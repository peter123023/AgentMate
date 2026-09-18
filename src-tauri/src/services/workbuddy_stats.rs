//! WorkBuddy 积分余额与本地消耗统计。
//!
//! 数据来源（均为只读，绝不写 WorkBuddy 的任何文件）：
//!
//! 1. **积分余额**（云端账号数据）：
//!    登录凭证位于
//!    `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
//!    （明文 JSON，`auth.accessToken` 为 Bearer JWT，`auth.domain` 为 API 域名）。
//!    带上 `Authorization: Bearer <token>` 调用
//!    `POST https://<domain>/billing/meter/get-user-resource-summary` 即可拿到
//!    各资源包的总额度/已用/剩余。token 过期后接口返回 401，此时应提示用户
//!    打开 WorkBuddy 刷新登录态（不要自实现刷新流程）。
//!
//! 2. **本地消耗统计**：`~/.workbuddy/workbuddy.db` 的 `session_usage` 表
//!    （`credit_json` 记录该会话消耗的积分，`updated_at` 为毫秒时间戳）。
//!    这是本地保留会话的消耗快照，不等于账号总消耗。

use crate::config::get_home_dir;
use crate::error::AppError;
use rusqlite::OpenFlags;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_INFO_CANDIDATES: &[&str] = &[
    // macOS 主路径
    "Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info",
    // 可能的备选（不同打包形态）
    ".codebuddy-extension/Data/Public/auth/workbuddy-desktop.info",
];
const DEFAULT_BILLING_DOMAIN: &str = "www.workbuddy.cn";
const BILLING_SUMMARY_PATH: &str = "/billing/meter/get-user-resource-summary";
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(1200);

fn auth_info_candidates() -> Vec<PathBuf> {
    AUTH_INFO_CANDIDATES
        .iter()
        .map(|rel| get_home_dir().join(rel))
        .collect()
}

struct WorkBuddyAuth {
    access_token: String,
    domain: String,
}

/// 读取本地凭证（明文 JSON）。文件缺失或损坏时返回 None（不算错误——
/// 用户可能根本没有登录过 WorkBuddy）。
fn read_auth_info() -> Option<WorkBuddyAuth> {
    for path in auth_info_candidates() {
        if !path.exists() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            log::warn!("[WorkBuddyStats] 凭证文件存在但不可读: {}", path.display());
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            log::warn!("[WorkBuddyStats] 凭证文件不是合法 JSON: {}", path.display());
            continue;
        };
        let Some(token) = value
            .pointer("/auth/accessToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        else {
            log::warn!("[WorkBuddyStats] 凭证文件缺少 auth.accessToken");
            continue;
        };
        let domain = value
            .pointer("/auth/domain")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_BILLING_DOMAIN)
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_string();
        return Some(WorkBuddyAuth {
            access_token: token,
            domain,
        });
    }
    None
}

/// 查询云端积分余额。
///
/// 返回结构（永不抛错，用 `available/reason` 表达不可用状态，便于前端
/// 静默降级）：
/// - `{ available: false, reason: "noAuth" }`：未找到凭证文件
/// - `{ available: false, reason: "unauthorized" }`：token 过期/无效
/// - `{ available: false, reason: "network", detail }`：网络异常
/// - `{ available: true, isPaidUser, packages: [{ code, total, used, remain }] }`
pub async fn get_credits_balance() -> Result<Value, AppError> {
    let Some(auth) = read_auth_info() else {
        return Ok(json!({ "available": false, "reason": "noAuth" }));
    };

    let url = format!("https://{}{BILLING_SUMMARY_PATH}", auth.domain);
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| AppError::Database(format!("构建 HTTP 客户端失败: {e}")))?;

    let response = match client
        .post(&url)
        // WorkBuddy 网关的 WAF 会拦截无 User-Agent 的请求
        // （403 code=10085「请求不合法」），reqwest 默认不带 UA，必须显式设置。
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AgentMate",
        )
        .bearer_auth(&auth.access_token)
        .header("Accept-Language", "zh-CN")
        .json(&json!({}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            log::warn!("[WorkBuddyStats] 余额接口请求失败: {e}");
            return Ok(json!({
                "available": false,
                "reason": "network",
                "detail": e.to_string(),
            }));
        }
    };

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(json!({ "available": false, "reason": "unauthorized" }));
    }
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        // 403 通常是 WAF 拦截（请求指纹问题），不是登录态问题
        return Ok(json!({ "available": false, "reason": "forbidden" }));
    }
    if !response.status().is_success() {
        return Ok(json!({
            "available": false,
            "reason": "http",
            "detail": response.status().as_u16().to_string(),
        }));
    }

    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(e) => {
            return Ok(json!({
                "available": false,
                "reason": "parse",
                "detail": e.to_string(),
            }));
        }
    };
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        return Ok(json!({
            "available": false,
            "reason": "apiError",
            "detail": body.get("msg").and_then(Value::as_str).unwrap_or("unknown"),
        }));
    }

    let mut packages = Vec::new();
    if let Some(list) = body.pointer("/data/Packages").and_then(Value::as_array) {
        for pkg in list {
            // 注意：接口返回的容量字段是字符串（如 "733.77000261"），需兼容两种类型
            let parse_num = |key: &str| -> f64 {
                match pkg.get(key) {
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                    Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
                    _ => 0.0,
                }
            };
            packages.push(json!({
                "code": pkg.get("PackageCode").and_then(Value::as_str).unwrap_or(""),
                "total": parse_num("CycleTotalCapacity"),
                "used": parse_num("CycleUsedCapacity"),
                "remain": parse_num("CycleRemainCapacity"),
            }));
        }
    }
    // 排序：剩余量大的在前
    packages.sort_by(|a, b| {
        let ra = a.get("remain").and_then(Value::as_f64).unwrap_or(0.0);
        let rb = b.get("remain").and_then(Value::as_f64).unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(json!({
        "available": true,
        "isPaidUser": body.pointer("/data/IsPaidUser").and_then(Value::as_bool).unwrap_or(false),
        "packages": packages,
    }))
}

/// 汇总本地 `session_usage` 消耗记录（只读打开，WorkBuddy 运行中也能读）。
///
/// 返回 `{ available, reason?, totalCredits, todayCredits, last7dCredits,
/// sessionCount, totalTokens, todayTokens, last7dTokens, lastUpdated }`。
///
/// 「今日」按**自然日**（本地时区 0 点起）切分，而不是滚动 24 小时——
/// 滚动窗口会把昨天下午的消耗算进「今日」，与用户直觉不符。
///
/// Token 口径说明（重要）：
/// - `session_usage.used` 列并非累计消耗，而是**该会话最后一次同步时的
///   上下文快照**（= 最后一次请求的 input_tokens，已实测验证），且
///   WorkBuddy 的同步存在分钟级延迟——0 点前后尤其容易出现「今天明明
///   用了却统计为 0」。
/// - 因此 Token 的**今日/近7天**改用会话 jsonl（`~/.workbuddy/projects/
///   **/*.jsonl`，含 subagents/ 子目录）里的逐请求 `message.usage` 明细
///   实时聚合：`total_tokens = input_tokens + output_tokens`（实测
///   input 已包含 cache_read；cache_creation 目前恒为 0，出现时单独累加）。
///   该链路不依赖 WorkBuddy 的同步节奏，运行中也能读到最新请求。
/// - `totalTokens`（全量）仍取 DB 口径（jsonl 只保留近期会话，且 DB 里
///   历史行有完整快照），两者语义不同，不直接相加。
pub fn get_usage_stats() -> Result<Value, AppError> {
    let db_path = get_home_dir()
        .join(".workbuddy")
        .join("workbuddy.db");
    if !db_path.exists() {
        return Ok(json!({ "available": false, "reason": "noDb" }));
    }

    let conn = rusqlite::Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| {
            AppError::Database(format!("无法打开 WorkBuddy 数据库（可能正被占用）: {e}"))
        })?;
    conn.busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|e| AppError::Database(e.to_string()))?;

    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_usage'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(|e| AppError::Database(e.to_string()))?;
    if !table_exists {
        return Ok(json!({ "available": false, "reason": "noTable" }));
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // 本地时区「今天 0 点」与「7 天前的 0 点」，自然日切分。
    let today_start_ms = chrono::Local::now().date_naive().and_hms_opt(0, 0, 0)
        .map(|t| t.and_local_timezone(chrono::Local).single())
        .flatten()
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(now_ms - 24 * 60 * 60 * 1000);
    let week_start_ms = (chrono::Local::now().date_naive() - chrono::Duration::days(6))
        .and_hms_opt(0, 0, 0)
        .map(|t| t.and_local_timezone(chrono::Local).single())
        .flatten()
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(now_ms - 7 * 24 * 60 * 60 * 1000);

    let mut stmt = conn
        .prepare("SELECT used, updated_at, credit_json FROM session_usage")
        .map_err(|e| AppError::Database(e.to_string()))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| AppError::Database(e.to_string()))?;

    let mut total_credits = 0.0f64;
    let mut today_credits = 0.0f64;
    let mut last7d_credits = 0.0f64;
    let mut total_tokens = 0i64;
    let mut session_count = 0i64;
    let mut last_updated: i64 = 0;

    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::Database(e.to_string()))?
    {
        let used: i64 = row.get(0).unwrap_or(0);
        let updated_at: i64 = row.get(1).unwrap_or(0);
        let credit_json: String = row
            .get::<_, Option<String>>(2)
            .unwrap_or_default()
            .unwrap_or_default();
        session_count += 1;
        total_tokens += used;
        if updated_at > last_updated {
            last_updated = updated_at;
        }

        if credit_json.is_empty() {
            continue;
        }
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&credit_json) else {
            continue;
        };
        let session_credits: f64 = map
            .values()
            .filter_map(Value::as_f64)
            .sum();
        total_credits += session_credits;
        if updated_at >= today_start_ms {
            today_credits += session_credits;
        }
        if updated_at >= week_start_ms {
            last7d_credits += session_credits;
        }
    }

    // 今日/近 7 天 Token：走 jsonl 逐请求明细（实时，不依赖 WorkBuddy 同步）。
    let (today_tokens, last7d_tokens) =
        aggregate_tokens_from_transcripts(today_start_ms, week_start_ms);

    Ok(json!({
        "available": true,
        "totalCredits": total_credits,
        "todayCredits": today_credits,
        "last7dCredits": last7d_credits,
        "sessionCount": session_count,
        "totalTokens": total_tokens,
        "todayTokens": today_tokens,
        "last7dTokens": last7d_tokens,
        "lastUpdated": last_updated,
    }))
}

/// 遍历 `~/.workbuddy/projects/**/**.jsonl`（含 `subagents/` 子目录），
/// 聚合窗口内的逐请求 token 消耗。
///
/// 口径（实测验证）：
/// - 每条 assistant 消息的 `message.usage` 是一次请求的最终用量（按
///   message.id 去重，流式快照不会重复累加）；
/// - `total_tokens = input_tokens + output_tokens`；本机数据中
///   `input_tokens` 已包含 cache_read（186256 ⊇ 182272），因此不能再
///   单独加 cache_read；
/// - `cache_creation_input_tokens` 恒为 0，但为口径完备起见出现时累加。
///
/// 性能：先按文件 mtime 预过滤（窗口外的文件跳过），再按行预筛
/// `"usage"` 字符串后解析 JSON；本机 155MB / 67 文件全量扫描 < 1s，
/// mtime 预过滤后远小于此。
fn aggregate_tokens_from_transcripts(today_start_ms: i64, week_start_ms: i64) -> (i64, i64) {
    let projects_dir = get_home_dir().join(".workbuddy").join("projects");
    if !projects_dir.exists() {
        return (0, 0);
    }

    let mut jsonl_files: Vec<PathBuf> = Vec::new();
    collect_transcript_files(&projects_dir, &mut jsonl_files);

    let mut today_tokens = 0i64;
    let mut last7d_tokens = 0i64;
    let mut seen_message_ids: HashSet<String> = HashSet::new();

    for path in jsonl_files {
        // mtime 预过滤：文件从未在近 7 天内更新过则不可能含窗口内事件。
        // mtime 缓冲 1 分钟，容忍文件系统时间精度差异。
        let week_floor = week_start_ms - 60_000;
        match std::fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(modified) => {
                let mtime_ms = modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if mtime_ms < week_floor {
                    continue;
                }
            }
            Err(_) => continue,
        }

        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let reader = std::io::BufReader::new(file);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            // 廉价预筛：绝大多数行不含 usage
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(usage) = value
                .pointer("/message/usage")
                .and_then(Value::as_object)
            else {
                continue;
            };
            let Some(ts) = value.get("timestamp").and_then(parse_timestamp_ms) else {
                continue;
            };

            // 去重 key：优先用 message.id（assistant 行）；function_call / 工具
            // 调用行没有 message.id，但有唯一的顶层 id 与 callId——必须用它
            // 才能区分不同请求。⚠️ 绝不能退回 usage.len()（字段数恒定，
            // 会把同文件所有 function_call 行误判为重复而全部丢弃，导致
            // today 统计成 0——这是踩过的坑）。
            let dedup_id = {
                let msg_id = value.pointer("/message/id").and_then(Value::as_str);
                let top_id = value.get("id").and_then(Value::as_str);
                let call_id = value.get("callId").and_then(Value::as_str);
                let key = msg_id
                    .or(top_id)
                    .or(call_id)
                    .unwrap_or("__no_key__");
                format!("{}:{}", path.display(), key)
            };
            if !seen_message_ids.insert(dedup_id) {
                continue;
            }

            let get = |key: &str| -> i64 {
                usage.get(key).and_then(Value::as_i64).unwrap_or(0)
            };
            let input_tokens = get("input_tokens").max(get("inputTokens"));
            let output_tokens = get("output_tokens").max(get("outputTokens"));
            // cache_read 已包含在 input_tokens 内（实测 186256 ⊇ 182272），不重复计；
            // cache_creation 目前恒为 0，出现时单独累加保证口径完备。
            let cache_creation = get("cache_creation_input_tokens")
                .max(get("cacheCreationInputTokens"));

            let request_tokens = input_tokens + output_tokens + cache_creation;

            if ts >= today_start_ms {
                today_tokens += request_tokens;
            }
            if ts >= week_start_ms {
                last7d_tokens += request_tokens;
            }
        }
    }

    (today_tokens, last7d_tokens)
}

/// 递归收集 jsonl（含 subagents/ 子目录）。目录不存在或不可读时静默返回。
fn collect_transcript_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_transcript_files(&path, files);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

/// 解析 jsonl 的 `timestamp` 字段为毫秒时间戳。WorkBuddy 的历史格式有过
/// 演进：可能是毫秒数字，也可能是 ISO 8601 字符串。
fn parse_timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => {
            if let Ok(ms) = s.trim().parse::<i64>() {
                return Some(ms);
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp_millis())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实 ~/.workbuddy/workbuddy.db 汇总演练（无库时跳过）。
    ///
    /// 注意：这里刻意**不写死具体数值**。累计消耗/会话数会随真实使用持续增长
    /// （历史上 4452.57/45 等硬编码断言都因数据增长而失效），故只校验结构性
    /// 不变量：解析成功、数值非负、区间聚合不超过总量。
    #[test]
    fn usage_stats_against_real_db() {
        let stats = get_usage_stats().unwrap();
        if stats["available"] != json!(true) {
            return;
        }
        let total = stats["totalCredits"].as_f64().unwrap();
        let today = stats["todayCredits"].as_f64().unwrap();
        let last7d = stats["last7dCredits"].as_f64().unwrap();
        let session_count = stats["sessionCount"].as_u64().unwrap();

        assert!(total > 0.0, "totalCredits={total} 应大于 0（若为 0 说明 credit_json 解析失败）");
        assert!(session_count > 0, "sessionCount={session_count} 应大于 0");
        assert!(
            today >= 0.0 && today <= total,
            "todayCredits={today} 应满足 0 <= today <= total({total})"
        );
        assert!(
            last7d >= 0.0 && last7d <= total,
            "last7dCredits={last7d} 应满足 0 <= last7d <= total({total})"
        );
        assert!(today <= last7d, "今日消耗({today})不应超过近 7 日({last7d})");

        // Token 口径说明：totalTokens 来自 DB 快照列（语义=各会话最后同步
        // 时的上下文快照之和），today/last7d 来自 jsonl 逐请求明细（实时，
        // 全量累加，量级远大于 DB 快照是正常的）。两者数据源不同、语义不同，
        // 不构成单调或同量级关系，只校验各自的结构性不变量。
        let total_tokens = stats["totalTokens"].as_i64().unwrap();
        let today_tokens = stats["todayTokens"].as_i64().unwrap();
        let last7d_tokens = stats["last7dTokens"].as_i64().unwrap();
        assert!(total_tokens > 0, "totalTokens={total_tokens} 应大于 0（DB used 快照列求和）");
        assert!(today_tokens > 0, "todayTokens={today_tokens} 应大于 0（今天有实际消耗，jsonl 明细应能读到）");
        assert!(today_tokens >= 0, "todayTokens 不应为负");
        assert!(last7d_tokens >= 0, "last7dTokens 不应为负");
        assert!(
            today_tokens <= last7d_tokens,
            "今日 tokens({today_tokens}) 不应超过近 7 日({last7d_tokens})"
        );
    }

    /// 无 id 行的去重兜底不崩溃、usage 缺失行被跳过、时间窗切分正确。
    /// 构造临时 projects 目录并注入 HOME 不可行（get_home_dir 读环境变量
    /// 只在进程启动时确定），故直接用本机真实数据做结构断言（无数据跳过）。
    #[test]
    fn transcript_aggregate_smoke() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let (today, week) = aggregate_tokens_from_transcripts(now - 6 * 3600_000, now - 7 * 86400_000);
        // 窗口重叠：today 计入的事件必然也被 week 计入
        assert!(
            today <= week,
            "today({today}) 应 <= week({week})"
        );
    }

    /// 本机真实凭证 → 云端余额接口演练（无凭证时跳过）。
    /// 验证带 User-Agent 的请求能通过网关 WAF 拿到真实余额。
    #[tokio::test]
    async fn credits_balance_against_real_auth() {
        if auth_info_candidates().iter().all(|p| !p.exists()) {
            return;
        }
        let balance = get_credits_balance().await.unwrap();
        assert_eq!(
            balance["available"],
            json!(true),
            "带 UA 的真实凭证请求应成功: {balance}"
        );
        assert!(balance["packages"].is_array());
        let packages = balance["packages"].as_array().unwrap();
        assert!(!packages.is_empty());
        // 字符串容量解析后必须大于 0。
        // 同样不写死总额：资源包会随购买/过期变化（历史快照 4559+500=5059
        // 早已过期），只校验每个包都能解析出数字且剩余量不超过总额。
        let total: f64 = packages
            .iter()
            .map(|p| p["total"].as_f64().unwrap_or(0.0))
            .sum();
        assert!(
            total > 0.0,
            "总容量应 > 0，实际 {total}——若为 0 说明字符串容量解析失败"
        );
        for pkg in packages {
            assert!(pkg["total"].is_f64(), "package.total 应为数字: {pkg}");
            assert!(pkg["remain"].is_f64(), "package.remain 应为数字: {pkg}");
            let pkg_total = pkg["total"].as_f64().unwrap();
            let remain = pkg["remain"].as_f64().unwrap();
            assert!(pkg_total > 0.0, "包容量应 > 0: {pkg}");
            assert!(
                remain >= 0.0 && remain <= pkg_total,
                "剩余({remain})应满足 0 <= remain <= total({pkg_total}): {pkg}"
            );
        }
    }
}
