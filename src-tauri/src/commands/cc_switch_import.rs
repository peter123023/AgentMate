#![allow(non_snake_case)]

//! 从旧版 CC Switch（上游原版应用）的数据目录 `~/.cc-switch` 一键导入配置。
//!
//! 流程分两步，中间由前端弹出确认对话框：
//!
//! 1. [`preview_import`]：只读检测源目录、统计各表可导入行数与目标库的
//!    冲突数量，返回给前端展示。
//! 2. [`execute_import`]：先对当前数据库做快照备份，再在单个事务内完成
//!    导入；任一表失败则整体回滚。
//!
//! 异常场景处理约定：
//! - 源目录 / 源数据库不存在：preview 返回 `found: false`，前端禁用导入。
//! - 源数据库损坏或无法打开：preview / execute 返回明确的错误信息。
//! - 源库缺表 / 缺列（上游旧版本）：按列交集导入，缺表时跳过该表并在
//!   结果中标注 `missingTable`，不阻断其它表。
//! - 源库正被旧版 CC Switch 占用：以只读模式打开源库，绝不写源。
//! - `providers.is_current` 一律置为 `false` 导入，避免导入行为悄悄切换
//!   当前激活的供应商、重写用户的 live 配置。

use rusqlite::types::Value as SqlValue;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::config::get_home_dir;
use crate::database::Database;
use crate::error::AppError;
use crate::services::skill::skill_state_write_guard;
use crate::services::sync_protocol::sync_mutex;
use crate::store::AppState;

const SOURCE_DIR_NAME: &str = ".cc-switch";
const SOURCE_DB_NAME: &str = "cc-switch.db";
const UNIVERSAL_PROVIDERS_KEY: &str = "universal_providers";

/// 一次导入任务的可选范围与冲突策略。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    pub import_providers: bool,
    pub import_mcp_servers: bool,
    pub import_prompts: bool,
    pub import_skills: bool,
    pub import_skill_repos: bool,
    pub import_universal_providers: bool,
    /// true = 同主键的现有数据被源数据覆盖；false = 跳过已存在的行。
    pub overwrite_existing: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            import_providers: true,
            import_mcp_servers: true,
            import_prompts: true,
            import_skills: true,
            import_skill_repos: true,
            import_universal_providers: true,
            overwrite_existing: false,
        }
    }
}

struct TableSpec {
    /// 前端 scope key（camelCase）
    key: &'static str,
    table: &'static str,
    key_columns: &'static [&'static str],
}

const IMPORT_TABLES: &[TableSpec] = &[
    TableSpec {
        key: "providers",
        table: "providers",
        key_columns: &["id", "app_type"],
    },
    TableSpec {
        key: "mcpServers",
        table: "mcp_servers",
        key_columns: &["id"],
    },
    TableSpec {
        key: "prompts",
        table: "prompts",
        key_columns: &["id", "app_type"],
    },
    TableSpec {
        key: "skills",
        table: "skills",
        key_columns: &["id"],
    },
    TableSpec {
        key: "skillRepos",
        table: "skill_repos",
        key_columns: &["owner", "name"],
    },
];

/// `providers.is_current` 是运行态（当前激活的供应商），导入时强制置 0，
/// 防止导入行为悄悄改写 live 配置。
const FORCE_FALSE_COLUMNS: &[&str] = &["is_current"];

pub(crate) fn default_source_dir() -> PathBuf {
    get_home_dir().join(SOURCE_DIR_NAME)
}

fn source_db_path(source_dir: &Path) -> PathBuf {
    source_dir.join(SOURCE_DB_NAME)
}

/// 以只读模式打开源数据库。旧版 CC Switch 正在运行时只读连接仍可安全读取。
fn open_source_readonly(path: &Path) -> Result<rusqlite::Connection, AppError> {
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| {
            AppError::Database(format!(
                "无法打开 CC Switch 数据库 {}: {e}",
                path.display()
            ))
        })
}

/// 读取表的列名（保持定义顺序）。表不存在时返回空列表。
fn table_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(|e| AppError::Database(format!("PRAGMA table_info({table}) failed: {e}")))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| AppError::Database(e.to_string()))?;
    let mut cols = Vec::new();
    for row in rows {
        cols.push(row.map_err(|e| AppError::Database(e.to_string()))?);
    }
    Ok(cols)
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| AppError::Database(e.to_string()))
}

fn row_count(conn: &rusqlite::Connection, table: &str) -> Result<i64, AppError> {
    conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
        row.get(0)
    })
    .map_err(|e| AppError::Database(format!("COUNT({table}) failed: {e}")))
}

fn primary_key_values(
    conn: &rusqlite::Connection,
    table: &str,
    key_columns: &[&str],
) -> Result<HashSet<Vec<String>>, AppError> {
    let cols = table_columns(conn, table)?;
    if key_columns.iter().any(|k| !cols.iter().any(|c| c == k)) {
        return Ok(HashSet::new());
    }
    let select = key_columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!("SELECT {select} FROM \"{table}\""))
        .map_err(|e| AppError::Database(format!("SELECT from {table} failed: {e}")))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| AppError::Database(e.to_string()))?;
    let mut set = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::Database(e.to_string()))?
    {
        let mut key = Vec::with_capacity(key_columns.len());
        for i in 0..key_columns.len() {
            let v: String = row.get(i).map_err(|e| AppError::Database(e.to_string()))?;
            key.push(v);
        }
        set.insert(key);
    }
    Ok(set)
}

/// 读取 settings 表中 universal_providers 的 JSON map（缺失或损坏时返回空 map）。
fn read_universal_providers(
    conn: &rusqlite::Connection,
) -> Result<serde_json::Map<String, Value>, AppError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [UNIVERSAL_PROVIDERS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))?;
    let Some(raw) = value else {
        return Ok(serde_json::Map::new());
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Ok(serde_json::Map::new()),
    }
}

use rusqlite::OptionalExtension;

/// 预览：统计可导入内容与冲突情况，不做任何写操作。
pub(crate) fn preview_import(source_dir: &Path, target_db: &Database) -> Result<Value, AppError> {
    let db_path = source_db_path(source_dir);
    if !source_dir.exists() || !db_path.exists() {
        return Ok(json!({
            "found": false,
            "sourceDir": source_dir.display().to_string(),
        }));
    }
    let source = open_source_readonly(&db_path)?;
    let target = target_db
        .conn
        .lock()
        .map_err(|e| AppError::Database(format!("Mutex lock failed: {e}")))?;

    let mut tables = serde_json::Map::new();
    for spec in IMPORT_TABLES {
        let source_exists = table_exists(&source, spec.table)?;
        if !source_exists {
            tables.insert(
                spec.key.to_string(),
                json!({ "missingTable": true, "sourceCount": 0, "targetCount": 0, "conflicts": 0 }),
            );
            continue;
        }
        let target_exists = table_exists(&target, spec.table)?;
        let source_count = row_count(&source, spec.table)?;
        let target_count = if target_exists {
            row_count(&target, spec.table)?
        } else {
            0
        };
        let conflicts = if target_exists {
            let source_keys = primary_key_values(&source, spec.table, spec.key_columns)?;
            let target_keys = primary_key_values(&target, spec.table, spec.key_columns)?;
            source_keys.intersection(&target_keys).count()
        } else {
            0
        };
        tables.insert(
            spec.key.to_string(),
            json!({
                "sourceCount": source_count,
                "targetCount": target_count,
                "conflicts": conflicts,
            }),
        );
    }

    let up_source = read_universal_providers(&source)?;
    let up_target = read_universal_providers(&target)?;
    let conflicts = up_source
        .keys()
        .filter(|k| up_target.contains_key(*k))
        .count();

    Ok(json!({
        "found": true,
        "sourceDir": source_dir.display().to_string(),
        "tables": tables,
        "universalProviders": {
            "sourceCount": up_source.len(),
            "targetCount": up_target.len(),
            "conflicts": conflicts,
        },
    }))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 把源表按「源∩目标列交集」导入目标表。
///
/// 统计语义：
/// - `imported`：目标原本不存在、新插入的行
/// - `skipped`：跳过策略下因主键冲突被跳过的行
/// - `overwritten`：覆盖策略下替换掉的已存在行
fn import_table(
    tx: &rusqlite::Transaction<'_>,
    source: &rusqlite::Connection,
    spec: &TableSpec,
    overwrite: bool,
) -> Result<Value, AppError> {
    if !table_exists(tx, spec.table)? || !table_exists(source, spec.table)? {
        return Ok(json!({ "missingTable": true, "imported": 0, "skipped": 0, "overwritten": 0 }));
    }
    let source_cols = table_columns(source, spec.table)?;
    let target_cols = table_columns(tx, spec.table)?;
    let common: Vec<String> = target_cols
        .iter()
        .filter(|c| source_cols.contains(c))
        .cloned()
        .collect();
    for key in spec.key_columns {
        if !common.iter().any(|c| c == key) {
            return Ok(json!({
                "error": format!("源表缺少主键列 {key}"),
                "imported": 0, "skipped": 0, "overwritten": 0,
            }));
        }
    }
    if common.is_empty() {
        return Ok(json!({ "error": "源表与目标表没有公共列", "imported": 0, "skipped": 0, "overwritten": 0 }));
    }

    let select_list = common
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let col_list = select_list.clone();
    let placeholders = vec!["?"; common.len()].join(", ");
    let insert_sql = format!(
        "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
        quote_ident(spec.table),
        col_list,
        placeholders
    );
    let key_check_sql = format!(
        "SELECT COUNT(*) FROM {} WHERE {}",
        quote_ident(spec.table),
        spec.key_columns
            .iter()
            .map(|k| format!("{} = ?", quote_ident(k)))
            .collect::<Vec<_>>()
            .join(" AND ")
    );

    let mut read_stmt = source
        .prepare(&format!("SELECT {select_list} FROM \"{}\"", spec.table))
        .map_err(|e| AppError::Database(format!("读取源表 {} 失败: {e}", spec.table)))?;
    let mut rows = read_stmt
        .query([])
        .map_err(|e| AppError::Database(e.to_string()))?;

    let mut inserted = 0i64;
    let mut skipped = 0i64;
    let mut overwritten = 0i64;

    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::Database(e.to_string()))?
    {
        let mut params: Vec<SqlValue> = Vec::with_capacity(common.len());
        let mut key_params: Vec<SqlValue> = Vec::with_capacity(spec.key_columns.len());
        for (i, col) in common.iter().enumerate() {
            let raw: SqlValue = row
                .get(i)
                .map_err(|e| AppError::Database(format!("读取 {}.{} 失败: {e}", spec.table, col)))?;
            if FORCE_FALSE_COLUMNS.contains(&col.as_str()) {
                params.push(SqlValue::Integer(0));
            } else {
                params.push(raw.clone());
            }
            if spec.key_columns.contains(&col.as_str()) {
                key_params.push(raw);
            }
        }

        let exists: bool = tx
            .query_row(&key_check_sql, rusqlite::params_from_iter(key_params.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map(|n| n > 0)
            .map_err(|e| AppError::Database(e.to_string()))?;

        if exists && !overwrite {
            skipped += 1;
            continue;
        }

        tx.execute(&insert_sql, rusqlite::params_from_iter(params.iter()))
            .map_err(|e| {
                AppError::Database(format!("写入目标表 {} 失败: {e}", spec.table))
            })?;
        if exists {
            overwritten += 1;
        } else {
            inserted += 1;
        }
    }

    Ok(json!({ "imported": inserted, "skipped": skipped, "overwritten": overwritten }))
}

/// 执行导入：先备份，再在单事务内逐表导入。
///
/// 返回每个表的导入/跳过/覆盖统计。任一表失败则整体回滚并返回错误，
/// 已生成的备份保留，可用于手动恢复。
pub(crate) fn execute_import(
    db: &Database,
    source_dir: &Path,
    options: &ImportOptions,
) -> Result<Value, AppError> {
    let db_path = source_db_path(source_dir);
    if !db_path.exists() {
        return Err(AppError::Config(format!(
            "未找到 CC Switch 数据库: {}",
            db_path.display()
        )));
    }

    // 1. 快照备份（在任何写操作之前）。
    let backup_path = db.backup_database_file()?;

    let source = open_source_readonly(&db_path)?;
    let mut conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Database(format!("Mutex lock failed: {e}")))?;

    let mut results = serde_json::Map::new();

    let tx = conn
        .transaction()
        .map_err(|e| AppError::Database(format!("开启事务失败: {e}")))?;

    for spec in IMPORT_TABLES {
        let enabled = match spec.key {
            "providers" => options.import_providers,
            "mcpServers" => options.import_mcp_servers,
            "prompts" => options.import_prompts,
            "skills" => options.import_skills,
            "skillRepos" => options.import_skill_repos,
            _ => false,
        };
        if !enabled {
            continue;
        }

        let entry = import_table(&tx, &source, spec, options.overwrite_existing)?;
        results.insert(spec.key.to_string(), entry);
    }

    // universal_providers 存放在 settings 表的 JSON map 中，需要按 id 逐条合并。
    if options.import_universal_providers && table_exists(&source, "settings")? {
        let up_source = read_universal_providers(&source)?;
        if !up_source.is_empty() {
            let mut up_target = read_universal_providers(&tx)?;
            let mut inserted = 0i64;
            let mut overwritten = 0i64;
            let mut skipped = 0i64;
            for (id, value) in up_source {
                if up_target.contains_key(&id) && !options.overwrite_existing {
                    skipped += 1;
                    continue;
                }
                if up_target.contains_key(&id) {
                    overwritten += 1;
                } else {
                    inserted += 1;
                }
                up_target.insert(id, value);
            }
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![
                    UNIVERSAL_PROVIDERS_KEY,
                    serde_json::to_string(&Value::Object(up_target)).map_err(|e| {
                        AppError::Config(format!("序列化 universal_providers 失败: {e}"))
                    })?
                ],
            )
            .map_err(|e| AppError::Database(format!("写入 universal_providers 失败: {e}")))?;
            results.insert(
                "universalProviders".to_string(),
                json!({ "imported": inserted, "skipped": skipped, "overwritten": overwritten }),
            );
        }
    }

    tx.commit()
        .map_err(|e| AppError::Database(format!("提交导入事务失败: {e}")))?;

    log::info!(
        "[CCSwitchImport] 导入完成：{}",
        serde_json::to_string(&Value::Object(results.clone())).unwrap_or_default()
    );

    Ok(json!({
        "success": true,
        "backupId": backup_path
            .as_ref()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())),
        "results": Value::Object(results),
    }))
}

// ─── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn cc_switch_import_preview(state: State<'_, AppState>) -> Result<Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source_dir = default_source_dir();
        preview_import(&source_dir, &db)
    })
    .await
    .map_err(|e| format!("检测 CC Switch 数据失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

#[tauri::command]
pub async fn cc_switch_import_execute(
    state: State<'_, AppState>,
    options: Option<ImportOptions>,
) -> Result<Value, String> {
    let options = options.unwrap_or_default();
    let app_state = state.inner().clone();
    let db = app_state.db.clone();

    // 与备份还原/云同步互斥，避免并发改库。
    let _sync_guard = sync_mutex().lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        // skills 表会被写入，阻塞本地 skill 状态变更。
        let _skill_guard = skill_state_write_guard();
        let source_dir = default_source_dir();
        execute_import(&db, &source_dir, &options)
    })
    .await
    .map_err(|e| format!("导入 CC Switch 配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 建一个精简但列名与目标库一致的源数据库。
    /// 故意比目标库少几列（如 is_current、icon_color），验证列交集逻辑。
    fn create_source_db(path: &Path) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                website_url TEXT,
                category TEXT,
                is_current BOOLEAN NOT NULL DEFAULT 0,
                PRIMARY KEY (id, app_type)
            );
            CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1
            );
            CREATE TABLE prompts (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                content TEXT NOT NULL, PRIMARY KEY (id, app_type)
            );
            CREATE TABLE skill_repos (
                owner TEXT NOT NULL, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1,
                PRIMARY KEY (owner, name)
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            "#,
        )
        .unwrap();

        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES
             ('prov-a', 'claude', 'A（新增）', '{}', 1),
             ('prov-b', 'claude', 'B（冲突）', '{}', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mcp_servers (id, name, server_config) VALUES ('mcp-x', 'X', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('universal_providers', ?1)",
            [serde_json::json!({
                "up-1": { "id": "up-1", "name": "统一1" },
                "up-conflict": { "id": "up-conflict", "name": "统一冲突" }
            })
            .to_string()],
        )
        .unwrap();
    }

    fn target_with_conflict() -> Database {
        let db = Database::memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES
             ('prov-b', 'claude', 'B（目标已有）', '{}', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('universal_providers', ?1)",
            [serde_json::json!({
                "up-conflict": { "id": "up-conflict", "name": "目标统一" }
            })
            .to_string()],
        )
        .unwrap();
        drop(conn);
        db
    }

    #[test]
    fn preview_reports_counts_and_conflicts() {
        let tmp = TempDir::new().unwrap();
        create_source_db(&tmp.path().join("cc-switch.db"));
        let db = target_with_conflict();

        let preview = preview_import(tmp.path(), &db).unwrap();
        assert_eq!(preview["found"], json!(true));
        let tables = &preview["tables"];
        assert_eq!(tables["providers"]["sourceCount"], json!(2));
        assert_eq!(tables["providers"]["targetCount"], json!(1));
        assert_eq!(tables["providers"]["conflicts"], json!(1));
        assert_eq!(tables["mcpServers"]["conflicts"], json!(0));
        assert_eq!(preview["universalProviders"]["conflicts"], json!(1));
    }

    #[test]
    fn preview_reports_missing_source() {
        let tmp = TempDir::new().unwrap();
        let db = Database::memory().unwrap();
        let preview = preview_import(tmp.path(), &db).unwrap();
        assert_eq!(preview["found"], json!(false));
    }

    #[test]
    fn execute_skip_keeps_existing_and_forces_is_current_false() {
        let tmp = TempDir::new().unwrap();
        create_source_db(&tmp.path().join("cc-switch.db"));
        let db = target_with_conflict();

        let result = execute_import(&db, tmp.path(), &ImportOptions::default()).unwrap();
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["results"]["providers"]["imported"], json!(1));
        assert_eq!(result["results"]["providers"]["skipped"], json!(1));
        assert_eq!(result["results"]["providers"]["overwritten"], json!(0));

        let conn = db.conn.lock().unwrap();
        // 新增行导入且 is_current 被强制为 0（即使源里是 1）
        let (name, is_current): (String, bool) = conn
            .query_row(
                "SELECT name, is_current FROM providers WHERE id='prov-a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "A（新增）");
        assert!(!is_current);
        // 冲突行保留目标值
        let name: String = conn
            .query_row(
                "SELECT name FROM providers WHERE id='prov-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "B（目标已有）");
        // 目标 current 未被影响
        let current: bool = conn
            .query_row(
                "SELECT is_current FROM providers WHERE id='prov-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(current);
        // universal_providers：新增 1 条、冲突跳过 1 条
        assert_eq!(result["results"]["universalProviders"]["imported"], json!(1));
        assert_eq!(result["results"]["universalProviders"]["skipped"], json!(1));
        let up: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='universal_providers'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let map: Value = serde_json::from_str(&up).unwrap();
        assert_eq!(map["up-1"]["name"], json!("统一1"));
        assert_eq!(map["up-conflict"]["name"], json!("目标统一"));
    }

    #[test]
    fn execute_overwrite_replaces_conflicts() {
        let tmp = TempDir::new().unwrap();
        create_source_db(&tmp.path().join("cc-switch.db"));
        let db = target_with_conflict();

        let options = ImportOptions {
            overwrite_existing: true,
            ..Default::default()
        };
        let result = execute_import(&db, tmp.path(), &options).unwrap();
        assert_eq!(result["results"]["providers"]["overwritten"], json!(1));
        assert_eq!(result["results"]["providers"]["skipped"], json!(0));

        let conn = db.conn.lock().unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM providers WHERE id='prov-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "B（冲突）");
    }

    #[test]
    fn execute_errors_when_source_missing() {
        let tmp = TempDir::new().unwrap();
        let db = Database::memory().unwrap();
        let result = execute_import(&db, tmp.path(), &ImportOptions::default());
        assert!(result.is_err());
    }

    /// 用本机真实的 ~/.cc-switch 数据库做只读演练（无源时自动跳过），
    /// 验证列交集 / 主键统计对真实 schema 的兼容性。
    #[test]
    fn preview_against_real_cc_switch_data() {
        let source_dir = default_source_dir();
        if !source_dir.join("cc-switch.db").exists() {
            return;
        }
        let db = Database::memory().unwrap();
        let preview = preview_import(&source_dir, &db).unwrap();
        assert_eq!(preview["found"], json!(true));
        assert_eq!(
            preview["tables"]["providers"]["sourceCount"],
            json!(9),
            "真实库 providers 应为 9 行（与 sqlite3 手查一致）"
        );
        assert_eq!(
            preview["tables"]["mcpServers"]["sourceCount"],
            json!(3),
            "真实库 mcp_servers 应为 3 行"
        );
        // universal_providers 有 1 条（火山codeplan统一），目标空库 → 0 冲突
        assert_eq!(preview["universalProviders"]["sourceCount"], json!(1));
        assert_eq!(preview["universalProviders"]["conflicts"], json!(0));
    }

    #[test]
    fn missing_source_table_is_reported_not_fatal() {
        let tmp = TempDir::new().unwrap();
        let conn = rusqlite::Connection::open(tmp.path().join("cc-switch.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, PRIMARY KEY (id, app_type));
             INSERT INTO providers VALUES ('p1','claude','X','{}');",
        )
        .unwrap();
        drop(conn);
        let db = Database::memory().unwrap();

        let result = execute_import(&db, tmp.path(), &ImportOptions::default()).unwrap();
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["results"]["mcpServers"]["missingTable"], json!(true));
        assert_eq!(result["results"]["providers"]["imported"], json!(1));
    }
}
