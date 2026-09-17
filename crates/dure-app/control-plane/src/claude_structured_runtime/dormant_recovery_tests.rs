use super::*;
use dure_app::{
    AgentIdV1, AgentRecordV1, AgentRuntimeTransitionAdvanceRequestV1,
    AgentRuntimeTransitionAdvanceV1, AgentRuntimeTransitionIntentV1, AgentTimelineEpochV1,
    OperationIdV1, ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use tempfile::TempDir;

use crate::agent_conversation_api::AgentConversationRuntimeRegistry;
use crate::claude_sdk_host_client::{
    ClaudeDch1HostIdentity, ClaudeDch1ProviderRetirementAuthority,
    ClaudeDch1ProviderRetirementPhase,
};
use crate::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;

#[tokio::test]
async fn dormant_structured_binding_rotates_only_for_the_exact_native_successor() {
    let root = TempDir::new().unwrap();
    let runtime_state = TempDir::new_in("/tmp").unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
    let runtime_state_root = runtime_state.path().to_path_buf();
    let host_state_root = root.path().join("host-state");
    let host_runtime_root = root.path().join("host-runtime");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();

    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-crash-cut").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-crash-cut").unwrap();
    let agent_id = AgentIdV1::new("agent-crash-cut").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Crash cut".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 20,
            updated_at_ms: 20,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Claude".into(),
            created_at_ms: 30,
            updated_at_ms: 30,
        })
        .await
        .unwrap();

    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-crash-cut").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-crash-cut".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-crash-cut".into(),
            provider_epoch: "query-crash-cut".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-crash-cut").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 40,
        updated_at_ms: 40,
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 40,
    };
    store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let transition = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("transition-crash-cut").unwrap(),
            idempotency_key: "transition-crash-cut-key".into(),
            source: selection,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-crash-cut",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 50,
        })
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: transition.intent.operation_id.clone(),
            expected_journal_revision: transition.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 60,
        })
        .await
        .unwrap();

    let executable = std::env::current_exe().unwrap();
    let configuration = ClaudeStructuredRuntimeConfiguration {
        backend_generation: "backend-crash-cut".into(),
        hmux_runtime: executable.clone(),
        discovery_root,
        relay_executable: executable.clone(),
        address_root: runtime_state_root.clone(),
        state_root: runtime_state_root,
        environment: BTreeMap::new(),
    };
    let runtime_registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        &executable,
        &executable,
        &host_state_root,
        &host_runtime_root,
        "host-crash-cut",
        Vec::new(),
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            "client-crash-cut",
            Arc::clone(&conversation_service),
            runtime_registry,
        )
        .unwrap(),
    );
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

    let mut stale_stop = binding.clone();
    stale_stop.runtime.provider_epoch = "query-stale-stop".into();
    assert_eq!(
        manager.stop_terminal(&stale_stop).await.unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::RuntimeConflict,
    );
    assert_eq!(
        manager.stop_terminal(&binding).await.unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::StopFailed,
        "an exact failed-target close cannot treat a missing journal as released",
    );
    assert!(
        manager
            .read_runtime(&binding, workspace_id.as_str(), &workspace)
            .unwrap()
            .is_none(),
        "an epoch-mismatched close authority must be rejected before runtime cleanup",
    );

    let mut prepared = manager
        .create_runtime(&binding, workspace_id.as_str(), &workspace, None)
        .unwrap();
    prepared.journal.stopped();
    write_journal(&prepared.files.runtime_directory, &prepared.journal).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_slice(
        &fs::read(prepared.files.runtime_directory.join("launch.json")).unwrap(),
    )
    .unwrap();
    legacy["schemaVersion"] = 4.into();
    legacy["retainRetirementFence"] = false.into();
    fs::write(
        prepared.files.runtime_directory.join("launch.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let mut replacement_binding = binding.clone();
    replacement_binding.runtime = replacement_runtime(
        &binding.interaction_session_id,
        &binding.runtime,
        &configuration.backend_generation,
    );
    replacement_binding.binding_revision += 1;
    let replacement_directory = runtime_files(&configuration, &replacement_binding)
        .unwrap()
        .runtime_directory;

    let result = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("conversation-crash-cut".into()),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await;

    assert_eq!(
        conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone()),
    );
    assert!(!replacement_directory.exists());
    assert!(
        result.is_err(),
        "ordinary open must not rotate dormant state"
    );

    let mut direct_stop = prepared.journal.clone();
    direct_stop.set_retirement_authority(ClaudeDch1ProviderRetirementAuthority {
        source: direct_stop.query_identity(),
        allowed_target: None,
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-direct-stop".into(),
            host_instance_id: "instance-direct-stop".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Released,
    });
    write_journal(&prepared.files.runtime_directory, &direct_stop).unwrap();

    let corrected_request = ClaudeStructuredOpenRequestV1 {
        agent_id: binding.agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-b".into(),
            credential_generation: Some("credential-b-1".into()),
        },
        provider_conversation_ref: binding.provider_conversation_ref.clone(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let operation_id = OperationIdV1::new("native-b-to-structured-b").unwrap();
    let context = manager
        .runtime_context(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    let corrected = manager
        .replace_stopped_target(&context, &binding, &corrected_request, &operation_id)
        .await
        .unwrap();
    assert_eq!(
        corrected.interaction_session_id,
        binding.interaction_session_id
    );
    assert_eq!(corrected.binding_revision, binding.binding_revision + 1);
    assert_eq!(
        corrected.execution_profile,
        corrected_request.execution_profile
    );
    let target = manager
        .read_runtime(&corrected, workspace_id.as_str(), &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(target.journal.state(), ClaudeRuntimeLaunchStateV1::Prepared);
    assert_eq!(target.journal.replaces(), None);
    assert_eq!(target.journal.provider_predecessor(), None);

    let replay_context = manager
        .runtime_context(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        manager
            .replace_stopped_target(&replay_context, &binding, &corrected_request, &operation_id,)
            .await
            .unwrap(),
        corrected,
        "the durable operation may observe its one exact replacement"
    );

    let source_identity = prepared.journal.query_identity();
    let target_identity = target.journal.query_identity();
    let mut attached_target = target;
    attached_target.journal.attached(std::process::id());
    let mut target_value = serde_json::to_value(&attached_target.journal).unwrap();
    target_value["replaces"] = serde_json::to_value(&source_identity).unwrap();
    fs::write(
        attached_target.files.runtime_directory.join("launch.json"),
        serde_json::to_vec(&target_value).unwrap(),
    )
    .unwrap();
    let mut authority = ClaudeDch1ProviderRetirementAuthority {
        source: source_identity.clone(),
        allowed_target: Some(target_identity.clone()),
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-finalize-source".into(),
            host_instance_id: "instance-finalize-source".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Retired,
    };
    for phase in [
        ClaudeDch1ProviderRetirementPhase::Retired,
        ClaudeDch1ProviderRetirementPhase::TargetBound,
        ClaudeDch1ProviderRetirementPhase::Released,
    ] {
        authority.phase = phase;
        authority.target_host =
            (phase != ClaudeDch1ProviderRetirementPhase::Retired).then(|| ClaudeDch1HostIdentity {
                host_generation: "host-finalize-target".into(),
                host_instance_id: "instance-finalize-target".into(),
            });
        let mut source_journal = read_journal(&prepared.files.runtime_directory).unwrap();
        source_journal.set_retirement_authority(authority.clone());
        write_journal(&prepared.files.runtime_directory, &source_journal).unwrap();
        let replay_context = manager
            .runtime_context(&binding.interaction_session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            manager
                .replace_stopped_target(
                    &replay_context,
                    &binding,
                    &corrected_request,
                    &operation_id,
                )
                .await
                .unwrap(),
            corrected,
            "an Attached finalize retry must preserve the exact target at {phase:?}",
        );
    }
    attached_target.journal.consume_provider_predecessor();
    write_journal(
        &attached_target.files.runtime_directory,
        &attached_target.journal,
    )
    .unwrap();
    let replay_context = manager
        .runtime_context(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        manager
            .replace_stopped_target(&replay_context, &binding, &corrected_request, &operation_id,)
            .await
            .unwrap(),
        corrected,
        "Released also admits the durable target-journal consume cut",
    );
}
