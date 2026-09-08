use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};
use crate::workbuddy_config::get_workbuddy_dir;

use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, read_head_tail_lines, truncate_summary,
    TITLE_MAX_CHARS,
};

const PROVIDER_ID: &str = "workbuddy";

/// WorkBuddy stores conversations as JSONL under `~/.workbuddy/projects/<project>/<uuid>.jsonl`.
///
/// Record shapes observed on disk:
/// - `message`: `{ type, role: "user" | "assistant", content: [{ type: "input_text", text }], sessionId, cwd }`
/// - `reasoning`: raw chain-of-thought (`rawContent`), skipped from the visible transcript
/// - `function_call` / `function_call_result`: tool invocation and its output
/// - `file-history-snapshot`: undo bookkeeping, ignored
/// - `ai-title`: `{ type: "ai-title", aiTitle, sessionId }` — WorkBuddy's own generated title
pub fn scan_sessions() -> Vec<SessionMeta> {
    let root = get_workbuddy_dir().join("projects");
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);

    let mut sessions = Vec::new();
    for path in files {
        if let Some(meta) = parse_session(&path) {
            sessions.push(meta);
        }
    }

    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        let (role, content) = match record_type {
            "message" => {
                let role = value
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let content = match value.get("content") {
                    Some(content) => strip_noise(&extract_text(content)),
                    None => String::new(),
                };
                (role, content)
            }
            "function_call" => {
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                ("assistant".to_string(), format!("[Tool: {name}]"))
            }
            "function_call_result" => {
                let content = value
                    .get("output")
                    .map(extract_text)
                    .unwrap_or_default();
                ("tool".to_string(), content)
            }
            // reasoning / file-history-snapshot / ai-title are not part of the transcript
            _ => continue,
        };

        if content.trim().is_empty() {
            continue;
        }

        messages.push(SessionMessage {
            role,
            content,
            ts: value.get("timestamp").and_then(parse_workbuddy_timestamp),
        });
    }

    Ok(messages)
}

pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let meta = parse_session(path).ok_or_else(|| {
        format!(
            "Failed to parse WorkBuddy session metadata: {}",
            path.display()
        )
    })?;

    if meta.session_id != session_id {
        return Err(format!(
            "WorkBuddy session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }

    if let Some(stem) = path.file_stem() {
        let sibling = path.parent().unwrap_or_else(|| Path::new("")).join(stem);
        remove_path_if_exists(&sibling).map_err(|e| {
            format!(
                "Failed to delete WorkBuddy session sidecar {}: {e}",
                sibling.display()
            )
        })?;
    }

    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete WorkBuddy session file {}: {e}",
            path.display()
        )
    })?;

    Ok(true)
}

pub fn session_roots() -> Vec<PathBuf> {
    vec![get_workbuddy_dir().join("projects")]
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    let (head, tail) = read_head_tail_lines(path, 10, 30).ok()?;

    let mut session_id: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut first_user_message: Option<String> = None;

    for line in &head {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
        if project_dir.is_none() {
            project_dir = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
        if created_at.is_none() {
            created_at = value
                .get("timestamp")
                .and_then(parse_workbuddy_timestamp);
        }
        if first_user_message.is_none() {
            let is_user_message = value.get("type").and_then(Value::as_str) == Some("message")
                && value.get("role").and_then(Value::as_str) == Some("user");
            if is_user_message {
                if let Some(content) = value.get("content") {
                    // WorkBuddy wraps machine context in <system-reminder> blocks; only the
                    // remaining text is the real user request.
                    let text = strip_noise(&extract_text(content));
                    if !text.is_empty() {
                        first_user_message = Some(text);
                    }
                }
            }
        }
        if session_id.is_some()
            && project_dir.is_some()
            && created_at.is_some()
            && first_user_message.is_some()
        {
            break;
        }
    }

    let mut last_active_at: Option<i64> = None;
    let mut summary: Option<String> = None;
    let mut ai_title: Option<String> = None;

    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if last_active_at.is_none() {
            last_active_at = value
                .get("timestamp")
                .and_then(parse_workbuddy_timestamp);
        }
        if ai_title.is_none() && value.get("type").and_then(Value::as_str) == Some("ai-title") {
            ai_title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        if summary.is_none() {
            let is_assistant = value.get("type").and_then(Value::as_str) == Some("message")
                && value.get("role").and_then(Value::as_str) == Some("assistant");
            if is_assistant {
                if let Some(content) = value.get("content") {
                    let text = extract_text(content);
                    if !text.trim().is_empty() {
                        summary = Some(text);
                    }
                }
            }
        }
        if last_active_at.is_some() && summary.is_some() && ai_title.is_some() {
            break;
        }
    }

    let session_id = session_id.or_else(|| infer_session_id_from_filename(path));
    let session_id = session_id?;

    // Title priority: WorkBuddy's AI title > first real user message > project directory name
    let title = ai_title
        .map(|t| truncate_summary(&t, TITLE_MAX_CHARS))
        .or_else(|| first_user_message.map(|t| truncate_summary(&t, TITLE_MAX_CHARS)))
        .or_else(|| project_dir.as_deref().and_then(path_basename).map(String::from));

    let summary = summary.map(|text| truncate_summary(&text, 160));

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary,
        project_dir,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: Some(format!("workbuddy --resume {session_id}")),
    })
}

/// WorkBuddy writes millisecond timestamps as JSON *strings*, which the shared
/// helper cannot parse (it expects numbers or RFC 3339).
fn parse_workbuddy_timestamp(value: &Value) -> Option<i64> {
    if let Some(parsed) = parse_timestamp_to_ms(value) {
        return Some(parsed);
    }

    let raw = value.as_str()?;
    let millis: i64 = raw.trim().parse().ok()?;
    Some(if millis > 1_000_000_000_000 {
        millis
    } else {
        millis * 1000
    })
}

/// Remove `<system-reminder>...</system-reminder>` blocks injected by WorkBuddy.
fn strip_noise(text: &str) -> String {
    const OPEN: &str = "<system-reminder";
    const CLOSE: &str = "</system-reminder>";

    let mut result = text.to_string();
    while let Some(start) = result.find(OPEN) {
        let close = match result[start..].find(CLOSE) {
            Some(offset) => start + offset + CLOSE.len(),
            // Unterminated block: drop the remainder to avoid leaking raw context.
            None => {
                result.truncate(start);
                break;
            }
        };
        result.replace_range(start..close, "");
    }

    result.trim().to_string()
}

fn infer_session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_string())
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }

    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Sub-agent transcripts live in their own folder; keep the list to top-level sessions.
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name == "subagents")
                .unwrap_or(false)
            {
                continue;
            }
            collect_jsonl_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_line(session_id: &str, cwd: &str, ts: &str, text: &str) -> String {
        format!(
            "{{\"id\":\"m1\",\"timestamp\":\"{ts}\",\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"{text}\"}}],\"sessionId\":\"{session_id}\",\"cwd\":\"{cwd}\"}}"
        )
    }

    #[test]
    fn parse_session_prefers_ai_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session-abc.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                sample_line(
                    "session-abc",
                    "/tmp/project",
                    "1788499813561",
                    "<system-reminder>noise</system-reminder>How do I deploy?"
                ),
                "{\"timestamp\":\"1788499814561\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Like this...\"}],\"sessionId\":\"session-abc\",\"cwd\":\"/tmp/project\"}",
                "{\"timestamp\":\"1788499815561\",\"type\":\"ai-title\",\"aiTitle\":\"部署方案讨论\",\"sessionId\":\"session-abc\",\"cwd\":\"/tmp/project\"}",
            ),
        )
        .expect("write session");

        let meta = parse_session(&path).expect("parse");
        assert_eq!(meta.title.as_deref(), Some("部署方案讨论"));
        assert_eq!(meta.session_id, "session-abc");
        assert_eq!(meta.project_dir.as_deref(), Some("/tmp/project"));
        assert_eq!(meta.created_at, Some(1_788_499_813_561));
        assert_eq!(meta.last_active_at, Some(1_788_499_815_561));
    }

    #[test]
    fn parse_session_strips_system_reminder_from_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session-def.jsonl");
        std::fs::write(
            &path,
            format!("{}\n", sample_line("session-def", "/tmp/p", "1788499813561", "<system-reminder data-role=\\\"user-context\\\">OS Version: darwin</system-reminder>重构这个函数")),
        )
        .expect("write session");

        let meta = parse_session(&path).expect("parse");
        assert_eq!(meta.title.as_deref(), Some("重构这个函数"));
    }

    #[test]
    fn load_messages_maps_tool_calls_and_results() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"1788499813561\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"读一下文件\"}],\"sessionId\":\"s1\"}\n",
                "{\"timestamp\":\"1788499813661\",\"type\":\"function_call\",\"name\":\"Read\",\"arguments\":\"{}\",\"sessionId\":\"s1\"}\n",
                "{\"timestamp\":\"1788499813761\",\"type\":\"function_call_result\",\"name\":\"Read\",\"output\":{\"type\":\"text\",\"text\":\"file body\"},\"sessionId\":\"s1\"}\n",
                "{\"timestamp\":\"1788499813861\",\"type\":\"reasoning\",\"rawContent\":[{\"type\":\"reasoning_text\",\"text\":\"thinking\"}],\"sessionId\":\"s1\"}\n",
            ),
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "读一下文件");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "[Tool: Read]");
        assert_eq!(msgs[2].role, "tool");
        assert_eq!(msgs[2].content, "file body");
    }

    #[test]
    fn delete_session_removes_file_and_sidecar() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session-xyz.jsonl");
        let sidecar = temp.path().join("session-xyz");
        std::fs::create_dir_all(&sidecar).expect("create sidecar");
        std::fs::write(
            &path,
            format!("{}\n", sample_line("session-xyz", "/tmp/p", "1788499813561", "hi")),
        )
        .expect("write session");

        delete_session(temp.path(), &path, "session-xyz").expect("delete");

        assert!(!path.exists());
        assert!(!sidecar.exists());
    }

    /// 真实数据冒烟：扫描本机 `~/.workbuddy/projects`，验证解析器在真实会话上可用。
    /// 目录不存在（未安装 WorkBuddy）时自动跳过，不污染 CI。
    ///
    /// 这里只校验结构性不变量——会话数量会随使用增长，不能写死。
    #[test]
    fn scan_real_sessions_smoke() {
        let root = get_workbuddy_dir().join("projects");
        if !root.exists() {
            eprintln!("skip: {} not found", root.display());
            return;
        }

        let sessions = scan_sessions();
        assert!(!sessions.is_empty(), "应至少解析出 1 个会话");

        for session in &sessions {
            assert_eq!(session.provider_id, PROVIDER_ID);
            assert!(!session.session_id.is_empty(), "session_id 不能为空");
            assert!(
                session.created_at.is_some() || session.last_active_at.is_some(),
                "会话应能解析出时间戳: {session:?}"
            );
        }

        // 抽样第一个会话，确认消息能被完整解析
        let first = &sessions[0];
        let source = first
            .source_path
            .as_ref()
            .expect("真实会话应带 source_path");
        let messages = load_messages(Path::new(source))
            .unwrap_or_else(|e| panic!("load_messages({source}) 失败: {e}"));
        assert!(!messages.is_empty(), "会话 {source} 应至少含 1 条消息");

        eprintln!(
            "workbuddy 真实会话: {} 个，抽样 {:?} 含 {} 条消息",
            sessions.len(),
            first.title.as_deref().unwrap_or("(无标题)"),
            messages.len()
        );
    }
}
