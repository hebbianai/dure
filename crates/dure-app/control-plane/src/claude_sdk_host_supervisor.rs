use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

mod lease;
use hmux_client::{ProcessDescriptor, exact_local_process_generation};
pub use lease::{ClaudeSdkHostLease, ClaudeSdkHostSupervisorError};
use lease::{HostLaunchLock, PublishedHost, process_is_live};

const HOST_READY_TIMEOUT: Duration = Duration::from_secs(5);
const HOST_MARKER_MAX_BYTES: u64 = 64 * 1024;

pub struct ClaudeSdkHostSupervisorConfiguration {
    environment: Vec<(String, String)>,
    host_generation: String,
    node: PathBuf,
    runtime_root: PathBuf,
    state_root: PathBuf,
    address_root: PathBuf,
    entrypoint: PathBuf,
}

impl fmt::Debug for ClaudeSdkHostSupervisorConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeSdkHostSupervisorConfiguration")
            .field(
                "environment_keys",
                &self
                    .environment
                    .iter()
                    .map(|(key, _)| key)
                    .collect::<Vec<_>>(),
            )
            .field("host_generation", &self.host_generation)
            .field("node", &self.node)
            .field("runtime_root", &self.runtime_root)
            .field("state_root", &self.state_root)
            .field("address_root", &self.address_root)
            .field("entrypoint", &self.entrypoint)
            .finish()
    }
}

impl ClaudeSdkHostSupervisorConfiguration {
    pub fn new(
        node: impl Into<PathBuf>,
        entrypoint: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
        runtime_root: impl Into<PathBuf>,
        host_generation: impl Into<String>,
        environment: Vec<(String, String)>,
    ) -> Result<Self, ClaudeSdkHostSupervisorError> {
        let state_root = state_root.into();
        let mut configuration = Self::new_with_address_root(
            node,
            entrypoint,
            state_root.clone(),
            state_root,
            runtime_root,
            host_generation,
            environment,
        )?;
        configuration.address_root = configuration.state_root.clone();
        Ok(configuration)
    }

    pub(crate) fn new_with_address_root(
        node: impl Into<PathBuf>,
        entrypoint: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
        address_root: impl Into<PathBuf>,
        runtime_root: impl Into<PathBuf>,
        host_generation: impl Into<String>,
        environment: Vec<(String, String)>,
    ) -> Result<Self, ClaudeSdkHostSupervisorError> {
        let node = exact_regular_file(&node.into(), true, "node_invalid")?;
        let entrypoint = exact_regular_file(&entrypoint.into(), false, "entrypoint_invalid")?;
        let state_root = exact_owner_directory(&state_root.into(), "state_root_unsafe")?;
        let address_root = address_root.into();
        let runtime_root = exact_owner_directory(&runtime_root.into(), "runtime_root_unsafe")?;
        if state_root.to_str().is_none()
            || !address_root.is_absolute()
            || address_root.to_str().is_none()
        {
            return Err(ClaudeSdkHostSupervisorError::contract("state_root_unsafe"));
        }
        if runtime_root.to_str().is_none() {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "runtime_root_unsafe",
            ));
        }
        let host_generation = host_generation.into();
        if !safe_token(&host_generation) {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "host_generation_invalid",
            ));
        }
        let mut environment_keys = BTreeSet::new();
        if environment.iter().any(|(key, value)| {
            !environment_keys.insert(key)
                || key.is_empty()
                || !key.bytes().enumerate().all(|(index, byte)| {
                    byte == b'_'
                        || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
                })
                || value.contains('\0')
        }) {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "environment_invalid",
            ));
        }
        Ok(Self {
            environment,
            host_generation,
            node,
            runtime_root,
            state_root,
            address_root,
            entrypoint,
        })
    }
}

#[derive(Debug)]
enum SupervisorState {
    Empty,
    Running {
        child: Option<Child>,
        process: ProcessDescriptor,
        lease: ClaudeSdkHostLease,
        _owner_lifetime: Option<ChildStdin>,
        runtime_directory: PathBuf,
    },
    Failed {
        observed_at: std::time::Instant,
        /// Why the last spawn died, replayed to every caller the cooldown
        /// absorbs. Without it only the first caller in each 10s window ever
        /// learned the cause and the rest got a bare `host_exited` — which is
        /// how a capability-boundary crash looked causeless for a day
        /// (2026-08-31).
        detail: Option<String>,
    },
}

/// A failed host spawn must not wedge every Claude conversation forever: the
/// old permanent Failed latch turned one bad spawn into a day-long global
/// chat outage (2026-08-31). The latch still absorbs spawn storms, but after
/// the cooldown the next caller attempts a fresh spawn.
const HOST_RESPAWN_COOLDOWN: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(50)
} else {
    std::time::Duration::from_secs(10)
};

#[derive(Debug)]
pub struct ClaudeSdkHostSupervisor {
    configuration: ClaudeSdkHostSupervisorConfiguration,
    launch_count: u32,
    state: SupervisorState,
}

impl ClaudeSdkHostSupervisor {
    #[must_use]
    pub fn new(configuration: ClaudeSdkHostSupervisorConfiguration) -> Self {
        Self {
            configuration,
            launch_count: 0,
            state: SupervisorState::Empty,
        }
    }

    #[must_use]
    pub fn launch_count(&self) -> u32 {
        self.launch_count
    }

    #[must_use]
    pub fn is_started(&self) -> bool {
        matches!(self.state, SupervisorState::Running { .. })
    }

    pub fn ensure_started(&mut self) -> Result<ClaudeSdkHostLease, ClaudeSdkHostSupervisorError> {
        self.retire_observed_host()?;
        match &self.state {
            SupervisorState::Running { lease, .. } => return Ok(lease.clone()),
            SupervisorState::Failed {
                observed_at,
                detail,
            } => {
                if observed_at.elapsed() < HOST_RESPAWN_COOLDOWN {
                    // The reason stays `host_exited` — callers match on it to
                    // know they are inside the latch rather than looking at a
                    // fresh attempt. The detail says what actually died.
                    return Err(ClaudeSdkHostSupervisorError::contract("host_exited")
                        .with_detail(detail.clone()));
                }
                self.state = SupervisorState::Empty;
            }
            SupervisorState::Empty => {}
        }

        let launch_lock = HostLaunchLock::acquire(&self.configuration.state_root)?;
        if let Some(published) = launch_lock.read(&self.configuration.address_root)? {
            if published.live()? {
                let lease = published.lease();
                self.state = SupervisorState::Running {
                    child: None,
                    process: published.process,
                    lease: lease.clone(),
                    _owner_lifetime: None,
                    runtime_directory: published.runtime_directory,
                };
                return Ok(lease);
            }
        }

        let runtime_token = random_hex::<8>()?;
        let capability = random_hex::<32>()?;
        let runtime_directory = self
            .configuration
            .state_root
            .join(format!("ch.{runtime_token}"));
        // The host argv must name the capability file and the endpoint with one
        // lexical parent: the host's boundary check compares `path.dirname`
        // strings without resolving symlinks, so a durable-path capability next
        // to an aliased-address endpoint dies instantly with
        // capability_boundary_mismatch (2026-08-31: every Claude host spawn
        // failed this way after the address indirection landed, silently under
        // the then-discarded stderr). The address directory is an alias of the
        // state directory by construction, so the file is written once through
        // the durable path and read through the alias.
        let address_directory = self
            .configuration
            .address_root
            .join(format!("ch.{runtime_token}"));
        let endpoint = address_directory.join("host.sock");
        if endpoint.as_os_str().as_bytes().len() >= 100 {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "endpoint_path_too_long",
            ));
        }
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&runtime_directory)
            .map_err(|_| {
                ClaudeSdkHostSupervisorError::contract("runtime_directory_create_failed")
            })?;
        let capability_file = runtime_directory.join("host-capability");
        let capability_argument = address_directory.join("host-capability");
        if let Err(error) = write_owner_file(&capability_file, capability.as_bytes()) {
            let _ = cleanup_runtime_directory(&runtime_directory);
            return Err(error);
        }

        // Capture the host's stderr instead of discarding it: `Stdio::null()`
        // here turned two 2026-08-31 spawn-failure incidents into blind
        // debugging — `supervisor_host_exited` carried no cause at all. The
        // file lives in state_root (not the per-launch runtime directory) so
        // failure cleanup cannot delete the evidence, and is truncated per
        // spawn attempt so it always shows the latest failure.
        let stderr_log_path = self.configuration.state_root.join("host-stderr.log");
        let stderr_sink = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&stderr_log_path)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut command = Command::new(&self.configuration.node);
        command
            .arg(&self.configuration.entrypoint)
            .args([
                "--capability-file",
                capability_argument.to_str().ok_or_else(|| {
                    ClaudeSdkHostSupervisorError::contract("runtime_path_invalid")
                })?,
                "--endpoint",
                endpoint.to_str().ok_or_else(|| {
                    ClaudeSdkHostSupervisorError::contract("runtime_path_invalid")
                })?,
                "--host-generation",
                &self.configuration.host_generation,
                "--owner-lifetime",
                "stdin",
                "--runtime-root",
                self.configuration.runtime_root.to_str().ok_or_else(|| {
                    ClaudeSdkHostSupervisorError::contract("runtime_path_invalid")
                })?,
                "--state-dir",
                runtime_directory.to_str().ok_or_else(|| {
                    ClaudeSdkHostSupervisorError::contract("runtime_path_invalid")
                })?,
            ])
            .current_dir(&self.configuration.state_root)
            .env_clear()
            .envs(self.configuration.environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(stderr_sink);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                cleanup_runtime_directory(&runtime_directory)?;
                return Err(ClaudeSdkHostSupervisorError::contract("host_spawn_failed"));
            }
        };
        let Some(owner_lifetime) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_runtime_directory(&runtime_directory)?;
            return Err(ClaudeSdkHostSupervisorError::contract(
                "host_owner_lifetime_unavailable",
            ));
        };
        let process_id = child.id();
        if let Err(error) = wait_until_ready(
            &mut child,
            &endpoint,
            &capability_file,
            &runtime_directory.join("host.json"),
            &self.configuration.host_generation,
        ) {
            let _ = child.kill();
            let _ = child.wait();
            let stderr_tail = read_stderr_tail(&stderr_log_path);
            // The stderr log is truncated by the next spawn, so the tail is
            // copied into the latch here — this is the only moment it exists.
            let latched_detail = Some(match &stderr_tail {
                Some(tail) => format!("{}: {tail}", error.reason()),
                None => error.reason().to_string(),
            });
            self.state = SupervisorState::Failed {
                observed_at: std::time::Instant::now(),
                detail: latched_detail,
            };
            cleanup_runtime_directory(&runtime_directory)?;
            if let Some(tail) = &stderr_tail {
                eprintln!(
                    "dure_claude_sdk_host_supervisor: host {} failed before ready ({}); stderr tail: {tail}",
                    self.configuration.host_generation,
                    error.reason(),
                );
            }
            return Err(error.with_detail(stderr_tail));
        }
        let lease = ClaudeSdkHostLease {
            capability,
            endpoint,
            host_generation: self.configuration.host_generation.clone(),
            process_id,
        };
        let process = match exact_local_process_generation(process_id) {
            Ok(process) => process,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup_runtime_directory(&runtime_directory)?;
                return Err(ClaudeSdkHostSupervisorError::contract(
                    "host_observe_failed",
                ));
            }
        };
        let published =
            PublishedHost::new(lease.clone(), process.clone(), runtime_directory.clone());
        if let Err(error) = launch_lock.publish(&published) {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_runtime_directory(&runtime_directory)?;
            return Err(error);
        }
        self.launch_count += 1;
        self.state = SupervisorState::Running {
            child: Some(child),
            process,
            lease: lease.clone(),
            _owner_lifetime: Some(owner_lifetime),
            runtime_directory,
        };
        Ok(lease)
    }

    pub fn observe_exit(&mut self) -> Result<bool, ClaudeSdkHostSupervisorError> {
        if self.retire_observed_host()? {
            return Ok(true);
        }
        match self.state {
            SupervisorState::Running { .. } => Ok(false),
            SupervisorState::Failed { .. } => Ok(true),
            SupervisorState::Empty => Ok(false),
        }
    }

    pub(crate) fn owns_live_process(
        &mut self,
        expected_process_id: u32,
    ) -> Result<bool, ClaudeSdkHostSupervisorError> {
        self.retire_observed_host()?;
        Ok(matches!(
            &self.state,
            SupervisorState::Running { lease, .. } if lease.process_id() == expected_process_id
        ))
    }

    fn retire_observed_host(&mut self) -> Result<bool, ClaudeSdkHostSupervisorError> {
        let runtime_directory = match &mut self.state {
            SupervisorState::Running {
                child,
                process,
                runtime_directory,
                ..
            } => {
                let live = if let Some(child) = child {
                    child
                        .try_wait()
                        .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_observe_failed"))?
                        .is_none()
                } else {
                    process_is_live(process)?
                };
                if live {
                    return Ok(false);
                }
                runtime_directory.clone()
            }
            SupervisorState::Empty | SupervisorState::Failed { .. } => return Ok(false),
        };
        cleanup_runtime_directory(&runtime_directory)?;
        self.state = SupervisorState::Empty;
        Ok(true)
    }

    pub fn abort_generation(
        &mut self,
        expected_host_generation: &str,
    ) -> Result<(), ClaudeSdkHostSupervisorError> {
        let SupervisorState::Running {
            child,
            lease,
            runtime_directory,
            ..
        } = &mut self.state
        else {
            return Err(ClaudeSdkHostSupervisorError::contract("host_not_running"));
        };
        if lease.host_generation != expected_host_generation {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "stale_host_generation",
            ));
        }
        // Borrowing a discovered capability does not confer OS signal authority.
        // Adopted Hosts are retired through the authenticated DCH1 query/drain API.
        let child = child.as_mut().ok_or_else(|| {
            ClaudeSdkHostSupervisorError::contract("host_not_spawned_by_controller")
        })?;
        if child
            .try_wait()
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_observe_failed"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_abort_failed"))?;
            child
                .wait()
                .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_abort_failed"))?;
        }
        let runtime_directory = runtime_directory.clone();
        // A retirement is not a failure — nothing to replay.
        self.state = SupervisorState::Failed {
            observed_at: std::time::Instant::now(),
            detail: None,
        };
        cleanup_runtime_directory(&runtime_directory)?;
        Ok(())
    }
}

impl Drop for ClaudeSdkHostSupervisor {
    fn drop(&mut self) {
        let state = std::mem::replace(&mut self.state, SupervisorState::Empty);
        if let SupervisorState::Running {
            child: Some(mut child),
            ..
        } = state
        {
            // Controller loss detaches. Queries and replay remain Host-owned;
            // an empty, unowned Host exits itself. Reap without terminating it.
            let _ = thread::Builder::new()
                .name("claude-host-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn exact_regular_file(
    path: &Path,
    executable: bool,
    reason: &'static str,
) -> Result<PathBuf, ClaudeSdkHostSupervisorError> {
    if !path.is_absolute() {
        return Err(ClaudeSdkHostSupervisorError::contract(reason));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ClaudeSdkHostSupervisorError::contract(reason))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o022 != 0
        || executable && metadata.permissions().mode() & 0o111 == 0
    {
        return Err(ClaudeSdkHostSupervisorError::contract(reason));
    }
    fs::canonicalize(path).map_err(|_| ClaudeSdkHostSupervisorError::contract(reason))
}

fn exact_owner_directory(
    path: &Path,
    reason: &'static str,
) -> Result<PathBuf, ClaudeSdkHostSupervisorError> {
    if !path.is_absolute() {
        return Err(ClaudeSdkHostSupervisorError::contract(reason));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ClaudeSdkHostSupervisorError::contract(reason))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ClaudeSdkHostSupervisorError::contract(reason));
    }
    fs::canonicalize(path).map_err(|_| ClaudeSdkHostSupervisorError::contract(reason))
}

fn cleanup_runtime_directory(path: &Path) -> Result<(), ClaudeSdkHostSupervisorError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "runtime_directory_cleanup_failed",
            ));
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(ClaudeSdkHostSupervisorError::contract(
            "runtime_directory_cleanup_unsafe",
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("runtime_directory_cleanup_failed"))
}

fn random_hex<const N: usize>() -> Result<String, ClaudeSdkHostSupervisorError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("entropy_unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Last ~512 bytes of the host's captured stderr, collapsed to one line, for
/// spawn-failure evidence. `None` when the file is missing or empty so a
/// silent exit stays distinguishable from a crash with output.
fn read_stderr_tail(path: &Path) -> Option<String> {
    const TAIL_BYTES: usize = 512;
    let bytes = fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(TAIL_BYTES);
    let tail = String::from_utf8_lossy(&bytes[start..]);
    let collapsed = tail
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    (!collapsed.is_empty()).then_some(collapsed)
}

fn write_owner_file(path: &Path, value: &[u8]) -> Result<(), ClaudeSdkHostSupervisorError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("capability_write_failed"))?;
    file.write_all(value)
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("capability_write_failed"))?;
    file.sync_all()
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("capability_write_failed"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMarker {
    host_generation: String,
    pid: u32,
    role: String,
}

fn wait_until_ready(
    child: &mut Child,
    endpoint: &Path,
    capability_file: &Path,
    marker: &Path,
    host_generation: &str,
) -> Result<(), ClaudeSdkHostSupervisorError> {
    let deadline = Instant::now() + HOST_READY_TIMEOUT;
    loop {
        if child
            .try_wait()
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_observe_failed"))?
            .is_some()
        {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "host_exited_before_ready",
            ));
        }
        if let (Ok(endpoint_metadata), Ok(marker_metadata)) =
            (fs::symlink_metadata(endpoint), fs::symlink_metadata(marker))
        {
            if marker_metadata.file_type().is_symlink()
                || !marker_metadata.is_file()
                || marker_metadata.uid() != unsafe { libc::geteuid() }
                || marker_metadata.permissions().mode() & 0o077 != 0
                || marker_metadata.len() == 0
                || marker_metadata.len() > HOST_MARKER_MAX_BYTES
            {
                return Err(ClaudeSdkHostSupervisorError::contract(
                    "host_marker_invalid",
                ));
            }
            let source = fs::read(marker)
                .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_marker_invalid"))?;
            let marker: HostMarker = serde_json::from_slice(&source)
                .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_marker_invalid"))?;
            if !endpoint_metadata.file_type().is_socket()
                || endpoint_metadata.uid() != unsafe { libc::geteuid() }
                || endpoint_metadata.permissions().mode() & 0o077 != 0
                || marker.role != "dure-claude-sdk-host"
                || marker.pid != child.id()
                || marker.host_generation != host_generation
                || capability_file.exists()
            {
                return Err(ClaudeSdkHostSupervisorError::contract(
                    "host_ready_identity_mismatch",
                ));
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ClaudeSdkHostSupervisorError::contract("host_ready_timeout"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[cfg(target_os = "linux")]
    use std::ffi::OsString;
    use std::io::Read;
    use std::ops::{Deref, DerefMut};
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::net::UnixStream;

    struct SupervisorGuard {
        generation: String,
        supervisor: ClaudeSdkHostSupervisor,
    }

    impl Deref for SupervisorGuard {
        type Target = ClaudeSdkHostSupervisor;

        fn deref(&self) -> &Self::Target {
            &self.supervisor
        }
    }

    impl DerefMut for SupervisorGuard {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.supervisor
        }
    }

    impl Drop for SupervisorGuard {
        fn drop(&mut self) {
            let _ = self.supervisor.abort_generation(&self.generation);
        }
    }

    #[test]
    fn rejects_unsafe_state_root_before_start() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o750)).unwrap();
        let current_executable = std::env::current_exe().unwrap();
        let error = ClaudeSdkHostSupervisorConfiguration::new(
            &current_executable,
            &current_executable,
            root.path(),
            root.path(),
            "host-test-1",
            Vec::new(),
        )
        .unwrap_err();
        assert_eq!(error.reason(), "state_root_unsafe");
    }

    #[test]
    fn rejects_unsafe_runtime_root_before_start() {
        let state_root = tempfile::tempdir().unwrap();
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        fs::set_permissions(runtime_root.path(), fs::Permissions::from_mode(0o750)).unwrap();
        let current_executable = std::env::current_exe().unwrap();
        let error = ClaudeSdkHostSupervisorConfiguration::new(
            &current_executable,
            &current_executable,
            state_root.path(),
            runtime_root.path(),
            "host-test-1",
            Vec::new(),
        )
        .unwrap_err();
        assert_eq!(error.reason(), "runtime_root_unsafe");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_non_utf8_runtime_root_before_allocating_host_state() {
        let state_root = tempfile::tempdir().unwrap();
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let runtime_parent = tempfile::tempdir().unwrap();
        let runtime_root = runtime_parent.path().join(OsString::from_vec(vec![0xff]));
        fs::create_dir(&runtime_root).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        let current_executable = std::env::current_exe().unwrap();
        let error = ClaudeSdkHostSupervisorConfiguration::new(
            &current_executable,
            &current_executable,
            state_root.path(),
            &runtime_root,
            "host-test-1",
            Vec::new(),
        )
        .unwrap_err();
        assert_eq!(error.reason(), "runtime_root_unsafe");
        assert!(fs::read_dir(state_root.path()).unwrap().next().is_none());
    }

    /// Red-first contract for the respawn cooldown: a failed spawn latches
    /// Failed only for the cooldown window - afterwards the next caller
    /// attempts a fresh spawn instead of returning host_exited forever
    /// (a permanent latch once turned one bad spawn into a day-long global
    /// chat outage, 2026-08-31).
    #[test]
    fn failed_spawn_cools_down_then_respawns_instead_of_wedging_forever() {
        let state_root = tempfile::tempdir().unwrap();
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        fs::set_permissions(runtime_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let configuration = ClaudeSdkHostSupervisorConfiguration::new(
            Path::new("/usr/bin/true"),
            std::env::current_exe().unwrap(),
            state_root.path(),
            runtime_root.path(),
            "host-cooldown-1",
            Vec::new(),
        )
        .unwrap();
        let mut supervisor = ClaudeSdkHostSupervisor::new(configuration);

        let first = supervisor.ensure_started().unwrap_err();
        assert_ne!(first.reason(), "host_exited");

        // Inside the cooldown the latch answers instantly - and still says
        // why. Only the first caller in each window used to learn the cause;
        // every other one got a bare host_exited, which is how a
        // capability-boundary crash looked causeless for a day (2026-08-31).
        let latched = supervisor.ensure_started().unwrap_err();
        assert_eq!(latched.reason(), "host_exited");
        assert!(
            latched
                .detail()
                .is_some_and(|detail| detail.contains(first.reason())),
            "latched error must replay the failure it absorbed, got {:?}",
            latched.detail()
        );

        // After the cooldown the next caller really respawns - the error is
        // the spawn failure again, never the latch.
        thread::sleep(HOST_RESPAWN_COOLDOWN + Duration::from_millis(20));
        let respawned = supervisor.ensure_started().unwrap_err();
        assert_ne!(respawned.reason(), "host_exited");
        assert_eq!(respawned.reason(), first.reason());
    }

    /// Red-first contract for the host's lexical capability boundary: the
    /// argv must name `--capability-file` and `--endpoint` under one string
    /// dirname even when the address root is a symlink alias of the state
    /// root. The host compares `path.dirname` without resolving symlinks, so
    /// a durable-path capability beside an aliased endpoint dies instantly
    /// with capability_boundary_mismatch — the root cause of the 2026-08-31
    /// all-day Claude spawn outage (introduced by the socket-path bounding).
    #[test]
    fn host_argv_names_capability_and_endpoint_under_one_lexical_parent() {
        let state_root = tempfile::tempdir().unwrap();
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        fs::set_permissions(runtime_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias_parent = tempfile::tempdir().unwrap();
        let address_root = alias_parent.path().join("alias");
        std::os::unix::fs::symlink(state_root.path(), &address_root).unwrap();
        let entrypoint = runtime_root.path().join("argv-entrypoint.sh");
        fs::write(&entrypoint, "printf '%s ' \"$@\" 1>&2\nexit 7\n").unwrap();
        fs::set_permissions(&entrypoint, fs::Permissions::from_mode(0o600)).unwrap();
        let configuration = ClaudeSdkHostSupervisorConfiguration::new_with_address_root(
            Path::new("/bin/sh"),
            &entrypoint,
            state_root.path(),
            &address_root,
            runtime_root.path(),
            "host-lexical-1",
            Vec::new(),
        )
        .unwrap();
        let mut supervisor = ClaudeSdkHostSupervisor::new(configuration);

        let error = supervisor.ensure_started().unwrap_err();
        assert_eq!(error.reason(), "host_exited_before_ready");
        let detail = error.detail().expect("argv detail");
        let tokens: Vec<&str> = detail.split_whitespace().collect();
        let value_after = |flag: &str| {
            let index = tokens.iter().position(|token| *token == flag).unwrap();
            Path::new(tokens[index + 1]).parent().unwrap().to_path_buf()
        };
        assert_eq!(
            value_after("--capability-file"),
            value_after("--endpoint"),
            "host argv must keep the capability file and endpoint in one lexical directory",
        );
    }

    /// Red-first contract for spawn-failure evidence: a host that dies before
    /// ready must leave its stderr in `state_root/host-stderr.log` and on the
    /// returned error's detail. `Stdio::null()` here made two same-day spawn
    /// failures (2026-08-31) undiagnosable — `supervisor_host_exited` carried
    /// no cause.
    #[test]
    fn failed_spawn_surfaces_the_hosts_stderr_tail() {
        let state_root = tempfile::tempdir().unwrap();
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        fs::set_permissions(runtime_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let entrypoint = state_root.path().join("failing-entrypoint.sh");
        fs::write(&entrypoint, "echo 'boom from host' 1>&2\nexit 7\n").unwrap();
        fs::set_permissions(&entrypoint, fs::Permissions::from_mode(0o600)).unwrap();
        let configuration = ClaudeSdkHostSupervisorConfiguration::new(
            Path::new("/bin/sh"),
            &entrypoint,
            state_root.path(),
            runtime_root.path(),
            "host-stderr-1",
            Vec::new(),
        )
        .unwrap();
        let mut supervisor = ClaudeSdkHostSupervisor::new(configuration);

        let error = supervisor.ensure_started().unwrap_err();
        assert_eq!(error.reason(), "host_exited_before_ready");
        assert_eq!(error.detail(), Some("boom from host"));
        let log = fs::read_to_string(state_root.path().join("host-stderr.log")).unwrap();
        assert!(log.contains("boom from host"));
    }

    #[test]
    #[ignore = "requires the channel-pinned Node executable"]
    fn lazy_supervisor_reuses_one_live_host_and_restarts_after_exit() {
        let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").expect("DURE_NODE_BIN"))
            .canonicalize()
            .unwrap();
        let entrypoint = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-shared-sdk-host-fixture.mjs")
            .canonicalize()
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let generation = "host-supervisor-test-1";
        let mut environment = std::env::var("PATH")
            .ok()
            .map(|value| vec![("PATH".into(), value)])
            .unwrap_or_default();
        environment.push((
            "DURE_SUPERVISOR_SECRET_TEST".into(),
            "supervisor-secret-value".into(),
        ));
        let configuration = ClaudeSdkHostSupervisorConfiguration::new(
            node,
            entrypoint,
            root.path(),
            root.path(),
            generation,
            environment,
        )
        .unwrap();
        assert!(!format!("{configuration:?}").contains("supervisor-secret-value"));
        let mut supervisor = SupervisorGuard {
            generation: generation.into(),
            supervisor: ClaudeSdkHostSupervisor::new(configuration),
        };
        assert!(!supervisor.is_started());
        assert_eq!(supervisor.launch_count(), 0);

        let first = supervisor.ensure_started().unwrap();
        let runtime_directory = first.endpoint().parent().unwrap().to_path_buf();
        assert!(supervisor.is_started());
        assert_eq!(supervisor.launch_count(), 1);
        let second = supervisor.ensure_started().unwrap();
        assert_eq!(supervisor.launch_count(), 1);
        assert_eq!(first.process_id(), second.process_id());
        assert_eq!(first.capability(), second.capability());
        assert!(!format!("{first:?}").contains(first.capability()));

        let mut first_client = attach(&first, "client-supervisor-test-1");
        let first_snapshot = read_host_frame(&mut first_client);
        assert_eq!(first_snapshot["result"]["queries"], json!([]));
        drop(first_client);
        thread::sleep(Duration::from_millis(50));
        assert!(!supervisor.observe_exit().unwrap());

        let mut second_client = attach(&first, "client-supervisor-test-2");
        let second_snapshot = read_host_frame(&mut second_client);
        assert_eq!(second_snapshot["result"]["hostGeneration"], generation);
        write_host_frame(
            &mut second_client,
            &json!({
                "action": "begin_drain",
                "hostGeneration": generation,
                "kind": "request",
                "payload": {},
                "requestSequence": 2,
            }),
        );
        let drained = read_host_frame(&mut second_client);
        assert_eq!(drained["result"]["affected"], json!([]));
        assert_eq!(
            supervisor
                .abort_generation("stale-host-generation")
                .unwrap_err()
                .reason(),
            "stale_host_generation"
        );
        write_host_frame(
            &mut second_client,
            &json!({
                "action": "shutdown",
                "hostGeneration": generation,
                "kind": "request",
                "payload": {},
                "requestSequence": 3,
            }),
        );
        let shutdown = read_host_frame(&mut second_client);
        assert_eq!(shutdown["result"]["state"], "drained");
        drop(second_client);

        let deadline = Instant::now() + HOST_READY_TIMEOUT;
        while !supervisor.observe_exit().unwrap() {
            assert!(Instant::now() < deadline, "drained SDK Host did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!runtime_directory.exists());
        let replacement = supervisor.ensure_started().unwrap();
        assert_ne!(replacement.process_id(), first.process_id());
        assert_ne!(replacement.capability(), first.capability());
        assert_eq!(supervisor.launch_count(), 2);
    }

    fn attach(lease: &ClaudeSdkHostLease, client_generation: &str) -> UnixStream {
        let mut stream = UnixStream::connect(lease.endpoint()).unwrap();
        stream.set_read_timeout(Some(HOST_READY_TIMEOUT)).unwrap();
        write_host_frame(
            &mut stream,
            &json!({
                "capability": lease.capability(),
                "clientGeneration": client_generation,
                "cursors": {},
                "hostGeneration": lease.host_generation(),
                "kind": "attach",
                "requestSequence": 1,
            }),
        );
        stream
    }

    fn write_host_frame(stream: &mut UnixStream, value: &Value) {
        let body = serde_json::to_vec(value).unwrap();
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(b"DCH1");
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        stream.write_all(&frame).unwrap();
    }

    fn read_host_frame(stream: &mut UnixStream) -> Value {
        let mut header = [0_u8; 8];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(&header[..4], b"DCH1");
        let length = u32::from_be_bytes(header[4..].try_into().unwrap()) as usize;
        assert!((1..=256 * 1024).contains(&length));
        let mut body = vec![0_u8; length];
        stream.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }
}
