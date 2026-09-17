use crate::runtime_diagnostics::{
    RuntimeDiagnosticEvent, RuntimeDiagnosticFields, RuntimeDiagnostics,
};
use hmux_host::local_discovery::{
    DiscoveryError, LifetimeLock, PresentationCheckpoint, PresentationCheckpointWriteError,
    PresentationCheckpointWritePhase, SessionDiscovery,
};
use hmux_host::terminal_replay::TerminalCheckpoint;
use std::io;
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PERIODIC_INTERVAL: Duration = Duration::from_secs(1);
const PERIODIC_MAX_INTERVAL: Duration = Duration::from_secs(5);
const PERIODIC_REPAINT_BUDGET_BYTES: usize = 256 * 1024;
const RETRY_INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const RETRY_MAX_BACKOFF: Duration = Duration::from_secs(5);
const FINAL_MAX_ATTEMPTS: usize = 3;
const FINAL_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(3);
const DIAGNOSTIC_DEGRADATION_MIN_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) trait PresentationSnapshotSource: Send + Sync + 'static {
    fn current_version(&self) -> Option<CheckpointVersion>;
    fn current_checkpoint(&self) -> Option<TerminalCheckpoint>;
}

pub(crate) trait PresentationCheckpointSink: Send + 'static {
    fn publish(
        &mut self,
        checkpoint: &PresentationCheckpoint,
    ) -> std::result::Result<(), CheckpointSinkError>;
}

pub(crate) struct SessionCheckpointSink {
    discovery: SessionDiscovery,
    lifetime_lock: Arc<LifetimeLock>,
}

impl SessionCheckpointSink {
    pub(crate) fn new(discovery: SessionDiscovery, lifetime_lock: Arc<LifetimeLock>) -> Self {
        Self {
            discovery,
            lifetime_lock,
        }
    }
}

impl PresentationCheckpointSink for SessionCheckpointSink {
    fn publish(
        &mut self,
        checkpoint: &PresentationCheckpoint,
    ) -> std::result::Result<(), CheckpointSinkError> {
        self.discovery
            .write_presentation_checkpoint_detailed(&self.lifetime_lock, checkpoint)
            .map_err(CheckpointSinkError::storage)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CheckpointFailureCode {
    NoSpace,
    QuotaExceeded,
    PermissionDenied,
    ReadOnlyFilesystem,
    Interrupted,
    InvalidCheckpoint,
    TooLarge,
    Serialization,
    StaleSnapshot,
    WorkerUnavailable,
    Io,
}

impl CheckpointFailureCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::NoSpace => "no_space",
            Self::QuotaExceeded => "quota_exceeded",
            Self::PermissionDenied => "permission_denied",
            Self::ReadOnlyFilesystem => "read_only_filesystem",
            Self::Interrupted => "interrupted",
            Self::InvalidCheckpoint => "invalid_checkpoint",
            Self::TooLarge => "too_large",
            Self::Serialization => "serialization",
            Self::StaleSnapshot => "stale_snapshot",
            Self::WorkerUnavailable => "worker_unavailable",
            Self::Io => "io",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CheckpointFailurePhase {
    Capture,
    Write,
    FileSync,
    AtomicReplace,
    DirectorySync,
    Validation,
    Serialization,
    Ordering,
    Worker,
    Storage,
}

impl CheckpointFailurePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Write => "write",
            Self::FileSync => "file_sync",
            Self::AtomicReplace => "atomic_replace",
            Self::DirectorySync => "directory_sync",
            Self::Validation => "validation",
            Self::Serialization => "serialization",
            Self::Ordering => "ordering",
            Self::Worker => "worker",
            Self::Storage => "storage",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CheckpointSinkError {
    code: CheckpointFailureCode,
    phase: CheckpointFailurePhase,
}

impl CheckpointSinkError {
    fn capture(error: DiscoveryError) -> Self {
        Self {
            code: classify_discovery_error(&error),
            phase: CheckpointFailurePhase::Capture,
        }
    }

    fn storage(error: PresentationCheckpointWriteError) -> Self {
        let phase = match error.phase() {
            PresentationCheckpointWritePhase::Validation => CheckpointFailurePhase::Validation,
            PresentationCheckpointWritePhase::Serialization => {
                CheckpointFailurePhase::Serialization
            }
            PresentationCheckpointWritePhase::Write => CheckpointFailurePhase::Write,
            PresentationCheckpointWritePhase::FileSync => CheckpointFailurePhase::FileSync,
            PresentationCheckpointWritePhase::AtomicReplace => {
                CheckpointFailurePhase::AtomicReplace
            }
            PresentationCheckpointWritePhase::DirectorySync => {
                CheckpointFailurePhase::DirectorySync
            }
        };
        Self {
            code: classify_discovery_error(error.discovery_error()),
            phase,
        }
    }

    #[cfg(test)]
    fn injected(phase: CheckpointFailurePhase, code: CheckpointFailureCode) -> Self {
        Self { code, phase }
    }
}

fn classify_discovery_error(error: &DiscoveryError) -> CheckpointFailureCode {
    match error {
        DiscoveryError::Io { source, .. } => classify_io_error(source),
        DiscoveryError::PresentationCheckpointInvalid { .. } => {
            CheckpointFailureCode::InvalidCheckpoint
        }
        DiscoveryError::PresentationCheckpointTooLarge { .. } => CheckpointFailureCode::TooLarge,
        DiscoveryError::Serialization(_) => CheckpointFailureCode::Serialization,
        _ => CheckpointFailureCode::Io,
    }
}

fn classify_io_error(error: &io::Error) -> CheckpointFailureCode {
    match error.raw_os_error() {
        Some(libc::ENOSPC) => CheckpointFailureCode::NoSpace,
        Some(libc::EDQUOT) => CheckpointFailureCode::QuotaExceeded,
        Some(libc::EACCES | libc::EPERM) => CheckpointFailureCode::PermissionDenied,
        Some(libc::EROFS) => CheckpointFailureCode::ReadOnlyFilesystem,
        _ if error.kind() == io::ErrorKind::Interrupted => CheckpointFailureCode::Interrupted,
        _ => CheckpointFailureCode::Io,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FinalFlushOutcome {
    Durable {
        sequence_through: u64,
        attempts: usize,
    },
    Degraded {
        sequence_through: u64,
        attempts: usize,
        failure_code: CheckpointFailureCode,
        failure_phase: CheckpointFailurePhase,
    },
}

impl FinalFlushOutcome {
    fn worker_unavailable(sequence_through: u64) -> Self {
        Self::Degraded {
            sequence_through,
            attempts: 0,
            failure_code: CheckpointFailureCode::WorkerUnavailable,
            failure_phase: CheckpointFailurePhase::Worker,
        }
    }
}

#[derive(Clone, Copy)]
struct WriterConfig {
    periodic_interval: Duration,
    periodic_max_interval: Duration,
    periodic_repaint_budget_bytes: usize,
    retry_initial_backoff: Duration,
    retry_max_backoff: Duration,
    final_max_attempts: usize,
    observation_timeout: Duration,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            periodic_interval: PERIODIC_INTERVAL,
            periodic_max_interval: PERIODIC_MAX_INTERVAL,
            periodic_repaint_budget_bytes: PERIODIC_REPAINT_BUDGET_BYTES,
            retry_initial_backoff: RETRY_INITIAL_BACKOFF,
            retry_max_backoff: RETRY_MAX_BACKOFF,
            final_max_attempts: FINAL_MAX_ATTEMPTS,
            observation_timeout: FINAL_OBSERVATION_TIMEOUT,
        }
    }
}

enum WriterCommand {
    Final {
        checkpoint: Box<TerminalCheckpoint>,
        reply: mpsc::SyncSender<FinalFlushOutcome>,
    },
    Shutdown {
        reply: mpsc::SyncSender<()>,
    },
}

pub(crate) struct RootRetired;

pub(crate) struct PresentationCheckpointWriter {
    command: mpsc::SyncSender<WriterCommand>,
    thread: Option<JoinHandle<()>>,
    observation_timeout: Duration,
}

impl PresentationCheckpointWriter {
    pub(crate) fn spawn(
        source: Arc<dyn PresentationSnapshotSource>,
        sink: Box<dyn PresentationCheckpointSink>,
        diagnostics: RuntimeDiagnostics,
    ) -> io::Result<Self> {
        Self::spawn_with_config(source, sink, diagnostics, WriterConfig::default())
    }

    fn spawn_with_config(
        source: Arc<dyn PresentationSnapshotSource>,
        mut sink: Box<dyn PresentationCheckpointSink>,
        diagnostics: RuntimeDiagnostics,
        config: WriterConfig,
    ) -> io::Result<Self> {
        let (command, receiver) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("hmux-checkpoint".into())
            .spawn(move || {
                run_writer(
                    source.as_ref(),
                    sink.as_mut(),
                    &diagnostics,
                    receiver,
                    config,
                );
            })?;
        Ok(Self {
            command,
            thread: Some(thread),
            observation_timeout: config.observation_timeout,
        })
    }

    pub(crate) fn finalize(mut self, checkpoint: TerminalCheckpoint) -> FinalFlushOutcome {
        let sequence_through = checkpoint.sequence_through;
        let (reply, response) = mpsc::sync_channel(1);
        if self
            .command
            .send(WriterCommand::Final {
                checkpoint: Box::new(checkpoint),
                reply,
            })
            .is_err()
        {
            self.join();
            return FinalFlushOutcome::worker_unavailable(sequence_through);
        }
        let outcome = match response.recv_timeout(self.observation_timeout) {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.join();
                return FinalFlushOutcome::worker_unavailable(sequence_through);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.detach();
                return FinalFlushOutcome::worker_unavailable(sequence_through);
            }
        };
        if self.join() {
            outcome
        } else {
            FinalFlushOutcome::worker_unavailable(sequence_through)
        }
    }

    pub(crate) fn shutdown(mut self, _reason: RootRetired) -> bool {
        let (reply, response) = mpsc::sync_channel(1);
        if self
            .command
            .send(WriterCommand::Shutdown { reply })
            .is_err()
        {
            return self.join();
        }
        match response.recv_timeout(self.observation_timeout) {
            Ok(()) => self.join(),
            Err(mpsc::RecvTimeoutError::Disconnected) => self.join(),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.detach();
                false
            }
        }
    }

    fn join(&mut self) -> bool {
        self.thread
            .take()
            .is_none_or(|thread| thread.join().is_ok())
    }

    fn detach(&mut self) {
        drop(self.thread.take());
    }
}

impl Drop for PresentationCheckpointWriter {
    fn drop(&mut self) {
        if self.thread.is_none() {
            return;
        }
        let (reply, response) = mpsc::sync_channel(1);
        if self
            .command
            .send(WriterCommand::Shutdown { reply })
            .is_err()
        {
            self.join();
            return;
        }
        match response.recv_timeout(self.observation_timeout) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.join();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => self.detach(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CheckpointVersion {
    pub(crate) sequence_through: u64,
    pub(crate) rows: u16,
    pub(crate) columns: u16,
}

impl From<&TerminalCheckpoint> for CheckpointVersion {
    fn from(checkpoint: &TerminalCheckpoint) -> Self {
        Self {
            sequence_through: checkpoint.sequence_through,
            rows: checkpoint.rows,
            columns: checkpoint.columns,
        }
    }
}

struct PeriodicCheckpointAttempt {
    version: CheckpointVersion,
    checkpoint: PresentationCheckpoint,
    next_wait: Duration,
}

fn run_writer(
    source: &dyn PresentationSnapshotSource,
    sink: &mut dyn PresentationCheckpointSink,
    diagnostics: &RuntimeDiagnostics,
    receiver: mpsc::Receiver<WriterCommand>,
    config: WriterConfig,
) {
    let mut last_durable = None;
    let mut degraded = false;
    let mut failure_streak = 0_u32;
    let mut pending_retry = None;
    let mut last_degraded_diagnostic = None;
    let mut degraded_diagnostic_visible = false;
    let mut wait = config.periodic_interval;
    loop {
        match receiver.recv_timeout(wait) {
            Ok(WriterCommand::Final { checkpoint, reply }) => {
                let outcome = flush_final(
                    sink,
                    diagnostics,
                    *checkpoint,
                    last_durable,
                    degraded,
                    config,
                );
                record_final_outcome(diagnostics, outcome);
                let _ = reply.send(outcome);
                return;
            }
            Ok(WriterCommand::Shutdown { reply }) => {
                let _ = reply.send(());
                return;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        let attempt = if let Some(pending) = pending_retry.take() {
            pending
        } else {
            if last_durable.is_some_and(|durable: CheckpointVersion| {
                source.current_version().is_none_or(|current| {
                    current.sequence_through < durable.sequence_through || current == durable
                })
            }) {
                wait = config.periodic_interval;
                continue;
            }
            let Some(checkpoint) = source.current_checkpoint() else {
                wait = config.periodic_interval;
                continue;
            };
            let version = CheckpointVersion::from(&checkpoint);
            let next_wait = periodic_wait_for_repaint(config, checkpoint.payload.len());
            if last_durable.is_some_and(|durable: CheckpointVersion| {
                version.sequence_through < durable.sequence_through || version == durable
            }) {
                wait = config.periodic_interval;
                continue;
            }
            let checkpoint =
                match PresentationCheckpoint::capture_terminal(&checkpoint, unix_time_ms()) {
                    Ok(checkpoint) => checkpoint,
                    Err(error) => {
                        let error = CheckpointSinkError::capture(error);
                        failure_streak = failure_streak.saturating_add(1);
                        wait = retry_backoff(config, failure_streak);
                        if !degraded {
                            degraded_diagnostic_visible = record_degraded(
                                diagnostics,
                                version,
                                error,
                                &mut last_degraded_diagnostic,
                            );
                            degraded = true;
                        }
                        continue;
                    }
                };
            PeriodicCheckpointAttempt {
                version,
                checkpoint,
                next_wait,
            }
        };

        match sink.publish(&attempt.checkpoint) {
            Ok(()) => {
                let recovery_attempts =
                    usize::try_from(failure_streak.saturating_add(1)).unwrap_or(usize::MAX);
                last_durable = Some(attempt.version);
                failure_streak = 0;
                wait = attempt.next_wait;
                if degraded {
                    if degraded_diagnostic_visible {
                        record_recovered(diagnostics, attempt.version, recovery_attempts);
                        degraded_diagnostic_visible = false;
                    }
                    degraded = false;
                }
            }
            Err(error) => {
                failure_streak = failure_streak.saturating_add(1);
                wait = retry_backoff(config, failure_streak);
                if !degraded {
                    degraded_diagnostic_visible = record_degraded(
                        diagnostics,
                        attempt.version,
                        error,
                        &mut last_degraded_diagnostic,
                    );
                    degraded = true;
                }
                pending_retry = Some(attempt);
            }
        }
    }
}

fn periodic_wait_for_repaint(config: WriterConfig, repaint_bytes: usize) -> Duration {
    let budget = config.periodic_repaint_budget_bytes.max(1);
    let quanta = repaint_bytes.div_ceil(budget).max(1);
    let multiplier = u32::try_from(quanta).unwrap_or(u32::MAX);
    config
        .periodic_interval
        .saturating_mul(multiplier)
        .min(config.periodic_max_interval.max(config.periodic_interval))
}

fn flush_final(
    sink: &mut dyn PresentationCheckpointSink,
    diagnostics: &RuntimeDiagnostics,
    terminal_checkpoint: TerminalCheckpoint,
    last_durable: Option<CheckpointVersion>,
    was_degraded: bool,
    config: WriterConfig,
) -> FinalFlushOutcome {
    let final_version = CheckpointVersion::from(&terminal_checkpoint);
    if last_durable.is_some_and(|durable| final_version.sequence_through < durable.sequence_through)
    {
        return FinalFlushOutcome::Degraded {
            sequence_through: final_version.sequence_through,
            attempts: 0,
            failure_code: CheckpointFailureCode::StaleSnapshot,
            failure_phase: CheckpointFailurePhase::Ordering,
        };
    }
    let checkpoint =
        match PresentationCheckpoint::capture_terminal(&terminal_checkpoint, unix_time_ms()) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                let failure = CheckpointSinkError::capture(error);
                return FinalFlushOutcome::Degraded {
                    sequence_through: final_version.sequence_through,
                    attempts: 1,
                    failure_code: failure.code,
                    failure_phase: failure.phase,
                };
            }
        };

    let maximum_attempts = config.final_max_attempts.max(1);
    let mut last_error = CheckpointSinkError {
        code: CheckpointFailureCode::Io,
        phase: CheckpointFailurePhase::Storage,
    };
    for attempt in 1..=maximum_attempts {
        match sink.publish(&checkpoint) {
            Ok(()) => {
                if was_degraded || attempt > 1 {
                    diagnostics.record(
                        RuntimeDiagnosticEvent::PresentationCheckpointRecovered,
                        RuntimeDiagnosticFields::checkpoint(
                            "durable",
                            final_version.sequence_through,
                            attempt,
                            None,
                            None,
                        ),
                    );
                }
                return FinalFlushOutcome::Durable {
                    sequence_through: final_version.sequence_through,
                    attempts: attempt,
                };
            }
            Err(error) => last_error = error,
        }
        if attempt < maximum_attempts {
            thread::sleep(final_retry_backoff(config, attempt));
        }
    }
    FinalFlushOutcome::Degraded {
        sequence_through: final_version.sequence_through,
        attempts: maximum_attempts,
        failure_code: last_error.code,
        failure_phase: last_error.phase,
    }
}

fn record_degraded(
    diagnostics: &RuntimeDiagnostics,
    candidate: CheckpointVersion,
    error: CheckpointSinkError,
    last_degraded_diagnostic: &mut Option<Instant>,
) -> bool {
    let now = Instant::now();
    if last_degraded_diagnostic.is_some_and(|last| {
        now.saturating_duration_since(last) < DIAGNOSTIC_DEGRADATION_MIN_INTERVAL
    }) {
        return false;
    }
    let recorded = diagnostics.record(
        RuntimeDiagnosticEvent::PresentationCheckpointDegraded,
        RuntimeDiagnosticFields::checkpoint(
            "degraded",
            candidate.sequence_through,
            1,
            Some(error.phase.as_str()),
            Some(error.code.as_str()),
        ),
    );
    if recorded {
        *last_degraded_diagnostic = Some(now);
    }
    recorded
}

fn record_recovered(
    diagnostics: &RuntimeDiagnostics,
    candidate: CheckpointVersion,
    attempts: usize,
) {
    diagnostics.record(
        RuntimeDiagnosticEvent::PresentationCheckpointRecovered,
        RuntimeDiagnosticFields::checkpoint(
            "durable",
            candidate.sequence_through,
            attempts,
            None,
            None,
        ),
    );
}

fn record_final_outcome(diagnostics: &RuntimeDiagnostics, outcome: FinalFlushOutcome) {
    match outcome {
        FinalFlushOutcome::Durable {
            sequence_through,
            attempts,
        } => {
            diagnostics.record(
                RuntimeDiagnosticEvent::PresentationCheckpointFinal,
                RuntimeDiagnosticFields::checkpoint(
                    "durable",
                    sequence_through,
                    attempts,
                    None,
                    None,
                ),
            );
        }
        FinalFlushOutcome::Degraded {
            sequence_through,
            attempts,
            failure_code,
            failure_phase,
        } => {
            diagnostics.record(
                RuntimeDiagnosticEvent::PresentationCheckpointFinal,
                RuntimeDiagnosticFields::checkpoint(
                    "degraded",
                    sequence_through,
                    attempts,
                    Some(failure_phase.as_str()),
                    Some(failure_code.as_str()),
                ),
            );
        }
    }
}

fn retry_backoff(config: WriterConfig, failure_streak: u32) -> Duration {
    let mut delay = config.retry_initial_backoff;
    for _ in 1..failure_streak.min(16) {
        delay = delay.saturating_mul(2).min(config.retry_max_backoff);
    }
    delay.min(config.retry_max_backoff)
}

fn final_retry_backoff(config: WriterConfig, completed_attempt: usize) -> Duration {
    let mut delay = config.retry_initial_backoff;
    for _ in 1..completed_attempt.min(16) {
        delay = delay.saturating_mul(2).min(config.retry_max_backoff);
    }
    delay.min(config.retry_max_backoff)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_protocol::SessionFence;
    use hmux_host::terminal_replay::TerminalCheckpointEncoding;
    use std::collections::VecDeque;
    use std::sync::{Condvar, Mutex};

    #[derive(Clone)]
    struct SharedSource {
        shared: Arc<(Mutex<SharedSourceState>, Condvar)>,
    }

    struct SharedSourceState {
        checkpoint: Option<TerminalCheckpoint>,
        reads: usize,
        version_reads: usize,
    }

    impl SharedSource {
        fn new(checkpoint: Option<TerminalCheckpoint>) -> Self {
            Self {
                shared: Arc::new((
                    Mutex::new(SharedSourceState {
                        checkpoint,
                        reads: 0,
                        version_reads: 0,
                    }),
                    Condvar::new(),
                )),
            }
        }

        fn set(&self, checkpoint: TerminalCheckpoint) -> usize {
            let mut state = self.shared.0.lock().unwrap();
            state.checkpoint = Some(checkpoint);
            state.version_reads
        }

        fn wait_for_version_reads(&self, minimum: usize) {
            let (state_lock, changed) = self.shared.as_ref();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut state = state_lock.lock().unwrap();
            while state.version_reads < minimum {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "checkpoint version read timed out");
                let (next, timeout) = changed.wait_timeout(state, remaining).unwrap();
                state = next;
                assert!(
                    !timeout.timed_out() || state.version_reads >= minimum,
                    "checkpoint version read timed out"
                );
            }
        }

        fn reads(&self) -> usize {
            self.shared.0.lock().unwrap().reads
        }

        fn version_reads(&self) -> usize {
            self.shared.0.lock().unwrap().version_reads
        }
    }

    impl PresentationSnapshotSource for SharedSource {
        fn current_version(&self) -> Option<CheckpointVersion> {
            let (state_lock, changed) = self.shared.as_ref();
            let mut state = state_lock.lock().ok()?;
            state.version_reads = state.version_reads.saturating_add(1);
            let version = state.checkpoint.as_ref().map(CheckpointVersion::from);
            changed.notify_all();
            version
        }

        fn current_checkpoint(&self) -> Option<TerminalCheckpoint> {
            let (state_lock, changed) = self.shared.as_ref();
            let mut state = state_lock.lock().ok()?;
            state.reads = state.reads.saturating_add(1);
            let checkpoint = state.checkpoint.clone();
            changed.notify_all();
            checkpoint
        }
    }

    struct FakeSink {
        shared: Arc<(Mutex<FakeSinkState>, Condvar)>,
    }

    struct FakeSinkHandle {
        shared: Arc<(Mutex<FakeSinkState>, Condvar)>,
    }

    struct FakeSinkState {
        calls: Vec<CheckpointVersion>,
        checkpoints: Vec<PresentationCheckpoint>,
        failures: VecDeque<CheckpointSinkError>,
        permanent_failure: Option<CheckpointSinkError>,
        block_first: bool,
        released: bool,
        dropped: bool,
    }

    impl FakeSink {
        fn new(
            failures: impl IntoIterator<Item = CheckpointSinkError>,
            permanent_failure: Option<CheckpointSinkError>,
            block_first: bool,
        ) -> (Self, FakeSinkHandle) {
            let shared = Arc::new((
                Mutex::new(FakeSinkState {
                    calls: Vec::new(),
                    checkpoints: Vec::new(),
                    failures: failures.into_iter().collect(),
                    permanent_failure,
                    block_first,
                    released: false,
                    dropped: false,
                }),
                Condvar::new(),
            ));
            (
                Self {
                    shared: Arc::clone(&shared),
                },
                FakeSinkHandle { shared },
            )
        }
    }

    impl PresentationCheckpointSink for FakeSink {
        fn publish(
            &mut self,
            checkpoint: &PresentationCheckpoint,
        ) -> std::result::Result<(), CheckpointSinkError> {
            let (state_lock, changed) = self.shared.as_ref();
            let mut state = state_lock.lock().unwrap();
            state.calls.push(CheckpointVersion {
                sequence_through: checkpoint.sequence_through(),
                rows: checkpoint.rows(),
                columns: checkpoint.columns(),
            });
            state.checkpoints.push(checkpoint.clone());
            changed.notify_all();
            while state.block_first && state.calls.len() == 1 && !state.released {
                state = changed.wait(state).unwrap();
            }
            if let Some(error) = state.permanent_failure {
                return Err(error);
            }
            state.failures.pop_front().map_or(Ok(()), Err)
        }
    }

    impl Drop for FakeSink {
        fn drop(&mut self) {
            let (state_lock, changed) = self.shared.as_ref();
            if let Ok(mut state) = state_lock.lock() {
                state.dropped = true;
                changed.notify_all();
            }
        }
    }

    impl FakeSinkHandle {
        fn wait_for_calls(&self, minimum: usize) {
            let (state_lock, changed) = self.shared.as_ref();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut state = state_lock.lock().unwrap();
            while state.calls.len() < minimum {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "checkpoint sink call timed out");
                let (next, timeout) = changed.wait_timeout(state, remaining).unwrap();
                state = next;
                assert!(
                    !timeout.timed_out() || state.calls.len() >= minimum,
                    "checkpoint sink call timed out"
                );
            }
        }

        fn release(&self) {
            let (state_lock, changed) = self.shared.as_ref();
            let mut state = state_lock.lock().unwrap();
            state.released = true;
            changed.notify_all();
        }

        fn calls(&self) -> Vec<CheckpointVersion> {
            self.shared.0.lock().unwrap().calls.clone()
        }

        fn checkpoints(&self) -> Vec<PresentationCheckpoint> {
            self.shared.0.lock().unwrap().checkpoints.clone()
        }

        fn wait_for_drop(&self) {
            let (state_lock, changed) = self.shared.as_ref();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut state = state_lock.lock().unwrap();
            while !state.dropped {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "checkpoint sink drop timed out");
                let (next, timeout) = changed.wait_timeout(state, remaining).unwrap();
                state = next;
                assert!(
                    !timeout.timed_out() || state.dropped,
                    "checkpoint sink drop timed out"
                );
            }
        }
    }

    fn checkpoint(sequence_through: u64, rows: u16, columns: u16) -> TerminalCheckpoint {
        TerminalCheckpoint {
            fence: SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-1".into(),
            },
            sequence_through,
            state_revision: sequence_through
                .saturating_add(u64::from(rows))
                .saturating_add(u64::from(columns)),
            rows,
            columns,
            encoding: TerminalCheckpointEncoding::LegacyAnsiRedrawV1,
            payload: format!("screen-{sequence_through}-{rows}-{columns}").into_bytes(),
            alternate_screen: false,
            cursor_visible: true,
            cold_history: None,
        }
    }

    fn config(periodic_interval: Duration, retry_backoff: Duration) -> WriterConfig {
        WriterConfig {
            periodic_interval,
            periodic_max_interval: periodic_interval.saturating_mul(5),
            periodic_repaint_budget_bytes: PERIODIC_REPAINT_BUDGET_BYTES,
            retry_initial_backoff: retry_backoff,
            retry_max_backoff: retry_backoff,
            final_max_attempts: 3,
            observation_timeout: Duration::from_secs(2),
        }
    }

    #[test]
    fn periodic_checkpoint_cadence_amortizes_large_repaints_with_a_hard_bound() {
        let mut writer_config = config(Duration::from_secs(1), Duration::from_millis(1));
        writer_config.periodic_repaint_budget_bytes = 256;

        assert_eq!(
            periodic_wait_for_repaint(writer_config, 0),
            Duration::from_secs(1)
        );
        assert_eq!(
            periodic_wait_for_repaint(writer_config, 256),
            Duration::from_secs(1)
        );
        assert_eq!(
            periodic_wait_for_repaint(writer_config, 257),
            Duration::from_secs(2)
        );
        assert_eq!(
            periodic_wait_for_repaint(writer_config, usize::MAX),
            Duration::from_secs(5)
        );
    }

    fn spawn_writer(
        source: SharedSource,
        sink: FakeSink,
        config: WriterConfig,
    ) -> PresentationCheckpointWriter {
        PresentationCheckpointWriter::spawn_with_config(
            Arc::new(source),
            Box::new(sink),
            RuntimeDiagnostics::disabled(),
            config,
        )
        .unwrap()
    }

    #[test]
    fn storage_errno_classification_is_stable_and_typed() {
        for (raw_os_error, expected) in [
            (libc::ENOSPC, CheckpointFailureCode::NoSpace),
            (libc::EDQUOT, CheckpointFailureCode::QuotaExceeded),
            (libc::EACCES, CheckpointFailureCode::PermissionDenied),
            (libc::EPERM, CheckpointFailureCode::PermissionDenied),
            (libc::EROFS, CheckpointFailureCode::ReadOnlyFilesystem),
        ] {
            assert_eq!(
                classify_io_error(&io::Error::from_raw_os_error(raw_os_error)),
                expected
            );
        }
    }

    #[test]
    fn unchanged_periodic_state_skips_full_capture_until_geometry_changes() {
        let source = SharedSource::new(Some(checkpoint(7, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, false);
        let writer = spawn_writer(
            source.clone(),
            sink,
            config(Duration::from_millis(1), Duration::from_millis(1)),
        );
        handle.wait_for_calls(1);
        let reads_after_first_publish = source.reads();
        let version_reads_after_first_publish = source.version_reads();

        source.wait_for_version_reads(version_reads_after_first_publish.saturating_add(2));

        assert_eq!(source.reads(), reads_after_first_publish);
        let version_reads_before_resize = source.set(checkpoint(7, 40, 120));
        source.wait_for_version_reads(version_reads_before_resize.saturating_add(1));
        handle.wait_for_calls(2);
        assert_eq!(source.reads(), reads_after_first_publish.saturating_add(1));
        writer.shutdown(RootRetired);
    }

    #[test]
    fn delayed_periodic_publish_cannot_overtake_final_flush() {
        let source = SharedSource::new(Some(checkpoint(1, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, true);
        let mut writer = spawn_writer(
            source,
            sink,
            config(Duration::from_millis(1), Duration::from_millis(1)),
        );
        handle.wait_for_calls(1);

        let (reply, response) = mpsc::sync_channel(1);
        writer
            .command
            .send(WriterCommand::Final {
                checkpoint: Box::new(checkpoint(2, 25, 81)),
                reply,
            })
            .unwrap();
        assert_eq!(handle.calls().len(), 1);
        handle.release();

        assert_eq!(
            response.recv_timeout(Duration::from_secs(2)).unwrap(),
            FinalFlushOutcome::Durable {
                sequence_through: 2,
                attempts: 1,
            }
        );
        assert!(writer.join());
        assert_eq!(
            handle.calls(),
            vec![
                CheckpointVersion {
                    sequence_through: 1,
                    rows: 24,
                    columns: 80,
                },
                CheckpointVersion {
                    sequence_through: 2,
                    rows: 25,
                    columns: 81,
                },
            ]
        );
        assert_eq!(handle.calls().len(), 2);
    }

    #[test]
    fn blocked_periodic_io_returns_a_bounded_final_observation() {
        let source = SharedSource::new(Some(checkpoint(1, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, true);
        let mut writer_config = config(Duration::from_millis(1), Duration::from_millis(1));
        writer_config.observation_timeout = Duration::from_millis(20);
        let writer = spawn_writer(source, sink, writer_config);
        handle.wait_for_calls(1);

        let started = Instant::now();
        assert_eq!(
            writer.finalize(checkpoint(2, 25, 81)),
            FinalFlushOutcome::Degraded {
                sequence_through: 2,
                attempts: 0,
                failure_code: CheckpointFailureCode::WorkerUnavailable,
                failure_phase: CheckpointFailurePhase::Worker,
            }
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(handle.calls().len(), 1);

        // The lifecycle owner refuses Exited for WorkerUnavailable and returns
        // from the Host process. Releasing the test-only stall proves the
        // detached worker consumes the already-admitted final command and then
        // terminates; it has no later periodic admission.
        handle.release();
        handle.wait_for_calls(2);
        handle.wait_for_drop();
        assert_eq!(handle.calls().len(), 2);
    }

    #[test]
    fn transient_phase_failure_is_retried_without_stopping_the_writer() {
        for phase in [
            CheckpointFailurePhase::Write,
            CheckpointFailurePhase::FileSync,
            CheckpointFailurePhase::AtomicReplace,
            CheckpointFailurePhase::DirectorySync,
        ] {
            let source = SharedSource::new(Some(checkpoint(7, 24, 80)));
            let error = CheckpointSinkError::injected(phase, CheckpointFailureCode::Interrupted);
            let (sink, handle) = FakeSink::new([error], None, false);
            let writer = spawn_writer(
                source,
                sink,
                config(Duration::from_millis(1), Duration::from_millis(1)),
            );

            handle.wait_for_calls(2);
            writer.shutdown(RootRetired);
            assert_eq!(handle.calls().len(), 2, "{phase:?} must retry once");
            let checkpoints = handle.checkpoints();
            assert_eq!(
                checkpoints[0], checkpoints[1],
                "{phase:?} must retry the byte-identical checkpoint object"
            );
        }
    }

    #[test]
    fn permanent_final_failure_is_bounded_and_reported_degraded() {
        for code in [
            CheckpointFailureCode::NoSpace,
            CheckpointFailureCode::QuotaExceeded,
            CheckpointFailureCode::PermissionDenied,
            CheckpointFailureCode::ReadOnlyFilesystem,
        ] {
            let source = SharedSource::new(None);
            let error = CheckpointSinkError::injected(CheckpointFailurePhase::Write, code);
            let (sink, handle) = FakeSink::new([], Some(error), false);
            let writer = spawn_writer(
                source,
                sink,
                config(Duration::from_secs(10), Duration::from_millis(1)),
            );

            assert_eq!(
                writer.finalize(checkpoint(9, 24, 80)),
                FinalFlushOutcome::Degraded {
                    sequence_through: 9,
                    attempts: 3,
                    failure_code: code,
                    failure_phase: CheckpointFailurePhase::Write,
                }
            );
            assert_eq!(handle.calls().len(), 3);
        }
    }

    #[test]
    fn permanent_periodic_failure_backs_off_without_spinning() {
        let source = SharedSource::new(Some(checkpoint(7, 24, 80)));
        let error = CheckpointSinkError::injected(
            CheckpointFailurePhase::Write,
            CheckpointFailureCode::NoSpace,
        );
        let (sink, handle) = FakeSink::new([], Some(error), false);
        let writer = spawn_writer(
            source,
            sink,
            config(Duration::from_millis(1), Duration::from_millis(50)),
        );
        handle.wait_for_calls(1);

        thread::sleep(Duration::from_millis(15));
        assert_eq!(
            handle.calls().len(),
            1,
            "a permanent error must enter backoff instead of spinning"
        );
        writer.shutdown(RootRetired);
    }

    #[test]
    fn regressive_periodic_snapshot_is_never_published() {
        let source = SharedSource::new(Some(checkpoint(10, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, false);
        let writer = spawn_writer(
            source.clone(),
            sink,
            config(Duration::from_millis(2), Duration::from_millis(1)),
        );
        handle.wait_for_calls(1);
        let version_reads_before_regression = source.set(checkpoint(9, 40, 120));
        source.wait_for_version_reads(version_reads_before_regression.saturating_add(1));
        assert_eq!(handle.calls().len(), 1);

        assert!(matches!(
            writer.finalize(checkpoint(10, 24, 80)),
            FinalFlushOutcome::Durable { .. }
        ));
        assert_eq!(handle.calls().len(), 2);
    }

    #[test]
    fn regressive_final_snapshot_is_refused_without_overwriting_durable_state() {
        let source = SharedSource::new(Some(checkpoint(10, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, false);
        let writer = spawn_writer(
            source,
            sink,
            config(Duration::from_millis(1), Duration::from_millis(1)),
        );
        handle.wait_for_calls(1);

        assert_eq!(
            writer.finalize(checkpoint(9, 40, 120)),
            FinalFlushOutcome::Degraded {
                sequence_through: 9,
                attempts: 0,
                failure_code: CheckpointFailureCode::StaleSnapshot,
                failure_phase: CheckpointFailurePhase::Ordering,
            }
        );
        assert_eq!(handle.calls().len(), 1);
    }

    #[test]
    fn equal_sequence_final_geometry_is_not_dropped() {
        let source = SharedSource::new(Some(checkpoint(7, 24, 80)));
        let (sink, handle) = FakeSink::new([], None, false);
        let writer = spawn_writer(
            source,
            sink,
            config(Duration::from_millis(1), Duration::from_millis(1)),
        );
        handle.wait_for_calls(1);

        assert_eq!(
            writer.finalize(checkpoint(7, 40, 120)),
            FinalFlushOutcome::Durable {
                sequence_through: 7,
                attempts: 1,
            }
        );
        assert_eq!(
            handle.calls(),
            vec![
                CheckpointVersion {
                    sequence_through: 7,
                    rows: 24,
                    columns: 80,
                },
                CheckpointVersion {
                    sequence_through: 7,
                    rows: 40,
                    columns: 120,
                },
            ]
        );
    }

    #[test]
    fn final_flush_interrupts_periodic_retry_backoff() {
        let source = SharedSource::new(Some(checkpoint(1, 24, 80)));
        let error = CheckpointSinkError::injected(
            CheckpointFailurePhase::DirectorySync,
            CheckpointFailureCode::Interrupted,
        );
        let (sink, handle) = FakeSink::new([error], None, false);
        let writer = spawn_writer(
            source,
            sink,
            config(Duration::from_millis(1), Duration::from_secs(5)),
        );
        handle.wait_for_calls(1);

        let started = Instant::now();
        assert!(matches!(
            writer.finalize(checkpoint(2, 25, 81)),
            FinalFlushOutcome::Durable { .. }
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(handle.calls().len(), 2);
    }

    #[test]
    fn blocked_writer_does_not_block_an_unrelated_session() {
        let first_source = SharedSource::new(Some(checkpoint(1, 24, 80)));
        let (first_sink, first_handle) = FakeSink::new([], None, true);
        let first = spawn_writer(
            first_source,
            first_sink,
            config(Duration::from_millis(1), Duration::from_millis(1)),
        );
        first_handle.wait_for_calls(1);

        let second_source = SharedSource::new(None);
        let (second_sink, second_handle) = FakeSink::new([], None, false);
        let second = spawn_writer(
            second_source,
            second_sink,
            config(Duration::from_secs(10), Duration::from_millis(1)),
        );
        let started = Instant::now();
        assert!(matches!(
            second.finalize(checkpoint(4, 30, 90)),
            FinalFlushOutcome::Durable { .. }
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(second_handle.calls().len(), 1);

        let finalizer = thread::spawn(move || first.finalize(checkpoint(2, 25, 81)));
        first_handle.release();
        assert!(matches!(
            finalizer.join().unwrap(),
            FinalFlushOutcome::Durable { .. }
        ));
    }
}
