//! Bounded evidence of a pane's failed Resume: which step failed (the exact
//! managed create or the closed-lineage wake) and with which code. The pane
//! keeps that failure only in its own UI state, so without this row a failed
//! wake cannot be diagnosed after a reload or restart.
//!
//! The existing native diagnostic journal owns persistence. The renderer
//! supplies a closed stage, a snake_case code and an optional Agent ID; the
//! timestamps are native, and messages, paths or other free text are refused
//! at ingress. The CLI reads the rows back through `dure diagnostics`.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const JOURNAL_KEY: &str = "paneRecoveryEvents";
const MAX_EVENTS: usize = 64;
const MAX_CODE_BYTES: usize = 128;
const MAX_AGENT_ID_BYTES: usize = 160;
const MAX_PER_INTERVAL: usize = 32;
const INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    ExactResume,
    LineageWake,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    stage: Stage,
    code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Event {
    stage: Stage,
    code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    first_seen_ms: u64,
    last_seen_ms: u64,
    count: u32,
}

/// `^[a-z][a-z0-9_]{0,127}$`, the shape of a backend or client failure code.
fn valid_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    bytes.len() <= MAX_CODE_BYTES
        && bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`, the shared domain ID contract.
fn valid_agent_id(agent_id: &str) -> bool {
    let bytes = agent_id.as_bytes();
    bytes.len() <= MAX_AGENT_ID_BYTES
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_identity(code: &str, agent_id: Option<&str>) -> bool {
    valid_code(code) && agent_id.is_none_or(valid_agent_id)
}

struct RateLimit {
    since: Instant,
    total: usize,
}

impl RateLimit {
    fn admit(&mut self, now: Instant) -> bool {
        if now.duration_since(self.since) >= INTERVAL {
            self.since = now;
            self.total = 0;
        }
        if self.total >= MAX_PER_INTERVAL {
            return false;
        }
        self.total += 1;
        true
    }
}

#[tauri::command(async)]
pub(crate) fn append_pane_recovery_diagnostic(event: Input) -> Result<(), String> {
    if !valid_identity(&event.code, event.agent_id.as_deref()) {
        return Err("pane_recovery_diagnostic_invalid".into());
    }
    static RATE: OnceLock<Mutex<RateLimit>> = OnceLock::new();
    let admitted = RATE
        .get_or_init(|| {
            Mutex::new(RateLimit {
                since: Instant::now(),
                total: 0,
            })
        })
        .lock()
        .map_err(|_| "pane_recovery_diagnostics_unavailable")?
        .admit(Instant::now());
    if !admitted {
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    crate::hmux_diagnostics::with_journal(|raw| Ok(((), Some(append_json(raw, event, now)?))))
        .map_err(|_| "pane_recovery_diagnostics_unavailable".into())
}

fn append_json(raw: &str, input: Input, now: u64) -> Result<String, String> {
    let mut journal = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(
            || serde_json::json!({ "schemaVersion": 2, "events": [], "incidents": [] }),
        );
    let mut events = retained_events(Some(&journal));
    let existing = events.iter().position(|event| {
        event.stage == input.stage && event.code == input.code && event.agent_id == input.agent_id
    });
    // A repeat moves to the end, so eviction drops the stalest failure first.
    let event = if let Some(index) = existing {
        let mut event = events.remove(index);
        event.last_seen_ms = now.max(event.last_seen_ms);
        event.count = event.count.saturating_add(1);
        event
    } else {
        Event {
            stage: input.stage,
            code: input.code,
            agent_id: input.agent_id,
            first_seen_ms: now,
            last_seen_ms: now,
            count: 1,
        }
    };
    events.push(event);
    bound_events(&mut events);
    journal[JOURNAL_KEY] =
        serde_json::to_value(events).map_err(|_| "pane_recovery_diagnostics_unavailable")?;
    serde_json::to_string(&journal)
        .map(|content| format!("{content}\n"))
        .map_err(|_| "pane_recovery_diagnostics_unavailable".into())
}

fn bound_events(events: &mut Vec<Event>) {
    if events.len() > MAX_EVENTS {
        events.drain(..events.len() - MAX_EVENTS);
    }
}

/// Every journal writer carries the retained rows forward; a row that no
/// longer satisfies ingress is dropped rather than re-published.
pub(crate) fn retained_events(journal: Option<&serde_json::Value>) -> Vec<Event> {
    let mut events: Vec<Event> = journal
        .and_then(|journal| journal.get(JOURNAL_KEY))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<Event>(value.clone()).ok())
        .filter(|event| {
            valid_identity(&event.code, event.agent_id.as_deref())
                && event.first_seen_ms <= event.last_seen_ms
                && event.count > 0
        })
        .collect();
    bound_events(&mut events);
    events
}

#[tauri::command(async)]
pub(crate) fn read_pane_recovery_diagnostics() -> Result<serde_json::Value, String> {
    crate::hmux_diagnostics::with_journal(|raw| {
        let journal = serde_json::from_str::<serde_json::Value>(raw).ok();
        Ok((
            serde_json::json!({
                "schemaVersion": 1, "state": "available", "events": retained_events(journal.as_ref()),
            }),
            None,
        ))
    })
    .map_err(|_| "pane_recovery_diagnostics_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(code: &str) -> Input {
        Input {
            stage: Stage::LineageWake,
            code: code.into(),
            agent_id: Some("agent-1".into()),
        }
    }

    fn rows(content: &str) -> Vec<Event> {
        retained_events(Some(&serde_json::from_str(content).unwrap()))
    }

    #[test]
    fn ingress_refuses_free_text_and_forged_fields() {
        let value = serde_json::to_value(input("session_checkout_store_busy")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "stage": "lineage_wake",
                "code": "session_checkout_store_busy",
                "agentId": "agent-1",
            })
        );
        for extra in ["message", "detail", "firstSeenMs", "count", "path"] {
            let mut forged = value.clone();
            forged[extra] = "private text".into();
            assert!(serde_json::from_value::<Input>(forged).is_err());
        }
        let mut stage = value.clone();
        stage["stage"] = "private".into();
        assert!(serde_json::from_value::<Input>(stage).is_err());
        for code in [
            "",
            "store is busy",
            "/Users/private/worktree",
            "Recovering",
            &format!("a{}", "b".repeat(128)),
        ] {
            assert!(!valid_identity(code, None), "{code:?}");
        }
        for agent_id in ["", "agent with spaces", "-agent", &"a".repeat(161)] {
            assert!(
                !valid_identity("recovering", Some(agent_id)),
                "{agent_id:?}"
            );
        }
        assert!(valid_identity("recovering", None));
        assert!(valid_identity("recovering", Some("agent-workflow-1:2.x")));
        assert_eq!(
            append_pane_recovery_diagnostic(input("store is busy")),
            Err("pane_recovery_diagnostic_invalid".into())
        );
    }

    #[test]
    fn coalesces_a_repeated_failure_and_keeps_other_journal_content() {
        let seed = r#"{"schemaVersion":2,"events":[{"code":"hmux_transport_closed"}],"incidents":[],"webviewEvents":[{"kept":true}]}"#;
        let first = append_json(seed, input("recovering"), 10).unwrap();
        let second = append_json(&first, input("session_checkout_closing"), 20).unwrap();
        let third = append_json(&second, input("recovering"), 30).unwrap();
        let journal: serde_json::Value = serde_json::from_str(&third).unwrap();
        assert_eq!(journal["events"][0]["code"], "hmux_transport_closed");
        assert_eq!(journal["webviewEvents"][0]["kept"], true);
        let events = rows(&third);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].code, "session_checkout_closing");
        assert_eq!(
            events[1],
            Event {
                stage: Stage::LineageWake,
                code: "recovering".into(),
                agent_id: Some("agent-1".into()),
                first_seen_ms: 10,
                last_seen_ms: 30,
                count: 2,
            }
        );
        let other_stage = Input {
            stage: Stage::ExactResume,
            ..input("recovering")
        };
        assert_eq!(
            rows(&append_json(&third, other_stage, 40).unwrap()).len(),
            3
        );
    }

    #[test]
    fn bounds_rows_and_drops_invalid_retained_content() {
        let mut journal = append_json("truncated", input("code_0"), 1).unwrap();
        for index in 1..=MAX_EVENTS {
            journal = append_json(&journal, input(&format!("code_{index}")), 1).unwrap();
        }
        let events = rows(&journal);
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0].code, "code_1");
        let tampered = serde_json::json!({ JOURNAL_KEY: [
            { "stage": "exact_resume", "code": "private text", "firstSeenMs": 1, "lastSeenMs": 1, "count": 1 },
            { "stage": "exact_resume", "code": "ok_code", "firstSeenMs": 2, "lastSeenMs": 1, "count": 1 },
            { "stage": "exact_resume", "code": "ok_code", "firstSeenMs": 1, "lastSeenMs": 1, "count": 0 },
            { "stage": "exact_resume", "code": "ok_code", "firstSeenMs": 1, "lastSeenMs": 1, "count": 1, "message": "private" },
            { "stage": "exact_resume", "code": "kept_code", "firstSeenMs": 1, "lastSeenMs": 1, "count": 1 },
        ]});
        let kept = retained_events(Some(&tampered));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].code, "kept_code");
        assert_eq!(kept[0].agent_id, None);
    }

    #[test]
    fn rate_limits_appends_per_interval() {
        let now = Instant::now();
        let mut limit = RateLimit {
            since: now,
            total: 0,
        };
        for _ in 0..MAX_PER_INTERVAL {
            assert!(limit.admit(now));
        }
        assert!(!limit.admit(now));
        assert!(limit.admit(now + INTERVAL));
    }
}
