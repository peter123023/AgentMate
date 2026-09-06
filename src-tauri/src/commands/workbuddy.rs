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
