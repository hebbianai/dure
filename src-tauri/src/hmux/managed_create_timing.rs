//! Bounded, opt-in timings for one native Refresh. No retained runtime state.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Includes the adapter and shared checkout preparation for the same request.
const MAX_CHECKPOINTS: usize = 32;

#[derive(Clone)]
pub(crate) struct ManagedCreateTiming(Option<Arc<Capture>>);

struct Capture {
    started: Instant,
    record: Mutex<TimingRecord>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TimingRecord {
    schema_version: u16,
    event: &'static str,
    process_id: u32,
    request_fingerprint: String,
    started_at_unix_ms: u64,
    elapsed_micros: u64,
    checkpoints: Vec<Checkpoint>,
    truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    phase: &'static str,
    elapsed_micros: u64,
}

impl ManagedCreateTiming {
    pub(crate) fn new(enabled: bool, request_id: &str) -> Self {
        Self::start_with(enabled, request_id, || (Instant::now(), SystemTime::now()))
    }

    fn start_with(
        enabled: bool,
        request_id: &str,
        clocks: impl FnOnce() -> (Instant, SystemTime),
    ) -> Self {
        Self(enabled.then(|| {
            let (started, unix) = clocks();
            Arc::new(Capture {
                started,
                record: Mutex::new(TimingRecord {
                    schema_version: 1,
                    event: "managed_create_adapter_timing",
                    process_id: std::process::id(),
                    request_fingerprint: format!("{:x}", Sha256::digest(request_id.as_bytes())),
                    started_at_unix_ms: u64::try_from(
                        unix.duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis(),
                    )
                    .unwrap_or(u64::MAX),
                    elapsed_micros: 0,
                    checkpoints: Vec::with_capacity(MAX_CHECKPOINTS),
                    truncated: false,
                }),
            })
        }))
    }

    pub(crate) fn enabled(&self) -> bool {
        self.0.is_some()
    }

    pub(crate) fn observer(&self) -> impl FnMut(&'static str) + Send + 'static {
        let mut timing = self.clone();
        move |phase| timing.mark(phase)
    }

    pub(crate) fn mark(&mut self, phase: &'static str) {
        self.mark_with(phase, elapsed);
    }

    fn mark_with(&mut self, phase: &'static str, clock: impl FnOnce(Instant) -> u64) {
        let Some(capture) = self.0.as_ref() else {
            return;
        };
        let Ok(mut record) = capture.record.lock() else {
            return;
        };
        if record.checkpoints.len() == MAX_CHECKPOINTS {
            record.truncated = true;
            return;
        }
        record.checkpoints.push(Checkpoint {
            phase,
            elapsed_micros: clock(capture.started),
        });
    }
}

fn elapsed(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

impl Drop for Capture {
    fn drop(&mut self) {
        let Ok(record) = self.record.get_mut() else {
            return;
        };
        record.elapsed_micros = elapsed(self.started);
        // Test capture is thread-local and absent from product builds.
        #[cfg(test)]
        if tests::capture_record(record) {
            return;
        }
        if let Ok(record) = serde_json::to_string(record) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "[hmux-managed-create-timing] {record}"
            );
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        static RECORDS: RefCell<Option<Vec<TimingRecord>>> = const { RefCell::new(None) };
    }

    pub(super) fn capture_record(record: &TimingRecord) -> bool {
        RECORDS.with_borrow_mut(|records| {
            let Some(records) = records else { return false };
            records.push(record.clone());
            true
        })
    }

    pub(in crate::hmux) struct Records;

    impl Records {
        pub(in crate::hmux) fn start() -> Self {
            RECORDS.with_borrow_mut(|records| {
                assert!(
                    records.is_none(),
                    "timing captures cannot overlap on one thread"
                );
                *records = Some(Vec::new());
            });
            Self
        }

        pub(in crate::hmux) fn finish(self) -> Vec<serde_json::Value> {
            RECORDS
                .with_borrow_mut(|records| records.take().unwrap())
                .into_iter()
                .map(|record| serde_json::to_value(record).unwrap())
                .collect()
        }
    }

    impl Drop for Records {
        fn drop(&mut self) {
            RECORDS.with_borrow_mut(|records| *records = None);
        }
    }

    #[test]
    fn disabled_timing_reads_no_clock_and_emits_nothing() {
        let records = Records::start();
        let mut timing = ManagedCreateTiming::start_with(false, "private", || panic!("clock read"));
        assert!(!timing.enabled());
        timing.mark_with("disabled", |_| panic!("clock read"));
        let mut observer = timing.observer();
        std::thread::spawn(move || observer("disabled.worker"))
            .join()
            .unwrap();
        drop(timing);
        assert!(records.finish().is_empty());
    }

    #[test]
    fn worker_observation_shares_one_request_and_finishes_after_its_owner() {
        let records = Records::start();
        let mut timing = ManagedCreateTiming::new(true, "private-request");
        timing.mark("before.worker");
        let mut observer = timing.observer();
        std::thread::spawn(move || observer("inside.worker"))
            .join()
            .unwrap();
        timing.mark("after.worker");
        assert!(RECORDS.with_borrow(|records| records.as_ref().unwrap().is_empty()));
        drop(timing);
        let records = records.finish();
        assert_eq!(records.len(), 1);
        let phases: Vec<_> = records[0]["checkpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|point| point["phase"].as_str().unwrap())
            .collect();
        assert_eq!(phases, ["before.worker", "inside.worker", "after.worker"]);
        assert!(!records[0].to_string().contains("private-request"));
    }

    #[test]
    fn worker_keeps_capture_until_completion_after_caller_is_dropped() {
        let timing = ManagedCreateTiming::new(true, "disconnected-caller");
        let mut observer = timing.observer();
        let (release, ready) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let records = Records::start();
            ready.recv().unwrap();
            observer("worker.complete");
            drop(observer);
            records.finish()
        });
        drop(timing);
        release.send(()).unwrap();
        let records = worker.join().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["checkpoints"][0]["phase"], "worker.complete");
    }

    #[test]
    fn selected_timing_is_bounded_redacted_and_monotonic() {
        let records = Records::start();
        let mut timing = ManagedCreateTiming::new(true, "private-operation-identity");
        for _ in 0..MAX_CHECKPOINTS + 2 {
            timing.mark("stage");
        }
        drop(timing);
        let records = records.finish();
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record["truncated"], true);
        let checkpoints = record["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), MAX_CHECKPOINTS);
        let mut previous = 0;
        for checkpoint in checkpoints {
            let current = checkpoint["elapsedMicros"].as_u64().unwrap();
            assert!(current >= previous);
            previous = current;
        }
        assert!(record["elapsedMicros"].as_u64().unwrap() >= previous);
        assert_eq!(record["requestFingerprint"].as_str().unwrap().len(), 64);
        assert!(!record.to_string().contains("private-operation-identity"));
        assert!(record.to_string().len() < 4096);
    }

    #[test]
    fn selection_ends_with_the_request_including_early_errors() {
        let records = Records::start();
        let operation = |enabled| -> Result<(), ()> {
            let mut timing = ManagedCreateTiming::new(enabled, "operation");
            timing.mark("before.error");
            Err(())
        };
        for enabled in [false, true, false] {
            assert!(operation(enabled).is_err());
        }
        let records = records.finish();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["checkpoints"][0]["phase"], "before.error");
    }
}
