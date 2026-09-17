use super::*;
use crate::codex_timeline_bridge::CodexTimelineBridge;
use crate::json_rpc_socket_client::JsonRpcSocketClient;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_TIMELINE_SCHEMA_VERSION_V1,
    AgentCheckpointBindingAuthorityV1, AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionProfileV1, AgentProviderConversationPlanV1, AgentRecordV1,
    AgentRuntimeReplacementAuthorityUpdateV1, AgentRuntimeSelectionV1,
    AgentRuntimeSourceStopPolicyV1, AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionIntentV1, AgentStartTurnIntentV1, AgentTimelineItemBodyV1,
    AgentTimelineLifecycleStateV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTurnIdV1, OperationIdV1,
    PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1, ProjectIdV1, ProjectRecordV1,
    ProviderCredentialProfileDirectoryNameV1, ProviderCredentialProfileRegistrationV1,
    ProviderCredentialProfileV1, ProviderIdV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    SessionBindingRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use hmux_client::{
    EndpointDescriptor, EndpointKind, LocalProcessGenerationStatus, LocalSessionCatalog,
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateReconcileBrokerResponse, ManagedStopBrokerResponse, ProcessDescriptor,
    ProtocolVersion, SessionClass, SessionDescriptor, SessionLifecycle, VersionRange,
    probe_local_process_generation,
};
use serde::Serialize;
use tempfile::TempDir;
use tokio::net::UnixListener;
use tokio::time::timeout;
use tokio_tungstenite::accept_async;

use crate::structured_provider_runtime::StructuredProviderOpenRequestV1;

#[path = "../../tests/support/process_metrics.rs"]
mod process_metrics;

#[path = "runtime_scale_launch.rs"]
mod runtime_scale_launch;

#[path = "runtime_scale_roles.rs"]
mod runtime_scale_roles;

#[path = "slack_conversation_smoke.rs"]
mod slack_conversation_smoke;

#[path = "goal_conversation_smoke.rs"]
mod goal_conversation_smoke;

use process_metrics::{
    HardwareContext, RoleMeasurement, descendant_pids, duration_millis, hardware_context,
    measure_roles, percentile, process_memory_method, process_rows, role_processes,
    sample_processes, sum_optional, wait_for_process_absence,
};

const COUNTS: [usize; 3] = [1, 5, 20];
const SETTLE_WINDOW: Duration = Duration::from_secs(1);
const IDLE_WINDOW: Duration = Duration::from_secs(3);
const PROCESS_WAIT: Duration = Duration::from_secs(10);

fn installed_codex_wrapper() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("codex"))
                .find(|path| path.exists())
        })
        .and_then(|path| path.canonicalize().ok())
}

#[test]
fn official_npm_wrapper_resolves_to_the_native_binary_when_present() {
    let Some(wrapper) = installed_codex_wrapper() else {
        return;
    };
    let resolved = super::provider::preferred_native_codex(&wrapper);
    assert!(resolved.is_file());
    if wrapper.file_name().and_then(|name| name.to_str()) == Some("codex.js") {
        assert_ne!(resolved, wrapper);
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("codex")
        );
    }
}

#[test]
fn a_configured_codex_executable_is_available_without_a_schema_allowlist() {
    let root = TempDir::new().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let executable = root.path().join("codex");
    fs::write(&executable, "#!/bin/sh\nexit 97\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

    let configuration = ManagedStructuredRuntimeConfiguration::new(
        "generation-1",
        ManagedProviderExecutable::new(ManagedProviderKind::Codex, Some(executable.clone())),
        executable.clone(),
        executable,
        root.path(),
        root.path(),
        root.path(),
    )
    .unwrap();

    assert!(configuration.supports_new_sessions());
}

#[tokio::test]
async fn a_missing_codex_executable_never_recreates_a_missing_exact_descriptor() {
    let root = tempfile::Builder::new()
        .prefix("dcr")
        .tempdir_in("/tmp")
        .unwrap();
    let discovery_root = root.path().join("discovery");
    let state_root = root.path().join("state");
    let credential_home = root.path().join("credentials");
    owner_directory(&discovery_root);
    owner_directory(&state_root);
    owner_directory(&credential_home);
    let provider_launcher = root.path().join("provider-launcher");
    fs::write(&provider_launcher, "#!/bin/sh\nexit 97\n").unwrap();
    fs::set_permissions(&provider_launcher, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux_runtime = root.path().join("hmux-runtime");
    fs::write(
        &hmux_runtime,
        "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\nexit 97\n",
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    seed(&store, root.path(), 1).await;
    let agent_id = AgentIdV1::new("agent-codex-scale-0").unwrap();
    let request = StructuredProviderOpenRequestV1 {
        agent_id: agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-lifecycle-only".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let agent = store.agent(&agent_id).await.unwrap().unwrap();
    let binding = initial_binding(&agent, &request, "generation-1").unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id,
        provider_id: ProviderIdV1::new(CODEX_PROVIDER_ID).unwrap(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 3,
    };
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        credential_home,
        Arc::clone(&store),
    ));
    let configuration = ManagedStructuredRuntimeConfiguration::new(
        "generation-1",
        ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher,
        hmux_runtime.clone(),
        discovery_root,
        state_root.clone(),
        state_root,
    )
    .unwrap();
    let manager = ManagedStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&conversation_service),
        Arc::new(AgentConversationRuntimeRegistry::default()),
        Arc::clone(&store),
    );

    let error = manager
        .attach_existing_runtime(&selection, &binding)
        .await
        .unwrap_err();

    assert_eq!(error.kind, ErrorKind::ExplicitRecoveryRequired, "{error:?}");
    assert_eq!(error.code, "managed_provider_recovery_required");
    assert!(
        !hmux_runtime.with_extension("calls").exists(),
        "recovery without a Codex executable must not create a new app-server"
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone()),
        "failed attach must preserve the exact selected binding"
    );

    let error = manager.stop_binding(&binding, true).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::SourceBusy, "{error:?}");
    assert!(error.retains_source());
    assert_eq!(
        fs::read_to_string(hmux_runtime.with_extension("calls")).unwrap(),
        format!("{MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}\n"),
        "an unavailable-provider idle probe may reconcile identity but cannot create or stop",
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone()),
        "an uncertain cold stop must retain the exact selected binding",
    );

    fs::remove_file(hmux_runtime.with_extension("calls")).unwrap();
    let files = runtime_files(&manager.configuration, &binding).unwrap();
    ensure_runtime_directory(&files.directory).unwrap();
    managed_create_checkpoint::prepare_managed_create_checkpoint(
        &files,
        agent.workspace_id.as_str(),
        &files.session_id,
        &files.idempotency_key,
        &digest("prepared-without-provider"),
    )
    .unwrap();
    assert!(matches!(
        managed_create_checkpoint::resolve_managed_create_checkpoint(
            &files,
            agent.workspace_id.as_str(),
        )
        .unwrap(),
        managed_create_checkpoint::ManagedCreateCheckpointResolution::Prepared { .. },
    ));
    let prepared_checkpoint = fs::read(&files.managed_create_identity).unwrap();

    let error = manager.stop_binding(&binding, true).await.unwrap_err();

    assert_eq!(error.kind, ErrorKind::SourceBusy, "{error:?}");
    assert!(error.retains_source());
    assert!(
        !hmux_runtime.with_extension("calls").exists(),
        "an unavailable-provider idle probe must not invoke {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}",
    );
    assert_eq!(
        fs::read(&files.managed_create_identity).unwrap(),
        prepared_checkpoint,
        "the idle probe must preserve prepared replay authority",
    );
    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding),
        "a prepared cold stop must retain the exact selected binding",
    );
}

#[tokio::test]
async fn missing_exact_runtime_is_replaced_before_a_successor_is_created() {
    let root = tempfile::Builder::new()
        .prefix("dcr-missing-")
        .tempdir_in("/tmp")
        .unwrap();
    let discovery_root = root.path().join("discovery");
    let state_root = root.path().join("state");
    let credential_home = root.path().join("credentials");
    owner_directory(&discovery_root);
    owner_directory(&state_root);
    owner_directory(&credential_home);

    let executable = root.path().join("fixture-executable");
    fs::write(&executable, "#!/bin/sh\nexit 97\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux_runtime = root.path().join("hmux-runtime");
    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\n[ \"$2\" = \"{}\" ] && exec cat \"$0.reconcile\"\nexit 97\n",
            MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND,
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let payload = serde_json::to_vec(&ManagedCreateReconcileBrokerResponse::NotFound).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    fs::write(hmux_runtime.with_extension("reconcile"), frame).unwrap();

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    seed(&store, root.path(), 1).await;
    let agent_id = AgentIdV1::new("agent-codex-scale-0").unwrap();
    let request = StructuredProviderOpenRequestV1 {
        agent_id: agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-missing-exact".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let agent = store.agent(&agent_id).await.unwrap().unwrap();
    let binding = initial_binding(&agent, &request, "generation-1").unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    store
        .record_agent_turn_intent(&AgentStartTurnIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding.interaction_session_id.clone(),
            runtime: binding.runtime.clone(),
            turn_id: AgentTurnIdV1::new("turn-missing-exact").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-missing-exact").unwrap(),
            input: "keep this turn finite".into(),
            requested_at_ms: 10,
        })
        .await
        .unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id,
        provider_id: ProviderIdV1::new(CODEX_PROVIDER_ID).unwrap(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 3,
    };
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let configuration = ManagedStructuredRuntimeConfiguration::new(
        "generation-1",
        ManagedProviderExecutable::new(ManagedProviderKind::Codex, Some(executable.clone())),
        executable,
        hmux_runtime.clone(),
        discovery_root,
        state_root.clone(),
        state_root,
    )
    .unwrap();
    let manager = ManagedStructuredRuntimeManager::new(
        configuration,
        Arc::new(ProviderCredentialProfileRegistry::new(
            credential_home,
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::new(AgentConversationRuntimeRegistry::default()),
        Arc::clone(&store),
    );

    let error = manager
        .attach_existing_runtime(&selection, &binding)
        .await
        .unwrap_err();

    assert_eq!(error.kind, ErrorKind::LaunchFailed, "{error:?}");
    let replacement = conversation_service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replacement.binding_revision, binding.binding_revision + 1);
    assert_ne!(replacement.runtime, binding.runtime);
    assert_eq!(
        replacement.provider_conversation_ref,
        binding.provider_conversation_ref,
    );
    let read = conversation_service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 16,
        })
        .await
        .unwrap();
    let AgentTimelineReadV1::Page { page } = read else {
        panic!("replacement must keep the current timeline readable");
    };
    assert_eq!(
        page.rows.last().unwrap().item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::TurnFailed,
            detail: Some("runtime_replaced".into()),
        },
    );
    assert_eq!(
        fs::read_to_string(hmux_runtime.with_extension("calls")).unwrap(),
        format!(
            "{MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}\n{MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}\n"
        ),
    );
}

#[tokio::test]
async fn disconnected_runtime_slot_is_released_when_exact_stop_fails() {
    let root = tempfile::Builder::new()
        .prefix("dcr-disconnected-")
        .tempdir_in("/tmp")
        .unwrap();
    let discovery_root = root.path().join("discovery");
    let state_root = root.path().join("state");
    let credential_home = root.path().join("credentials");
    owner_directory(&discovery_root);
    owner_directory(&state_root);
    owner_directory(&credential_home);

    let executable = root.path().join("fixture-executable");
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\ncat >/dev/null\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) exec cat \"$0.stop\" ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    for (suffix, response) in [
        (
            "reconcile",
            ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_intent_not_found",
                "no prior stop intent",
            ),
        ),
        (
            "stop",
            ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_fence_mismatch",
                "source generation retained",
            ),
        ),
    ] {
        let payload = serde_json::to_vec(&response).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend(payload);
        fs::write(executable.with_extension(suffix), frame).unwrap();
    }

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    seed(&store, root.path(), 1).await;
    let agent = store
        .agent(&AgentIdV1::new("agent-codex-scale-0").unwrap())
        .await
        .unwrap()
        .unwrap();
    let request = StructuredProviderOpenRequestV1 {
        agent_id: agent.agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-disconnected".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let binding = initial_binding(&agent, &request, "generation-1").unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let manager = ManagedStructuredRuntimeManager::new(
        ManagedStructuredRuntimeConfiguration::new(
            "generation-1",
            ManagedProviderExecutable::new(ManagedProviderKind::Codex, Some(executable.clone())),
            executable.clone(),
            executable,
            discovery_root,
            state_root.clone(),
            state_root,
        )
        .unwrap(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            credential_home,
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::new(AgentConversationRuntimeRegistry::default()),
        Arc::clone(&store),
    );

    let socket_path = root.path().join("bridge.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _socket = accept_async(stream).await.unwrap();
    });
    let (client, incoming) = JsonRpcSocketClient::connect(&socket_path).await.unwrap();
    let settings = ProviderTurnSettings::new(ProviderPermissionModeV1::Default, None, None);
    let bridge = Arc::new(
        CodexTimelineBridge::new(
            binding.clone(),
            client,
            "thread-disconnected".into(),
            settings.clone(),
            Arc::clone(&conversation_service),
        )
        .await
        .unwrap(),
    );
    let files = runtime_files(&manager.configuration, &binding).unwrap();
    let slot = Arc::new(Mutex::new(Some(ActiveManagedRuntime {
        binding: binding.clone(),
        cwd: exact_directory(&root.path().join("workspace-0")).unwrap(),
        descriptor: SessionDescriptor {
            schema_version: 1,
            session_id: "session-disconnected".into(),
            session_name: None,
            workspace_id: agent.workspace_id.as_str().into(),
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
        },
        files,
        settings,
        bridge: bridge.clone(),
    })));
    manager
        .slots
        .lock()
        .await
        .insert(binding.interaction_session_id.clone(), Arc::clone(&slot));
    let mut notifications = conversation_service.subscribe();
    manager.watch_connection(
        Arc::clone(&slot),
        binding.clone(),
        bridge.clone(),
        bridge.spawn(incoming),
    );

    timeout(Duration::from_secs(3), notifications.recv())
        .await
        .expect("runtime invalidation timed out")
        .expect("runtime invalidation channel closed");
    server.await.unwrap();
    assert!(
        slot.lock().await.is_none(),
        "a disconnected in-process runtime must not remain the recovery authority"
    );
}

#[tokio::test]
async fn failed_chat_retirement_advances_from_the_current_binding_generation() {
    let root = tempfile::Builder::new()
        .prefix("dcr")
        .tempdir_in("/tmp")
        .unwrap();
    let discovery_root = root.path().join("discovery");
    let state_root = root.path().join("state");
    let credential_home = root.path().join("credentials");
    owner_directory(&discovery_root);
    owner_directory(&state_root);
    owner_directory(&credential_home);
    let provider_launcher = root.path().join("provider-launcher");
    let hmux_runtime = root.path().join("hmux-runtime");
    for executable in [&provider_launcher, &hmux_runtime] {
        fs::write(executable, "#!/bin/sh\nexit 97\n").unwrap();
        fs::set_permissions(executable, fs::Permissions::from_mode(0o700)).unwrap();
    }

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    seed(&store, root.path(), 1).await;
    let agent_id = AgentIdV1::new("agent-codex-scale-0").unwrap();
    let provider_id = ProviderIdV1::new(CODEX_PROVIDER_ID).unwrap();
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 4,
    };
    store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let source_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "native-source".into(),
            provider_conversation_id: Some("conversation-live".into()),
            credential_reference_id: None,
            binding_generation: 1,
            bound_at_ms: 4,
        },
        runtime_workspace_id: "workspace-codex-scale-0".into(),
        runner_principal: "local-user".into(),
        runner_instance: "runner-source".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-source".into(),
        terminal_epoch: "terminal-source".into(),
        updated_at_ms: 4,
    };
    store
        .upsert_agent_checkpoint_binding_authority(&source_authority)
        .await
        .unwrap();
    let operation_id = OperationIdV1::new("failed-chat-retirement").unwrap();
    let admitted = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: "failed-chat-retirement-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume("conversation-live")
                .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 10,
        })
        .await
        .unwrap();
    let stopped = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 11,
        })
        .await
        .unwrap();

    let request = StructuredProviderOpenRequestV1 {
        agent_id: agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-live".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let agent = store.agent(&agent_id).await.unwrap().unwrap();
    let mut first = initial_binding(&agent, &request, "generation-1").unwrap();
    first.runtime = transition_runtime(&stopped);
    first.updated_at_ms = 12;
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let first = conversation_service.create(&first).await.unwrap();
    let second = conversation_service
        .replace_runtime(&AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: first.interaction_session_id.clone(),
            expected_binding_revision: first.binding_revision,
            source: first.runtime.clone(),
            source_execution_profile: first.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-second-repair".into(),
                provider_epoch: "provider-second-repair".into(),
            },
            target_execution_profile: first.execution_profile.clone(),
            provider_conversation_ref: first.provider_conversation_ref.clone(),
            replaced_at_ms: 13,
        })
        .await
        .unwrap();
    let failed = conversation_service
        .replace_runtime(&AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: second.interaction_session_id.clone(),
            expected_binding_revision: second.binding_revision,
            source: second.runtime.clone(),
            source_execution_profile: second.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-current-failed".into(),
                provider_epoch: "provider-current-failed".into(),
            },
            target_execution_profile: second.execution_profile.clone(),
            provider_conversation_ref: second.provider_conversation_ref.clone(),
            replaced_at_ms: 14,
        })
        .await
        .unwrap();
    let repair_required = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id,
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "managed_provider_managed_create_rejected",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                            binding: failed.clone(),
                        },
                    ))),
                },
            },
            advanced_at_ms: 15,
        })
        .await
        .unwrap();

    let configuration = ManagedStructuredRuntimeConfiguration::new(
        "generation-1",
        ManagedProviderExecutable::new(ManagedProviderKind::Codex, None),
        provider_launcher,
        hmux_runtime,
        discovery_root,
        state_root.clone(),
        state_root,
    )
    .unwrap();
    let manager = ManagedStructuredRuntimeManager::new(
        configuration,
        Arc::new(ProviderCredentialProfileRegistry::new(
            credential_home,
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        Arc::new(AgentConversationRuntimeRegistry::default()),
        Arc::clone(&store),
    );

    let retired = manager
        .retire_replacement_runtime(&repair_required)
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol {
        binding: retired_binding,
    } = &retired.0
    else {
        panic!("Codex retirement must return structured authority");
    };
    assert_eq!(retired_binding.binding_revision, 4);
    assert_ne!(retired_binding.runtime, first.runtime);
    assert_eq!(
        conversation_service
            .binding(&retired_binding.interaction_session_id)
            .await
            .unwrap(),
        Some(retired_binding.clone()),
    );
    assert_eq!(
        manager
            .retire_replacement_runtime(&repair_required)
            .await
            .unwrap(),
        retired,
        "a lost retirement response must replay the exact new generation",
    );
}

#[test]
fn failed_idle_probe_always_retains_the_selected_source() {
    for kind in [
        ErrorKind::LaunchFailed,
        ErrorKind::RuntimeUnavailable,
        ErrorKind::StopFailed,
        ErrorKind::CredentialUnavailable,
    ] {
        let error = source_retaining_stop_probe_error(Error::new(kind, "probe_failed"));
        assert_eq!(error.kind, ErrorKind::SourceBusy);
        assert!(error.retains_source());
    }
    let stale = source_retaining_stop_probe_error(Error::new(
        ErrorKind::CredentialStale,
        "credential_stale",
    ));
    assert_eq!(stale.kind, ErrorKind::CredentialStale);
    assert!(stale.retains_source());
}

#[derive(Clone)]
struct FixturePaths {
    codex: PathBuf,
    credential: Option<CredentialFixture>,
    credential_home: PathBuf,
    database: PathBuf,
    discovery_root: PathBuf,
    hmux_runtime: PathBuf,
    provider_launcher: PathBuf,
    root: PathBuf,
    state_root: PathBuf,
}

#[derive(Clone)]
struct CredentialFixture {
    directory_name: ProviderCredentialProfileDirectoryNameV1,
    generation: String,
    reference_id: String,
}

#[derive(Clone, Debug)]
struct BindingIdentity {
    agent_id: String,
    interaction_session_id: String,
    provider_conversation_ref: Option<String>,
    runtime: AgentProviderRuntimeFenceV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseTotals {
    process_count: usize,
    rss_kib: u64,
    physical_footprint_kib: Option<u64>,
    fd_count: Option<u64>,
    socket_count: Option<u64>,
    idle_cpu_nanos: Option<u64>,
    idle_interrupt_wakeups: Option<u64>,
    idle_package_wakeups: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseMeasurement {
    backend_generation: String,
    open_wall_ms: f64,
    open_p50_ms: f64,
    open_p95_ms: f64,
    totals: PhaseTotals,
    roles: Vec<RoleMeasurement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementMeasurement {
    interaction_count: usize,
    preserved_interaction_count: usize,
    preserved_provider_reference_state_count: usize,
    reused_runtime_fence_count: usize,
    reused_exact_generation_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioMeasurement {
    count: usize,
    initial: PhaseMeasurement,
    replacement: PhaseMeasurement,
    backend_replacement: ReplacementMeasurement,
    cleanup_remaining_process_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementMethod {
    process_memory: &'static str,
    settle_window_ms: u64,
    idle_window_ms: u64,
    startup_policy: &'static str,
    replacement_policy: &'static str,
    cleanup_policy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaleReport {
    schema_version: u16,
    provider: &'static str,
    provider_mode: &'static str,
    cli_version: String,
    hardware: HardwareContext,
    method: MeasurementMethod,
    scenarios: Vec<ScenarioMeasurement>,
}

struct PhaseOutcome {
    bindings: Vec<BindingIdentity>,
    descriptors: Vec<SessionDescriptor>,
    measurement: PhaseMeasurement,
    owned_pids: BTreeSet<u32>,
}

#[derive(Clone, Copy)]
struct PhasePolicy {
    stop_after_measurement: bool,
    establish_active_turn: bool,
    expect_active_turn: bool,
}

fn required_executable(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required for this QA test")),
    )
    .canonicalize()
    .unwrap();
    assert!(path.is_file(), "{name} is not a file");
    path
}

fn explicit_real_profile(name: &str, ambient_name: &str) {
    let expected = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required for real Codex QA")),
    )
    .canonicalize()
    .unwrap();
    let ambient = PathBuf::from(
        std::env::var_os(ambient_name)
            .unwrap_or_else(|| panic!("{ambient_name} must match {name} for real Codex QA")),
    )
    .canonicalize()
    .unwrap();
    assert_eq!(ambient, expected, "real Codex QA profile mismatch");
}

pub(super) fn owner_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

async fn seed(store: &SqliteDomainStore, root: &Path, count: usize) {
    seed_provider(store, root, count, "codex").await;
}

pub(super) async fn seed_provider(
    store: &SqliteDomainStore,
    root: &Path,
    count: usize,
    provider: &str,
) {
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new(format!("project-{provider}-runtime-scale")).unwrap(),
            root_path: root.to_string_lossy().into_owned(),
            display_name: "Codex runtime scale".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    for index in 0..count {
        let workspace = root.join(format!("workspace-{index}"));
        fs::create_dir_all(&workspace).unwrap();
        let workspace_id =
            WorkspaceIdV1::new(format!("workspace-{provider}-scale-{index}")).unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id: ProjectIdV1::new(format!("project-{provider}-runtime-scale")).unwrap(),
                root_path: workspace.to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: AgentIdV1::new(format!("agent-{provider}-scale-{index}")).unwrap(),
                workspace_id,
                provider_id: ProviderIdV1::new(provider).unwrap(),
                display_name: format!("Codex runtime scale {index}"),
                created_at_ms: 3,
                updated_at_ms: 3,
            })
            .await
            .unwrap();
    }
}

async fn execution_profile(
    store: &SqliteDomainStore,
    credential_home: &Path,
    credential: Option<&CredentialFixture>,
) -> AgentExecutionProfileV1 {
    let Some(credential) = credential else {
        return AgentExecutionProfileV1::ProviderDefault;
    };
    let provider_id = ProviderIdV1::new("codex").unwrap();
    let profile_path = credential_home
        .join("accounts")
        .join(credential.directory_name.as_str());
    let metadata = fs::symlink_metadata(profile_path).unwrap();
    let registration = ProviderCredentialProfileRegistrationV1 {
        profile: ProviderCredentialProfileV1 {
            schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
            provider_id: provider_id.clone(),
            reference_id: credential.reference_id.clone(),
            credential_generation: credential.generation.clone(),
        },
        profile_directory_name: credential.directory_name.clone(),
        profile_device: metadata.dev(),
        profile_inode: metadata.ino(),
    };
    let existing = store
        .provider_credential_profile(&provider_id, &credential.reference_id)
        .await
        .unwrap();
    store
        .register_provider_credential_profile(
            existing
                .as_ref()
                .map(|existing| existing.profile.credential_generation.as_str()),
            &registration,
        )
        .await
        .unwrap();
    AgentExecutionProfileV1::CredentialReference {
        reference_id: credential.reference_id.clone(),
        credential_generation: Some(credential.generation.clone()),
    }
}

fn live_descriptors(discovery_root: &Path, count: usize) -> Vec<SessionDescriptor> {
    let mut descriptors = LocalSessionCatalog::new(discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| {
            descriptor.provider_id == "codex"
                && probe_local_process_generation(&descriptor.host_process).unwrap()
                    == LocalProcessGenerationStatus::Live
                && probe_local_process_generation(&descriptor.provider_process).unwrap()
                    == LocalProcessGenerationStatus::Live
        })
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    assert_eq!(descriptors.len(), count, "unexpected live Codex topology");
    descriptors
}

fn same_exact_generation(left: &SessionDescriptor, right: &SessionDescriptor) -> bool {
    left.session_id == right.session_id
        && left.workspace_id == right.workspace_id
        && left.host_process.process_id == right.host_process.process_id
        && left.host_process.start_marker == right.host_process.start_marker
        && left.provider_process.process_id == right.provider_process.process_id
        && left.provider_process.start_marker == right.provider_process.start_marker
        && left.host_instance_id == right.host_instance_id
        && left.terminal_epoch == right.terminal_epoch
}

fn phase_totals(roles: &[RoleMeasurement]) -> PhaseTotals {
    PhaseTotals {
        process_count: roles.iter().map(|role| role.process_count).sum(),
        rss_kib: roles.iter().map(|role| role.rss_kib).sum(),
        physical_footprint_kib: sum_optional(roles.iter().map(|role| role.physical_footprint_kib)),
        fd_count: sum_optional(roles.iter().map(|role| role.fd_count)),
        socket_count: sum_optional(roles.iter().map(|role| role.socket_count)),
        idle_cpu_nanos: sum_optional(roles.iter().map(|role| role.idle_cpu_nanos)),
        idle_interrupt_wakeups: sum_optional(roles.iter().map(|role| role.idle_interrupt_wakeups)),
        idle_package_wakeups: sum_optional(roles.iter().map(|role| role.idle_package_wakeups)),
    }
}

fn assert_stable_role(roles: &[RoleMeasurement], role: &str, expected_count: usize) {
    let measurement = roles
        .iter()
        .find(|measurement| measurement.role == role)
        .unwrap_or_else(|| panic!("missing {role} measurement"));
    assert_eq!(measurement.process_count, expected_count);
    assert_eq!(measurement.stable_process_count, expected_count);
    assert_eq!(measurement.started_during_idle_count, 0);
    assert_eq!(measurement.exited_during_idle_count, 0);
}

fn role_process_count(measurement: &PhaseMeasurement, role: &str) -> usize {
    measurement
        .roles
        .iter()
        .find(|measurement| measurement.role == role)
        .map_or(0, |measurement| measurement.process_count)
}

fn wait_for_descriptor_absence(descriptors: &[SessionDescriptor]) {
    let deadline = Instant::now() + PROCESS_WAIT;
    for descriptor in descriptors {
        loop {
            let host = probe_local_process_generation(&descriptor.host_process).unwrap();
            let provider = probe_local_process_generation(&descriptor.provider_process).unwrap();
            if host == LocalProcessGenerationStatus::Absent
                && provider == LocalProcessGenerationStatus::Absent
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Codex exact generation survived explicit cleanup"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

async fn run_phase(
    paths: FixturePaths,
    backend_generation: String,
    count: usize,
    prior_descriptors: Vec<SessionDescriptor>,
    policy: PhasePolicy,
) -> PhaseOutcome {
    let store = Arc::new(SqliteDomainStore::open(&paths.database).await.unwrap());
    seed(&store, &paths.root, count).await;
    let execution_profile =
        execution_profile(&store, &paths.credential_home, paths.credential.as_ref()).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        paths.credential_home.clone(),
        Arc::clone(&store),
    ));
    let configuration = ManagedStructuredRuntimeConfiguration::new(
        backend_generation.clone(),
        ManagedProviderExecutable::new(ManagedProviderKind::Codex, Some(paths.codex.clone())),
        paths.provider_launcher.clone(),
        paths.hmux_runtime.clone(),
        paths.discovery_root.clone(),
        paths.state_root.clone(),
        paths.state_root.clone(),
    )
    .unwrap();
    let manager = ManagedStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&service),
        registry,
        Arc::clone(&store),
    );

    let wall_started = Instant::now();
    let mut open_durations = Vec::with_capacity(count);
    let mut bindings = Vec::with_capacity(count);
    for index in 0..count {
        let started = Instant::now();
        let binding = runtime_scale_launch::open_or_attach(
            &manager,
            AgentIdV1::new(format!("agent-codex-scale-{index}")).unwrap(),
            &execution_profile,
            !prior_descriptors.is_empty(),
        )
        .await
        .expect(&backend_generation);
        open_durations.push(duration_millis(started.elapsed()));
        bindings.push(binding);
    }
    if policy.expect_active_turn {
        assert!(
            bindings
                .iter()
                .all(|binding| binding.provider_conversation_ref.is_some()),
            "an active Codex thread must preserve its provider reference"
        );
    } else {
        assert!(
            bindings
                .iter()
                .all(|binding| binding.provider_conversation_ref.is_none()),
            "an empty Codex thread must remain replaceable until its first turn"
        );
    }
    let open_wall_ms = duration_millis(wall_started.elapsed());
    let descriptors = live_descriptors(&paths.discovery_root, count);
    if !prior_descriptors.is_empty() {
        assert_eq!(prior_descriptors.len(), descriptors.len());
        assert!(prior_descriptors.iter().all(|prior| {
            descriptors
                .iter()
                .any(|current| same_exact_generation(prior, current))
        }));
    }
    thread::sleep(SETTLE_WINDOW);
    let before_roles = runtime_scale_roles::collect(&descriptors);
    let before_pids = role_processes(&before_roles);
    let before = sample_processes(&before_pids);
    thread::sleep(IDLE_WINDOW);
    let after_roles = runtime_scale_roles::collect(&descriptors);
    let after_pids = role_processes(&after_roles);
    let after = sample_processes(&after_pids);
    let roles = measure_roles(&before_roles, &after_roles, &before, &after);
    assert_stable_role(&roles, "hmux_host", count);
    assert_stable_role(&roles, "codex_connection_driver", count);
    assert_stable_role(&roles, "codex_app_server", count);
    let owned_pids = before_pids.union(&after_pids).copied().collect();
    let totals = phase_totals(&roles);
    if policy.expect_active_turn {
        for binding in &bindings {
            let slot = manager
                .slots
                .lock()
                .await
                .get(&binding.interaction_session_id)
                .cloned()
                .unwrap();
            let bridge = Arc::clone(&slot.lock().await.as_ref().unwrap().bridge);
            assert!(
                !bridge.begin_idle_drain().await,
                "the active Codex turn must survive backend replacement"
            );
        }
    }
    if policy.establish_active_turn {
        let binding = bindings[0].clone();
        let slot = manager
            .slots
            .lock()
            .await
            .get(&binding.interaction_session_id)
            .cloned()
            .unwrap();
        let bridge = Arc::clone(&slot.lock().await.as_ref().unwrap().bridge);
        service
            .start_turn(
                bridge.as_ref(),
                &AgentStartTurnIntentV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    runtime: binding.runtime.clone(),
                    turn_id: AgentTurnIdV1::new("turn-codex-scale-first").unwrap(),
                    client_message_id: AgentClientMessageIdV1::new("message-codex-scale-first")
                        .unwrap(),
                    input: "fixture first turn".into(),
                    requested_at_ms: 10,
                },
            )
            .await
            .unwrap();
        let established = service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            established.provider_conversation_ref.is_some(),
            "the first accepted turn must establish the provider conversation"
        );
        bindings[0] = established;
    }
    let binding_identities = bindings
        .iter()
        .map(|binding| BindingIdentity {
            agent_id: binding.agent_id.as_str().into(),
            interaction_session_id: binding.interaction_session_id.as_str().into(),
            provider_conversation_ref: binding.provider_conversation_ref.clone(),
            runtime: binding.runtime.clone(),
        })
        .collect::<Vec<_>>();
    let measurement = PhaseMeasurement {
        backend_generation,
        open_wall_ms,
        open_p50_ms: percentile(&open_durations, 0.50),
        open_p95_ms: percentile(&open_durations, 0.95),
        totals,
        roles,
    };
    if policy.stop_after_measurement {
        for binding in &bindings {
            assert!(manager.stop_binding(binding, false).await.unwrap());
        }
        wait_for_descriptor_absence(&descriptors);
    }
    PhaseOutcome {
        bindings: binding_identities,
        descriptors,
        measurement,
        owned_pids,
    }
}

fn execute_phase(
    paths: FixturePaths,
    backend_generation: String,
    count: usize,
    prior_descriptors: Vec<SessionDescriptor>,
    policy: PhasePolicy,
) -> PhaseOutcome {
    thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_phase(
                paths,
                backend_generation,
                count,
                prior_descriptors,
                policy,
            ))
    })
    .join()
    .unwrap()
}

fn replacement_measurement(
    initial: &PhaseOutcome,
    replacement: &PhaseOutcome,
) -> ReplacementMeasurement {
    let initial_by_agent = initial
        .bindings
        .iter()
        .map(|binding| (binding.agent_id.as_str(), binding))
        .collect::<BTreeMap<_, _>>();
    ReplacementMeasurement {
        interaction_count: initial.bindings.len(),
        preserved_interaction_count: replacement
            .bindings
            .iter()
            .filter(|binding| {
                initial_by_agent
                    .get(binding.agent_id.as_str())
                    .is_some_and(|initial| {
                        initial.interaction_session_id == binding.interaction_session_id
                    })
            })
            .count(),
        preserved_provider_reference_state_count: replacement
            .bindings
            .iter()
            .filter(|binding| {
                initial_by_agent
                    .get(binding.agent_id.as_str())
                    .is_some_and(|initial| {
                        initial.provider_conversation_ref == binding.provider_conversation_ref
                    })
            })
            .count(),
        reused_runtime_fence_count: replacement
            .bindings
            .iter()
            .filter(|binding| {
                initial_by_agent
                    .get(binding.agent_id.as_str())
                    .is_some_and(|initial| initial.runtime == binding.runtime)
            })
            .count(),
        reused_exact_generation_count: initial
            .descriptors
            .iter()
            .filter(|prior| {
                replacement
                    .descriptors
                    .iter()
                    .any(|current| same_exact_generation(prior, current))
            })
            .count(),
    }
}

#[test]
#[ignore = "capacity QA; requires Hmux, provider launcher, and a Codex app-server executable"]
fn initialized_codex_runtime_matrix_1_5_20_reattaches_backend_and_cleans_exactly() {
    let hmux_runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let provider_launcher = required_executable("DURE_PROVIDER_LAUNCHER_BIN");
    let (codex, provider_mode) = match std::env::var_os("DURE_SCALE_CODEX_BIN") {
        Some(_) => (required_executable("DURE_SCALE_CODEX_BIN"), "real"),
        None => (
            required_executable("DURE_CODEX_APP_SERVER_FIXTURE_BIN"),
            "deterministic_fake",
        ),
    };
    if provider_mode == "real" {
        explicit_real_profile("DURE_SCALE_CODEX_HOME", "CODEX_HOME");
        explicit_real_profile("DURE_SCALE_CODEX_SQLITE_HOME", "CODEX_SQLITE_HOME");
    }
    let (credential_home, credential) = if provider_mode == "real" {
        let credential_home = PathBuf::from(
            std::env::var_os("DURE_SCALE_DURE_HOME")
                .expect("DURE_SCALE_DURE_HOME is required for real Codex QA"),
        )
        .canonicalize()
        .unwrap();
        let codex_home = PathBuf::from(std::env::var_os("DURE_SCALE_CODEX_HOME").unwrap())
            .canonicalize()
            .unwrap();
        assert_eq!(
            codex_home.parent(),
            Some(credential_home.join("accounts").as_path())
        );
        let directory_name = ProviderCredentialProfileDirectoryNameV1::new(
            &ProviderIdV1::new("codex").unwrap(),
            codex_home.file_name().unwrap().to_string_lossy(),
        )
        .unwrap();
        let generation = fs::read_to_string(codex_home.join(".dure-profile-generation-v1"))
            .unwrap()
            .trim()
            .to_owned();
        (
            credential_home,
            Some(CredentialFixture {
                directory_name,
                generation,
                reference_id: "scale-hebbian98".into(),
            }),
        )
    } else {
        (PathBuf::new(), None)
    };
    let version = Command::new(&codex).arg("--version").output().unwrap();
    assert!(version.status.success() && version.stderr.is_empty());
    let cli_version = String::from_utf8(version.stdout).unwrap().trim().to_owned();
    let temporary = tempfile::Builder::new()
        .prefix("dcx-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path().to_path_buf();
    let mut scenarios = Vec::new();
    for count in COUNTS {
        let scenario_root = root.join(format!("scenario-{count}"));
        owner_directory(&scenario_root);
        let discovery_root = scenario_root.join("discovery");
        let state_root = scenario_root.join("state");
        owner_directory(&discovery_root);
        owner_directory(&state_root);
        let paths = FixturePaths {
            codex: codex.clone(),
            credential: credential.clone(),
            credential_home: if provider_mode == "real" {
                credential_home.clone()
            } else {
                scenario_root.clone()
            },
            database: scenario_root.join("domain.sqlite3"),
            discovery_root,
            hmux_runtime: hmux_runtime.clone(),
            provider_launcher: provider_launcher.clone(),
            root: scenario_root,
            state_root,
        };
        let initial = execute_phase(
            paths.clone(),
            format!("codex-scale-{count}-initial"),
            count,
            Vec::new(),
            PhasePolicy {
                stop_after_measurement: false,
                establish_active_turn: provider_mode == "deterministic_fake" && count == 1,
                expect_active_turn: false,
            },
        );
        assert!(initial.descriptors.iter().all(|descriptor| {
            probe_local_process_generation(&descriptor.host_process).unwrap()
                == LocalProcessGenerationStatus::Live
                && probe_local_process_generation(&descriptor.provider_process).unwrap()
                    == LocalProcessGenerationStatus::Live
        }));
        let replacement = execute_phase(
            paths,
            format!("codex-scale-{count}-replacement"),
            count,
            initial.descriptors.clone(),
            PhasePolicy {
                stop_after_measurement: true,
                establish_active_turn: false,
                expect_active_turn: provider_mode == "deterministic_fake" && count == 1,
            },
        );
        let backend_replacement = replacement_measurement(&initial, &replacement);
        assert_eq!(backend_replacement.preserved_interaction_count, count);
        assert_eq!(
            backend_replacement.preserved_provider_reference_state_count,
            count
        );
        assert_eq!(backend_replacement.reused_runtime_fence_count, count);
        assert_eq!(backend_replacement.reused_exact_generation_count, count);
        assert_eq!(
            role_process_count(&replacement.measurement, "codex_descendant"),
            role_process_count(&initial.measurement, "codex_descendant"),
            "backend replacement must not initialize a second Codex child set"
        );
        let all_owned = initial
            .owned_pids
            .union(&replacement.owned_pids)
            .copied()
            .collect::<BTreeSet<_>>();
        wait_for_process_absence(&all_owned, PROCESS_WAIT);
        scenarios.push(ScenarioMeasurement {
            count,
            initial: initial.measurement,
            replacement: replacement.measurement,
            backend_replacement,
            cleanup_remaining_process_count: 0,
        });
    }
    let report = ScaleReport {
        schema_version: 1,
        provider: "codex",
        provider_mode,
        cli_version,
        hardware: hardware_context(),
        method: MeasurementMethod {
            process_memory: process_memory_method(),
            settle_window_ms: SETTLE_WINDOW.as_millis() as u64,
            idle_window_ms: IDLE_WINDOW.as_millis() as u64,
            startup_policy: "serial structured opens; every Hmux-owned connection driver and initialized app-server remains live for the simultaneous sample",
            replacement_policy: "drop one complete backend Tokio runtime, then reconnect every durable interaction to its exact Hmux-owned connection-driver generation without reinitializing the app-server",
            cleanup_policy: "provider manager exact-stop receipts followed by numeric absence of every observed QA PID",
        },
        scenarios,
    };
    println!(
        "structured_chat_runtime_scale={}",
        serde_json::to_string(&report).unwrap()
    );
}
