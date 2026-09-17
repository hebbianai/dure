use hebbian_bounded_process::{self as bounded_process, CommandSpec};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::login_shell::resolve_login_shell;

mod claude_session_title;
mod codex_rollout_files;
mod codex_thread_index;
pub(crate) mod presentation_metadata;
mod recent_sessions;
pub(crate) mod remote_presentation_metadata;
pub use recent_sessions::{
    details_global, details_remote, list_global, list_remote, ProviderConversationDetails,
    ProviderConversationRecord, ProviderConversationTranscript, transcript_global,
};

#[tauri::command(async)]
pub async fn provider_conversation_details(
    provider: String,
    conversation_id: String,
) -> Result<ProviderConversationDetails, String> {
    details_global(&provider, &conversation_id).await
}

#[tauri::command(async)]
pub async fn remote_provider_conversation_details(
    host_id: String,
    opts: crate::ssh::SshOptions,
    provider: String,
    conversation_id: String,
) -> Result<ProviderConversationDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        details_remote(&host_id, &opts, &provider, &conversation_id)
    })
    .await
    .map_err(|error| format!("remote provider conversation details task failed: {error}"))?
}

const MAX_CONVERSATIONS: usize = 50;
const MAX_PROVIDER_RECORDS: usize = 200;
const MAX_SESSION_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PROVIDER_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_PROVIDER_LIST_OUTPUT: usize = 1024 * 1024;
const PROVIDER_LIST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// 마지막 활동 시각 (unix secs)
    pub mtime: u64,
}

/// Claude Code는 cwd의 `/`와 `.`를 모두 `-`로 바꿔 프로젝트 디렉토리명을 만든다.
fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn mtime_secs(e: &fs::DirEntry) -> u64 {
    e.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn path_mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn clip(s: &str) -> String {
    let t = s.trim();
    t.chars().take(64).collect()
}

/// JSON 값에서 사용자 텍스트를 추출 (content: string | [{type:text,text}]).
fn user_text(v: &serde_json::Value) -> Option<String> {
    match v.pointer("/message/content") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => arr.iter().find_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        }),
        _ => None,
    }
}

/// 같은 논리적 대화의 조각들을 하나로 접는다 — 최신 활동만 남긴다.
///
/// 왜: 컨텍스트 압축(claude)과 resume(codex)은 전체 히스토리를 **새 세션
/// 파일로 복사**한다. 파일마다 행을 만들면 같은 대화가 제목은 같고 시간만
/// 다른 행으로 반복돼 Recent work와 히스토리 드롭다운이 도배된다(2026-07-31
/// 사용자 제보 — 실측: claude는 첫 user 줄 uuid가 동일한 조각 2개, codex는
/// 같은 thread id가 파일 3개). 키가 없는 항목(None)은 병합 근거가 없으므로
/// 전부 남긴다 — 잘못 합치는 것보다 중복이 낫다.
fn keep_newest_by_key(mut rows: Vec<(Conversation, Option<String>)>) -> Vec<Conversation> {
    rows.sort_by_key(|(conversation, _)| std::cmp::Reverse(conversation.mtime));
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter_map(|(conversation, key)| match key {
            Some(key) => seen.insert(key).then_some(conversation),
            None => Some(conversation),
        })
        .collect()
}

fn list_claude_from_root(cwd: &str, root: &Path) -> Vec<Conversation> {
    let dir = root.join("projects").join(encode_cwd(cwd));
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let id = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let (title, identity) = claude_session_title::title_and_identity(&p);
            out.push((
                Conversation {
                    id,
                    title,
                    mtime: mtime_secs(&e),
                },
                identity,
            ));
        }
    }
    // keep_newest_by_key가 mtime 내림차순 정렬까지 맡는다.
    let mut out = keep_newest_by_key(out);
    out.truncate(MAX_CONVERSATIONS);
    out
}

fn codex_content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_text" | "text")
                    )
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Codex rollouts contain startup context in user-role records. Those records
/// configure the client and are not a conversation title.
fn codex_context_injection(text: &str) -> bool {
    let text = text.trim_start();
    [
        "# AGENTS.md instructions for ",
        "<environment_context>",
        "<INSTRUCTIONS>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<apps_instructions>",
        "<plugins_instructions>",
        "<skills_instructions>",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn codex_user_text(record: &Value) -> Option<String> {
    let payload = record.get("payload").unwrap_or(record);
    if payload.get("type").and_then(Value::as_str) == Some("user_message") {
        return payload
            .get("message")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string);
    }
    if payload.get("type").and_then(Value::as_str) == Some("message")
        && payload.get("role").and_then(Value::as_str) == Some("user")
    {
        return payload.get("content").and_then(codex_content_text);
    }
    None
}

fn latest_title_codex(content: &str) -> Option<String> {
    let mut latest = None;
    for record in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        let Some(text) = codex_user_text(&record) else {
            continue;
        };
        if codex_context_injection(&text) {
            continue;
        }
        let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !title.is_empty() {
            latest = Some(clip(&title));
        }
    }
    latest
}

/// 파일 끝쪽 max_bytes를 읽는다. 경계에서 잘린 앞부분의 불완전한 줄 하나는
/// 버린다 — jsonl에서 완전한 레코드만 파싱되게.
fn read_bounded_text_suffix(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::Seek;
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let start = metadata.len().saturating_sub(max_bytes);
    file.seek(std::io::SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        let index = text.find('\n')?;
        text.drain(..=index);
    }
    Some(text)
}

fn collect_codex(dir: &Path, cwd: &str, out: &mut Vec<(Conversation, Option<String>)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_codex(&p, cwd, out);
            continue;
        }
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(content) = read_bounded_text_prefix(&p, MAX_SESSION_FILE_BYTES) else { continue };
        let first = content.lines().next().unwrap_or("");
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(first) else { continue };
        if meta.pointer("/payload/cwd").and_then(|c| c.as_str()) != Some(cwd) {
            continue;
        }
        // subagent 스레드는 대화가 아니다 — 부모 히스토리를 첫 메시지째 복사해
        // 목록을 같은 제목으로 도배한다(2026-07-31 실측: 사용자 스레드 1개에
        // subagent 사본 6개). thread_source 도입 전 파일을 위해 source 객체의
        // subagent 키도 함께 본다.
        if meta.pointer("/payload/thread_source").and_then(|v| v.as_str()) == Some("subagent")
            || meta.pointer("/payload/source/subagent").is_some()
        {
            continue;
        }
        let id = meta
            .pointer("/payload/id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        out.push((
            Conversation {
                id: id.clone(),
                // 최근 발화는 파일 끝쪽에 있다 — 긴 rollout에서 접두 1MB만
                // 보면 며칠 전 첫 질문이 제목이 된다. 꼬리에 사용자 발화가
                // 없으면(짧은 파일은 꼬리=전체) 접두로 물러난다.
                title: read_bounded_text_suffix(&p, MAX_SESSION_FILE_BYTES)
                    .and_then(|tail| latest_title_codex(&tail))
                    .or_else(|| latest_title_codex(&content))
                    .unwrap_or_else(|| "Codex session".to_string()),
                mtime: mtime_secs(&e),
            },
            Some(id),
        ));
    }
}

fn list_codex_from_root(cwd: &str, root: &Path) -> Vec<Conversation> {
    let mut out = Vec::new();
    collect_codex(&root.join("sessions"), cwd, &mut out);
    // resume는 같은 thread id로 새 rollout 파일을 만든다(실측: 한 id가 파일
    // 3개). 최신 파일만 남겨야 이어하기가 현재 조각을 연다.
    let mut out = keep_newest_by_key(out);
    let provider_titles = codex_thread_index::titles(root);
    for conversation in &mut out {
        if let Some(title) = provider_titles.get(&conversation.id) {
            conversation.title = title.clone();
        }
    }
    out.truncate(MAX_CONVERSATIONS);
    out
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    if left.as_os_str().is_empty() || right.as_os_str().is_empty() {
        return false;
    }
    canonical_path(left) == canonical_path(right)
}

fn safe_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-".contains(character))
}

pub(crate) fn exact_uuid_identity(value: &str) -> bool {
    dure_provider_adapter::exact_uuid_identity(value)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if seen.insert(path.clone()) {
        paths.push(path);
    }
}

fn read_bounded_text(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn read_bounded_text_prefix(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    fs::File::open(path)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn gemini_root() -> PathBuf {
    let home = std::env::var_os("GEMINI_CLI_HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".gemini")
}

fn gemini_project_directories(cwd: &Path, root: &Path) -> Vec<PathBuf> {
    let cwd = canonical_path(cwd);
    let tmp = root.join("tmp");
    let mut directories = Vec::new();
    let mut seen = HashSet::new();

    if let Some(content) =
        read_bounded_text(&root.join("projects.json"), MAX_PROVIDER_METADATA_BYTES)
    {
        if let Ok(registry) = serde_json::from_str::<Value>(&content) {
            if let Some(projects) = registry.get("projects").and_then(Value::as_object) {
                for (project, slug) in projects {
                    if same_path(Path::new(project), &cwd) {
                        if let Some(slug) = slug.as_str().filter(|slug| {
                            !slug.is_empty()
                                && slug
                                    .chars()
                                    .all(|character| {
                                        character.is_ascii_lowercase()
                                            || character.is_ascii_digit()
                                            || character == '-'
                                    })
                        }) {
                            push_unique_path(&mut directories, &mut seen, tmp.join(slug));
                        }
                    }
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&tmp) {
        for entry in entries.flatten().take(MAX_PROVIDER_RECORDS) {
            let candidate = entry.path();
            let marker = candidate.join(".project_root");
            let Ok(metadata) = fs::metadata(&marker) else {
                continue;
            };
            if metadata.len() > 4096 {
                continue;
            }
            let Ok(owner) = fs::read_to_string(marker) else {
                continue;
            };
            if same_path(Path::new(owner.trim()), &cwd) {
                push_unique_path(&mut directories, &mut seen, candidate);
            }
        }
    }

    {
        let project = cwd.to_string_lossy().into_owned();
        let mut digest = Sha256::new();
        digest.update(project.as_bytes());
        push_unique_path(
            &mut directories,
            &mut seen,
            tmp.join(format!("{:x}", digest.finalize())),
        );
    }
    directories
}

fn text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.as_str())
                })
                .collect::<String>();
            (!joined.trim().is_empty()).then_some(joined)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn gemini_user_title(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("user") {
        return value.get("content").and_then(text_content).map(|text| clip(&text));
    }
    value
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.iter().find_map(gemini_user_title))
}

fn gemini_session(path: &Path) -> Option<Conversation> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SESSION_FILE_BYTES {
        return None;
    }
    let content = read_bounded_text(path, MAX_SESSION_FILE_BYTES)?;
    let mut session_id = None;
    let mut title = None;
    let mut subagent = false;
    if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        for line in content.lines() {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let metadata = record.get("$set").unwrap_or(&record);
            if session_id.is_none() {
                session_id = metadata
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if metadata.get("kind").and_then(Value::as_str) == Some("subagent") {
                subagent = true;
            }
            if title.is_none() {
                title = gemini_user_title(&record);
            }
        }
    } else {
        let record = serde_json::from_str::<Value>(&content).ok()?;
        session_id = record
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        subagent = record.get("kind").and_then(Value::as_str) == Some("subagent");
        title = gemini_user_title(&record);
    }
    let session_id = session_id.filter(|id| safe_conversation_id(id))?;
    if subagent {
        return None;
    }
    Some(Conversation {
        id: session_id,
        title: title.unwrap_or_else(|| "Gemini session".to_string()),
        mtime: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
    })
}

fn list_gemini_from_root(cwd: &Path, root: &Path) -> Vec<Conversation> {
    let mut out = Vec::new();
    let mut candidates_seen = 0;
    for project in gemini_project_directories(cwd, root) {
        if candidates_seen >= MAX_PROVIDER_RECORDS {
            break;
        }
        let Ok(entries) = fs::read_dir(project.join("chats")) else {
            continue;
        };
        for entry in entries
            .flatten()
            .take(MAX_PROVIDER_RECORDS - candidates_seen)
        {
            candidates_seen += 1;
            let path = entry.path();
            let supported = matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("json" | "jsonl")
            );
            if supported {
                if let Some(conversation) = gemini_session(&path) {
                    out.push(conversation);
                }
            }
        }
    }
    out.sort_by_key(|conversation| std::cmp::Reverse(conversation.mtime));
    let mut seen = HashSet::new();
    out.retain(|conversation| seen.insert(conversation.id.clone()));
    out.truncate(MAX_CONVERSATIONS);
    out
}

pub fn list_gemini(cwd: &str) -> Vec<Conversation> {
    list_gemini_from_root(Path::new(cwd), &gemini_root())
}

fn pi_sessions_root() -> PathBuf {
    if let Some(root) =
        std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|value| !value.is_empty())
    {
        return PathBuf::from(root);
    }
    let agent_root = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pi/agent")
        });
    agent_root.join("sessions")
}

fn pi_project_directory_name(cwd: &Path) -> String {
    let cwd = cwd.to_string_lossy();
    let without_root = cwd.trim_start_matches(['/', '\\']);
    let encoded = without_root
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    format!("--{encoded}--")
}

fn pi_session(path: &Path, cwd: &Path) -> Option<Conversation> {
    // Long-running Pi sessions routinely exceed the inspection budget. The
    // provider identity is in the first record, so inspect only a bounded
    // prefix instead of making mature sessions disappear from the picker.
    let content = read_bounded_text_prefix(path, MAX_SESSION_FILE_BYTES)?;
    let mut lines = content.lines().filter(|line| !line.trim().is_empty());
    let header = serde_json::from_str::<Value>(lines.next()?).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = header.get("id").and_then(Value::as_str)?;
    let owner = header.get("cwd").and_then(Value::as_str)?;
    if !safe_conversation_id(id) || !same_path(Path::new(owner), cwd) {
        return None;
    }

    let mut name = None;
    let mut first_message = None;
    for record in lines.filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
        if record.get("type").and_then(Value::as_str) == Some("session_info") {
            name = record
                .get("name")
                .and_then(Value::as_str)
                .map(clip)
                .filter(|title| !title.is_empty());
        }
        if first_message.is_none()
            && record.get("type").and_then(Value::as_str) == Some("message")
            && record.pointer("/message/role").and_then(Value::as_str) == Some("user")
        {
            first_message = record
                .pointer("/message/content")
                .and_then(text_content)
                .map(|title| clip(&title))
                .filter(|title| !title.is_empty());
        }
    }

    Some(Conversation {
        id: id.to_string(),
        title: name
            .or(first_message)
            .unwrap_or_else(|| "Pi session".to_string()),
        mtime: path_mtime_secs(path),
    })
}

fn list_pi_from_root(cwd: &Path, root: &Path) -> Vec<Conversation> {
    let mut directories = vec![root.to_path_buf()];
    let mut seen = HashSet::from([root.to_path_buf()]);
    push_unique_path(
        &mut directories,
        &mut seen,
        root.join(pi_project_directory_name(cwd)),
    );
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten().take(MAX_PROVIDER_RECORDS) {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                push_unique_path(&mut directories, &mut seen, entry.path());
            }
        }
    }

    let mut out = Vec::new();
    let mut candidates_seen = 0;
    for directory in directories {
        if candidates_seen >= MAX_PROVIDER_RECORDS {
            break;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries
            .flatten()
            .take(MAX_PROVIDER_RECORDS - candidates_seen)
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            candidates_seen += 1;
            if let Some(conversation) = pi_session(&path, cwd) {
                out.push(conversation);
            }
        }
    }
    out.sort_by_key(|conversation| std::cmp::Reverse(conversation.mtime));
    let mut ids = HashSet::new();
    out.retain(|conversation| ids.insert(conversation.id.clone()));
    out.truncate(MAX_CONVERSATIONS);
    out
}

pub fn list_pi(cwd: &str) -> Vec<Conversation> {
    list_pi_from_root(Path::new(cwd), &pi_sessions_root())
}

fn grok_root() -> PathBuf {
    std::env::var_os("GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".grok")
        })
}

fn url_encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn grok_session(path: &Path, cwd: &Path) -> Option<Conversation> {
    let content = read_bounded_text(path, MAX_PROVIDER_METADATA_BYTES)?;
    let record = serde_json::from_str::<Value>(&content).ok()?;
    let id = record.pointer("/info/id").and_then(Value::as_str)?;
    let owner = record.pointer("/info/cwd").and_then(Value::as_str)?;
    if !safe_conversation_id(id)
        || !exact_uuid_identity(id)
        || !same_path(Path::new(owner), cwd)
    {
        return None;
    }
    let hidden = record
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            record
                .get("session_kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.starts_with("subagent"))
        });
    if hidden {
        return None;
    }
    let title = record
        .get("generated_title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            record
                .get("session_summary")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
        })
        .map(clip)
        .unwrap_or_else(|| "Grok Build session".to_string());
    Some(Conversation {
        id: id.to_string(),
        title,
        mtime: path_mtime_secs(path),
    })
}

fn list_grok_from_root(cwd: &Path, root: &Path) -> Vec<Conversation> {
    let sessions_root = root.join("sessions");
    let preferred = sessions_root.join(url_encode_component(&cwd.to_string_lossy()));
    let mut directories = vec![preferred.clone()];
    let mut seen = HashSet::from([preferred]);
    if let Ok(entries) = fs::read_dir(&sessions_root) {
        for entry in entries.flatten().take(MAX_PROVIDER_RECORDS) {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                push_unique_path(&mut directories, &mut seen, entry.path());
            }
        }
    }

    let mut out = Vec::new();
    let mut candidates_seen = 0;
    for directory in directories {
        if candidates_seen >= MAX_PROVIDER_RECORDS {
            break;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries
            .flatten()
            .take(MAX_PROVIDER_RECORDS - candidates_seen)
        {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            candidates_seen += 1;
            if let Some(conversation) = grok_session(&entry.path().join("summary.json"), cwd) {
                out.push(conversation);
            }
        }
    }
    out.sort_by_key(|conversation| std::cmp::Reverse(conversation.mtime));
    let mut ids = HashSet::new();
    out.retain(|conversation| ids.insert(conversation.id.clone()));
    out.truncate(MAX_CONVERSATIONS);
    out
}

pub fn list_grok(cwd: &str) -> Vec<Conversation> {
    list_grok_from_root(Path::new(cwd), &grok_root())
}

fn parse_opencode_sessions(cwd: &Path, output: &[u8]) -> Vec<Conversation> {
    let Ok(records) = serde_json::from_slice::<Vec<Value>>(output) else {
        return Vec::new();
    };
    let mut out = records
        .into_iter()
        .take(MAX_PROVIDER_RECORDS)
        .filter_map(|record| {
            let id = record.get("id").and_then(Value::as_str)?;
            let directory = record.get("directory").and_then(Value::as_str)?;
            if !safe_conversation_id(id) || !same_path(Path::new(directory), cwd) {
                return None;
            }
            let title = record
                .get("title")
                .and_then(Value::as_str)
                .map(clip)
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| "OpenCode session".to_string());
            let mtime = record
                .get("updated")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                / 1000;
            Some(Conversation {
                id: id.to_string(),
                title,
                mtime,
            })
        })
        .collect::<Vec<_>>();
    out.sort_by_key(|conversation| std::cmp::Reverse(conversation.mtime));
    let mut seen = HashSet::new();
    out.retain(|conversation| seen.insert(conversation.id.clone()));
    out.truncate(MAX_CONVERSATIONS);
    out
}

fn opencode_list_command(cwd: &Path) -> CommandSpec {
    #[cfg(unix)]
    {
        let shell = resolve_login_shell();
        let mut command = CommandSpec::new(shell);
        command
            .args([
                "-lc",
                "exec opencode session list --max-count 200 --format json",
            ])
            .current_dir(cwd);
        command
    }
    #[cfg(windows)]
    {
        let mut command = CommandSpec::new("cmd");
        command
            .args([
                "/D",
                "/S",
                "/C",
                "opencode session list --max-count 200 --format json",
            ])
            .current_dir(cwd);
        command
    }
}

pub fn list_opencode(cwd: &str) -> Vec<Conversation> {
    let cwd = Path::new(cwd);
    let command = opencode_list_command(cwd);
    let Ok(output) = bounded_process::run(
        &command,
        PROVIDER_LIST_TIMEOUT,
        MAX_PROVIDER_LIST_OUTPUT,
    ) else {
        return Vec::new();
    };
    if !output.status.success() || output.exceeded_limit {
        return Vec::new();
    }
    parse_opencode_sessions(cwd, &output.stdout)
}

fn ensure_conversation_credential_profile_supported(
    provider: &str,
    profile_selected: bool,
) -> Result<(), String> {
    if profile_selected && !matches!(provider, "claude" | "codex") {
        return Err(
            "conversation_credential_profile_unsupported: provider does not store conversations in a credential profile"
                .to_string(),
        );
    }
    Ok(())
}

fn parse_conversation_home(home: Option<std::ffi::OsString>) -> Result<PathBuf, String> {
    home.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "conversation_home_unavailable".to_string())
}

pub(crate) fn conversation_home() -> Result<PathBuf, String> {
    parse_conversation_home(std::env::var_os("HOME"))
}

pub fn list(
    cwd: &str,
    provider: &str,
    credential_profile_root: Option<&Path>,
) -> Result<Vec<Conversation>, String> {
    ensure_conversation_credential_profile_supported(
        provider,
        credential_profile_root.is_some(),
    )?;
    let default_root = |directory: &str| conversation_home().map(|home| home.join(directory));
    let conversations = match (provider, credential_profile_root) {
        ("claude", Some(root)) => list_claude_from_root(cwd, root),
        ("claude", None) => list_claude_from_root(cwd, &default_root(".claude")?),
        ("codex", Some(root)) => list_codex_from_root(cwd, root),
        ("codex", None) => list_codex_from_root(cwd, &default_root(".codex")?),
        ("gemini", None) => list_gemini(cwd),
        ("grok", None) => list_grok(cwd),
        ("opencode", None) => list_opencode(cwd),
        ("pi", None) => list_pi(cwd),
        _ => Vec::new(),
    };
    Ok(conversations)
}

const REMOTE_LIST_SCRIPT: &str = r##"import glob,hashlib,itertools,json,os,re,subprocess,sys,tempfile,urllib.parse,uuid
cwd=sys.argv[1]; prov=sys.argv[2]; home=os.path.expanduser("~"); profile=sys.argv[3] or None; out=[]
profile_root=os.path.join(home,profile) if profile else None
limit=1024*1024; safe_id=re.compile(r"^[A-Za-z0-9._:+-]{1,256}$")
def clip(value): return str(value).strip()[:64]
def same(left,right):
  return isinstance(left,str) and isinstance(right,str) and bool(left) and bool(right) and os.path.realpath(left)==os.path.realpath(right)
def text(value):
  if isinstance(value,str): return value if value.strip() else None
  if isinstance(value,list):
    joined="".join(str(part.get("text","")) if isinstance(part,dict) else str(part) if isinstance(part,str) else "" for part in value)
    return joined if joined.strip() else None
  if isinstance(value,dict) and isinstance(value.get("text"),str): return value["text"]
  return None
def codex_content_text(value):
  if isinstance(value,str): return value if value.strip() else None
  if isinstance(value,list):
    joined="".join(part.get("text","") for part in value if isinstance(part,dict) and part.get("type") in ("input_text","text") and isinstance(part.get("text"),str))
    return joined if joined.strip() else None
  return None
def codex_context_injection(value):
  stripped=value.lstrip()
  return stripped.startswith(("# AGENTS.md instructions for ","<environment_context>","<INSTRUCTIONS>","<permissions instructions>","<collaboration_mode>","<apps_instructions>","<plugins_instructions>","<skills_instructions>"))
def codex_user_text(value):
  if not isinstance(value,dict): return None
  payload=value.get("payload",value)
  if not isinstance(payload,dict): return None
  if payload.get("type")=="user_message" and isinstance(payload.get("message"),str): return payload["message"]
  if payload.get("type")=="message" and payload.get("role")=="user": return codex_content_text(payload.get("content"))
  return None
def add(cid,title,mtime):
  if isinstance(cid,str) and safe_id.fullmatch(cid):
    out.append({"id":cid,"title":clip(title) or "(Untitled)","mtime":int(mtime)})
def exact_uuid(value):
  try: return isinstance(value,str) and str(uuid.UUID(value)).lower()==value.lower()
  except Exception: return False
if prov=="codex":
  root=profile_root or os.path.join(home,".codex")
  files=itertools.islice(glob.iglob(os.path.join(root,"sessions","**","rollout-*.jsonl"),recursive=True),200)
  for file in files:
    try:
      if os.path.getsize(file)>limit: continue
      with open(file) as handle: first=handle.readline()
      metadata=json.loads(first)
      if not same(metadata.get("payload",{}).get("cwd",""),cwd): continue
      title="Codex session"
      with open(file) as handle:
        for line in handle:
          try:
            found=codex_user_text(json.loads(line))
            if found and not codex_context_injection(found): title=" ".join(found.split()); break
          except Exception: pass
      add(metadata.get("payload",{}).get("id"),title,os.path.getmtime(file))
    except Exception: pass
elif prov=="claude":
  encoded="".join("-" if character in "/." else character for character in cwd)
  root=profile_root or os.path.join(home,".claude")
  for file in itertools.islice(glob.iglob(os.path.join(root,"projects",encoded,"*.jsonl")),200):
    try:
      if os.path.getsize(file)>limit: continue
      title="(Untitled)"
      with open(file) as handle:
        for line in handle:
          if '"type":"user"' not in line: continue
          try:
            value=json.loads(line)
            if value.get("type")!="user": continue
            found=text(value.get("message",{}).get("content"))
            if found and not found.strip().startswith(("<","Caveat:")): title=found; break
          except Exception: pass
      add(os.path.basename(file)[:-6],title,os.path.getmtime(file))
    except Exception: pass
elif prov=="gemini":
  base=os.environ.get("GEMINI_CLI_HOME") or home
  root=os.path.join(base,".gemini"); tmp=os.path.join(root,"tmp"); directories=[]
  try:
    registry=os.path.join(root,"projects.json")
    if os.path.getsize(registry)>limit: raise ValueError("oversized registry")
    with open(registry) as handle: projects=json.load(handle).get("projects",{})
    for project,slug in projects.items():
      if same(project,cwd) and isinstance(slug,str) and re.fullmatch(r"[a-z0-9-]+",slug): directories.append(os.path.join(tmp,slug))
  except Exception: pass
  for candidate in itertools.islice(glob.iglob(os.path.join(tmp,"*")),200):
    try:
      marker=os.path.join(candidate,".project_root")
      if os.path.getsize(marker)<=4096:
        with open(marker) as handle:
          if same(handle.read().strip(),cwd): directories.append(candidate)
    except Exception: pass
  directories.append(os.path.join(tmp,hashlib.sha256(os.path.realpath(cwd).encode()).hexdigest()))
  seen=set(); candidates=0
  for directory in directories:
    if directory in seen or candidates>=200: continue
    seen.add(directory)
    for file in itertools.islice(glob.iglob(os.path.join(directory,"chats","session-*.json*")),200-candidates):
      candidates+=1
      try:
        if os.path.getsize(file)>limit: continue
        cid=None; title="Gemini session"; subagent=False
        if file.endswith(".jsonl"):
          with open(file) as handle:
            for line in handle:
              try: value=json.loads(line)
              except Exception: continue
              metadata=value.get("$set",value)
              cid=cid or metadata.get("sessionId")
              subagent=subagent or metadata.get("kind")=="subagent"
              if value.get("type")=="user":
                found=text(value.get("content"))
                if found: title=found
        else:
          with open(file) as handle: value=json.load(handle)
          cid=value.get("sessionId"); subagent=value.get("kind")=="subagent"
          for message in value.get("messages",[]):
            if isinstance(message,dict) and message.get("type")=="user":
              found=text(message.get("content"))
              if found: title=found; break
        if not subagent: add(cid,title,os.path.getmtime(file))
      except Exception: pass
elif prov=="pi":
  session_root=os.environ.get("PI_CODING_AGENT_SESSION_DIR")
  if not session_root:
    agent_root=os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home,".pi","agent")
    session_root=os.path.join(agent_root,"sessions")
  stripped=cwd.lstrip("/\\")
  encoded="".join("-" if character in "/\\:" else character for character in stripped)
  directories=[session_root,os.path.join(session_root,"--"+encoded+"--")]
  directories.extend(itertools.islice(glob.iglob(os.path.join(session_root,"*")),200))
  seen=set(); candidates=0
  for directory in directories:
    if directory in seen or candidates>=200 or not os.path.isdir(directory): continue
    seen.add(directory)
    for file in itertools.islice(glob.iglob(os.path.join(directory,"*.jsonl")),200-candidates):
      candidates+=1
      try:
        with open(file,"rb") as handle: lines=handle.read(limit).decode("utf-8","replace").splitlines()
        if not lines: continue
        header=json.loads(lines[0])
        if header.get("type")!="session" or not same(header.get("cwd",""),cwd): continue
        title="Pi session"; name=None
        for line in lines[1:]:
          try: value=json.loads(line)
          except Exception: continue
          if value.get("type")=="session_info":
            candidate=clip(value.get("name",""))
            name=candidate or None
          if title=="Pi session" and value.get("type")=="message" and value.get("message",{}).get("role")=="user":
            found=text(value.get("message",{}).get("content"))
            if found: title=found
        add(header.get("id"),name or title,os.path.getmtime(file))
      except Exception: pass
elif prov=="grok":
  root=os.environ.get("GROK_HOME") or os.path.join(home,".grok")
  sessions_root=os.path.join(root,"sessions")
  preferred=os.path.join(sessions_root,urllib.parse.quote(cwd,safe=""))
  directories=[preferred]
  directories.extend(itertools.islice(glob.iglob(os.path.join(sessions_root,"*")),200))
  seen=set(); candidates=0
  for directory in directories:
    if directory in seen or candidates>=200 or not os.path.isdir(directory): continue
    seen.add(directory)
    for session_dir in itertools.islice(glob.iglob(os.path.join(directory,"*")),200-candidates):
      if not os.path.isdir(session_dir): continue
      candidates+=1; file=os.path.join(session_dir,"summary.json")
      try:
        if os.path.getsize(file)>limit: continue
        with open(file) as handle: value=json.load(handle)
        info=value.get("info",{})
        if not same(info.get("cwd",""),cwd): continue
        hidden=value.get("hidden")
        if hidden is True or hidden is None and str(value.get("session_kind","")).startswith("subagent"): continue
        cid=info.get("id")
        title=value.get("generated_title") or value.get("session_summary") or "Grok Build session"
        if exact_uuid(cid): add(cid,title,os.path.getmtime(file))
      except Exception: pass
elif prov=="opencode":
  try:
    shell=os.environ.get("SHELL") or "/bin/sh"
    with tempfile.TemporaryFile() as captured:
      process=subprocess.Popen([shell,"-lc","exec opencode session list --max-count 200 --format json"],cwd=cwd,stdout=captured,stderr=subprocess.DEVNULL)
      try: process.wait(timeout=5)
      except subprocess.TimeoutExpired:
        process.kill(); process.wait()
      captured.seek(0,os.SEEK_END); size=captured.tell()
      captured.seek(0); stdout=captured.read().decode() if size<=limit else ""
    if process.returncode==0 and stdout:
      for record in json.loads(stdout)[:200]:
        if not isinstance(record,dict) or not same(record.get("directory",""),cwd): continue
        updated=record.get("updated",0)
        add(record.get("id"),record.get("title") or "OpenCode session",updated/1000 if isinstance(updated,(int,float)) else 0)
  except Exception: pass
out.sort(key=lambda item:-item["mtime"]); unique=[]; ids=set()
for item in out:
  if item["id"] in ids: continue
  ids.add(item["id"]); unique.append(item)
  if len(unique)>=50: break
print(json.dumps(unique))
"##;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn remote_list_command(
    cwd: &str,
    provider: &str,
    credential_profile_directory: Option<&str>,
) -> Result<String, String> {
    ensure_conversation_credential_profile_supported(
        provider,
        credential_profile_directory.is_some(),
    )?;
    Ok(format!(
        "python3 -c {} {} {} {} 2>/dev/null || echo '[]'",
        shell_quote(REMOTE_LIST_SCRIPT),
        shell_quote(cwd),
        shell_quote(provider),
        shell_quote(credential_profile_directory.unwrap_or_default()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(id: &str, mtime: u64) -> Conversation {
        Conversation {
            id: id.into(),
            title: format!("title-{id}"),
            mtime,
        }
    }

    #[test]
    fn segment_merge_keeps_only_the_newest_copy_per_identity() {
        // 압축/resume가 만든 조각 3개(같은 신원) + 별개 대화 1개 + 신원 없는 1개.
        let merged = keep_newest_by_key(vec![
            (conversation("old", 100), Some("thread-a".into())),
            (conversation("new", 300), Some("thread-a".into())),
            (conversation("mid", 200), Some("thread-a".into())),
            (conversation("other", 150), Some("thread-b".into())),
            (conversation("anon", 50), None),
        ]);
        let ids: Vec<_> = merged.iter().map(|c| c.id.as_str()).collect();
        // 최신 조각만 남고, 신원 없는 항목은 병합 근거가 없어 남는다.
        assert_eq!(ids, ["new", "other", "anon"]);
    }

    #[test]
    fn claude_title_is_the_latest_user_line_and_identity_is_the_first() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("segment.jsonl");
        let lines = [
            // 도구 결과·명령 출력은 제목이 아니다 — 건너뛴 줄의 uuid를 신원으로
            // 잡으면 조각마다 달라져 병합이 깨진다.
            serde_json::json!({"type":"user","uuid":"skip-1","message":{"content":"<local-command>x</local-command>"}}),
            serde_json::json!({"type":"user","uuid":"first-real","message":{"content":"실제 첫 질문"}}),
            serde_json::json!({"type":"user","uuid":"later","message":{"content":"나중 질문"}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        fs::write(&path, lines).unwrap();
        let (title, identity) = claude_session_title::title_and_identity(&path);
        // 제목은 최근 발화("지금 무슨 이야기 중인가"), 신원은 조각 사이에
        // 변하지 않는 시작점(첫 발화 uuid)이다.
        assert_eq!(title, "나중 질문");
        assert_eq!(identity.as_deref(), Some("first-real"));
    }

    #[test]
    fn selected_claude_profile_is_the_conversation_history_authority() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let profile = temporary.path().join("claude-work");
        let projects = profile
            .join("projects")
            .join(encode_cwd(&cwd.to_string_lossy()));
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join("selected.jsonl"),
            serde_json::json!({
                "type": "user",
                "uuid": "selected-message",
                "message": {"content": "selected credential conversation"},
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            list(&cwd.to_string_lossy(), "claude", Some(&profile)).unwrap(),
            vec![Conversation {
                id: "selected".to_string(),
                title: "selected credential conversation".to_string(),
                mtime: path_mtime_secs(&projects.join("selected.jsonl")),
            }]
        );
    }

    #[test]
    fn conversation_home_rejects_missing_and_empty_values() {
        assert_eq!(
            parse_conversation_home(None).unwrap_err(),
            "conversation_home_unavailable"
        );
        assert_eq!(
            parse_conversation_home(Some(std::ffi::OsString::new())).unwrap_err(),
            "conversation_home_unavailable"
        );
        assert_eq!(
            parse_conversation_home(Some(std::ffi::OsString::from("/home/test"))).unwrap(),
            PathBuf::from("/home/test")
        );
    }

    #[test]
    fn selected_codex_profile_is_the_conversation_history_authority() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let profile = temporary.path().join("codex-work");
        let sessions = profile.join("sessions/2026/08/30");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join("rollout-selected.jsonl");
        fs::write(
            &rollout,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "selected", "cwd": cwd},
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "selected credential conversation",
                    },
                }),
            ]
            .map(|record| record.to_string())
            .join("\n"),
        )
        .unwrap();

        assert_eq!(
            list(&cwd.to_string_lossy(), "codex", Some(&profile)).unwrap(),
            vec![Conversation {
                id: "selected".to_string(),
                title: "selected credential conversation".to_string(),
                mtime: path_mtime_secs(&rollout),
            }]
        );
    }

    #[test]
    fn codex_provider_thread_name_overrides_rollout_prompt_title() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let profile = temporary.path().join("codex-work");
        let sessions = profile.join("sessions/2026/09/03");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join("rollout-thread.jsonl");
        fs::write(
            &rollout,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "thread-1", "cwd": cwd},
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "the original prompt is not the thread name",
                    },
                }),
            ]
            .map(|record| record.to_string())
            .join("\n"),
        )
        .unwrap();
        fs::write(
            profile.join("session_index.jsonl"),
            [
                serde_json::json!({
                    "id": "thread-1",
                    "thread_name": "First generated title",
                    "updated_at": "2026-09-03T14:01:34Z",
                }),
                serde_json::json!({
                    "id": "other-thread",
                    "thread_name": "Unrelated title",
                    "updated_at": "2026-09-03T14:02:00Z",
                }),
                serde_json::json!({
                    "id": "thread-1",
                    "thread_name": "clean code",
                    "updated_at": "2026-09-03T14:03:14Z",
                }),
            ]
            .map(|record| record.to_string())
            .join("\n"),
        )
        .unwrap();

        let conversations = list(&cwd.to_string_lossy(), "codex", Some(&profile)).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].id, "thread-1");
        assert_eq!(conversations[0].title, "clean code");
    }

    #[test]
    fn unsupported_provider_does_not_reinterpret_a_credential_profile() {
        assert_eq!(
            list("/workspace", "gemini", Some(Path::new("/profile"))).unwrap_err(),
            "conversation_credential_profile_unsupported: provider does not store conversations in a credential profile"
        );
        assert_eq!(
            remote_list_command("/workspace", "gemini", Some(".dure/accounts/gemini-work"))
                .unwrap_err(),
            "conversation_credential_profile_unsupported: provider does not store conversations in a credential profile"
        );
    }

    #[test]
    fn suffix_read_drops_the_partial_first_line_at_the_boundary() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("tail.jsonl");
        // 12바이트 창은 파일(31B)의 두 번째 줄 중간(offset 19)에서 시작한다.
        // 잘린 줄을 파싱하면 JSON 오류가 아니라 엉뚱한 제목이 나올 수 있다.
        fs::write(&path, "aaaaaaaaaaaaaaa\nbbbbbbbbbb\nccc\n").unwrap();
        let tail = read_bounded_text_suffix(&path, 12).unwrap();
        assert_eq!(tail, "ccc\n");
        // 파일 전체보다 큰 창이면 전부 그대로 온다.
        let whole = read_bounded_text_suffix(&path, 4096).unwrap();
        assert!(whole.starts_with("aaaaaaaaaaaaaaa"));
    }

    #[test]
fn codex_listing_skips_subagent_threads_and_merges_resumed_files() {
        // subagent 스레드는 부모 히스토리를 첫 메시지째 복사한 내부 산물이다.
        let temporary = tempfile::tempdir().unwrap();
        let write = |name: &str, meta: serde_json::Value| {
            let record = serde_json::json!({"type":"session_meta","payload":meta});
            let message = serde_json::json!({
                "type":"event_msg",
                "payload":{"type":"user_message","message":"hmux 세션 유지 요청"},
            });
            fs::write(
                temporary.path().join(name),
                format!("{record}\n{message}\n"),
            )
            .unwrap();
        };
        write(
            "user-thread.jsonl",
            serde_json::json!({"id":"thread-user","cwd":"/workspace","thread_source":"user"}),
        );
        write(
            "user-thread-resumed.jsonl",
            serde_json::json!({"id":"thread-user","cwd":"/workspace","thread_source":"user"}),
        );
        write(
            "subagent.jsonl",
            serde_json::json!({
                "id":"thread-sub","cwd":"/workspace","thread_source":"subagent",
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"thread-user"}}},
            }),
        );
        write(
            "legacy-subagent.jsonl",
            serde_json::json!({
                // thread_source 필드가 없던 옛 파일 — source 객체로 판별한다.
                "id":"thread-legacy-sub","cwd":"/workspace",
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"thread-user"}}},
            }),
        );
        let mut out = Vec::new();
        collect_codex(temporary.path(), "/workspace", &mut out);
        let merged = keep_newest_by_key(out);
        let ids: Vec<_> = merged.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["thread-user"]);
    }
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn codex_title_skips_injected_context_and_uses_the_first_user_request() {
        let content = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {"id": "conversation-1", "cwd": "/workspace"},
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
                },
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "<environment_context><cwd>/workspace</cwd></environment_context>"},
                        {"type": "output_text", "text": "must stay hidden"},
                    ],
                },
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "developer",
                    "content": [{"type": "input_text", "text": "developer text must stay hidden"}],
                },
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Resume conversation "},
                        {"type": "text", "text": "without replacing the live pane"},
                    ],
                },
            }),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");

        assert_eq!(
            latest_title_codex(&content).as_deref(),
            Some("Resume conversation without replacing the live pane")
        );
        // 주입 컨텍스트뿐이면 제목이 없다 — 호출부가 "codex 세션"으로 물러난다.
        assert_eq!(
            latest_title_codex(
                &serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "<environment_context><cwd>/workspace</cwd></environment_context>",
                    },
                })
                .to_string()
            ),
            None
        );
        // 발화가 여럿이면 마지막 것이 제목이다.
        let two = [
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"첫 질문"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"최근 질문"}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        assert_eq!(latest_title_codex(&two).as_deref(), Some("최근 질문"));
    }

    #[cfg(unix)]
    #[test]
    fn remote_codex_title_filter_matches_the_local_adapter() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let sessions = temporary.path().join(".codex/sessions/2026/07/30");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join("rollout-conversation-1.jsonl");
        fs::write(
            &rollout,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "conversation-1", "cwd": cwd},
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "# AGENTS.md instructions for /workspace"}],
                    },
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "developer",
                        "content": [{"type": "input_text", "text": "developer text must stay hidden"}],
                    },
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "Resume this exact "},
                            {"type": "text", "text": "conversation"},
                        ],
                    },
                }),
            ]
            .into_iter()
            .map(|record| record.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();

        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &remote_list_command(&cwd.to_string_lossy(), "codex", None).unwrap(),
            ])
            .env("HOME", temporary.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let conversations =
            serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].id, "conversation-1");
        assert_eq!(conversations[0].title, "Resume this exact conversation");
    }

    #[cfg(unix)]
    #[test]
    fn remote_codex_history_reads_only_the_selected_profile() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let write_rollout = |root: &Path, id: &str| {
            let sessions = root.join("sessions/2026/08/30");
            fs::create_dir_all(&sessions).unwrap();
            fs::write(
                sessions.join(format!("rollout-{id}.jsonl")),
                [
                    serde_json::json!({
                        "type": "session_meta",
                        "payload": {"id": id, "cwd": cwd},
                    }),
                    serde_json::json!({
                        "type": "event_msg",
                        "payload": {"type": "user_message", "message": id},
                    }),
                ]
                .map(|record| record.to_string())
                .join("\n"),
            )
            .unwrap();
        };
        write_rollout(&temporary.path().join(".codex"), "canonical");
        write_rollout(
            &temporary.path().join(".dure/accounts/codex-work"),
            "selected",
        );

        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &remote_list_command(
                    &cwd.to_string_lossy(),
                    "codex",
                    Some(".dure/accounts/codex-work"),
                )
                .unwrap(),
            ])
            .env("HOME", temporary.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap(),
            vec![Conversation {
                id: "selected".to_string(),
                title: "selected".to_string(),
                mtime: path_mtime_secs(&temporary.path().join(
                    ".dure/accounts/codex-work/sessions/2026/08/30/rollout-selected.jsonl"
                )),
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_claude_history_reads_only_the_selected_profile() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let write_session = |root: &Path, id: &str| {
            let projects = root
                .join("projects")
                .join(encode_cwd(&cwd.to_string_lossy()));
            fs::create_dir_all(&projects).unwrap();
            fs::write(
                projects.join(format!("{id}.jsonl")),
                serde_json::json!({
                    "type": "user",
                    "uuid": format!("{id}-message"),
                    "message": {"content": id},
                })
                .to_string(),
            )
            .unwrap();
        };
        write_session(&temporary.path().join(".claude"), "canonical");
        write_session(
            &temporary.path().join(".dure/accounts/claude-work"),
            "selected",
        );

        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &remote_list_command(
                    &cwd.to_string_lossy(),
                    "claude",
                    Some(".dure/accounts/claude-work"),
                )
                .unwrap(),
            ])
            .env("HOME", temporary.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let conversations =
            serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].id, "selected");
        assert_eq!(conversations[0].title, "selected");
    }

    #[test]
    fn gemini_records_are_scoped_bounded_and_fail_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let other = temporary.path().join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let gemini = temporary.path().join(".gemini");
        let project = gemini.join("tmp/workspace");
        let chats = project.join("chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(project.join(".project_root"), cwd.to_string_lossy().as_bytes()).unwrap();
        fs::write(
            chats.join("session-valid.jsonl"),
            concat!(
                "{\"sessionId\":\"gemini-session-1\",\"projectHash\":\"workspace\",\"kind\":\"main\"}\n",
                "{\"id\":\"message-1\",\"type\":\"user\",\"content\":[{\"text\":\"implement provider support\"}]}\n"
            ),
        )
        .unwrap();
        fs::write(
            chats.join("session-subagent.jsonl"),
            "{\"sessionId\":\"gemini-subagent\",\"kind\":\"subagent\"}\n",
        )
        .unwrap();
        fs::write(chats.join("session-malformed.jsonl"), "{not-json}\n").unwrap();
        let oversized_path = chats.join("session-oversized.jsonl");
        let oversized = fs::File::create(&oversized_path).unwrap();
        oversized.set_len(MAX_SESSION_FILE_BYTES + 1).unwrap();

        assert_eq!(
            list_gemini_from_root(&cwd, &gemini),
            vec![Conversation {
                id: "gemini-session-1".to_string(),
                title: "implement provider support".to_string(),
                mtime: fs::metadata(chats.join("session-valid.jsonl"))
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            }]
        );
        assert!(list_gemini_from_root(&other, &gemini).is_empty());
    }

    #[test]
    fn gemini_registry_slug_and_legacy_json_are_supported() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let gemini = temporary.path().join(".gemini");
        let chats = gemini.join("tmp/workspace-2/chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(
            gemini.join("projects.json"),
            serde_json::json!({
                "projects": {
                    (cwd.to_string_lossy().into_owned()): "workspace-2"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            chats.join("session-legacy.json"),
            serde_json::json!({
                "sessionId": "gemini-session-2",
                "projectHash": "workspace-2",
                "messages": [{
                    "id": "message-1",
                    "type": "user",
                    "content": "resume the exact session"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let conversations = list_gemini_from_root(&cwd, &gemini);
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].id, "gemini-session-2");
        assert_eq!(conversations[0].title, "resume the exact session");
    }

    #[test]
    fn pi_records_are_exactly_scoped_and_use_provider_native_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let other = temporary.path().join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let root = temporary.path().join("sessions");
        let project = root.join(pi_project_directory_name(&cwd));
        fs::create_dir_all(&project).unwrap();
        let valid = project.join("2026-07-30_pi-session-1.jsonl");
        fs::write(
            &valid,
            format!(
                "{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "session",
                    "version": 3,
                    "id": "pi-session-1",
                    "timestamp": "2026-07-30T00:00:00Z",
                    "cwd": cwd,
                }),
                serde_json::json!({
                    "type": "message",
                    "id": "message-1",
                    "parentId": null,
                    "timestamp": "2026-07-30T00:00:01Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "implement Pi support"}],
                        "timestamp": 1,
                    },
                }),
                serde_json::json!({
                    "type": "session_info",
                    "id": "info-1",
                    "parentId": "message-1",
                    "timestamp": "2026-07-30T00:00:02Z",
                    "name": "Pi named session",
                }),
            ),
        )
        .unwrap();
        fs::write(
            project.join("other.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session",
                    "id": "pi-other",
                    "timestamp": "2026-07-30T00:00:00Z",
                    "cwd": other,
                })
            ),
        )
        .unwrap();
        fs::write(project.join("malformed.jsonl"), "{not-json}\n").unwrap();

        assert_eq!(
            list_pi_from_root(&cwd, &root),
            vec![Conversation {
                id: "pi-session-1".to_string(),
                title: "Pi named session".to_string(),
                mtime: path_mtime_secs(&valid),
            }]
        );
    }

    #[test]
    fn pi_picker_keeps_large_sessions_within_a_bounded_prefix_read() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let root = temporary.path().join("sessions");
        let project = root.join(pi_project_directory_name(&cwd));
        fs::create_dir_all(&project).unwrap();
        let record = project.join("large.jsonl");
        let mut content = format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "pi-large-session",
                "timestamp": "2026-07-30T00:00:00Z",
                "cwd": cwd,
            }),
            serde_json::json!({
                "type": "message",
                "message": {"role": "user", "content": "large Pi session"},
            }),
        );
        content.push_str(&"x".repeat(MAX_SESSION_FILE_BYTES as usize));
        fs::write(&record, content).unwrap();

        assert!(fs::metadata(&record).unwrap().len() > MAX_SESSION_FILE_BYTES);
        assert_eq!(
            list_pi_from_root(&cwd, &root),
            vec![Conversation {
                id: "pi-large-session".to_string(),
                title: "large Pi session".to_string(),
                mtime: path_mtime_secs(&record),
            }]
        );
    }

    #[test]
    fn grok_summaries_are_exactly_scoped_and_hide_subagents() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let other = temporary.path().join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let root = temporary.path().join(".grok");
        let project = root
            .join("sessions")
            .join(url_encode_component(&cwd.to_string_lossy()));
        let valid = project.join("019c10d2-8d16-7cc0-a44e-55847c4eb786/summary.json");
        fs::create_dir_all(valid.parent().unwrap()).unwrap();
        fs::write(
            &valid,
            serde_json::json!({
                "info": {"id": "019c10d2-8d16-7cc0-a44e-55847c4eb786", "cwd": cwd},
                "session_summary": "fallback summary",
                "generated_title": "Grok named session",
                "session_kind": "fork",
            })
            .to_string(),
        )
        .unwrap();
        let hidden = project.join("grok-subagent/summary.json");
        fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        fs::write(
            hidden,
            serde_json::json!({
                "info": {"id": "grok-subagent", "cwd": cwd},
                "session_summary": "hidden",
                "session_kind": "subagent_fork",
            })
            .to_string(),
        )
        .unwrap();
        let prefix = project.join("grok-prefix/summary.json");
        fs::create_dir_all(prefix.parent().unwrap()).unwrap();
        fs::write(
            prefix,
            serde_json::json!({
                "info": {"id": "019c10d2", "cwd": cwd},
                "session_summary": "ambiguous prefix",
            })
            .to_string(),
        )
        .unwrap();
        let wrong = project.join("grok-other/summary.json");
        fs::create_dir_all(wrong.parent().unwrap()).unwrap();
        fs::write(
            wrong,
            serde_json::json!({
                "info": {"id": "grok-other", "cwd": other},
                "session_summary": "wrong workspace",
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            list_grok_from_root(&cwd, &root),
            vec![Conversation {
                id: "019c10d2-8d16-7cc0-a44e-55847c4eb786".to_string(),
                title: "Grok named session".to_string(),
                mtime: path_mtime_secs(&valid),
            }]
        );
    }

    #[test]
    fn opencode_json_is_filtered_to_the_exact_workspace() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let other = temporary.path().join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let output = serde_json::json!([
            {
                "id": "ses_current",
                "title": "Current workspace",
                "updated": 2000,
                "directory": cwd,
            },
            {
                "id": "ses_other",
                "title": "Other workspace",
                "updated": 3000,
                "directory": other,
            },
            {
                "id": "unsafe session id",
                "title": "Unsafe",
                "updated": 4000,
                "directory": cwd,
            }
        ]);

        assert_eq!(
            parse_opencode_sessions(&cwd, output.to_string().as_bytes()),
            vec![Conversation {
                id: "ses_current".to_string(),
                title: "Current workspace".to_string(),
                mtime: 2,
            }]
        );
        assert!(parse_opencode_sessions(&cwd, b"not-json").is_empty());
        assert!(!same_path(Path::new(""), &cwd));
    }

    #[test]
    fn unknown_provider_never_falls_back_to_claude_records() {
        assert!(list("/tmp", "unknown-provider", None).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn remote_gemini_adapter_handles_quoted_workspace_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("work'space");
        fs::create_dir_all(&cwd).unwrap();
        let project = temporary.path().join(".gemini/tmp/workspace");
        let chats = project.join("chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(project.join(".project_root"), cwd.to_string_lossy().as_bytes()).unwrap();
        fs::write(
            chats.join("session-remote.jsonl"),
            concat!(
                "{\"sessionId\":\"gemini-remote\",\"kind\":\"main\"}\n",
                "{\"type\":\"user\",\"content\":\"remote resume\"}\n"
            ),
        )
        .unwrap();

        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &remote_list_command(&cwd.to_string_lossy(), "gemini", None).unwrap(),
            ])
            .env("HOME", temporary.path())
            .env_remove("GEMINI_CLI_HOME")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap(),
            vec![Conversation {
                id: "gemini-remote".to_string(),
                title: "remote resume".to_string(),
                mtime: fs::metadata(chats.join("session-remote.jsonl"))
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_pi_and_grok_adapters_handle_quoted_workspace_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("work'space");
        fs::create_dir_all(&cwd).unwrap();

        let pi_file = temporary
            .path()
            .join(".pi/agent/sessions")
            .join(pi_project_directory_name(&cwd))
            .join("pi-remote.jsonl");
        fs::create_dir_all(pi_file.parent().unwrap()).unwrap();
        let mut pi_content = format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "session",
                "id": "pi-remote",
                "timestamp": "2026-07-30T00:00:00Z",
                "cwd": cwd,
            }),
            serde_json::json!({
                "type": "message",
                "message": {"role": "user", "content": "remote Pi resume"},
            }),
        );
        pi_content.push_str(&"x".repeat(MAX_SESSION_FILE_BYTES as usize));
        fs::write(&pi_file, pi_content).unwrap();

        let grok_summary = temporary
            .path()
            .join(".grok/sessions")
            .join(url_encode_component(&cwd.to_string_lossy()))
            .join("019c10d2-8d16-7cc0-a44e-55847c4eb787/summary.json");
        fs::create_dir_all(grok_summary.parent().unwrap()).unwrap();
        fs::write(
            &grok_summary,
            serde_json::json!({
                "info": {"id": "019c10d2-8d16-7cc0-a44e-55847c4eb787", "cwd": cwd},
                "session_summary": "remote Grok resume",
            })
            .to_string(),
        )
        .unwrap();

        for (provider, expected) in [
            (
                "pi",
                Conversation {
                    id: "pi-remote".to_string(),
                    title: "remote Pi resume".to_string(),
                    mtime: path_mtime_secs(&pi_file),
                },
            ),
            (
                "grok",
                Conversation {
                    id: "019c10d2-8d16-7cc0-a44e-55847c4eb787".to_string(),
                    title: "remote Grok resume".to_string(),
                    mtime: path_mtime_secs(&grok_summary),
                },
            ),
        ] {
            let output = std::process::Command::new("/bin/sh")
                .args([
                    "-c",
                    &remote_list_command(&cwd.to_string_lossy(), provider, None).unwrap(),
                ])
                .env("HOME", temporary.path())
                .env_remove("PI_CODING_AGENT_DIR")
                .env_remove("PI_CODING_AGENT_SESSION_DIR")
                .env_remove("GROK_HOME")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap(),
                vec![expected],
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn remote_opencode_adapter_consumes_only_structured_cli_output() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().join("workspace");
        let bin = temporary.path().join("bin");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let executable = bin.join("opencode");
        fs::write(
            &executable,
            concat!(
                "#!/bin/sh\n",
                "printf '[{\"id\":\"ses_remote\",\"title\":\"Remote OpenCode\",\"updated\":5000,\"directory\":\"%s\"}]\\n' \"$PWD\"\n"
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let path = format!("{}:/usr/bin:/bin", bin.display());

        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &remote_list_command(&cwd.to_string_lossy(), "opencode", None).unwrap(),
            ])
            .env("HOME", temporary.path())
            .env("PATH", path)
            .env("SHELL", "/bin/sh")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Vec<Conversation>>(&output.stdout).unwrap(),
            vec![Conversation {
                id: "ses_remote".to_string(),
                title: "Remote OpenCode".to_string(),
                mtime: 5,
            }]
        );
    }
}
