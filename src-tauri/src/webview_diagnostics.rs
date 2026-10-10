//! Redacted desktop WebView diagnostics. The existing native diagnostic journal
//! owns persistence; neither the renderer nor the CLI can supply a window label,
//! timestamp, message, stack, URL, or arbitrary context for this collection.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BATCH: usize = 16;
const MAX_EVENTS: usize = 256;
const MAX_PER_WINDOW: usize = 64;
const INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Level {
    Warn,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source {
    Console,
    WindowError,
    UnhandledRejection,
    RenderBoundary,
    EntryImport,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Code {
    Redacted,
    ClientSpaceWindowChanged,
    ClientSpaceNotFound,
    ClientSpaceMountTimeout,
    ClientSourcePaneChanged,
    ClientSpaceChanged,
    ClientPresentationNotAuthorized,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    level: Level,
    source: Source,
    code: Code,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Event {
    level: Level,
    source: Source,
    code: Code,
    window_label: String,
    first_seen_ms: u64,
    last_seen_ms: u64,
    count: u32,
}

struct RateLimit {
    since: Instant,
    total: usize,
    windows: HashMap<String, usize>,
}

impl RateLimit {
    fn new(now: Instant) -> Self {
        Self {
            since: now,
            total: 0,
            windows: HashMap::new(),
        }
    }

    fn admit(&mut self, label: &str, count: usize, now: Instant) -> bool {
        if now.duration_since(self.since) >= INTERVAL {
            *self = Self::new(now);
        }
        // Bounds the map as well as writes across arbitrary window churn.
        if self.total + count > 128 || self.windows.get(label).copied().unwrap_or(0) + count > 32 {
            return false;
        }
        self.total += count;
        *self.windows.entry(label.to_owned()).or_default() += count;
        true
    }
}

// Native labels are application identifiers, never window titles or URLs.
// Unknown/nonstandard labels are hashed so even a user-supplied native label
// cannot turn this field into an unbounded text or credential channel.
fn window_identity(label: &str) -> String {
    let numeric_window = label.strip_prefix("win-").is_some_and(|suffix| {
        suffix.split_once('-').is_some_and(|(time, counter)| {
            !time.is_empty()
                && !counter.is_empty()
                && time.bytes().all(|c| c.is_ascii_digit())
                && counter.bytes().all(|c| c.is_ascii_digit())
        })
    });
    if label.len() <= 128 && (label == "main" || label == "win-source-control" || numeric_window) {
        return label.to_owned();
    }
    use sha2::{Digest, Sha256};
    format!("window-{:x}", Sha256::digest(label.as_bytes()))
}

#[tauri::command(async)]
pub(crate) fn append_webview_diagnostics(
    window: tauri::WebviewWindow,
    events: Vec<Input>,
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    if events.len() > MAX_BATCH {
        return Err("webview_diagnostics_batch_limit".into());
    }
    let label = window_identity(window.label());
    static RATE: OnceLock<Mutex<RateLimit>> = OnceLock::new();
    let admitted = RATE
        .get_or_init(|| Mutex::new(RateLimit::new(Instant::now())))
        .lock()
        .map_err(|_| "webview_diagnostics_unavailable")?
        .admit(&label, events.len(), Instant::now());
    if !admitted {
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    crate::hmux_diagnostics::with_journal(|raw| {
        Ok(((), Some(append_json(raw, &label, events, now)?)))
    })
    .map_err(|_| "webview_diagnostics_unavailable".into())
}

fn append_json(raw: &str, label: &str, inputs: Vec<Input>, now: u64) -> Result<String, String> {
    let mut journal = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .filter(|v| v.is_object())
        .unwrap_or_else(
            || serde_json::json!({ "schemaVersion": 2, "events": [], "incidents": [] }),
        );
    let mut events = retained_events(Some(&journal));
    for input in inputs {
        let existing = events.iter().position(|event| {
            event.window_label == label
                && event.level == input.level
                && event.source == input.source
                && event.code == input.code
        });
        let event = if let Some(index) = existing {
            let mut event = events.remove(index);
            event.last_seen_ms = now.max(event.last_seen_ms);
            event.count = event.count.saturating_add(1);
            event
        } else {
            Event {
                level: input.level,
                source: input.source,
                code: input.code,
                window_label: label.into(),
                first_seen_ms: now,
                last_seen_ms: now,
                count: 1,
            }
        };
        events.push(event);
        bound_events(&mut events);
    }
    journal["webviewEvents"] =
        serde_json::to_value(events).map_err(|_| "webview_diagnostics_unavailable")?;
    serde_json::to_string(&journal)
        .map(|s| format!("{s}\n"))
        .map_err(|_| "webview_diagnostics_unavailable".into())
}

fn bound_events(events: &mut Vec<Event>) {
    let mut counts = HashMap::<String, usize>::new();
    events.reverse();
    events.retain(|event| {
        let count = counts.entry(event.window_label.clone()).or_default();
        *count += 1;
        *count <= MAX_PER_WINDOW
    });
    events.truncate(MAX_EVENTS);
    events.reverse();
}

pub(crate) fn retained_events(journal: Option<&serde_json::Value>) -> Vec<Event> {
    let mut events = journal
        .and_then(|j| j.get("webviewEvents"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<Event>(value.clone()).ok())
        .filter(|event| {
            let label = &event.window_label;
            (window_identity(label) == *label
                || (label.len() == 71
                    && label.starts_with("window-")
                    && label[7..].bytes().all(|c| c.is_ascii_hexdigit())))
                && event.first_seen_ms <= event.last_seen_ms
                && event.count > 0
        })
        .collect();
    bound_events(&mut events);
    events
}

#[tauri::command(async)]
pub(crate) fn read_webview_diagnostics() -> Result<serde_json::Value, String> {
    crate::hmux_diagnostics::with_journal(|raw| {
        let journal = serde_json::from_str::<serde_json::Value>(raw).ok();
        Ok((serde_json::json!({
            "schemaVersion": 1, "state": "available", "events": retained_events(journal.as_ref()),
        }), None))
    }).map_err(|_| "webview_diagnostics_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input {
        Input {
            level: Level::Warn,
            source: Source::Console,
            code: Code::ClientSpaceWindowChanged,
        }
    }

    #[test]
    fn ingress_rejects_raw_content_and_forged_identity() {
        for extra in ["message", "stack", "windowLabel", "url", "timestamp"] {
            let mut value = serde_json::to_value(input()).unwrap();
            value[extra] = "private text".into();
            assert!(serde_json::from_value::<Input>(value).is_err());
        }
        let mut value = serde_json::to_value(input()).unwrap();
        value["code"] = "client_space_window_changed secret".into();
        assert!(serde_json::from_value::<Input>(value).is_err());
        assert_eq!(window_identity("main"), "main");
        assert_eq!(window_identity("win-123-2"), "win-123-2");
        assert!(!window_identity("win-session-private-conversation").contains("private"));
    }

    #[test]
    fn bounds_writes_per_window_and_across_window_churn() {
        let now = Instant::now();
        let mut limit = RateLimit::new(now);
        assert!(limit.admit("main", 16, now));
        assert!(limit.admit("main", 16, now));
        assert!(!limit.admit("main", 1, now));
        for i in 0..96 {
            assert!(limit.admit(&format!("win-{i}-1"), 1, now));
        }
        assert!(!limit.admit("another", 1, now));
        assert!(limit.admit("main", 16, now + INTERVAL));
        assert_eq!(limit.windows.len(), 1);
    }

    #[test]
    fn coalesces_recurrences_rotates_old_windows_and_preserves_hmux_records() {
        let raw =
            r#"{"schemaVersion":2,"events":[{"code":"hmux_transport_closed"}],"incidents":[]}"#;
        let raw = append_json(raw, "main", vec![input(), input()], 1).unwrap();
        let mut raw = append_json(&raw, "main", vec![input()], 2).unwrap();
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let events = retained_events(Some(&journal));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].count, 3);
        assert_eq!(events[0].first_seen_ms, 1);
        assert_eq!(events[0].last_seen_ms, 2);
        for i in 0..300 {
            raw = append_json(&raw, &format!("win-{i}-1"), vec![input()], 3).unwrap();
        }
        let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(retained_events(Some(&journal)).len(), MAX_EVENTS);
        assert_eq!(journal["events"][0]["code"], "hmux_transport_closed");
        assert!(raw.len() < 128 * 1024);
        assert!(!retained_events(Some(&journal))
            .iter()
            .any(|event| event.window_label == "main"));
    }

    #[test]
    fn retained_window_quota_prevents_one_window_evicting_every_peer() {
        let mut events = Vec::new();
        for label in ["main", "win-195-1"] {
            for time in 0..100 {
                events.push(Event {
                    level: Level::Error,
                    source: Source::Console,
                    code: Code::Redacted,
                    window_label: label.into(),
                    first_seen_ms: time,
                    last_seen_ms: time,
                    count: 1,
                });
            }
        }
        bound_events(&mut events);
        assert_eq!(events.len(), 128);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.window_label == "main")
                .count(),
            MAX_PER_WINDOW
        );
        assert_eq!(events[0].first_seen_ms, 36);
    }

    #[test]
    fn read_discards_untrusted_fields_and_invalid_retained_rows() {
        let raw = append_json("truncated", "main", vec![input()], 1).unwrap();
        let mut journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
        journal["webviewEvents"][0]["message"] = "private".into();
        assert!(retained_events(Some(&journal)).is_empty());
    }
}
