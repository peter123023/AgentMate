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
use std::path::PathBuf;
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
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ModelBoard",
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
/// sessionCount, totalTokens, lastUpdated }`。
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
    let day_ms: i64 = 24 * 60 * 60 * 1000;

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
        if updated_at >= now_ms - day_ms {
            today_credits += session_credits;
        }
        if updated_at >= now_ms - 7 * day_ms {
            last7d_credits += session_credits;
        }
    }

    Ok(json!({
        "available": true,
        "totalCredits": total_credits,
        "todayCredits": today_credits,
        "last7dCredits": last7d_credits,
        "sessionCount": session_count,
        "totalTokens": total_tokens,
        "lastUpdated": last_updated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实 ~/.workbuddy/workbuddy.db 汇总演练（无库时跳过）。
    /// 累计积分与 `sqlite3 "SELECT SUM(...)"` 手查值对齐。
    #[test]
    fn usage_stats_against_real_db() {
        let stats = get_usage_stats().unwrap();
        if stats["available"] != json!(true) {
            return;
        }
        let total = stats["totalCredits"].as_f64().unwrap();
        // 手查总消耗 ≈ 4452.57（允许浮点误差）
        assert!(
            (total - 4452.57).abs() < 0.01,
            "totalCredits={total} 应与 sqlite3 手查一致"
        );
        assert_eq!(stats["sessionCount"], json!(45));
        assert!(stats["todayCredits"].as_f64().unwrap() <= total);
        assert!(stats["last7dCredits"].as_f64().unwrap() <= total);
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
        // 字符串容量解析后必须大于 0（真实账户有两个包：4559 与 500）
        let total: f64 = packages
            .iter()
            .map(|p| p["total"].as_f64().unwrap_or(0.0))
            .sum();
        assert!(
            (total - 5059.0).abs() < 1.0,
            "总容量应 ≈ 5059（4559+500），实际 {total}——若为 0 说明字符串容量解析失败"
        );
        for pkg in packages {
            assert!(pkg["total"].is_f64());
            assert!(pkg["remain"].is_f64());
        }
    }
}
