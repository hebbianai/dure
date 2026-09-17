//! Durable, non-secret attribution between an app-owned provider launch and a
//! provider-native conversation. Hmux intentionally does not carry credential
//! identity; this adapter journal lets usage accounting retain that fact
//! without putting account concerns into the runtime protocol.

mod managed_create_advance;
pub(crate) use managed_create_advance::{
    finish_advanced_managed_launch, finish_current_managed_launch,
    managed_create_advance_credential_intent, ManagedCreateAdvanceCredentialIntent,
    PreparedCredentialLaunch,
};

use fs2::FileExt;
use hmux_client::{
    ManagedRehostReceipt, ProviderConversationIdentityDescriptor, SessionClass, SessionDescriptor,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u16 = 1;
const JOURNAL_DIRECTORY: &str = "credential-session-bindings";
const JOURNAL_FILE: &str = "v1.journal.jsonl";
const LOCK_FILE: &str = "v1.lock";
const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;

fn typed_error(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-".contains(character))
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if valid_id(value) {
        Ok(())
    } else {
        Err(typed_error(
            "credential_binding_invalid_identity",
            format!("{label} is invalid"),
        ))
    }
}

fn default_root() -> Result<PathBuf, String> {
    crate::app_channel::current()
        .map(|channel| channel.control_dir)
        .map_err(|error| typed_error("credential_binding_storage_unavailable", error))
}

fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(typed_error(
                    "credential_binding_storage_untrusted",
                    format!(
                        "{} must be a real directory owned by the current user",
                        path.display()
                    ),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(typed_error(
                        "credential_binding_io",
                        format!("create {}: {error}", path.display()),
                    ));
                }
            }
            let metadata = std::fs::symlink_metadata(path).map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("reinspect {}: {error}", path.display()),
                )
            })?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(typed_error(
                    "credential_binding_storage_untrusted",
                    format!(
                        "{} must be a real directory owned by the current user",
                        path.display()
                    ),
                ));
            }
        }
        Err(error) => {
            return Err(typed_error(
                "credential_binding_io",
                format!("inspect {}: {error}", path.display()),
            ));
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        typed_error(
            "credential_binding_io",
            format!("secure {}: {error}", path.display()),
        )
    })
}

fn journal_directory(root: &Path) -> Result<PathBuf, String> {
    if !root.exists() {
        let parent = root.parent().ok_or_else(|| {
            typed_error(
                "credential_binding_io",
                "credential binding root has no parent",
            )
        })?;
        if !parent.is_dir() {
            return Err(typed_error(
                "credential_binding_io",
                "credential binding root parent is unavailable",
            ));
        }
    }
    ensure_owned_directory(root)?;
    let directory = root.join(JOURNAL_DIRECTORY);
    ensure_owned_directory(&directory)?;
    File::open(root)
        .and_then(|root| root.sync_all())
        .map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("sync {}: {error}", root.display()),
            )
        })?;
    Ok(directory)
}

fn open_owned_file(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("open {}: {error}", path.display()),
            )
        })?;
    let metadata = file.metadata().map_err(|error| {
        typed_error(
            "credential_binding_io",
            format!("inspect {}: {error}", path.display()),
        )
    })?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err(typed_error(
            "credential_binding_storage_untrusted",
            format!(
                "{} must be a singly linked regular file owned by the current user",
                path.display()
            ),
        ));
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("secure {}: {error}", path.display()),
            )
        })?;
    Ok(file)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EventKind {
    LaunchPrepared,
    LaunchCommitted,
    LaunchUnattributed,
    LaunchNotAdmitted,
    ConversationBound,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEvent {
    schema_version: u16,
    seq: u64,
    at_ms: u64,
    event: EventKind,
    launch_id: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    credential_id: Option<String>,
    conversation_id: Option<String>,
    effective_at_ms: u64,
    /// Direct creates record whether their target generation already existed
    /// before the durable prepare. Reusing such a generation is deliberately
    /// left unattributed; a launch journal written after that Host started is
    /// not evidence of which credential actually created it.
    #[serde(default)]
    preexisting_runtime: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runner_principal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runner_instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_epoch: Option<String>,
}

#[derive(Clone, Copy)]
struct RuntimeGeneration<'a> {
    runner_principal: &'a str,
    runner_instance: &'a str,
    channel_epoch: &'a str,
    host_instance_id: &'a str,
    terminal_epoch: &'a str,
}

impl<'a> From<&'a SessionDescriptor> for RuntimeGeneration<'a> {
    fn from(descriptor: &'a SessionDescriptor) -> Self {
        Self {
            runner_principal: &descriptor.runner_principal,
            runner_instance: &descriptor.runner_instance,
            channel_epoch: &descriptor.channel_epoch,
            host_instance_id: &descriptor.host_instance_id,
            terminal_epoch: &descriptor.terminal_epoch,
        }
    }
}

fn generation_matches(event: &JournalEvent, generation: RuntimeGeneration<'_>) -> bool {
    event.runner_principal.as_deref() == Some(generation.runner_principal)
        && event.runner_instance.as_deref() == Some(generation.runner_instance)
        && event.channel_epoch.as_deref() == Some(generation.channel_epoch)
        && event.host_instance_id.as_deref() == Some(generation.host_instance_id)
        && event.terminal_epoch.as_deref() == Some(generation.terminal_epoch)
}

fn same_recorded_generation(left: &JournalEvent, right: &JournalEvent) -> bool {
    left.runner_principal == right.runner_principal
        && left.runner_instance == right.runner_instance
        && left.channel_epoch == right.channel_epoch
        && left.host_instance_id == right.host_instance_id
        && left.terminal_epoch == right.terminal_epoch
}

fn has_complete_generation(event: &JournalEvent) -> bool {
    [
        event.runner_principal.as_deref(),
        event.runner_instance.as_deref(),
        event.channel_epoch.as_deref(),
        event.host_instance_id.as_deref(),
        event.terminal_epoch.as_deref(),
    ]
    .into_iter()
    .all(|value| {
        value.is_some_and(|value| {
            !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
        })
    })
}

fn has_no_generation(event: &JournalEvent) -> bool {
    event.runner_principal.is_none()
        && event.runner_instance.is_none()
        && event.channel_epoch.is_none()
        && event.host_instance_id.is_none()
        && event.terminal_epoch.is_none()
}

fn apply_generation(event: &mut JournalEvent, generation: RuntimeGeneration<'_>) {
    event.runner_principal = Some(generation.runner_principal.to_string());
    event.runner_instance = Some(generation.runner_instance.to_string());
    event.channel_epoch = Some(generation.channel_epoch.to_string());
    event.host_instance_id = Some(generation.host_instance_id.to_string());
    event.terminal_epoch = Some(generation.terminal_epoch.to_string());
}

fn validate_generation(generation: RuntimeGeneration<'_>) -> Result<(), String> {
    if [
        generation.runner_principal,
        generation.runner_instance,
        generation.channel_epoch,
        generation.host_instance_id,
        generation.terminal_epoch,
    ]
    .into_iter()
    .any(|value| value.is_empty() || value.len() > 512 || value.chars().any(char::is_control))
    {
        return Err(typed_error(
            "credential_binding_invalid_identity",
            "Host generation is invalid",
        ));
    }
    Ok(())
}

struct LockedJournal {
    _lock: File,
    file: File,
    events: Vec<JournalEvent>,
    next_seq: u64,
}

fn same_launch_payload(
    prepared: &JournalEvent,
    event: &JournalEvent,
    compare_conversation: bool,
) -> bool {
    prepared.launch_id == event.launch_id
        && prepared.session_id == event.session_id
        && prepared.workspace_id == event.workspace_id
        && prepared.provider_id == event.provider_id
        && prepared.credential_id == event.credential_id
        && (!compare_conversation || prepared.conversation_id == event.conversation_id)
        && prepared.effective_at_ms == event.effective_at_ms
        && prepared.preexisting_runtime == event.preexisting_runtime
}

fn validate_events(events: &[JournalEvent]) -> Result<(), String> {
    let invalid = |line: usize, detail: &str| {
        typed_error(
            "credential_binding_journal_invalid",
            format!("credential binding journal line {line} {detail}"),
        )
    };
    let mut prepared = HashMap::<&str, &JournalEvent>::new();
    let mut committed = HashMap::<&str, &JournalEvent>::new();
    let mut unattributed = HashSet::<&str>::new();
    let mut not_admitted = HashSet::<&str>::new();
    let mut bound = HashSet::<&str>::new();
    let mut claimed_sessions = HashSet::<(&str, &str, &str)>::new();

    for (index, event) in events.iter().enumerate() {
        let line = index + 1;
        if event.seq != index as u64 {
            return Err(invalid(line, "has a non-contiguous sequence"));
        }
        for (label, value) in [
            ("launch id", event.launch_id.as_str()),
            ("session id", event.session_id.as_str()),
            ("workspace id", event.workspace_id.as_str()),
            ("provider id", event.provider_id.as_str()),
        ] {
            if !valid_id(value) {
                return Err(invalid(line, &format!("has an invalid {label}")));
            }
        }
        if event
            .credential_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
            || event
                .conversation_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
        {
            return Err(invalid(line, "has an invalid optional identity"));
        }

        match event.event {
            EventKind::LaunchPrepared => {
                let session = (
                    event.session_id.as_str(),
                    event.workspace_id.as_str(),
                    event.provider_id.as_str(),
                );
                if !has_no_generation(event)
                    || prepared.insert(&event.launch_id, event).is_some()
                    || !claimed_sessions.insert(session)
                {
                    return Err(invalid(line, "duplicates a prepared launch"));
                }
            }
            EventKind::LaunchCommitted => {
                let Some(source) = prepared.get(event.launch_id.as_str()) else {
                    return Err(invalid(line, "has no preceding prepared launch"));
                };
                if !same_launch_payload(source, event, true)
                    || !has_complete_generation(event)
                    || committed.insert(&event.launch_id, event).is_some()
                    || unattributed.contains(event.launch_id.as_str())
                    || not_admitted.contains(event.launch_id.as_str())
                {
                    return Err(invalid(line, "has conflicting terminal outcomes"));
                }
            }
            EventKind::LaunchUnattributed => {
                let Some(source) = prepared.get(event.launch_id.as_str()) else {
                    return Err(invalid(line, "has no preceding prepared launch"));
                };
                if !same_launch_payload(source, event, true)
                    || !has_no_generation(event)
                    || !unattributed.insert(&event.launch_id)
                    || committed.contains_key(event.launch_id.as_str())
                    || not_admitted.contains(event.launch_id.as_str())
                {
                    return Err(invalid(line, "has conflicting terminal outcomes"));
                }
            }
            EventKind::LaunchNotAdmitted => {
                let Some(source) = prepared.get(event.launch_id.as_str()) else {
                    return Err(invalid(line, "has no preceding prepared launch"));
                };
                if !same_launch_payload(source, event, true)
                    || !has_no_generation(event)
                    || !not_admitted.insert(&event.launch_id)
                    || committed.contains_key(event.launch_id.as_str())
                    || unattributed.contains(event.launch_id.as_str())
                {
                    return Err(invalid(line, "has conflicting terminal outcomes"));
                }
            }
            EventKind::ConversationBound => {
                let Some(source) = prepared.get(event.launch_id.as_str()) else {
                    return Err(invalid(line, "has no preceding prepared launch"));
                };
                let Some(committed) = committed.get(event.launch_id.as_str()) else {
                    return Err(invalid(line, "has no committed launch generation"));
                };
                if !same_recorded_generation(committed, event)
                    || unattributed.contains(event.launch_id.as_str())
                    || source.conversation_id.is_some()
                    || event.conversation_id.is_none()
                    || !same_launch_payload(source, event, false)
                    || !bound.insert(&event.launch_id)
                {
                    return Err(invalid(line, "has an invalid conversation binding"));
                }
            }
        }
    }
    Ok(())
}

impl LockedJournal {
    fn open(root: &Path) -> Result<Self, String> {
        let directory = journal_directory(root)?;
        let lock = open_owned_file(&directory.join(LOCK_FILE))?;
        lock.lock_exclusive().map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("lock credential binding journal: {error}"),
            )
        })?;
        let mut file = open_owned_file(&directory.join(JOURNAL_FILE))?;
        File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("sync credential binding directory: {error}"),
                )
            })?;
        if file
            .metadata()
            .map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("inspect credential binding journal: {error}"),
                )
            })?
            .len()
            > MAX_JOURNAL_BYTES
        {
            return Err(typed_error(
                "credential_binding_journal_too_large",
                "credential binding journal requires explicit compaction",
            ));
        }
        let mut bytes = Vec::new();
        file.seek(SeekFrom::Start(0))
            .and_then(|_| {
                Read::by_ref(&mut file)
                    .take(MAX_JOURNAL_BYTES + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("read credential binding journal: {error}"),
                )
            })?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(typed_error(
                "credential_binding_journal_too_large",
                "credential binding journal requires explicit compaction",
            ));
        }

        let complete_len = if bytes.is_empty() || bytes.ends_with(b"\n") {
            bytes.len()
        } else {
            bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |position| position + 1)
        };
        if complete_len != bytes.len() {
            file.set_len(complete_len as u64).map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("repair credential binding journal tail: {error}"),
                )
            })?;
            file.sync_all().map_err(|error| {
                typed_error(
                    "credential_binding_io",
                    format!("sync repaired credential binding journal: {error}"),
                )
            })?;
        }
        let contents = std::str::from_utf8(&bytes[..complete_len]).map_err(|_| {
            typed_error(
                "credential_binding_journal_invalid",
                "credential binding journal is not UTF-8",
            )
        })?;
        let mut events = Vec::new();
        for (index, line) in contents.lines().enumerate() {
            let event = serde_json::from_str::<JournalEvent>(line).map_err(|_| {
                typed_error(
                    "credential_binding_journal_invalid",
                    format!("credential binding journal line {} is malformed", index + 1),
                )
            })?;
            if event.schema_version != SCHEMA_VERSION {
                return Err(typed_error(
                    "credential_binding_journal_invalid",
                    format!(
                        "credential binding journal line {} uses an unsupported schema",
                        index + 1
                    ),
                ));
            }
            events.push(event);
        }
        validate_events(&events)?;
        let next_seq = events
            .iter()
            .map(|event| event.seq)
            .max()
            .map_or(0, |seq| seq.saturating_add(1));
        file.seek(SeekFrom::End(0)).map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("seek credential binding journal: {error}"),
            )
        })?;
        Ok(Self {
            _lock: lock,
            file,
            events,
            next_seq,
        })
    }

    fn append(&mut self, mut event: JournalEvent) -> Result<(), String> {
        event.seq = self.next_seq;
        event.at_ms = now_ms();
        let mut encoded = serde_json::to_vec(&event).map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("encode credential binding event: {error}"),
            )
        })?;
        encoded.push(b'\n');
        let current_len = self.file.metadata().map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("inspect credential binding journal before append: {error}"),
            )
        })?;
        if current_len.len().saturating_add(encoded.len() as u64) > MAX_JOURNAL_BYTES {
            return Err(typed_error(
                "credential_binding_journal_too_large",
                "credential binding journal requires explicit compaction",
            ));
        }
        self.file.write_all(&encoded).map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("append credential binding event: {error}"),
            )
        })?;
        self.file.sync_all().map_err(|error| {
            typed_error(
                "credential_binding_io",
                format!("sync credential binding event: {error}"),
            )
        })?;
        self.next_seq = self.next_seq.saturating_add(1);
        self.events.push(event);
        Ok(())
    }
}

pub(crate) struct ManagedCredentialLaunch<'a> {
    pub launch_id: &'a str,
    pub session_id: &'a str,
    pub workspace_id: &'a str,
    pub provider_id: &'a str,
    pub credential_id: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
    pub preexisting_runtime: bool,
}

fn validate_launch(input: &ManagedCredentialLaunch<'_>) -> Result<(), String> {
    validate_id("launch id", input.launch_id)?;
    validate_id("session id", input.session_id)?;
    validate_id("workspace id", input.workspace_id)?;
    validate_id("provider id", input.provider_id)?;
    if let Some(credential_id) = input.credential_id {
        validate_id("credential id", credential_id)?;
    }
    if let Some(conversation_id) = input.conversation_id {
        validate_id("conversation id", conversation_id)?;
    }
    Ok(())
}

fn prepared_events(events: &[JournalEvent]) -> impl Iterator<Item = &JournalEvent> {
    events
        .iter()
        .filter(|event| event.event == EventKind::LaunchPrepared)
}

/// 준비된 기록과 재시도의 대화 id 가 같은 launch 를 가리키는가.
///
/// 대화를 **아직 모른 채** 준비된 launch 만 느슨하다. 그 경우 나중에 관측된
/// 값이 실려 와도 같은 launch 로 본다 — 준비 기록은 그대로 `None` 으로 남고
/// (`prepare_at` 은 일찍 반환하며 이 힌트를 저장하지 않는다), 대화는 원래
/// 설계대로 `observe_at` 이 `ConversationBound` 로 적는다.
///
/// 반대로 준비 때 이미 대화를 알고 있었으면 엄격하다. 그 값은 참고가 아니라
/// 귀속의 유일한 근거이기 때문이다: `bindings_at` 은 준비 기록의
/// `conversation_id` 를 먼저 읽고 없을 때만 `ConversationBound` 로 내려가며,
/// `validate_events` 는 준비 기록에 대화가 있으면 `ConversationBound` 자체를
/// 거부한다. 그래서 힌트를 잃은 재시도(`Some` → `None`)도 통과시키지 않는다 —
/// 통과시키면 provider 가 다른 대화로 시작해도 저널은 준비 때의 대화를
/// 커밋해 버리고, 그 귀속은 나중에 정정할 방법이 없다.
///
/// 채워 넣기를 거부하던 것이 실제 사고였다(2026-07-31). managed agent 의
/// create 는 `agent.id` 를 launch id 로 고정해 쓰는데(store.ts
/// `createIdempotencyKey`), 대화를 아직 모르는 상태로 준비된 launch 에
/// 나중에 관측된 대화 id 가 다음 ensure 에 실려 오면 같은 launch id 에 다른
/// 입력이 되어 `credential_binding_idempotency_conflict` 가 났다. 저널은
/// 영구 기록이라 재시도마다 같은 충돌이 재생산됐고, 포커스로 pane 이 다시
/// ensure 될 때마다 attach 가 실패해 "끊겼는데 스스로 복구되지 않는다"가 됐다.
fn conversation_matches(recorded: Option<&str>, input: Option<&str>) -> bool {
    match (recorded, input) {
        (None, _) => true,
        (Some(recorded), Some(input)) => recorded == input,
        (Some(_), None) => false,
    }
}

fn launch_matches(event: &JournalEvent, input: &ManagedCredentialLaunch<'_>) -> bool {
    event.launch_id == input.launch_id
        && event.session_id == input.session_id
        && event.workspace_id == input.workspace_id
        && event.provider_id == input.provider_id
        && event.credential_id.as_deref() == input.credential_id
        && conversation_matches(event.conversation_id.as_deref(), input.conversation_id)
}

fn prepare_at(
    root: &Path,
    input: ManagedCredentialLaunch<'_>,
) -> Result<PreparedCredentialLaunch, String> {
    validate_launch(&input)?;
    let mut journal = LockedJournal::open(root)?;
    if let Some(existing) =
        prepared_events(&journal.events).find(|event| event.launch_id == input.launch_id)
    {
        if !launch_matches(existing, &input) {
            return Err(typed_error(
                "credential_binding_idempotency_conflict",
                "launch id was already prepared with different inputs",
            ));
        }
        return Ok(PreparedCredentialLaunch::from_input(&input));
    }
    if prepared_events(&journal.events).any(|event| {
        event.session_id == input.session_id
            && event.workspace_id == input.workspace_id
            && event.provider_id == input.provider_id
    }) {
        return Err(typed_error(
            "credential_binding_session_conflict",
            "runtime session was already prepared by a different launch",
        ));
    }
    let effective_at_ms = now_ms();
    journal.append(JournalEvent {
        schema_version: SCHEMA_VERSION,
        seq: 0,
        at_ms: 0,
        event: EventKind::LaunchPrepared,
        launch_id: input.launch_id.to_string(),
        session_id: input.session_id.to_string(),
        workspace_id: input.workspace_id.to_string(),
        provider_id: input.provider_id.to_string(),
        credential_id: input.credential_id.map(str::to_string),
        conversation_id: input.conversation_id.map(str::to_string),
        effective_at_ms,
        preexisting_runtime: input.preexisting_runtime,
        runner_principal: None,
        runner_instance: None,
        channel_epoch: None,
        host_instance_id: None,
        terminal_epoch: None,
    })?;
    Ok(PreparedCredentialLaunch::from_input(&input))
}

fn finish_at(
    root: &Path,
    launch_id: &str,
    created: bool,
    generation: RuntimeGeneration<'_>,
) -> Result<(), String> {
    validate_id("launch id", launch_id)?;
    validate_generation(generation)?;
    let mut journal = LockedJournal::open(root)?;
    if let Some(committed) = journal
        .events
        .iter()
        .find(|event| event.event == EventKind::LaunchCommitted && event.launch_id == launch_id)
    {
        return if generation_matches(committed, generation) {
            Ok(())
        } else {
            Err(typed_error(
                "credential_binding_generation_conflict",
                "committed launch belongs to a different Host generation",
            ))
        };
    }
    if journal
        .events
        .iter()
        .any(|event| event.event == EventKind::LaunchUnattributed && event.launch_id == launch_id)
    {
        return if created {
            Err(typed_error(
                "credential_binding_launch_unattributed",
                "a pre-existing runtime has no durable credential evidence",
            ))
        } else {
            Ok(())
        };
    }
    if journal
        .events
        .iter()
        .any(|event| event.event == EventKind::LaunchNotAdmitted && event.launch_id == launch_id)
    {
        return Err(typed_error(
            "credential_binding_launch_not_admitted",
            "a non-admitted launch cannot claim a runtime generation",
        ));
    }
    let prepared = prepared_events(&journal.events)
        .find(|event| event.launch_id == launch_id)
        .cloned()
        .ok_or_else(|| {
            typed_error(
                "credential_binding_prepare_missing",
                "launch finish has no durable prepared input",
            )
        })?;
    let mut event = if created || !prepared.preexisting_runtime {
        JournalEvent {
            event: EventKind::LaunchCommitted,
            ..prepared
        }
    } else {
        JournalEvent {
            event: EventKind::LaunchUnattributed,
            ..prepared
        }
    };
    if event.event == EventKind::LaunchCommitted {
        apply_generation(&mut event, generation);
    }
    journal.append(event)
}

#[cfg(test)]
fn close_not_admitted_at(root: &Path, launch_id: &str) -> Result<(), String> {
    validate_id("launch id", launch_id)?;
    let mut journal = LockedJournal::open(root)?;
    if journal.events.iter().any(|event| {
        event.launch_id == launch_id
            && matches!(
                event.event,
                EventKind::LaunchCommitted
                    | EventKind::LaunchUnattributed
                    | EventKind::LaunchNotAdmitted
            )
    }) {
        return Ok(());
    }
    let prepared = prepared_events(&journal.events)
        .find(|event| event.launch_id == launch_id)
        .cloned()
        .ok_or_else(|| {
            typed_error(
                "credential_binding_prepare_missing",
                "launch close has no durable prepared input",
            )
        })?;
    journal.append(JournalEvent {
        event: EventKind::LaunchNotAdmitted,
        ..prepared
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CredentialBindingObservationOutcome {
    Bound,
    AlreadyBound,
    LaunchNotRecorded,
}

fn observe_at(
    root: &Path,
    session_id: &str,
    workspace_id: &str,
    provider_id: &str,
    conversation_id: &str,
    generation: RuntimeGeneration<'_>,
) -> Result<CredentialBindingObservationOutcome, String> {
    validate_id("session id", session_id)?;
    validate_id("workspace id", workspace_id)?;
    validate_id("provider id", provider_id)?;
    validate_id("conversation id", conversation_id)?;
    validate_generation(generation)?;
    let mut journal = LockedJournal::open(root)?;
    let matches = journal
        .events
        .iter()
        .filter(|event| {
            event.event == EventKind::LaunchCommitted
                && event.session_id == session_id
                && event.workspace_id == workspace_id
                && event.provider_id == provider_id
                && generation_matches(event, generation)
        })
        .filter_map(|committed| {
            prepared_events(&journal.events)
                .find(|prepared| prepared.launch_id == committed.launch_id)
                .map(|prepared| (prepared.clone(), committed.clone()))
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Ok(CredentialBindingObservationOutcome::LaunchNotRecorded);
    }
    if matches.len() != 1 {
        return Err(typed_error(
            "credential_binding_session_conflict",
            "multiple committed launches claim one runtime session",
        ));
    }
    let (prepared, committed) = &matches[0];
    let previously_bound = journal.events.iter().find(|event| {
        event.event == EventKind::ConversationBound && event.launch_id == prepared.launch_id
    });
    let expected = prepared
        .conversation_id
        .as_deref()
        .or_else(|| previously_bound.and_then(|event| event.conversation_id.as_deref()));
    if let Some(expected) = expected {
        if expected != conversation_id {
            return Err(typed_error(
                "credential_binding_conversation_conflict",
                "runtime session reported a different conversation",
            ));
        }
        return Ok(CredentialBindingObservationOutcome::AlreadyBound);
    }
    let mut binding = JournalEvent {
        event: EventKind::ConversationBound,
        conversation_id: Some(conversation_id.to_string()),
        ..prepared.clone()
    };
    binding
        .runner_principal
        .clone_from(&committed.runner_principal);
    binding
        .runner_instance
        .clone_from(&committed.runner_instance);
    binding.channel_epoch.clone_from(&committed.channel_epoch);
    binding
        .host_instance_id
        .clone_from(&committed.host_instance_id);
    binding.terminal_epoch.clone_from(&committed.terminal_epoch);
    journal.append(binding)?;
    Ok(CredentialBindingObservationOutcome::Bound)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialConversationBinding {
    pub schema_version: u16,
    pub launch_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: String,
    pub credential_id: Option<String>,
    pub conversation_id: String,
    pub effective_at_ms: u64,
    pub effective_sequence: u64,
}

fn bindings_at(
    root: &Path,
    provider_id: &str,
) -> Result<Vec<CredentialConversationBinding>, String> {
    validate_id("provider id", provider_id)?;
    let journal = LockedJournal::open(root)?;
    let observed = journal
        .events
        .iter()
        .filter(|event| event.event == EventKind::ConversationBound)
        .filter_map(|event| {
            event
                .conversation_id
                .as_ref()
                .map(|conversation| (event.launch_id.as_str(), conversation.as_str()))
        })
        .collect::<HashMap<_, _>>();
    let prepared_by_launch = prepared_events(&journal.events)
        .map(|event| (event.launch_id.as_str(), event))
        .collect::<HashMap<_, _>>();
    let mut bindings = journal
        .events
        .iter()
        .filter(|event| {
            event.event == EventKind::LaunchCommitted && event.provider_id == provider_id
        })
        .filter_map(|committed| {
            let prepared = prepared_by_launch.get(committed.launch_id.as_str())?;
            prepared
                .conversation_id
                .as_deref()
                .or_else(|| observed.get(prepared.launch_id.as_str()).copied())
                .map(|conversation_id| CredentialConversationBinding {
                    schema_version: SCHEMA_VERSION,
                    launch_id: prepared.launch_id.clone(),
                    session_id: prepared.session_id.clone(),
                    workspace_id: prepared.workspace_id.clone(),
                    provider_id: prepared.provider_id.clone(),
                    credential_id: prepared.credential_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    effective_at_ms: prepared.effective_at_ms,
                    effective_sequence: committed.seq,
                })
        })
        .collect::<Vec<_>>();
    bindings.sort_by_key(|binding| binding.effective_sequence);
    Ok(bindings)
}

pub(crate) fn prepare_managed_launch(
    input: ManagedCredentialLaunch<'_>,
) -> Result<Option<PreparedCredentialLaunch>, String> {
    if !provider_tracks_credential_conversations(input.provider_id) {
        return Ok(None);
    }
    prepare_at(&default_root()?, input).map(Some)
}

pub(crate) fn provider_tracks_credential_conversations(provider_id: &str) -> bool {
    matches!(provider_id, "claude" | "codex")
}

pub(crate) fn finish_direct_managed_launch(
    prepared: Option<&PreparedCredentialLaunch>,
    created: bool,
    descriptor: &SessionDescriptor,
) -> Result<(), String> {
    let Some(prepared) = prepared else {
        return Ok(());
    };
    finish_direct_at(&default_root()?, prepared, created, descriptor.into())
}

pub(crate) fn record_managed_rehost(receipt: &ManagedRehostReceipt) -> Result<(), String> {
    record_managed_rehost_at(&default_root()?, receipt)
}

fn record_managed_rehost_at(root: &Path, receipt: &ManagedRehostReceipt) -> Result<(), String> {
    receipt.validate().map_err(|error| error.to_string())?;
    let replacement = receipt.replacement_receipt();
    let fence = replacement.generation_fence().ok_or_else(|| {
        typed_error(
            "credential_binding_generation_missing",
            "managed rehost replacement has no generation fence",
        )
    })?;
    let prepared = prepare_at(
        root,
        ManagedCredentialLaunch {
            launch_id: replacement.idempotency_key(),
            session_id: replacement.session_id(),
            workspace_id: replacement.workspace_id(),
            provider_id: replacement.provider_id(),
            credential_id: receipt.launch_reference(),
            conversation_id: receipt.conversation_id(),
            // The canonical rehost receipt proves this operation owns the
            // replacement generation, including when the receipt is replayed
            // after the app reconnects.
            preexisting_runtime: false,
        },
    )?;
    finish_at(
        root,
        &prepared.launch_id,
        true,
        RuntimeGeneration {
            runner_principal: fence.runner_principal(),
            runner_instance: fence.runner_instance(),
            channel_epoch: &fence.channel_epoch().to_string(),
            host_instance_id: fence.host_instance_id(),
            terminal_epoch: fence.terminal_epoch(),
        },
    )
}

fn finish_direct_at(
    root: &Path,
    prepared: &PreparedCredentialLaunch,
    created: bool,
    generation: RuntimeGeneration<'_>,
) -> Result<(), String> {
    finish_at(root, &prepared.launch_id, created, generation)
}

pub(crate) fn observe_managed_conversation(
    descriptor: &SessionDescriptor,
    conversation_id: &str,
) -> Result<CredentialBindingObservationOutcome, String> {
    if !provider_tracks_credential_conversations(&descriptor.provider_id) {
        return Ok(CredentialBindingObservationOutcome::LaunchNotRecorded);
    }
    observe_at(
        &default_root()?,
        &descriptor.session_id,
        &descriptor.workspace_id,
        &descriptor.provider_id,
        conversation_id,
        descriptor.into(),
    )
}

fn exact_managed_provider_conversation<'a>(
    descriptor: &SessionDescriptor,
    identity: &'a ProviderConversationIdentityDescriptor,
) -> Result<Option<&'a str>, String> {
    if descriptor.session_class != SessionClass::Managed {
        return Ok(None);
    }
    if identity.session_id != descriptor.session_id
        || identity.workspace_id != descriptor.workspace_id
        || identity.runner_principal != descriptor.runner_principal
        || identity.runner_instance != descriptor.runner_instance
        || identity.channel_epoch != descriptor.channel_epoch
        || identity.host_instance_id != descriptor.host_instance_id
        || identity.terminal_epoch != descriptor.terminal_epoch
        || identity.provider_id != descriptor.provider_id
        || identity.conversation_id.is_empty()
    {
        return Err(typed_error(
            "credential_binding_conversation_conflict",
            "provider identity does not match the managed Host generation",
        ));
    }
    Ok(Some(identity.conversation_id.as_str()))
}

pub(crate) fn observe_managed_provider_conversation_identity(
    descriptor: &SessionDescriptor,
    identity: &ProviderConversationIdentityDescriptor,
) -> Result<CredentialBindingObservationOutcome, String> {
    let Some(conversation_id) = exact_managed_provider_conversation(descriptor, identity)? else {
        return Ok(CredentialBindingObservationOutcome::LaunchNotRecorded);
    };
    observe_managed_conversation(descriptor, conversation_id)
}

#[tauri::command]
pub fn credential_session_bindings(
    provider_id: String,
) -> Result<Vec<CredentialConversationBinding>, String> {
    bindings_at(&default_root()?, &provider_id)
}

/// How strongly the journal ties a conversation to a credential.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AttributionConfidence {
    /// The launch created the runtime generation, so the journal proves which
    /// credential produced the conversation.
    Committed,
    /// The launch reattached to a generation that was already running. The
    /// credential is what this app asked for, not proof of who created the
    /// conversation. Usable for usage accounting only when the surface says so:
    /// long-lived sessions never create a generation again, so refusing to read
    /// this at all leaves their account permanently blank.
    Observed,
}

pub(crate) struct ConversationCredential {
    pub credential_id: Option<String>,
    pub confidence: AttributionConfidence,
}

fn attributions_at(
    root: &Path,
    provider_id: &str,
) -> Result<HashMap<String, ConversationCredential>, String> {
    validate_id("provider id", provider_id)?;
    let journal = LockedJournal::open(root)?;
    let bound = journal
        .events
        .iter()
        .filter(|event| event.event == EventKind::ConversationBound)
        .filter_map(|event| {
            event
                .conversation_id
                .as_ref()
                .map(|conversation| (event.launch_id.as_str(), conversation.as_str()))
        })
        .collect::<HashMap<_, _>>();
    let prepared_by_launch = prepared_events(&journal.events)
        .map(|event| (event.launch_id.as_str(), event))
        .collect::<HashMap<_, _>>();

    let mut out: HashMap<String, (u64, ConversationCredential)> = HashMap::new();
    for event in &journal.events {
        let confidence = match event.event {
            EventKind::LaunchCommitted => AttributionConfidence::Committed,
            EventKind::LaunchUnattributed => AttributionConfidence::Observed,
            _ => continue,
        };
        if event.provider_id != provider_id {
            continue;
        }
        let Some(prepared) = prepared_by_launch.get(event.launch_id.as_str()) else {
            continue;
        };
        let Some(conversation) = prepared
            .conversation_id
            .as_deref()
            .or_else(|| bound.get(prepared.launch_id.as_str()).copied())
        else {
            continue;
        };
        // A proven era always outranks an observed one; within the same class
        // the later durable sequence wins, so a migrated conversation keeps its
        // newest credential.
        let replaces = match out.get(conversation) {
            None => true,
            Some((seq, held)) => match (held.confidence, confidence) {
                (AttributionConfidence::Observed, AttributionConfidence::Committed) => true,
                (AttributionConfidence::Committed, AttributionConfidence::Observed) => false,
                _ => event.seq >= *seq,
            },
        };
        if replaces {
            out.insert(
                conversation.to_string(),
                (
                    event.seq,
                    ConversationCredential {
                        credential_id: prepared.credential_id.clone(),
                        confidence,
                    },
                ),
            );
        }
    }
    Ok(out
        .into_iter()
        .map(|(conversation, (_, credential))| (conversation, credential))
        .collect())
}

/// Conversation -> credential map for usage accounting. An unreadable or absent
/// journal yields an empty map: callers must treat that as unattributed and
/// never fall back to the active account, which would invent attribution the
/// journal does not have.
pub(crate) fn conversation_credentials(provider_id: &str) -> HashMap<String, ConversationCredential> {
    let Ok(root) = default_root() else {
        return HashMap::new();
    };
    // Usage accounting is a read path polled on a timer. Opening the journal
    // creates its directory and takes the exclusive launch lock, so skip both
    // while no launch has ever been recorded.
    if !root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE).exists() {
        return HashMap::new();
    }
    attributions_at(&root, provider_id).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion,
        ProviderConversationIdentitySource, SessionLifecycle, VersionRange,
    };
    use std::sync::Arc;

    fn root(temp: &tempfile::TempDir) -> PathBuf {
        temp.path().join(".dure")
    }

    fn launch<'a>(
        launch_id: &'a str,
        session_id: &'a str,
        credential_id: Option<&'a str>,
        conversation_id: Option<&'a str>,
    ) -> ManagedCredentialLaunch<'a> {
        ManagedCredentialLaunch {
            launch_id,
            session_id,
            workspace_id: "workspace-1",
            provider_id: "codex",
            credential_id,
            conversation_id,
            preexisting_runtime: false,
        }
    }

    fn generation(id: &str) -> RuntimeGeneration<'_> {
        RuntimeGeneration {
            runner_principal: "runner-principal",
            runner_instance: "runner-instance",
            channel_epoch: "1",
            host_instance_id: id,
            terminal_epoch: id,
        }
    }

    fn session_descriptor(session_class: SessionClass) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "session-1".into(),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "codex".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: Some("codex".into()),
            runner_principal: "runner-principal".into(),
            runner_instance: "runner-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "4".into(),
            host_build_version: "build-1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: Vec::new(),
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "host-process".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 2,
                start_marker: "provider-process".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/tmp/session-1.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    fn provider_identity() -> ProviderConversationIdentityDescriptor {
        ProviderConversationIdentityDescriptor {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            runner_principal: "runner-principal".into(),
            runner_instance: "runner-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            revision: "1".into(),
            observed_through_output_seq: "4".into(),
            provider_id: "codex".into(),
            conversation_id: "conversation-1".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        }
    }

    #[test]
    fn structured_identity_requires_one_exact_managed_host_generation() {
        let managed = session_descriptor(SessionClass::Managed);
        let identity = provider_identity();

        assert_eq!(
            exact_managed_provider_conversation(&managed, &identity).unwrap(),
            Some("conversation-1")
        );

        let mut stale = identity.clone();
        stale.terminal_epoch = "terminal-predecessor".into();
        assert!(
            exact_managed_provider_conversation(&managed, &stale)
                .unwrap_err()
                .starts_with("credential_binding_conversation_conflict:")
        );
        assert_eq!(
            exact_managed_provider_conversation(
                &session_descriptor(SessionClass::Standalone),
                &identity,
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn reviewed_claude_and_codex_launches_get_durable_credential_attribution() {
        assert!(provider_tracks_credential_conversations("claude"));
        assert!(provider_tracks_credential_conversations("codex"));
        assert!(!provider_tracks_credential_conversations("gemini"));
    }

    #[test]
    fn commit_rehydrates_every_replacement_input_from_the_journal() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch(
                "launch-1",
                "session-1",
                Some("credential-crispy"),
                Some("conversation-1"),
            ),
        )
        .unwrap();

        // Simulate losing every in-memory hint after the provider-create boundary.
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();

        assert_eq!(
            bindings_at(&root, "codex").unwrap(),
            vec![CredentialConversationBinding {
                schema_version: 1,
                launch_id: "launch-1".into(),
                session_id: "session-1".into(),
                workspace_id: "workspace-1".into(),
                provider_id: "codex".into(),
                credential_id: Some("credential-crispy".into()),
                conversation_id: "conversation-1".into(),
                effective_at_ms: bindings_at(&root, "codex").unwrap()[0].effective_at_ms,
                effective_sequence: 1,
            }]
        );
    }

    #[test]
    fn a_fresh_conversation_binds_only_after_its_launch_is_committed() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), None),
        )
        .unwrap();
        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-1",
                generation("generation-1"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::LaunchNotRecorded
        );
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();
        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-1",
                generation("generation-1"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::Bound
        );
        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-1",
                generation("generation-1"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::AlreadyBound
        );
        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 1);
    }

    #[test]
    fn a_replacement_host_generation_cannot_inherit_an_old_credential_launch() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), None),
        )
        .unwrap();
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();

        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-2",
                generation("generation-2"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::LaunchNotRecorded
        );
        assert!(finish_at(
            &root,
            &prepared.launch_id,
            false,
            generation("generation-2")
        )
        .unwrap_err()
        .starts_with("credential_binding_generation_conflict:"));
        assert!(bindings_at(&root, "codex").unwrap().is_empty());
    }

    #[test]
    fn exact_conversation_migration_retains_both_credential_eras() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let first = prepare_at(
            &root,
            launch(
                "launch-z",
                "session-a",
                Some("credential-a"),
                Some("conversation-1"),
            ),
        )
        .unwrap();
        finish_at(&root, &first.launch_id, true, generation("generation-1")).unwrap();
        let second = prepare_at(
            &root,
            launch(
                "launch-a",
                "session-b",
                Some("credential-b"),
                Some("conversation-1"),
            ),
        )
        .unwrap();
        finish_at(&root, &second.launch_id, true, generation("generation-2")).unwrap();

        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-a"));
        assert_eq!(bindings[1].credential_id.as_deref(), Some("credential-b"));
        assert_eq!(bindings[0].conversation_id, "conversation-1");
        assert_eq!(bindings[1].conversation_id, "conversation-1");
        assert!(bindings[0].effective_sequence < bindings[1].effective_sequence);
    }

    #[test]
    fn canonical_rehost_receipt_records_the_replacement_credential_era() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let request = hmux_client::ManagedRehostRequest::new(
            "rehost-1",
            "source-session",
            "workspace-1",
            "source-principal",
            "source-runner",
            1,
            "source-host",
            "source-terminal",
            true,
        )
        .unwrap()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-1")
        .unwrap();
        let stopped = hmux_client::ManagedStopReceipt::from_request(
            request.source(),
            hmux_client::ManagedStopOutcome::Stopped,
            "rehosted",
        )
        .unwrap();
        let replacement = hmux_client::ManagedCreateReceipt::new(
            "replacement-1",
            "replacement-session",
            "workspace-1",
            "codex",
            hmux_client::PermissionMode::Default,
            "/tmp/discovery",
            hmux_client::ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            hmux_client::ManagedCreateGenerationFence::new(
                "target-principal",
                "target-runner",
                2,
                "target-host",
                "target-terminal",
            )
            .unwrap(),
        )
        .unwrap();
        let receipt = hmux_client::ManagedRehostReceipt::new(
            &request,
            stopped,
            replacement,
            "conversation-1",
            Some("credential-b".into()),
            false,
        )
        .unwrap();

        record_managed_rehost_at(&root, &receipt).unwrap();
        record_managed_rehost_at(&root, &receipt).unwrap();

        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].session_id, "replacement-session");
        assert_eq!(bindings[0].conversation_id, "conversation-1");
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-b"));
    }

    #[test]
    fn the_default_credential_is_explicit_and_no_profile_path_is_exposed() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();

        let value = serde_json::to_value(&bindings_at(&root, "codex").unwrap()[0]).unwrap();
        assert!(value.get("credentialId").unwrap().is_null());
        assert!(value.get("credentialDirectory").is_none());
        assert!(value.get("providerStateEnvironment").is_none());
    }

    #[test]
    fn retries_are_idempotent_and_conflicting_reuse_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let input = launch("launch-1", "session-1", None, Some("conversation-1"));
        let first = prepare_at(&root, input).unwrap();
        let second = prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        assert_eq!(first.launch_id, second.launch_id);
        finish_at(&root, &first.launch_id, true, generation("generation-1")).unwrap();
        finish_at(&root, &first.launch_id, true, generation("generation-1")).unwrap();

        let error = prepare_at(
            &root,
            launch(
                "launch-1",
                "session-other",
                Some("credential-other"),
                Some("conversation-2"),
            ),
        )
        .unwrap_err();
        assert!(error.starts_with("credential_binding_idempotency_conflict:"));
        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 1);
    }

    /// 나중에 관측된 대화 id 는 같은 launch 를 막지 않는다.
    ///
    /// 겪은 순서 그대로다(2026-07-31, managed Claude pane). create 는 launch id
    /// 로 `agent.id` 를 고정해 쓰고, 최초 create 는 대화가 생기기 전이라 null 로
    /// 커밋된다. pane 이 포커스로 다시 ensure 될 때는 그 사이 관측된 대화 id 가
    /// 실려 온다. 이걸 신원 불일치로 보면 저널이 영구 기록이라 재시도마다 같은
    /// 충돌이 재생산되고, pane 이 스스로 복구되지 못한다.
    #[test]
    fn a_later_observed_conversation_does_not_block_the_same_launch() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);

        // 최초 create: 대화가 아직 없다.
        let first = prepare_at(&root, launch("agent-1", "session-1", None, None)).unwrap();
        finish_direct_at(&root, &first, true, generation("generation-1")).unwrap();

        // 포커스로 다시 ensure — 이제 대화 id 를 안다. 같은 launch 여야 하고,
        // 이어지는 finish 까지 통과해야 pane 이 실제로 붙는다.
        let second = prepare_at(
            &root,
            launch("agent-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        assert_eq!(second.launch_id, first.launch_id);
        finish_direct_at(&root, &second, false, generation("generation-1")).unwrap();

        // 준비 기록은 여전히 None 이다 — prepare 는 힌트를 저장하지 않는다.
        // 대화 귀속은 설계대로 observe 가 맡는다.
        assert_eq!(
            prepared_events(&LockedJournal::open(&root).unwrap().events)
                .find(|event| event.launch_id == "agent-1")
                .and_then(|event| event.conversation_id.clone()),
            None,
        );

        // 준비 때부터 대화를 알고 있던 launch 는 엄격하다. 그 값이 귀속의
        // 유일한 근거라, 힌트를 잃은 재시도도 다른 대화도 모두 거부한다.
        prepare_at(
            &root,
            launch("agent-2", "session-2", None, Some("conversation-1")),
        )
        .unwrap();
        for (label, conversation) in [("힌트 없는 재시도", None), ("다른 대화", Some("conversation-2"))]
        {
            let error = prepare_at(&root, launch("agent-2", "session-2", None, conversation))
                .unwrap_err();
            assert!(
                error.starts_with("credential_binding_idempotency_conflict:"),
                "{label}는 거부해야 한다: {error}",
            );
        }
    }

    #[test]
    fn preexisting_runtime_without_a_prepared_record_stays_unattributed() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let mut input = launch("launch-1", "session-1", Some("credential-a"), None);
        input.preexisting_runtime = true;
        let first = prepare_at(&root, input).unwrap();
        finish_direct_at(&root, &first, false, generation("generation-1")).unwrap();

        let retry = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), None),
        )
        .unwrap();
        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-1",
                generation("generation-1"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::LaunchNotRecorded
        );
        assert!(
            finish_at(&root, &retry.launch_id, true, generation("generation-1"))
                .unwrap_err()
                .starts_with("credential_binding_launch_unattributed:")
        );
        assert!(bindings_at(&root, "codex").unwrap().is_empty());
    }

    #[test]
    fn non_admitted_create_is_excluded_from_usage_attribution() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch(
                "launch-1",
                "session-1",
                Some("credential-requested"),
                Some("conversation-1"),
            ),
        )
        .unwrap();

        close_not_admitted_at(&root, &prepared.launch_id).unwrap();
        close_not_admitted_at(&root, &prepared.launch_id).unwrap();

        let error = finish_at(
            &root,
            &prepared.launch_id,
            false,
            generation("generation-late"),
        )
        .unwrap_err();
        assert!(error.starts_with("credential_binding_launch_not_admitted:"));

        assert!(bindings_at(&root, "codex").unwrap().is_empty());
        assert!(attributions_at(&root, "codex").unwrap().is_empty());
        assert_eq!(
            LockedJournal::open(&root).unwrap().events.last().unwrap().event,
            EventKind::LaunchNotAdmitted
        );
    }

    #[test]
    fn non_admitted_close_never_overwrites_a_previously_committed_generation() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch(
                "launch-1",
                "session-1",
                Some("credential-proven"),
                Some("conversation-1"),
            ),
        )
        .unwrap();
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();

        close_not_admitted_at(&root, &prepared.launch_id).unwrap();

        let credential = attributions_at(&root, "codex")
            .unwrap()
            .remove("conversation-1")
            .expect("committed attribution");
        assert_eq!(credential.confidence, AttributionConfidence::Committed);
        assert_eq!(
            credential.credential_id.as_deref(),
            Some("credential-proven")
        );
    }

    #[test]
    fn retry_after_create_interruption_uses_the_prepared_absence_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let first = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), None),
        )
        .unwrap();

        // The runtime now exists, but the retry must use the prepare-time
        // observation rather than this post-boundary client hint.
        let mut retry_input = launch("launch-1", "session-1", Some("credential-a"), None);
        retry_input.preexisting_runtime = true;
        let retry = prepare_at(&root, retry_input).unwrap();
        finish_direct_at(&root, &retry, false, generation("generation-1")).unwrap();
        assert_eq!(
            observe_at(
                &root,
                "session-1",
                "workspace-1",
                "codex",
                "conversation-1",
                generation("generation-1"),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::Bound
        );
        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 1);
        finish_at(&root, &first.launch_id, true, generation("generation-1")).unwrap();
    }

    #[test]
    fn a_committed_direct_launch_stays_attributed_when_later_reused() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let mut input = launch("launch-1", "session-1", Some("credential-a"), None);
        input.preexisting_runtime = true;
        let first = prepare_at(&root, input).unwrap();
        finish_direct_at(&root, &first, true, generation("generation-1")).unwrap();

        let retry = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), None),
        )
        .unwrap();
        finish_direct_at(&root, &retry, false, generation("generation-1")).unwrap();
    }

    #[test]
    fn a_partial_tail_is_removed_before_retry_append() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        let journal_path = root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE);
        OpenOptions::new()
            .append(true)
            .open(&journal_path)
            .unwrap()
            .write_all(b"{\"partial\"")
            .unwrap();

        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();

        let raw = std::fs::read_to_string(journal_path).unwrap();
        assert!(raw.ends_with('\n'));
        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 1);
    }

    #[test]
    fn concurrent_writers_leave_only_complete_events() {
        let temp = tempfile::tempdir().unwrap();
        let root = Arc::new(root(&temp));
        let threads = (0..12)
            .map(|index| {
                let root = Arc::clone(&root);
                std::thread::spawn(move || {
                    let launch_id = format!("launch-{index}");
                    let session_id = format!("session-{index}");
                    let conversation_id = format!("conversation-{index}");
                    let prepared = prepare_at(
                        &root,
                        launch(&launch_id, &session_id, None, Some(&conversation_id)),
                    )
                    .unwrap();
                    finish_at(
                        &root,
                        &prepared.launch_id,
                        true,
                        generation(&format!("generation-{index}")),
                    )
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 12);
        let raw = std::fs::read_to_string(root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE)).unwrap();
        assert!(raw
            .lines()
            .all(|line| serde_json::from_str::<JournalEvent>(line).is_ok()));
    }

    #[test]
    fn malformed_complete_event_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        let journal_path = root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE);
        OpenOptions::new()
            .append(true)
            .open(journal_path)
            .unwrap()
            .write_all(b"{\"malformed\":true}\n")
            .unwrap();

        assert!(bindings_at(&root, "codex")
            .unwrap_err()
            .starts_with("credential_binding_journal_invalid:"));
    }

    #[test]
    fn a_tampered_terminal_event_cannot_change_the_prepared_credential() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let prepared = prepare_at(
            &root,
            launch(
                "launch-1",
                "session-1",
                Some("credential-a"),
                Some("conversation-1"),
            ),
        )
        .unwrap();
        finish_at(&root, &prepared.launch_id, true, generation("generation-1")).unwrap();
        let journal_path = root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE);
        let raw = std::fs::read_to_string(&journal_path).unwrap();
        let mut lines = raw.lines().map(str::to_string).collect::<Vec<_>>();
        lines[1] = lines[1].replace("credential-a", "credential-b");
        std::fs::write(&journal_path, format!("{}\n", lines.join("\n"))).unwrap();

        assert!(bindings_at(&root, "codex")
            .unwrap_err()
            .starts_with("credential_binding_journal_invalid:"));
    }

    #[test]
    fn oversized_journal_is_rejected_before_reading_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        let journal_path = root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE);
        OpenOptions::new()
            .write(true)
            .open(journal_path)
            .unwrap()
            .set_len(MAX_JOURNAL_BYTES + 1)
            .unwrap();

        assert!(bindings_at(&root, "codex")
            .unwrap_err()
            .starts_with("credential_binding_journal_too_large:"));
    }

    #[test]
    fn a_hard_linked_journal_is_refused_without_changing_the_other_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        prepare_at(
            &root,
            launch("launch-1", "session-1", None, Some("conversation-1")),
        )
        .unwrap();
        let journal_path = root.join(JOURNAL_DIRECTORY).join(JOURNAL_FILE);
        let outside = temp.path().join("outside.jsonl");
        std::fs::write(&outside, b"outside\n").unwrap();
        std::fs::remove_file(&journal_path).unwrap();
        std::fs::hard_link(&outside, &journal_path).unwrap();

        assert!(bindings_at(&root, "codex")
            .unwrap_err()
            .starts_with("credential_binding_storage_untrusted:"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside\n");
    }

    /// A reattach to a running generation stays out of the proven bindings, but
    /// usage accounting can still see it as observed evidence. Without this a
    /// long-lived session's account is blank forever: it never creates a
    /// generation again.
    #[test]
    fn a_reattached_launch_is_observed_evidence_but_never_a_proven_binding() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let mut input = launch(
            "launch-1",
            "session-1",
            Some("credential-crispy"),
            Some("conversation-1"),
        );
        input.preexisting_runtime = true;
        let prepared = prepare_at(&root, input).unwrap();
        finish_at(&root, &prepared.launch_id, false, generation("generation-1")).unwrap();

        assert!(bindings_at(&root, "codex").unwrap().is_empty());
        let attributions = attributions_at(&root, "codex").unwrap();
        let credential = attributions.get("conversation-1").expect("observed attribution");
        assert_eq!(credential.credential_id.as_deref(), Some("credential-crispy"));
        assert_eq!(credential.confidence, AttributionConfidence::Observed);
    }

    /// A proven era must outrank an observed one regardless of journal order —
    /// otherwise a later reattach would downgrade a conversation we can prove.
    #[test]
    fn a_proven_era_outranks_a_later_observed_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let created = prepare_at(
            &root,
            launch("launch-1", "session-1", Some("credential-a"), Some("conversation-1")),
        )
        .unwrap();
        finish_at(&root, &created.launch_id, true, generation("generation-1")).unwrap();

        let mut reattach = launch(
            "launch-2",
            "session-2",
            Some("credential-b"),
            Some("conversation-1"),
        );
        reattach.preexisting_runtime = true;
        let reattached = prepare_at(&root, reattach).unwrap();
        finish_at(&root, &reattached.launch_id, false, generation("generation-1")).unwrap();

        let attributions = attributions_at(&root, "codex").unwrap();
        let credential = attributions.get("conversation-1").expect("attribution");
        assert_eq!(credential.credential_id.as_deref(), Some("credential-a"));
        assert_eq!(credential.confidence, AttributionConfidence::Committed);
    }

    /// Among observed eras the newest wins, so moving a live session onto
    /// another credential is reflected instead of pinned to the first reattach.
    #[test]
    fn the_newest_observed_era_wins_when_nothing_is_proven() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        for (launch_id, session_id, credential) in [
            ("launch-1", "session-1", "credential-a"),
            ("launch-2", "session-2", "credential-b"),
        ] {
            let mut input = launch(
                launch_id,
                session_id,
                Some(credential),
                Some("conversation-1"),
            );
            input.preexisting_runtime = true;
            let prepared = prepare_at(&root, input).unwrap();
            finish_at(&root, &prepared.launch_id, false, generation("generation-1")).unwrap();
        }

        let attributions = attributions_at(&root, "codex").unwrap();
        let credential = attributions.get("conversation-1").expect("attribution");
        assert_eq!(credential.credential_id.as_deref(), Some("credential-b"));
        assert_eq!(credential.confidence, AttributionConfidence::Observed);
    }
}
