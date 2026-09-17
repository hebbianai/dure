use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use hmux_host::local_protocol::{ErrorCode, ErrorFrame, FrameBody, RetryPosture};
use hmux_host::session_host::SessionHostError;
use hmux_host::terminal_replay::{
    CapturedViewportSource, TerminalReplayError, ViewProjection, ViewportCaptureRequest,
};
use hmux_runtime_contract::TERMINAL_VIEWPORT_MULTIPART_CAPABILITY;

use crate::host_resource_budget::RetainedActiveConnection;
use crate::subscriber_delivery::PreparedFrame;

use super::super::{Result, ServerState};
use super::StructuredRecordEncodingError;

const VIEWPORT_SOURCE_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const VIEWPORT_TOTAL_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
// ponytail: one Host-wide 30 Hz cap is enough for text output; split the
// cadence by attachment only if a future surface needs a higher refresh rate.
const VIEWPORT_PROJECTION_INTERVAL: Duration = Duration::from_millis(33);

#[derive(Default)]
struct ViewportCaptureBudgetState {
    used_bytes: usize,
}

pub(crate) struct ViewportCaptureBudget {
    state: Mutex<ViewportCaptureBudgetState>,
    changed: Condvar,
}

impl ViewportCaptureBudget {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ViewportCaptureBudgetState::default()),
            changed: Condvar::new(),
        })
    }

    fn reserve(self: &Arc<Self>) -> Option<ViewportCaptureReservation> {
        let mut state = self.state.lock().ok()?;
        while state
            .used_bytes
            .checked_add(VIEWPORT_SOURCE_CAPTURE_BYTES)
            .is_none_or(|next| next > VIEWPORT_TOTAL_CAPTURE_BYTES)
        {
            state = self.changed.wait(state).ok()?;
        }
        state.used_bytes += VIEWPORT_SOURCE_CAPTURE_BYTES;
        Some(ViewportCaptureReservation {
            budget: Arc::clone(self),
            bytes: VIEWPORT_SOURCE_CAPTURE_BYTES,
        })
    }

    fn try_reserve(self: &Arc<Self>) -> Option<ViewportCaptureReservation> {
        let mut state = self.state.lock().ok()?;
        let next = state
            .used_bytes
            .checked_add(VIEWPORT_SOURCE_CAPTURE_BYTES)?;
        if next > VIEWPORT_TOTAL_CAPTURE_BYTES {
            return None;
        }
        state.used_bytes = next;
        Some(ViewportCaptureReservation {
            budget: Arc::clone(self),
            bytes: VIEWPORT_SOURCE_CAPTURE_BYTES,
        })
    }
}

struct ViewportCaptureReservation {
    budget: Arc<ViewportCaptureBudget>,
    bytes: usize,
}

impl ViewportCaptureReservation {
    fn shrink_to(&mut self, bytes: usize) -> bool {
        if bytes > self.bytes {
            return false;
        }
        let released = self.bytes - bytes;
        let Ok(mut state) = self.budget.state.lock() else {
            return false;
        };
        let Some(remaining) = state.used_bytes.checked_sub(released) else {
            return false;
        };
        state.used_bytes = remaining;
        self.bytes = bytes;
        self.budget.changed.notify_all();
        true
    }
}

impl Drop for ViewportCaptureReservation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.budget.state.lock() {
            if let Some(remaining) = state.used_bytes.checked_sub(self.bytes) {
                state.used_bytes = remaining;
                self.budget.changed.notify_all();
            }
        }
    }
}

#[derive(Default)]
struct PublicationState {
    generation: u64,
    completed_generation: u64,
    last_projection_started_at: Option<Instant>,
    output_after_input: Option<PendingInputOutputTiming>,
    latest_input_output_timing: Option<ObservedInputOutputTiming>,
    closed: bool,
}

#[derive(Clone, Copy)]
struct PendingInputOutputTiming {
    input_baseline_output_sequence: u64,
    input_accepted_at: Instant,
    correlation: Option<crate::pty_input::InputTimingCorrelation>,
}

#[derive(Clone, Copy)]
struct ObservedInputOutputTiming {
    client_id: u64,
    input_record_id: u64,
    input_baseline_output_sequence: u64,
    first_output_sequence: u64,
    input_to_output: Duration,
    output_observed_at: Instant,
}

impl ObservedInputOutputTiming {
    fn project_at(
        self,
        projection_started_at: Instant,
    ) -> terminal_state_protocol::InputOutputTiming {
        terminal_state_protocol::InputOutputTiming {
            input_baseline_output_sequence: self.input_baseline_output_sequence,
            first_output_sequence: self.first_output_sequence,
            input_to_output_micros: duration_micros(self.input_to_output),
            output_to_projection_start_micros: duration_micros(
                projection_started_at.saturating_duration_since(self.output_observed_at),
            ),
            input_record_id: self.input_record_id,
        }
    }
}

fn duration_micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublicationSealOutcome {
    Sealed,
    GenerationChanged,
    Unavailable,
}

/// Capacity-one wakeup for complete viewport projection.
///
/// Mutating the terminal only advances a generation. One worker consumes the
/// latest generation after the preceding attachment work completes, then
/// bounds continuous complete frame capture and encoding to display cadence.
pub(crate) struct ViewportProjectionPublication {
    state: Mutex<PublicationState>,
    changed: Condvar,
}

/// Completion capability for the attachments actually scheduled by one pass.
///
/// Receipt-blocked attachments are deliberately absent: their release creates
/// a newer publication generation. Provider exit retains the separate all-
/// attachment fence that accounts for those ordered receipts.
pub(crate) struct ScheduledViewportProjectionPass {
    generation: u64,
    projections: Vec<Arc<AttachmentViewportProjection>>,
}

impl ScheduledViewportProjectionPass {
    pub(crate) fn wait_completed(self) -> bool {
        self.projections
            .into_iter()
            .all(|projection| projection.wait_completed_through(self.generation))
    }
}

struct AttachmentProjectionJob {
    generation: u64,
    observed_revision: u64,
    publication_blocked: Arc<AtomicBool>,
    publication_revision: Arc<AtomicU64>,
    projection: ViewProjection,
    source: CapturedViewportSource,
    input_output_timing: Option<ObservedInputOutputTiming>,
    _capture_reservation: Arc<ViewportCaptureReservation>,
}

struct AttachmentProjectionCandidate {
    client_id: u64,
    projection: Arc<AttachmentViewportProjection>,
    publication_blocked: Arc<AtomicBool>,
    publication_revision: Arc<AtomicU64>,
    observed_revision: u64,
    request: ViewportCaptureRequest,
    projected: ViewProjection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttachmentScheduleOutcome {
    Scheduled,
    Stale,
    Unavailable,
}

/// Why one viewport publication attempt stopped, carried to the retirement
/// that closes the attachment so the peer is told rather than merely dropped.
///
/// `reported` marks the refusals that already delivered a richer frame (a
/// missing capability, an encoded-size bound). Those must not be overwritten
/// by the generic retirement reason.
struct ViewportPublishFailure {
    reason: String,
    reported: bool,
}

impl ViewportPublishFailure {
    fn unreported(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            reported: false,
        }
    }

    fn reported(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            reported: true,
        }
    }

    fn unreported_reason(&self) -> Option<&str> {
        (!self.reported).then_some(self.reason.as_str())
    }
}

type PublishResult = std::result::Result<(), ViewportPublishFailure>;

/// Whether a successor attach can undo the condition that retired an
/// attachment. The peer decides what to do from this, so a caller that cannot
/// resume must not advertise `Retryable`: reattaching then succeeds, seeds one
/// frame, keeps accepting keystrokes, and never delivers another frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ViewportRetirement {
    Retryable,
    Final,
}

impl ViewportRetirement {
    fn retry_posture(self) -> RetryPosture {
        match self {
            Self::Retryable => RetryPosture::Reconnect,
            Self::Final => RetryPosture::Never,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttachmentCommitOutcome {
    Committed,
    MutationStale,
    ProjectionStale,
    Unavailable,
}

#[derive(Default)]
struct AttachmentProjectionState {
    pending: Option<AttachmentProjectionJob>,
    completed_generation: u64,
    closed: bool,
    #[cfg(test)]
    maximum_pending: usize,
}

/// One attachment's independently scheduled projection state.
///
/// A worker may own one running job while this slot retains only the newest
/// pending generation. The canonical `ViewProjection` mutex is held only to
/// fork/commit scalar state, never across hot/cold projection or encoding.
pub(crate) struct AttachmentViewportProjection {
    projection: Mutex<ViewProjection>,
    state: Mutex<AttachmentProjectionState>,
    changed: Condvar,
}

impl AttachmentViewportProjection {
    pub(crate) fn new(projection: ViewProjection) -> Arc<Self> {
        Arc::new(Self {
            projection: Mutex::new(projection),
            state: Mutex::new(AttachmentProjectionState::default()),
            changed: Condvar::new(),
        })
    }

    fn schedule(&self, job: AttachmentProjectionJob) -> AttachmentScheduleOutcome {
        let Ok(mut state) = self.state.lock() else {
            return AttachmentScheduleOutcome::Unavailable;
        };
        if state.closed || job.generation <= state.completed_generation {
            return AttachmentScheduleOutcome::Stale;
        }
        state.pending = Some(job);
        #[cfg(test)]
        {
            state.maximum_pending = state
                .maximum_pending
                .max(usize::from(state.pending.is_some()));
        }
        self.changed.notify_one();
        AttachmentScheduleOutcome::Scheduled
    }

    fn wait_job(&self) -> Option<AttachmentProjectionJob> {
        let mut state = self.state.lock().ok()?;
        while !state.closed && state.pending.is_none() {
            state = self.changed.wait(state).ok()?;
        }
        (!state.closed).then(|| state.pending.take()).flatten()
    }

    fn capture_request(
        &self,
        publication_revision: &AtomicU64,
    ) -> Option<(ViewportCaptureRequest, ViewProjection, u64)> {
        let projection = self.projection.lock().ok()?;
        let projected = projection.fork_for_projection();
        let request = projected.capture_request()?;
        let observed_revision = publication_revision.load(Ordering::Acquire);
        Some((request, projected, observed_revision))
    }

    fn commit_projection(
        &self,
        publication_revision: &AtomicU64,
        observed_revision: u64,
        projected: ViewProjection,
    ) -> AttachmentCommitOutcome {
        let Ok(mut projection) = self.projection.lock() else {
            return AttachmentCommitOutcome::Unavailable;
        };
        if publication_revision.load(Ordering::Acquire) != observed_revision {
            return AttachmentCommitOutcome::MutationStale;
        }
        match projection.commit_projected(projected) {
            Ok(true) => AttachmentCommitOutcome::Committed,
            Ok(false) => AttachmentCommitOutcome::ProjectionStale,
            Err(_) => AttachmentCommitOutcome::Unavailable,
        }
    }

    pub(crate) fn with_projection<T>(
        &self,
        apply: impl FnOnce(&mut ViewProjection) -> T,
    ) -> Option<T> {
        self.projection
            .lock()
            .ok()
            .map(|mut projection| apply(&mut projection))
    }

    pub(super) fn mark_completed(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.completed_generation = state.completed_generation.max(generation);
            self.changed.notify_all();
        }
    }

    pub(crate) fn wait_completed_through(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while !state.closed && state.completed_generation < generation {
            let Ok(next) = self.changed.wait(state) else {
                return false;
            };
            state = next;
        }
        state.closed || state.completed_generation >= generation
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending = None;
            self.changed.notify_all();
        }
    }

    #[cfg(test)]
    fn maximum_pending(&self) -> usize {
        self.state
            .lock()
            .map_or(usize::MAX, |state| state.maximum_pending)
    }
}

impl ViewportProjectionPublication {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(PublicationState::default()),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn mark_dirty(&self) -> bool {
        self.mark_dirty_for_output(None)
    }

    pub(crate) fn arm_next_output_after_input(
        &self,
        output_sequence: u64,
        input_accepted_at: Instant,
        correlation: Option<crate::pty_input::InputTimingCorrelation>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        if state
            .output_after_input
            .is_none_or(|pending| output_sequence > pending.input_baseline_output_sequence)
        {
            state.output_after_input = Some(PendingInputOutputTiming {
                input_baseline_output_sequence: output_sequence,
                input_accepted_at,
                correlation,
            });
        }
    }

    pub(crate) fn mark_output_dirty(
        &self,
        output_sequence: u64,
        output_observed_at: Instant,
    ) -> bool {
        self.mark_dirty_for_output(Some((output_sequence, output_observed_at)))
    }

    fn mark_dirty_for_output(&self, output: Option<(u64, Instant)>) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.closed {
            return false;
        }
        let Some(generation) = state.generation.checked_add(1) else {
            state.closed = true;
            self.changed.notify_all();
            return false;
        };
        state.generation = generation;
        if let Some((output_sequence, output_observed_at)) = output {
            if let Some(pending) = state
                .output_after_input
                .filter(|pending| output_sequence > pending.input_baseline_output_sequence)
            {
                state.output_after_input = None;
                // Complete viewport generations may coalesce. An unmeasured
                // follow-up has no timing value that can replace an exact one.
                if let Some(correlation) = pending.correlation {
                    state.latest_input_output_timing = Some(ObservedInputOutputTiming {
                        client_id: correlation.client_id,
                        input_record_id: correlation.record_id,
                        input_baseline_output_sequence: pending.input_baseline_output_sequence,
                        first_output_sequence: output_sequence,
                        input_to_output: output_observed_at
                            .saturating_duration_since(pending.input_accepted_at),
                        output_observed_at,
                    });
                }
                state.last_projection_started_at = None;
            }
        }
        self.changed.notify_one();
        true
    }

    fn latest_input_output_timing(&self) -> Option<ObservedInputOutputTiming> {
        self.state.lock().ok()?.latest_input_output_timing
    }

    pub(crate) fn wait_after(&self, observed: u64) -> Option<u64> {
        let mut state = self.state.lock().ok()?;
        while !state.closed && state.generation <= observed {
            state = self.changed.wait(state).ok()?;
        }
        while !state.closed {
            let Some(remaining) = state
                .last_projection_started_at
                .and_then(|started| VIEWPORT_PROJECTION_INTERVAL.checked_sub(started.elapsed()))
            else {
                break;
            };
            state = self.changed.wait_timeout(state, remaining).ok()?.0;
        }
        if state.closed {
            return None;
        }
        state.last_projection_started_at = Some(Instant::now());
        Some(state.generation)
    }

    pub(crate) fn current_generation(&self) -> Option<u64> {
        let state = self.state.lock().ok()?;
        (!state.closed).then_some(state.generation)
    }

    pub(crate) fn mark_completed(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.closed || generation > state.generation {
            return false;
        }
        state.completed_generation = state.completed_generation.max(generation);
        self.changed.notify_all();
        true
    }

    pub(crate) fn wait_completed_through(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while !state.closed && state.completed_generation < generation {
            let Ok(next) = self.changed.wait(state) else {
                return false;
            };
            state = next;
        }
        !state.closed && state.completed_generation >= generation
    }

    fn seal_completed_generation(&self, generation: u64) -> PublicationSealOutcome {
        let Ok(mut state) = self.state.lock() else {
            return PublicationSealOutcome::Unavailable;
        };
        if state.closed {
            return PublicationSealOutcome::Unavailable;
        }
        if state.generation != generation || state.completed_generation < generation {
            return PublicationSealOutcome::GenerationChanged;
        }
        state.closed = true;
        self.changed.notify_all();
        PublicationSealOutcome::Sealed
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.changed.notify_all();
        }
    }
}

/// Seal one stable publication generation while holding the same fence used
/// by attachment mutations. Waiting stays outside that fence; only the final
/// generation compare-and-seal is serialized with mutation plus `mark_dirty`.
fn close_after_dependents_complete<T>(
    publication: &ViewportProjectionPublication,
    mutation_fence: &Mutex<T>,
    mut wait_dependents: impl FnMut(u64) -> bool,
) -> Option<u64> {
    loop {
        let generation = publication.current_generation()?;
        if !publication.wait_completed_through(generation) || !wait_dependents(generation) {
            return None;
        }
        let _mutation = mutation_fence.lock().ok()?;
        match publication.seal_completed_generation(generation) {
            PublicationSealOutcome::Sealed => return Some(generation),
            PublicationSealOutcome::GenerationChanged => continue,
            PublicationSealOutcome::Unavailable => return None,
        }
    }
}

impl ServerState {
    pub(crate) fn capture_initial_attachment_viewport(
        &self,
        host: &mut hmux_host::session_host::SessionHost,
        projection: &mut ViewProjection,
    ) -> Result<terminal_state_protocol::TerminalStateRecord> {
        let request = projection
            .capture_request()
            .ok_or("initial terminal viewport projection is unavailable")?;
        let mut reservation = self
            .viewport_capture_budget
            .try_reserve()
            .ok_or("initial terminal viewport capture capacity is unavailable")?;
        let source = host.capture_viewport_source(
            &self.fence,
            std::slice::from_ref(&request),
            VIEWPORT_SOURCE_CAPTURE_BYTES,
        )?;
        if !reservation.shrink_to(source.accounted_capture_bytes()) {
            return Err("initial terminal viewport capture exceeded its reservation".into());
        }
        Ok(source
            .capture_latest_viewport_frame(projection)?
            .ok_or("initial terminal viewport capture produced no frame")?
            .finish()?)
    }

    pub(crate) fn close_terminal_viewport_publication(&self) -> Option<u64> {
        close_after_dependents_complete(
            &self.viewport_publication,
            &self.terminal_surfaces,
            |generation| self.wait_attachment_viewports_completed_through(generation),
        )
    }

    pub(crate) fn retire_terminal_viewport_attachments(
        &self,
        reason: &str,
        retirement: ViewportRetirement,
    ) -> usize {
        let client_ids = self
            .terminal_surfaces
            .lock()
            .map(|actor| {
                actor
                    .surfaces
                    .iter()
                    .filter_map(|(client_id, surface)| {
                        surface.projection.is_some().then_some(*client_id)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let retired = client_ids.len();
        for client_id in client_ids {
            self.retire_viewport_attachment(client_id, Some(reason), retirement);
        }
        retired
    }

    /// Retiring a viewport attachment is this runtime's decision, so this
    /// runtime owes the peer the reason. A bare close is byte-identical to
    /// every other closed transport, which leaves the client able to report
    /// only the symptom — that is why unrelated Host-side failures have kept
    /// arriving as one indistinguishable message.
    ///
    /// The queue drains before it reports end-of-stream, so the reason
    /// normally reaches the peer even though the retirement seals the
    /// subscriber. It does not when the queue is already in backpressure: that
    /// lane replaces pending records with its own resource-limit frame. The
    /// reason is therefore also recorded here, because the peer is exactly the
    /// party that may already be gone.
    ///
    /// `reason` is `None` only when a more specific failure frame was already
    /// delivered, so the peer never receives two competing explanations.
    pub(crate) fn retire_viewport_attachment(
        &self,
        client_id: u64,
        reason: Option<&str>,
        retirement: ViewportRetirement,
    ) {
        if let Some(reason) = reason {
            eprintln!("hmux-runtime: retired viewport attachment for client {client_id}: {reason}");
            if let Some(delivery) = self.subscribers.delivery(client_id).ok().flatten() {
                let mut failure = PreparedFrame::new(FrameBody::Error(ErrorFrame {
                    origin_code: None,
                    code: ErrorCode::TransportClosed,
                    message: format!("Hmux retired this terminal viewport attachment: {reason}"),
                    retry: retirement.retry_posture(),
                    required_capability: None,
                    supported_versions: None,
                    in_reply_to_request_id: None,
                }));
                let _ = delivery.deliver(&mut failure);
            }
        }
        self.retire_attachment(client_id);
    }

    pub(crate) fn schedule_latest_terminal_viewports(
        &self,
        generation: u64,
    ) -> Result<ScheduledViewportProjectionPass> {
        if projection_pass_fault_injected_for_test() {
            return Err("terminal viewport projection pass was fault-injected".into());
        }
        let candidates = {
            let Ok(actor) = self.terminal_surfaces.lock() else {
                return Err("terminal viewport surface registry is unavailable".into());
            };
            let mut candidates = Vec::new();
            for (client_id, surface) in &actor.surfaces {
                let Some(projection) = surface.projection.as_ref() else {
                    continue;
                };
                if surface.frame_receipt_barrier.is_some() {
                    // Completion remains outstanding until the ordered receipt
                    // releases a newer frame generation. Detach closes the
                    // projection, so an abandoned receipt cannot strand exit.
                    continue;
                }
                let Some((request, projected, observed_revision)) =
                    projection.capture_request(&surface.publication_revision)
                else {
                    return Err("terminal viewport capture request is unavailable".into());
                };
                candidates.push(AttachmentProjectionCandidate {
                    client_id: *client_id,
                    projection: Arc::clone(projection),
                    publication_blocked: Arc::clone(&surface.publication_blocked),
                    publication_revision: Arc::clone(&surface.publication_revision),
                    observed_revision,
                    request,
                    projected,
                });
            }
            candidates
        };
        let mut projections = Vec::with_capacity(candidates.len());
        if !candidates.is_empty() {
            self.schedule_terminal_viewport_batches(generation, candidates, &mut projections)?;
        }
        Ok(ScheduledViewportProjectionPass {
            generation,
            projections,
        })
    }

    fn schedule_terminal_viewport_batches(
        &self,
        generation: u64,
        candidates: Vec<AttachmentProjectionCandidate>,
        scheduled: &mut Vec<Arc<AttachmentViewportProjection>>,
    ) -> Result<()> {
        let mut batches = vec![candidates];
        while let Some(mut batch) = batches.pop() {
            let requests = batch
                .iter()
                .map(|candidate| candidate.request.clone())
                .collect::<Vec<_>>();
            let Some(mut reservation) = self.viewport_capture_budget.reserve() else {
                return Err("terminal viewport capture budget is unavailable".into());
            };
            if record_viewport_source_capture_for_test(generation).is_err() {
                return Err("terminal viewport capture could not be recorded".into());
            }
            let captured = {
                let Ok(mut host) = self.host.lock() else {
                    return Err("terminal viewport Host actor is unavailable".into());
                };
                host.capture_viewport_source(&self.fence, &requests, VIEWPORT_SOURCE_CAPTURE_BYTES)
            };
            // A rejected union is split outside the Host actor. Give queued
            // PTY input the lock before attempting the next bounded capture.
            std::thread::yield_now();
            let source = match captured {
                Ok(source) => source,
                Err(SessionHostError::TerminalReplay(
                    TerminalReplayError::ViewportCaptureBudgetExceeded { .. },
                )) if batch.len() > 1 => {
                    let later = batch.split_off(batch.len() / 2);
                    batches.push(later);
                    batches.push(batch);
                    continue;
                }
                Err(SessionHostError::TerminalReplay(
                    TerminalReplayError::ViewportCaptureBudgetExceeded { .. },
                )) => {
                    let candidate = batch.pop().expect("one capture candidate remains");
                    self.deliver_viewport_capture_resource_limit(candidate.client_id);
                    candidate.projection.mark_completed(generation);
                    self.retire_viewport_attachment(
                        candidate.client_id,
                        None,
                        ViewportRetirement::Retryable,
                    );
                    continue;
                }
                Err(error) => {
                    return Err(format!("terminal viewport source capture failed: {error}").into());
                }
            };
            if !reservation.shrink_to(source.accounted_capture_bytes()) {
                return Err("terminal viewport capture exceeded its reservation".into());
            }
            // Observe correlation only after the immutable Host source exists.
            // A newer timing can then be rejected by that source's output
            // high-water and converge through the already-pending generation.
            let input_output_timing = self.viewport_publication.latest_input_output_timing();
            let reservation = Arc::new(reservation);
            for candidate in batch {
                let AttachmentProjectionCandidate {
                    client_id,
                    projection,
                    publication_blocked,
                    publication_revision,
                    observed_revision,
                    projected,
                    ..
                } = candidate;
                match projection.schedule(AttachmentProjectionJob {
                    generation,
                    observed_revision,
                    publication_blocked,
                    publication_revision,
                    projection: projected,
                    source: source.clone(),
                    input_output_timing: input_output_timing
                        .filter(|timing| timing.client_id == client_id),
                    _capture_reservation: Arc::clone(&reservation),
                }) {
                    AttachmentScheduleOutcome::Scheduled => scheduled.push(projection),
                    AttachmentScheduleOutcome::Stale => {}
                    AttachmentScheduleOutcome::Unavailable => {
                        return Err("terminal viewport projection worker is unavailable".into());
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn spawn_attachment_projection_worker(
        self: &Arc<Self>,
        client_id: u64,
        projection: Arc<AttachmentViewportProjection>,
        active_connection: RetainedActiveConnection,
    ) {
        let state = Arc::downgrade(self);
        std::thread::spawn(move || {
            let _active_connection = active_connection;
            while let Some(job) = projection.wait_job() {
                let generation = job.generation;
                let outcome = match state.upgrade() {
                    Some(state) => state.publish_attachment_viewport(client_id, &projection, job),
                    None => Err(ViewportPublishFailure::unreported(
                        "the terminal viewport runtime is shutting down",
                    )),
                };
                projection.mark_completed(generation);
                if let Err(failure) = outcome {
                    if let Some(state) = state.upgrade() {
                        state.retire_viewport_attachment(
                            client_id,
                            failure.unreported_reason(),
                            ViewportRetirement::Retryable,
                        );
                    }
                    return;
                }
            }
        });
    }

    fn publish_attachment_viewport(
        &self,
        client_id: u64,
        projection: &AttachmentViewportProjection,
        job: AttachmentProjectionJob,
    ) -> PublishResult {
        if pause_attachment_projection_for_test().is_err() {
            return Err(ViewportPublishFailure::unreported(
                "the terminal viewport projector could not pause",
            ));
        }
        if job.publication_blocked.load(Ordering::Acquire)
            || job.publication_revision.load(Ordering::Acquire) != job.observed_revision
        {
            return Ok(());
        }
        let projection_started_at = Instant::now();
        let input_output_timing = job.input_output_timing;
        let mut projected = job.projection;
        let capture = match job.source.capture_latest_viewport_frame(&mut projected) {
            Ok(Some(capture)) => capture,
            Ok(None) => return Ok(()),
            Err(error) => {
                return Err(ViewportPublishFailure::unreported(format!(
                    "terminal viewport projection failed: {error}"
                )));
            }
        };
        let mut record = match capture.finish() {
            Ok(record) => record,
            Err(error) => {
                return Err(ViewportPublishFailure::unreported(format!(
                    "terminal viewport encoding failed: {error}"
                )));
            }
        };
        if let Some(timing) = input_output_timing
            .filter(|timing| timing.first_output_sequence <= record.through_output_seq)
        {
            let Some(terminal_state_protocol::terminal_state_record::Body::ViewportFrame(frame)) =
                record.body.as_mut()
            else {
                return Err(ViewportPublishFailure::unreported(
                    "terminal viewport capture produced a non-viewport record",
                ));
            };
            frame.input_output_timing = Some(timing.project_at(projection_started_at));
        }
        let Some(delivery) = self.subscribers.delivery(client_id).ok().flatten() else {
            // Nothing was delivered here, so this is not `reported`: the lookup
            // also collapses a poisoned subscriber registry into the same None,
            // and that peer may still be connected and owed a reason.
            return Err(ViewportPublishFailure::unreported(
                "the terminal viewport subscriber is unavailable",
            ));
        };
        let terminal_base_protocol_minor = delivery
            .terminal_base_protocol_minor()
            .unwrap_or(hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR);
        let prepared = match Self::prepare_structured_batch(
            record,
            terminal_base_protocol_minor,
            delivery.supports_viewport_multipart(),
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                let Ok(_publish_order) = self.publish_order.lock() else {
                    return Err(ViewportPublishFailure::unreported(
                        "the terminal viewport publish order is unavailable",
                    ));
                };
                return Err(self.refuse_viewport_encoding(&delivery, &error));
            }
        };
        if job.publication_blocked.load(Ordering::Acquire) {
            return Ok(());
        }
        match projection.commit_projection(
            &job.publication_revision,
            job.observed_revision,
            projected,
        ) {
            AttachmentCommitOutcome::Committed => {}
            AttachmentCommitOutcome::MutationStale => return Ok(()),
            AttachmentCommitOutcome::ProjectionStale => {
                let _ = self.viewport_publication.mark_dirty();
                return Ok(());
            }
            AttachmentCommitOutcome::Unavailable => {
                return Err(ViewportPublishFailure::unreported(
                    "the terminal viewport projection could not be committed",
                ));
            }
        }
        let Ok(_publish_order) = self.publish_order.lock() else {
            return Err(ViewportPublishFailure::unreported(
                "the terminal viewport publish order is unavailable",
            ));
        };
        if job.publication_blocked.load(Ordering::Acquire)
            || job.publication_revision.load(Ordering::Acquire) != job.observed_revision
        {
            return Ok(());
        }
        let batch = match self.sequence_prepared_structured_batch(prepared) {
            Ok(batch) => batch,
            Err(error) => return Err(self.refuse_viewport_encoding(&delivery, &error)),
        };
        if delivery.deliver_viewport(&batch) {
            Ok(())
        } else {
            // deliver_viewport returns false for several conditions and only
            // the backpressure lane emits a frame of its own, so the reason
            // stays unreported and the retirement supplies it.
            Err(ViewportPublishFailure::unreported(
                "the terminal viewport queue refused its frame",
            ))
        }
    }

    /// Reports an encoding refusal the peer can act on, and answers whether it
    /// could. A refusal this function cannot name falls back to the generic
    /// retirement reason rather than closing in silence.
    fn refuse_viewport_encoding(
        &self,
        delivery: &Arc<crate::subscriber_delivery::SubscriberDelivery>,
        error: &super::super::DynError,
    ) -> ViewportPublishFailure {
        let encoding_error = error.downcast_ref::<StructuredRecordEncodingError>();
        let failure = if let Some((actual, maximum)) =
            encoding_error.and_then(StructuredRecordEncodingError::viewport_multipart_bounds)
        {
            Some(ErrorFrame {
                code: ErrorCode::UnsupportedCapability,
                origin_code: None,
                message: format!(
                    "complete viewport requires {TERMINAL_VIEWPORT_MULTIPART_CAPABILITY} capability ({actual} encoded bytes, single-record maximum {maximum})"
                ),
                retry: RetryPosture::Never,
                required_capability: Some(TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string()),
                supported_versions: None,
                in_reply_to_request_id: None,
            })
        } else if let Some((actual, maximum)) =
            encoding_error.and_then(StructuredRecordEncodingError::resource_limit_bounds)
        {
            Some(ErrorFrame {
                code: ErrorCode::ResourceLimit,
                origin_code: None,
                message: format!(
                    "complete viewport requires {actual} encoded bytes, maximum is {maximum}"
                ),
                retry: RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            })
        } else {
            None
        };
        let Some(failure) = failure else {
            return ViewportPublishFailure::unreported(format!(
                "terminal viewport encoding failed: {error}"
            ));
        };
        let reason = failure.message.clone();
        let mut failure = PreparedFrame::new(FrameBody::Error(failure));
        let _ = delivery.deliver(&mut failure);
        ViewportPublishFailure::reported(reason)
    }

    fn deliver_viewport_capture_resource_limit(&self, client_id: u64) {
        let Some(delivery) = self.subscribers.delivery(client_id).ok().flatten() else {
            return;
        };
        let mut failure = PreparedFrame::new(FrameBody::Error(ErrorFrame {
            origin_code: None,
            code: ErrorCode::ResourceLimit,
            message: format!(
                "complete viewport requires more than {VIEWPORT_SOURCE_CAPTURE_BYTES} capture bytes"
            ),
            retry: RetryPosture::Never,
            required_capability: None,
            supported_versions: None,
            in_reply_to_request_id: None,
        }));
        let _ = delivery.deliver(&mut failure);
    }

    pub(crate) fn wait_attachment_viewports_completed_through(&self, generation: u64) -> bool {
        let projections = self
            .terminal_surfaces
            .lock()
            .map(|actor| {
                actor
                    .surfaces
                    .values()
                    .filter_map(|surface| surface.projection.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        projections
            .into_iter()
            .all(|projection| projection.wait_completed_through(generation))
    }

    pub(crate) fn close_attachment_viewport_workers(&self) {
        let projections = self
            .terminal_surfaces
            .lock()
            .map(|actor| {
                actor
                    .surfaces
                    .values()
                    .filter_map(|surface| surface.projection.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for projection in projections {
            projection.close();
        }
    }
}

#[cfg(debug_assertions)]
fn viewport_projection_work_marker_for_test() -> std::io::Result<Option<std::path::PathBuf>> {
    const WORK_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_VIEWPORT_PROJECTION_WORK_MARKER";

    let Some(marker) = std::env::var_os(WORK_MARKER_ENV).map(std::path::PathBuf::from) else {
        return Ok(None);
    };
    if !marker.is_absolute() {
        return Err(std::io::Error::other(
            "viewport projection work marker must be absolute",
        ));
    }
    if !marker.with_extension("arm").try_exists()? {
        return Ok(None);
    }
    Ok(Some(marker))
}

#[cfg(debug_assertions)]
fn record_viewport_source_capture_for_test(generation: u64) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let Some(marker) = viewport_projection_work_marker_for_test()? else {
        return Ok(());
    };
    let mut captures = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(marker.with_extension("captures"))?;
    writeln!(captures, "{generation}")
}

#[cfg(not(debug_assertions))]
fn record_viewport_source_capture_for_test(_generation: u64) -> std::io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn pause_attachment_projection_for_test() -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let Some(marker) = viewport_projection_work_marker_for_test()? else {
        return Ok(());
    };
    let mut paused = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
    {
        Ok(paused) => paused,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    paused.write_all(b"attachment_projection_paused")?;
    paused.sync_all()?;
    while !marker.with_extension("release").try_exists()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_attachment_projection_for_test() -> std::io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn projection_pass_fault_injected_for_test() -> bool {
    const FAULT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_VIEWPORT_PROJECTION_FAULT_MARKER";

    let Some(marker) = std::env::var_os(FAULT_MARKER_ENV).map(std::path::PathBuf::from) else {
        return false;
    };
    if !marker.is_absolute() {
        return false;
    }
    match std::fs::remove_file(marker) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

#[cfg(not(debug_assertions))]
fn projection_pass_fault_injected_for_test() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_protocol::SessionFence;
    use hmux_host::terminal_replay::{TerminalReplay, TerminalReplayLimits};

    use crate::terminal_surface::actor::{TerminalSurfaceActor, TerminalSurfaceMutation};

    fn replay() -> TerminalReplay {
        TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "attachment-capacity-one".into(),
            },
            24,
            80,
            TerminalReplayLimits::default(),
        )
        .unwrap()
    }

    fn capture_reservation() -> Arc<ViewportCaptureReservation> {
        Arc::new(ViewportCaptureBudget::new().reserve().unwrap())
    }

    fn attachment_job(
        generation: u64,
        attachment: &AttachmentViewportProjection,
        blocked: Arc<AtomicBool>,
        revision: Arc<AtomicU64>,
        source: CapturedViewportSource,
        reservation: Arc<ViewportCaptureReservation>,
    ) -> AttachmentProjectionJob {
        AttachmentProjectionJob {
            generation,
            observed_revision: revision.load(Ordering::Acquire),
            publication_blocked: blocked,
            publication_revision: Arc::clone(&revision),
            projection: attachment.capture_request(&revision).unwrap().1,
            source,
            input_output_timing: None,
            _capture_reservation: reservation,
        }
    }

    #[test]
    fn scheduled_pass_cannot_finish_before_its_attachment_worker() {
        let mut replay = replay();
        let projection = AttachmentViewportProjection::new(
            replay.attach_view_projection().expect("attach projection"),
        );
        let pass = ScheduledViewportProjectionPass {
            generation: 7,
            projections: vec![Arc::clone(&projection)],
        };
        let (completed_tx, completed_rx) = std::sync::mpsc::sync_channel(1);
        let waiting = std::thread::spawn(move || completed_tx.send(pass.wait_completed()).unwrap());

        assert!(matches!(
            completed_rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        projection.mark_completed(7);
        assert!(completed_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiting.join().unwrap();
    }

    #[test]
    fn scheduled_pass_does_not_adopt_an_unscheduled_attachment_barrier() {
        let mut replay = replay();
        let scheduled = AttachmentViewportProjection::new(
            replay
                .attach_view_projection()
                .expect("scheduled projection"),
        );
        let _receipt_blocked = AttachmentViewportProjection::new(
            replay
                .attach_view_projection()
                .expect("receipt-blocked projection"),
        );
        scheduled.mark_completed(11);

        assert!(
            ScheduledViewportProjectionPass {
                generation: 11,
                projections: vec![scheduled],
            }
            .wait_completed()
        );
    }

    #[test]
    fn shared_generation_counts_one_capture_until_its_last_job_drops() {
        let budget = ViewportCaptureBudget::new();
        let mut reservation = budget.reserve().unwrap();
        assert!(reservation.shrink_to(4096));
        let reservation = Arc::new(reservation);
        let jobs = (0..64)
            .map(|_| Arc::clone(&reservation))
            .collect::<Vec<_>>();
        assert_eq!(budget.state.lock().unwrap().used_bytes, 4096);

        drop(reservation);
        assert_eq!(budget.state.lock().unwrap().used_bytes, 4096);
        drop(jobs);
        assert_eq!(budget.state.lock().unwrap().used_bytes, 0);
    }

    #[test]
    fn distinct_captures_wait_at_the_host_ceiling_and_resume_after_release() {
        let budget = ViewportCaptureBudget::new();
        let mut reservations = (0..VIEWPORT_TOTAL_CAPTURE_BYTES / VIEWPORT_SOURCE_CAPTURE_BYTES)
            .map(|_| budget.reserve().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            budget.state.lock().unwrap().used_bytes,
            VIEWPORT_TOTAL_CAPTURE_BYTES
        );

        let waiting_budget = Arc::clone(&budget);
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (reserved_tx, reserved_rx) = std::sync::mpsc::sync_channel(1);
        let waiting = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            reserved_tx.send(waiting_budget.reserve()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(matches!(
            reserved_rx.recv_timeout(std::time::Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        drop(reservations.pop());
        let replacement = reserved_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
        waiting.join().unwrap();
        assert_eq!(
            budget.state.lock().unwrap().used_bytes,
            VIEWPORT_TOTAL_CAPTURE_BYTES
        );
        drop(replacement);
        drop(reservations);
        assert_eq!(budget.state.lock().unwrap().used_bytes, 0);
    }

    #[test]
    fn many_mutations_collapse_to_one_latest_pending_generation() {
        let publication = ViewportProjectionPublication::new();
        assert!(publication.mark_dirty());
        assert!(publication.mark_dirty());
        assert!(publication.mark_dirty());
        assert_eq!(publication.wait_after(0), Some(3));

        assert!(publication.mark_dirty());
        assert_eq!(publication.wait_after(3), Some(4));
        assert!(publication.mark_completed(4));
        assert!(publication.wait_completed_through(4));
        publication.close();
        assert_eq!(publication.wait_after(4), None);
        assert!(!publication.mark_dirty());
    }

    #[test]
    fn continuous_output_waits_before_the_next_projection_pass() {
        let publication = ViewportProjectionPublication::new();
        assert!(publication.mark_dirty());
        assert_eq!(publication.wait_after(0), Some(1));

        assert!(publication.mark_dirty());
        assert!(publication.mark_dirty());
        let started = std::time::Instant::now();
        assert_eq!(publication.wait_after(1), Some(3));
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(20),
            "continuous output projected again without a bounded coalescing window"
        );
    }

    #[test]
    fn only_output_newer_than_the_latest_input_bypasses_the_continuous_cadence() {
        let publication = ViewportProjectionPublication::new();
        assert!(publication.mark_dirty());
        assert_eq!(publication.wait_after(0), Some(1));

        publication.arm_next_output_after_input(
            7,
            Instant::now(),
            Some(crate::pty_input::InputTimingCorrelation {
                client_id: 3,
                record_id: 7,
            }),
        );
        publication.arm_next_output_after_input(
            8,
            Instant::now(),
            Some(crate::pty_input::InputTimingCorrelation {
                client_id: 3,
                record_id: 8,
            }),
        );
        assert!(publication.mark_output_dirty(8, Instant::now()));
        assert!(
            publication
                .state
                .lock()
                .unwrap()
                .last_projection_started_at
                .is_some(),
            "output already ingested before the latest input must not consume its priority"
        );

        assert!(publication.mark_output_dirty(9, Instant::now()));
        let timing = publication.latest_input_output_timing().unwrap();
        assert_eq!(timing.client_id, 3);
        assert_eq!(timing.input_record_id, 8);
        assert_eq!(timing.input_baseline_output_sequence, 8);
        assert_eq!(timing.first_output_sequence, 9);
        let started = std::time::Instant::now();
        assert_eq!(publication.wait_after(1), Some(3));
        assert!(
            started.elapsed() < std::time::Duration::from_millis(20),
            "the first output newer than accepted input retained the continuous-output delay"
        );

        assert!(publication.mark_output_dirty(10, Instant::now()));
        let started = std::time::Instant::now();
        assert_eq!(publication.wait_after(3), Some(4));
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(20),
            "output after the one-shot escaped the continuous-output cadence"
        );
    }

    #[test]
    fn correlated_input_timing_survives_unmeasured_follow_up_before_projection() {
        let publication = ViewportProjectionPublication::new();
        publication.arm_next_output_after_input(
            7,
            Instant::now(),
            Some(crate::pty_input::InputTimingCorrelation {
                client_id: 3,
                record_id: 7,
            }),
        );
        assert!(publication.mark_output_dirty(8, Instant::now()));

        publication.arm_next_output_after_input(8, Instant::now(), None);
        assert!(publication.mark_output_dirty(9, Instant::now()));

        let timing = publication
            .latest_input_output_timing()
            .expect("an unmeasured follow-up must not erase the exact sampled timing");
        assert_eq!(timing.client_id, 3);
        assert_eq!(timing.input_record_id, 7);
        assert_eq!(timing.input_baseline_output_sequence, 7);
        assert_eq!(timing.first_output_sequence, 8);
    }

    #[test]
    fn close_wakes_a_waiting_projector() {
        let publication = std::sync::Arc::new(ViewportProjectionPublication::new());
        let waiting = std::sync::Arc::clone(&publication);
        let worker = std::thread::spawn(move || waiting.wait_after(0));

        publication.close();
        assert_eq!(worker.join().unwrap(), None);
    }

    #[test]
    fn completion_fence_tracks_the_latest_coalesced_generation() {
        let publication = ViewportProjectionPublication::new();
        assert!(publication.mark_dirty());
        assert!(publication.mark_dirty());
        assert_eq!(publication.current_generation(), Some(2));
        assert!(publication.mark_completed(2));
        assert!(publication.wait_completed_through(2));
    }

    #[test]
    fn provider_exit_fence_does_not_finish_before_cas_reschedule_generation() {
        let publication = Arc::new(ViewportProjectionPublication::new());
        assert!(publication.mark_dirty());
        assert!(publication.mark_completed(1));
        let mut replay = replay();
        let attachment = AttachmentViewportProjection::new(
            replay.attach_view_projection().expect("attach projection"),
        );
        let exit_publication = Arc::clone(&publication);
        let exit_attachment = Arc::clone(&attachment);
        let mutation_fence = Arc::new(Mutex::new(()));
        let exit_mutation_fence = Arc::clone(&mutation_fence);
        let (snapshot_tx, snapshot_rx) = std::sync::mpsc::sync_channel(1);
        let exit = std::thread::spawn(move || {
            let mut snapshot_tx = Some(snapshot_tx);
            close_after_dependents_complete(&exit_publication, &exit_mutation_fence, |generation| {
                if let Some(snapshot_tx) = snapshot_tx.take() {
                    snapshot_tx.send(generation).unwrap();
                }
                exit_attachment.wait_completed_through(generation)
            })
            .expect("provider exit must seal the stable projection generation")
        });

        assert_eq!(snapshot_rx.recv().unwrap(), 1);
        assert!(publication.mark_dirty(), "CAS rejection must enqueue G+1");
        assert!(publication.mark_completed(2));
        attachment.mark_completed(1);
        attachment.mark_completed(2);

        assert_eq!(exit.join().unwrap(), 2);
        assert_eq!(publication.current_generation(), None);
        assert!(!publication.mark_dirty());
    }

    #[test]
    fn attachment_mutation_cannot_cross_provider_exit_seal() {
        let publication = Arc::new(ViewportProjectionPublication::new());
        assert!(publication.mark_dirty());
        assert!(publication.mark_completed(1));
        let actor = Arc::new(Mutex::new(TerminalSurfaceActor::default()));
        let revision = Arc::new(AtomicU64::new(0));
        let (mutated_tx, mutated_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let mutation_publication = Arc::clone(&publication);
        let mutation_actor = Arc::clone(&actor);
        let mutation_revision = Arc::clone(&revision);
        let mutation = std::thread::spawn(move || {
            let mut mutation =
                TerminalSurfaceMutation::begin(&mutation_actor, &mutation_publication).unwrap();
            assert!(mutation.actor_mut().surfaces.is_empty());
            mutation_revision.fetch_add(1, Ordering::AcqRel);
            mutated_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            mutation.publish().is_ok()
        });

        mutated_rx.recv().unwrap();
        let exit_publication = Arc::clone(&publication);
        let exit_actor = Arc::clone(&actor);
        let (sealing_tx, sealing_rx) = std::sync::mpsc::sync_channel(1);
        let exit = std::thread::spawn(move || {
            let mut sealing_tx = Some(sealing_tx);
            close_after_dependents_complete(&exit_publication, &exit_actor, |_| {
                if let Some(sealing_tx) = sealing_tx.take() {
                    sealing_tx.send(()).unwrap();
                }
                true
            })
            .expect("provider exit must seal a stable generation")
        });
        sealing_rx.recv().unwrap();
        release_tx.send(()).unwrap();

        assert!(
            mutation.join().unwrap(),
            "an accepted mutation must publish"
        );
        assert!(publication.mark_completed(2));
        assert_eq!(exit.join().unwrap(), 2);
        assert_eq!(revision.load(Ordering::Acquire), 1);
        assert!(TerminalSurfaceMutation::begin(&actor, &publication).is_err());
    }

    #[test]
    fn frame_release_cannot_cross_provider_exit_seal() {
        let publication = Arc::new(ViewportProjectionPublication::new());
        assert!(publication.mark_dirty());
        assert!(publication.mark_completed(1));
        let actor = Arc::new(Mutex::new(TerminalSurfaceActor::default()));
        let blocked = Arc::new(AtomicBool::new(true));
        let (released_tx, released_rx) = std::sync::mpsc::sync_channel(1);
        let (continue_tx, continue_rx) = std::sync::mpsc::sync_channel(1);
        let release_publication = Arc::clone(&publication);
        let release_actor = Arc::clone(&actor);
        let release_blocked = Arc::clone(&blocked);
        let release = std::thread::spawn(move || {
            let mutation =
                TerminalSurfaceMutation::begin(&release_actor, &release_publication).unwrap();
            release_blocked.store(false, Ordering::Release);
            released_tx.send(()).unwrap();
            continue_rx.recv().unwrap();
            mutation.publish().is_ok()
        });

        released_rx.recv().unwrap();
        let exit_publication = Arc::clone(&publication);
        let exit_actor = Arc::clone(&actor);
        let (sealing_tx, sealing_rx) = std::sync::mpsc::sync_channel(1);
        let exit = std::thread::spawn(move || {
            let mut sealing_tx = Some(sealing_tx);
            close_after_dependents_complete(&exit_publication, &exit_actor, |_| {
                if let Some(sealing_tx) = sealing_tx.take() {
                    sealing_tx.send(()).unwrap();
                }
                true
            })
            .expect("provider exit must seal a stable generation")
        });
        sealing_rx.recv().unwrap();
        continue_tx.send(()).unwrap();

        assert!(release.join().unwrap(), "an accepted release must publish");
        assert!(publication.mark_completed(2));
        assert_eq!(exit.join().unwrap(), 2);
        assert!(!blocked.load(Ordering::Acquire));
        assert!(TerminalSurfaceMutation::begin(&actor, &publication).is_err());
    }

    #[test]
    fn attachment_retains_only_the_latest_pending_viewport_generation() {
        let mut replay = replay();
        let projection = replay.attach_view_projection().unwrap();
        let request = projection.capture_request().unwrap();
        let source = replay
            .capture_viewport_source(&[request], VIEWPORT_SOURCE_CAPTURE_BYTES)
            .unwrap();
        let reservation = capture_reservation();
        let attachment = AttachmentViewportProjection::new(projection);
        let blocked = Arc::new(AtomicBool::new(false));
        let revision = Arc::new(AtomicU64::new(0));

        assert_eq!(
            attachment.schedule(attachment_job(
                1,
                &attachment,
                Arc::clone(&blocked),
                Arc::clone(&revision),
                source.clone(),
                Arc::clone(&reservation),
            )),
            AttachmentScheduleOutcome::Scheduled
        );
        let running = attachment.wait_job().unwrap();
        for generation in 2..=100_001 {
            assert_eq!(
                attachment.schedule(attachment_job(
                    generation,
                    &attachment,
                    Arc::clone(&blocked),
                    Arc::clone(&revision),
                    source.clone(),
                    Arc::clone(&reservation),
                )),
                AttachmentScheduleOutcome::Scheduled
            );
        }

        assert_eq!(attachment.maximum_pending(), 1);
        assert_eq!(running.generation, 1);
        assert_eq!(attachment.wait_job().unwrap().generation, 100_001);
        attachment.close();
    }

    #[test]
    fn detached_attachment_is_a_stale_schedule_not_a_global_failure() {
        let mut replay = replay();
        let projection = replay.attach_view_projection().unwrap();
        let request = projection.capture_request().unwrap();
        let source = replay
            .capture_viewport_source(&[request], VIEWPORT_SOURCE_CAPTURE_BYTES)
            .unwrap();
        let attachment = AttachmentViewportProjection::new(projection);
        attachment.close();

        assert_eq!(
            attachment.schedule(AttachmentProjectionJob {
                generation: 1,
                observed_revision: 0,
                publication_blocked: Arc::new(AtomicBool::new(false)),
                publication_revision: Arc::new(AtomicU64::new(0)),
                projection: attachment.projection.lock().unwrap().fork_for_projection(),
                source,
                input_output_timing: None,
                _capture_reservation: capture_reservation(),
            }),
            AttachmentScheduleOutcome::Stale
        );
    }

    #[test]
    fn detached_attachment_releases_the_final_completion_barrier() {
        let mut replay = replay();
        let projection = replay.attach_view_projection().unwrap();
        let attachment = AttachmentViewportProjection::new(projection);
        let waiting = Arc::clone(&attachment);
        let waiter = std::thread::spawn(move || waiting.wait_completed_through(7));

        attachment.close();

        assert!(waiter.join().unwrap());
    }
}
