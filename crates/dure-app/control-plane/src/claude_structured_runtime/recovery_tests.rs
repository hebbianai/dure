use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_TIMELINE_SCHEMA_VERSION_V1,
    AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1, AgentHistorySnapshotV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionProfileV1, AgentProviderRuntimeFenceV1,
    AgentRecordV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeLaunchSelectionV1,
    AgentRuntimeSelectionV1, AgentRuntimeTransitionAdvanceRequestV1,
    AgentRuntimeTransitionAdvanceV1, AgentRuntimeTransitionIntentV1, AgentRuntimeTransitionStateV1,
    AgentTimelineEpochV1, OperationIdV1, PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
    ProjectIdV1, ProjectRecordV1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileV1, ProviderIdV1,
    ProviderPermissionModeV1, RuntimeKindIdV1, SessionBindingRecordV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    EndpointDescriptor, EndpointKind, LocalSessionCatalog, MANAGED_CREATE_RETIRED_EXACT_CODE,
    ManagedCreateBrokerResponse, ManagedStopRequest, ProcessDescriptor, ProtocolVersion,
    SessionClass, SessionDescriptor, SessionLifecycle, VersionRange, write_managed_create_response,
};
use sha2::{Digest, Sha256};
use tokio::time::{Duration, Instant};

use super::*;
use crate::agent_conversation_api::AgentConversationRuntimeRegistry;
use crate::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;

#[tokio::test]
async fn active_reopen_attempts_recovery_without_reusing_an_unproved_host_receipt() {
    let root = tempfile::Builder::new()
        .prefix("dcrt-history-projection-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let host_state_root = root.path().join("host-state");
    let host_runtime_root = root.path().join("host-runtime");
    let runtime_state_root = root.path().join("runtime-state");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
        &runtime_state_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-history-projection").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-history-projection").unwrap();
    let agent_id = AgentIdV1::new("agent-history-projection").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "History projection".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "History projection".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let stale = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-history-projection")
            .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-history-projection".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-history-projection".into(),
            provider_epoch: "query-history-projection".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-history-projection").unwrap(),
        binding_revision: 1,
        history_complete: false,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        agent_id: stale.agent_id.clone(),
        provider_id: stale.provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: stale.execution_profile.clone(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 4,
    };
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&stale).await.unwrap();
    let completed = conversation_service
        .reconcile_history(&AgentHistorySnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            binding: stale.clone(),
            items: Vec::new(),
            observed_at_ms: 5,
        })
        .await
        .unwrap()
        .binding;
    assert!(completed.history_complete);

    let executable = std::env::current_exe().unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &executable,
                &executable,
                &host_state_root,
                &host_runtime_root,
                "host-history-projection",
                Vec::new(),
            )
            .unwrap(),
            "client-history-projection",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let manager = ClaudeStructuredRuntimeManager::new(
        ClaudeStructuredRuntimeConfiguration {
            backend_generation: "backend-history-projection".into(),
            hmux_runtime: executable.clone(),
            discovery_root,
            relay_executable: executable,
            address_root: runtime_state_root.clone(),
            state_root: runtime_state_root,
            environment: BTreeMap::new(),
        },
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        host,
        store,
    );
    manager.slots.lock().await.insert(
        stale.interaction_session_id.clone(),
        Arc::new(Mutex::new(Some(ActiveClaudeRuntime {
            binding: stale.clone(),
            cwd: workspace.clone(),
            launch_options: ClaudeStructuredLaunchOptionsV1::default(),
            host_identity: ClaudeDch1HostIdentity {
                host_generation: "host-history-projection".into(),
                host_instance_id: "instance-history-projection".into(),
            },
            query_identity: ClaudeDch1QueryIdentity {
                runtime_generation: stale.runtime.runtime_generation.clone(),
                query_epoch: stale.runtime.provider_epoch.clone(),
                relay_id: "relay-history-projection".into(),
            },
            receipt: ClaudeStructuredLaunchReceiptV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: stale.interaction_session_id.clone(),
                runtime_generation: stale.runtime.runtime_generation.clone(),
                query_epoch: stale.runtime.provider_epoch.clone(),
            },
        }))),
    );

    // The empty launch environment deliberately has no HOME or PATH. Reaching
    // RuntimeUnavailable proves the stale receipt was discarded and recovery
    // entered the canonical launch path without creating another relay.
    assert_eq!(
        manager
            .attach_existing(&selection, &stale)
            .await
            .unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable
    );
    let slot = manager
        .slots
        .lock()
        .await
        .get(&stale.interaction_session_id)
        .cloned()
        .unwrap();
    assert!(slot.lock().await.is_none());
    assert_eq!(
        conversation_service
            .binding(&stale.interaction_session_id)
            .await
            .unwrap(),
        Some(completed)
    );
}

#[tokio::test]
async fn attached_finalize_retry_keeps_the_exact_binding_while_its_relay_is_live() {
    let root = tempfile::Builder::new()
        .prefix("dcrt-attached-finalize-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let host_state_root = root.path().join("host-state");
    let host_runtime_root = root.path().join("host-runtime");
    let runtime_state_root = root.path().join("runtime-state");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
        &runtime_state_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-attached-finalize").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-attached-finalize").unwrap();
    let agent_id = AgentIdV1::new("agent-attached-finalize").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Attached finalize".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Attached finalize".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-attached-finalize")
            .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-attached-finalize".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-attached-finalize".into(),
            provider_epoch: "query-attached-finalize".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-attached-finalize").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let executable = std::env::current_exe().unwrap();
    let configuration = ClaudeStructuredRuntimeConfiguration {
        backend_generation: "backend-attached-finalize".into(),
        hmux_runtime: executable.clone(),
        discovery_root,
        relay_executable: executable.clone(),
        address_root: runtime_state_root.clone(),
        state_root: runtime_state_root,
        environment: BTreeMap::new(),
    };
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &executable,
                &executable,
                &host_state_root,
                &host_runtime_root,
                "host-attached-finalize",
                Vec::new(),
            )
            .unwrap(),
            "client-attached-finalize",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::clone(&host),
        store,
    );
    let mut prepared = manager
        .create_runtime(&binding, workspace_id.as_str(), &workspace, None)
        .unwrap();
    let _relay = tokio::net::UnixListener::bind(&prepared.files.endpoint).unwrap();
    let process_id = std::process::id();
    prepared.journal.relay_ready(SessionDescriptor {
        schema_version: 1,
        session_id: prepared.files.relay_session_id.clone(),
        session_name: None,
        workspace_id: workspace_id.as_str().into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CLAUDE_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "attached-finalize-runner".into(),
        runner_instance: "attached-finalize-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "attached-finalize-host".into(),
        terminal_epoch: "attached-finalize-terminal".into(),
        output_seq: "0".into(),
        host_build_version: "attached-finalize-build".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id,
            start_marker: format!("{process_id}-host"),
        },
        provider_process: ProcessDescriptor {
            process_id,
            start_marker: format!("{process_id}-provider"),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: prepared.files.endpoint.to_string_lossy().into_owned(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    });
    prepared.journal.attached(process_id);
    write_journal(&prepared.files.runtime_directory, &prepared.journal).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_slice(
        &fs::read(prepared.files.runtime_directory.join("launch.json")).unwrap(),
    )
    .unwrap();
    legacy["schemaVersion"] = 4.into();
    legacy["replaces"] = serde_json::to_value(ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-ancestry-only".into(),
        query_epoch: "query-ancestry-only".into(),
        relay_id: "relay-ancestry-only".into(),
    })
    .unwrap();
    legacy["providerReplacementFence"] = false.into();
    fs::write(
        prepared.files.runtime_directory.join("launch.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();

    let (observed_binding, mut observed_runtime) = manager
        .prepare_launch(binding.clone(), workspace_id.as_str(), &workspace)
        .await
        .unwrap();

    assert_eq!(observed_binding, binding);
    assert_eq!(
        observed_runtime.journal.state(),
        ClaudeRuntimeLaunchStateV1::Attached,
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding),
        "a finalize retry must not rotate binding revision or runtime identity",
    );
    manager
        .finalize_replacement_authority(
            &observed_binding,
            workspace_id.as_str(),
            &workspace,
            &mut observed_runtime,
        )
        .await
        .unwrap();
    let finalized = read_journal(&observed_runtime.files.runtime_directory).unwrap();
    assert_eq!(finalized.replaces(), None);
    assert_eq!(finalized.provider_predecessor(), None);
    assert_eq!(host.host_launch_count().unwrap(), 0);
}

#[tokio::test]
async fn retired_exact_crash_replay_parks_the_published_generation_without_rotation() {
    let root = tempfile::Builder::new()
        .prefix("dcrt-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let host_state_root = root.path().join("host-state");
    let host_runtime_root = root.path().join("host-runtime");
    let runtime_state_root = root.path().join("runtime-state");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
        &runtime_state_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-retired-exact").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-retired-exact").unwrap();
    let agent_id = AgentIdV1::new("agent-retired-exact").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Retired exact".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Retired exact".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-retired-exact")
            .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-retired-exact".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-retired-exact".into(),
            provider_epoch: "query-retired-exact".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-retired-exact").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        agent_id: binding.agent_id.clone(),
        provider_id: binding.provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: binding.execution_profile.clone(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 4,
    };
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let executable = std::env::current_exe().unwrap();
    let fake_runtime = root.path().join("fake-hmux-runtime");
    let fake_runtime_file =
        |suffix: &str| PathBuf::from(format!("{}{suffix}", fake_runtime.to_string_lossy()));
    fs::write(
        &fake_runtime,
        b"#!/bin/sh\n/bin/cat >> \"${0}.requests\"\nif [ -e \"${0}.first\" ]; then\n  /bin/rm \"${0}.first\"\n  /bin/cat \"${0}.retired\"\nelse\n  /bin/cat \"${0}.refused\"\nfi\n",
    )
    .unwrap();
    fs::set_permissions(&fake_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(fake_runtime_file(".first"), b"armed\n").unwrap();
    for (suffix, response) in [
        (
            ".retired",
            ManagedCreateBrokerResponse::refused(
                MANAGED_CREATE_RETIRED_EXACT_CODE,
                "retired exact fixture",
            ),
        ),
        (
            ".refused",
            ManagedCreateBrokerResponse::refused(
                "hmux_test_second_create_refused",
                "second create fixture",
            ),
        ),
    ] {
        let mut frame = Vec::new();
        write_managed_create_response(&mut frame, &response).unwrap();
        fs::write(fake_runtime_file(suffix), frame).unwrap();
    }
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &executable,
                &executable,
                &host_state_root,
                &host_runtime_root,
                "host-retired-exact",
                Vec::new(),
            )
            .unwrap(),
            "client-retired-exact",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let configuration = ClaudeStructuredRuntimeConfiguration {
        backend_generation: "backend-retired-exact".into(),
        hmux_runtime: fake_runtime.clone(),
        discovery_root,
        relay_executable: executable,
        address_root: runtime_state_root.clone(),
        state_root: runtime_state_root,
        environment: BTreeMap::new(),
    };
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration.clone(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        host,
        Arc::clone(&store),
    );
    let mut source = manager
        .create_runtime(&binding, workspace_id.as_str(), &workspace, None)
        .unwrap();
    let source_directory = source.files.runtime_directory.clone();
    // Crash cut: Hmux retired the published Prepared generation and the
    // journal recorded that outcome, but successor publication did not run.
    source
        .journal
        .failure_cleanup_pending(ClaudeStructuredRecordedFailureV1::ManagedCreateRetiredExact);
    source.journal.failure_cleanup_completed();
    write_journal(&source.files.runtime_directory, &source.journal).unwrap();

    let first_recovery = manager
        .attach_existing(&selection, &binding)
        .await
        .unwrap_err();
    assert_eq!(
        first_recovery,
        ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone()),
        "automatic recovery cannot rotate a cleanup-complete failed generation"
    );
    assert!(!fake_runtime_file(".requests").exists());

    let replay = manager
        .attach_existing(&selection, &binding)
        .await
        .unwrap_err();
    assert_eq!(
        replay,
        ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone())
    );
    assert!(!fake_runtime_file(".requests").exists());
    let retired = read_journal(&source_directory).unwrap();
    assert_eq!(retired.state(), ClaudeRuntimeLaunchStateV1::Failed);
    assert_eq!(
        retired.failure(),
        Some(&ClaudeStructuredRecordedFailureV1::ManagedCreateRetiredExact)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, relay, pinned Node, and Claude driver dependencies"]
async fn failed_published_target_parks_until_the_next_explicit_open() {
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let hmux_runtime = PathBuf::from(std::env::var_os("DURE_HMUX_RUNTIME_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let relay = PathBuf::from(std::env::var_os("DURE_CLAUDE_PROCESS_RELAY_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let driver = manifest_root.join("provider-drivers/claude");
    let entrypoint = driver
        .join("shared-sdk-host-entrypoint.mjs")
        .canonicalize()
        .unwrap();
    let installer = driver
        .join("claude-runtime-install.mjs")
        .canonicalize()
        .unwrap();
    let fake_claude = manifest_root
        .join("tests/fixtures/fake-claude-agent-sdk-cli.mjs")
        .canonicalize()
        .unwrap();

    let root = tempfile::Builder::new()
        .prefix("dcfr-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let host_state_root = root.path().join("host-state");
    let relay_state_root = root.path().join("relay-state");
    let runtime_root = root.path().join("runtime");
    let accounts_root = root.path().join("accounts");
    let credential_directory = accounts_root.join("claude-failed-attach");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &relay_state_root,
        &accounts_root,
        &credential_directory,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let install = Command::new(&node)
        .args([
            installer.as_os_str(),
            "--runtime-root".as_ref(),
            runtime_root.as_os_str(),
            "--source".as_ref(),
            fake_claude.as_os_str(),
        ])
        .current_dir(&driver)
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "runtime adoption failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-failed-attach").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-failed-attach").unwrap();
    let agent_id = AgentIdV1::new("agent-failed-attach").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    let credential_reference_id = "account-failed-attach";
    let credential_directory_name =
        ProviderCredentialProfileDirectoryNameV1::new(&provider_id, "claude-failed-attach")
            .unwrap();
    let credential_metadata = fs::symlink_metadata(&credential_directory).unwrap();
    let credential_generation = format!(
        "credential-v1-{:x}",
        Sha256::digest(
            format!(
                "provider-credential-profile/v1\0{}\0{credential_reference_id}\0{}\0{}",
                provider_id.as_str(),
                credential_metadata.dev(),
                credential_metadata.ino(),
            )
            .as_bytes(),
        )
    );
    store
        .register_provider_credential_profile(
            None,
            &ProviderCredentialProfileRegistrationV1 {
                profile: ProviderCredentialProfileV1 {
                    schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                    provider_id: provider_id.clone(),
                    reference_id: credential_reference_id.into(),
                    credential_generation: credential_generation.clone(),
                },
                profile_directory_name: credential_directory_name,
                profile_device: credential_metadata.dev(),
                profile_inode: credential_metadata.ino(),
            },
        )
        .await
        .unwrap();
    let execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: credential_reference_id.into(),
        credential_generation: Some(credential_generation),
    };
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Failed attach recovery".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Failed attach recovery".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();

    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-failed-attach")
            .unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile,
        provider_conversation_ref: Some("99999999-8888-4777-8666-555555555555".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-dead-source".into(),
            provider_epoch: "query-dead-source".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-failed-attach").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let native_binding = SessionBindingRecordV1 {
        agent_id: agent_id.clone(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        session_id: "native-session-failed-attach".into(),
        provider_conversation_id: binding.provider_conversation_ref.clone(),
        credential_reference_id: Some(credential_reference_id.into()),
        binding_generation: 1,
        bound_at_ms: 4,
    };
    store.upsert_session_binding(&native_binding).await.unwrap();
    let native_selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: binding.execution_profile.clone(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 4,
    };
    store
        .initialize_agent_runtime_selection(&native_selection)
        .await
        .unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let native_to_structured = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("native-to-structured-failed-attach").unwrap(),
            idempotency_key: "native-to-structured-failed-attach-key".into(),
            source: native_selection,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: AgentCheckpointBindingAuthorityV1 {
                    schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                    binding: native_binding.clone(),
                    runtime_workspace_id: workspace_id.as_str().into(),
                    runner_principal: "runner-failed-attach".into(),
                    runner_instance: "runner-instance-failed-attach".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-failed-attach".into(),
                    terminal_epoch: "terminal-failed-attach".into(),
                    updated_at_ms: 4,
                },
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                binding.provider_conversation_ref.clone().unwrap(),
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: binding.execution_profile.clone(),
            target_launch_selection: None,
            requested_at_ms: 5,
        })
        .await
        .unwrap();
    let native_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: native_to_structured.intent.operation_id.clone(),
            expected_journal_revision: native_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 6,
        })
        .await
        .unwrap();
    let native_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: native_to_structured.intent.operation_id.clone(),
            expected_journal_revision: native_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: binding.clone(),
                }),
            },
            advanced_at_ms: 7,
        })
        .await
        .unwrap();
    let native_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: native_to_structured.intent.operation_id.clone(),
            expected_journal_revision: native_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: 8,
        })
        .await
        .unwrap();
    let structured_selection = native_to_structured.intent.target_selection_at(8).unwrap();
    let structured_to_structured = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("structured-model-failed-attach").unwrap(),
            idempotency_key: "structured-model-failed-attach-key".into(),
            source: structured_selection,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                binding.provider_conversation_ref.clone().unwrap(),
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: binding.execution_profile.clone(),
            target_launch_selection: Some(AgentRuntimeLaunchSelectionV1 {
                model: Some(
                    dure_app::AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap(),
                ),
                effort: None,
                permission_mode: None,
            }),
            requested_at_ms: 9,
        })
        .await
        .unwrap();
    let structured_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: structured_to_structured.intent.operation_id.clone(),
            expected_journal_revision: structured_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 10,
        })
        .await
        .unwrap();
    let structured_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: structured_to_structured.intent.operation_id.clone(),
            expected_journal_revision: structured_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: binding.clone(),
                }),
            },
            advanced_at_ms: 11,
        })
        .await
        .unwrap();
    let structured_to_structured = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: structured_to_structured.intent.operation_id.clone(),
            expected_journal_revision: structured_to_structured.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: 12,
        })
        .await
        .unwrap();
    let selection = structured_to_structured
        .intent
        .target_selection_at(12)
        .unwrap();
    assert_eq!(
        store.session_binding(&binding.agent_id).await.unwrap(),
        Some(native_binding.clone())
    );
    assert_eq!(
        store
            .agent_runtime_selection(&binding.agent_id)
            .await
            .unwrap(),
        Some(selection.clone())
    );
    let runtime_registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        &node,
        entrypoint,
        &host_state_root,
        &runtime_root,
        "host-failed-attach",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            "client-failed-attach",
            Arc::clone(&conversation_service),
            runtime_registry,
        )
        .unwrap(),
    );
    let fail_once = root.path().join("fail-start-once");
    let provider_start_log = root.path().join("provider-starts");
    fs::write(&fail_once, b"armed\n").unwrap();
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-failed-attach",
        hmux_runtime,
        &discovery_root,
        relay,
        &relay_state_root,
        BTreeMap::from([
            ("HOME".into(), root.path().to_string_lossy().into_owned()),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            (
                "HEBBIAN_TEST_CLAUDE_FAIL_START_ONCE_FILE".into(),
                fail_once.to_string_lossy().into_owned(),
            ),
            (
                "HEBBIAN_TEST_CLAUDE_START_LOG_FILE".into(),
                provider_start_log.to_string_lossy().into_owned(),
            ),
        ]),
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::clone(&host),
        Arc::clone(&store),
    );

    let mut dead_source = manager
        .create_runtime(&binding, workspace_id.as_str(), &workspace, None)
        .unwrap();
    let mut exited = Command::new("/usr/bin/true").spawn().unwrap();
    let dead_process_id = exited.id();
    assert!(exited.wait().unwrap().success());
    dead_source.journal.relay_ready(SessionDescriptor {
        schema_version: 1,
        session_id: dead_source.files.relay_session_id.clone(),
        session_name: None,
        workspace_id: workspace_id.as_str().into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CLAUDE_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "dead-runner".into(),
        runner_instance: "dead-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "dead-host".into(),
        terminal_epoch: "dead-terminal".into(),
        output_seq: "0".into(),
        host_build_version: "dead-build".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id: dead_process_id,
            start_marker: format!("{dead_process_id}-1"),
        },
        provider_process: ProcessDescriptor {
            process_id: dead_process_id,
            start_marker: format!("{dead_process_id}-1"),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: dead_source.files.endpoint.to_string_lossy().into_owned(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    });
    // This fixture never bound a provider Query. RelayReady is the exact
    // crash cut; an Attached journal now requires provider retirement proof.
    write_journal(&dead_source.files.runtime_directory, &dead_source.journal).unwrap();
    let provider_process_ids = || {
        fs::read_to_string(&provider_start_log)
            .unwrap()
            .lines()
            .map(|line| line.parse::<u32>().unwrap())
            .collect::<Vec<_>>()
    };
    let provider_process_is_live = |process_id: u32| {
        let output = Command::new("/bin/ps")
            .args(["-p", &process_id.to_string(), "-o", "pid="])
            .output()
            .unwrap();
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).trim() == process_id.to_string()
    };

    let first = manager
        .attach_existing(&selection, &binding)
        .await
        .unwrap_err();
    assert_eq!(first.code(), "claude_conversation_host_attach_failed");
    assert_eq!(first, ClaudeStructuredRuntimeErrorV1::HostAttachFailed);
    let failed_binding = conversation_service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed_binding.binding_revision, 2);
    assert_eq!(
        failed_binding.interaction_session_id,
        binding.interaction_session_id
    );
    assert_eq!(failed_binding.execution_profile, binding.execution_profile);
    assert_eq!(
        failed_binding.provider_conversation_ref,
        binding.provider_conversation_ref
    );
    let failed_runtime = manager
        .read_runtime(&failed_binding, workspace_id.as_str(), &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(
        failed_runtime.journal.state(),
        ClaudeRuntimeLaunchStateV1::Failed
    );
    let failed_relay_descriptor = failed_runtime.journal.descriptor().unwrap().clone();
    let failed_journal_path = failed_runtime.files.runtime_directory.join("launch.json");
    let failed_journal_bytes = fs::read(&failed_journal_path).unwrap();
    let failed_journal: serde_json::Value = serde_json::from_slice(&failed_journal_bytes).unwrap();
    assert_eq!(failed_journal["failure"]["kind"], "host_attach");
    assert_eq!(
        failed_journal["failure"]["reason"],
        "bind_remote_internal_error"
    );
    let failed_provider_processes = provider_process_ids();
    let failed_runtime_directory_count = fs::read_dir(&relay_state_root).unwrap().count();
    assert_eq!(failed_provider_processes.len(), 1);
    assert!(!provider_process_is_live(failed_provider_processes[0]));
    assert!(relay_generation_is_absent(&failed_relay_descriptor).unwrap());

    let parked = manager
        .attach_existing(&selection, &failed_binding)
        .await
        .unwrap_err();
    assert_eq!(
        parked,
        ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(failed_binding.clone())
    );
    assert_eq!(provider_process_ids(), failed_provider_processes);
    assert_eq!(
        fs::read(&failed_journal_path).unwrap(),
        failed_journal_bytes
    );
    assert_eq!(
        fs::read_dir(&relay_state_root).unwrap().count(),
        failed_runtime_directory_count
    );
    assert!(relay_generation_is_absent(&failed_relay_descriptor).unwrap());

    let opened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: binding.agent_id.clone(),
            execution_profile: binding.execution_profile.clone(),
            provider_conversation_ref: binding.provider_conversation_ref.clone(),
            permission_mode: selection.permission_mode.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        })
        .await
        .unwrap();
    let recovered = opened.binding;
    assert_eq!(recovered.binding_revision, 3);
    assert_eq!(
        opened.launch.runtime_generation,
        recovered.runtime.runtime_generation
    );
    assert_eq!(opened.launch.query_epoch, recovered.runtime.provider_epoch);
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(recovered.clone())
    );
    assert_eq!(
        recovered.interaction_session_id,
        binding.interaction_session_id
    );
    assert_eq!(recovered.execution_profile, binding.execution_profile);
    assert_eq!(
        recovered.provider_conversation_ref,
        binding.provider_conversation_ref
    );
    assert_eq!(recovered.timeline_epoch, binding.timeline_epoch);
    assert_eq!(recovered.history_complete, binding.history_complete);
    assert_ne!(recovered.runtime, binding.runtime);
    assert_ne!(recovered.runtime, failed_binding.runtime);
    let live_relays = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| {
            descriptor.workspace_id == workspace_id.as_str()
                && descriptor.provider_id == CLAUDE_PROVIDER_ID
                && descriptor.lifecycle == SessionLifecycle::Ready
        })
        .count();
    assert_eq!(live_relays, 1);
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    let provider_processes = provider_process_ids();
    assert_eq!(provider_processes.len(), 2);
    assert_ne!(provider_processes[0], provider_processes[1]);
    assert!(!provider_process_is_live(provider_processes[0]));
    assert!(provider_process_is_live(provider_processes[1]));

    let reopened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: binding.agent_id.clone(),
            execution_profile: binding.execution_profile.clone(),
            provider_conversation_ref: binding.provider_conversation_ref.clone(),
            permission_mode: selection.permission_mode.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        })
        .await
        .unwrap();
    assert_eq!(reopened.binding, recovered);
    assert_eq!(provider_process_ids(), provider_processes);
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    assert_eq!(
        store.session_binding(&binding.agent_id).await.unwrap(),
        Some(native_binding)
    );

    assert!(
        manager
            .stop(
                &binding.interaction_session_id,
                &recovered.runtime.runtime_generation,
            )
            .await
            .unwrap()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while provider_process_is_live(provider_processes[1]) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!provider_process_is_live(provider_processes[1]));
}

mod query_retirement;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires native Hmux, relay, pinned Node and Claude driver dependencies"]
async fn query_retirement_is_durable_before_an_exact_hmux_stop_refusal() {
    query_retirement::exercise().await;
}

/// Red-first contract for dead-runtime retirement convergence: a journal
/// still Attached whose relay host and provider processes are durably absent
/// (the CLI died and the backend restarted, so the fresh DCH1 host has no
/// record to retire) must retire through the proven-absence reconcile instead
/// of failing forever. A wedged chat-to-terminal switch retried this exact
/// stop for hours (2026-08-31).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned Node and Claude driver dependencies"]
async fn dead_attached_query_retires_by_absence_proof() {
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let driver = manifest_root.join("provider-drivers/claude");
    let entrypoint = driver
        .join("shared-sdk-host-entrypoint.mjs")
        .canonicalize()
        .unwrap();
    let installer = driver
        .join("claude-runtime-install.mjs")
        .canonicalize()
        .unwrap();
    let fake_claude = manifest_root
        .join("tests/fixtures/fake-claude-agent-sdk-cli.mjs")
        .canonicalize()
        .unwrap();

    let root = tempfile::Builder::new()
        .prefix("dcds-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let host_state_root = root.path().join("host-state");
    let relay_state_root = root.path().join("relay-state");
    let runtime_root = root.path().join("runtime");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &relay_state_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let install = Command::new(&node)
        .args([
            installer.as_os_str(),
            "--runtime-root".as_ref(),
            runtime_root.as_os_str(),
            "--source".as_ref(),
            fake_claude.as_os_str(),
        ])
        .current_dir(&driver)
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "runtime adoption failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-dead-stop").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-dead-stop").unwrap();
    let agent_id = AgentIdV1::new("agent-dead-stop").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Dead stop".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Dead stop".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-dead-stop").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("11111111-2222-4333-8444-555555555555".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-dead-stop".into(),
            provider_epoch: "query-dead-stop".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-dead-stop").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();

    // A real, freshly started DCH1 host: it has no record of the dead query,
    // exactly like a backend restarted after the CLI died.
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &node,
                entrypoint,
                &host_state_root,
                &runtime_root,
                "host-dead-stop",
                Vec::new(),
            )
            .unwrap(),
            "client-dead-stop",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-dead-stop",
        node.clone(),
        &discovery_root,
        node.clone(),
        &relay_state_root,
        BTreeMap::from([
            ("HOME".into(), root.path().to_string_lossy().into_owned()),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ]),
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::clone(&host),
        Arc::clone(&store),
    );

    let mut dead_source = manager
        .create_runtime(&binding, workspace_id.as_str(), &workspace, None)
        .unwrap();
    let mut exited = Command::new("/usr/bin/true").spawn().unwrap();
    let dead_process_id = exited.id();
    assert!(exited.wait().unwrap().success());
    dead_source.journal.relay_ready(SessionDescriptor {
        schema_version: 1,
        session_id: dead_source.files.relay_session_id.clone(),
        session_name: None,
        workspace_id: workspace_id.as_str().into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: CLAUDE_PROVIDER_ID.into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "dead-runner".into(),
        runner_instance: "dead-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "dead-host".into(),
        terminal_epoch: "dead-terminal".into(),
        output_seq: "0".into(),
        host_build_version: "dead-build".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id: dead_process_id,
            start_marker: format!("{dead_process_id}-1"),
        },
        provider_process: ProcessDescriptor {
            process_id: dead_process_id,
            start_marker: format!("{dead_process_id}-1"),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: dead_source.files.endpoint.to_string_lossy().into_owned(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    });
    dead_source.journal.attached(dead_process_id);
    write_journal(&dead_source.files.runtime_directory, &dead_source.journal).unwrap();

    let identity = dead_source.journal.query_identity();
    manager
        .retire_query_before_stop(
            &binding,
            &identity,
            &dead_source.files.runtime_directory,
            &mut dead_source.journal,
            true,
            None,
        )
        .await
        .expect("proven absence must let retirement converge");
    assert_eq!(
        dead_source.journal.state(),
        ClaudeRuntimeLaunchStateV1::QueryRetired
    );
    let authority = dead_source.journal.retirement_authority().unwrap();
    assert_eq!(authority.source, identity);
    assert_eq!(authority.allowed_target, None);

    manager
        .begin_prepared_stop_cleanup(workspace_id.as_str(), &mut dead_source)
        .await
        .unwrap();
    manager
        .complete_stop_cleanup(
            &workspace,
            &dead_source.files.runtime_directory,
            &mut dead_source.journal,
        )
        .await
        .expect("an exact relay generation that is already absent is stopped");
    assert_eq!(
        dead_source.journal.state(),
        ClaudeRuntimeLaunchStateV1::Stopped
    );
}
