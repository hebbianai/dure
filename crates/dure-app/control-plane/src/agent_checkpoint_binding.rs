use std::path::Path;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
    AgentBootstrapV1, AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1,
    AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1,
    DomainStore, DomainStoreErrorV1, ProviderIdV1, RuntimeKindIdV1, SessionBindingRecordV1,
    WorkflowSessionGenerationV1, WorkspaceIdV1,
};
use dure_app_sqlite::{OrchestrationDispatchSessionRebindRequestV1, SqliteDomainStore};
use hmux_client::recovery_journal::managed_create_ledger::{
    completed_create_receipt, managed_rehost_recipe,
};
use serde_json::{Value, json};

use crate::{
    BindingEnsureBody, ExactHmuxRehostError, HMUX_RUNTIME_KIND_ID, ServiceState,
    agent_runtime_projection, authority_stop_fence, binding_authority,
    exact_hmux_rehost_operation_id, now_ms,
    provider_credential_profile::{
        ProviderCredentialProfileErrorV1, native_provider_state_environment,
    },
    provider_permission, query_hmux, valid_token,
};

pub(super) struct PreparedInitialNativeSelection {
    pub(super) selection: AgentRuntimeSelectionV1,
    pub(super) launch_idempotency_key: String,
}

pub(super) fn authority_write_error(error: DomainStoreErrorV1) -> String {
    match error {
        DomainStoreErrorV1::IdentityConflict { .. } => {
            "agent_checkpoint_binding_runtime_owned".into()
        }
        _ => "agent_checkpoint_binding_store_failed".into(),
    }
}

fn credential_admission_error(error: ProviderCredentialProfileErrorV1) -> String {
    match error {
        ProviderCredentialProfileErrorV1::RequestInvalid
        | ProviderCredentialProfileErrorV1::Conflict
        | ProviderCredentialProfileErrorV1::StaleGeneration => {
            "agent_checkpoint_binding_credential_authority_unsupported".into()
        }
        ProviderCredentialProfileErrorV1::Unavailable
        | ProviderCredentialProfileErrorV1::StoreFailed => {
            "agent_checkpoint_binding_credential_unavailable".into()
        }
    }
}

/// Converts one exact, immutable Hmux launch authority into the backend's
/// initial runtime selection. Mutable pane or registry projections never
/// participate in this compatibility admission.
pub(super) async fn prepare_initial_native_selection(
    state: &ServiceState,
    body: &BindingEnsureBody,
    provider_id: &ProviderIdV1,
    timestamp: i64,
) -> Result<Option<PreparedInitialNativeSelection>, String> {
    let Some(receipt) = completed_create_receipt(
        &state.hmux_identity.discovery_root,
        &body.workspace_id,
        &body.session_id,
    )
    .map_err(|_| "agent_checkpoint_binding_launch_authority_unavailable".to_string())?
    else {
        return Ok(None);
    };
    let Some(recipe) = managed_rehost_recipe(
        &state.hmux_identity.discovery_root,
        &body.workspace_id,
        &body.session_id,
    )
    .map_err(|_| "agent_checkpoint_binding_launch_authority_unavailable".to_string())?
    else {
        return Ok(None);
    };
    let fence = receipt
        .generation_fence()
        .ok_or_else(|| "agent_checkpoint_binding_launch_authority_stale".to_string())?;
    if receipt.provider_id() != provider_id.as_str()
        || recipe.provider_id() != provider_id.as_str()
        || recipe.permission_mode() != receipt.permission_mode()
        || recipe.provider_cwd() != Path::new(&body.worktree_path)
        || !fence.matches_generation(
            &body.stop_fence.runner_principal,
            &body.stop_fence.runner_instance,
            &body.stop_fence.channel_epoch,
            &body.stop_fence.host_instance_id,
            &body.stop_fence.terminal_epoch,
        )
    {
        return Err("agent_checkpoint_binding_launch_authority_stale".into());
    }
    let execution_profile = match recipe.rehost().launch_reference() {
        Some(reference_id) => {
            let registered = state
                .credential_profiles
                .verified_native_launch_reference(
                    provider_id,
                    reference_id,
                    recipe.provider_state_environment(),
                )
                .await
                .map_err(credential_admission_error)?;
            AgentExecutionProfileV1::CredentialReference {
                reference_id: registered.profile().reference_id.clone(),
                // Legacy Hmux authority proves the stable credential identity,
                // but its recipe predates generation-fenced launch metadata.
                // Leave the generation explicitly unclaimed so a later
                // credential replacement cannot be mistaken for the source.
                credential_generation: None,
            }
        }
        None => {
            let expected = native_provider_state_environment(provider_id, None)
                .map_err(credential_admission_error)?;
            // Providers without profile selectors have an empty native default.
            if recipe.provider_state_environment() != &expected {
                return Err("agent_checkpoint_binding_credential_authority_unsupported".into());
            }
            AgentExecutionProfileV1::ProviderDefault
        }
    };
    Ok(Some(PreparedInitialNativeSelection {
        selection: AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: body.agent_id.clone(),
            provider_id: provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile,
            permission_mode: provider_permission::from_hmux(receipt.permission_mode()),
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: timestamp,
        },
        launch_idempotency_key: receipt.idempotency_key().to_owned(),
    }))
}

/// Preserves backend-owned project/workspace identity for an existing Agent.
/// Synthetic identities are only a compatibility bootstrap for a coordinator
/// that has never been registered with the backend.
pub(super) async fn ensure_agent_identity(
    store: &SqliteDomainStore,
    body: &BindingEnsureBody,
    provider_id: &ProviderIdV1,
    timestamp: i64,
) -> Result<(), String> {
    store
        .ensure_agent_identity(
            &AgentBootstrapV1 {
                agent_id: body.agent_id.clone(),
                runtime_workspace_id: WorkspaceIdV1::new(body.workspace_id.clone())
                    .map_err(|_| "agent_checkpoint_binding_invalid")?,
                provider_id: provider_id.clone(),
                working_directory: body.worktree_path.clone(),
                display_name: body.display_name.clone(),
            },
            timestamp,
        )
        .await
        .map_err(|error| match error {
            DomainStoreErrorV1::IdentityConflict {
                entity: "agent provider",
                ..
            } => "agent_checkpoint_binding_profile_stale".into(),
            DomainStoreErrorV1::IdentityConflict {
                entity: "agent workspace",
                ..
            } => "agent_checkpoint_binding_workspace_stale".into(),
            _ => "agent_checkpoint_binding_store_failed".into(),
        })
}

pub(super) async fn ensure(state: &ServiceState, body: BindingEnsureBody) -> Result<Value, String> {
    if body.schema_version != 1
        || !valid_token(&body.session_id)
        || !valid_token(&body.workspace_id)
        || body.display_name.is_empty()
        || !Path::new(&body.worktree_path).is_absolute()
    {
        return Err("agent_checkpoint_binding_invalid".into());
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    let selected_native = match agent_runtime_projection::read_locked(state, &body.agent_id).await?
    {
        agent_runtime_projection::AgentRuntimeObservedV1::Unmanaged => None,
        agent_runtime_projection::AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => match *authority {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority }
                if authority.binding.session_id == body.session_id
                    && authority.runtime_workspace_id == body.workspace_id
                    && authority_stop_fence(&authority) == body.stop_fence =>
            {
                Some((selection, authority))
            }
            _ => return Err("agent_checkpoint_binding_runtime_owned".into()),
        },
        agent_runtime_projection::AgentRuntimeObservedV1::Closed(_)
        | agent_runtime_projection::AgentRuntimeObservedV1::Transitioning { .. } => {
            return Err("agent_checkpoint_binding_runtime_owned".into());
        }
    };
    let hmux = query_hmux(
        &state.hmux_identity,
        &body.session_id,
        &body.workspace_id,
        &body.stop_fence,
    )
    .await?;
    let provider_id = ProviderIdV1::new(hmux.provider_id)
        .map_err(|_| "agent_checkpoint_binding_invalid".to_string())?;
    let provider_conversation_id = hmux
        .provider_conversation_identity
        .map(|identity| identity.conversation_id);
    let timestamp = now_ms().map_err(|_| "backend_clock_invalid".to_string())?;
    let initial_native_adoption = match selected_native.as_ref() {
        Some(_) => None,
        None => prepare_initial_native_selection(state, &body, &provider_id, timestamp).await?,
    };
    let credential_reference_id = match selected_native.as_ref() {
        Some((selection, _)) if selection.provider_id == provider_id => {
            match &selection.execution_profile {
                AgentExecutionProfileV1::ProviderDefault => None,
                AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                    Some(reference_id.clone())
                }
            }
        }
        Some(_) => return Err("agent_checkpoint_binding_profile_stale".into()),
        None => initial_native_adoption.as_ref().and_then(|prepared| {
            match &prepared.selection.execution_profile {
                AgentExecutionProfileV1::ProviderDefault => None,
                AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                    Some(reference_id.clone())
                }
            }
        }),
    };
    ensure_agent_identity(&state.store, &body, &provider_id, timestamp).await?;
    if let Some((_, authority)) = selected_native.as_ref()
        && authority.binding.provider_conversation_id.is_none()
        && let Some(conversation) = provider_conversation_id.as_deref()
    {
        // Only the exact observed native generation can fill a missing identity.
        // Preserve its selection, binding generation, and any already-known ID.
        state
            .store
            .converge_agent_checkpoint_provider_conversation(authority, conversation)
            .await
            .map_err(authority_write_error)?;
    }
    let existing = state
        .store
        .session_binding(&body.agent_id)
        .await
        .map_err(|_| "agent_checkpoint_binding_store_failed".to_string())?;
    let authority = binding_authority(&state.store, &body.agent_id).await?;
    if existing.is_none() && authority.is_some() {
        return Err("agent_checkpoint_binding_store_failed".into());
    }
    if let (Some(binding), Some(authority)) = (&existing, &authority) {
        if authority.binding.binding_generation > binding.binding_generation {
            return Err("agent_checkpoint_binding_store_failed".into());
        }
    }
    let exact = existing
        .as_ref()
        .zip(authority.as_ref())
        .is_some_and(|(binding, authority)| {
            binding.binding_generation == authority.binding.binding_generation
                && binding.session_id == body.session_id
                && authority.binding.session_id == body.session_id
                && authority.runtime_workspace_id == body.workspace_id
                && authority_stop_fence(authority) == body.stop_fence
                && binding.provider_conversation_id == provider_conversation_id
                && binding.credential_reference_id == credential_reference_id
        });
    if selected_native.is_some() && !exact {
        return Err("agent_checkpoint_binding_runtime_owned".into());
    }
    let target_authority = if exact {
        authority
            .as_ref()
            .ok_or_else(|| "agent_checkpoint_binding_store_failed".to_string())?
            .clone()
    } else {
        let next_generation = match existing.as_ref() {
            Some(record) => record
                .binding_generation
                .checked_add(1)
                .ok_or_else(|| "agent_checkpoint_binding_store_failed".to_string())?,
            None => 1,
        };
        let record = SessionBindingRecordV1 {
            agent_id: body.agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new(HMUX_RUNTIME_KIND_ID)
                .map_err(|_| "agent_checkpoint_binding_invalid".to_string())?,
            session_id: body.session_id.clone(),
            provider_conversation_id,
            credential_reference_id,
            binding_generation: next_generation,
            bound_at_ms: timestamp,
        };
        AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: record,
            runtime_workspace_id: body.workspace_id.clone(),
            runner_principal: body.stop_fence.runner_principal.clone(),
            runner_instance: body.stop_fence.runner_instance.clone(),
            channel_epoch: body.stop_fence.channel_epoch.clone(),
            host_instance_id: body.stop_fence.host_instance_id.clone(),
            terminal_epoch: body.stop_fence.terminal_epoch.clone(),
            updated_at_ms: timestamp,
        }
    };
    let target_generation =
        WorkflowSessionGenerationV1::from_checkpoint_authority(&target_authority, &provider_id);
    let source_generation = authority
        .as_ref()
        .map(|source| WorkflowSessionGenerationV1::from_checkpoint_authority(source, &provider_id));
    if initial_native_adoption.is_none()
        && source_generation
            .as_ref()
            .is_some_and(|source| source != &target_generation)
    {
        return Err("agent_checkpoint_binding_launch_authority_unavailable".into());
    }
    if let Some(prepared) = initial_native_adoption {
        let checkout_runtime = dure_session_runtime::CheckoutSessionRuntime::at_root(
            state.store.as_ref().clone(),
            state.hmux_identity.runtime_executable_path.clone(),
            state.hmux_identity.discovery_root.clone(),
        )
        .map_err(|_| "agent_checkpoint_binding_checkout_unavailable".to_string())?;
        let checkout = checkout_runtime
            .checkout_for_managed_create(
                hmux_client::ManagedCreateReconcileRequest::new(
                    &prepared.launch_idempotency_key,
                    &target_generation.session_id,
                    &target_generation.workspace_id,
                )
                .map_err(|_| "agent_checkpoint_binding_invalid".to_string())?,
            )
            .await
            .map_err(|_| "agent_checkpoint_binding_checkout_unavailable".to_string())?;
        let dispatch_rebind = match source_generation.as_ref() {
            Some(source) if source != &target_generation => {
                let operation_id = exact_hmux_rehost_operation_id(
                    state,
                    source,
                    &target_generation,
                    Some(&prepared.selection.permission_mode),
                )
                .await
                .map_err(|error| match error {
                    ExactHmuxRehostError::Unavailable => {
                        "agent_checkpoint_binding_launch_authority_unavailable".to_string()
                    }
                    ExactHmuxRehostError::Conflict => {
                        "agent_checkpoint_binding_launch_authority_stale".to_string()
                    }
                })?;
                Some(OrchestrationDispatchSessionRebindRequestV1 {
                    schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
                    operation_id,
                    source: source.clone(),
                    target: target_generation,
                    rebound_at_ms: timestamp,
                })
            }
            _ => None,
        };
        state
            .store
            .commit_initial_agent_runtime_native_adoption(
                authority.as_ref(),
                &target_authority,
                &prepared.selection,
                dispatch_rebind.as_ref(),
                &prepared.launch_idempotency_key,
                checkout.as_ref(),
            )
            .await
            .map_err(authority_write_error)?;
    } else {
        state
            .store
            .upsert_agent_checkpoint_binding_authority(&target_authority)
            .await
            .map_err(authority_write_error)?;
    }
    let binding = target_authority.binding;
    Ok(json!({
        "schemaVersion": 1,
        "identity": {
            "agentId": body.agent_id,
            "sessionId": binding.session_id,
            "bindingGeneration": binding.binding_generation,
        }
    }))
}

#[cfg(test)]
mod tests {
    use dure_app::{
        AgentIdV1, ProjectIdV1, WorkspaceIdV1, agent_bootstrap_project_id as checkpoint_project_id,
        agent_bootstrap_runtime_workspace as checkpoint_bootstrap_runtime_workspace,
        agent_bootstrap_workspace_id as checkpoint_workspace_id,
    };

    use super::*;

    #[tokio::test]
    async fn failed_agent_bootstrap_does_not_publish_partial_parent_records() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let store = SqliteDomainStore::open(root.join("bootstrap.sqlite3"))
            .await
            .unwrap();
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(store.database_path()),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TRIGGER fail_agent_bootstrap BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT, 'fixture Agent publication failure'); END")
            .execute(&pool).await.unwrap();
        // This test calls metadata bootstrap only; no runtime fence is observed
        // and no provider selection/session is fabricated by the application.
        let body = BindingEnsureBody {
            schema_version: 1,
            agent_id: AgentIdV1::new("unregistered-agent").unwrap(),
            session_id: "unused-session".into(),
            workspace_id: "unregistered-workspace".into(),
            display_name: "New Agent".into(),
            worktree_path: root.to_str().unwrap().into(),
            stop_fence: crate::HmuxStopFence {
                runner_principal: "unused".into(),
                runner_instance: "unused".into(),
                channel_epoch: "1".into(),
                host_instance_id: "unused".into(),
                terminal_epoch: "unused".into(),
            },
        };
        let provider = ProviderIdV1::new("codex").unwrap();
        let failed = ensure_agent_identity(&store, &body, &provider, 10).await;
        assert!(failed.is_err());
        let project = store
            .project(&checkpoint_project_id(&body.workspace_id).unwrap())
            .await
            .unwrap();
        let workspace = store
            .workspace(&checkpoint_workspace_id(&body.agent_id).unwrap())
            .await
            .unwrap();
        assert!(
            project.is_none() && workspace.is_none(),
            "failed Agent publication leaked parent records: {project:?} {workspace:?}"
        );
        sqlx::query("DROP TRIGGER fail_agent_bootstrap")
            .execute(&pool)
            .await
            .unwrap();
        ensure_agent_identity(&store, &body, &provider, 20)
            .await
            .unwrap();
        assert!(store.agent(&body.agent_id).await.unwrap().is_some());
        pool.close().await;
        store.close().await;
    }

    #[test]
    fn checkpoint_bootstrap_codec_round_trips_one_typed_identity() {
        let agent_id = AgentIdV1::new("agent-1").unwrap();
        let runtime_workspace_id = WorkspaceIdV1::new("runtime-workspace-1").unwrap();
        let workspace_id = checkpoint_workspace_id(&agent_id).unwrap();
        let project_id = checkpoint_project_id(runtime_workspace_id.as_str()).unwrap();

        assert_eq!(
            checkpoint_bootstrap_runtime_workspace(&agent_id, &workspace_id, &project_id).unwrap(),
            Some(runtime_workspace_id)
        );
    }

    #[test]
    fn checkpoint_bootstrap_codec_distinguishes_registered_and_invalid_graphs() {
        let agent_id = AgentIdV1::new("agent-1").unwrap();

        assert_eq!(
            checkpoint_bootstrap_runtime_workspace(
                &agent_id,
                &WorkspaceIdV1::new("workspace-1").unwrap(),
                &ProjectIdV1::new("project-1").unwrap(),
            )
            .unwrap(),
            None
        );
        assert!(
            checkpoint_bootstrap_runtime_workspace(
                &agent_id,
                &checkpoint_workspace_id(&agent_id).unwrap(),
                &ProjectIdV1::new("project-1").unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn permanent_credential_authority_failures_are_not_classified_as_unavailable() {
        for error in [
            ProviderCredentialProfileErrorV1::RequestInvalid,
            ProviderCredentialProfileErrorV1::Conflict,
            ProviderCredentialProfileErrorV1::StaleGeneration,
        ] {
            assert_eq!(
                credential_admission_error(error),
                "agent_checkpoint_binding_credential_authority_unsupported"
            );
        }
        for error in [
            ProviderCredentialProfileErrorV1::Unavailable,
            ProviderCredentialProfileErrorV1::StoreFailed,
        ] {
            assert_eq!(
                credential_admission_error(error),
                "agent_checkpoint_binding_credential_unavailable"
            );
        }
    }
}
