use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{extract_text, path_basename, truncate_summary, TITLE_MAX_CHARS};

const PROVIDER_ID: &str = "deepseek-harness";

/// DeepSeek Harness (DSH) stores sessions as an append-only event stream:
/// `~/.dsh/sessions/<encoded-cwd>/session-<uuid>/session.jsonl.zstd`
///
/// The JSONL payload is **zstd-compressed** (streaming, no content-size in the
/// frame header), so it must be decoded with a streaming reader.
///
/// Event shapes observed on disk:
/// - `session` (first line): `{ type, version, id, createdAt, cwd, agentPreset }`
/// - `user/message`:          `{ type, seq, time, data: { role, content: [{ type: "text", text }] } }`
/// - `assistant/chunk`:       `{ type, seq, time, data: { turn, step, chunk: { type, text | delta } } }`
///   — streamed increments; consecutive chunks are merged into one message
/// - `tool/call` / `tool/result`: tool invocation and its output
/// - `session/title`:         `{ type, time, data: { title, source: { kind: "llm" | "fallback" } } }`
/// - `permission/preset`, `sandbox/mode`, `approval/policy`, `turn/start`, `step/*`,
///   `request/*`: runtime bookkeeping, not part of the visible transcript
fn dsh_home() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DSH_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".dsh"))
}

fn sessions_root() -> Option<PathBuf> {
    dsh_home().map(|home| home.join("sessions"))
}

/// Decode a zstd-compressed JSONL file into parsed events.
///
/// `max_lines` caps how many lines are decoded — scanning only needs the head
/// of the file, so large transcripts are not fully inflated.
fn read_events(path: &Path, max_lines: usize) -> Result<Vec<Value>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open DSH session file: {e}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("Failed to init zstd decoder: {e}"))?;
    let reader = BufReader::new(decoder);

    let mut events = Vec::new();
    for line in reader.lines().take(max_lines) {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            events.push(value);
        }
    }
    Ok(events)
}

fn event_time(value: &Value) -> Option<i64> {
    value
        .get("time")
        .and_then(Value::as_i64)
        .or_else(|| value.get("time").and_then(Value::as_f64).map(|v| v as i64))
        .or_else(|| value.get("createdAt").and_then(Value::as_i64))
}

/// Extract the visible text from one `assistant/chunk` payload.
/// Terminal chunks (`finish` / `error` / `stop`) carry no text and are skipped.
fn chunk_text(chunk: &Value) -> Option<String> {
    let kind = chunk.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(kind, "finish" | "end" | "stop" | "error") {
        return None;
    }
    for key in ["text", "delta", "content"] {
        let Some(value) = chunk.get(key) else {
            continue;
        };
        let text = if value.is_string() {
            value.as_str().unwrap_or("").to_string()
        } else {
            extract_text(value)
        };
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let root = match sessions_root() {
        Some(root) => root,
        None => return Vec::new(),
    };
    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_session_files(&root, &mut files);
    files.sort();

    files.iter().filter_map(|path| parse_session(path)).collect()
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let events = read_events(path, usize::MAX)?;
    let mut messages = Vec::new();

    // Consecutive assistant chunks belong to the same reply — accumulate them
    // and flush when the turn ends or the user speaks again.
    let mut pending = String::new();
    let mut pending_ts: Option<i64> = None;

    let flush = |messages: &mut Vec<SessionMessage>, pending: &mut String, ts: &mut Option<i64>| {
        let text = pending.trim().to_string();
        if !text.is_empty() {
            messages.push(SessionMessage {
                role: "assistant".to_string(),
                content: text,
                ts: ts.take(),
            });
        }
        pending.clear();
        *ts = None;
    };

    for value in &events {
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let ts = event_time(value);

        match record_type {
            "user/message" => {
                flush(&mut messages, &mut pending, &mut pending_ts);
                let role = data
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user")
                    .to_string();
                let content = data
                    .get("content")
                    .map(extract_text)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if content.is_empty() {
                    continue;
                }
                messages.push(SessionMessage {
                    role,
                    content,
                    ts: ts.or(pending_ts.take()),
                });
            }
            "assistant/chunk" => {
                let chunk = data.get("chunk").cloned().unwrap_or(Value::Null);
                if let Some(text) = chunk_text(&chunk) {
                    if pending_ts.is_none() {
                        pending_ts = ts;
                    }
                    pending.push_str(&text);
                }
            }
            "tool/call" => {
                flush(&mut messages, &mut pending, &mut pending_ts);
                let name = data
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| data.get("tool").and_then(Value::as_str))
                    .unwrap_or("unknown");
                let args = data
                    .get("arguments")
                    .or_else(|| data.get("input"))
                    .map(extract_text)
                    .unwrap_or_default();
                let content = if args.trim().is_empty() {
                    format!("[Tool: {name}]")
                } else {
                    format!("[Tool: {name}] {}", truncate_summary(&args, 200))
                };
                messages.push(SessionMessage {
                    role: "assistant".to_string(),
                    content,
                    ts,
                });
            }
            "tool/result" => {
                flush(&mut messages, &mut pending, &mut pending_ts);
                let content = data
                    .get("output")
                    .or_else(|| data.get("result"))
                    .or_else(|| data.get("content"))
                    .map(extract_text)
                    .unwrap_or_default();
                if content.trim().is_empty() {
                    continue;
                }
                messages.push(SessionMessage {
                    role: "tool".to_string(),
                    content,
                    ts,
                });
            }
            "turn/end" | "step/end" | "session/end" => {
                flush(&mut messages, &mut pending, &mut pending_ts);
            }
            // session / session/title / permission/* / turn/start / step/start /
            // request/* are not part of the visible transcript
            _ => {}
        }
    }

    flush(&mut messages, &mut pending, &mut pending_ts);

    Ok(messages)
}

/// Delete a DSH session.
///
/// A session lives in its own directory (`session-<uuid>/session.jsonl.zstd`),
/// so the whole directory is removed when it matches the session id; otherwise
/// only the transcript file is removed.
pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let meta = parse_session(path)
        .ok_or_else(|| format!("Failed to parse DSH session metadata: {}", path.display()))?;

    if meta.session_id != session_id {
        return Err(format!(
            "DSH session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }

    // Prefer removing the session directory (it may hold more than the transcript).
    if let Some(dir) = path.parent() {
        let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if dir_name == session_id {
            std::fs::remove_dir_all(dir).map_err(|e| {
                format!("Failed to delete DSH session dir {}: {e}", dir.display())
            })?;
            return Ok(true);
        }
    }

    std::fs::remove_file(path)
        .map_err(|e| format!("Failed to delete DSH session file {}: {e}", path.display()))?;
    Ok(true)
}

pub fn session_roots() -> Vec<PathBuf> {
    sessions_root().into_iter().collect()
}

fn collect_session_files(root: &Path, files: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, files);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.ends_with(".jsonl.zstd"))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    // The head carries session metadata, the generated title and the opening
    // user message; 80 events is plenty for all of them.
    let events = read_events(path, 80).ok()?;

    let mut session_id: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut title: Option<String> = None;
    let mut first_user_message: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut last_active_at: Option<i64> = None;

    for value in &events {
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let data = value.get("data").cloned().unwrap_or(Value::Null);

        match record_type {
            "session" => {
                if session_id.is_none() {
                    session_id = value
                        .get("id")
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
                    created_at = value.get("createdAt").and_then(Value::as_i64);
                }
            }
            "session/title" => {
                // Later title events supersede earlier ones (LLM may refine it).
                if let Some(candidate) = data
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                {
                    title = Some(candidate);
                }
            }
            "user/message" => {
                if first_user_message.is_none() {
                    let text = data
                        .get("content")
                        .map(extract_text)
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        first_user_message = Some(text);
                    }
                }
            }
            "assistant/chunk" => {
                // Keep the latest assistant text as the session summary preview.
                if let Some(text) = data.get("chunk").and_then(chunk_text) {
                    if !text.trim().is_empty() {
                        summary = Some(text);
                    }
                }
            }
            _ => {}
        }

        if let Some(ts) = event_time(value) {
            last_active_at = Some(ts);
        }
    }

    let session_id = session_id.or_else(|| infer_session_id_from_dir(path))?;

    // Title priority: DSH generated title > first user message > project dir name
    let title = title
        .map(|t| truncate_summary(&t, TITLE_MAX_CHARS))
        .or_else(|| {
            first_user_message
                .as_deref()
                .map(|t| truncate_summary(t, TITLE_MAX_CHARS))
        })
        .or_else(|| {
            project_dir
                .as_deref()
                .and_then(path_basename)
                .map(String::from)
        });

    let summary = summary.map(|text| truncate_summary(&text, 160));

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary,
        project_dir,
        created_at,
        last_active_at: last_active_at.or(created_at),
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: Some(format!("dsh --resume {session_id}")),
    })
}

/// `…/session-<uuid>/session.jsonl.zstd` → `session-<uuid>`
fn infer_session_id_from_dir(path: &Path) -> Option<String> {
    path.parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with("session-"))
        .map(|name| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn zstd_jsonl(lines: &[&str]) -> Vec<u8> {
        let raw = lines.join("\n") + "\n";
        zstd::encode_all(raw.as_bytes(), 3).expect("zstd encode")
    }

    fn session_line(id: &str, cwd: &str, created_at: i64) -> String {
        format!(
            r#"{{"type":"session","version":0,"id":"{id}","createdAt":{created_at},"cwd":"{cwd}","delegationDepth":0,"agentPreset":"standard"}}"#
        )
    }

    fn user_line(seq: u64, time: i64, text: &str) -> String {
        format!(
            r#"{{"type":"user/message","seq":{seq},"time":{time},"data":{{"content":[{{"type":"text","text":"{text}"}}],"role":"user"}}}}"#
        )
    }

    fn chunk_line(seq: u64, time: i64, text: &str) -> String {
        format!(
            r#"{{"type":"assistant/chunk","seq":{seq},"time":{time},"data":{{"turn":1,"step":1,"chunk":{{"type":"text","text":"{text}"}}}}}}"#
        )
    }

    fn write_session(dir: &Path, session_id: &str, payload: Vec<u8>) -> PathBuf {
        let session_dir = dir.join(session_id);
        std::fs::create_dir_all(&session_dir).expect("mkdir");
        let path = session_dir.join("session.jsonl.zstd");
        std::fs::write(&path, payload).expect("write");
        path
    }

    #[test]
    fn parses_session_metadata_and_generated_title() {
        let temp = tempdir().expect("tempdir");
        let payload = zstd_jsonl(&[
            &session_line("session-abc", "/tmp/proj", 1786789640185),
            &user_line(7, 1786789675863, "hi"),
            r#"{"type":"session/title","seq":9,"time":1786789675865,"data":{"title":"开场问候","source":{"kind":"llm"}}}"#,
        ]);
        let path = write_session(temp.path(), "session-abc", payload);

        let meta = parse_session(&path).expect("parse");
        assert_eq!(meta.provider_id, PROVIDER_ID);
        assert_eq!(meta.session_id, "session-abc");
        assert_eq!(meta.title.as_deref(), Some("开场问候"));
        assert_eq!(meta.project_dir.as_deref(), Some("/tmp/proj"));
        assert_eq!(meta.created_at, Some(1786789640185));
        assert_eq!(meta.last_active_at, Some(1786789675865));
    }

    #[test]
    fn falls_back_to_first_user_message_without_title() {
        let temp = tempdir().expect("tempdir");
        let payload = zstd_jsonl(&[
            &session_line("session-def", "/tmp/proj", 1786789640185),
            &user_line(7, 1786789675863, "帮我看下这个报错"),
        ]);
        let path = write_session(temp.path(), "session-def", payload);

        let meta = parse_session(&path).expect("parse");
        assert_eq!(meta.title.as_deref(), Some("帮我看下这个报错"));
    }

    #[test]
    fn load_messages_merges_chunks_and_maps_tools() {
        let temp = tempdir().expect("tempdir");
        let payload = zstd_jsonl(&[
            &session_line("session-xyz", "/tmp/proj", 1786789640185),
            &user_line(1, 1786789641000, "hi"),
            &chunk_line(2, 1786789642000, "你好"),
            &chunk_line(3, 1786789643000, "，有什么可以帮你？"),
            r#"{"type":"assistant/chunk","seq":4,"time":1786789644000,"data":{"turn":1,"step":1,"chunk":{"type":"finish"}}}"#,
            r#"{"type":"tool/call","seq":5,"time":1786789645000,"data":{"name":"bash","arguments":"ls -la"}}"#,
            r#"{"type":"tool/result","seq":6,"time":1786789646000,"data":{"output":"total 3"}}"#,
        ]);
        let path = write_session(temp.path(), "session-xyz", payload);

        let messages = load_messages(&path).expect("load");
        let roles: Vec<&str> = messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "assistant", "tool"]);
        // consecutive chunks merged into a single assistant message
        assert_eq!(messages[1].content, "你好，有什么可以帮你？");
        assert_eq!(messages[1].ts, Some(1786789642000));
        assert!(messages[2].content.starts_with("[Tool: bash]"));
        assert_eq!(messages[3].content, "total 3");
    }

    #[test]
    fn delete_session_removes_session_directory() {
        let temp = tempdir().expect("tempdir");
        let payload = zstd_jsonl(&[&session_line("session-del", "/tmp/proj", 1786789640185)]);
        let path = write_session(temp.path(), "session-del", payload);
        let dir = path.parent().expect("parent").to_path_buf();

        delete_session(temp.path(), &path, "session-del").expect("delete");
        assert!(!dir.exists());
        assert!(!path.exists());
    }

    /// Real-data smoke: scan the machine's `~/.dsh/sessions`.
    /// Skipped when DSH is not installed.
    #[test]
    fn scan_real_sessions_smoke() {
        let root = match sessions_root() {
            Some(root) => root,
            None => return,
        };
        if !root.exists() {
            eprintln!("skip: {} not found", root.display());
            return;
        }

        let sessions = scan_sessions();
        assert!(!sessions.is_empty(), "应至少解析出 1 个 DSH 会话");

        for session in &sessions {
            assert_eq!(session.provider_id, PROVIDER_ID);
            assert!(!session.session_id.is_empty());
            assert!(
                session.created_at.is_some() || session.last_active_at.is_some(),
                "会话应能解析出时间戳: {session:?}"
            );
        }

        let first = &sessions[0];
        let source = first.source_path.as_ref().expect("source_path");
        let messages = load_messages(Path::new(source))
            .unwrap_or_else(|e| panic!("load_messages({source}) 失败: {e}"));
        eprintln!(
            "dsh 真实会话: {} 个，抽样 {:?} 含 {} 条消息",
            sessions.len(),
            first.title.as_deref().unwrap_or("(无标题)"),
            messages.len()
        );
    }
}
