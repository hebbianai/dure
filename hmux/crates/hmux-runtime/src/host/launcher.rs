//! Host process launch, exact readiness reconciliation, and launch packet transport.

use hmux_client::{
    ConnectionOptions, LocalAttachRole, LocalSessionCatalog, ProcessDescriptor,
    SESSION_RETIREMENT_ADMIN_CAPABILITY, SessionClass as ClientSessionClass, SessionDescriptor,
    SessionProbeStatus, SessionSelector, exact_local_process_generation,
    probe_local_session_exact,
};
use hmux_host::local_discovery::{
    DiscoveryManifest, DiscoveryRoot, LocalEndpointKind, PresentationCheckpointHandoff,
    PresentationCheckpointSource, SessionClass, SessionRetirementPolicy, StaleDiscoveryReason,
};
use hmux_host::local_protocol::TerminalDefaultColors;
use hmux_runtime_contract::{
    DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE, HOST_REGISTRATION_CAPACITY_EXIT_CODE,
    ProviderConversationIdentitySeed, ProviderStateEnvironment, StandaloneResurrectionRecipe,
    TerminalEnvironment, write_json_frame,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

type DynError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, DynError>;

pub(crate) const INTERNAL_HOST_SUBCOMMAND: &str = "internal-hmux-host";
pub(crate) const HOST_PACKET_SCHEMA: &str = "hmux-runtime-host-v1";
pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const READY_POLL: Duration = Duration::from_millis(25);
const READY_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(debug_assertions)]
const HOST_SPAWN_BEFORE_START_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_HOST_SPAWN_BEFORE_START_FAULT_MARKER";
#[cfg(debug_assertions)]
const READY_PROBE_AFTER_MATCH_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_READY_PROBE_AFTER_MATCH_FAULT_MARKER";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HostSpawnFailureCertainty {
    DefinitePreReady,
    Uncertain,
}

#[derive(Debug)]
pub(crate) struct HostSpawnFailure {
    certainty: HostSpawnFailureCertainty,
    code: &'static str,
    message: String,
}

impl HostSpawnFailure {
    fn definite(message: impl Into<String>) -> Self {
        Self {
            certainty: HostSpawnFailureCertainty::DefinitePreReady,
            code: "hmux_host_launch_failed",
            message: message.into(),
        }
    }

    fn uncertain(message: impl Into<String>) -> Self {
        Self {
            certainty: HostSpawnFailureCertainty::Uncertain,
            code: "hmux_host_launch_failed",
            message: message.into(),
        }
    }

    fn from_child_exit(status: std::process::ExitStatus, message: impl Into<String>) -> Self {
        let mut failure = Self::definite(message);
        if status.code() == Some(HOST_REGISTRATION_CAPACITY_EXIT_CODE) {
            failure.code = DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE;
        }
        failure
    }

    pub(crate) fn is_uncertain(&self) -> bool {
        self.certainty == HostSpawnFailureCertainty::Uncertain
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for HostSpawnFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HostSpawnFailure {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostLaunchPacket {
    pub(crate) schema: String,
    pub(crate) discovery_root: PathBuf,
    pub(crate) provider_program: PathBuf,
    pub(crate) provider_args: Vec<String>,
    pub(crate) provider_cwd: PathBuf,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) session_class: SessionClass,
    pub(crate) provider_id: String,
    pub(crate) session_name: Option<String>,
    pub(crate) idempotency_key: Option<String>,
    pub(crate) initial_rows: u16,
    pub(crate) initial_columns: u16,
    #[serde(default)]
    pub(crate) terminal_default_colors: TerminalDefaultColors,
    pub(crate) terminal_environment: TerminalEnvironment,
    pub(crate) provider_state_environment: ProviderStateEnvironment,
    pub(crate) launch_owner_proof: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) retirement_policy: Option<SessionRetirementPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resurrection_recipe: Option<StandaloneResurrectionRecipe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) presentation_source: Option<PresentationCheckpointSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) presentation_handoff: Option<PresentationCheckpointHandoff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) conversation_identity: Option<ProviderConversationIdentitySeed>,
}

#[cfg(debug_assertions)]
pub(crate) fn inject_managed_create_fault(point: &str) {
    if std::env::var("HMUX_TEST_MANAGED_CREATE_FAULT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}

#[cfg(not(debug_assertions))]
pub(crate) fn inject_managed_create_fault(_point: &str) {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostSpawnProbe {
    Absent,
    Pending,
    Ready,
}

pub(crate) fn spawn_host(packet: &HostLaunchPacket) -> std::result::Result<(), HostSpawnFailure> {
    fault_inject_host_spawn_before_start_for_test()
        .map_err(|error| HostSpawnFailure::definite(error.to_string()))?;
    spawn_host_after_preflight(packet, |_| Ok(()))
}

pub(crate) fn spawn_host_after_preflight<F>(
    packet: &HostLaunchPacket,
    before_release: F,
) -> std::result::Result<(), HostSpawnFailure>
where
    F: FnOnce(ProcessDescriptor) -> std::result::Result<(), String>,
{
    let executable =
        env::current_exe().map_err(|error| HostSpawnFailure::definite(error.to_string()))?;
    let mut command = Command::new(executable);
    // Broker diagnostics must not become inherited provider/descendant policy.
    command.env_remove("HMUX_BROKER_TIMING_REQUEST");
    for key in hmux_runtime_contract::launching_client_session_env_keys(
        env::vars_os().filter_map(|(key, _)| key.into_string().ok()),
    ) {
        command.env_remove(key);
    }
    command
        .arg(INTERNAL_HOST_SUBCOMMAND)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(host_stderr());
    // SAFETY: setsid has no pointer arguments and is called in the post-fork,
    // pre-exec child, where only async-signal-safe libc is used.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| HostSpawnFailure::definite(error.to_string()))?;
    let child_process = match exact_local_process_generation(child.id()) {
        Ok(process) => process,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(HostSpawnFailure::definite(format!(
                "spawned Hmux Host process generation is unavailable: {error}"
            )));
        }
    };
    inject_managed_create_fault("after_inert_host_spawn_before_reservation");
    if let Err(error) = before_release(child_process) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(HostSpawnFailure::definite(format!(
            "could not durably reserve the Hmux Host process generation: {error}"
        )));
    }
    let write_result: Result<()> = match child.stdin.take() {
        Some(mut stdin) => write_json_frame(&mut stdin, &packet).map_err(Into::into),
        None => Err("Hmux host launch pipe is unavailable".into()),
    };
    if let Err(error) = write_result {
        return stop_host_child_and_classify(
            &mut child,
            packet,
            format!("could not send Hmux Host launch packet: {error}"),
        );
    }
    inject_managed_create_fault("after_host_launch_packet_write");

    let deadline = Instant::now() + READY_TIMEOUT;
    let mut liveness_probe_error = None;
    let mut child_exit_status = None;
    loop {
        if child_exit_status.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    child_exit_status = Some(status);
                }
                Ok(None) => {}
                Err(error) => {
                    liveness_probe_error = Some(error.to_string());
                }
            }
        }
        match probe_host_spawn_target(packet) {
            Ok(HostSpawnProbe::Ready) => return Ok(()),
            Ok(HostSpawnProbe::Absent) => {
                if let Some(status) = child_exit_status.as_ref() {
                    return Err(HostSpawnFailure::from_child_exit(
                        *status,
                        format!("Hmux Host exited before ready: {status}"),
                    ));
                }
            }
            Ok(HostSpawnProbe::Pending) | Err(_) => {}
        }
        if Instant::now() >= deadline {
            return match probe_host_spawn_target(packet) {
                Ok(HostSpawnProbe::Ready) => Ok(()),
                Ok(HostSpawnProbe::Pending) => {
                    Err(HostSpawnFailure::uncertain(match child_exit_status {
                        Some(status) => format!(
                            "Hmux Host exited while its exact target remained pending: {status}"
                        ),
                        None => {
                            "Hmux Host did not become ready, but its exact target remains pending"
                                .to_string()
                        }
                    }))
                }
                Err(error) => Err(HostSpawnFailure::uncertain(format!(
                    "Hmux Host target could not be reconciled before the ready deadline{}: {error}",
                    child_exit_status
                        .as_ref()
                        .map_or_else(String::new, |status| {
                            format!(" after the child exited ({status})")
                        })
                ))),
                Ok(HostSpawnProbe::Absent) => stop_host_child_and_classify(
                    &mut child,
                    packet,
                    match liveness_probe_error {
                        Some(error) => format!(
                            "Hmux Host did not become ready before the deadline after a \
                                 liveness probe error: {error}"
                        ),
                        None => "Hmux Host did not become ready before the deadline".to_string(),
                    },
                ),
            };
        }
        thread::sleep(READY_POLL);
    }
}

fn stop_host_child_and_classify(
    child: &mut std::process::Child,
    packet: &HostLaunchPacket,
    message: impl Into<String>,
) -> std::result::Result<(), HostSpawnFailure> {
    let message = message.into();
    match child.kill() {
        Ok(()) => match child.wait() {
            Ok(_) => classify_stopped_host_spawn(packet, message),
            Err(error) => uncertain_host_spawn_after_stop_failure(packet, message, error),
        },
        Err(kill_error) => match child.try_wait() {
            Ok(Some(_)) => classify_stopped_host_spawn(packet, message),
            Ok(None) => uncertain_host_spawn_after_stop_failure(packet, message, kill_error),
            Err(wait_error) => uncertain_host_spawn_after_stop_failure(
                packet,
                message,
                format!("{kill_error}; child liveness recheck failed: {wait_error}"),
            ),
        },
    }
}

fn uncertain_host_spawn_after_stop_failure(
    packet: &HostLaunchPacket,
    message: impl Into<String>,
    stop_error: impl std::fmt::Display,
) -> std::result::Result<(), HostSpawnFailure> {
    let message = message.into();
    match probe_host_spawn_target(packet) {
        Ok(HostSpawnProbe::Ready) => Ok(()),
        Ok(HostSpawnProbe::Absent | HostSpawnProbe::Pending) => Err(HostSpawnFailure::uncertain(
            format!("{message}; spawned Host could not be proven stopped: {stop_error}"),
        )),
        Err(probe_error) => Err(HostSpawnFailure::uncertain(format!(
            "{message}; spawned Host could not be proven stopped: {stop_error}; \
             exact target reconciliation failed: {probe_error}"
        ))),
    }
}

fn classify_stopped_host_spawn(
    packet: &HostLaunchPacket,
    message: impl Into<String>,
) -> std::result::Result<(), HostSpawnFailure> {
    let message = message.into();
    match probe_host_spawn_target(packet) {
        Ok(HostSpawnProbe::Ready) => Ok(()),
        Ok(HostSpawnProbe::Absent) => Err(HostSpawnFailure::definite(message)),
        Ok(HostSpawnProbe::Pending) => Err(HostSpawnFailure::uncertain(format!(
            "{message}; the exact target remains pending"
        ))),
        Err(error) => Err(HostSpawnFailure::uncertain(format!(
            "{message}; exact target reconciliation failed: {error}"
        ))),
    }
}

fn probe_host_spawn_target(packet: &HostLaunchPacket) -> Result<HostSpawnProbe> {
    if !packet.discovery_root.try_exists()? {
        return Ok(HostSpawnProbe::Absent);
    }
    let root = DiscoveryRoot::open(&packet.discovery_root)?;
    let found = match root.find_manifest_by_session(&packet.workspace_id, &packet.session_id) {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound) => {
            return Ok(HostSpawnProbe::Absent);
        }
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => return Ok(HostSpawnProbe::Absent),
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        }) => return Ok(HostSpawnProbe::Pending),
        Err(error) => return Err(error.into()),
    };
    let common = found.manifest.common();
    if common.session_class != packet.session_class
        || common.provider_id != packet.provider_id
        || common.session_name != packet.session_name
        || common.claim_linkage.kickoff_action_id != packet.idempotency_key
    {
        return Err("Hmux Host target identity conflicts with the launch packet".into());
    }
    let descriptor = SessionDescriptor::from(found.clone());
    let DiscoveryManifest::Ready(ready) = found.manifest else {
        return Ok(HostSpawnProbe::Pending);
    };
    if ready.endpoint.kind != LocalEndpointKind::UnixSocket {
        return Ok(HostSpawnProbe::Pending);
    }
    let catalog = LocalSessionCatalog::new(&packet.discovery_root);
    if !spawn_target_transport_is_ready(&catalog, &descriptor) {
        return Ok(HostSpawnProbe::Pending);
    }
    fault_inject_ready_probe_after_match_for_test()?;
    Ok(HostSpawnProbe::Ready)
}

fn spawn_target_transport_is_ready(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
) -> bool {
    if descriptor.session_class != ClientSessionClass::Standalone {
        return probe_local_session_exact(catalog, descriptor) == SessionProbeStatus::Healthy;
    }

    let selector = SessionSelector::new(
        descriptor.session_id.clone(),
        Some(descriptor.workspace_id.clone()),
    );
    let Ok(session) = catalog.open(&selector) else {
        return false;
    };
    if !descriptor.same_generation(session.descriptor()) {
        return false;
    }
    let deadline = Instant::now() + READY_HANDSHAKE_TIMEOUT;
    let options = ConnectionOptions::new(LocalAttachRole::Observer, None)
        .with_optional_capabilities(&[SESSION_RETIREMENT_ADMIN_CAPABILITY])
        .with_handshake_completion_timeout(READY_HANDSHAKE_TIMEOUT)
        .with_handshake_deadline(deadline);
    #[cfg(feature = "terminal-state-stream")]
    let options = options
        .with_terminal_viewport_projection()
        .with_terminal_viewport_wheel()
        .with_terminal_viewport_multipart();
    let Ok(connection) = session.connect_with_options(options) else {
        return false;
    };
    let ready = connection.supports(SESSION_RETIREMENT_ADMIN_CAPABILITY);
    connection.shutdown();
    ready
}

#[cfg(debug_assertions)]
pub(crate) fn fault_inject_host_spawn_before_start_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os(HOST_SPAWN_BEFORE_START_FAULT_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other("Host spawn fault marker must be absolute"));
    }
    if fs::read(&marker).is_ok_and(|contents| contents == b"fail") {
        fs::write(&marker, b"observed")?;
        return Err(io::Error::other(
            "fault-injected Hmux Host spawn failure before process start",
        ));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
pub(crate) fn fault_inject_host_spawn_before_start_for_test() -> io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn fault_inject_ready_probe_after_match_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os(READY_PROBE_AFTER_MATCH_FAULT_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "Ready probe fault marker must be absolute",
        ));
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
    {
        Ok(mut file) => {
            file.write_all(b"faulted")?;
            file.sync_all()?;
            Err(io::Error::other(
                "fault-injected Ready probe read failure after exact match",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(debug_assertions))]
fn fault_inject_ready_probe_after_match_for_test() -> io::Result<()> {
    Ok(())
}

fn host_stderr() -> Stdio {
    let Some(path) = env::var_os("HMUX_RUNTIME_LOG").filter(|value| !value.is_empty()) else {
        return Stdio::null();
    };
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn registration_capacity_child_exit_preserves_the_typed_broker_code() {
        let status = std::process::ExitStatus::from_raw(HOST_REGISTRATION_CAPACITY_EXIT_CODE << 8);
        let failure = HostSpawnFailure::from_child_exit(status, "capacity refusal");

        assert_eq!(
            failure.code(),
            DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE
        );
        assert!(!failure.is_uncertain());
    }
}
