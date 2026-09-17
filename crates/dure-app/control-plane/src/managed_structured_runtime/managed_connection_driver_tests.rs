use std::fs;
use std::os::unix::fs::PermissionsExt;

use super::managed_connection_driver::*;
use super::managed_create_checkpoint::{
    ManagedCreateCheckpointResolution, persist_effective_managed_create_identity,
    prepare_managed_create_checkpoint, resolve_managed_create_checkpoint,
};
use super::*;
use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRecordV1, AgentTimelineEpochV1,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, ProviderPermissionModeV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use hmux_client::{
    EndpointDescriptor, EndpointKind, MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ManagedCreateReconcileRequest,
    ManagedStopBrokerResponse, ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest,
    ProcessDescriptor, ProtocolVersion, SessionClass, SessionLifecycle, VersionRange,
    recovery_journal::managed_create_ledger::{self, ManagedCreateSuccessorLedgerState},
};
use serde::Serialize;

use crate::managed_create_recovery_test_support::{
    publish_completed_successor, publish_managed_create_successor_edge,
    successor_session_in_source_shard,
};

fn write_frame<T: Serialize>(path: &Path, response: &T) {
    let payload = serde_json::to_vec(response).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(path, frame).unwrap();
}

fn decode_single_frame<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let frame = fs::read(path).unwrap();
    let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(frame.len(), length + 4);
    serde_json::from_slice(&frame[4..]).unwrap()
}

fn write_broker_frame(path: &Path, response: &ManagedStopBrokerResponse) {
    write_frame(path, response);
}

fn binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-codex-test").unwrap(),
        agent_id: AgentIdV1::new("agent-codex-test").unwrap(),
        provider_id: ProviderIdV1::new(CODEX_PROVIDER_ID).unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-codex-test".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-codex-test".into(),
            provider_epoch: "provider-codex-test".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-codex-test").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn descriptor() -> SessionDescriptor {
    SessionDescriptor {
        schema_version: 1,
        session_id: "codex-chat-test".into(),
        session_name: None,
        workspace_id: "workspace-test".into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CODEX_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "principal-test".into(),
        runner_instance: "runner-test".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-test".into(),
        terminal_epoch: "terminal-test".into(),
        output_seq: "0".into(),
        host_build_version: "build-test".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id: 1,
            start_marker: "host-process-test".into(),
        },
        provider_process: ProcessDescriptor {
            process_id: 2,
            start_marker: "provider-process-test".into(),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: "unused.sock".into(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    }
}

#[tokio::test]
async fn response_loss_prepared_checkpoint_authorizes_only_the_exact_advance_replay() {
    let root = tempfile::Builder::new()
        .prefix("dcr-codex-replay-")
        .tempdir_in("/tmp")
        .unwrap();
    let runtime = root.path().join("unused-hmux-runtime");
    fs::write(&runtime, "#!/bin/sh\nprintf x >> \"$0.calls\"\nexit 97\n").unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().join("discovery"),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };
    let files = runtime_files(&configuration, &binding()).unwrap();
    ensure_runtime_directory(&files.directory).unwrap();
    let request_digest = digest("exact-authorized-request");
    prepare_managed_create_checkpoint(
        &files,
        "workspace-test",
        &files.session_id,
        &files.idempotency_key,
        &request_digest,
    )
    .unwrap();

    assert!(matches!(
        reconcile_existing_managed_connection_driver(&configuration, "workspace-test", &files,)
            .await,
        ManagedConnectionDriverExistingOutcome::ReplayPrepared,
    ));
    assert!(
        !runtime.with_extension("calls").exists(),
        "recovery observes the durable replay authority before consulting the retired source",
    );
    assert!(
        prepare_managed_create_checkpoint(
            &files,
            "workspace-test",
            &files.session_id,
            &files.idempotency_key,
            &digest("different-request"),
        )
        .is_err()
    );
}

#[tokio::test]
async fn stop_after_advance_response_loss_claims_and_stops_the_exact_successor_without_create() {
    let root = tempfile::Builder::new()
        .prefix("dcr-codex-stop-")
        .tempdir_in("/tmp")
        .unwrap();
    let discovery_root = root.path().join("discovery");
    let state_root = root.path().join("runtime-state");
    let credential_root = root.path().join("credentials");
    let workspace = root.path().join("workspace");
    for directory in [&discovery_root, &state_root, &credential_root, &workspace] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let runtime = root.path().join("fake-hmux-runtime");
    fs::write(
        &runtime,
        format!(
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.stop-reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) exec cat \"$0.stop\" ;;\n  *) exit 93 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-test").unwrap(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Codex stop recovery".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-test").unwrap(),
            project_id: ProjectIdV1::new("project-test").unwrap(),
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-codex-test").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-test").unwrap(),
            provider_id: ProviderIdV1::new(CODEX_PROVIDER_ID).unwrap(),
            display_name: "Codex stop recovery".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: discovery_root.clone(),
        address_root: state_root.clone(),
        state_root: state_root.clone(),
    };
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let manager = ManagedStructuredRuntimeManager::new(
        configuration.clone(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            credential_root,
            Arc::clone(&store),
        )),
        conversation_service,
        Arc::new(AgentConversationRuntimeRegistry::default()),
        Arc::clone(&store),
    );
    let binding = binding();
    let files = runtime_files(&configuration, &binding).unwrap();
    ensure_runtime_directory(&files.directory).unwrap();
    prepare_managed_create_checkpoint(
        &files,
        "workspace-test",
        &files.session_id,
        &files.idempotency_key,
        &digest("request-committed-before-response-loss"),
    )
    .unwrap();
    let target_session_id = successor_session_in_source_shard(
        "workspace-test",
        &files.session_id,
        &files.idempotency_key,
        "codex-chat-successor",
    );
    let target_idempotency_key = "codex-create-successor";
    let (_target_lock, target_receipt) = publish_completed_successor(
        &discovery_root,
        "workspace-test",
        &target_session_id,
        target_idempotency_key,
        CODEX_PROVIDER_ID,
    );
    publish_managed_create_successor_edge(
        &discovery_root,
        &files.session_id,
        &files.idempotency_key,
        &target_receipt,
    );
    write_broker_frame(
        &runtime.with_extension("stop-reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    let stop_request = ManagedStopRequest::new(
        format!(
            "codex-app-server-stop-{}",
            &digest(&target_session_id)[..24]
        ),
        &target_session_id,
        "workspace-test",
    )
    .and_then(|request| {
        request.with_expected_fence(
            "successor-runner",
            "successor-runner-instance",
            7,
            "successor-host",
            "successor-terminal",
        )
    })
    .unwrap();
    let stop_receipt = ManagedStopReceipt::from_request(
        &stop_request,
        ManagedStopOutcome::Stopped,
        "codex-successor-stopped",
    )
    .unwrap();
    write_broker_frame(
        &runtime.with_extension("stop"),
        &ManagedStopBrokerResponse::Completed(Box::new(stop_receipt.clone())),
    );

    assert!(manager.stop_binding(&binding, false).await.unwrap());

    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!("{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}\n{MANAGED_STOP_BROKER_SUBCOMMAND}\n"),
        "stop recovery must never invoke managed create or advance",
    );
    assert!(!files.directory.exists());
    managed_create_ledger::checkpoint_retirement_exact(&discovery_root, &stop_receipt).unwrap();
    managed_create_ledger::finalize_retirement_exact(&discovery_root, &stop_receipt).unwrap();
    let target_identity = ManagedCreateReconcileRequest::new(
        target_idempotency_key,
        &target_session_id,
        "workspace-test",
    )
    .unwrap();
    assert_eq!(
        managed_create_ledger::reserve_terminal_successor(
            &discovery_root,
            &target_identity,
            || panic!("cleanup must close the successor before a late advance can allocate"),
        )
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed,
    );
}

#[tokio::test]
async fn effective_restart_reconciles_the_exact_target_without_create_or_advance() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    fs::write(
        &runtime,
        "#!/bin/sh\ncat >> \"$0.requests\"\nprintf '%s\\n' \"$2\" > \"$0.calls\"\nexec cat \"$0.reconcile\"\n",
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let payload =
        serde_json::to_vec(&hmux_client::ManagedCreateReconcileBrokerResponse::NotFound).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(runtime.with_extension("reconcile"), frame).unwrap();
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().join("discovery"),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };
    let files = RuntimeFiles {
        directory: root.path().join("runtime-files"),
        endpoint: root.path().join("runtime-files/app.sock"),
        upstream: root.path().join("runtime-files/provider.sock"),
        managed_create_identity: root
            .path()
            .join("runtime-files/managed-create-identity.json"),
        session_id: "codex-chat-test".into(),
        idempotency_key: "codex-app-server-create-test".into(),
    };
    ensure_runtime_directory(&files.directory).unwrap();
    let digest = digest("first-approved-request");
    prepare_managed_create_checkpoint(
        &files,
        "workspace-test",
        &files.session_id,
        &files.idempotency_key,
        &digest,
    )
    .unwrap();
    persist_effective_managed_create_identity(
        &files,
        "workspace-test",
        &digest,
        "codex-chat-successor",
        "codex-app-server-create-successor",
    )
    .unwrap();

    assert!(matches!(
        reconcile_existing_managed_connection_driver(&configuration, "workspace-test", &files)
            .await,
        ManagedConnectionDriverExistingOutcome::NotFound
    ));
    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!(
            "{}\n",
            hmux_client::MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND
        )
    );
    let request: ManagedCreateReconcileRequest =
        decode_single_frame(&runtime.with_extension("requests"));
    assert_eq!(request.session_id(), "codex-chat-successor");
    assert_eq!(
        request.idempotency_key(),
        "codex-app-server-create-successor"
    );
}

#[tokio::test]
async fn legacy_terminal_recovery_is_attach_only_and_never_advances() {
    let root = tempfile::Builder::new()
        .prefix("dcr-codex-legacy-")
        .tempdir_in("/tmp")
        .unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    fs::write(
        &runtime,
        "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" > \"$0.calls\"\nexec cat \"$0.reconcile\"\n",
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    write_frame(
        &runtime.with_extension("reconcile"),
        &hmux_client::ManagedCreateReconcileBrokerResponse::Retired,
    );
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().join("discovery"),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };
    let files = runtime_files(&configuration, &binding()).unwrap();

    assert!(matches!(
        reconcile_existing_managed_connection_driver(&configuration, "workspace-test", &files)
            .await,
        ManagedConnectionDriverExistingOutcome::Terminal,
    ));
    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!(
            "{}\n",
            hmux_client::MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND
        ),
    );
}

#[path = "managed_create_credential_tests.rs"]
mod credential_tests;

#[tokio::test]
async fn hmux_stop_refusal_remains_retryable_until_cleanup_completes() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    let script = format!(
        "#!/bin/sh\ncat >/dev/null\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) exec cat \"$0.stop\" ;;\n  *) exit 64 ;;\nesac\n"
    );
    fs::write(&runtime, script).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    write_broker_frame(
        &runtime.with_extension("reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    write_broker_frame(
        &runtime.with_extension("stop"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_fence_mismatch",
            "source generation retained",
        ),
    );
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime,
        discovery_root: root.path().to_path_buf(),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };

    let error = stop_exact(&configuration, &descriptor()).await.unwrap_err();

    assert_eq!(error.kind, ErrorKind::StopFailed);
    assert_eq!(error.code, "managed_provider_stop_failed");
    assert!(!error.retains_source());
}

#[tokio::test]
async fn hmux_stop_refusal_retains_the_selected_source_without_replay() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("fake-hmux-runtime");
    let script = format!(
        "#!/bin/sh\ncat >/dev/null\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) printf x >> \"$0.stop-calls\"; exec cat \"$0.stop\" ;;\n  *) exit 64 ;;\nesac\n"
    );
    fs::write(&runtime, script).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    write_broker_frame(
        &runtime.with_extension("reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    write_broker_frame(
        &runtime.with_extension("stop"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_fence_mismatch",
            "selected source retained",
        ),
    );
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().to_path_buf(),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };

    let error = stop_selected_source_exact(&configuration, &descriptor())
        .await
        .unwrap_err();

    assert_eq!(error.kind, ErrorKind::RuntimeConflict);
    assert!(error.retains_source());
    assert_eq!(
        fs::read(runtime.with_extension("stop-calls")).unwrap(),
        b"x",
        "a definitive refusal cannot authorize an automatic replay"
    );
}

#[tokio::test]
async fn invalid_stop_authority_is_pre_effect_and_contextually_projected() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("unused-hmux-runtime");
    fs::write(&runtime, "#!/bin/sh\nprintf x >> \"$0.calls\"\nexit 97\n").unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let configuration = ManagedStructuredRuntimeConfiguration {
        backend_generation: "backend-test".into(),
        provider: ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher_executable: runtime.clone(),
        hmux_runtime: runtime.clone(),
        discovery_root: root.path().to_path_buf(),
        address_root: root.path().to_path_buf(),
        state_root: root.path().to_path_buf(),
    };
    let mut malformed = descriptor();
    malformed.channel_epoch = "not-a-channel-epoch".into();

    let cleanup = stop_exact(&configuration, &malformed).await.unwrap_err();
    let selected = stop_selected_source_exact(&configuration, &malformed)
        .await
        .unwrap_err();

    assert_eq!(cleanup.kind, ErrorKind::StopFailed);
    assert_eq!(selected.kind, ErrorKind::RuntimeConflict);
    assert!(!runtime.with_extension("calls").exists());
}
