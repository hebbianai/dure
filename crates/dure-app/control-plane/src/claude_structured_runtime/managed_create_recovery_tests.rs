use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dure_app::{AgentIdV1, AgentTimelineEpochV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    EndpointDescriptor, EndpointKind, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_STOP_BROKER_SUBCOMMAND,
    MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedStopBrokerResponse, ManagedStopOutcome,
    ManagedStopReceipt, ManagedStopRequest, ProcessDescriptor, ProtocolVersion, SessionClass,
    SessionDescriptor, SessionLifecycle, VersionRange,
    recovery_journal::managed_create_ledger::{
        self, ManagedCreateLedgerState, ManagedCreateSuccessorLedgerState,
    },
};
use hmux_host::local_discovery::DiscoveryRoot;
use serde::Serialize;

use super::*;
use crate::agent_conversation_api::AgentConversationRuntimeRegistry;
use crate::claude_sdk_host_client::{
    ClaudeDch1HostIdentity, ClaudeDch1ProviderRetirementAuthority,
    ClaudeDch1ProviderRetirementPhase,
};
use crate::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use crate::managed_create_recovery_test_support::{
    publish_completed_successor, publish_managed_create_successor_edge,
    successor_session_in_source_shard,
};

fn owner_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn write_frame<T: Serialize>(path: &Path, response: &T) {
    let payload = serde_json::to_vec(response).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(path, frame).unwrap();
}

fn fake_runtime(root: &Path) -> PathBuf {
    let runtime = root.join("fake-hmux-runtime");
    fs::write(
        &runtime,
        format!(
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\ncase \"$2\" in\n  {MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.create-reconcile\" ;;\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.stop-reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) exec cat \"$0.stop\" ;;\n  {MANAGED_CREATE_BROKER_SUBCOMMAND}) exit 93 ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    runtime
}

async fn manager(root: &Path, runtime: &Path) -> ClaudeStructuredRuntimeManager<SqliteDomainStore> {
    let discovery_root = root.join("discovery");
    let host_state_root = root.join("host-state");
    let host_runtime_root = root.join("host-runtime");
    let runtime_state_root = root.join("runtime-state");
    let credential_root = root.join("credentials");
    for directory in [
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
        &runtime_state_root,
        &credential_root,
    ] {
        owner_directory(directory);
    }
    let store = Arc::new(
        SqliteDomainStore::open(root.join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let executable = std::env::current_exe().unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &executable,
                &executable,
                host_state_root,
                host_runtime_root,
                "host-managed-create-recovery-test",
                Vec::new(),
            )
            .unwrap(),
            "client-managed-create-recovery-test",
            Arc::clone(&service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    ClaudeStructuredRuntimeManager::new(
        ClaudeStructuredRuntimeConfiguration {
            backend_generation: "backend-managed-create-recovery-test".into(),
            hmux_runtime: runtime.to_path_buf(),
            discovery_root,
            relay_executable: executable,
            address_root: runtime_state_root.clone(),
            state_root: runtime_state_root,
            environment: BTreeMap::new(),
        },
        Arc::new(ProviderCredentialProfileRegistry::new(
            credential_root,
            Arc::clone(&store),
        )),
        service,
        host,
        store,
    )
}

fn descriptor(files: &ClaudeRuntimeFiles, workspace_id: &str) -> SessionDescriptor {
    let process_id = std::process::id();
    SessionDescriptor {
        schema_version: 1,
        session_id: files.relay_session_id.clone(),
        session_name: None,
        workspace_id: workspace_id.into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CLAUDE_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "principal-managed-create-recovery".into(),
        runner_instance: "runner-managed-create-recovery".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-managed-create-recovery".into(),
        terminal_epoch: "terminal-managed-create-recovery".into(),
        output_seq: "0".into(),
        host_build_version: "build-managed-create-recovery".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id,
            start_marker: "host-process-managed-create-recovery".into(),
        },
        provider_process: ProcessDescriptor {
            process_id,
            start_marker: "provider-process-managed-create-recovery".into(),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: files.endpoint.to_string_lossy().into_owned(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    }
}

fn binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-stop-recovery")
            .unwrap(),
        agent_id: AgentIdV1::new("agent-stop-recovery").unwrap(),
        provider_id: ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-stop-recovery".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-stop-recovery".into(),
            provider_epoch: "query-stop-recovery".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-stop-recovery").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

#[tokio::test]
async fn pending_prepared_stop_preserves_the_exact_journal_and_never_creates() {
    let root = tempfile::Builder::new()
        .prefix("dcr-stop-")
        .tempdir_in("/tmp")
        .unwrap();
    let runtime = fake_runtime(root.path());
    let manager = manager(root.path(), &runtime).await;
    let workspace = root.path().canonicalize().unwrap();
    let binding = binding();
    let mut prepared = manager
        .create_runtime(&binding, "workspace-create-test", &workspace, None)
        .unwrap();
    assert!(matches!(
        managed_create_ledger::reserve(
            &manager.configuration.discovery_root,
            "workspace-create-test",
            &prepared.files.relay_session_id,
            &prepared.files.create_idempotency_key,
            &"c".repeat(64),
        )
        .unwrap(),
        ManagedCreateLedgerState::Prepared(_),
    ));
    let before = fs::read(prepared.files.runtime_directory.join("launch.json")).unwrap();

    assert_eq!(
        manager
            .begin_prepared_stop_cleanup("workspace-create-test", &mut prepared)
            .await
            .unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::StopFailed,
    );
    assert_eq!(
        prepared.journal.state(),
        ClaudeRuntimeLaunchStateV1::Prepared
    );
    assert_eq!(
        fs::read(prepared.files.runtime_directory.join("launch.json")).unwrap(),
        before,
    );
    assert!(
        !runtime.with_extension("calls").exists(),
        "pending read-only stop resolution must not spawn the Hmux runtime",
    );
}

#[tokio::test]
async fn prepared_stop_after_advance_response_loss_stops_the_exact_existing_successor() {
    let root = tempfile::Builder::new()
        .prefix("dcr-advance-stop-")
        .tempdir_in("/tmp")
        .unwrap();
    let runtime = fake_runtime(root.path());
    write_frame(
        &runtime.with_extension("create-reconcile"),
        &ManagedCreateReconcileBrokerResponse::Retired,
    );
    let manager = manager(root.path(), &runtime).await;
    let workspace = root.path().canonicalize().unwrap();
    let workspace_id = "workspace-create-test";
    let binding = binding();
    let mut prepared = manager
        .create_runtime(&binding, workspace_id, &workspace, None)
        .unwrap();
    let target_session_id = successor_session_in_source_shard(
        workspace_id,
        &prepared.files.relay_session_id,
        &prepared.files.create_idempotency_key,
        "claude-chat-successor",
    );
    let target_idempotency_key = "claude-create-successor";
    let (_target_lock, target_receipt) = publish_completed_successor(
        &manager.configuration.discovery_root,
        workspace_id,
        &target_session_id,
        target_idempotency_key,
        CLAUDE_PROVIDER_ID,
    );
    publish_managed_create_successor_edge(
        &manager.configuration.discovery_root,
        &prepared.files.relay_session_id,
        &prepared.files.create_idempotency_key,
        &target_receipt,
    );
    let resolved = ManagedSessionCreator::new(&manager.configuration.hmux_runtime)
        .with_discovery_root(&manager.configuration.discovery_root)
        .resolve_successor_chain(
            ManagedCreateReconcileRequest::new(
                &prepared.files.create_idempotency_key,
                &prepared.files.relay_session_id,
                workspace_id,
            )
            .unwrap(),
        )
        .unwrap();
    let ManagedCreateChainResolution::Existing(resolved) = resolved else {
        panic!("durable successor must resolve as a completed generation")
    };
    assert_eq!(resolved.receipt(), &target_receipt);
    let target_descriptor = SessionDescriptor::from(
        DiscoveryRoot::open(&manager.configuration.discovery_root)
            .unwrap()
            .find_manifest_by_session(workspace_id, &target_session_id)
            .unwrap(),
    );
    let stop_request = ManagedStopRequest::new(
        format!(
            "claude-chat-stop-{}",
            exact_stop_identity(&target_descriptor)
        ),
        &target_session_id,
        workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &target_descriptor.runner_principal,
            &target_descriptor.runner_instance,
            target_descriptor.channel_epoch.parse().unwrap(),
            &target_descriptor.host_instance_id,
            &target_descriptor.terminal_epoch,
        )
    })
    .unwrap();
    write_frame(
        &runtime.with_extension("stop-reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    let target_stop_receipt = ManagedStopReceipt::from_request(
        &stop_request,
        ManagedStopOutcome::Stopped,
        "test-successor-stopped",
    )
    .unwrap();
    write_frame(
        &runtime.with_extension("stop"),
        &ManagedStopBrokerResponse::Completed(Box::new(target_stop_receipt.clone())),
    );

    manager
        .begin_prepared_stop_cleanup(workspace_id, &mut prepared)
        .await
        .unwrap();
    manager
        .complete_stop_cleanup(
            &workspace,
            &prepared.files.runtime_directory,
            &mut prepared.journal,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "successor stop failed: {error:?}; runtime calls: {:?}",
                fs::read_to_string(runtime.with_extension("calls"))
            )
        });

    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!("{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}\n{MANAGED_STOP_BROKER_SUBCOMMAND}\n"),
        "stop recovery must resolve the durable successor without invoking create or advance",
    );
    let recovered = read_journal(&prepared.files.runtime_directory).unwrap();
    assert_eq!(recovered.state(), ClaudeRuntimeLaunchStateV1::Stopped);
    assert_eq!(
        recovered
            .descriptor()
            .map(|descriptor| descriptor.session_id.as_str()),
        Some(target_session_id.as_str()),
    );
    let reopened = manager
        .read_runtime(&binding, workspace_id, &workspace)
        .expect("the stopped successor journal must remain readable after restart")
        .expect("the stopped successor runtime must remain durably projected");
    assert_eq!(
        reopened.journal.state(),
        ClaudeRuntimeLaunchStateV1::Stopped,
    );
    assert_eq!(
        reopened
            .journal
            .descriptor()
            .map(|descriptor| descriptor.session_id.as_str()),
        Some(target_session_id.as_str()),
    );
    assert_eq!(
        reopened.journal.effective_managed_create_identity(
            &reopened.files.relay_session_id,
            &reopened.files.create_idempotency_key,
        ),
        (target_session_id.as_str(), target_idempotency_key),
    );
    let target_identity = ManagedCreateReconcileRequest::new(
        target_idempotency_key,
        &target_session_id,
        workspace_id,
    )
    .unwrap();
    managed_create_ledger::checkpoint_retirement_exact(
        &manager.configuration.discovery_root,
        &target_stop_receipt,
    )
    .unwrap();
    managed_create_ledger::finalize_retirement_exact(
        &manager.configuration.discovery_root,
        &target_stop_receipt,
    )
    .unwrap();
    assert_eq!(
        managed_create_ledger::reserve_terminal_successor(
            &manager.configuration.discovery_root,
            &target_identity,
            || panic!("cleanup must close the target before a late advance can allocate"),
        )
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed,
        "the stop decision and late advance reservation must share one durable fence",
    );
}

#[tokio::test]
async fn retired_direct_stop_crash_resumes_exact_cleanup_without_create_or_retarget() {
    let root = tempfile::Builder::new()
        .prefix("dcr-retire-")
        .tempdir_in("/tmp")
        .unwrap();
    let runtime = fake_runtime(root.path());
    write_frame(
        &runtime.with_extension("stop-reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    write_frame(
        &runtime.with_extension("stop"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_fence_mismatch",
            "retain the exact generation",
        ),
    );
    let manager = manager(root.path(), &runtime).await;
    let workspace = root.path().canonicalize().unwrap();
    let binding = binding();
    let mut prepared = manager
        .create_runtime(&binding, "workspace-create-test", &workspace, None)
        .unwrap();
    let descriptor = descriptor(&prepared.files, "workspace-create-test");
    prepared.journal.relay_ready(descriptor.clone());
    prepared
        .journal
        .query_retired(ClaudeDch1ProviderRetirementAuthority {
            source: prepared.journal.query_identity(),
            allowed_target: None,
            source_host: ClaudeDch1HostIdentity {
                host_generation: "host-generation-direct-stop".into(),
                host_instance_id: "host-instance-direct-stop".into(),
            },
            target_host: None,
            phase: ClaudeDch1ProviderRetirementPhase::Retired,
        });
    write_journal(&prepared.files.runtime_directory, &prepared.journal).unwrap();

    let error = match manager
        .prepare_launch(binding, "workspace-create-test", &workspace)
        .await
    {
        Ok(_) => panic!("an interrupted direct stop cannot become launchable"),
        Err(error) => error,
    };
    assert_eq!(error, ClaudeStructuredRuntimeErrorV1::StopFailed);
    let recovered = read_journal(&prepared.files.runtime_directory).unwrap();
    assert_eq!(
        recovered.state(),
        ClaudeRuntimeLaunchStateV1::StopCleanupPending,
    );
    assert_eq!(recovered.descriptor(), Some(&descriptor));
    assert_eq!(
        fs::read_to_string(runtime.with_extension("calls")).unwrap(),
        format!("{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}\n{MANAGED_STOP_BROKER_SUBCOMMAND}\n"),
        "recovery must only stop the exact retired relay",
    );
}
