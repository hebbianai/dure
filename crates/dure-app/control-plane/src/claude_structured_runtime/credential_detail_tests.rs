use super::*;
use dure_app::{
    AgentIdV1, AgentRecordV1, ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use tempfile::TempDir;

use crate::agent_conversation_api::AgentConversationRuntimeRegistry;
use crate::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime,
    StructuredProviderRuntimeErrorKindV1,
};

/// A Run whose account cannot be prepared stops at structured launch. The
/// failure reaching the spawn journal names the account and what was missing,
/// not only `claude_conversation_credential_unavailable`.
#[tokio::test]
async fn an_unavailable_account_reaches_the_spawn_boundary_with_what_was_missing() {
    let root = TempDir::new().unwrap();
    let runtime_state = TempDir::new_in("/tmp").unwrap();
    let workspace = root.path().join("workspace");
    let discovery_root = root.path().join("discovery");
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
    let project_id = ProjectIdV1::new("project-credential-detail").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-credential-detail").unwrap();
    let agent_id = AgentIdV1::new("agent-credential-detail").unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Credential detail".into(),
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
            workspace_id,
            provider_id: ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap(),
            display_name: "Claude".into(),
            created_at_ms: 30,
            updated_at_ms: 30,
        })
        .await
        .unwrap();

    let executable = std::env::current_exe().unwrap();
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &executable,
                &executable,
                &host_state_root,
                &host_runtime_root,
                "host-credential-detail",
                Vec::new(),
            )
            .unwrap(),
            "client-credential-detail",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let manager = ClaudeStructuredRuntimeManager::new(
        ClaudeStructuredRuntimeConfiguration {
            backend_generation: "backend-credential-detail".into(),
            hmux_runtime: executable.clone(),
            discovery_root,
            relay_executable: executable,
            address_root: runtime_state.path().to_path_buf(),
            state_root: runtime_state.path().to_path_buf(),
            environment: BTreeMap::new(),
        },
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&conversation_service),
        host,
        Arc::clone(&store),
    );

    let error = StructuredProviderRuntime::open(
        &manager,
        StructuredProviderOpenRequestV1 {
            agent_id,
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "acc-unregistered".into(),
                credential_generation: Some("credential-v1-unregistered".into()),
            },
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        },
    )
    .await
    .unwrap_err();

    assert_eq!(
        error.kind,
        StructuredProviderRuntimeErrorKindV1::CredentialUnavailable
    );
    assert_eq!(error.code, "claude_conversation_credential_unavailable");
    let detail = error.detail.expect("the refusal says what was missing");
    assert!(
        detail.contains("claude account acc-unregistered is not registered on this backend"),
        "{detail}"
    );
    assert!(!detail.contains(root.path().to_str().unwrap()), "{detail}");
}
