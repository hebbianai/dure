//! Opt-in timing for one synchronous broker request, not a Host lifecycle log.
//! The selector is the exact managed-create idempotency key. No terminal data,
//! launch payload or fabricated Host fence enters the diagnostic record.
//! Phase intervals may nest; their durations must not be added together.

use super::{MAX_FILE_BYTES, ROTATED_FILES, RotatingFileSink, record_payload, unix_time_ms};
use hmux_client::LocalSessionCatalog;
use hmux_client::recovery_journal::RecoveryReservationPhase;
use hmux_runtime_contract::{ManagedCreateAdvanceBrokerResponse, ManagedCreateRequest};
use serde::Serialize;
use std::cell::RefCell;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

const SELECTOR: &str = "HMUX_BROKER_TIMING_REQUEST";
const FILE: &str = "broker-timing.jsonl";
const LOCK: &str = ".broker-timing.lock";
const MAX_PHASES: usize = 24;

thread_local! {
    // Broker execution is synchronous. Scope guards cannot cross threads (Rc)
    // and nested requests cannot replace the active correlation identity.
    static ACTIVE: RefCell<Option<Rc<RefCell<Trace>>>> = const { RefCell::new(None) };
    #[cfg(test)]
    static CLOCK_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    ReplacementReplay,
    TargetLaunch,
    LaunchCapacity,
    LaunchCompatibility,
    LaunchAdmission,
    SourceLookup,
    ReplacementReservation,
    SourceClose,
    SourceStop,
    StopReconcile,
    StopReservation,
    StopCapacityMaintenance,
    StopReservationAfterMaintenance,
    ReplacementCompletion,
    ResponsePublish,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimedPhase {
    phase: Phase,
    start_micros: u64,
    elapsed_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reservation: Option<ReservationBreakdown>,
}

// Fixed-size counters attached to their parent interval, not additional
// top-level phases that could evict response publication from MAX_PHASES.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationBreakdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    maintenance_acquire_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    admission_lock_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_scan_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    record_scan_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capacity_maintenance_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_lock_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    record_read_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    record_publish_micros: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    event: &'static str,
    build_id: &'static str,
    process_id: u32,
    timestamp_unix_ms: String,
    request_id: String,
    session_id: String,
    workspace_id: String,
    outcome: &'static str,
    response_published: bool,
    elapsed_micros: u64,
    truncated: bool,
    phases: Vec<TimedPhase>,
}

struct Trace {
    root: PathBuf,
    started: Instant,
    record: Record,
}

pub(crate) struct RequestTiming(Option<Rc<RefCell<Trace>>>);

pub(crate) struct PhaseTiming(Option<(Rc<RefCell<Trace>>, usize, Instant)>);

pub(crate) fn begin(request: &ManagedCreateRequest) -> RequestTiming {
    RequestTiming::selected(std::env::var_os(SELECTOR).as_deref(), request, || {
        LocalSessionCatalog::from_environment()
            .ok()
            .map(|catalog| catalog.discovery_root().to_path_buf())
    })
}

impl RequestTiming {
    fn selected(
        selector: Option<&OsStr>,
        request: &ManagedCreateRequest,
        root: impl FnOnce() -> Option<PathBuf>,
    ) -> Self {
        if selector != Some(OsStr::new(request.idempotency_key())) {
            return Self(None);
        }
        let trace = ACTIVE.with(|active| {
            let mut active = active.try_borrow_mut().ok()?;
            if active.is_some() {
                return None;
            }
            let root = root()?;
            let trace = Rc::new(RefCell::new(Trace {
                root,
                started: now(),
                record: Record {
                    schema_version: 1,
                    event: "managed_create_broker_timing",
                    build_id: crate::HOST_BUILD_ID,
                    process_id: std::process::id(),
                    timestamp_unix_ms: unix_time_ms().to_string(),
                    request_id: request.idempotency_key().into(),
                    session_id: request.session_id().into(),
                    workspace_id: request.workspace_id().into(),
                    outcome: "incomplete",
                    response_published: false,
                    elapsed_micros: 0,
                    truncated: false,
                    phases: Vec::with_capacity(MAX_PHASES),
                },
            }));
            *active = Some(trace.clone());
            Some(trace)
        });
        Self(trace)
    }

    pub(crate) fn finish(self, response: &ManagedCreateAdvanceBrokerResponse, published: bool) {
        if let Some(trace) = &self.0 {
            if let Ok(mut trace) = trace.try_borrow_mut() {
                trace.record.outcome = match response {
                    ManagedCreateAdvanceBrokerResponse::Current(_) => "current",
                    ManagedCreateAdvanceBrokerResponse::Advanced(_) => "advanced",
                    ManagedCreateAdvanceBrokerResponse::Pending => "pending",
                    ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(_) => {
                        "authority_unavailable"
                    }
                    ManagedCreateAdvanceBrokerResponse::Refused(_) => "refused",
                };
                trace.record.response_published = published;
            }
        }
    }
}

impl Drop for RequestTiming {
    fn drop(&mut self) {
        let Some(trace) = self.0.take() else {
            return;
        };
        let _ = ACTIVE.try_with(|active| {
            if let Ok(mut active) = active.try_borrow_mut() {
                if active
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &trace))
                {
                    active.take();
                }
            }
        });
        let Ok(mut trace) = trace.try_borrow_mut() else {
            return;
        };
        trace.record.elapsed_micros = micros(now().saturating_duration_since(trace.started));
        let Some(payload) = record_payload(&trace.record) else {
            return;
        };
        // One best-effort append after the response; never change the broker's
        // result or wait for another process's diagnostic file lock.
        if let Ok(mut sink) =
            RotatingFileSink::open(&trace.root, FILE, LOCK, MAX_FILE_BYTES, ROTATED_FILES)
        {
            let _ = sink.append(&payload);
        }
    }
}

pub(crate) fn phase(phase: Phase) -> PhaseTiming {
    PhaseTiming(ACTIVE.with(|active| {
        let active = active.try_borrow().ok()?;
        let trace = active.as_ref()?;
        let mut data = trace.try_borrow_mut().ok()?;
        if data.record.phases.len() == MAX_PHASES {
            data.record.truncated = true;
            return None;
        }
        let started = now();
        let index = data.record.phases.len();
        let start_micros = micros(started.saturating_duration_since(data.started));
        data.record.phases.push(TimedPhase {
            phase,
            start_micros,
            elapsed_micros: None,
            reservation: None,
        });
        Some((trace.clone(), index, started))
    }))
}

impl Drop for PhaseTiming {
    fn drop(&mut self) {
        let Some((trace, index, started)) = self.0.take() else {
            return;
        };
        if let Ok(mut trace) = trace.try_borrow_mut() {
            trace.record.phases[index].elapsed_micros =
                Some(micros(now().saturating_duration_since(started)));
        }
    }
}

pub(crate) struct ReservationStepTiming {
    parent: PhaseTiming,
    step: RecoveryReservationPhase,
}

impl PhaseTiming {
    pub(crate) fn reservation_step(&self, step: RecoveryReservationPhase) -> ReservationStepTiming {
        ReservationStepTiming {
            parent: PhaseTiming(
                self.0
                    .as_ref()
                    .map(|(trace, index, _)| (trace.clone(), *index, now())),
            ),
            step,
        }
    }
}

impl Drop for ReservationStepTiming {
    fn drop(&mut self) {
        // Consume the inner guard so its Drop cannot overwrite the parent's
        // total with one substage. Disabled timing takes no clocks or storage.
        let Some((trace, index, started)) = self.parent.0.take() else {
            return;
        };
        if let Ok(mut trace) = trace.try_borrow_mut() {
            let breakdown = trace.record.phases[index]
                .reservation
                .get_or_insert_with(ReservationBreakdown::default);
            let slot = match self.step {
                RecoveryReservationPhase::MaintenanceAcquire => {
                    &mut breakdown.maintenance_acquire_micros
                }
                RecoveryReservationPhase::AdmissionLock => &mut breakdown.admission_lock_micros,
                RecoveryReservationPhase::MetadataScan => &mut breakdown.metadata_scan_micros,
                RecoveryReservationPhase::RecordScan => &mut breakdown.record_scan_micros,
                RecoveryReservationPhase::CapacityMaintenance => {
                    &mut breakdown.capacity_maintenance_micros
                }
                RecoveryReservationPhase::OperationLock => &mut breakdown.operation_lock_micros,
                RecoveryReservationPhase::RecordRead => &mut breakdown.record_read_micros,
                RecoveryReservationPhase::RecordPublish => &mut breakdown.record_publish_micros,
            };
            *slot = Some(
                slot.unwrap_or(0)
                    .saturating_add(micros(now().saturating_duration_since(started))),
            );
        }
    }
}

fn now() -> Instant {
    #[cfg(test)]
    CLOCK_READS.with(|reads| reads.set(reads.get() + 1));
    Instant::now()
}

fn micros(duration: Duration) -> u64 {
    duration.as_micros().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
