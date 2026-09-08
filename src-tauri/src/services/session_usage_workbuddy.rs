//! WorkBuddy 会话日志使用追踪
//!
//! 从 `~/.workbuddy/projects/**/*.jsonl` 提取精确 token 使用数据，写入
//! `proxy_request_logs`，让概览页/完整统计页能看到 WorkBuddy 的消耗
//! （此前 WorkBuddy 既不走代理、也没有同步器，概览页恒为 0）。
//!
//! ## 数据流
//! ```text
//! ~/.workbuddy/projects/**/*.jsonl → 增量解析 → 去重 → 费用计算 → proxy_request_logs 表
//! ```
//!
//! ## WorkBuddy jsonl 结构（实测，区别于 Claude/Codex）
//! - 顶层 `type` 为 `function_call` / `message` 等，usage 位于
//!   `message.usage`（`input_tokens` / `output_tokens` /
//!   `cache_read_input_tokens` / `total_tokens`）；
//! - 每行 = 一次真实 API 请求（实测同文件 206 行顶层 `id` 全部唯一，
//!   `function_call` 行的 `callId` 也全部唯一，无 Claude 式累计值
//!   delta，天然按行去重）；
//! - `message.usage.input_tokens` **已包含** `cache_read_input_tokens`
//!   （实测 189200 ≈ 188800 + fresh 400，与 DB `used` 快照同口径），
//!   存储时拆成 fresh input 列 + 独立 cache_read 列（Anthropic 语义，
//!   计费时 cache 走低价）；
//! - `timestamp` 是**毫秒数字**（历史格式也可能为 ISO 字符串，解析兼容）；
//! - model 在 `providerData.requestModelId`（如 `custom-local:deepseek-v4-flash`，
//!   剥前缀后可命中定价表）/ `requestModelName` / `model`，不在 message 里。

use crate::config::get_home_dir;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::calculator::{CostCalculator, ModelPricing};
use crate::proxy::usage::parser::TokenUsage;
use crate::services::session_usage::{
    load_sync_cursors, metadata_modified_nanos, SessionSyncResult, SyncCursor,
};
use crate::services::usage_stats::{find_model_pricing, should_skip_session_insert, DedupKey};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const WORKBUDDY_REQUEST_ID_PREFIX: &str = "workbuddy_session";

/// 单次 API 请求的 token 用量（fresh input 已在插入前拆分）。
#[derive(Debug)]
struct WorkBuddyUsage {
    /// 顶层 `id`（行唯一，直接作为 request_id 主体）
    top_id: String,
    /// 归一化后的模型名（用于定价与展示）
    model: String,
    /// fresh input（不含 cache read）
    input_tokens: u32,
    output_tokens: u32,
    /// 独立 cache read（按低价计费）
    cache_read_tokens: u32,
    session_id: Option<String>,
    /// 毫秒时间戳（缺失时插入层兜底当前时间）
    timestamp: Option<i64>,
}

/// 单文件一轮同步结果。
#[derive(Debug, Default)]
struct WorkBuddyFileSync {
    imported: u32,
    skipped: u32,
}

/// 同步 WorkBuddy 使用数据（从 `~/.workbuddy/projects` JSONL 会话日志）。
pub fn sync_workbuddy_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let projects_dir = get_home_dir().join(".workbuddy").join("projects");
    let files = collect_workbuddy_jsonl(&projects_dir);

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: files.len() as u32,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };
    if files.is_empty() {
        return Ok(result);
    }

    let cursors = load_sync_cursors(db)?;

    for file_path in &files {
        let cursor = cursors.get(file_path.to_string_lossy().as_ref());
        match sync_single_workbuddy_file(db, file_path, cursor) {
            Ok(file_result) => {
                result.imported = result.imported.saturating_add(file_result.imported);
                result.skipped = result.skipped.saturating_add(file_result.skipped);
            }
            Err(e) => {
                let msg = format!("WorkBuddy 会话文件解析失败 {}: {e}", file_path.display());
                log::warn!("[WORKBUDDY-SYNC] {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.imported > 0 {
        log::info!(
            "[WORKBUDDY-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, 扫描 {} 个文件",
            result.imported,
            result.skipped,
            result.files_scanned
        );
    }

    Ok(result)
}

/// 递归收集 WorkBuddy 项目目录下所有 `.jsonl`（含子 agent 嵌套目录）。
///
/// WorkBuddy 布局：`projects/<编码后目录名>/<sessionId>.jsonl` 为主会话，
/// 子 agent / Task 会话散落在更深层子目录里。与 Claude 不同这里没有
/// `journal.jsonl` 之类杂质（即便有也会因无 usage 行被解析层跳过），
/// 直接全树递归即可，无需限深。
fn collect_workbuddy_jsonl(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_workbuddy_jsonl_recursive(dir, &mut files);
    files.sort();
    files
}

fn collect_workbuddy_jsonl_recursive(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_workbuddy_jsonl_recursive(&path, files);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

/// 解析 jsonl 行顶层 `timestamp`：可能是毫秒数字，也可能（历史格式）是
/// ISO 8601 字符串。统一返回**毫秒**。
fn parse_timestamp_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    match value {
        serde_json::Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => {
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

/// 从 `providerData` 提取归一化模型名。
///
/// 优先级：`requestModelId`（剥 `custom-local:` 之类命名空间前缀）>
/// `requestModelName` > `model`。返回值用于定价查找与展示，尽力与
/// 定价表的 `model_id`（如 `deepseek-v4-flash`）对齐。
fn extract_model_name(value: &serde_json::Value) -> String {
    let provider_data = value.get("providerData");
    let pick = |key: &str| -> Option<String> {
        provider_data
            .and_then(|pd| pd.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    };

    let raw = pick("requestModelId")
        .or_else(|| pick("requestModelName"))
        .or_else(|| pick("model"))
        .unwrap_or_else(|| {
            value
                .pointer("/message/model")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| "unknown".to_string())
        });

    // 剥命名空间前缀：取最后一个 ':' 或 '/' 之后的片段。
    // `custom-local:deepseek-v4-flash` → `deepseek-v4-flash`
    raw.rsplit([':', '/'])
        .next()
        .unwrap_or(&raw)
        .trim()
        .to_string()
}

/// 解析单行 usage 为 [`WorkBuddyUsage`]。返回 `None` 表示该行不含可用
/// 用量（可能是无 usage 的事件行、缺顶层 id 的流式中间行、全零用量等）。
fn parse_usage_line(line: &str) -> Result<Option<WorkBuddyUsage>, AppError> {
    if !line.contains("\"usage\"") {
        return Ok(None);
    }
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    // 顶层 id：function_call / message 行都有，且行内唯一
    let Some(top_id) = value.get("id").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    if top_id.trim().is_empty() {
        return Ok(None);
    }

    let Some(usage) = value.pointer("/message/usage").and_then(|u| u.as_object()) else {
        return Ok(None);
    };
    if usage.is_empty() {
        return Ok(None);
    }

    let get = |key: &str, alt: &str| -> u64 {
        usage
            .get(key)
            .or_else(|| usage.get(alt))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    let raw_input = get("input_tokens", "inputTokens");
    let output = get("output_tokens", "outputTokens");
    let cache_read = get("cache_read_input_tokens", "cacheReadInputTokens");

    // 实测 input 已包含 cache read；cache_creation 恒为 0（出现时并入 input
    // 语义的拆分由插入层处理）。全零（纯异常行）直接跳过。
    if raw_input == 0 && output == 0 && cache_read == 0 {
        return Ok(None);
    }

    let timestamp = parse_timestamp_ms(value.get("timestamp"));
    let session_id = value
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    // 拆分 cache：fresh input = max(raw_input - cache_read, 0)。实测本机
    // 数据 cache_read <= input 恒成立（input 是含 cache 的上下文总量）。
    let input_tokens = raw_input.saturating_sub(cache_read) as u32;
    let model = extract_model_name(&value);

    Ok(Some(WorkBuddyUsage {
        top_id: top_id.to_string(),
        model,
        input_tokens,
        output_tokens: output as u32,
        cache_read_tokens: cache_read as u32,
        session_id,
        timestamp,
    }))
}

/// 单文件增量同步。
///
/// 增量语义：游标记录**字节偏移**与文件 mtime。mtime 未变直接跳过；
/// 变化后 seek 到游标偏移只读新增尾部（活跃会话文件每轮无需整文件重读）。
/// 游标只推进到最后一个**完整行**（以 `\n` 结尾）之后——写进程可能正在
/// 追加，半行不会计入游标、下一轮补全后再处理，避免整行永久丢失。
///
/// 幂等：`request_id = workbuddy_session:<文件 stem>:<顶层 id>`，配合
/// INSERT OR IGNORE 主键去重，重复扫描/中断重跑不会双算。
fn sync_single_workbuddy_file(
    db: &Database,
    file_path: &Path,
    cursor: Option<&SyncCursor>,
) -> Result<WorkBuddyFileSync, AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();

    let metadata = fs::metadata(file_path)
        .map_err(|e| AppError::Config(format!("无法读取文件元数据: {e}")))?;
    let file_modified = metadata_modified_nanos(&metadata);
    let file_size = metadata.len() as i64;

    let last_modified = cursor.map_or(0, |c| c.last_modified);
    let last_byte_offset = cursor.and_then(|c| c.last_byte_offset);

    // 文件未变化则跳过
    if file_modified <= last_modified {
        return Ok(WorkBuddyFileSync::default());
    }

    let mut file = fs::File::open(file_path)
        .map_err(|e| AppError::Config(format!("无法打开文件: {e}")))?;

    // 确定起始读取位置：截断（游标越过当前文件大小）回退全量重扫——
    // request_id 幂等保证不双算（WorkBuddy jsonl 只追加不重写，截断仅
    // 出现于用户手动删除历史等极端情形）。
    let start_byte = match last_byte_offset {
        Some(offset) if offset <= file_size => offset,
        _ => {
            if last_byte_offset.is_some() {
                log::warn!(
                    "[WORKBUDDY-SYNC] 文件被截断（游标 {} > 大小 {}），全量重扫: {}",
                    last_byte_offset.unwrap_or(0),
                    file_size,
                    file_path.display()
                );
            }
            0
        }
    };

    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(start_byte as u64))
        .map_err(|e| AppError::Config(format!("无法定位文件偏移: {e}")))?;

    let mut reader = BufReader::new(file);
    let mut committed_offset = start_byte;
    let mut buf: Vec<u8> = Vec::new();
    let mut usage_rows: Vec<WorkBuddyUsage> = Vec::new();

    // 只推进到最后一个完整行（以 \n 结尾）之后；写进程可能正在追加，
    // 半行不推进游标、下一轮补齐后处理，避免整行永久丢失。半行若恰好
    // 是完整 JSON（写入方先落内容后落换行），仍会解析入库——request_id
    // 幂等保证下一轮补齐重读时不会双算。
    loop {
        buf.clear();
        let read = match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                log::warn!(
                    "[WORKBUDDY-SYNC] 读取中断 {}: {e}",
                    file_path.display()
                );
                break;
            }
        };
        if buf.ends_with(b"\n") {
            committed_offset += read as i64;
        }

        if buf.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(Some(parsed)) = parse_usage_line(line) {
            usage_rows.push(parsed);
        }
    }

    // 文件无任何新 usage → 直接推进游标（含半行场景下只推进到完整行尾）
    if usage_rows.is_empty() {
        update_workbuddy_sync_state(
            db,
            &file_path_str,
            file_modified,
            committed_offset,
        )?;
        return Ok(WorkBuddyFileSync::default());
    }

    // 写库 + 游标推进原子提交（参考 Claude 路径：中途崩溃两者一起回滚，
    // 不会出现「游标已推进但数据缺失」）。
    let mut result = WorkBuddyFileSync::default();
    let conn = lock_conn!(db.conn);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Database(format!("开启 WorkBuddy 会话写入事务失败: {e}")))?;

    let file_stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");

    let mut pricing_cache: HashMap<String, Option<ModelPricing>> = HashMap::new();
    for usage in &usage_rows {
        let request_id = format!(
            "{WORKBUDDY_REQUEST_ID_PREFIX}:{file_stem}:{}",
            usage.top_id
        );
        match insert_workbuddy_session_entry_on_conn(
            &tx,
            &request_id,
            usage,
            &mut pricing_cache,
        ) {
            Ok(true) => result.imported += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => {
                log::warn!("[WORKBUDDY-SYNC] 插入失败 ({request_id}): {e}");
                result.skipped += 1;
            }
        }
    }

    update_workbuddy_sync_state_on_conn(&tx, &file_path_str, file_modified, committed_offset)?;
    tx.commit()
        .map_err(|e| AppError::Database(format!("提交 WorkBuddy 会话写入事务失败: {e}")))?;

    Ok(result)
}

/// 更新 WorkBuddy 文件的字节游标（自取锁便捷包装）。
fn update_workbuddy_sync_state(
    db: &Database,
    file_path: &str,
    last_modified: i64,
    byte_offset: i64,
) -> Result<(), AppError> {
    let conn = lock_conn!(db.conn);
    update_workbuddy_sync_state_on_conn(&conn, file_path, last_modified, byte_offset)
}

/// 字节游标写入（免锁版，供已持锁事务使用）。行号列固定置 0，明确表示
/// 本路径只用字节游标。
fn update_workbuddy_sync_state_on_conn(
    conn: &rusqlite::Connection,
    file_path: &str,
    last_modified: i64,
    byte_offset: i64,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.prepare_cached(
        "INSERT OR REPLACE INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at, last_byte_offset, last_tail_fingerprint)
         VALUES (?1, ?2, 0, ?3, ?4, NULL)",
    )
    .and_then(|mut stmt| stmt.execute(rusqlite::params![file_path, last_modified, now, byte_offset]))
    .map_err(|e| AppError::Database(format!("更新 WorkBuddy 同步状态失败: {e}")))?;
    Ok(())
}

/// 插入单条 WorkBuddy 会话记录到 proxy_request_logs（已持锁/事务版本）。
#[allow(clippy::too_many_arguments)]
fn insert_workbuddy_session_entry_on_conn(
    conn: &rusqlite::Connection,
    request_id: &str,
    usage: &WorkBuddyUsage,
    pricing_cache: &mut HashMap<String, Option<ModelPricing>>,
) -> Result<bool, AppError> {
    // created_at：秒级时间戳。jsonl timestamp 为毫秒；缺失时兜底当前时间
    let created_at = usage
        .timestamp
        .map(|ms| ms / 1000)
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });

    let dedup_key = DedupKey {
        app_type: "workbuddy",
        model: &usage.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: 0,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }

    // 计算费用。model 已归一化（剥命名空间前缀），可直接查定价表；
    // 查不到（如 glm-5.3-flash 无定价行）时各成本列记 0。
    let token_usage = TokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: 0,
        model: Some(usage.model.clone()),
        message_id: None,
    };

    let pricing = pricing_cache
        .entry(usage.model.clone())
        .or_insert_with(|| find_model_pricing(conn, &usage.model));
    let multiplier = Decimal::from(1);
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
        match pricing {
            Some(p) => {
                let cost = CostCalculator::calculate_for_app("workbuddy", &token_usage, p, multiplier);
                (
                    cost.input_cost.to_string(),
                    cost.output_cost.to_string(),
                    cost.cache_read_cost.to_string(),
                    cost.cache_creation_cost.to_string(),
                    cost.total_cost.to_string(),
                )
            }
            None => (
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
            ),
        };

    let inserted_rows = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        )
        .and_then(|mut stmt| stmt.execute(rusqlite::params![
                request_id,
                "_workbuddy_session", // provider_id
                "workbuddy",          // app_type
                usage.model,
                usage.model,          // request_model
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                0i64,                 // cache_creation_tokens
                input_cost,
                output_cost,
                cache_read_cost,
                cache_creation_cost,
                total_cost,
                0i64,                 // latency_ms
                Option::<i64>::None,  // first_token_ms
                200i64,               // status_code
                Option::<String>::None, // error_message
                usage.session_id.clone(),
                Some("workbuddy_session"), // provider_type
                1i64,                 // is_streaming
                "1.0",                // cost_multiplier
                created_at,
                "workbuddy_session",  // data_source
            ]))
        .map_err(|e| AppError::Database(format!("插入 WorkBuddy 会话日志失败: {e}")))?;

    Ok(inserted_rows > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_model_name_strips_custom_local_prefix() {
        let value = serde_json::json!({
            "providerData": {
                "model": "deepseek-v4-flash-ga-260731",
                "requestModelId": "custom-local:deepseek-v4-flash",
                "requestModelName": "Deepseek-V4-Flash"
            }
        });
        assert_eq!(extract_model_name(&value), "deepseek-v4-flash");
    }

    #[test]
    fn test_extract_model_name_falls_back() {
        let value = serde_json::json!({
            "providerData": { "model": "glm-5-3-flash" }
        });
        assert_eq!(extract_model_name(&value), "glm-5-3-flash");

        let value = serde_json::json!({ "providerData": {} });
        assert_eq!(extract_model_name(&value), "unknown");
    }

    #[test]
    fn test_extract_model_name_from_message_model() {
        let value = serde_json::json!({
            "message": { "model": "fallback-model" }
        });
        assert_eq!(extract_model_name(&value), "fallback-model");
    }

    #[test]
    fn test_parse_usage_line_function_call() {
        let line = serde_json::json!({
            "type": "function_call",
            "id": "02178888312152943",
            "callId": "call_abc",
            "sessionId": "sess-1",
            "timestamp": 1788883219751i64,
            "message": {
                "usage": {
                    "input_tokens": 189200,
                    "output_tokens": 4461,
                    "cache_read_input_tokens": 188800,
                    "total_tokens": 193661
                }
            },
            "providerData": { "requestModelId": "custom-local:deepseek-v4-flash" }
        })
        .to_string();

        let parsed = parse_usage_line(&line).unwrap().unwrap();
        // input 含 cache → 拆分为 fresh input
        assert_eq!(parsed.input_tokens, 400);
        assert_eq!(parsed.output_tokens, 4461);
        assert_eq!(parsed.cache_read_tokens, 188800);
        assert_eq!(parsed.model, "deepseek-v4-flash");
        assert_eq!(parsed.top_id, "02178888312152943");
        assert_eq!(parsed.session_id.as_deref(), Some("sess-1"));
        assert_eq!(parsed.timestamp, Some(1788883219751));
    }

    #[test]
    fn test_parse_usage_line_skips_non_usage_lines() {
        // 无 usage 的事件行
        let line = serde_json::json!({
            "type": "reasoning",
            "id": "x",
            "message": { "content": "thinking..." }
        })
        .to_string();
        assert!(parse_usage_line(&line).unwrap().is_none());

        // 全零用量
        let line = serde_json::json!({
            "type": "message",
            "id": "y",
            "message": { "usage": { "input_tokens": 0, "output_tokens": 0 } }
        })
        .to_string();
        assert!(parse_usage_line(&line).unwrap().is_none());

        // 非 JSON 行
        assert!(parse_usage_line("not json at all").unwrap().is_none());
    }

    #[test]
    fn test_parse_timestamp_ms_formats() {
        // 毫秒数字
        assert_eq!(
            parse_timestamp_ms(Some(&serde_json::json!(1788883219751i64))),
            Some(1788883219751)
        );
        // 数字字符串
        assert_eq!(
            parse_timestamp_ms(Some(&serde_json::json!("1788883219751"))),
            Some(1788883219751)
        );
        // ISO 字符串
        assert_eq!(
            parse_timestamp_ms(Some(&serde_json::json!("2026-09-09T00:00:00+08:00"))),
            Some(1788883200000)
        );
        assert_eq!(parse_timestamp_ms(None), None);
    }

    #[test]
    fn test_collect_workbuddy_jsonl_nonexistent() {
        let files = collect_workbuddy_jsonl(Path::new("/nonexistent/workbuddy/projects"));
        assert!(files.is_empty());
    }

    /// 本机真实 ~/.workbuddy/projects 端到端冒烟（无数据时跳过）。
    ///
    /// 使用内存数据库（Database::memory），只读本机 jsonl、不污染真实库。
    /// 断言分两层：至少扫描到文件（环境有 WorkBuddy 会话）；若文件含
    /// usage 行则应成功导入（今天有真实消耗），且字节游标落库。
    #[test]
    fn sync_workbuddy_usage_against_real_transcripts() -> Result<(), AppError> {
        let projects_dir = get_home_dir().join(".workbuddy").join("projects");
        if !projects_dir.exists() {
            return Ok(());
        }
        let files = collect_workbuddy_jsonl(&projects_dir);
        if files.is_empty() {
            return Ok(());
        }

        let db = Database::memory()?;
        let result = sync_workbuddy_usage(&db)?;
        assert_eq!(result.files_scanned, files.len() as u32);
        assert!(
            result.errors.is_empty(),
            "同步不应报错: {:?}",
            result.errors
        );

        // 游标应已写入（至少对 mtime > 0 的文件）。若有 usage 行则应有导入。
        let conn = lock_conn!(db.conn);
        let cursor_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM session_log_sync WHERE file_path LIKE '%/.workbuddy/projects/%'",
            [],
            |row| row.get(0),
        )?;
        let imported = result.imported + result.skipped;
        if imported > 0 {
            assert!(cursor_count > 0, "有导入则必有游标落库");
            let row_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'workbuddy_session'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(row_count, result.imported as i64);
        }
        Ok(())
    }
}
