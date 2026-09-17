use fs2::FileExt;
use hmux_host::local_protocol::SessionFence;
use serde::Serialize;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::host_resource_budget::HostResourceSnapshot;

pub(crate) mod broker_timing;

const DIAGNOSTICS_DIRECTORY: &str = ".diagnostics";
const RUNTIME_DIRECTORY: &str = "runtime-v1";
const RUNTIME_FILE: &str = "runtime.jsonl";
const LOCK_FILE: &str = ".runtime.lock";
const MAX_RECORD_BYTES: usize = 4 * 1024;
const PANIC_MESSAGE_BYTES: usize = 1024;
const PANIC_RECORD_ATTEMPTS: usize = 5;
const PANIC_RECORD_RETRY: std::time::Duration = std::time::Duration::from_millis(10);
const MAX_FILE_BYTES: u64 = 256 * 1024;
const ROTATED_FILES: usize = 3;

#[derive(Clone)]
pub(crate) struct RuntimeDiagnostics {
    inner: Option<Arc<RuntimeDiagnosticsInner>>,
}

struct RuntimeDiagnosticsInner {
    context: RuntimeDiagnosticContext,
    sink: Mutex<RotatingFileSink>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDiagnosticContext {
    build_info: RuntimeBuildInfo,
    session: RuntimeSessionIdentity,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBuildInfo {
    build_id: String,
    source: &'static str,
    protocol: RuntimeProtocolRange,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct RuntimeProtocolRange {
    minimum: &'static str,
    maximum: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSessionIdentity {
    workspace_id: String,
    session_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeDiagnosticEvent {
    HostStarting,
    HostReady,
    ListenerDegraded,
    ListenerRecovered,
    ConnectionAccepted,
    ConnectionRejected,
    AttachReady,
    AttachFailed,
    AttachDetached,
    SubscriberBackpressure,
    ProviderExit,
    TerminalResizeFailed,
    #[cfg(feature = "terminal-state-stream")]
    TerminalHistoryDegraded,
    TerminalPresentationDegraded,
    PresentationCheckpointDegraded,
    PresentationCheckpointRecovered,
    PresentationCheckpointFinal,
    HostPanic,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDiagnosticFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    transport_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attach_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    controller_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscriber_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_backpressure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropped_records: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropped_bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_error: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_classification: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_phase: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt_count: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_workers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_connection_workers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_pending_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_active_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejected_pending_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejected_active_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queued_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_queued_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejected_queue_pushes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panic_thread: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panic_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panic_message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnosticRecord<'a> {
    schema_version: u8,
    timestamp_unix_ms: String,
    event: RuntimeDiagnosticEvent,
    #[serde(flatten)]
    context: &'a RuntimeDiagnosticContext,
    #[serde(flatten)]
    fields: &'a RuntimeDiagnosticFields,
}

struct RotatingFileSink {
    path: PathBuf,
    lock_path: PathBuf,
    maximum_bytes: u64,
    rotated_files: usize,
    #[cfg(test)]
    fault_raw_os_error: Option<i32>,
}

impl RuntimeDiagnosticContext {
    pub(crate) fn new(build_id: &str, fence: &SessionFence) -> Self {
        Self {
            build_info: RuntimeBuildInfo {
                build_id: build_id.to_string(),
                source: "hmux_runtime",
                protocol: RuntimeProtocolRange {
                    minimum: "1.0",
                    maximum: "1.0",
                },
            },
            session: RuntimeSessionIdentity {
                workspace_id: fence.workspace_id.clone(),
                session_id: fence.session_id.clone(),
                runner_principal: fence.runner_principal.clone(),
                runner_instance: fence.runner_instance.clone(),
                channel_epoch: fence.channel_epoch.to_string(),
                host_instance_id: fence.host_instance_id.clone(),
                terminal_epoch: fence.terminal_epoch.clone(),
            },
        }
    }
}

impl RuntimeDiagnosticFields {
    pub(crate) fn listener_accept_failed(error: &io::Error) -> Self {
        Self {
            transport_state: Some("retrying"),
            failure_code: Some("listener_accept_failed"),
            os_error: error.raw_os_error(),
            ..Self::default()
        }
    }

    pub(crate) fn transport(state: &'static str) -> Self {
        Self {
            transport_state: Some(state),
            ..Self::default()
        }
    }

    pub(crate) fn attach_ready(
        mode: &'static str,
        output_sequence: u64,
        controller_generation: u64,
        subscriber_count: usize,
    ) -> Self {
        Self {
            attach_mode: Some(mode),
            output_sequence: Some(output_sequence.to_string()),
            controller_generation: Some(controller_generation.to_string()),
            subscriber_count: Some(subscriber_count),
            ..Self::default()
        }
    }

    pub(crate) fn attach_failed(code: &'static str) -> Self {
        Self {
            failure_code: Some(code),
            ..Self::default()
        }
    }

    pub(crate) fn attach_detached(mode: &'static str, subscriber_count: usize) -> Self {
        Self {
            attach_mode: Some(mode),
            subscriber_count: Some(subscriber_count),
            ..Self::default()
        }
    }

    pub(crate) fn backpressure(accounted_bytes: usize, output_sequence: Option<u64>) -> Self {
        Self {
            output_sequence: output_sequence.map(|value| value.to_string()),
            queue_backpressure: Some(true),
            dropped_records: Some("1".to_string()),
            dropped_bytes: Some(accounted_bytes.to_string()),
            ..Self::default()
        }
    }

    pub(crate) fn provider_exit(
        classification: &'static str,
        exit_code: Option<i32>,
        output_sequence: u64,
    ) -> Self {
        Self {
            output_sequence: Some(output_sequence.to_string()),
            exit_classification: Some(classification),
            exit_code,
            ..Self::default()
        }
    }

    pub(crate) fn terminal_presentation_degraded(
        failure_code: &'static str,
        output_sequence: u64,
    ) -> Self {
        Self {
            output_sequence: Some(output_sequence.to_string()),
            failure_code: Some(failure_code),
            ..Self::default()
        }
    }

    pub(crate) fn terminal_resize_failed(stage: &'static str, failure_code: &'static str) -> Self {
        Self {
            failure_code: Some(failure_code),
            failure_stage: Some(stage),
            ..Self::default()
        }
    }

    pub(crate) fn checkpoint(
        state: &'static str,
        output_sequence: u64,
        attempts: usize,
        phase: Option<&'static str>,
        failure_code: Option<&'static str>,
    ) -> Self {
        Self {
            output_sequence: Some(output_sequence.to_string()),
            failure_code,
            checkpoint_state: Some(state),
            checkpoint_phase: phase,
            attempt_count: Some(attempts.to_string()),
            ..Self::default()
        }
    }

    pub(crate) fn host_panic(info: &std::panic::PanicHookInfo<'_>) -> Self {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| (*message).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());
        Self {
            panic_thread: Some(
                std::thread::current()
                    .name()
                    .unwrap_or("unnamed")
                    .to_string(),
            ),
            panic_location: info
                .location()
                .map(|location| format!("{}:{}", location.file(), location.line())),
            panic_message: Some(truncate_for_record(message, PANIC_MESSAGE_BYTES)),
            ..Self::default()
        }
    }

    pub(crate) fn with_resources(mut self, snapshot: HostResourceSnapshot) -> Self {
        self.connection_workers = Some(snapshot.connection_workers);
        self.peak_connection_workers = Some(snapshot.peak_connection_workers);
        self.pending_connections = Some(snapshot.pending_connections);
        self.active_connections = Some(snapshot.active_connections);
        self.peak_pending_connections = Some(snapshot.peak_pending_connections);
        self.peak_active_connections = Some(snapshot.peak_active_connections);
        self.rejected_pending_connections = Some(snapshot.rejected_pending_connections);
        self.rejected_active_connections = Some(snapshot.rejected_active_connections);
        self.queued_bytes = Some(snapshot.queued_bytes);
        self.peak_queued_bytes = Some(snapshot.peak_queued_bytes);
        self.rejected_queue_pushes = Some(snapshot.rejected_queue_pushes);
        self
    }
}

impl RuntimeDiagnostics {
    pub(crate) fn disabled() -> Self {
        Self { inner: None }
    }

    pub(crate) fn open(discovery_root: &Path, context: RuntimeDiagnosticContext) -> Self {
        if std::env::var("HMUX_RUNTIME_DIAGNOSTICS")
            .is_ok_and(|value| matches!(value.as_str(), "0" | "off"))
        {
            return Self::disabled();
        }
        Self::open_with_limits(discovery_root, context, MAX_FILE_BYTES, ROTATED_FILES)
            .unwrap_or_else(|_| Self::disabled())
    }

    fn open_with_limits(
        discovery_root: &Path,
        context: RuntimeDiagnosticContext,
        maximum_bytes: u64,
        rotated_files: usize,
    ) -> io::Result<Self> {
        Ok(Self {
            inner: Some(Arc::new(RuntimeDiagnosticsInner {
                context,
                sink: Mutex::new(RotatingFileSink::open(
                    discovery_root,
                    RUNTIME_FILE,
                    LOCK_FILE,
                    maximum_bytes,
                    rotated_files,
                )?),
            })),
        })
    }

    /// Records every panic in this process as a `host_panic` diagnostic before
    /// the default hook prints it. A Host that dies of a panic otherwise
    /// leaves no evidence: its stderr is a null device unless an operator
    /// set `HMUX_RUNTIME_LOG` ahead of time, and the next client only sees a
    /// poisoned-lock refusal followed by a vanished process.
    pub(crate) fn install_panic_hook(&self) {
        if self.inner.is_none() {
            return;
        }
        let diagnostics = self.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // An ordinary record yields to a busy cross-Host file lock. A
            // panic record is the one that must land, so retry briefly.
            let fields = RuntimeDiagnosticFields::host_panic(info);
            for attempt in 1..=PANIC_RECORD_ATTEMPTS {
                if diagnostics.record(RuntimeDiagnosticEvent::HostPanic, fields.clone())
                    || attempt == PANIC_RECORD_ATTEMPTS
                {
                    break;
                }
                std::thread::sleep(PANIC_RECORD_RETRY);
            }
            previous(info);
        }));
    }

    pub(crate) fn record(
        &self,
        event: RuntimeDiagnosticEvent,
        fields: RuntimeDiagnosticFields,
    ) -> bool {
        let Some(inner) = self.inner.as_ref() else {
            return false;
        };
        let record = RuntimeDiagnosticRecord {
            schema_version: 1,
            timestamp_unix_ms: unix_time_ms().to_string(),
            event,
            context: &inner.context,
            fields: &fields,
        };
        let Some(payload) = record_payload(&record) else {
            return false;
        };
        inner
            .sink
            .lock()
            .is_ok_and(|mut sink| sink.append(&payload).is_ok())
    }
}

impl RotatingFileSink {
    fn open(
        discovery_root: &Path,
        file: &str,
        lock: &str,
        maximum_bytes: u64,
        rotated_files: usize,
    ) -> io::Result<Self> {
        let directory = discovery_root
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY);
        ensure_private_directory(&discovery_root.join(DIAGNOSTICS_DIRECTORY))?;
        ensure_private_directory(&directory)?;
        Ok(Self {
            path: directory.join(file),
            lock_path: directory.join(lock),
            maximum_bytes,
            rotated_files,
            #[cfg(test)]
            fault_raw_os_error: None,
        })
    }

    fn append(&mut self, payload: &[u8]) -> io::Result<()> {
        #[cfg(test)]
        if let Some(raw_os_error) = self.fault_raw_os_error {
            return Err(io::Error::from_raw_os_error(raw_os_error));
        }
        let lock_file = open_owner_file(&self.lock_path, true)?;
        lock_file.try_lock_exclusive()?;
        let result = (|| {
            let current_bytes = safe_regular_file_metadata(&self.path)?
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if current_bytes.saturating_add(payload.len() as u64) > self.maximum_bytes {
                self.rotate()?;
            }
            let mut file = open_owner_file(&self.path, false)?;
            file.write_all(payload)
        })();
        let unlock_result = FileExt::unlock(&lock_file);
        result.and(unlock_result)
    }

    fn rotate(&self) -> io::Result<()> {
        for index in (1..=self.rotated_files).rev() {
            let destination = rotated_path(&self.path, index);
            if index == self.rotated_files {
                remove_safe_regular_file(&destination)?;
            }
            let source = if index == 1 {
                self.path.clone()
            } else {
                rotated_path(&self.path, index - 1)
            };
            if safe_regular_file_metadata(&source)?.is_some() {
                fs::rename(source, destination)?;
            }
        }
        Ok(())
    }
}

fn record_payload(record: &impl Serialize) -> Option<Vec<u8>> {
    let mut payload = serde_json::to_vec(record).ok()?;
    payload.push(b'\n');
    (payload.len() <= MAX_RECORD_BYTES).then_some(payload)
}

fn open_owner_file(path: &Path, read: bool) -> io::Result<File> {
    let create = safe_regular_file_metadata(path)?.is_none();
    let mut options = OpenOptions::new();
    options
        .read(read)
        .write(true)
        .append(true)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    require_owner_regular_file(&metadata)?;
    if metadata.mode() & 0o7777 != 0o600 {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        // SAFETY: geteuid has no pointer arguments and does not dereference memory.
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime diagnostics directory is unsafe",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

fn safe_regular_file_metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            require_owner_regular_file(&metadata)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn require_owner_regular_file(metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        // SAFETY: geteuid has no pointer arguments and does not dereference memory.
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime diagnostics file is unsafe",
        ));
    }
    Ok(())
}

fn remove_safe_regular_file(path: &Path) -> io::Result<()> {
    if safe_regular_file_metadata(path)?.is_some() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn truncate_for_record(mut message: String, maximum_bytes: usize) -> String {
    if message.len() <= maximum_bytes {
        return message;
    }
    let mut end = maximum_bytes;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message.push_str("...");
    message
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    let mut rotated = OsString::from(path.as_os_str());
    rotated.push(format!(".{index}"));
    PathBuf::from(rotated)
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
#[path = "runtime_diagnostics_file_tests.rs"]
mod file_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::{Duration, Instant};

    fn context() -> RuntimeDiagnosticContext {
        RuntimeDiagnosticContext::new(
            "build-1",
            &SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "local-user".into(),
                runner_instance: "runner".into(),
                channel_epoch: 1,
                host_instance_id: "host".into(),
                terminal_epoch: "terminal".into(),
            },
        )
    }

    #[test]
    fn rotates_at_the_byte_bound_and_keeps_owner_only_files() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics =
            RuntimeDiagnostics::open_with_limits(root.path(), context(), 900, 2).unwrap();
        for _ in 0..12 {
            assert!(diagnostics.record(
                RuntimeDiagnosticEvent::HostReady,
                RuntimeDiagnosticFields::transport("listening"),
            ));
        }
        let directory = root
            .path()
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY);
        let files = fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(RUNTIME_FILE))
                    .then_some(path)
            })
            .collect::<Vec<_>>();

        assert!(files.len() >= 2);
        assert!(files.len() <= 3);
        assert!(files.iter().all(|path| {
            let metadata = fs::metadata(path).unwrap();
            metadata.len() <= 900 && metadata.permissions().mode() & 0o777 == 0o600
        }));
    }

    #[test]
    fn unsafe_or_unwritable_destination_disables_diagnostics_without_panicking() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(DIAGNOSTICS_DIRECTORY)).unwrap();
        symlink(
            root.path().join("outside"),
            root.path()
                .join(DIAGNOSTICS_DIRECTORY)
                .join(RUNTIME_DIRECTORY),
        )
        .unwrap();

        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        assert!(!diagnostics.record(
            RuntimeDiagnosticEvent::HostReady,
            RuntimeDiagnosticFields::default(),
        ));
    }

    #[test]
    fn disabled_and_full_disk_sinks_never_affect_the_runtime_path() {
        assert!(!RuntimeDiagnostics::disabled().record(
            RuntimeDiagnosticEvent::HostStarting,
            RuntimeDiagnosticFields::default(),
        ));

        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        diagnostics
            .inner
            .as_ref()
            .unwrap()
            .sink
            .lock()
            .unwrap()
            .fault_raw_os_error = Some(libc::ENOSPC);

        assert!(!diagnostics.record(
            RuntimeDiagnosticEvent::ProviderExit,
            RuntimeDiagnosticFields::provider_exit("normal", Some(0), 12),
        ));
    }

    #[test]
    fn busy_cross_session_lock_drops_diagnostic_without_blocking() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        let lock_path = root
            .path()
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY)
            .join(LOCK_FILE);
        let lock = open_owner_file(&lock_path, true).unwrap();
        lock.lock_exclusive().unwrap();

        let started = Instant::now();
        assert!(!diagnostics.record(
            RuntimeDiagnosticEvent::PresentationCheckpointFinal,
            RuntimeDiagnosticFields::checkpoint("durable", 7, 1, None, None),
        ));
        assert!(started.elapsed() < Duration::from_millis(100));
        FileExt::unlock(&lock).unwrap();
    }

    #[test]
    fn typed_records_never_accept_payload_or_authority_fields() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        assert!(diagnostics.record(
            RuntimeDiagnosticEvent::SubscriberBackpressure,
            RuntimeDiagnosticFields::backpressure(42, Some(7)),
        ));
        let directory = root
            .path()
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY);
        let file = fs::read_dir(directory)
            .unwrap()
            .find(|entry| {
                entry
                    .as_ref()
                    .is_ok_and(|entry| entry.file_name() == RUNTIME_FILE)
            })
            .unwrap()
            .unwrap()
            .path();
        let raw = fs::read_to_string(file).unwrap();

        assert!(raw.contains("\"droppedBytes\":\"42\""));
        assert!(!raw.contains("capabilityToken"));
        assert!(!raw.contains("environment"));
        assert!(!raw.contains("payload"));
    }

    #[test]
    fn resource_records_expose_only_bounded_counters_and_rejection_codes() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        assert!(diagnostics.record(
            RuntimeDiagnosticEvent::ConnectionRejected,
            RuntimeDiagnosticFields::attach_failed("pending_connection_limit").with_resources(
                HostResourceSnapshot {
                    connection_workers: 17,
                    peak_connection_workers: 17,
                    pending_connections: 16,
                    active_connections: 64,
                    peak_pending_connections: 16,
                    peak_active_connections: 64,
                    rejected_pending_connections: 7,
                    rejected_active_connections: 3,
                    queued_bytes: 1024,
                    peak_queued_bytes: 2048,
                    rejected_queue_pushes: 2,
                },
            ),
        ));
        let file = root
            .path()
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY)
            .join(RUNTIME_FILE);
        let raw = fs::read_to_string(file).unwrap();

        assert!(raw.contains("\"event\":\"connection_rejected\""));
        assert!(raw.contains("\"failureCode\":\"pending_connection_limit\""));
        assert!(raw.contains("\"connectionWorkers\":17"));
        assert!(raw.contains("\"peakConnectionWorkers\":17"));
        assert!(raw.contains("\"activeConnections\":64"));
        assert!(raw.contains("\"peakQueuedBytes\":2048"));
        assert!(raw.contains("\"rejectedQueuePushes\":2"));
        assert!(!raw.contains("capabilityToken"));
        assert!(!raw.contains("payload"));
    }

    #[test]
    fn checkpoint_degradation_record_is_typed_and_redacted() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        assert!(diagnostics.record(
            RuntimeDiagnosticEvent::PresentationCheckpointDegraded,
            RuntimeDiagnosticFields::checkpoint(
                "degraded",
                42,
                1,
                Some("directory_sync"),
                Some("no_space"),
            ),
        ));
        let directory = root
            .path()
            .join(DIAGNOSTICS_DIRECTORY)
            .join(RUNTIME_DIRECTORY);
        let file = fs::read_dir(directory)
            .unwrap()
            .find(|entry| {
                entry
                    .as_ref()
                    .is_ok_and(|entry| entry.file_name() == RUNTIME_FILE)
            })
            .unwrap()
            .unwrap()
            .path();
        let raw = fs::read_to_string(file).unwrap();

        assert!(raw.contains("\"event\":\"presentation_checkpoint_degraded\""));
        assert!(raw.contains("\"outputSequence\":\"42\""));
        assert!(raw.contains("\"checkpointPhase\":\"directory_sync\""));
        assert!(raw.contains("\"failureCode\":\"no_space\""));
        assert!(!raw.contains("presentation.json"));
        assert!(!raw.contains("repaint"));
        assert!(!raw.contains("payload"));
    }

    #[test]
    fn resize_failure_record_retains_only_bounded_stage_and_cause() {
        let root = tempfile::tempdir().unwrap();
        let diagnostics = RuntimeDiagnostics::open(root.path(), context());
        assert!(diagnostics.record(
            RuntimeDiagnosticEvent::TerminalResizeFailed,
            RuntimeDiagnosticFields::terminal_resize_failed("pty_platform", "platform_api",),
        ));
        let raw = fs::read_to_string(
            root.path()
                .join(DIAGNOSTICS_DIRECTORY)
                .join(RUNTIME_DIRECTORY)
                .join(RUNTIME_FILE),
        )
        .unwrap();

        assert!(raw.contains("\"event\":\"terminal_resize_failed\""));
        assert!(raw.contains("\"failureStage\":\"pty_platform\""));
        assert!(raw.contains("\"failureCode\":\"platform_api\""));
        assert!(!raw.contains("payload"));
        assert!(!raw.contains("provider"));
    }
}
