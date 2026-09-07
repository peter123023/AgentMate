//! DeepSeek Harness (DSH) 配置文件读写模块
//!
//! DSH 把用户级设置放在 `$DSH_HOME/settings.yaml`，其中 `llm-pi-ai:` 段承载
//! 多供应商配置（官方文档明确说明这段由 web 端 Models 页面写入、热重载生效），
//! 密钥通过 `apiKeyEnv` 引用 `$DSH_HOME/.credentials.yaml` 中的条目，
//! 当前激活模型则由每个 profile 的 `cordis.patch.yml` 里
//! `id: agent-default-model` 条目的 `config.provider/model` 决定。
//!
//! ## 配置结构
//!
//! ```yaml
//! # ~/.dsh/settings.yaml
//! llm-pi-ai:
//!   providers:
//!     my-openai:              # route key 即供应商标识
//!       displayName: 我的 OpenAI
//!       api: openai-completions
//!       baseURL: https://api.example.com/v1
//!       apiKeyEnv: DSH_MB_MY_OPENAI
//!       models:
//!         - id: gpt-4o
//!           name: GPT-4o
//! ```
//!
//! ```yaml
//! # ~/.dsh/.credentials.yaml
//! DSH_MB_MY_OPENAI: sk-...
//! ```
//!
//! ```yaml
//! # ~/.dsh/profiles/<name>/cordis.patch.yml
//! - insert:
//!     - id: agent-default-model
//!       name: '@deepseek-ai/dsh-agent-default-model'
//!       config:
//!         provider: my-openai
//!         model: gpt-4o
//! ```
//!
//! 供应商列表是全局的（settings.yaml），而"当前激活"按 profile 各自记录。
//! ModelBoard 切换供应商时写入**所有** profile，保证无论用哪个 profile 启动，
//! 当前模型都是用户的选择。

use crate::config::{atomic_write, get_home_dir};
use crate::error::AppError;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 供应商配置所在的 settings 段与子键
const LLM_SECTION: &str = "llm-pi-ai";
const PROVIDERS_KEY: &str = "providers";
/// 当前模型条目在 cordis.patch.yml 中的 id 与插件名
const DEFAULT_MODEL_ID: &str = "agent-default-model";
const DEFAULT_MODEL_PLUGIN: &str = "@deepseek-ai/dsh-agent-default-model";
/// ModelBoard 写入凭证时使用的前缀（避免与用户自己的环境变量冲突）
const CREDENTIAL_PREFIX: &str = "DSH_MB_";

// ============================================================================
// 路径
// ============================================================================

/// DSH 配置根目录：优先 `DSH_HOME`，否则 `~/.dsh`
pub fn get_dsh_home() -> PathBuf {
    if let Some(raw) = std::env::var_os("DSH_HOME") {
        let trimmed = raw.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    get_home_dir().join(".dsh")
}

pub fn get_settings_path() -> PathBuf {
    get_dsh_home().join("settings.yaml")
}

pub fn get_credentials_path() -> PathBuf {
    get_dsh_home().join(".credentials.yaml")
}

pub fn get_profiles_dir() -> PathBuf {
    get_dsh_home().join("profiles")
}

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ============================================================================
// settings.yaml 读写
// ============================================================================

/// 读取 settings.yaml（不存在或为空时返回空 Mapping）
fn read_settings() -> Result<serde_yaml::Value, AppError> {
    let path = get_settings_path();
    if !path.exists() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    let content = fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    if content.trim().is_empty() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    serde_yaml::from_str(&content)
        .map_err(|e| AppError::Config(format!("解析 DSH settings.yaml 失败: {e}")))
}

fn write_settings(settings: &serde_yaml::Value) -> Result<(), AppError> {
    let path = get_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    let out = serde_yaml::to_string(settings)
        .map_err(|e| AppError::Config(format!("序列化 DSH settings.yaml 失败: {e}")))?;
    atomic_write(&path, out.as_bytes())
}

/// 取出 `llm-pi-ai.providers` 的可变引用（不存在时创建）
fn providers_mapping_mut<'a>(
    settings: &'a mut serde_yaml::Value,
) -> Result<&'a mut serde_yaml::Mapping, AppError> {
    if !settings.is_mapping() {
        *settings = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let root = settings
        .as_mapping_mut()
        .ok_or_else(|| AppError::Config("DSH settings.yaml 根节点不是映射".into()))?;

    let section = root
        .entry(serde_yaml::Value::String(LLM_SECTION.to_string()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !section.is_mapping() {
        *section = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let section_map = section
        .as_mapping_mut()
        .ok_or_else(|| AppError::Config("DSH settings.yaml 的 llm-pi-ai 段不是映射".into()))?;

    let providers = section_map
        .entry(serde_yaml::Value::String(PROVIDERS_KEY.to_string()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !providers.is_mapping() {
        *providers = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    providers
        .as_mapping_mut()
        .ok_or_else(|| AppError::Config("DSH settings.yaml 的 providers 段不是映射".into()))
}

fn yaml_to_json(yaml: &serde_yaml::Value) -> Result<Value, AppError> {
    let s = serde_yaml::to_string(yaml)
        .map_err(|e| AppError::Config(format!("YAML 序列化失败: {e}")))?;
    serde_yaml::from_str::<Value>(&s)
        .map_err(|e| AppError::Config(format!("YAML 转 JSON 失败: {e}")))
}

fn json_to_yaml(json: &Value) -> Result<serde_yaml::Value, AppError> {
    let s = serde_json::to_string(json)
        .map_err(|e| AppError::Config(format!("JSON 序列化失败: {e}")))?;
    serde_yaml::from_str(&s).map_err(|e| AppError::Config(format!("JSON 转 YAML 失败: {e}")))
}

// ============================================================================
// 凭证（.credentials.yaml）
// ============================================================================

fn read_credentials() -> Result<serde_yaml::Mapping, AppError> {
    let path = get_credentials_path();
    if !path.exists() {
        return Ok(serde_yaml::Mapping::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    if content.trim().is_empty() {
        return Ok(serde_yaml::Mapping::new());
    }
    let value: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| AppError::Config(format!("解析 DSH .credentials.yaml 失败: {e}")))?;
    Ok(value.as_mapping().cloned().unwrap_or_default())
}

fn write_credentials(map: &serde_yaml::Mapping) -> Result<(), AppError> {
    let path = get_credentials_path();
    let out = serde_yaml::to_string(map)
        .map_err(|e| AppError::Config(format!("序列化 DSH 凭证失败: {e}")))?;
    // 凭证含密钥，收紧权限后写入
    atomic_write(&path, out.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 由 route 推导凭证环境变量名：`my-openai` → `DSH_MB_MY_OPENAI`
fn credential_env_for(route: &str) -> String {
    let sanitized: String = route
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect();
    format!("{CREDENTIAL_PREFIX}{sanitized}")
}

// ============================================================================
// Provider CRUD
// ============================================================================

/// 读取全部供应商（route → 配置）。
///
/// 返回的 JSON 使用 DB 层统一字段名（`base_url` / `api_key` / `display_name` / `api` / `models`），
/// 与 `provider.rs` 的凭据提取逻辑保持一致；YAML 原生字段（`baseURL` / `displayName` / `apiKeyEnv`）
/// 在读取时桥接转换，写入时再还原。
pub fn get_providers() -> Result<serde_json::Map<String, Value>, AppError> {
    let settings = read_settings()?;
    let credentials = read_credentials()?;
    let empty = serde_yaml::Mapping::new();
    let providers = settings
        .get(LLM_SECTION)
        .and_then(|s| s.get(PROVIDERS_KEY))
        .and_then(|p| p.as_mapping())
        .unwrap_or(&empty);

    let mut out = serde_json::Map::new();
    for (key, value) in providers {
        let Some(route) = key.as_str() else { continue };
        let mut json_val = yaml_to_json(value)?;
        if let Some(obj) = json_val.as_object_mut() {
            // 统一字段名：YAML 用 baseURL/displayName，DB 用 snake_case
            if let Some(v) = obj.remove("baseURL") {
                obj.insert("base_url".to_string(), v);
            }
            if let Some(v) = obj.remove("displayName") {
                obj.insert("display_name".to_string(), v);
            }
            // 从 apiKeyEnv 引用的凭证文件还原明文 api_key
            let key_value = obj
                .get("apiKeyEnv")
                .and_then(|v| v.as_str())
                .and_then(|env| credentials.get(serde_yaml::Value::String(env.to_string())))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(k) = key_value {
                obj.insert("api_key".to_string(), json!(k));
            }
        }
        out.insert(route.to_string(), json_val);
    }
    Ok(out)
}

pub fn get_provider(route: &str) -> Result<Option<Value>, AppError> {
    Ok(get_providers()?.get(route).cloned())
}

/// 供应商 route 列表
pub fn get_live_provider_ids() -> Result<Vec<String>, AppError> {
    Ok(get_providers()?.keys().cloned().collect())
}

/// 新增或更新一个供应商。
///
/// `config`（DB 层 settings_config）中支持：
/// - `base_url`：供应商 base URL（写入 YAML 时转为 `baseURL`）
/// - `api_key`：明文密钥，写入 `.credentials.yaml` 并转为 `apiKeyEnv` 引用
/// - `display_name`：显示名（写入时转为 `displayName`）
/// - `api` / `models`：原生字段，透传
pub fn set_provider(route: &str, config: Value) -> Result<(), AppError> {
    let _guard = write_lock().lock()?;

    let mut incoming = config;
    let (base_url, api_key, display_name, api) = if let Some(obj) = incoming.as_object_mut() {
        let base_url = obj
            .remove("base_url")
            .and_then(|v| v.as_str().map(|s| s.to_string()));
        let api_key = obj
            .remove("api_key")
            .and_then(|v| v.as_str().map(|s| s.to_string()));
        let display_name = obj
            .remove("display_name")
            .and_then(|v| v.as_str().map(|s| s.to_string()));
        let api = obj.remove("api").and_then(|v| v.as_str().map(|s| s.to_string()));
        // 清理 UI 层注入的字段，避免写入 YAML
        obj.remove("_route");
        obj.remove("_apiKey");
        (base_url, api_key, display_name, api)
    } else {
        (None, None, None, None)
    };

    // 密钥写入独立凭证文件，settings.yaml 只保留 apiKeyEnv 引用
    if let Some(key) = api_key {
        let env_name = credential_env_for(route);
        let mut credentials = read_credentials()?;
        credentials.insert(
            serde_yaml::Value::String(env_name.clone()),
            serde_yaml::Value::String(key),
        );
        write_credentials(&credentials)?;
        if let Some(obj) = incoming.as_object_mut() {
            obj.insert("apiKeyEnv".to_string(), json!(env_name));
        }
    } else if let Some(obj) = incoming.as_object_mut() {
        // 未提供密钥时移除 apiKeyEnv，避免指向空凭证
        obj.remove("apiKeyEnv");
    }

    // 还原 YAML 原生字段名
    if let Some(obj) = incoming.as_object_mut() {
        if let Some(b) = base_url {
            obj.insert("baseURL".to_string(), json!(b));
        }
        if let Some(d) = display_name {
            obj.insert("displayName".to_string(), json!(d));
        }
        if let Some(a) = api {
            obj.insert("api".to_string(), json!(a));
        }
    }

    let mut settings = read_settings()?;
    let yaml_val = json_to_yaml(&incoming)?;
    {
        let providers = providers_mapping_mut(&mut settings)?;
        providers.insert(serde_yaml::Value::String(route.to_string()), yaml_val);
    }
    write_settings(&settings)?;
    log::info!("DSH provider '{route}' 已写入 settings.yaml");
    Ok(())
}

/// 删除供应商，同时清理它引用的凭证条目
pub fn remove_provider(route: &str) -> Result<(), AppError> {
    let _guard = write_lock().lock()?;

    let mut settings = read_settings()?;
    let removed_env = settings
        .get(LLM_SECTION)
        .and_then(|s| s.get(PROVIDERS_KEY))
        .and_then(|p| p.get(route))
        .and_then(|v| v.get("apiKeyEnv"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let existed = {
        let providers = providers_mapping_mut(&mut settings)?;
        providers
            .remove(serde_yaml::Value::String(route.to_string()))
            .is_some()
    };
    if !existed {
        return Ok(());
    }
    write_settings(&settings)?;

    if let Some(env_name) = removed_env {
        let mut credentials = read_credentials()?;
        credentials.remove(serde_yaml::Value::String(env_name));
        write_credentials(&credentials)?;
    }
    log::info!("DSH provider '{route}' 已从 settings.yaml 移除");
    Ok(())
}

/// 读取完整配置（供编辑对话框使用）
pub fn read_live_settings() -> Result<Value, AppError> {
    let settings = read_settings()?;
    yaml_to_json(&settings)
}

// ============================================================================
// 当前激活模型（每 profile 一份 cordis.patch.yml）
// ============================================================================

/// 列出所有 profile 名称（按目录名排序）
pub fn list_profiles() -> Vec<String> {
    let dir = get_profiles_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter(|e| e.file_name() != "node_modules")
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

fn patch_path(profile: &str) -> PathBuf {
    get_profiles_dir().join(profile).join("cordis.patch.yml")
}

/// 读取某个 profile 的 patch 数组（文件不存在时返回空数组）
fn read_patch(profile: &str) -> Result<Vec<serde_yaml::Value>, AppError> {
    let path = patch_path(profile);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    let value: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| AppError::Config(format!("解析 {profile} 的 cordis.patch.yml 失败: {e}")))?;
    Ok(value.as_sequence().cloned().unwrap_or_default())
}

fn write_patch(profile: &str, patch: &[serde_yaml::Value]) -> Result<(), AppError> {
    let path = patch_path(profile);
    let value = serde_yaml::Value::Sequence(patch.to_vec());
    let out = serde_yaml::to_string(&value)
        .map_err(|e| AppError::Config(format!("序列化 {profile} 的 cordis.patch.yml 失败: {e}")))?;
    atomic_write(&path, out.as_bytes())
}

/// 从 patch 条目中找出 `agent-default-model` 的配置
fn find_default_model_entry(
    patch: &[serde_yaml::Value],
) -> Option<(usize, usize, serde_yaml::Mapping)> {
    for (i, entry) in patch.iter().enumerate() {
        let Some(items) = entry.get("insert").and_then(|v| v.as_sequence()) else {
            continue;
        };
        for (j, item) in items.iter().enumerate() {
            if item.get("id").and_then(|v| v.as_str()) == Some(DEFAULT_MODEL_ID) {
                let config = item
                    .get("config")
                    .and_then(|v| v.as_mapping())
                    .cloned()
                    .unwrap_or_default();
                return Some((i, j, config));
            }
        }
    }
    None
}

/// 读取当前激活的 (provider, model)。
///
/// 优先取指定 profile；未指定时取任一 profile 中第一个有配置的（保证 UI 有值可显示）。
pub fn get_default_model(profile: Option<&str>) -> Result<Option<(String, String)>, AppError> {
    let profiles: Vec<String> = match profile {
        Some(p) => vec![p.to_string()],
        None => list_profiles(),
    };
    for name in profiles {
        let patch = read_patch(&name)?;
        if let Some((_, _, config)) = find_default_model_entry(&patch) {
            let provider = config
                .get(serde_yaml::Value::String("provider".into()))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let model = config
                .get(serde_yaml::Value::String("model".into()))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !provider.is_empty() {
                return Ok(Some((provider, model)));
            }
        }
    }
    Ok(None)
}

/// 写入当前激活模型。
///
/// `profile` 为 None 时写入**所有** profile，保证任何 profile 启动都用它。
pub fn set_default_model(provider: &str, model: &str, profile: Option<&str>) -> Result<(), AppError> {
    let _guard = write_lock().lock()?;

    let targets: Vec<String> = match profile {
        Some(p) => vec![p.to_string()],
        None => list_profiles(),
    };
    if targets.is_empty() {
        return Err(AppError::Config(
            "未找到任何 DSH profile，无法写入当前模型".into(),
        ));
    }

    for name in targets {
        let mut patch = read_patch(&name)?;
        let mut config = serde_yaml::Mapping::new();
        config.insert(
            serde_yaml::Value::String("provider".into()),
            serde_yaml::Value::String(provider.to_string()),
        );
        if !model.is_empty() {
            config.insert(
                serde_yaml::Value::String("model".into()),
                serde_yaml::Value::String(model.to_string()),
            );
        }

        let mut entry = serde_yaml::Mapping::new();
        entry.insert(
            serde_yaml::Value::String("id".into()),
            serde_yaml::Value::String(DEFAULT_MODEL_ID.to_string()),
        );
        entry.insert(
            serde_yaml::Value::String("name".into()),
            serde_yaml::Value::String(DEFAULT_MODEL_PLUGIN.to_string()),
        );
        entry.insert(
            serde_yaml::Value::String("config".into()),
            serde_yaml::Value::Mapping(config),
        );

        match find_default_model_entry(&patch) {
            Some((i, j, _)) => {
                if let Some(items) = patch[i]
                    .get_mut("insert")
                    .and_then(|v| v.as_sequence_mut())
                {
                    items[j] = serde_yaml::Value::Mapping(entry);
                }
            }
            None => {
                // 没有 insert 段则新建一个（- insert: [...]）
                let mut wrapper = serde_yaml::Mapping::new();
                wrapper.insert(
                    serde_yaml::Value::String("insert".into()),
                    serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(entry)]),
                );
                patch.push(serde_yaml::Value::Mapping(wrapper));
            }
        }

        write_patch(&name, &patch)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_env_is_sanitized() {
        assert_eq!(credential_env_for("my-openai"), "DSH_MB_MY_OPENAI");
        assert_eq!(credential_env_for("ollama.local"), "DSH_MB_OLLAMA_LOCAL");
    }

    #[test]
    fn dsh_home_defaults_under_home() {
        assert!(get_settings_path().starts_with(get_dsh_home()));
        assert!(get_dsh_home().ends_with(".dsh"));
    }

    #[test]
    fn missing_settings_reads_as_empty_mapping() {
        // 仅在 DSH_HOME 指向不存在目录时成立；此处只校验读取不会 panic
        let _ = read_settings();
    }

    #[test]
    fn patch_entry_lookup_shape() {
        // 校验 find_default_model_entry 能定位到预期条目
        let yaml = r#"
- insert:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
"#;
        let patch: Vec<serde_yaml::Value> = serde_yaml::from_str(yaml).unwrap();
        let (_, _, config) = find_default_model_entry(&patch).expect("entry found");
        assert_eq!(
            config
                .get(serde_yaml::Value::String("provider".into()))
                .and_then(|v| v.as_str()),
            Some("deepseek-official")
        );
    }
}
