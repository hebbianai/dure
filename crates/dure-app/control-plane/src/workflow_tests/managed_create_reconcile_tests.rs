use super::*;
use dure_app::{
    ProviderPermissionModeV1, WorkflowSessionLaunchFailureDispositionV1,
    WorkflowSessionLaunchRequestV1,
};
use hmux_client::{
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, ManagedCreateAdvanceBrokerResponse,
    ManagedCreateAdvanceRequest, ManagedCreateGenerationFence, ManagedCreateOutcome,
    ManagedCreateReceipt, PermissionMode as HmuxPermissionMode, ProviderStateEnvironment,
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
    LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
};
use hmux_host::local_protocol::{
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY, ProcessProof, ProtocolVersion,
    RuntimeContext, VersionRange,
};

fn frame(value: &impl serde::Serialize) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&payload);
    frame
}

fn decode_frames<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Vec<T> {
    let mut remaining = bytes;
    let mut decoded = Vec::new();
    while !remaining.is_empty() {
        let length = u32::from_be_bytes(remaining[..4].try_into().unwrap()) as usize;
        decoded.push(serde_json::from_slice(&remaining[4..4 + length]).unwrap());
        remaining = &remaining[4 + length..];
    }
    decoded
}

fn launch_request(root: &std::path::Path) -> WorkflowSessionLaunchRequestV1 {
    WorkflowSessionLaunchRequestV1 {
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        launch_idempotency_key: "workflow-launch-1".into(),
        session_id: "workflow-session-1".into(),
        workspace_id: "workflow-workspace-1".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        provider_conversation_ref: Some("conversation-1".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        provider_executable: "/bin/true".into(),
        provider_arguments: Vec::new(),
        provider_resume: None,
        initial_prompt: None,
        working_directory: root.to_string_lossy().into_owned(),
        prelaunch_command: None,
    }
}

struct RuntimeFixture {
    executable: std::path::PathBuf,
    calls: std::path::PathBuf,
    requests: std::path::PathBuf,
}

fn runtime_fixture(
    root: &std::path::Path,
    response: &ManagedCreateAdvanceBrokerResponse,
) -> RuntimeFixture {
    let response_path = root.join("advance-response.bin");
    fs::write(&response_path, frame(response)).unwrap();
    let executable = root.join("hmux-runtime-fixture");
    let calls = root.join("runtime-calls.txt");
    let requests = root.join("advance-requests.bin");
    crate::fixture_executable::write_fixture_executable(
        &executable,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$2\" >> '{}'\ncase \"$2\" in\n  {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}) cat >> '{}'; cat '{}' ;;\n  *) exit 64 ;;\nesac\n",
            calls.display(),
            requests.display(),
            response_path.display(),
        ),
    );
    RuntimeFixture {
        executable,
        calls,
        requests,
    }
}

fn launcher(
    executable: std::path::PathBuf,
    discovery_root: std::path::PathBuf,
) -> workflow_launch::HmuxWorkflowSessionLauncher {
    workflow_launch::HmuxWorkflowSessionLauncher::new(executable, discovery_root)
}

async fn launch_failure(
    launcher: &workflow_launch::HmuxWorkflowSessionLauncher,
    request: WorkflowSessionLaunchRequestV1,
) -> WorkflowSessionLaunchFailureV1 {
    workflow_launch::CredentialAwareWorkflowSessionLauncher::launch_with_provider_state(
        launcher,
        request,
        ProviderStateEnvironment::default(),
        None,
    )
    .await
    .unwrap_err()
}

fn runtime_calls(path: &std::path::Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn receipt(
    request: &WorkflowSessionLaunchRequestV1,
    session_id: &str,
    idempotency_key: &str,
    discovery_root: &std::path::Path,
    outcome: ManagedCreateOutcome,
) -> ManagedCreateReceipt {
    ManagedCreateReceipt::new(
        idempotency_key,
        session_id,
        &request.workspace_id,
        request.provider_id.as_str(),
        HmuxPermissionMode::Default,
        discovery_root,
        outcome,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "fixture-runner",
            "fixture-runner-instance",
            7,
            "fixture-host",
            "fixture-terminal",
        )
        .unwrap(),
    )
    .unwrap()
}

fn publish_generation(
    discovery_root: &std::path::Path,
    request: &WorkflowSessionLaunchRequestV1,
    session_id: &str,
    idempotency_key: &str,
) -> hmux_host::local_discovery::LifetimeLock {
    let root = DiscoveryRoot::create(discovery_root).unwrap();
    let session = root
        .session(
            DiscoveryKey::new(
                &request.workspace_id,
                session_id,
                "fixture-runner-instance",
                7,
            )
            .unwrap(),
        )
        .unwrap();
    let common = ManifestCommon {
        schema_version: 1,
        host_build_version: "fixture-build".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: vec![MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY.into()],
        lifetime: HostLifetimeIdentity {
            workspace_id: request.workspace_id.clone(),
            session_id: session_id.into(),
            runner_principal: "fixture-runner".into(),
            runner_instance: "fixture-runner-instance".into(),
            channel_epoch: 7,
        },
        host_instance_id: "fixture-host".into(),
        provider_id: request.provider_id.as_str().into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: Some(idempotency_key.into()),
        },
        host_process: ProcessProof {
            process_id: std::process::id(),
            start_marker: "fixture-host-process".into(),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
        launch_program: None,
    };
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    session
        .publish_ready(
            &lock,
            ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: std::process::id(),
                    start_marker: "fixture-provider-process".into(),
                },
                terminal_epoch: "fixture-terminal".into(),
                ready_output_seq: 1,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: discovery_root
                        .join(format!("{session_id}.sock"))
                        .to_string_lossy()
                        .into_owned(),
                },
                capability_token: "fixture-capability-token".into(),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
    lock
}

#[tokio::test]
async fn pending_replay_submits_the_same_ledger_identity_and_digest() {
    let root = tempfile::tempdir().unwrap();
    let discovery_root = root.path().join("discovery");
    let runtime = runtime_fixture(root.path(), &ManagedCreateAdvanceBrokerResponse::Pending);
    let launcher = launcher(runtime.executable, discovery_root);
    let request = launch_request(root.path());

    for _ in 0..2 {
        let failure = launch_failure(&launcher, request.clone()).await;
        assert_eq!(
            failure.disposition,
            WorkflowSessionLaunchFailureDispositionV1::Retryable
        );
        assert_eq!(failure.code, "hmux_managed_create_pending");
    }

    let requests: Vec<ManagedCreateAdvanceRequest> =
        decode_frames(&fs::read(&runtime.requests).unwrap());
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(
        requests[0].request().session_id(),
        request.session_id.as_str()
    );
    assert_eq!(
        requests[0].request().idempotency_key(),
        request.launch_idempotency_key.as_str()
    );
    assert_eq!(
        runtime_calls(&runtime.calls),
        vec![
            MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
            MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
        ]
    );
}

#[tokio::test]
async fn authority_unavailable_is_retryable_without_a_fallback_writer() {
    let root = tempfile::tempdir().unwrap();
    let runtime = runtime_fixture(
        root.path(),
        &ManagedCreateAdvanceBrokerResponse::authority_unavailable(
            "fixture_authority_unavailable",
            "fixture authority is temporarily unavailable",
        ),
    );
    let launcher = launcher(runtime.executable, root.path().join("discovery"));

    let failure = launch_failure(&launcher, launch_request(root.path())).await;

    assert_eq!(
        failure.disposition,
        WorkflowSessionLaunchFailureDispositionV1::Retryable
    );
    assert_eq!(failure.code, "fixture_authority_unavailable");
    assert_eq!(
        runtime_calls(&runtime.calls),
        vec![MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND]
    );
}

#[tokio::test]
async fn current_resolution_projects_the_exact_source_generation() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = root.path().join("discovery");
    let request = launch_request(root.path());
    let _lock = publish_generation(
        &discovery_root,
        &request,
        &request.session_id,
        &request.launch_idempotency_key,
    );
    let response = ManagedCreateAdvanceBrokerResponse::Current(Box::new(receipt(
        &request,
        &request.session_id,
        &request.launch_idempotency_key,
        &discovery_root,
        ManagedCreateOutcome::Reused,
    )));
    let runtime = runtime_fixture(root.path(), &response);
    let launcher = launcher(runtime.executable, discovery_root);

    let generation =
        workflow_launch::CredentialAwareWorkflowSessionLauncher::launch_with_provider_state(
            &launcher,
            request.clone(),
            ProviderStateEnvironment::default(),
            None,
        )
        .await
        .unwrap();

    assert_eq!(generation.session.session_id, "workflow-session-1");
    assert_eq!(
        generation.session.runner_instance,
        "fixture-runner-instance"
    );
    assert_eq!(
        generation.launch_idempotency_key,
        request.launch_idempotency_key
    );
    assert_eq!(
        runtime_calls(&runtime.calls),
        vec![MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND]
    );
}

#[tokio::test]
async fn advanced_resolution_projects_and_replays_the_exact_ledger_successor() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = root.path().join("discovery");
    let request = launch_request(root.path());
    let successor_session = "workflow-session-successor";
    let successor_create = "workflow-launch-successor";
    let _lock = publish_generation(
        &discovery_root,
        &request,
        successor_session,
        successor_create,
    );
    let response = ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(receipt(
        &request,
        successor_session,
        successor_create,
        &discovery_root,
        ManagedCreateOutcome::Created,
    )));
    let runtime = runtime_fixture(root.path(), &response);
    let launcher = launcher(runtime.executable, discovery_root);

    for _ in 0..2 {
        let generation =
            workflow_launch::CredentialAwareWorkflowSessionLauncher::launch_with_provider_state(
                &launcher,
                request.clone(),
                ProviderStateEnvironment::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(generation.session.session_id, successor_session);
        assert_eq!(
            generation.session.runner_instance,
            "fixture-runner-instance"
        );
        assert_eq!(generation.launch_idempotency_key, successor_create);
    }

    let requests: Vec<ManagedCreateAdvanceRequest> =
        decode_frames(&fs::read(&runtime.requests).unwrap());
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(
        runtime_calls(&runtime.calls),
        vec![
            MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
            MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
        ]
    );
}

// TEMPORARY PROBE for #257, removed before merge: reproduce the App core CI
// signature on Linux with the real launcher.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn probe_257_forked_child_holding_the_fixture_writer_fails_the_launch() {
    use std::io::Write as _;

    struct Held(libc::pid_t);
    impl Drop for Held {
        fn drop(&mut self) {
            unsafe {
                libc::kill(self.0, libc::SIGKILL);
                libc::waitpid(self.0, std::ptr::null_mut(), 0);
            }
        }
    }
    fn fork_holder() -> Held {
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe {
                libc::sleep(30);
                libc::_exit(0);
            }
        }
        Held(child)
    }

    let response = ManagedCreateAdvanceBrokerResponse::authority_unavailable(
        "fixture_authority_unavailable",
        "fixture authority is temporarily unavailable",
    );

    let before_root = tempfile::tempdir().unwrap();
    let before_runtime = runtime_fixture(before_root.path(), &response);
    let script = fs::read(&before_runtime.executable).unwrap();
    // Rewrite it in this process, as fs::write did, and fork while it is open.
    let held = {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&before_runtime.executable)
            .unwrap();
        file.write_all(&script).unwrap();
        fork_holder()
    };
    let spawn_error = std::process::Command::new(&before_runtime.executable)
        .status()
        .unwrap_err();
    let before = launch_failure(
        &launcher(
            before_runtime.executable.clone(),
            before_root.path().join("discovery"),
        ),
        launch_request(before_root.path()),
    )
    .await;
    drop(held);

    let after_root = tempfile::tempdir().unwrap();
    let after_runtime = runtime_fixture(after_root.path(), &response);
    let held = fork_holder();
    let after = launch_failure(
        &launcher(
            after_runtime.executable,
            after_root.path().join("discovery"),
        ),
        launch_request(after_root.path()),
    )
    .await;
    drop(held);

    let _ = std::io::stderr().write_all(
        format!(
            "PROBE-257 in-process writer held by a forked child: spawn={spawn_error:?} launch={}\nPROBE-257 writer process, forked child alive: launch={}\n",
            before.code, after.code
        )
        .as_bytes(),
    );
    assert_eq!(spawn_error.raw_os_error(), Some(libc::ETXTBSY));
    assert_eq!(before.code, "hmux_managed_runtime_failed");
    assert_eq!(after.code, "fixture_authority_unavailable");
}
