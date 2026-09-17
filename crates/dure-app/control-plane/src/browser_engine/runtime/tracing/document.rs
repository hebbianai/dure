use super::{TraceMode, capture::MAX_ARTIFACT_BYTES};
use serde_json::{Value, json};

const MAX_PROFILE_EVENTS: usize = 5_000_000;

pub(super) struct Document {
    bytes: Vec<u8>,
    suffix: Vec<u8>,
    count: usize,
    limit: usize,
    pub dropped: bool,
}

impl Document {
    pub(super) fn new(mode: &TraceMode) -> Self {
        let mut suffix = b"]".to_vec();
        let profiler = matches!(mode, TraceMode::Profiler { .. });
        if profiler {
            let clock = if cfg!(target_os = "macos") {
                Some("MAC_MACH_ABSOLUTE_TIME")
            } else if cfg!(target_os = "linux") {
                Some("LINUX_CLOCK_MONOTONIC")
            } else {
                None
            };
            if let Some(clock) = clock {
                suffix.extend(b",\"metadata\":");
                suffix.extend(json!({"clock-domain":clock}).to_string().as_bytes());
            }
        }
        suffix.push(b'}');
        Self {
            bytes: b"{\"traceEvents\":[".to_vec(),
            suffix,
            count: 0,
            limit: if profiler {
                MAX_PROFILE_EVENTS
            } else {
                usize::MAX
            },
            dropped: false,
        }
    }

    pub(super) fn append(&mut self, events: &Value) -> Result<(), &'static str> {
        let events = events.as_array().ok_or("browser_trace_events_invalid")?;
        if self.count.saturating_add(events.len()) > self.limit {
            self.dropped = true;
            return Ok(());
        }
        for event in events {
            if !event.is_object() {
                return Err("browser_trace_event_invalid");
            }
            let bytes = serde_json::to_vec(event).map_err(|_| "browser_trace_event_invalid")?;
            if self
                .bytes
                .len()
                .saturating_add(bytes.len())
                .saturating_add(self.suffix.len())
                .saturating_add(usize::from(self.count > 0))
                > MAX_ARTIFACT_BYTES
            {
                return Err("browser_trace_byte_limit");
            }
            if self.count > 0 {
                self.bytes.push(b',');
            }
            self.bytes.extend(bytes);
            self.count += 1;
        }
        Ok(())
    }

    pub(super) fn finish(mut self) -> (Vec<u8>, usize) {
        self.bytes.extend(self.suffix);
        (self.bytes, self.count)
    }
}
