use std::path::Path;

const FILE_NAME: &str = "hmux-connection-diagnostics.json";
const MAX_EVENTS: usize = 512;
const MAX_INCIDENTS: usize = 64;
const MAX_EVENT_BYTES: usize = 16 * 1024;
const MAX_BATCH_EVENTS: usize = 64;
const MAX_JOURNAL_BYTES: u64 =
    ((MAX_EVENTS + MAX_INCIDENTS) * MAX_EVENT_BYTES + 64 * 1024) as u64;
static PROCESS_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

/// Persist one bounded Hmux connection event. A process mutex serializes
/// WebViews, while the owner-only file lock also serializes separate app
/// processes before the journal is atomically replaced.
#[tauri::command(async)]
pub(crate) fn append_hmux_connection_diagnostic(event: serde_json::Value) -> Result<(), String> {
    append_diagnostics(vec![event])
}

#[tauri::command(async)]
pub(crate) fn append_hmux_connection_diagnostics(
    events: Vec<serde_json::Value>,
) -> Result<(), String> {
    append_diagnostics(events)
}

fn append_diagnostics(events: Vec<serde_json::Value>) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    if events.len() > MAX_BATCH_EVENTS {
        return Err("Hmux connection diagnostic batch exceeds the event limit".into());
    }
    for event in &events {
        validate_event(event)?;
    }
    let timestamp = events
        .last()
        .and_then(|event| event.get("timestamp"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let process_lock = PROCESS_LOCK.get_or_init(Default::default);
    let _process_guard = process_lock
        .lock()
        .map_err(|_| "Hmux connection diagnostics lock poisoned".to_string())?;
    let path = crate::hebbian_file(FILE_NAME)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Hmux connection diagnostics parent is unavailable".to_string())?;
    secure_directory(directory)?;
    let file_lock = open_file_lock(directory)?;
    file_lock.lock().map_err(|error| error.to_string())?;
    let raw = read_journal(&path)?;
    let content = append_events_json(&raw, events, &timestamp)?;
    persist_journal(&path, &content)
}

fn validate_event(event: &serde_json::Value) -> Result<(), String> {
    if !event.is_object() {
        return Err("Hmux connection diagnostic must be a JSON object".into());
    }
    let event_size = serde_json::to_vec(event)
        .map_err(|error| error.to_string())?
        .len();
    if event_size > MAX_EVENT_BYTES {
        return Err("Hmux connection diagnostic exceeds the size limit".into());
    }
    Ok(())
}

fn secure_directory(directory: &Path) -> Result<(), String> {
    let metadata = directory
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Hmux connection diagnostics directory is unsafe".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_file_lock(directory: &Path) -> Result<std::fs::File, String> {
    let path = directory.join(".hmux-connection-diagnostics.lock");
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("Hmux connection diagnostics lock is unsafe".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(file)
}

fn read_journal(path: &Path) -> Result<String, String> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Hmux connection diagnostics file is unsafe".into());
    }
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Ok(String::new());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    {
        use std::io::Read;
        file.take(MAX_JOURNAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
    }
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Ok(String::new());
    }
    Ok(String::from_utf8(bytes).unwrap_or_default())
}

fn persist_journal(path: &Path, content: &str) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Hmux connection diagnostics parent is unavailable".to_string())?;
    let temporary = directory.join(format!(
        ".hmux-connection-diagnostics.{}.tmp",
        crate::server::gen_token().map_err(|error| error.to_string())?
    ));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        {
            use std::io::Write;
            file.write_all(content.as_bytes())
                .map_err(|error| error.to_string())?;
        }
        file.sync_all().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        std::fs::File::open(directory)
            .and_then(|parent| parent.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
fn append_event_json(
    raw: &str,
    event: serde_json::Value,
    timestamp: &str,
) -> Result<String, String> {
    append_events_json(raw, vec![event], timestamp)
}

fn append_events_json(
    raw: &str,
    new_events: Vec<serde_json::Value>,
    timestamp: &str,
) -> Result<String, String> {
    let journal = serde_json::from_str::<serde_json::Value>(raw).ok();
    let schema_version = journal
        .as_ref()
        .and_then(|value| value.get("schemaVersion"))
        .and_then(serde_json::Value::as_u64);
    let mut events = if matches!(schema_version, Some(1 | 2)) {
        journal
            .as_ref()
            .and_then(|value| value.get("events"))
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    events.retain(|candidate| {
        candidate.is_object()
            && serde_json::to_vec(candidate)
                .is_ok_and(|serialized| serialized.len() <= MAX_EVENT_BYTES)
    });
    let mut incidents = if schema_version == Some(2) {
        journal
            .as_ref()
            .and_then(|value| value.get("incidents"))
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        events
            .iter()
            .filter(|candidate| is_incident(candidate))
            .cloned()
            .collect()
    };
    incidents.retain(|candidate| {
        candidate.is_object()
            && is_incident(candidate)
            && serde_json::to_vec(candidate)
                .is_ok_and(|serialized| serialized.len() <= MAX_EVENT_BYTES)
    });
    for event in new_events {
        if is_incident(&event) {
            record_observation(&mut incidents, event.clone());
        }
        record_observation(&mut events, event);
    }
    if events.len() > MAX_EVENTS {
        events.drain(..events.len() - MAX_EVENTS);
    }
    if incidents.len() > MAX_INCIDENTS {
        incidents.drain(..incidents.len() - MAX_INCIDENTS);
    }
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 2,
        "updatedAt": timestamp,
        "events": events,
        "incidents": incidents,
    }))
    .map(|content| format!("{content}\n"))
    .map_err(|error| error.to_string())
}

/// What makes two observations the same recurrence rather than two facts.
///
/// Everything except the timestamps and the recurrence counters, so a pane
/// failing the same way twice coalesces while a different session, code, state,
/// or detail stays its own row.
fn observation_identity(event: &serde_json::Value) -> Option<serde_json::Value> {
    let mut identity = event.as_object()?.clone();
    for volatile in ["timestamp", "lastTimestamp", "repeatCount"] {
        identity.remove(volatile);
    }
    Some(serde_json::Value::Object(identity))
}

/// Records one observation, coalescing a repeat into the row it repeats.
///
/// Both journal tiers are bounded and both used to trim purely by age, so a
/// single failure repeating every 30s evicted every other session's history —
/// measured on a live machine as 512/512 events and 64/64 incidents carrying
/// one code, with the long-term tier retaining 8x LESS history than the primary
/// one. Coalescing keeps the recurrence (first seen, last seen, how many) and
/// keeps the room for everything else.
fn record_observation(rows: &mut Vec<serde_json::Value>, event: serde_json::Value) {
    let Some(identity) = observation_identity(&event) else {
        rows.push(event);
        return;
    };
    let last_timestamp = event.get("timestamp").cloned();
    if let Some(existing) = rows
        .iter_mut()
        .find(|row| observation_identity(row).as_ref() == Some(&identity))
    {
        let Some(row) = existing.as_object_mut() else {
            return;
        };
        let repeats = row
            .get("repeatCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1)
            .saturating_add(1);
        row.insert("repeatCount".into(), repeats.into());
        if let Some(last_timestamp) = last_timestamp {
            row.insert("lastTimestamp".into(), last_timestamp);
        }
        return;
    }
    rows.push(event);
}

fn is_incident(event: &serde_json::Value) -> bool {
    let state = event
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if matches!(state, "disconnected" | "error" | "stale") {
        return true;
    }
    let code = event
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "closed",
        "failed",
        "error",
        "stalled",
        "backlog",
        "backpressure",
        "resource_limit",
        "timeout",
        "gap",
        "conflict",
        "unavailable",
        "exhausted",
    ]
    .iter()
    .any(|marker| code.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_invalid_content_and_preserves_cause() {
        let raw = append_event_json(
            "truncated",
            serde_json::json!({
                "event": "connection",
                "code": "hmux_observer_pending",
                "timestamp": "2026-07-28T00:00:00.000Z",
            }),
            "2026-07-28T00:00:00.000Z",
        )
        .unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(journal["schemaVersion"], 2);
        assert_eq!(journal["updatedAt"], "2026-07-28T00:00:00.000Z");
        assert_eq!(journal["events"][0]["code"], "hmux_observer_pending");
        assert_eq!(journal["incidents"], serde_json::json!([]));
    }

    /// One session failing the same way must not evict every other session's
    /// history. Measured on a live machine: three dangling bindings filled both
    /// tiers with one code in 82 minutes, and the long-term incident tier ended
    /// up retaining 8x LESS history than the primary tier, because both trim
    /// purely by age.
    #[test]
    fn a_repeating_failure_cannot_evict_unrelated_history() {
        let seeded = append_events_json(
            "",
            vec![
                serde_json::json!({
                    "event": "connection",
                    "code": "hmux_resize_failed",
                    "sessionId": "session-a",
                    "state": "error",
                    "timestamp": "2026-08-17T08:00:00.000Z",
                }),
                serde_json::json!({
                    "event": "connection",
                    "code": "hmux_replay_gap",
                    "sessionId": "session-b",
                    "state": "error",
                    "timestamp": "2026-08-17T08:00:01.000Z",
                }),
            ],
            "2026-08-17T08:00:01.000Z",
        )
        .unwrap();

        let flood = (0..MAX_EVENTS * 2)
            .map(|_| {
                serde_json::json!({
                    "event": "connection",
                    "code": "managed_agent_semantic_attach_failed",
                    "sessionId": "session-dangling",
                    "state": "error",
                    "timestamp": "2026-08-17T09:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let raw = append_events_json(&seeded, flood, "2026-08-17T09:00:00.000Z").unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();

        for tier in ["events", "incidents"] {
            let rows = journal[tier].as_array().unwrap();
            let codes = rows
                .iter()
                .map(|row| row["code"].as_str().unwrap_or_default())
                .collect::<Vec<_>>();
            assert!(
                codes.contains(&"hmux_resize_failed") && codes.contains(&"hmux_replay_gap"),
                "{tier} lost unrelated history to one repeating failure: {codes:?}"
            );
            let repeats = codes
                .iter()
                .filter(|code| **code == "managed_agent_semantic_attach_failed")
                .count();
            assert_eq!(
                repeats, 1,
                "{tier} kept {repeats} rows of one repeating failure instead of coalescing"
            );
        }
        let repeated = journal["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["code"] == "managed_agent_semantic_attach_failed")
            .expect("the repeating failure is still reported");
        assert_eq!(repeated["repeatCount"], (MAX_EVENTS * 2) as u64);
    }

    #[test]
    fn keeps_only_the_latest_event_window() {
        let events = (0..MAX_EVENTS)
            .map(|sequence| serde_json::json!({ "sequence": sequence }))
            .collect::<Vec<_>>();
        let existing = serde_json::json!({
            "schemaVersion": 1,
            "updatedAt": "old",
            "events": events,
        })
        .to_string();
        let raw = append_event_json(
            &existing,
            serde_json::json!({ "sequence": MAX_EVENTS }),
            "new",
        )
        .unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let events = journal["events"].as_array().unwrap();

        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0]["sequence"], 1);
        assert_eq!(events.last().unwrap()["sequence"], MAX_EVENTS);
    }

    #[test]
    fn appends_a_bounded_batch_in_order_with_one_journal_update() {
        let events = (0..MAX_BATCH_EVENTS)
            .map(|sequence| {
                serde_json::json!({
                    "event": "health",
                    "sequence": sequence,
                    "timestamp": format!("event-{sequence}"),
                })
            })
            .collect::<Vec<_>>();
        let raw = append_events_json("", events, "batch-complete").unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let retained = journal["events"].as_array().unwrap();

        assert_eq!(retained.len(), MAX_BATCH_EVENTS);
        assert_eq!(retained[0]["sequence"], 0);
        assert_eq!(retained.last().unwrap()["sequence"], MAX_BATCH_EVENTS - 1);
        assert_eq!(journal["updatedAt"], "batch-complete");
    }

    #[test]
    fn migrates_v1_and_retains_incidents_beyond_the_event_window() {
        let existing = serde_json::json!({
            "schemaVersion": 1,
            "updatedAt": "old",
            "events": [{
                "event": "connection",
                "state": "disconnected",
                "code": "hmux_transport_closed",
            }],
        })
        .to_string();
        let mut raw = append_event_json(
            &existing,
            serde_json::json!({ "event": "health", "state": "live" }),
            "new",
        )
        .unwrap();
        for sequence in 0..MAX_EVENTS {
            raw = append_event_json(
                &raw,
                serde_json::json!({
                    "event": "health",
                    "state": "live",
                    "sequence": sequence,
                }),
                "newer",
            )
            .unwrap();
        }
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(journal["schemaVersion"], 2);
        assert!(journal["events"].as_array().unwrap().iter().all(|event| {
            event.get("code").and_then(serde_json::Value::as_str)
                != Some("hmux_transport_closed")
        }));
        assert_eq!(
            journal["incidents"][0]["code"],
            "hmux_transport_closed"
        );
    }

    #[test]
    fn discards_oversized_or_invalid_retained_events() {
        let existing = serde_json::json!({
            "schemaVersion": 1,
            "updatedAt": "old",
            "events": [
                { "event": "valid" },
                { "event": "oversized", "details": "x".repeat(MAX_EVENT_BYTES) },
                "invalid",
            ],
        })
        .to_string();
        let raw =
            append_event_json(&existing, serde_json::json!({ "event": "new" }), "new").unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(
            journal["events"],
            serde_json::json!([{ "event": "valid" }, { "event": "new" }])
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_destination() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let victim = directory.path().join("victim");
        let journal = directory.path().join("journal.json");
        std::fs::write(&victim, "keep").unwrap();
        symlink(&victim, &journal).unwrap();

        assert!(read_journal(&journal).is_err());
        assert_eq!(std::fs::read_to_string(victim).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn atomically_publishes_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let journal = directory.path().join("journal.json");
        persist_journal(&journal, "{\"ok\":true}\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&journal).unwrap(),
            "{\"ok\":true}\n"
        );
        assert_eq!(
            std::fs::metadata(journal).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }
}
