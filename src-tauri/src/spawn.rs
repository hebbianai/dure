//! Spawn saga journal/receipt (UC-04).
//!
//! The append-only journal is the sole durable authority. Receipts are folded
//! from it in memory for the frontend and local CLI server (`GET /spawn/{id}`),
//! so reads survive WebView and process restarts without a second state path.
//! The journal stores neither secrets nor terminal contents; prompts are kept
//! only as digests.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

mod prompt_delivery;
#[cfg(debug_assertions)]
mod prompt_delivery_qa;
#[cfg(test)]
mod prompt_delivery_tests;
#[cfg(test)]
mod journal_tests;
#[cfg(test)]
mod ipc_tests;

use prompt_delivery::{
    host_atomic_prompt_delivery, prompt_failure_is_unverified, prompt_identity, prompt_step,
};

pub const STEPS: [&str; 6] = [
    "preflight",
    "worktree",
    "runtime_session",
    "pane",
    "provider_exec",
    "prompt_delivery",
];

const TERMINAL_STATES: [&str; 4] = [
    "succeeded",
    "failed",
    "compensated",
    "manual_intervention_required",
];

const EVENTS: [&str; 12] = [
    "saga_created",
    "step_started",
    "step_succeeded",
    "step_failed",
    "step_skipped",
    "artifact_created",
    "artifact_adopted",
    "evidence",
    "prompt_write_started",
    "compensation_started",
    "compensation_done",
    "saga_finished",
];

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn spawn_dir() -> Result<PathBuf, String> {
    let (root, _) = crate::app_home::app_root_resolution()?;
    let dir = root.join("spawn");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create spawn dir: {e}"))?;
    Ok(dir)
}

fn valid_receipt_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(not(windows))]
fn journal_path(id: &str) -> Result<PathBuf, String> {
    journal_path_in(&spawn_dir()?, id)
}

fn journal_path_in(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_receipt_id(id) {
        return Err("invalid receipt id".into());
    }
    Ok(dir.join(format!("{id}.journal.jsonl")))
}

#[cfg(unix)]
fn owner_only_options(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn owner_only_options(_options: &mut std::fs::OpenOptions) {}

fn append_line(path: &Path, line: &str) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true).read(true);
    owner_only_options(&mut options);
    let mut file = options
        .open(path)
        .map_err(|e| format!("could not open journal: {e}"))?;
    let appended: std::io::Result<()> = (|| {
        if file.seek(SeekFrom::End(0))? > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            // Retain the interrupted bytes, but never concatenate a new
            // event with an incomplete or merely unterminated prior line.
            if last[0] != b'\n' {
                file.write_all(b"\n")?;
            }
        }
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    appended.map_err(|e| format!("could not append journal event: {e}"))
}

/// The same file lock orders CLI and WebView writers across OS processes.
fn journal_write_lock(dir: &Path) -> Result<File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    owner_only_options(&mut options);
    let file = options
        .open(dir.join(".journal.lock"))
        .map_err(|error| format!("could not open spawn lock: {error}"))?;
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| format!("could not lock spawn journal: {error}"))?;
    Ok(file)
}

fn keyed_receipt_id(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"dure.spawn-journal/v1\0");
    digest.update(key.as_bytes());
    format!("{:x}", digest.finalize())
}

/// Publish the complete first event without replacing an existing intent.
/// The temporary name is never a journal; a crash cannot expose a partial request.
fn publish_journal(dir: &Path, id: &str, event: &Value) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(dir)
        .map_err(|error| format!("could not prepare spawn journal: {error}"))?;
    let mut bytes = serde_json::to_vec(event).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| format!("could not write spawn journal: {error}"))?;
    file.persist_noclobber(journal_path_in(dir, id)?)
        .map_err(|error| format!("could not publish spawn journal: {error}"))?;
    #[cfg(unix)]
    File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync spawn journal directory: {error}"))?;
    Ok(())
}

/// Read valid JSON object lines independently. A truncated UTF-8 tail must
/// not hide earlier complete events or later records appended after recovery.
fn read_events_in(dir: &Path, id: &str) -> Result<Vec<Map<String, Value>>, String> {
    let path = journal_path_in(dir, id)?;
    let raw = std::fs::read(&path).map_err(|_| format!("spawn receipt {id} not found"))?;
    Ok(raw
        .split(|byte| *byte == b'\n')
        .filter_map(|line| match serde_json::from_slice::<Value>(line) {
            Ok(Value::Object(event)) => Some(event),
            _ => None,
        })
        .collect())
}

fn step_index(step: &str) -> Option<usize> {
    STEPS.iter().position(|s| *s == step)
}

fn prompt_evidence_rank(level: &str) -> u8 {
    match level {
        "activity_observed" => 3,
        "provider_ready" => 2,
        "written_to_pty" => 1,
        _ => 0,
    }
}

fn project_prompt_evidence(entry: &mut Map<String, Value>, evidence: &Value) {
    let new_level = evidence.get("level").and_then(Value::as_str).unwrap_or("");
    let old_level = entry
        .get("evidence")
        .and_then(|value| value.get("level"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if prompt_evidence_rank(new_level) >= prompt_evidence_rank(old_level) {
        entry.insert("evidence".into(), evidence.clone());
    }
}

fn validate_event_payload(
    kind: &str,
    payload: &Map<String, Value>,
    receipt: &Value,
) -> Result<(), String> {
    let request = receipt.get("request").unwrap_or(&Value::Null);
    host_atomic_prompt_delivery(payload, request, prompt_step(receipt))?;
    if kind == "prompt_write_started" {
        if payload.get("step").and_then(Value::as_str) != Some("prompt_delivery") {
            return Err("prompt_write_started requires the prompt_delivery step".into());
        }
        let intent = payload
            .get("intent")
            .ok_or("prompt_write_started requires an intent object")?;
        let intent_identity = prompt_identity(intent)
            .ok_or("prompt_write_started requires a valid prompt identity")?;
        let request_identity = receipt
            .get("request")
            .and_then(prompt_identity)
            .ok_or("prompt_write_started requires a durable request identity")?;
        if intent_identity != request_identity {
            return Err("prompt_write_started intent does not match the durable request".into());
        }
        let step = prompt_step(receipt).ok_or("prompt_delivery step is unavailable")?;
        if step.get("status").and_then(Value::as_str) != Some("running") {
            return Err("prompt_write_started requires a running prompt_delivery step".into());
        }
        if step.get("delivery").is_some() {
            return Err("prompt delivery intent is already durable".into());
        }
    }

    let written_to_pty = kind == "evidence"
        && payload
            .get("evidence")
            .and_then(|evidence| evidence.get("level"))
            .and_then(Value::as_str)
            == Some("written_to_pty");
    if written_to_pty {
        let delivery_state = prompt_step(receipt)
            .and_then(|step| step.get("delivery"))
            .and_then(|delivery| delivery.get("state"))
            .and_then(Value::as_str);
        if delivery_state != Some("intent_durable") {
            return Err("written_to_pty evidence requires a durable prompt intent".into());
        }
    }
    Ok(())
}

/// journal 이벤트 목록을 receipt(spawn_receipt_v1)로 fold한다.
pub fn fold(events: &[Map<String, Value>]) -> Value {
    let mut receipt_id = String::new();
    let mut request = Value::Null;
    let mut idempotency_key = Value::Null;
    let mut state = "running".to_string();
    let mut updated_at = 0u64;
    let mut steps: Vec<Value> = STEPS
        .iter()
        .map(|s| json!({ "step": s, "status": "pending", "artifacts": [] }))
        .collect();

    for ev in events {
        let at = ev.get("at").and_then(Value::as_u64).unwrap_or(0);
        updated_at = updated_at.max(at);
        let kind = ev.get("event").and_then(Value::as_str).unwrap_or("");
        match kind {
            "saga_created" => {
                receipt_id = ev
                    .get("receiptId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                request = ev.get("request").cloned().unwrap_or(Value::Null);
                idempotency_key = ev.get("idempotencyKey").cloned().unwrap_or(Value::Null);
            }
            "step_started" | "step_succeeded" | "step_failed" | "step_skipped" => {
                let Some(index) = ev
                    .get("step")
                    .and_then(Value::as_str)
                    .and_then(step_index)
                else {
                    continue;
                };
                let entry = steps[index].as_object_mut().expect("step is object");
                let host_atomic_delivery =
                    match host_atomic_prompt_delivery(ev, &request, Some(entry)) {
                        Ok(delivery) => delivery,
                        Err(_) => continue,
                    };
                let status = match kind {
                    "step_started" => "running",
                    "step_succeeded" => "ok",
                    "step_failed" => "failed",
                    _ => "skipped",
                };
                entry.insert("status".into(), json!(status));
                let stamp = if kind == "step_started" { "startedAt" } else { "endedAt" };
                entry.insert(stamp.into(), json!(at));
                if kind == "step_started" {
                    entry.remove("endedAt");
                    entry.remove("error");
                }
                if let Some(detail) = ev.get("detail") {
                    entry.insert("detail".into(), detail.clone());
                }
                if let Some(delivery) = host_atomic_delivery {
                    entry.insert("delivery".into(), delivery);
                    project_prompt_evidence(
                        entry,
                        &json!({
                            "level": "written_to_pty",
                            "detail": "exact Host initial-prompt receipt"
                        }),
                    );
                }
                if kind == "step_failed" {
                    if let Some(error) = ev.get("error") {
                        entry.insert("error".into(), error.clone());
                    }
                    let unverified = ev.get("step").and_then(Value::as_str)
                        == Some("prompt_delivery")
                        && ev.get("error").is_some_and(prompt_failure_is_unverified);
                    if unverified {
                        let delivery = entry
                            .get("delivery")
                            .and_then(Value::as_object)
                            .cloned()
                            .or_else(|| {
                                prompt_identity(&request).map(|(digest, len)| {
                                    let mut delivery = Map::new();
                                    delivery.insert("promptDigest".into(), json!(digest));
                                    delivery.insert("promptLen".into(), json!(len));
                                    delivery
                                })
                            });
                        if let Some(mut delivery) = delivery {
                            delivery.insert("state".into(), json!("unverified"));
                            entry.insert("delivery".into(), Value::Object(delivery));
                        }
                    }
                }
            }
            "artifact_created" | "artifact_adopted" => {
                let Some(index) = ev
                    .get("step")
                    .and_then(Value::as_str)
                    .and_then(step_index)
                else {
                    continue;
                };
                let Some(artifact) = ev.get("artifact").and_then(Value::as_object) else {
                    continue;
                };
                let mut artifact = artifact.clone();
                artifact.insert(
                    "created_by_request".into(),
                    json!(kind == "artifact_created"),
                );
                let entry = steps[index].as_object_mut().expect("step is object");
                entry
                    .entry("artifacts")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .expect("artifacts is array")
                    .push(Value::Object(artifact));
            }
            "prompt_write_started" => {
                let Some(intent) = ev.get("intent").and_then(Value::as_object) else {
                    continue;
                };
                let entry = steps[step_index("prompt_delivery").expect("known step")]
                    .as_object_mut()
                    .expect("step is object");
                let mut delivery = intent.clone();
                delivery.insert("state".into(), json!("intent_durable"));
                entry.insert("delivery".into(), Value::Object(delivery));
            }
            "evidence" => {
                if let Some(index) = step_index("prompt_delivery") {
                    let entry = steps[index].as_object_mut().expect("step is object");
                    let new_level = ev
                        .get("evidence")
                        .and_then(|e| e.get("level"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if let Some(evidence) = ev.get("evidence") {
                        project_prompt_evidence(entry, evidence);
                    }
                    if new_level == "written_to_pty" {
                        let mut delivery = entry
                            .get("delivery")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        delivery.insert("state".into(), json!("written_to_pty"));
                        if let Some(request) = request.as_object() {
                            for key in ["promptDigest", "promptLen"] {
                                if !delivery.contains_key(key) {
                                    if let Some(value) = request.get(key) {
                                        delivery.insert(key.into(), value.clone());
                                    }
                                }
                            }
                        }
                        entry.insert("delivery".into(), Value::Object(delivery));
                    }
                }
            }
            "compensation_started" => state = "compensating".into(),
            "saga_finished" => {
                if let Some(terminal) = ev.get("state").and_then(Value::as_str) {
                    if TERMINAL_STATES.contains(&terminal) {
                        state = terminal.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    json!({
        "v": 1,
        "receiptId": receipt_id,
        "idempotencyKey": idempotency_key,
        "request": request,
        "steps": steps,
        "state": state,
        "updatedAt": updated_at,
    })
}

/// New receipts use a direct keyed path. Only old sp_* journals need discovery;
/// their first event remains authoritative even if index.json was never written.
fn find_receipt_id_in(dir: &Path, key: &str) -> Result<Option<String>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    let id = keyed_receipt_id(key);
    match File::open(journal_path_in(dir, &id)?) {
        Ok(_) => return Ok(Some(id)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not read spawn journal: {error}")),
    }
    let mut found = None;
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".journal.jsonl"))
            .filter(|id| id.starts_with("sp_") && valid_receipt_id(id))
        else {
            continue;
        };
        let file = File::open(entry.path()).map_err(|error| error.to_string())?;
        let mut line = Vec::new();
        BufReader::new(file)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        let Ok(created) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if created["event"] == "saga_created" && created["idempotencyKey"] == key {
            if found.is_some() {
                return Err("multiple spawn journals own the same retry key".into());
            }
            found = Some(id.to_string());
        }
    }
    Ok(found)
}

/// journal에 저장할 request 사본 — prompt 원문은 저장하지 않는다(터미널 내용
/// 금지 원칙). digest와 길이만 남긴다.
fn sanitize_request(params: &Value) -> Value {
    let Some(object) = params.as_object() else {
        return params.clone();
    };
    let mut sanitized = object.clone();
    if let Some(prompt) = sanitized.remove("prompt").and_then(|p| match p {
        Value::String(s) if !s.is_empty() => Some(s),
        _ => None,
    }) {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(prompt.as_bytes());
        sanitized.insert(
            "promptDigest".into(),
            json!(format!("sha256:{digest:x}")),
        );
        sanitized.insert("promptLen".into(), json!(prompt.len()));
    }
    Value::Object(sanitized)
}

/// saga를 생성한다. 같은 idempotencyKey가 이미 있으면 기존 receipt를 돌려준다.
#[tauri::command(async)]
pub fn spawn_saga_create(
    request: Value,
    idempotency_key: Option<String>,
) -> Result<Value, String> {
    create_saga_in(&spawn_dir()?, request, idempotency_key)
}

fn create_saga_in(
    dir: &Path,
    request: Value,
    idempotency_key: Option<String>,
) -> Result<Value, String> {
    let _guard = journal_write_lock(dir)?;
    let request = sanitize_request(&request);
    let key = idempotency_key.as_deref().filter(|key| !key.is_empty());
    if let Some(key) = key {
        if let Some(existing) = find_receipt_id_in(dir, key)? {
            let receipt = read_keyed_receipt_in(dir, &existing, key)?;
            return Ok(json!({ "receiptId": existing, "existing": true, "receipt": receipt }));
        }
    }
    let receipt_id = match key {
        Some(key) => keyed_receipt_id(key),
        None => crate::random_token::gen_token().map_err(|error| error.to_string())?,
    };
    let event = json!({
        "v": 1,
        "receiptId": receipt_id,
        "seq": 0,
        "at": now_ms(),
        "event": "saga_created",
        "request": request,
        "idempotencyKey": idempotency_key,
    });
    publish_journal(dir, &receipt_id, &event)?;
    let receipt = read_receipt_from_disk_in(dir, &receipt_id)?;
    Ok(json!({ "receiptId": receipt_id, "existing": false, "receipt": receipt }))
}

/// journal에 이벤트를 추가한다. seq/at은 여기서 부여한다.
#[tauri::command(async)]
pub fn spawn_journal_append(receipt_id: String, event: Value) -> Result<Value, String> {
    append_event_in(&spawn_dir()?, &receipt_id, &event)
}

fn append_event_in(dir: &Path, receipt_id: &str, event: &Value) -> Result<Value, String> {
    let _guard = journal_write_lock(dir)?;
    let Some(payload) = event.as_object() else {
        return Err("event must be an object".into());
    };
    let kind = payload.get("event").and_then(Value::as_str).unwrap_or("");
    if !EVENTS.contains(&kind) {
        return Err(format!("unknown journal event kind: {kind}"));
    }
    if kind == "saga_created" {
        return Err("saga_created is only written by spawn_saga_create".into());
    }
    let events = read_events_in(dir, receipt_id)?;
    let folded = fold(&events);
    validate_event_payload(kind, payload, &folded)?;
    #[cfg(debug_assertions)]
    prompt_delivery_qa::fail_prompt_success_append_once(receipt_id, payload)?;
    // failed / manual_intervention_required는 재개 가능(서버 게이트와 정합) —
    // 최종 확정은 succeeded/compensated뿐이다.
    let state = folded
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if (state == "succeeded" || state == "compensated") && kind != "saga_finished" {
        return Err("saga already reached a terminal state".into());
    }
    let mut record = payload.clone();
    record.insert("v".into(), json!(1));
    record.insert("receiptId".into(), json!(receipt_id));
    record.insert("seq".into(), json!(events.len() as u64));
    record.insert("at".into(), json!(now_ms()));
    append_line(
        &journal_path_in(dir, receipt_id)?,
        &serde_json::to_string(&Value::Object(record)).map_err(|e| e.to_string())?,
    )?;
    read_receipt_from_disk_in(dir, receipt_id)
}

fn read_receipt_from_disk(id: &str) -> Result<Value, String> {
    read_receipt_from_disk_in(&spawn_dir()?, id)
}

fn read_receipt_from_disk_in(dir: &Path, id: &str) -> Result<Value, String> {
    Ok(fold(&read_events_in(dir, id)?))
}

#[tauri::command(async)]
pub fn spawn_receipt_get(receipt_id: String) -> Result<Value, String> {
    read_receipt_from_disk(&receipt_id)
}

/// Resolve an existing intent before a client prepares mutable launch inputs.
#[tauri::command(async)]
pub fn spawn_receipt_find(idempotency_key: String) -> Result<Option<Value>, String> {
    receipt_by_key_in(&spawn_dir()?, &idempotency_key)
}

fn receipt_by_key_in(dir: &Path, key: &str) -> Result<Option<Value>, String> {
    let _guard = journal_write_lock(dir)?;
    find_receipt_id_in(dir, key)?
        .map(|id| read_keyed_receipt_in(dir, &id, key))
        .transpose()
}

fn read_keyed_receipt_in(dir: &Path, id: &str, key: &str) -> Result<Value, String> {
    let receipt = read_receipt_from_disk_in(dir, id)?;
    if receipt["receiptId"] != id || receipt["idempotencyKey"] != key {
        return Err("spawn journal retry identity does not match".into());
    }
    Ok(receipt)
}

/// 로컬 CLI 서버가 쓰는 디스크 직독 경로 (webview 불필요).
#[cfg(not(windows))]
pub fn receipt_for_server(id: &str) -> Result<Value, String> {
    read_receipt_from_disk(id)
}

#[cfg(not(windows))]
pub fn journal_for_server(id: &str) -> Result<String, String> {
    std::fs::read_to_string(journal_path(id)?)
        .map_err(|_| format!("spawn receipt {id} not found"))
}

/// 앱 시작 시 running 상태로 남은 saga 스캔 (크래시 복구의 관찰 창구).
#[tauri::command(async)]
pub fn spawn_receipts_list_running() -> Result<Vec<Value>, String> {
    let dir = spawn_dir()?;
    list_running_in(&dir)
}

fn list_running_in(dir: &Path) -> Result<Vec<Value>, String> {
    let mut running = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(running);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".journal.jsonl") else {
            continue;
        };
        if let Ok(receipt) = read_receipt_from_disk_in(dir, id) {
            let state = receipt
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !TERMINAL_STATES.contains(&state) {
                running.push(receipt);
            }
        }
    }
    Ok(running)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, step: Option<&str>, extra: Value) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("event".into(), json!(kind));
        m.insert("at".into(), json!(1000u64));
        if let Some(step) = step {
            m.insert("step".into(), json!(step));
        }
        if let Some(object) = extra.as_object() {
            for (k, v) in object {
                m.insert(k.clone(), v.clone());
            }
        }
        m
    }

    #[test]
    fn fold_reaches_terminal_state_and_keeps_ownership() {
        let events = vec![
            event(
                "saga_created",
                None,
                json!({ "receiptId": "sp_x", "request": { "provider": "claude" } }),
            ),
            event("step_started", Some("worktree"), json!({})),
            event(
                "artifact_adopted",
                Some("worktree"),
                json!({ "artifact": { "kind": "worktree", "id": "/w" } }),
            ),
            event("step_succeeded", Some("worktree"), json!({})),
            event("step_started", Some("runtime_session"), json!({})),
            event(
                "artifact_created",
                Some("runtime_session"),
                json!({ "artifact": { "kind": "hmux_session", "id": "s1" } }),
            ),
            event(
                "step_failed",
                Some("runtime_session"),
                json!({ "error": { "code": "boom", "message": "x" } }),
            ),
            event("saga_finished", None, json!({ "state": "failed" })),
        ];
        let receipt = fold(&events);
        assert_eq!(receipt["state"], "failed");
        assert_eq!(receipt["steps"][1]["status"], "ok");
        assert_eq!(receipt["steps"][1]["artifacts"][0]["created_by_request"], false);
        assert_eq!(receipt["steps"][2]["status"], "failed");
        assert_eq!(receipt["steps"][2]["artifacts"][0]["created_by_request"], true);
        assert_eq!(receipt["steps"][2]["error"]["code"], "boom");
        // 손대지 않은 단계는 pending으로 남는다
        assert_eq!(receipt["steps"][5]["status"], "pending");
    }

    #[test]
    fn evidence_keeps_highest_level() {
        let events = vec![
            event("saga_created", None, json!({ "receiptId": "sp_e" })),
            event(
                "evidence",
                None,
                json!({ "evidence": { "level": "activity_observed" } }),
            ),
            event(
                "evidence",
                None,
                json!({ "evidence": { "level": "written_to_pty" } }),
            ),
        ];
        let receipt = fold(&events);
        assert_eq!(
            receipt["steps"][5]["evidence"]["level"],
            "activity_observed"
        );
    }

    #[test]
    fn fold_tracks_prompt_boundary_independently_from_ranked_evidence() {
        let prompt_digest = format!("sha256:{}", "a".repeat(64));
        let events = vec![
            event(
                "saga_created",
                None,
                json!({
                    "receiptId": "sp_prompt",
                    "request": {
                        "promptDigest": prompt_digest,
                        "promptLen": 7
                    }
                }),
            ),
            event(
                "step_started",
                Some("prompt_delivery"),
                json!({ "detail": { "deliveryContract": "journal_first_v1" } }),
            ),
            event(
                "evidence",
                None,
                json!({ "evidence": { "level": "provider_ready" } }),
            ),
            event(
                "prompt_write_started",
                Some("prompt_delivery"),
                json!({
                    "intent": {
                        "promptDigest": format!("sha256:{}", "a".repeat(64)),
                        "promptLen": 7
                    }
                }),
            ),
            event(
                "evidence",
                None,
                json!({ "evidence": { "level": "written_to_pty" } }),
            ),
        ];
        let receipt = fold(&events);
        assert_eq!(receipt["steps"][5]["evidence"]["level"], "provider_ready");
        assert_eq!(
            receipt["steps"][5]["delivery"]["state"],
            "written_to_pty"
        );
        assert_eq!(
            receipt["steps"][5]["delivery"]["promptDigest"],
            format!("sha256:{}", "a".repeat(64))
        );
    }

    #[test]
    fn fold_projects_ambiguous_prompt_outcome_as_unverified() {
        let digest = format!("sha256:{}", "b".repeat(64));
        let events = vec![
            event(
                "saga_created",
                None,
                json!({
                    "receiptId": "sp_prompt",
                    "request": { "promptDigest": digest, "promptLen": 7 }
                }),
            ),
            event("step_started", Some("prompt_delivery"), json!({})),
            event(
                "prompt_write_started",
                Some("prompt_delivery"),
                json!({
                    "intent": {
                        "promptDigest": format!("sha256:{}", "b".repeat(64)),
                        "promptLen": 7
                    }
                }),
            ),
            event(
                "step_failed",
                Some("prompt_delivery"),
                json!({
                    "error": {
                        "code": "prompt_delivery_unverified",
                        "message": "ambiguous"
                    }
                }),
            ),
        ];
        let receipt = fold(&events);
        assert_eq!(receipt["steps"][5]["delivery"]["state"], "unverified");
    }

    #[test]
    fn prompt_delivery_boundary_requires_one_matching_durable_intent() {
        let digest = format!("sha256:{}", "c".repeat(64));
        let mut events = vec![
            event(
                "saga_created",
                None,
                json!({
                    "receiptId": "sp_prompt",
                    "request": { "promptDigest": digest, "promptLen": 7 }
                }),
            ),
            event("step_started", Some("prompt_delivery"), json!({})),
        ];
        let intent = event(
            "prompt_write_started",
            Some("prompt_delivery"),
            json!({
                "intent": {
                    "promptDigest": format!("sha256:{}", "c".repeat(64)),
                    "promptLen": 7
                }
            }),
        );
        let receipt = fold(&events);
        assert!(validate_event_payload("prompt_write_started", &intent, &receipt).is_ok());

        let malformed = event(
            "prompt_write_started",
            Some("prompt_delivery"),
            json!({ "intent": { "promptDigest": "sha256:bad" } }),
        );
        assert!(validate_event_payload("prompt_write_started", &malformed, &receipt).is_err());

        events.push(intent.clone());
        let with_intent = fold(&events);
        assert!(validate_event_payload("prompt_write_started", &intent, &with_intent).is_err());

        let written = event(
            "evidence",
            None,
            json!({ "evidence": { "level": "written_to_pty" } }),
        );
        assert!(validate_event_payload("evidence", &written, &receipt).is_err());
        assert!(validate_event_payload("evidence", &written, &with_intent).is_ok());
    }

    #[test]
    fn saga_creation_sanitizer_uses_utf8_prompt_length() {
        let sanitized = sanitize_request(&json!({ "prompt": "계" }));
        assert!(sanitized.get("prompt").is_none());
        assert_eq!(sanitized["promptLen"], 3);
        assert!(prompt_delivery::prompt_identity(&sanitized).is_some());
    }

    #[test]
    fn legacy_journal_recovers_without_its_index_and_keeps_terminal_state() {
        let directory = tempfile::tempdir().unwrap();
        let id = "sp_keyed_retry";
        let key = "agent-registration:[\"agent\",\"incarnation\"]";
        assert_eq!(receipt_by_key_in(directory.path(), key).unwrap(), None);
        let request = json!({ "kind": "agent_registration", "target": "original-host" });
        append_line(
            &journal_path_in(directory.path(), id).unwrap(),
            &json!({
                "v": 1, "receiptId": id, "seq": 0, "at": 1,
                "event": "saga_created", "request": request, "idempotencyKey": key,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            receipt_by_key_in(directory.path(), key).unwrap().unwrap()["request"],
            request,
        );
        let replay = create_saga_in(
            directory.path(),
            json!({ "target": "changed-host" }),
            Some(key.into()),
        )
        .unwrap();
        assert_eq!(replay["receiptId"], id);
        assert_eq!(replay["receipt"]["request"], request);
        assert_eq!(replay["existing"], true);
        append_event_in(
            directory.path(),
            id,
            &json!({ "event": "saga_finished", "state": "compensated" }),
        )
        .unwrap();
        assert_eq!(
            receipt_by_key_in(directory.path(), key).unwrap().unwrap()["state"],
            "compensated",
        );
        assert_eq!(
            receipt_by_key_in(directory.path(), "another-incarnation").unwrap(),
            None,
        );
    }

    #[test]
    fn keyed_creation_has_one_durable_record_even_when_the_old_index_is_unwritable() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("index.json")).unwrap();
        let request = json!({ "kind": "agent_registration", "target": "original-host" });
        let created =
            create_saga_in(directory.path(), request.clone(), Some("retry-key".into())).unwrap();
        let id = created["receiptId"].as_str().unwrap();
        assert!(valid_receipt_id(id));
        assert_eq!(id, keyed_receipt_id("retry-key"));
        // The caller loses the acknowledgement after publication. Its next
        // invocation must recover the first inputs without a secondary write.
        let replay = create_saga_in(
            directory.path(),
            json!({ "target": "different-host" }),
            Some("retry-key".into()),
        )
        .unwrap();
        assert_eq!(replay["receiptId"], id);
        assert_eq!(replay["receipt"]["request"], request);
        assert_eq!(replay["existing"], true);
        assert_eq!(list_running_in(directory.path()).unwrap().len(), 1);
        assert_eq!(
            receipt_by_key_in(directory.path(), "retry-key")
                .unwrap()
                .unwrap()["request"],
            request
        );
        assert!(receipt_by_key_in(directory.path(), "missing-key")
            .unwrap()
            .is_none());
    }

    #[test]
    fn unpublished_temporary_input_is_not_a_committed_journal() {
        let directory = tempfile::tempdir().unwrap();
        let mut temporary = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        temporary.write_all(b"{\"event\":\"saga_created\"").unwrap();
        assert!(receipt_by_key_in(directory.path(), "retry")
            .unwrap()
            .is_none());
        assert!(list_running_in(directory.path()).unwrap().is_empty());
        let created = create_saga_in(
            directory.path(),
            json!({ "target": "complete" }),
            Some("retry".into()),
        )
        .unwrap();
        assert_eq!(created["receipt"]["request"]["target"], "complete");
        assert_eq!(list_running_in(directory.path()).unwrap().len(), 1);
    }

    #[test]
    fn publication_never_overwrites_an_existing_journal() {
        let directory = tempfile::tempdir().unwrap();
        let created = create_saga_in(
            directory.path(),
            json!({ "original": true }),
            Some("retry".into()),
        )
        .unwrap();
        let id = created["receiptId"].as_str().unwrap();
        let path = journal_path_in(directory.path(), id).unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(publish_journal(directory.path(), id, &json!({ "replacement": true })).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn keyed_path_cannot_adopt_another_request_identity() {
        let directory = tempfile::tempdir().unwrap();
        let id = keyed_receipt_id("retry");
        publish_journal(directory.path(), &id, &json!({
            "event": "saga_created", "receiptId": id, "idempotencyKey": "another-key", "request": {},
        })).unwrap();
        assert!(receipt_by_key_in(directory.path(), "retry").is_err());
        assert!(create_saga_in(directory.path(), json!({}), Some("retry".into())).is_err());
    }

    #[test]
    fn independent_writers_share_one_keyed_receipt_and_append_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let mut writers = Vec::new();
        for writer in 0..4 {
            let path = directory.path().to_path_buf();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                barrier.wait();
                let receipt =
                    create_saga_in(&path, json!({ "writer": writer }), Some("shared".into()))
                        .unwrap();
                append_event_in(
                    &path,
                    receipt["receiptId"].as_str().unwrap(),
                    &json!({ "event": "step_started", "step": "preflight" }),
                )
                .unwrap();
                receipt
            }));
        }
        let receipts: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        assert_eq!(
            receipts
                .iter()
                .filter(|receipt| receipt["existing"] == false)
                .count(),
            1
        );
        let id = receipts[0]["receiptId"].as_str().unwrap();
        for receipt in &receipts {
            assert_eq!(receipt["receiptId"], id);
            assert_eq!(
                receipt["receipt"]["request"],
                receipts[0]["receipt"]["request"]
            );
        }
        let events = read_events_in(directory.path(), id).unwrap();
        assert_eq!(events.len(), 5);
        for (sequence, event) in events.iter().enumerate() {
            assert_eq!(event["seq"], sequence);
        }
    }

    #[test]
    fn unkeyed_creations_remain_independent() {
        let directory = tempfile::tempdir().unwrap();
        let first = create_saga_in(directory.path(), json!({}), None).unwrap();
        let second = create_saga_in(directory.path(), json!({}), None).unwrap();
        assert_ne!(first["receiptId"], second["receiptId"]);
        assert!(!first["receiptId"].as_str().unwrap().starts_with("sp_"));
        assert_eq!(list_running_in(directory.path()).unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn durable_append_survives_receipt_projection_failure() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let id = "sp_projection_failure";
        let created = json!({
            "v": 1,
            "receiptId": id,
            "seq": 0,
            "at": 1,
            "event": "saga_created",
            "request": {},
            "idempotencyKey": null,
        });
        append_line(
            &journal_path_in(directory.path(), id).unwrap(),
            &serde_json::to_string(&created).unwrap(),
        )
        .unwrap();
        let stale_receipt = fold(&read_events_in(directory.path(), id).unwrap());
        std::fs::write(
            directory.path().join(format!("{id}.receipt.json")),
            serde_json::to_vec(&stale_receipt).unwrap(),
        )
        .unwrap();

        // Production creates the writer lock before the journal's first event.
        drop(journal_write_lock(directory.path()).unwrap());
        let original_permissions = std::fs::metadata(directory.path()).unwrap().permissions();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let append = append_event_in(
            directory.path(),
            id,
            &json!({ "event": "step_started", "step": "worktree" }),
        );
        std::fs::set_permissions(directory.path(), original_permissions).unwrap();

        let from_get = read_receipt_from_disk_in(directory.path(), id).unwrap();
        let from_restart = list_running_in(directory.path()).unwrap();
        assert_eq!(
            json!({
                "appendAccepted": append.is_ok(),
                "getStatus": from_get["steps"][1]["status"],
                "restartStatus": from_restart[0]["steps"][1]["status"],
            }),
            json!({
                "appendAccepted": true,
                "getStatus": "running",
                "restartStatus": "running",
            })
        );
    }

    #[test]
    fn truncated_last_line_is_ignored_by_parser() {
        // read_events는 파싱 실패 라인을 건너뛴다 — fold 입력으로 확인
        let valid = serde_json::from_str::<Value>(
            r#"{"event":"saga_created","receiptId":"sp_t","at":1}"#,
        )
        .unwrap();
        let events = vec![valid.as_object().cloned().unwrap()];
        let receipt = fold(&events);
        assert_eq!(receipt["state"], "running");
        assert_eq!(receipt["receiptId"], "sp_t");
    }
}
