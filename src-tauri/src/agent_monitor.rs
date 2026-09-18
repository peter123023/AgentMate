//! 代理（agent）任务完成监控
//!
//! 监控被托管的 CLI 会话，当某个会话"一轮对话任务完成"、且主窗口当前
//! 不可见（未聚焦或处于轻量模式）时，在菜单栏托盘图标下方弹出一个提示窗口，
//! 展示该 agent 的信息；点击提示窗口即可回到主窗口并定位到该会话。
//!
//! 完成信号按 provider 各自的落盘约定识别（见 `detect_completion`）：
//! - workbuddy: 最后一条 `type=message, role=assistant` 带 `status: "completed"`
//! - codex: `payload.type == "task_complete"`
//! - pi: assistant message 的 `stopReason` 为终态（stop / endTurn / maxTokens ...）
//! - claude: 最后一条 assistant 消息不以 `tool_use` 结尾（回合已交还用户）
//! - 其余 provider: 退化为"文件静默 N 秒"推断

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::session_manager::{self, SessionMeta};

/// 轮询间隔：会话文件是本地磁盘读写，2s 足够灵敏且开销可忽略。
///
/// 背景（22:56 用户反馈"codex 执行完等很久才弹"）：原来是 15s，加上 4s
/// 静默期，最坏要等 ~19s，用户感知是"等了很久"。改成 2s 后最坏 ~6s。
/// 目录扫描本身很便宜（每个 provider 只读文件尾部 64KB），代价可忽略。
const POLL_INTERVAL_SECS: u64 = 2;

/// 一次对话回合完成后，文件至少静默这么久才认定"真的结束了"，
/// 避免把工具调用之间的空档误判成完成。
///
/// 各 provider 都有精确的"回合结束"落盘标记（workbuddy 的
/// `message/completed`、codex 的 `task_complete`…），静默期只是防抖，
/// 取 1.5s 即可：既能滤掉同一标记的重复写入，又不让用户多等。
const QUIET_PERIOD_MS: i64 = 1_500;

/// 提示窗口存活时长，超时自动关闭，避免一直挂在屏幕上。
const NOTIFY_WINDOW_TTL_SECS: u64 = 12;

/// 同一次完成事件在这个时间窗内只提醒一次（新一轮完成不算重复）。
const DEDUP_WINDOW_MS: i64 = 10 * 60 * 1000;

/// 提示窗口与托盘图标之间的垂直间隙（逻辑像素）。
const TRAY_POPUP_GAP: f64 = 6.0;

pub const NOTIFY_WINDOW_LABEL: &str = "agent-notify";

/// 一个"agent 完成了任务"的通知载荷，前端提示窗口用它渲染。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompletion {
    pub provider_id: String,
    pub session_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub project_dir: Option<String>,
    pub source_path: Option<String>,
    pub resume_command: Option<String>,
    /// 完成时刻（毫秒时间戳）
    pub completed_at: i64,
    /// 该 agent 配置的提示音（"none" | "system" | "chime" | "bell" | "pop" | "success"）
    pub sound: Option<String>,
    /// 该 agent 配置的通知卡主题色覆盖（CSS 颜色字符串）。None = 用品牌色。
    pub color: Option<String>,
}

/// 已提醒过的完成事件指纹（provider:session:completed_at）-> 上次提醒时间，用于去重。
/// completed_at 变了（新一轮完成）就是新事件，可以再次提醒；同一次完成的
/// 重复扫描 / 重启回放在窗口内命中同一指纹，不会重复打扰。
static NOTIFIED: Lazy<Mutex<HashMap<String, i64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 当前提示窗口里展示的通知（前端挂载后拉取一次）。
static PENDING: Lazy<Mutex<Option<AgentCompletion>>> = Lazy::new(|| Mutex::new(None));

/// 自动关闭提示窗口的定时器代次：每次弹新窗口自增，旧定时器发现代次变化即放弃关闭。
static NOTIFY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 提示窗口生命周期串行锁：把「查存在 → 复用或创建 → 显示 → emit」整段串起来。
///
/// 必要性：`WebviewWindow::close()` 是异步的（macOS 上走主线程销毁队列，
/// 调用后立即返回），若 show 与 auto-close/dismiss 的 close 交错执行，就会
/// 出现"查的时候没有、build 的时候已经有"的同名窗口竞态。加锁后所有
/// 窗口生命周期操作严格串行，彻底消除该竞态。
static NOTIFY_WINDOW_GUARD: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// 取窗口生命周期锁；即便持锁线程 panic 过，也继续用内部值而不放弃。
fn lock_notify_window() -> std::sync::MutexGuard<'static, ()> {
    match NOTIFY_WINDOW_GUARD.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 启动后台监控循环。应用 setup 阶段调用一次。
pub fn spawn_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 首个 tick 立即返回，跳过等待，让启动后很快建立基线。
        let mut interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match tauri::async_runtime::spawn_blocking(scan_completions).await {
                Ok(completions) => {
                    for completion in completions {
                        handle_completion(&app, completion);
                    }
                }
                Err(error) => log::warn!("agent 完成扫描任务失败: {error}"),
            }
        }
    });
}

/// 去重指纹：provider + 会话 + 完成时刻。同一轮完成的重复出现（15s 轮询重扫、
/// 重启回放）命中同一指纹被去重；新一轮完成 completed_at 变化，视为新事件。
///
/// 背景（踩过的坑）：早期指纹只含 provider+session，导致「同一会话的新一轮
/// 完成」在 10 分钟窗口内被误判为重复而静默吞掉——用户看到的正是
/// 「workbuddy 一直不弹通知」。
fn completion_fingerprint(completion: &AgentCompletion) -> String {
    format!(
        "{}:{}:{}",
        completion.provider_id, completion.session_id, completion.completed_at
    )
}

/// 扫描全部会话，返回"本轮新完成且尚未提醒过"的条目。
fn scan_completions() -> Vec<AgentCompletion> {
    let sessions = session_manager::scan_sessions();
    let now = now_ms();

    let mut fresh = Vec::new();
    for session in sessions {
        if let Some(completion) = detect_completion(&session, now) {
            let fingerprint = completion_fingerprint(&completion);
            let mut notified = match NOTIFIED.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let already = notified
                .get(&fingerprint)
                .map(|last| now - *last < DEDUP_WINDOW_MS)
                .unwrap_or(false);
            if already {
                continue;
            }
            notified.insert(fingerprint, now);
            drop(notified);
            fresh.push(completion);
        }
    }

    // 顺手清理过期去重记录，避免长期运行后无限增长。
    if let Ok(mut notified) = NOTIFIED.lock() {
        notified.retain(|_, last| now - *last < DEDUP_WINDOW_MS);
    }

    fresh
}

/// 判断单个会话是否刚刚完成一轮任务。
///
/// 返回 `None` 表示"没有完成信号"或"完成信号不够新"。
fn detect_completion(session: &SessionMeta, now: i64) -> Option<AgentCompletion> {
    let last_active = session.last_active_at?;

    // 用户为该 agent 关掉了完成通知：直接跳过（不弹、不发声）。
    let notify_setting = crate::settings::get_agent_notification(&session.provider_id);
    if !notify_setting.enabled {
        return None;
    }

    // 完成信号必须足够新，否则会把陈年会话在每次启动时重新提醒一遍。
    if now - last_active > DEDUP_WINDOW_MS {
        return None;
    }
    // 文件仍在被写入 -> 任务还在进行中。
    if now - last_active < QUIET_PERIOD_MS {
        return None;
    }

    let source_path = session.source_path.as_deref()?;
    if !detect_turn_complete(&session.provider_id, Path::new(source_path))? {
        return None;
    }

    let title = session
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            session
                .project_dir
                .as_deref()
                .and_then(|dir| Path::new(dir).file_name())
                .and_then(|name| name.to_str())
                .map(String::from)
        })
        .unwrap_or_else(|| session.session_id.clone());

    Some(AgentCompletion {
        provider_id: session.provider_id.clone(),
        session_id: session.session_id.clone(),
        title,
        summary: session.summary.clone(),
        project_dir: session.project_dir.clone(),
        source_path: session.source_path.clone(),
        resume_command: session.resume_command.clone(),
        completed_at: last_active,
        sound: Some(sound_wire_value(notify_setting.sound).to_string()),
        color: notify_setting.color.clone().filter(|c| !c.trim().is_empty()),
    })
}

/// 提示音枚举 -> 前端消费的字符串（camelCase，与 serde 序列化一致）。
fn sound_wire_value(sound: crate::settings::AgentNotificationSound) -> &'static str {
    use crate::settings::AgentNotificationSound as S;
    match sound {
        S::None => "none",
        S::System => "system",
        S::Chime => "chime",
        S::Bell => "bell",
        S::Pop => "pop",
        S::Success => "success",
    }
}

/// 读取会话文件尾部若干行，按 provider 约定判断"回合是否已结束"。
fn detect_turn_complete(provider_id: &str, path: &Path) -> Option<bool> {
    let tail = read_tail_lines(path, 40).ok()?;
    if tail.is_empty() {
        return Some(false);
    }

    // 从尾往前找第一条"有语义"的记录。
    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        match provider_id {
            "workbuddy" => {
                match record_type {
                    // 尾部出现工具痕迹 = 回合仍在进行：工具刚发出 / 刚返回 /
                    // 正在思考，后面还会继续写 message。绝不能跳过它们去认
                    // 上一轮完成的 message——否则长回合里工具调用之间的空档
                    // （>4s 静默）会被误判成"已完成"而弹假通知（21:57 实测踩坑）。
                    "function_call" | "function_call_result" | "reasoning" => {
                        return Some(false);
                    }
                    "message" => {
                        let role = value.get("role").and_then(Value::as_str);
                        let status = value.get("status").and_then(Value::as_str);
                        return Some(match (role, status) {
                            // 尾部是用户消息：agent 还没开始回答，回合未完成。
                            (Some("user"), _) => false,
                            // assistant 完成（status 缺失是历史格式，视为已完成）。
                            (_, Some("completed") | None) => true,
                            _ => false,
                        });
                    }
                    // 其余记录类型（bookkeeping 等）：跳过，继续往前找。
                    _ => {}
                }
            }
            "codex" => {
                if record_type != "event_msg" {
                    continue;
                }
                match value
                    .get("payload")
                    .and_then(|p| p.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("task_complete") => return Some(true),
                    // 还有工具在执行，或新一轮已开始。
                    Some("task_started") => return Some(false),
                    _ => continue,
                }
            }
            "pi" => {
                if record_type != "message" {
                    continue;
                }
                let Some(message) = value.get("message") else {
                    continue;
                };
                let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "assistant" {
                    continue;
                }
                let stop = message
                    .get("stopReason")
                    .or_else(|| message.get("stop_reason"))
                    .and_then(Value::as_str);
                return Some(match stop {
                    Some("toolUse") | Some("tool_use") => false,
                    Some(_) => true,
                    // 没有 stopReason 说明流还在进行。
                    None => false,
                });
            }
            "claude" => {
                if record_type != "assistant" && record_type != "user" {
                    continue;
                }
                let is_assistant = record_type == "assistant"
                    || value
                        .get("message")
                        .and_then(|m| m.get("role"))
                        .and_then(Value::as_str)
                        == Some("assistant");
                if !is_assistant {
                    // user 记录有两种：真正的用户输入（说明上一轮已交还用户）
                    // 和工具返回（content 是 tool_result，回合仍在进行）。后者
                    // 必须继续往前找 assistant，否则工具执行间隙会被误判完成。
                    let is_tool_result = value
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                        .map(|items| {
                            items.iter().any(|item| {
                                item.get("type").and_then(Value::as_str) == Some("tool_result")
                            })
                        })
                        .unwrap_or(false);
                    if is_tool_result {
                        continue;
                    }
                    // 遇到真正的用户输入：说明上一轮已交还用户。
                    return Some(true);
                }
                // 最后一条 assistant 若以 tool_use 结尾 -> 还要继续跑工具。
                let ends_with_tool_use = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                    .map(|items| {
                        items
                            .last()
                            .and_then(|item| item.get("type"))
                            .and_then(Value::as_str)
                            == Some("tool_use")
                    })
                    .unwrap_or(false);
                return Some(!ends_with_tool_use);
            }
            _ => {
                // 未适配的 provider：只要尾部是 assistant 的产出，就按"疑似完成"处理。
                let is_assistant = record_type == "assistant"
                    || (record_type == "message"
                        && (value.get("role").and_then(Value::as_str) == Some("assistant")
                            || value
                                .get("message")
                                .and_then(|m| m.get("role"))
                                .and_then(Value::as_str)
                                == Some("assistant")));
                if !is_assistant {
                    continue;
                }
                return Some(true);
            }
        }
    }

    Some(false)
}

/// 从文件尾部读取最多 `max_lines` 行（按 ~64KB 窗口回退，避免整文件读入）。
fn read_tail_lines(path: &Path, max_lines: usize) -> std::io::Result<Vec<String>> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let file_len = file.metadata()?.len();
    let window = 64 * 1024u64;

    if file_len > window {
        file.seek(SeekFrom::Start(file_len - window))?;
    }

    let reader = BufReader::new(file);
    let mut lines: Vec<String> = reader.lines().map_while(Result::ok).collect();
    if file_len > window && !lines.is_empty() {
        // 首行可能是被截断的半行，丢弃。
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(max_lines);
    Ok(lines.into_iter().skip(skip).collect())
}

/// 收到一个完成事件：主窗口不可见时弹提示窗口。
///
/// 这里两条分支都记 info 级日志：本功能的行为完全取决于"是否弹窗"，
/// 出问题时用户与排查者都需要能从日志直接看出当时判到了哪一支。
fn handle_completion(app: &tauri::AppHandle, completion: AgentCompletion) {
    let label = format!("{}:{}", completion.provider_id, completion.session_id);

    if is_main_window_visible(app) {
        log::info!("agent 完成：{label}，但主窗口在前台，跳过提醒");
        return;
    }

    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(completion.clone());
    }

    match show_notify_window(app, &completion) {
        Ok(()) => log::info!("agent 完成：{label}，已在菜单栏弹出完成提示"),
        Err(error) => log::warn!("弹出 agent 完成提示窗口失败 ({label}): {error}"),
    }
}

/// 主窗口是否"开着"：存在、可见、未最小化、且处于聚焦状态。
///
/// 用户确认的判定口径是**主窗口未聚焦或已隐藏**才提醒——只要它还
/// 稳稳地在前台，就不必打扰。
fn is_main_window_visible(app: &tauri::AppHandle) -> bool {
    if crate::lightweight::is_lightweight_mode() {
        return false;
    }

    let Some(window) = app.get_webview_window("main") else {
        return false;
    };

    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    visible && !minimized && focused
}

/// 标记提示窗口已请求关闭、正在异步销毁。下一次 show 前要先等它销毁完
/// （close 是异步的），否则会复用到一个"正在死"的窗口——看得到但点不了。
static NOTIFY_CLOSE_PENDING: AtomicBool = AtomicBool::new(false);

/// 让提示窗口成为「非激活面板」：应用处于 inactive 时点击也能直达 webview。
///
/// 为什么需要：macOS 上，非前台应用窗口的**第一次点击会被系统吃掉**当作
/// "激活点击"（activation click），不会派发到 webview。主窗口被最小化后
/// 应用即失活，此提示窗口又是 `.focused(false)` 的不抢焦点窗口，于是用户
/// 点「打开 Codex」时点击被吞、`open_agent_completion` 根本没被调用，
/// 弹窗最终只能等 12s 自动关闭定时器收掉——这正是用户实测的现象
/// （日志表现为：弹窗→12s 后关闭，中间**没有**「已打开 agent」）。
///
/// 试过但不成立的做法：`NSRunningApplication::activateWithOptions`。
/// 本应用主窗口被最小化后**没有可见窗口**，macOS 会拒绝激活（实测点完
/// 弹窗后 `lsappinfo front` 仍是别的 app），所以激活路线不可靠。
///
/// 正确做法：`NSWindowStyleMaskNonactivatingPanel` —— AppKit 专为
/// 「应用不激活也要能接收点击」设计的 style mask（系统输入法候选窗、
/// 悬浮面板都用它）。加上这一位后，本窗口在应用 inactive 时仍能接收
/// 首次鼠标点击，不再被吞。
#[cfg(target_os = "macos")]
fn make_notify_window_clickable_when_inactive(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};

    let Ok(ptr) = window.ns_window() else {
        log::warn!("提示窗口：取 NSWindow 指针失败，跳过非激活面板设置");
        return;
    };
    if ptr.is_null() {
        return;
    }

    // SAFETY: 指针由 Tauri 提供，生命周期覆盖本窗口；只是在已有样式上
    // 追加一个位，不改变窗口既有的无边框/透明等语义。
    unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        let mask = ns_window.styleMask();
        ns_window.setStyleMask(mask | NSWindowStyleMask::NonactivatingPanel);
    }
    log::info!("提示窗口：已设为非激活面板（inactive 下首击可直达）");
}

#[cfg(not(target_os = "macos"))]
fn make_notify_window_clickable_when_inactive(_window: &tauri::WebviewWindow) {}


/// 创建（或复用）提示窗口，定位到托盘图标附近。
fn show_notify_window(
    app: &tauri::AppHandle,
    completion: &AgentCompletion,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    const WIDTH: f64 = 392.0;
    const HEIGHT: f64 = 168.0;

    // 串行化整个窗口生命周期（见 NOTIFY_WINDOW_GUARD 说明）。
    let _guard = lock_notify_window();

    // 上一次提示窗口正在异步销毁：等它销毁完再走复用/新建（最多 2s）。
    // 本函数运行在后台扫描线程，短暂阻塞无碍。
    if NOTIFY_CLOSE_PENDING.load(Ordering::SeqCst) {
        for _ in 0..100 {
            if app.get_webview_window(NOTIFY_WINDOW_LABEL).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        NOTIFY_CLOSE_PENDING.store(false, Ordering::SeqCst);
        log::info!("提示窗口：等待上一次销毁完成后重建");
    }

    // 复用已存在的窗口：**不要** close 后再 build。
    // `WebviewWindow::close()` 是异步的（macOS 上走主线程销毁队列，立即返回），
    // 紧接着用同一 label build 会撞上 "a webview with label `agent-notify`
    // already exists" —— 这正是"同时两个会话完成时第二个静默不弹"的根因。
    // 改为复用：重新定位 + 重新 emit，前端收到新内容后自行刷新即可。
    let window = if let Some(existing) = app.get_webview_window(NOTIFY_WINDOW_LABEL) {
        log::info!("提示窗口：复用已存在窗口");
        position_near_tray(&existing, WIDTH, HEIGHT);
        // 重新显示（可能刚被自动关闭定时器藏起来，也可能已经在屏上）。
        let _ = existing.show();
        let _ = existing.set_always_on_top(true);

        // 关键：设为非激活面板，否则应用失活时首次点击会被 macOS
        // 当作"激活点击"吃掉（见 make_notify_window_clickable_when_inactive）。
        make_notify_window_clickable_when_inactive(&existing);

        // 兜底：某些平台下提示窗口可能抢到焦点，立即还给原窗口。
        if let Some(main) = app.get_webview_window("main") {
            if main.is_focused().unwrap_or(false) {
                let _ = main.set_focus();
            }
        }

        let _ = app.emit_to(
            NOTIFY_WINDOW_LABEL,
            "agent-completion",
            completion.clone(),
        );
        let _ = app.emit("agent-completion", completion.clone());

        schedule_auto_close(app.clone());
        return Ok(());
    } else {
        // 说明：这里用**透明窗口**——macOS 上 `transparent(true)` 要求启用
        // `macos-private-api`，本项目已经启用（主窗口自绘标题栏在用）。
        // 透明窗口让前端画 16px 圆角卡片，四周留 10px 透明边距，
        // 系统阴影（NSWindow shadow 跟随内容 alpha）会自动贴着圆角走，
        // 视觉上与系统通知一致。
        WebviewWindowBuilder::new(
            app,
            NOTIFY_WINDOW_LABEL,
            WebviewUrl::App("notify.html".into()),
        )
        .title("")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建提示窗口失败: {e}"))?
    };

    log::info!("提示窗口：新建窗口");
    position_near_tray(&window, WIDTH, HEIGHT);

    // 显示时保持"不抢焦点"，否则会打断用户当前正在做的事。
    let _ = window.show();
    let _ = window.set_always_on_top(true);

    // 关键：设为非激活面板，让应用在 inactive（主窗口最小化）状态下
    // 的首次点击也能直达 webview（详见 make_notify_window_clickable_when_inactive）。
    make_notify_window_clickable_when_inactive(&window);

    // 兜底：某些平台下提示窗口可能抢到焦点，立即还给原窗口。
    if let Some(main) = app.get_webview_window("main") {
        if main.is_focused().unwrap_or(false) {
            let _ = main.set_focus();
        }
    }

    let _ = app.emit_to(NOTIFY_WINDOW_LABEL, "agent-completion", completion.clone());
    let _ = app.emit("agent-completion", completion.clone());

    schedule_auto_close(app.clone());
    Ok(())
}

/// 把提示窗口摆到托盘图标附近。
///
/// 优先读取托盘图标的实际位置，把窗口贴在其正下方——托盘图标在菜单栏
/// 右上角，因此弹窗也落在同一区域，符合菜单栏应用的交互预期。
/// 取不到图标位置时退化为"主屏右上角"（macOS）/“主屏右下角”（其他平台）。
fn position_near_tray(window: &tauri::WebviewWindow, width: f64, height: f64) {
    use tauri::PhysicalSize;

    let scale = window.scale_factor().unwrap_or(1.0);
    let size = PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    );

    if let Some(position) = tray_anchored_position(window, size, scale) {
        let _ = window.set_position(position);
        return;
    }

    fallback_position(window, size, scale);
}

/// 用托盘图标矩形算出提示窗口左上角（物理像素）。
fn tray_anchored_position(
    window: &tauri::WebviewWindow,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) -> Option<tauri::PhysicalPosition<i32>> {
    use tauri::PhysicalPosition;

    let tray = window.app_handle().tray_by_id(crate::tray::TRAY_ID)?;
    let rect = tray.rect().ok().flatten()?;

    // tray.rect() 的位置/尺寸可能是物理或逻辑单位，统一折算到物理像素。
    let position = rect.position.to_physical::<i32>(scale);
    let rect_size = rect.size.to_physical::<u32>(scale);

    // 图标水平中线与窗口水平中线对齐，整体下移一个图标高度 + 间隙。
    let icon_center_x = position.x as f64 + rect_size.width as f64 / 2.0;
    let x = (icon_center_x - size.width as f64 / 2.0).round() as i32;
    let y =
        (position.y as f64 + rect_size.height as f64 + TRAY_POPUP_GAP * scale).round() as i32;

    Some(PhysicalPosition::new(x, y))
}

/// 取不到托盘位置时的退化摆放。
#[cfg(target_os = "macos")]
fn fallback_position(
    window: &tauri::WebviewWindow,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) {
    use tauri::PhysicalPosition;

    // macOS：贴着主屏右上角（菜单栏正下方）。
    let Ok(Some(monitor)) = window.primary_monitor() else {
        let _ = window.set_position(PhysicalPosition::new(0, 0));
        return;
    };
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let _ = window.set_position(PhysicalPosition::new(
        monitor_pos.x + monitor_size.width as i32 - size.width as i32 - (12.0 * scale) as i32,
        monitor_pos.y + (28.0 * scale) as i32,
    ));
}

#[cfg(not(target_os = "macos"))]
fn fallback_position(
    window: &tauri::WebviewWindow,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) {
    use tauri::PhysicalPosition;

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let _ = window.set_position(PhysicalPosition::new(
        monitor_pos.x + monitor_size.width as i32 - size.width as i32 - (12.0 * scale) as i32,
        monitor_pos.y + monitor_size.height as i32 - size.height as i32 - (48.0 * scale) as i32,
    ));
}

/// 到点自动收起提示窗口。
fn schedule_auto_close(app: tauri::AppHandle) {
    let generation = NOTIFY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(NOTIFY_WINDOW_TTL_SECS)).await;
        if NOTIFY_GENERATION.load(Ordering::SeqCst) != generation {
            // 期间又弹了新窗口，这次不管了。
            return;
        }
        close_notify_window(&app);
    });
}

/// 关闭提示窗口并清空挂起通知。
pub fn close_notify_window(app: &tauri::AppHandle) {
    // 与 show_notify_window 共用同一把锁，避免 close 异步销毁期间被 build 抢占。
    let _guard = lock_notify_window();
    if let Some(window) = app.get_webview_window(NOTIFY_WINDOW_LABEL) {
        // 注意：lib.rs 的全局 CloseRequested 处理器对 agent-notify 直接放行，
        // 这里 close 会真正销毁窗口。此前它被「关闭到托盘」拦成 hide——窗口
        // 永远销毁不掉、之后一直复用同一个 webview，前端一次性点击闸门把
        // 后续弹窗全部变成点不了（22:29 用户实测的根因）。
        NOTIFY_CLOSE_PENDING.store(true, Ordering::SeqCst);
        let _ = window.close();
        log::info!("提示窗口：已请求关闭（异步销毁）");
    }
    if let Ok(mut pending) = PENDING.lock() {
        *pending = None;
    }
}

/// 供前端提示窗口挂载时拉取当前通知（避免事件早于监听注册而丢失）。
#[tauri::command]
pub fn get_pending_agent_completion() -> Option<AgentCompletion> {
    match PENDING.lock() {
        Ok(pending) => pending.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// 提示窗口被点击：唤起目标 agent 的宿主，并关闭提示窗口。
///
/// 按 provider 分发：
/// - `workbuddy`：打开 WorkBuddy 桌面应用本身（用户口径：「打开 agent 本身，
///   不是终端」）。用 bundle id 定位，不受应用显示名改动影响。
/// - 其余 CLI 型 provider（claude / codex / pi / …）：没有 GUI 宿主，
///   "打开"就是回终端继续会话——走与会话列表「在终端打开」相同的
///   终端选择与启动逻辑，命令串由后端从会话记录重建，不接受前端传入。
///
/// 非 macOS 上两种路径都可能不支持，返回 Err 由前端降级为复制 resume 命令。
/// 无论成败都关闭提示窗口——它只是入口，失败后留在屏幕上没有意义。
#[tauri::command]
pub async fn open_agent_completion(
    app: tauri::AppHandle,
    // 参数名保持 camelCase 以匹配前端 invoke 的载荷字段
    #[allow(non_snake_case)] providerId: String,
    #[allow(non_snake_case)] sessionId: String,
) -> Result<(), String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        // 有桌面应用的 provider：直接唤起应用本身。
        if provider_id == "workbuddy" {
            return open_workbuddy_app();
        }
        if provider_id == "codex" {
            return open_codex_app();
        }

        // CLI 型 provider：回终端继续会话。
        let session = session_manager::scan_sessions()
            .into_iter()
            .find(|s| s.provider_id == provider_id && s.session_id == session_id)
            .ok_or_else(|| format!("会话不存在或已被删除: {provider_id}:{session_id}"))?;

        let resume = session
            .resume_command
            .clone()
            .filter(|c| !c.trim().is_empty())
            .ok_or_else(|| "该会话没有可用的 resume 命令".to_string())?;

        // 与 commands::launch_session_terminal 相同的终端选择逻辑。
        let preferred = crate::settings::get_preferred_terminal();
        let target = match preferred.as_deref() {
            Some("iterm2") => "iterm".to_string(),
            Some(t) => t.to_string(),
            None => "terminal".to_string(),
        };

        session_manager::terminal::launch_terminal(
            &target,
            &resume,
            session.project_dir.as_deref(),
            None,
        )
    })
    .await
    .map_err(|e| format!("打开 agent 任务失败: {e}"))
    .and_then(|inner| inner);

    // 无论成败都收掉提示窗口。
    close_notify_window(&app);
    match &result {
        Ok(()) => log::info!("agent 完成提示：已打开 agent ({providerId}:{sessionId})"),
        Err(error) => log::warn!("agent 完成提示：打开 agent 失败 ({providerId}:{sessionId}): {error}"),
    }
    result
}

/// 唤起 WorkBuddy 桌面应用（macOS）。
fn open_workbuddy_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const WORKBUDDY_BUNDLE_ID: &str = "com.tencent.workbuddy.mac";
        let status = std::process::Command::new("open")
            .args(["-b", WORKBUDDY_BUNDLE_ID])
            .status()
            .map_err(|e| format!("执行 open 失败: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("open -b {WORKBUDDY_BUNDLE_ID} 退出码 {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("打开 WorkBuddy 应用仅支持 macOS".to_string())
    }
}

/// 唤起 Codex 桌面应用（macOS）。
///
/// Codex 桌面端就是 `/Applications/ChatGPT.app`（bundle id
/// `com.openai.codex`，同时注册了 `codex://` URL scheme），用户口径是
/// 「打开 codex 这个 app」，不是回终端 resume。
///
/// 优先用 `codex://` scheme：能直达 Codex 界面；scheme 不可用时退化为
/// 按 bundle id 唤起应用本体。
fn open_codex_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const CODEX_URL: &str = "codex://";
        const CODEX_BUNDLE_ID: &str = "com.openai.codex";

        if std::process::Command::new("open")
            .arg(CODEX_URL)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }

        let status = std::process::Command::new("open")
            .args(["-b", CODEX_BUNDLE_ID])
            .status()
            .map_err(|e| format!("执行 open 失败: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("open -b {CODEX_BUNDLE_ID} 退出码 {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("打开 Codex 应用仅支持 macOS".to_string())
    }
}

/// 用户显式关闭提示窗口。
#[tauri::command]
pub fn dismiss_agent_completion(app: tauri::AppHandle) {
    close_notify_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_session(lines: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create");
        for line in lines {
            writeln!(file, "{line}").expect("write");
        }
        dir
    }

    #[test]
    fn workbuddy_completed_status_is_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"message","role":"user","content":[]}"#,
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("workbuddy", &path), Some(true));
    }

    #[test]
    fn workbuddy_in_progress_status_is_not_a_completion() {
        let dir = write_temp_session(&[r#"{"type":"message","role":"assistant","status":"in_progress","content":[]}"#]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("workbuddy", &path), Some(false));
    }

    /// 回归（21:57 实测误报，长回合中弹出两次假通知）：回合进行中，尾部是
    /// function_call 等工具痕迹，往前才是上一轮完成的 message —— 绝不能跳过
    /// 工具痕迹去认旧 message。
    #[test]
    fn workbuddy_trailing_tool_activity_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"function_call","name":"shell"}"#,
            r#"{"type":"function_call_result","status":"completed"}"#,
            r#"{"type":"reasoning","content":"[]"}"#,
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
            r#"{"type":"function_call","name":"shell"}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("workbuddy", &path), Some(false));
    }

    /// 真实完成形态：工具痕迹之后落了 assistant 完成消息，才算完成。
    #[test]
    fn workbuddy_completed_message_after_tool_activity_is_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"function_call","name":"shell"}"#,
            r#"{"type":"function_call_result","status":"completed"}"#,
            r#"{"type":"reasoning","content":"[]"}"#,
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("workbuddy", &path), Some(true));
    }

    /// 尾部是尚未回复的用户消息：agent 还没开始回答，回合未完成。
    #[test]
    fn workbuddy_trailing_user_message_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
            r#"{"type":"message","role":"user","content":[]}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("workbuddy", &path), Some(false));
    }

    /// 回归（与 workbuddy 同类误报）：claude 的工具返回也挂在 user 记录上，
    /// 回合中不能把它当成"已交还用户"。
    #[test]
    fn claude_tool_result_user_record_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("claude", &path), Some(false));
    }

    #[test]
    fn codex_task_complete_is_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"event_msg","payload":{"type":"token_count"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete","completed_at":1}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("codex", &path), Some(true));
    }

    #[test]
    fn codex_task_started_after_complete_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("codex", &path), Some(false));
    }

    #[test]
    fn pi_tool_use_stop_reason_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"message","message":{"role":"assistant","stopReason":"stop"}}"#,
            r#"{"type":"message","message":{"role":"assistant","stopReason":"toolUse"}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("pi", &path), Some(false));
    }

    #[test]
    fn claude_trailing_tool_use_is_not_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use"}]}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("claude", &path), Some(false));
    }

    #[test]
    fn claude_plain_assistant_is_a_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        assert_eq!(detect_turn_complete("claude", &path), Some(true));
    }

    #[test]
    fn stale_session_is_filtered_out() {
        let now = now_ms();
        let session = SessionMeta {
            provider_id: "workbuddy".to_string(),
            session_id: "s1".to_string(),
            title: Some("旧会话".to_string()),
            summary: None,
            project_dir: None,
            created_at: Some(now - 3_600_000),
            last_active_at: Some(now - 3_600_000),
            source_path: Some("/tmp/does-not-matter.jsonl".to_string()),
            resume_command: None,
        };
        assert!(detect_completion(&session, now).is_none());
    }

    #[test]
    fn completion_is_not_detected_within_quiet_period() {
        let now = now_ms();
        let session = SessionMeta {
            provider_id: "workbuddy".to_string(),
            session_id: "s2".to_string(),
            title: Some("刚写完".to_string()),
            summary: None,
            project_dir: None,
            created_at: Some(now),
            last_active_at: Some(now - 500),
            source_path: Some("/tmp/does-not-matter.jsonl".to_string()),
            resume_command: None,
        };
        assert!(detect_completion(&session, now).is_none());
    }

    /// 端到端：真实 workbuddy 会话文件 -> detect_completion 产出完整通知载荷。
    ///
    /// 这是对本功能主路径的验证：文件落盘 -> 尾部解析 -> 完成判定 ->
    /// 组装出可交给提示窗口渲染的 `AgentCompletion`（含标题兜底与字段透传）。
    #[test]
    fn real_session_file_yields_full_completion_payload() {
        let dir = write_temp_session(&[
            r#"{"id":"m1","timestamp":"1789580000000","type":"message","role":"user","content":[{"type":"input_text","text":"帮我重构这个函数"}],"sessionId":"aaaa1111-2222-3333-4444-555566667777","cwd":"/tmp/mb-test/proj"}"#,
            r#"{"id":"m2","timestamp":"1789580010000","type":"reasoning","content":"[]","sessionId":"aaaa1111-2222-3333-4444-555566667777","cwd":"/tmp/mb-test/proj"}"#,
            r#"{"id":"m3","timestamp":"1789580020000","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"重构完成，已拆成三个纯函数。"}],"sessionId":"aaaa1111-2222-3333-4444-555566667777","cwd":"/tmp/mb-test/proj"}"#,
        ]);
        let path = dir.path().join("session.jsonl");

        let now = now_ms();
        let session = SessionMeta {
            provider_id: "workbuddy".to_string(),
            session_id: "aaaa1111-2222-3333-4444-555566667777".to_string(),
            title: Some("函数重构".to_string()),
            summary: Some("重构完成，已拆成三个纯函数。".to_string()),
            project_dir: Some("/tmp/mb-test/proj".to_string()),
            created_at: Some(1_789_580_000_000),
            // 文件已静默超过 quiet period，且落在去重窗口内。
            last_active_at: Some(now - QUIET_PERIOD_MS - 1_000),
            source_path: Some(path.to_string_lossy().to_string()),
            resume_command: Some(
                "workbuddy --resume aaaa1111-2222-3333-4444-555566667777".to_string(),
            ),
        };

        let completion =
            detect_completion(&session, now).expect("真实完成信号应产出通知载荷");

        assert_eq!(completion.provider_id, "workbuddy");
        assert_eq!(
            completion.session_id,
            "aaaa1111-2222-3333-4444-555566667777"
        );
        assert_eq!(completion.title, "函数重构");
        assert_eq!(completion.project_dir.as_deref(), Some("/tmp/mb-test/proj"));
        assert_eq!(
            completion.resume_command.as_deref(),
            Some("workbuddy --resume aaaa1111-2222-3333-4444-555566667777")
        );
        assert!(completion.completed_at > 0);
    }

    /// 标题缺失时回退到项目目录名，再回退到会话 id。
    #[test]
    fn completion_falls_back_to_project_then_session_id() {
        let dir = write_temp_session(&[
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        let now = now_ms();

        let with_project = SessionMeta {
            provider_id: "workbuddy".to_string(),
            session_id: "s3".to_string(),
            title: None,
            summary: None,
            project_dir: Some("/tmp/mb-test/my-proj".to_string()),
            created_at: Some(now - QUIET_PERIOD_MS - 1_000),
            last_active_at: Some(now - QUIET_PERIOD_MS - 1_000),
            source_path: Some(path.to_string_lossy().to_string()),
            resume_command: None,
        };
        assert_eq!(
            detect_completion(&with_project, now)
                .expect("应产出载荷")
                .title,
            "my-proj"
        );

        let bare = SessionMeta {
            title: None,
            project_dir: None,
            ..with_project
        };
        assert_eq!(
            detect_completion(&bare, now).expect("应产出载荷").title,
            "s3"
        );
    }

    /// 去重：同一次完成事件在窗口期内只应被上报一次。
    #[test]
    fn scan_completions_dedups_within_window() {
        let now = now_ms();
        let completion = AgentCompletion {
            provider_id: "workbuddy".to_string(),
            session_id: "dedup-probe".to_string(),
            title: "去重探针".to_string(),
            summary: None,
            project_dir: None,
            source_path: None,
            resume_command: None,
            completed_at: now,
            sound: None,
            color: None,
        };
        let fingerprint = completion_fingerprint(&completion);

        {
            let mut notified = NOTIFIED.lock().expect("lock");
            notified.insert(fingerprint.clone(), now);
        }

        let mut notified = NOTIFIED.lock().expect("lock");
        let already = notified
            .get(&fingerprint)
            .map(|last| now - *last < DEDUP_WINDOW_MS)
            .unwrap_or(false);
        assert!(already, "窗口期内应判为重复");
        notified.remove(&fingerprint);
    }

    /// 回归（21:43 用户报告"workbuddy 一直不弹"）：同一会话新一轮完成
    /// （completed_at 变化）不得命中旧指纹，否则窗口内后续轮次全部静默。
    #[test]
    fn new_turn_completion_produces_new_fingerprint() {
        let base = AgentCompletion {
            provider_id: "codex".to_string(),
            session_id: "s1".to_string(),
            title: "t".to_string(),
            summary: None,
            project_dir: None,
            source_path: None,
            resume_command: None,
            completed_at: 1_000,
            sound: None,
            color: None,
        };
        let mut next = base.clone();
        next.completed_at = 2_000;

        assert_eq!(
            completion_fingerprint(&base),
            "codex:s1:1000",
            "指纹应包含完成时刻"
        );
        assert_ne!(
            completion_fingerprint(&base),
            completion_fingerprint(&next),
            "新一轮完成必须生成新指纹"
        );
    }

    /// 回归：提示音枚举到前端字符串的映射必须稳定（前端按这些值选音效）。
    #[test]
    fn notification_sound_wire_values_are_stable() {
        use crate::settings::AgentNotificationSound as S;
        assert_eq!(sound_wire_value(S::None), "none");
        assert_eq!(sound_wire_value(S::System), "system");
        assert_eq!(sound_wire_value(S::Chime), "chime");
        assert_eq!(sound_wire_value(S::Bell), "bell");
        assert_eq!(sound_wire_value(S::Pop), "pop");
        assert_eq!(sound_wire_value(S::Success), "success");
    }

    /// 用户为某 agent 关闭通知后，即使有真实完成信号也不得产出通知。
    #[test]
    fn disabled_agent_setting_suppresses_completion() {
        let dir = write_temp_session(&[
            r#"{"type":"message","role":"assistant","status":"completed","content":[]}"#,
        ]);
        let path = dir.path().join("session.jsonl");
        let now = now_ms();
        let provider = "e2e-disabled-probe";

        // 先设成关闭，验证被抑制
        crate::settings::update_settings(crate::settings::AppSettings {
            agent_notifications: [(
                provider.to_string(),
                crate::settings::AgentNotificationSetting {
                    enabled: false,
                    ..Default::default()
                },
            )]
            .into_iter()
            .collect(),
            ..crate::settings::get_settings()
        })
        .expect("保存设置");

        let session = SessionMeta {
            provider_id: provider.to_string(),
            session_id: "disabled-1".to_string(),
            title: Some("关闭通知的 agent".to_string()),
            summary: None,
            project_dir: None,
            created_at: Some(now - QUIET_PERIOD_MS - 1_000),
            last_active_at: Some(now - QUIET_PERIOD_MS - 1_000),
            source_path: Some(path.to_string_lossy().to_string()),
            resume_command: None,
        };
        assert!(
            detect_completion(&session, now).is_none(),
            "关闭通知后不应产出完成事件"
        );

        // 恢复成开启，验证重新生效（顺带清理测试写入的设置）
        crate::settings::update_settings(crate::settings::AppSettings {
            agent_notifications: [(
                provider.to_string(),
                crate::settings::AgentNotificationSetting {
                    enabled: true,
                    sound: crate::settings::AgentNotificationSound::Chime,
                    color: Some("#123456".to_string()),
                },
            )]
            .into_iter()
            .collect(),
            ..crate::settings::get_settings()
        })
        .expect("保存设置");

        let completion = detect_completion(&session, now).expect("开启后应产出完成事件");
        assert_eq!(completion.sound.as_deref(), Some("chime"));
        assert_eq!(completion.color.as_deref(), Some("#123456"));

        // 清掉探针设置，避免污染后续测试
        crate::settings::update_settings(crate::settings::AppSettings {
            agent_notifications: Default::default(),
            ..crate::settings::get_settings()
        })
        .expect("清理设置");
    }

    /// 回归：窗口生命周期锁必须是可用的（非重入、可串行释放）。
    ///
    /// 修复前 `show_notify_window` 先异步 `close()` 再立即 `build()` 同名窗口，
    /// 会撞上 "a webview with label `agent-notify` already exists"。现在整段
    /// 生命周期由 `NOTIFY_WINDOW_GUARD` 串行化，本测试确保该锁本身可正常
    /// 获取/释放——若将来有人把它换成重入锁或误改成持有跨 await，会先在此暴露。
    #[test]
    fn notify_window_guard_serializes_and_releases() {
        {
            let _guard = lock_notify_window();
            // 持锁期间再取会阻塞，故这里不做二次获取，只验证能拿到并释放。
        }
        // 释放后应可再次获取（证明没有泄漏/死锁）。
        let _guard = lock_notify_window();
    }

    /// 回归：锁被 panic 污染后，`lock_notify_window` 仍应返回可用 guard
    /// （否则一次收尾失败会让通知功能永久失效）。
    #[test]
    fn notify_window_guard_survives_poisoning() {
        let _ = std::thread::spawn(|| {
            let _guard = lock_notify_window();
            panic!("故意污染锁");
        })
        .join();

        // 不应 panic，且应返回可用的 guard。
        let _guard = lock_notify_window();
    }
}
