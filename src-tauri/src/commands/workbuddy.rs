use tauri::State;

use crate::store::AppState;
use crate::workbuddy_config;

/// Import models from WorkBuddy live config (models.json) into the database.
///
/// WorkBuddy uses additive mode — users may already have models configured
/// in ~/.workbuddy/models.json.
#[tauri::command]
pub fn import_workbuddy_providers_from_live(state: State<'_, AppState>) -> Result<usize, String> {
    crate::services::provider::import_workbuddy_providers_from_live(state.inner())
        .map_err(|e| e.to_string())
}

/// Get model ids currently present in WorkBuddy's models.json.
#[tauri::command]
pub fn get_workbuddy_live_provider_ids() -> Result<Vec<String>, String> {
    workbuddy_config::get_live_provider_ids().map_err(|e| e.to_string())
}

/// Get a single WorkBuddy model entry from live config.
#[tauri::command]
pub fn get_workbuddy_live_provider(
    #[allow(non_snake_case)] providerId: String,
) -> Result<Option<serde_json::Value>, String> {
    workbuddy_config::get_provider(&providerId).map_err(|e| e.to_string())
}

/// Query WorkBuddy cloud credit balance (read-only, best-effort).
///
/// Never fails hard — unavailability is expressed via `available/reason`
/// so the frontend can silently degrade.
#[tauri::command]
pub async fn get_workbuddy_credits_balance() -> Result<serde_json::Value, String> {
    crate::services::workbuddy_stats::get_credits_balance()
        .await
        .map_err(|e| e.to_string())
}

/// Summarize local credit consumption from WorkBuddy's own SQLite DB
/// (read-only). WorkBuddy may be running — a busy timeout is applied.
#[tauri::command]
pub async fn get_workbuddy_usage_stats() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::services::workbuddy_stats::get_usage_stats()
    })
    .await
    .map_err(|e| format!("查询 WorkBuddy 消耗统计失败: {e}"))?
    .map_err(|e| e.to_string())
}
