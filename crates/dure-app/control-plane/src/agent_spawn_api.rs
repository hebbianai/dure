use dure_app::{
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentIdV1, AgentProviderRegistry,
    AgentProviderStructuredSessionRequestV1, AgentRecordV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeSelectionV1, AgentSpawnAuthorityV1, AgentSpawnExistingWorkspaceAuthorityV1,
    AgentSpawnInteractionPreferenceV1, AgentSpawnJournalReceiptV1, AgentSpawnJournalStore,
    AgentSpawnLaunchPlanV1, AgentSpawnPlanIntentDraftV1, AgentSpawnPreviewIntentV1,
    AgentSpawnRuntimePlanV1, AgentSpawnSourceRuntimeAuthorityV1,
    AgentSpawnSourceSelectionAuthorityV1, CapabilityIdV1, DomainStoreErrorV1, OperationEventIdV1,
    OperationIdV1, ProjectIdV1, RuntimeKindIdV1, WorkspaceIdV1, WorkspaceRecordV1,
    validate_agent_spawn_plan_intent_v1,
};
use dure_app_sqlite::SqliteDomainStore;
use serde::Deserialize;

mod replay;
use replay::reconcile_existing;

use crate::agent_spawn_support::{random_nonce, store_error};
use crate::project_catalog::ProjectProjection;

const LOCAL_HMUX_RUNTIME_KIND: &str = "runtime.hmux";
const RUNTIME_REQUIRED_CAPABILITIES: [&str; 2] = ["provider-launch", "session-create"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSpawnStatusBody {
    pub(crate) schema_version: u16,
    #[serde(default)]
    pub(crate) operation_id: Option<OperationIdV1>,
    #[serde(default)]
    pub(crate) idempotency_key: Option<String>,
}

#[derive(Clone)]
struct PlanIdentities {
    operation_id: OperationIdV1,
    agent_id: AgentIdV1,
    workspace_id: WorkspaceIdV1,
    session_id: String,
}

#[derive(Clone, Copy)]
enum WorktreeBaseReconciliation {
    Exact,
    ServiceResolved,
}

struct PreviewInput<'a> {
    backend_id: &'a str,
    backend_generation: &'a str,
    project: ProjectProjection,
    request: AgentSpawnPreviewIntentV1,
    worktree_base_reconciliation: WorktreeBaseReconciliation,
    recorded_at_ms: i64,
}

pub(crate) fn runtime_kind_id() -> RuntimeKindIdV1 {
    RuntimeKindIdV1::new(LOCAL_HMUX_RUNTIME_KIND).expect("static runtime kind is valid")
}

pub(crate) fn existing_workspace_authority(
    source_agent: &AgentRecordV1,
    workspace: &WorkspaceRecordV1,
    runtime_selection: &AgentRuntimeSelectionV1,
    runtime_binding: &AgentRuntimeBindingAuthorityV1,
) -> Result<AgentSpawnExistingWorkspaceAuthorityV1, String> {
    source_agent
        .validate()
        .map_err(|_| "agent_spawn_source_authority_mismatch".to_string())?;
    workspace
        .validate()
        .map_err(|_| "agent_spawn_source_authority_mismatch".to_string())?;
    runtime_binding
        .validate_for_selection(runtime_selection)
        .map_err(|_| "agent_spawn_source_authority_mismatch".to_string())?;
    if source_agent.workspace_id != workspace.workspace_id
        || source_agent.agent_id != runtime_selection.agent_id
        || source_agent.provider_id != runtime_selection.provider_id
    {
        return Err("agent_spawn_source_authority_mismatch".into());
    }
    let authority = AgentSpawnExistingWorkspaceAuthorityV1 {
        source_agent_id: source_agent.agent_id.clone(),
        workspace_id: workspace.workspace_id.clone(),
        project_id: workspace.project_id.clone(),
        provider_id: source_agent.provider_id.clone(),
        workspace_root: workspace.root_path.clone(),
        workspace_base_commit_sha: workspace.base_commit_sha.clone(),
        runtime_selection: AgentSpawnSourceSelectionAuthorityV1::from_selection(runtime_selection),
        runtime_binding: AgentSpawnSourceRuntimeAuthorityV1::from_authority(runtime_binding),
    };
    authority
        .validate()
        .map_err(|_| "agent_spawn_source_authority_mismatch".to_string())?;
    Ok(authority)
}

pub(crate) async fn preview(
    store: &SqliteDomainStore,
    agent_providers: &AgentProviderRegistry,
    backend_id: &str,
    backend_generation: &str,
    project: ProjectProjection,
    request: AgentSpawnPreviewIntentV1,
    recorded_at_ms: i64,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    preview_inner(
        store,
        agent_providers,
        PreviewInput {
            backend_id,
            backend_generation,
            project,
            request,
            worktree_base_reconciliation: WorktreeBaseReconciliation::Exact,
            recorded_at_ms,
        },
    )
    .await
}

pub(crate) async fn preview_with_service_resolved_base(
    store: &SqliteDomainStore,
    agent_providers: &AgentProviderRegistry,
    backend_id: &str,
    backend_generation: &str,
    project: ProjectProjection,
    request: AgentSpawnPreviewIntentV1,
    recorded_at_ms: i64,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    preview_inner(
        store,
        agent_providers,
        PreviewInput {
            backend_id,
            backend_generation,
            project,
            request,
            worktree_base_reconciliation: WorktreeBaseReconciliation::ServiceResolved,
            recorded_at_ms,
        },
    )
    .await
}

async fn preview_inner(
    store: &SqliteDomainStore,
    agent_providers: &AgentProviderRegistry,
    input: PreviewInput<'_>,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    let PreviewInput {
        backend_id,
        backend_generation,
        project,
        request,
        worktree_base_reconciliation,
        recorded_at_ms,
    } = input;
    let authority = spawn_authority(backend_id, backend_generation, project)?;
    let runtime = spawn_runtime_plan();

    // Validate the entire caller-owned contract before touching the journal.
    validate_agent_spawn_plan_intent_v1(&build_intent_draft(
        authority.clone(),
        request.clone(),
        PlanIdentities {
            operation_id: OperationIdV1::new("spawn-validation").expect("static ID is valid"),
            agent_id: AgentIdV1::new("agent-validation").expect("static ID is valid"),
            workspace_id: workspace_id_for_policy(
                &request.worktree,
                WorkspaceIdV1::new("workspace-validation").expect("static ID is valid"),
            ),
            session_id: "session-validation".into(),
        },
        runtime.clone(),
    ))
    .map_err(|_| "agent_spawn_plan_invalid".to_string())?;

    if let Some(existing) = store
        .agent_spawn_receipt_by_idempotency_key(&request.idempotency_key)
        .await
        .map_err(store_error)?
    {
        return reconcile_existing(
            existing,
            authority,
            request,
            runtime,
            worktree_base_reconciliation,
        );
    }

    let nonce = random_nonce()?;
    let draft = build_intent_draft(
        authority.clone(),
        request.clone(),
        PlanIdentities {
            operation_id: OperationIdV1::new(format!("spawn-{nonce}"))
                .map_err(|_| "agent_spawn_plan_invalid".to_string())?,
            agent_id: AgentIdV1::new(format!("agent-{nonce}"))
                .map_err(|_| "agent_spawn_plan_invalid".to_string())?,
            workspace_id: workspace_id_for_policy(
                &request.worktree,
                WorkspaceIdV1::new(format!("workspace-{nonce}"))
                    .map_err(|_| "agent_spawn_plan_invalid".to_string())?,
            ),
            session_id: format!("session-{nonce}"),
        },
        runtime.clone(),
    );
    let event_id = OperationEventIdV1::new(format!("spawn-event-{nonce}"))
        .map_err(|_| "agent_spawn_plan_invalid".to_string())?;
    match store
        .append_agent_spawn_plan_resolving_provider_defaults(
            draft,
            event_id,
            recorded_at_ms,
            |plan| match if plan.request.interaction_preference
                == Some(AgentSpawnInteractionPreferenceV1::NativeCli)
            {
                // Caller pinned the PTY surface (basic interface mode) — do
                // not consult the structured session plan at all.
                Ok(None)
            } else {
                agent_providers.structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                    provider_id: &plan.request.provider_id,
                    execution_profile: &plan.request.execution_profile,
                    permission_mode: &plan.request.permission_mode,
                    model: plan.request.model.as_ref(),
                    effort: plan.request.effort.as_ref(),
                    has_setup_command: plan.request.setup_command.is_some(),
                    provider_conversation_ref: &plan.request.provider_conversation_ref,
                })
            } {
                Ok(Some(_)) => plan
                    .with_launch(AgentSpawnLaunchPlanV1::StructuredProtocol)
                    .map_err(|_| DomainStoreErrorV1::InvalidRecord {
                        field: "agentSpawnPlan",
                        reason: "structured launch selection is invalid".into(),
                    }),
                Ok(None) => match agent_providers.launch_plan(
                    &plan.request.provider_id,
                    &plan.request.permission_mode,
                    plan.request.model.as_ref(),
                    plan.request.effort.as_ref(),
                    plan.request.provider_conversation_ref.as_option(),
                ) {
                    Ok(Some(_)) => Ok(plan),
                    Ok(None) => Err(DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected {
                        code: "agent_spawn_provider_unavailable",
                    }),
                    Err(_) => Err(DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected {
                        code: "agent_spawn_provider_preflight_failed",
                    }),
                },
                Err(_) => Err(DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected {
                    code: "agent_spawn_provider_preflight_failed",
                }),
            },
        )
        .await
    {
        Ok(receipt) => Ok(receipt),
        Err(DomainStoreErrorV1::IdempotencyConflict { .. }) => {
            let existing = store
                .agent_spawn_receipt_by_idempotency_key(&request.idempotency_key)
                .await
                .map_err(store_error)?
                .ok_or_else(|| "agent_spawn_idempotency_conflict".to_string())?;
            reconcile_existing(
                existing,
                authority,
                request,
                runtime,
                worktree_base_reconciliation,
            )
        }
        Err(error) => Err(store_error(error)),
    }
}

pub(crate) async fn status(
    store: &SqliteDomainStore,
    body: AgentSpawnStatusBody,
) -> Result<Option<AgentSpawnJournalReceiptV1>, String> {
    if body.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
        || body.operation_id.is_some() == body.idempotency_key.is_some()
    {
        return Err("agent_spawn_status_request_invalid".into());
    }
    if let Some(operation_id) = body.operation_id {
        return store
            .agent_spawn_receipt(&operation_id)
            .await
            .map_err(store_error);
    }
    let idempotency_key = body
        .idempotency_key
        .ok_or_else(|| "agent_spawn_status_request_invalid".to_string())?;
    if !valid_token(&idempotency_key) {
        return Err("agent_spawn_status_request_invalid".into());
    }
    store
        .agent_spawn_receipt_by_idempotency_key(&idempotency_key)
        .await
        .map_err(store_error)
}

fn spawn_authority(
    backend_id: &str,
    backend_generation: &str,
    project: ProjectProjection,
) -> Result<AgentSpawnAuthorityV1, String> {
    Ok(AgentSpawnAuthorityV1 {
        backend_id: backend_id.into(),
        backend_generation: backend_generation.into(),
        project_id: ProjectIdV1::new(project.id)
            .map_err(|_| "agent_spawn_project_invalid".to_string())?,
        root_id: project.root_id,
        repository_id: project.repository_id,
    })
}

fn spawn_runtime_plan() -> AgentSpawnRuntimePlanV1 {
    AgentSpawnRuntimePlanV1 {
        runtime_kind_id: runtime_kind_id(),
        required_capabilities: RUNTIME_REQUIRED_CAPABILITIES
            .into_iter()
            .map(|capability| {
                CapabilityIdV1::new(capability).expect("static capability ID is valid")
            })
            .collect(),
    }
}

fn workspace_id_for_policy(
    policy: &dure_app::AgentSpawnWorktreePolicyV1,
    allocated: WorkspaceIdV1,
) -> WorkspaceIdV1 {
    match policy {
        dure_app::AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => {
            source.workspace_id.clone()
        }
        _ => allocated,
    }
}

fn build_intent_draft(
    authority: AgentSpawnAuthorityV1,
    request: AgentSpawnPreviewIntentV1,
    identities: PlanIdentities,
    runtime: AgentSpawnRuntimePlanV1,
) -> AgentSpawnPlanIntentDraftV1 {
    AgentSpawnPlanIntentDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: identities.operation_id,
        authority,
        request,
        agent_id: identities.agent_id,
        workspace_id: identities.workspace_id,
        launch: AgentSpawnLaunchPlanV1::NativeCli {
            session_id: identities.session_id,
            runtime,
        },
    }
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
mod tests {
    mod destination_tests;
    use std::collections::BTreeMap;

    use dure_app::{
        AgentExecutionProfileV1, AgentInteractionBindingV1, AgentInteractionProfileV1,
        AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentSpawnEffortSelectionV1,
        AgentSpawnModelSelectionV1, AgentSpawnPermissionModeV1, AgentSpawnPromptDigestV1,
        AgentSpawnWorktreePolicyV1, AgentTimelineEpochV1,
        PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProviderIdV1, ProviderLaunchDefaultV1,
        ProviderLaunchDefaultsPutRequestV1, ProviderLaunchPermissionModeV1,
        ProviderLaunchPermissionOverrideV1, ProviderPermissionModeV1,
    };

    use super::*;

    fn project() -> ProjectProjection {
        ProjectProjection {
            id: "dure".into(),
            display_name: "Dure".into(),
            root_id: "root_0123456789abcdef0123456789abcdef".into(),
            repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
        }
    }

    fn request(agent_name: &str) -> AgentSpawnPreviewIntentV1 {
        AgentSpawnPreviewIntentV1 {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            idempotency_key: "spawn-request-1".into(),
            project_id: ProjectIdV1::new("dure").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: agent_name.into(),
            worktree: AgentSpawnWorktreePolicyV1::ProjectRoot,
            provider_conversation_ref: Default::default(),
            permission_override: None,
            prompt_digest: Some(AgentSpawnPromptDigestV1::sha256("private prompt")),
            setup_command: None,
            model: None,
            effort: None,
            interaction_preference: None,
        }
    }

    fn dedicated_request(base_commit_sha: &str, branch: &str) -> AgentSpawnPreviewIntentV1 {
        let mut request = request("codex-1");
        request.worktree = AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha: base_commit_sha.into(),
            branch: branch.into(),
            branch_mode: Default::default(),
            checkout_path: None,
        };
        request
    }

    fn structured_source_authority_fixture() -> (
        AgentRecordV1,
        WorkspaceRecordV1,
        AgentRuntimeSelectionV1,
        AgentInteractionBindingV1,
    ) {
        let agent_id = AgentIdV1::new("agent-source").unwrap();
        let workspace_id = WorkspaceIdV1::new("workspace-source").unwrap();
        let provider_id = ProviderIdV1::new("claude").unwrap();
        (
            AgentRecordV1 {
                agent_id: agent_id.clone(),
                workspace_id: workspace_id.clone(),
                provider_id: provider_id.clone(),
                display_name: "Source".into(),
                created_at_ms: 1,
                updated_at_ms: 2,
            },
            WorkspaceRecordV1 {
                workspace_id,
                project_id: ProjectIdV1::new("dure").unwrap(),
                root_path: "/repo/.worktrees/source".into(),
                base_commit_sha: Some("a".repeat(40)),
                created_at_ms: 1,
                updated_at_ms: 2,
            },
            AgentRuntimeSelectionV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                provider_id: provider_id.clone(),
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                permission_mode: ProviderPermissionModeV1::Default,
                model: None,
                effort: None,
                revision: 4,
                selected_by_operation_id: Some(OperationIdV1::new("transition-source").unwrap()),
                updated_at_ms: 2,
            },
            AgentInteractionBindingV1 {
                schema_version: 1,
                interaction_session_id: AgentInteractionSessionIdV1::new("interaction-source")
                    .unwrap(),
                agent_id,
                provider_id,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                provider_conversation_ref: Some("conversation-source".into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime-source".into(),
                    provider_epoch: "provider-source".into(),
                },
                timeline_epoch: AgentTimelineEpochV1::new("timeline-source").unwrap(),
                binding_revision: 3,
                history_complete: true,
                created_at_ms: 1,
                updated_at_ms: 2,
            },
        )
    }

    #[test]
    fn existing_workspace_authority_ignores_record_clones_renames_and_observation_metadata() {
        let (agent, workspace, selection, binding) = structured_source_authority_fixture();
        let expected = existing_workspace_authority(
            &agent,
            &workspace,
            &selection,
            &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
        )
        .unwrap();
        let mut renamed = agent.clone();
        renamed.display_name = "Renamed".into();
        renamed.updated_at_ms = 9;
        let mut observed_workspace = workspace.clone();
        observed_workspace.updated_at_ms = 9;
        let mut observed_binding = binding;
        observed_binding.history_complete = false;
        observed_binding.updated_at_ms = 9;

        assert_eq!(
            existing_workspace_authority(
                &renamed,
                &observed_workspace,
                &selection,
                &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: observed_binding,
                },
            )
            .unwrap(),
            expected
        );
    }

    #[test]
    fn existing_workspace_authority_fences_workspace_selection_and_runtime_identity() {
        let (agent, workspace, selection, binding) = structured_source_authority_fixture();
        let expected = existing_workspace_authority(
            &agent,
            &workspace,
            &selection,
            &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
        )
        .unwrap();

        let mut changed_workspace = workspace.clone();
        changed_workspace.root_path = "/repo/.worktrees/other".into();
        assert_ne!(
            existing_workspace_authority(
                &agent,
                &changed_workspace,
                &selection,
                &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: binding.clone(),
                },
            )
            .unwrap(),
            expected
        );

        let mut changed_selection = selection.clone();
        changed_selection.revision += 1;
        assert_ne!(
            existing_workspace_authority(
                &agent,
                &workspace,
                &changed_selection,
                &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: binding.clone(),
                },
            )
            .unwrap(),
            expected
        );

        let mut changed_binding = binding;
        changed_binding.runtime.runtime_generation = "runtime-other".into();
        assert_ne!(
            existing_workspace_authority(
                &agent,
                &workspace,
                &selection,
                &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: changed_binding,
                },
            )
            .unwrap(),
            expected
        );
    }

    #[tokio::test]
    async fn registered_codex_app_server_makes_default_new_agents_chat_first() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_codex_structured_agent_provider_registry();
        let receipt = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            request("codex-chat-1"),
            1,
        )
        .await
        .unwrap();
        assert!(matches!(
            receipt.plan.launch,
            AgentSpawnLaunchPlanV1::StructuredProtocol
        ));
    }

    #[tokio::test]
    async fn native_pi_and_kimi_preview_commit_before_any_runtime_effect() {
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        for provider in ["pi", "kimi"] {
            let root = tempfile::tempdir().unwrap();
            let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
                .await
                .unwrap();
            let mut intent = request(&format!("{provider}-native"));
            intent.idempotency_key = format!("spawn-{provider}-native");
            intent.provider_id = ProviderIdV1::new(provider).unwrap();

            let receipt = preview(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                intent,
                1,
            )
            .await
            .unwrap();

            assert!(matches!(
                receipt.plan.launch,
                AgentSpawnLaunchPlanV1::NativeCli { .. }
            ));
            assert!(receipt.completed.is_empty());
        }
    }

    #[tokio::test]
    async fn structured_claude_keeps_supported_launch_selections_before_apply_side_effects() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let mut intent = request("claude-chat-1");
        intent.idempotency_key = "spawn-claude-chat-1".into();
        intent.provider_id = ProviderIdV1::new("claude").unwrap();
        intent.permission_override = Some(ProviderLaunchPermissionOverrideV1::BypassApprovals);
        intent.prompt_digest = None;
        intent.model = Some(AgentSpawnModelSelectionV1::parse("opus").unwrap());
        intent.effort = Some(AgentSpawnEffortSelectionV1::parse("high").unwrap());

        let receipt = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            intent,
            1,
        )
        .await
        .unwrap();
        let plan = serde_json::to_value(&receipt.plan).unwrap();

        assert_eq!(
            plan.pointer("/launch/interactionProfile")
                .and_then(serde_json::Value::as_str),
            Some("structured_protocol")
        );
        assert_eq!(
            receipt.plan.request.permission_mode,
            AgentSpawnPermissionModeV1::SkipPermissions
        );
        assert_eq!(
            receipt.plan.request.model.as_ref().unwrap().as_str(),
            "opus"
        );
        assert_eq!(
            receipt.plan.request.effort.as_ref().unwrap().as_str(),
            "high"
        );
        assert!(plan.get("sessionId").is_none());
        assert!(receipt.completed.is_empty());
    }

    #[tokio::test]
    async fn structured_preview_preserves_an_explicit_auto_edit_override() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let mut intent = request("claude-auto-edit");
        intent.idempotency_key = "spawn-claude-auto-edit".into();
        intent.provider_id = ProviderIdV1::new("claude").unwrap();
        intent.permission_override = Some(ProviderLaunchPermissionOverrideV1::AutoEdit);
        intent.prompt_digest = None;

        let receipt = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            intent,
            1,
        )
        .await
        .unwrap();

        assert_eq!(
            receipt.plan.request.permission_mode,
            AgentSpawnPermissionModeV1::AutoEdit
        );
        assert_eq!(
            receipt
                .plan
                .provider_launch_defaults
                .as_ref()
                .and_then(|resolution| resolution.permission_override),
            Some(ProviderLaunchPermissionOverrideV1::AutoEdit)
        );
    }

    #[tokio::test]
    async fn structured_claude_passes_unlisted_effort_tokens_through_the_spawn() {
        // The provider runtime owns which efforts exist and downgrades
        // unsupported levels itself; a shape-valid token the local list never
        // heard of still previews, carrying the token verbatim.
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let mut intent = request("claude-chat-unlisted-effort");
        intent.idempotency_key = "spawn-claude-chat-unlisted-effort".into();
        intent.provider_id = ProviderIdV1::new("claude").unwrap();
        intent.effort = Some(AgentSpawnEffortSelectionV1::parse("ultra").unwrap());

        let receipt = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            intent,
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            receipt.plan.request.effort.as_ref().unwrap().as_str(),
            "ultra"
        );
    }

    #[tokio::test]
    async fn concurrent_identical_preview_converges_and_divergence_mutates_nothing() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let first = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            request("codex-1"),
            1,
        );
        let second = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            request("codex-1"),
            2,
        );
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.plan.request.permission_mode,
            AgentSpawnPermissionModeV1::Default
        );
        assert_eq!(
            first
                .plan
                .provider_launch_defaults
                .as_ref()
                .unwrap()
                .revision,
            0
        );

        let successor = preview(
            &store,
            &providers,
            "dure-local",
            "generation-2",
            project(),
            request("codex-1"),
            3,
        )
        .await
        .unwrap();
        assert_eq!(successor, first);

        assert_eq!(
            preview(
                &store,
                &providers,
                "different-backend",
                "generation-2",
                project(),
                request("codex-1"),
                4,
            )
            .await
            .unwrap_err(),
            "agent_spawn_idempotency_conflict"
        );

        assert_eq!(
            preview(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                request("codex-2"),
                5,
            )
            .await
            .unwrap_err(),
            "agent_spawn_idempotency_conflict"
        );
        let stored = status(
            &store,
            AgentSpawnStatusBody {
                schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
                operation_id: None,
                idempotency_key: Some("spawn-request-1".into()),
            },
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stored, first);
    }

    #[tokio::test]
    async fn launch_selection_divergence_is_an_idempotency_conflict() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let mut selected = request("codex-1");
        selected.model = Some(AgentSpawnModelSelectionV1::parse("opus").unwrap());
        let first = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            selected.clone(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(first.plan.request.model, selected.model);

        let mut other = request("codex-1");
        other.model = Some(AgentSpawnModelSelectionV1::parse("sonnet").unwrap());
        let mut other_effort = selected.clone();
        other_effort.effort = Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap());
        for divergent in [request("codex-1"), other, other_effort] {
            assert_eq!(
                preview(
                    &store,
                    &providers,
                    "dure-local",
                    "generation-1",
                    project(),
                    divergent,
                    2,
                )
                .await
                .unwrap_err(),
                "agent_spawn_idempotency_conflict"
            );
        }

        let replay = preview(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            selected,
            3,
        )
        .await
        .unwrap();
        assert_eq!(replay, first);
    }

    #[tokio::test]
    async fn inherited_bypass_uses_existing_actual_argv_mapping_for_both_providers() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        store
            .put_provider_launch_defaults(
                &ProviderLaunchDefaultsPutRequestV1 {
                    schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                    idempotency_key: "both-provider-defaults".into(),
                    expected_revision: 0,
                    defaults: BTreeMap::from_iter(["codex", "claude"].map(|provider| {
                        (
                            ProviderIdV1::new(provider).unwrap(),
                            ProviderLaunchDefaultV1 {
                                permission_mode: ProviderLaunchPermissionModeV1::BypassApprovals,
                            },
                        )
                    })),
                },
                1,
            )
            .await
            .unwrap();

        for (provider, arguments) in [
            (
                "codex",
                crate::provider_extension::test_codex_provider_arguments(
                    ProviderPermissionModeV1::SkipPermissions,
                ),
            ),
            (
                "claude",
                vec![
                    "--settings".into(),
                    "/fixture/managed-claude-settings.json".into(),
                    "--dangerously-skip-permissions".into(),
                ],
            ),
        ] {
            let mut intent = request(&format!("{provider}-inherit"));
            intent.idempotency_key = format!("spawn-{provider}-inherit");
            intent.provider_id = ProviderIdV1::new(provider).unwrap();
            let receipt = preview(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                intent,
                2,
            )
            .await
            .unwrap();
            assert_eq!(
                receipt.plan.request.permission_mode,
                AgentSpawnPermissionModeV1::SkipPermissions
            );
            assert_eq!(
                providers
                    .launch_plan(
                        &receipt.plan.request.provider_id,
                        &receipt.plan.request.permission_mode,
                        receipt.plan.request.model.as_ref(),
                        receipt.plan.request.effort.as_ref(),
                        None,
                    )
                    .unwrap()
                    .unwrap()
                    .arguments,
                arguments
            );
        }
    }

    #[tokio::test]
    async fn unavailable_provider_returns_typed_failure_without_a_plan() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let mut intent = request("unknown-inherit");
        intent.idempotency_key = "spawn-unknown-inherit".into();
        intent.provider_id = ProviderIdV1::new("unknown").unwrap();

        assert_eq!(
            preview(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                intent,
                1,
            )
            .await
            .unwrap_err(),
            "agent_spawn_provider_unavailable"
        );
        assert!(
            store
                .agent_spawn_receipt_by_idempotency_key("spawn-unknown-inherit")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn service_resolved_base_replays_the_persisted_base_only_for_the_same_branch() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
            .await
            .unwrap();
        let providers = crate::provider_extension::test_local_agent_provider_registry();
        let first = preview_with_service_resolved_base(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            dedicated_request(&"a".repeat(40), "agent/codex-1"),
            1,
        )
        .await
        .unwrap();

        let replay = preview_with_service_resolved_base(
            &store,
            &providers,
            "dure-local",
            "generation-1",
            project(),
            dedicated_request(&"b".repeat(40), "agent/codex-1"),
            2,
        )
        .await
        .unwrap();
        assert_eq!(replay, first);

        assert_eq!(
            preview(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                dedicated_request(&"b".repeat(40), "agent/codex-1"),
                3,
            )
            .await
            .unwrap_err(),
            "agent_spawn_idempotency_conflict"
        );
        assert_eq!(
            preview_with_service_resolved_base(
                &store,
                &providers,
                "dure-local",
                "generation-1",
                project(),
                dedicated_request(&"b".repeat(40), "agent/other"),
                4,
            )
            .await
            .unwrap_err(),
            "agent_spawn_idempotency_conflict"
        );
    }
}
