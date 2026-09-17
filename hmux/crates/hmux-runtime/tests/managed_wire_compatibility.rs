#![cfg(unix)]

use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest, PermissionMode,
    ProcessDescriptor, SessionSelector, probe_local_process_generation,
};
use hmux_host::local_discovery::{DiscoveryManifest, DiscoveryRoot, ReadyManifest};
use hmux_host::local_protocol::{
    AttachMode, AuthorizationPosture, Detach, ErrorCode, FrameBody, FrameCodec, FrameLimits, Hello,
    LifecycleState, MANAGED_AUTHORIZATION_GRANT_CAPABILITY, PROTOCOL_V1, SessionFence,
    VersionRange, WireFrame,
};
use hmux_runtime_contract::ProviderStateEnvironment;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

const LEGACY_MANAGED_CONTROLLER_HELLO_V1: &str =
    include_str!("fixtures/legacy_managed_controller_hello_v1.json");
const FIXTURE_PROVIDER_STATE_ENV: &str = "WIRE_COMPAT_STATE_DIR";
const LEGACY_CONTROLLER_CAPABILITIES: [&str; 4] = [
    "live_output",
    "screen_snapshot",
    "terminal_input",
    "terminal_resize",
];

#[test]
fn new_host_preserves_legacy_proof_attach_but_fences_current_raw_token_use() {
    let mut fixture = ManagedHostFixture::start();
    let ready = fixture.ready_manifest();
    let fence = session_fence(&ready);

    assert!(
        ready
            .common
            .capabilities
            .iter()
            .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
    );

    let mut current = connect(&ready);
    FrameCodec::new(FrameLimits::default())
        .write_to(
            &mut current,
            &WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::Hello(Hello {
                    supported_versions: VersionRange {
                        minimum: PROTOCOL_V1,
                        maximum: PROTOCOL_V1,
                    },
                    requested_capabilities: vec![
                        "live_output".into(),
                        MANAGED_AUTHORIZATION_GRANT_CAPABILITY.into(),
                        "screen_snapshot".into(),
                        "terminal_input".into(),
                        "terminal_resize".into(),
                    ],
                    expected_fence: fence.clone(),
                    requested_mode: AttachMode::Controller,
                    reconnect_cursor: None,
                    capability_token: ready.capability_token.clone(),
                    authorization_proof_reference: Some(ready.capability_token.clone()),
                    initial_snapshot_profile: None,
                }),
            },
        )
        .unwrap();
    let denied_frame = read_frame(&mut current);
    assert_eq!(denied_frame.protocol_version, PROTOCOL_V1);
    let FrameBody::Error(denied) = denied_frame.body else {
        panic!("a grant-capable client must not attach with the discovery token");
    };
    assert_eq!(denied.code, ErrorCode::AuthorizationDenied);
    drop(current);

    let mut legacy = connect(&ready);
    write_legacy_hello(&mut legacy, &fence, &ready.capability_token);
    let ack_frame = read_frame(&mut legacy);
    assert_eq!(ack_frame.protocol_version, PROTOCOL_V1);
    let FrameBody::HelloAck(ack) = ack_frame.body else {
        panic!("the legacy V1 controller did not receive HelloAck");
    };
    assert_eq!(ack.selected_version, PROTOCOL_V1);
    assert_eq!(ack.actual_fence, fence);
    assert_eq!(ack.lifecycle, LifecycleState::Controlling);
    assert_eq!(
        ack.authorization_posture,
        AuthorizationPosture::DaemonAuthorized
    );
    assert_eq!(
        ack.selected_capabilities
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        LEGACY_CONTROLLER_CAPABILITIES
    );
    let snapshot_frame = read_frame(&mut legacy);
    assert_eq!(snapshot_frame.protocol_version, ack.selected_version);
    let FrameBody::ScreenSnapshot(snapshot) = snapshot_frame.body else {
        panic!("the legacy V1 controller did not receive its full initial snapshot");
    };
    assert_eq!(snapshot.fence, fence);
    assert!(snapshot.sequence_through >= ack.current_output_seq);
    assert_eq!(snapshot.actual_profile, None);

    FrameCodec::new(FrameLimits::default())
        .write_to(
            &mut legacy,
            &WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::Detach(Detach {
                    reason: Some("wire_compatibility_complete".into()),
                }),
            },
        )
        .unwrap();
    drop(legacy);

    assert_eq!(fixture.stop(), ManagedStopOutcome::Stopped);
}

#[test]
#[ignore = "launched as the deterministic provider child by the compatibility test"]
fn managed_wire_fixture_provider() {
    if std::env::var_os(FIXTURE_PROVIDER_STATE_ENV).is_none() {
        return;
    }
    loop {
        std::thread::park();
    }
}

struct ManagedHostFixture {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    cwd: PathBuf,
    session_id: String,
    workspace_id: String,
    host_process: ProcessDescriptor,
    provider_process: ProcessDescriptor,
    endpoint: PathBuf,
    stop_requested: bool,
    cleanup_complete: bool,
}

impl ManagedHostFixture {
    fn start() -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let provider = std::env::current_exe().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let session_id = format!("wire-compat-{}", &suffix[..12]);
        let workspace_id = format!("wire-compat-workspace-{suffix}");
        let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    "wire-compat-create",
                    &session_id,
                    &workspace_id,
                    "fixture-provider",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        provider.to_string_lossy().into_owned(),
                        "--ignored".into(),
                        "--exact".into(),
                        "managed_wire_fixture_provider".into(),
                        "--nocapture".into(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_provider_state_environment(
                    ProviderStateEnvironment::new(BTreeMap::from([(
                        FIXTURE_PROVIDER_STATE_ENV.to_string(),
                        state.path().to_string_lossy().into_owned(),
                    )]))
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let host_process = created.session().descriptor().host_process.clone();
        let provider_process = created.session().descriptor().provider_process.clone();
        let endpoint = PathBuf::from(&created.session().descriptor().endpoint.address);
        Self {
            _state: state,
            discovery_root,
            cwd,
            session_id,
            workspace_id,
            host_process,
            provider_process,
            endpoint,
            stop_requested: false,
            cleanup_complete: false,
        }
    }

    fn ready_manifest(&self) -> ReadyManifest {
        let root = DiscoveryRoot::open(&self.discovery_root).unwrap();
        let found = root
            .find_manifest_by_session(&self.workspace_id, &self.session_id)
            .unwrap();
        let DiscoveryManifest::Ready(ready) = found.manifest else {
            panic!("wire compatibility session is not ready");
        };
        ready
    }

    fn stop(&mut self) -> ManagedStopOutcome {
        let outcome = stop_managed_session(
            &self.discovery_root,
            &self.cwd,
            &self.session_id,
            &self.workspace_id,
        )
        .unwrap();
        self.stop_requested = true;
        assert!(
            wait_for_host_shutdown(&self.host_process, &self.endpoint, Duration::from_secs(7)),
            "temporary Host generation or endpoint remained after managed stop"
        );
        self.cleanup_complete = true;
        outcome
    }
}

impl Drop for ManagedHostFixture {
    fn drop(&mut self) {
        if self.cleanup_complete {
            return;
        }
        if !self.stop_requested {
            let _ = stop_managed_session(
                &self.discovery_root,
                &self.cwd,
                &self.session_id,
                &self.workspace_id,
            );
        }
        if !wait_for_host_shutdown(&self.host_process, &self.endpoint, Duration::from_secs(7)) {
            terminate_exact_test_generation(&self.provider_process);
            terminate_exact_test_generation(&self.host_process);
            let host_absent = wait_for_process_shutdown(&self.host_process, Duration::from_secs(3));
            let _ = wait_for_process_shutdown(&self.provider_process, Duration::from_secs(3));
            if host_absent {
                let _ = fs::remove_file(&self.endpoint);
            }
        }
    }
}

fn stop_managed_session(
    discovery_root: &Path,
    cwd: &Path,
    session_id: &str,
    workspace_id: &str,
) -> Result<ManagedStopOutcome, hmux_client::ClientError> {
    let descriptor = LocalSessionCatalog::new(discovery_root).find(&SessionSelector::new(
        session_id,
        Some(workspace_id.to_string()),
    ))?;
    let channel_epoch = descriptor.channel_epoch.parse::<u64>().unwrap();
    let request = ManagedStopRequest::new("wire-compat-stop", session_id, workspace_id)
        .unwrap()
        .with_expected_fence(
            descriptor.runner_principal,
            descriptor.runner_instance,
            channel_epoch,
            descriptor.host_instance_id,
            descriptor.terminal_epoch,
        )
        .unwrap();
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), cwd)
        .with_discovery_root(discovery_root)
        .stop(request)
        .map(|receipt| receipt.outcome())
}

fn wait_for_host_shutdown(
    host_process: &ProcessDescriptor,
    endpoint: &Path,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let host_absent = matches!(
            probe_local_process_generation(host_process),
            Ok(LocalProcessGenerationStatus::Absent)
        );
        let endpoint_absent = endpoint.try_exists().is_ok_and(|exists| !exists);
        if host_absent && endpoint_absent {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_shutdown(process: &ProcessDescriptor, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(
            probe_local_process_generation(process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn terminate_exact_test_generation(process: &ProcessDescriptor) {
    if !matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ) {
        return;
    }
    let Ok(process_id) = i32::try_from(process.process_id) else {
        return;
    };
    // SAFETY: getpgid only inspects the exact temporary process generation.
    let process_group = unsafe { libc::getpgid(process_id) };
    // SAFETY: getpgrp only inspects the current test runner.
    let caller_group = unsafe { libc::getpgrp() };
    if process_group != process_id || process_group == caller_group {
        return;
    }
    if !matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ) {
        return;
    }
    // SAFETY: both the process generation and its test-owned group leadership
    // were revalidated immediately before this signal.
    unsafe {
        libc::kill(-process_group, libc::SIGKILL);
    }
}

fn session_fence(ready: &ReadyManifest) -> SessionFence {
    SessionFence {
        workspace_id: ready.common.lifetime.workspace_id.clone(),
        session_id: ready.common.lifetime.session_id.clone(),
        runner_principal: ready.common.lifetime.runner_principal.clone(),
        runner_instance: ready.common.lifetime.runner_instance.clone(),
        channel_epoch: ready.common.lifetime.channel_epoch,
        host_instance_id: ready.common.host_instance_id.clone(),
        terminal_epoch: ready.terminal_epoch.clone(),
    }
}

fn connect(ready: &ReadyManifest) -> UnixStream {
    let stream = UnixStream::connect(&ready.endpoint.address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
}

fn write_legacy_hello(stream: &mut UnixStream, fence: &SessionFence, token: &str) {
    let mut frame = serde_json::from_str::<Value>(LEGACY_MANAGED_CONTROLLER_HELLO_V1).unwrap();
    let payload = frame
        .pointer_mut("/body/payload")
        .and_then(Value::as_object_mut)
        .expect("legacy Hello fixture must retain its payload object");
    payload.insert(
        "expected_fence".into(),
        serde_json::to_value(fence).unwrap(),
    );
    payload.insert("capability_token".into(), Value::String(token.into()));
    payload.insert(
        "authorization_proof_reference".into(),
        Value::String(token.into()),
    );
    let payload = serde_json::to_vec(&frame).unwrap();
    let length = u32::try_from(payload.len()).unwrap();
    stream.write_all(&length.to_be_bytes()).unwrap();
    stream.write_all(&payload).unwrap();
}

fn read_frame(stream: &mut UnixStream) -> WireFrame {
    FrameCodec::new(FrameLimits::default())
        .read_from(stream)
        .unwrap()
}
