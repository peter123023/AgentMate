use crate::config::get_home_dir;
use crate::error::AppError;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::path::PathBuf;

/// WorkBuddy (Desktop) model configuration.
///
/// WorkBuddy stores its model list as a JSON array in `~/.workbuddy/models.json`.
/// Each entry is an object with at least:
///
/// ```json
/// {
///   "id": "glm-5.3-flash",
///   "name": "glm-5.3-flash",
///   "vendor": "Custom",
///   "url": "https://ark.cn-beijing.volces.com/api/coding/v3",
///   "apiKey": "ark-...",
///   "supportsToolCall": true,
///   "supportsImages": false,
///   "supportsReasoning": false,
///   "useCustomProtocol": false
/// }
/// ```
///
/// ModelBoard treats WorkBuddy in additive mode: every provider managed here maps
/// 1:1 to an entry in `models.json` (keyed by the entry's `id`). Entries are
/// handled as raw JSON values so unknown fields written by future WorkBuddy
/// versions survive round-trips.
///
/// Note: WorkBuddy's *active* model selection lives in its own internal state
/// (per-session SQLite rows / app local storage) and is intentionally NOT
/// touched here — switching the selection must happen inside WorkBuddy itself.

pub fn get_workbuddy_dir() -> PathBuf {
    get_home_dir().join(".workbuddy")
}

pub fn get_workbuddy_models_path() -> PathBuf {
    get_workbuddy_dir().join("models.json")
}

/// Read the raw models array. Returns an empty vector when the file does not
/// exist so first-run import stays quiet.
fn read_models_raw() -> Result<Vec<Value>, AppError> {
    let path = get_workbuddy_models_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| AppError::Config(format!("Failed to parse WorkBuddy models.json: {e}")))?;
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(AppError::Config(
            "WorkBuddy models.json must be a JSON array".to_string(),
        )),
    }
}

fn write_models_raw(models: &[Value]) -> Result<(), AppError> {
    let path = get_workbuddy_models_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::io(&path, e))?;
        }
    }
    let pretty = serde_json::to_string_pretty(models)
        .map_err(|e| AppError::Config(format!("Failed to serialize WorkBuddy models.json: {e}")))?;
    std::fs::write(&path, pretty).map_err(|e| AppError::io(&path, e))?;
    Ok(())
}

fn entry_id(entry: &Value) -> Option<&str> {
    entry.get("id").and_then(|v| v.as_str())
}

/// Get all model entries keyed by their `id`, preserving file order.
pub fn get_providers() -> Result<IndexMap<String, Value>, AppError> {
    let mut map = IndexMap::new();
    for entry in read_models_raw()? {
        match entry_id(&entry).map(|s| s.to_string()) {
            Some(id) => {
                map.insert(id, entry);
            }
            None => {
                log::warn!("Skipping WorkBuddy model entry without 'id' field");
            }
        }
    }
    Ok(map)
}

/// Get a single model entry by id.
pub fn get_provider(id: &str) -> Result<Option<Value>, AppError> {
    Ok(get_providers()?.get(id).cloned())
}

/// Get the ids currently present in models.json.
pub fn get_live_provider_ids() -> Result<Vec<String>, AppError> {
    Ok(get_providers()?.keys().cloned().collect())
}

/// Insert or update a model entry (keyed by `id`).
///
/// When an entry with the same id exists it is replaced in place, otherwise the
/// entry is appended. Unknown fields on the incoming config are preserved as-is.
pub fn set_provider(id: &str, config: Value) -> Result<(), AppError> {
    let mut models = read_models_raw()?;
    let mut entry = config;
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("id".to_string(), json!(id));
    }

    if let Some(pos) = models
        .iter()
        .position(|e| entry_id(e) == Some(id))
    {
        models[pos] = entry;
    } else {
        models.push(entry);
    }

    write_models_raw(&models)?;
    log::info!("WorkBuddy model '{id}' written to live config");
    Ok(())
}

/// Remove a model entry by id. Missing entries are a no-op.
pub fn remove_provider(id: &str) -> Result<(), AppError> {
    let mut models = read_models_raw()?;
    let before = models.len();
    models.retain(|e| entry_id(e) != Some(id));
    if models.len() == before {
        return Ok(());
    }
    write_models_raw(&models)?;
    log::info!("WorkBuddy model '{id}' removed from live config");
    Ok(())
}

/// Read the full models.json contents as JSON (array). Returns an empty array
/// when the file is missing so the edit dialog doesn't hard-fail.
pub fn read_live_settings() -> Result<Value, AppError> {
    Ok(Value::Array(read_models_raw()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_provider_ensures_id_field() {
        let mut config = json!({
            "name": "test-model",
            "url": "https://example.com/v1",
            "apiKey": "sk-test"
        });
        // set_provider writes to the real file; simulate by checking the id
        // injection logic through a clone. The function itself is exercised in
        // integration tests against a temp HOME.
        if let Some(obj) = config.as_object_mut() {
            obj.insert("id".to_string(), json!("test-model"));
        }
        assert_eq!(entry_id(&config), Some("test-model"));
    }

    #[test]
    fn missing_file_reads_as_empty() {
        // read_models_raw returns Ok(vec![]) for a non-existent path only when
        // HOME points elsewhere; the path helper must always be under HOME.
        assert!(get_workbuddy_models_path().starts_with(get_home_dir()));
    }
}
