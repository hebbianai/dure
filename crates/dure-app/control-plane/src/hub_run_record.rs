//! Durable per-run records for `dure-control-plane serve`.
//!
//! Each hub process keeps one owner-only record under `<backend>/hub-runs/`:
//! when it started, why its launcher started it, a liveness heartbeat, the
//! last panic it observed and how it ended (clean shutdown, serve error,
//! terminating signal or a panic unwinding out of serve). A hub that is killed
//! without a chance to write (SIGKILL, memory pressure, power loss) leaves a
//! record without an ending; the next hub to start marks it `unrecorded`,
//! bounded by its last heartbeat.
//!
//! The records are diagnostics only. Failing to write one never stops the hub
//! and never changes how it serves or how a signal ends it.

use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::{
    ControlPlaneError, ensure_owner_subdirectory, now_ms, private_record, valid_generation,
};

/// The variable a launcher sets to say why it started this hub.
pub const LAUNCH_REASON_ENVIRONMENT: &str = "DURE_HUB_LAUNCH_REASON";

const RUNS_DIRECTORY: &str = "hub-runs";
const RECORD_SCHEMA_VERSION: u16 = 1;
const RETAINED_RECORDS: usize = 32;
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const MAX_TEXT_CHARS: usize = 512;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// Why a launcher started this hub, as the launcher observed it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HubLaunchReason {
    /// No hub descriptor existed.
    FirstStart,
    /// The descriptor named this generation but its endpoint did not answer.
    RestartUnreachable,
    /// A newer build is replacing the running generation.
    Replacement,
    /// A replacement target was restarted to finish an interrupted activation.
    ActivationRecovery,
    /// Started directly or by a launcher that does not report a reason.
    #[serde(other)]
    Unspecified,
}

impl HubLaunchReason {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("first_start") => Self::FirstStart,
            Some("restart_unreachable") => Self::RestartUnreachable,
            Some("replacement") => Self::Replacement,
            Some("activation_recovery") => Self::ActivationRecovery,
            _ => Self::Unspecified,
        }
    }
}

/// The launch context recorded for one hub run.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubLaunch {
    pub reason: HubLaunchReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher_process_id: Option<u32>,
}

impl HubLaunch {
    /// Reads the reason the launcher passed and the launcher's process id.
    pub fn observed(reason: Option<&str>) -> Self {
        let parent = unsafe { libc::getppid() };
        Self {
            reason: HubLaunchReason::parse(reason),
            launcher_process_id: u32::try_from(parent).ok().filter(|parent| *parent > 1),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HubExitCause {
    /// Serve returned normally, as after a `backend.shutdown` request.
    Shutdown,
    /// Serve returned an error.
    Error,
    /// A terminating signal ended the hub.
    Signal,
    /// A panic unwound out of serve.
    Panic,
    /// The hub ended without writing an ending; a successor observed it.
    Unrecorded,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubExitRecordV1 {
    pub(crate) cause: HubExitCause,
    pub(crate) recorded_at_ms: i64,
    pub(crate) uptime_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    /// Set when a later hub recorded this run's ending on its behalf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recorded_by_process_id: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubPanicRecordV1 {
    pub(crate) at_ms: i64,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) location: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubRunRecordV1 {
    pub(crate) schema_version: u16,
    pub(crate) process_id: u32,
    pub(crate) generation: String,
    pub(crate) build_id: String,
    pub(crate) started_at_ms: i64,
    pub(crate) last_alive_at_ms: i64,
    pub(crate) launch: HubLaunch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_panic: Option<HubPanicRecordV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exit: Option<HubExitRecordV1>,
}

/// The single writer of one hub run's record.
pub(crate) struct HubRunRecorder {
    path: PathBuf,
    record: Mutex<HubRunRecordV1>,
}

impl HubRunRecorder {
    /// Writes this run's record, then settles predecessors and retention.
    pub(crate) fn start(
        backend_root: &Path,
        generation: &str,
        build_id: &str,
        launch: HubLaunch,
    ) -> Result<Self, ControlPlaneError> {
        let directory = ensure_owner_subdirectory(backend_root, RUNS_DIRECTORY)?;
        let started_at_ms = now_ms()?;
        let process_id = std::process::id();
        let record = HubRunRecordV1 {
            schema_version: RECORD_SCHEMA_VERSION,
            process_id,
            generation: generation.into(),
            build_id: build_id.into(),
            started_at_ms,
            last_alive_at_ms: started_at_ms,
            launch,
            last_panic: None,
            exit: None,
        };
        let path = directory.join(record_file_name(started_at_ms, process_id));
        private_record::write(&path, &record)?;
        let recorder = Self {
            path,
            record: Mutex::new(record),
        };
        recorder.settle_predecessors(backend_root, &directory);
        prune(&directory, &recorder.path);
        Ok(recorder)
    }

    fn lock(&self) -> MutexGuard<'_, HubRunRecordV1> {
        self.record
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, record: &HubRunRecordV1) -> Result<(), ControlPlaneError> {
        private_record::write(&self.path, record)
    }

    pub(crate) fn heartbeat(&self) -> Result<(), ControlPlaneError> {
        let mut record = self.lock();
        if record.exit.is_some() {
            return Ok(());
        }
        record.last_alive_at_ms = now_ms()?;
        self.persist(&record)
    }

    /// Records an ending. The first ending wins; later ones are ignored.
    pub(crate) fn record_exit(
        &self,
        cause: HubExitCause,
        signal: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), ControlPlaneError> {
        let mut record = self.lock();
        if record.exit.is_some() {
            return Ok(());
        }
        let recorded_at_ms = now_ms()?;
        record.last_alive_at_ms = recorded_at_ms;
        record.exit = Some(HubExitRecordV1 {
            cause,
            recorded_at_ms,
            uptime_ms: recorded_at_ms.saturating_sub(record.started_at_ms).max(0),
            signal: signal.map(bounded_text),
            error: error.map(bounded_text),
            recorded_by_process_id: None,
        });
        self.persist(&record)
    }

    /// Called from the panic hook. A panic raised while this recorder holds
    /// its own lock is skipped rather than deadlocking the hook.
    fn record_panic(&self, info: &PanicHookInfo<'_>) {
        let mut record = match self.record.try_lock() {
            Ok(record) => record,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        let Ok(at_ms) = now_ms() else {
            return;
        };
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| (*message).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic payload is not text".into());
        record.last_panic = Some(HubPanicRecordV1 {
            at_ms,
            message: bounded_text(&message),
            location: info
                .location()
                .map(|location| bounded_text(&format!("{}:{}", location.file(), location.line()))),
        });
        let _ = self.persist(&record);
    }

    /// Marks earlier runs that ended without an ending as `unrecorded`.
    fn settle_predecessors(&self, backend_root: &Path, directory: &Path) {
        let (own_generation, own_process_id) = {
            let record = self.lock();
            (record.generation.clone(), record.process_id)
        };
        for path in record_paths(directory) {
            if path == self.path {
                continue;
            }
            let Ok(Some(source)) = private_record::read_bounded(&path, MAX_RECORD_BYTES) else {
                continue;
            };
            let Ok(mut record) = serde_json::from_slice::<HubRunRecordV1>(&source) else {
                continue;
            };
            if record.schema_version != RECORD_SCHEMA_VERSION
                || record.exit.is_some()
                || !run_has_ended(backend_root, &record, &own_generation)
            {
                continue;
            }
            let Ok(recorded_at_ms) = now_ms() else {
                return;
            };
            record.exit = Some(HubExitRecordV1 {
                cause: HubExitCause::Unrecorded,
                recorded_at_ms,
                uptime_ms: record
                    .last_alive_at_ms
                    .saturating_sub(record.started_at_ms)
                    .max(0),
                signal: None,
                error: None,
                recorded_by_process_id: Some(own_process_id),
            });
            if let Err(error) = private_record::write(&path, &record) {
                eprintln!("dure-control-plane: hub run record was not settled: {error}");
            }
        }
    }
}

/// A run has ended when its process is gone and no process holds its
/// generation lock. The process check alone could be fooled by a reused
/// process id (which only delays settling); the lock check alone could race
/// the short tail between a hub releasing its lock and writing its ending.
fn run_has_ended(backend_root: &Path, record: &HubRunRecordV1, own_generation: &str) -> bool {
    if record.process_id == std::process::id() || process_exists(record.process_id) {
        return false;
    }
    // This hub holds its own generation's lock, so a predecessor in the same
    // generation has released it.
    record.generation == own_generation
        || generation_lock_released(backend_root, &record.generation)
}

fn process_exists(process_id: u32) -> bool {
    let Ok(process_id) = libc::pid_t::try_from(process_id) else {
        return false;
    };
    if process_id <= 0 {
        return false;
    }
    if unsafe { libc::kill(process_id, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn generation_lock_released(backend_root: &Path, generation: &str) -> bool {
    if !valid_generation(generation) {
        return false;
    }
    let lock = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(backend_root.join(format!("service.{generation}.lock")))
    {
        Ok(lock) => lock,
        Err(error) => return error.kind() == io::ErrorKind::NotFound,
    };
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return false;
    }
    unsafe {
        libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
    }
    true
}

fn record_file_name(started_at_ms: i64, process_id: u32) -> String {
    format!("run-{started_at_ms:013}-{process_id}.json")
}

/// Record paths, oldest first.
fn record_paths(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_str().is_some_and(|name| {
                name.starts_with("run-") && name.ends_with(".json") && name.len() <= 64
            })
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn prune(directory: &Path, own_path: &Path) {
    let paths = record_paths(directory);
    let excess = paths.len().saturating_sub(RETAINED_RECORDS);
    for path in paths.into_iter().take(excess) {
        if path == own_path {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("dure-control-plane: hub run record was not pruned: {error}");
            }
        }
    }
}

fn bounded_text(value: &str) -> String {
    value
        .chars()
        .take(MAX_TEXT_CHARS)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// The observers attached to one served hub process.
pub(crate) struct HubRun {
    recorder: Option<Arc<HubRunRecorder>>,
    heartbeat: Option<JoinHandle<()>>,
    finished: bool,
}

impl HubRun {
    /// Starts recording this process's run. Recording problems are reported
    /// on stderr and leave the hub serving without a record.
    pub(crate) fn begin(
        backend_root: &Path,
        generation: &str,
        build_id: &str,
        launch: HubLaunch,
    ) -> Self {
        let recorder = match HubRunRecorder::start(backend_root, generation, build_id, launch) {
            Ok(recorder) => Arc::new(recorder),
            Err(error) => {
                eprintln!("dure-control-plane: hub run record is unavailable: {error}");
                return Self {
                    recorder: None,
                    heartbeat: None,
                    finished: false,
                };
            }
        };
        let previous_hook = std::panic::take_hook();
        let panic_recorder = Arc::clone(&recorder);
        std::panic::set_hook(Box::new(move |info| {
            panic_recorder.record_panic(info);
            previous_hook(info);
        }));
        // Register before serve publishes the descriptor, so a launcher that
        // signals the hub as soon as it is discoverable is observed. The
        // observer stays registered until the process ends, so a signal during
        // shutdown still ends the hub as it did before.
        tokio::spawn(record_terminating_signal(
            Arc::clone(&recorder),
            TerminatingSignals::register(),
        ));
        let heartbeat_recorder = Arc::clone(&recorder);
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await;
            loop {
                interval.tick().await;
                let recorder = Arc::clone(&heartbeat_recorder);
                if let Ok(Err(error)) =
                    tokio::task::spawn_blocking(move || recorder.heartbeat()).await
                {
                    eprintln!("dure-control-plane: hub heartbeat was not recorded: {error}");
                }
            }
        });
        Self {
            recorder: Some(recorder),
            heartbeat: Some(heartbeat),
            finished: false,
        }
    }

    /// Records how serve ended.
    pub(crate) fn finish(mut self, result: &Result<(), ControlPlaneError>) {
        self.finished = true;
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        let Some(recorder) = self.recorder.as_ref() else {
            return;
        };
        let recorded = match result {
            Ok(()) => recorder.record_exit(HubExitCause::Shutdown, None, None),
            Err(error) => recorder.record_exit(HubExitCause::Error, None, Some(&error.to_string())),
        };
        if let Err(error) = recorded {
            eprintln!("dure-control-plane: hub exit was not recorded: {error}");
        }
    }
}

impl Drop for HubRun {
    fn drop(&mut self) {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        if self.finished || !std::thread::panicking() {
            return;
        }
        if let Some(recorder) = self.recorder.as_ref() {
            let _ = recorder.record_exit(HubExitCause::Panic, None, None);
        }
    }
}

struct TerminatingSignals {
    terminate: Option<tokio::signal::unix::Signal>,
    interrupt: Option<tokio::signal::unix::Signal>,
    hangup: Option<tokio::signal::unix::Signal>,
}

impl TerminatingSignals {
    /// Observes only signals whose current action ends the process. A signal
    /// the hub inherited as ignored stays ignored.
    fn register() -> Self {
        use tokio::signal::unix::{SignalKind, signal};
        let observe = |number: libc::c_int| {
            (!signal_is_ignored(number))
                .then(|| signal(SignalKind::from_raw(number)).ok())
                .flatten()
        };
        Self {
            terminate: observe(libc::SIGTERM),
            interrupt: observe(libc::SIGINT),
            hangup: observe(libc::SIGHUP),
        }
    }
}

fn signal_is_ignored(number: libc::c_int) -> bool {
    let mut current = std::mem::MaybeUninit::<libc::sigaction>::zeroed();
    if unsafe { libc::sigaction(number, std::ptr::null(), current.as_mut_ptr()) } != 0 {
        return false;
    }
    unsafe { current.assume_init() }.sa_sigaction == libc::SIG_IGN
}

async fn received(signal: &mut Option<tokio::signal::unix::Signal>) {
    match signal {
        Some(signal) => {
            signal.recv().await;
        }
        None => std::future::pending().await,
    }
}

async fn record_terminating_signal(recorder: Arc<HubRunRecorder>, mut signals: TerminatingSignals) {
    let (number, name) = tokio::select! {
        () = received(&mut signals.terminate) => (libc::SIGTERM, "SIGTERM"),
        () = received(&mut signals.interrupt) => (libc::SIGINT, "SIGINT"),
        () = received(&mut signals.hangup) => (libc::SIGHUP, "SIGHUP"),
    };
    if let Err(error) = recorder.record_exit(HubExitCause::Signal, Some(name), None) {
        eprintln!("dure-control-plane: hub exit was not recorded: {error}");
    }
    // Restore the default action and deliver the signal again, so the hub
    // ends exactly as it would have without this observer.
    unsafe {
        libc::signal(number, libc::SIG_DFL);
        libc::raise(number);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn backend_root() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        home
    }

    fn read_record(path: &Path) -> HubRunRecordV1 {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn launch() -> HubLaunch {
        HubLaunch {
            reason: HubLaunchReason::RestartUnreachable,
            launcher_process_id: Some(4242),
        }
    }

    fn write_predecessor(directory: &Path, record: &HubRunRecordV1) -> PathBuf {
        let path = directory.join(record_file_name(record.started_at_ms, record.process_id));
        private_record::write(&path, record).unwrap();
        path
    }

    fn exited_process_id() -> u32 {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let process_id = child.id();
        child.wait().unwrap();
        process_id
    }

    fn predecessor(process_id: u32, generation: &str) -> HubRunRecordV1 {
        HubRunRecordV1 {
            schema_version: RECORD_SCHEMA_VERSION,
            process_id,
            generation: generation.into(),
            build_id: "build-old".into(),
            started_at_ms: 1_000,
            last_alive_at_ms: 61_000,
            launch: HubLaunch {
                reason: HubLaunchReason::FirstStart,
                launcher_process_id: None,
            },
            last_panic: None,
            exit: None,
        }
    }

    #[test]
    fn launch_reasons_parse_known_values_and_default_to_unspecified() {
        for (value, reason) in [
            ("first_start", HubLaunchReason::FirstStart),
            ("restart_unreachable", HubLaunchReason::RestartUnreachable),
            ("replacement", HubLaunchReason::Replacement),
            ("activation_recovery", HubLaunchReason::ActivationRecovery),
        ] {
            assert_eq!(HubLaunchReason::parse(Some(value)), reason);
            assert_eq!(serde_json::to_value(reason).unwrap(), value);
        }
        assert_eq!(
            HubLaunchReason::parse(Some("other")),
            HubLaunchReason::Unspecified
        );
        assert_eq!(HubLaunchReason::parse(None), HubLaunchReason::Unspecified);
        assert_eq!(
            serde_json::from_str::<HubLaunchReason>("\"from_a_newer_launcher\"").unwrap(),
            HubLaunchReason::Unspecified
        );
    }

    #[test]
    fn a_run_records_its_start_heartbeat_and_first_ending() {
        let home = backend_root();
        let recorder =
            HubRunRecorder::start(home.path(), "local-v1-current", "build-1", launch()).unwrap();
        let started = read_record(&recorder.path);
        assert_eq!(started.process_id, std::process::id());
        assert_eq!(started.generation, "local-v1-current");
        assert_eq!(started.build_id, "build-1");
        assert_eq!(started.launch, launch());
        assert_eq!(started.exit, None);
        let mode = fs::metadata(&recorder.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "the record is owner-only");

        recorder.heartbeat().unwrap();
        assert!(read_record(&recorder.path).last_alive_at_ms >= started.started_at_ms);

        recorder
            .record_exit(HubExitCause::Signal, Some("SIGTERM"), None)
            .unwrap();
        recorder
            .record_exit(HubExitCause::Shutdown, None, None)
            .unwrap();
        let ended = read_record(&recorder.path);
        let exit = ended.exit.expect("the ending is recorded");
        assert_eq!(exit.cause, HubExitCause::Signal);
        assert_eq!(exit.signal.as_deref(), Some("SIGTERM"));
        assert_eq!(exit.recorded_by_process_id, None);
        assert!(exit.uptime_ms >= 0);

        recorder.heartbeat().unwrap();
        assert_eq!(
            read_record(&recorder.path).last_alive_at_ms,
            ended.last_alive_at_ms
        );
    }

    #[test]
    fn a_successor_settles_a_predecessor_that_ended_without_a_record() {
        let home = backend_root();
        let directory = ensure_owner_subdirectory(home.path(), RUNS_DIRECTORY).unwrap();
        let killed = write_predecessor(
            &directory,
            &predecessor(exited_process_id(), "local-v1-current"),
        );

        let recorder =
            HubRunRecorder::start(home.path(), "local-v1-current", "build-1", launch()).unwrap();

        let settled = read_record(&killed);
        let exit = settled
            .exit
            .expect("the successor records the missing ending");
        assert_eq!(exit.cause, HubExitCause::Unrecorded);
        assert_eq!(
            exit.uptime_ms, 60_000,
            "uptime is bounded by the last heartbeat"
        );
        assert_eq!(exit.recorded_by_process_id, Some(std::process::id()));
        assert_eq!(settled.last_alive_at_ms, 61_000);
        assert_eq!(read_record(&recorder.path).exit, None);
    }

    #[test]
    fn a_successor_leaves_a_live_or_lock_holding_predecessor_running() {
        let home = backend_root();
        let directory = ensure_owner_subdirectory(home.path(), RUNS_DIRECTORY).unwrap();
        let mut sleeper = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let live = write_predecessor(&directory, &predecessor(sleeper.id(), "local-v1-current"));

        let other_generation = "local-v1-other";
        let lock = crate::owner_file(&home.path().join(format!("service.{other_generation}.lock")))
            .unwrap();
        // flock conflicts between open file descriptions, so this handle
        // stands in for another hub holding that generation.
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let mut locked_record = predecessor(exited_process_id(), other_generation);
        locked_record.started_at_ms = 2_000;
        let locked = write_predecessor(&directory, &locked_record);

        HubRunRecorder::start(home.path(), "local-v1-current", "build-1", launch()).unwrap();

        assert_eq!(read_record(&live).exit, None);
        assert_eq!(read_record(&locked).exit, None);
        drop(lock);
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

    #[test]
    fn retention_keeps_the_newest_records() {
        let home = backend_root();
        let directory = ensure_owner_subdirectory(home.path(), RUNS_DIRECTORY).unwrap();
        let mut ended = predecessor(exited_process_id(), "local-v1-current");
        ended.exit = Some(HubExitRecordV1 {
            cause: HubExitCause::Shutdown,
            recorded_at_ms: 61_000,
            uptime_ms: 60_000,
            signal: None,
            error: None,
            recorded_by_process_id: None,
        });
        for index in 0..RETAINED_RECORDS + 3 {
            ended.started_at_ms = 1_000 + index as i64;
            write_predecessor(&directory, &ended);
        }

        let recorder =
            HubRunRecorder::start(home.path(), "local-v1-current", "build-1", launch()).unwrap();

        let paths = record_paths(&directory);
        assert_eq!(paths.len(), RETAINED_RECORDS);
        assert_eq!(paths.last(), Some(&recorder.path));
        assert!(
            !directory
                .join(record_file_name(1_000, ended.process_id))
                .exists()
        );
    }

    #[test]
    fn panic_text_is_bounded_and_single_line() {
        let text = bounded_text(&format!("line one\nline two{}", "x".repeat(2_000)));
        assert_eq!(text.chars().count(), MAX_TEXT_CHARS);
        assert!(text.starts_with("line one line two"));
    }
}
