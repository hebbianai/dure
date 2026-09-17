use super::*;

/// Both client forms converge on the same native proof and binding transaction.
#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum RequestV1 {
    Explicit(Box<AgentRuntimeNativeRehostBodyV1>),
    CompletedOperation(CompletedOperationV1),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompletedOperationV1 {
    schema_version: u16,
    agent_id: AgentIdV1,
    operation_id: OperationIdV1,
    source_session_id: String,
    source_workspace_id: String,
}

pub(crate) async fn apply(
    state: &ServiceState,
    request: RequestV1,
) -> Result<
    crate::agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    BackendDispatchError,
> {
    let request = match request {
        RequestV1::Explicit(body) => return super::apply(state, *body).await,
        RequestV1::CompletedOperation(request) => request,
    };
    if request.schema_version != AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1 {
        return Err(conflict());
    }
    let _agent_guard = state.agent_operations.acquire(&request.agent_id).await;
    let receipt = read_receipt(
        state.hmux_identity.discovery_root.clone(),
        request.operation_id.as_str().into(),
        request.source_session_id,
        request.source_workspace_id,
    )
    .await?;
    let resolution = ManagedRehostResolution::from_receipts(
        receipt.operation_id(),
        receipt.source_stop_receipt(),
        receipt.replacement_receipt(),
    )
    .map_err(|_| conflict())?;
    let provider_id =
        ProviderIdV1::new(receipt.replacement_receipt().provider_id()).map_err(|_| conflict())?;
    let source = source_projection::read(state, &request.agent_id, &provider_id).await?;
    if source
        .repair_record
        .as_ref()
        .is_some_and(|transition| transition.replacement_authority.is_some())
    {
        // Receipt publication does not authorize stopping another repair target.
        return Err(BackendDispatchError::terminal(
            "agent_runtime_native_rehost_explicit_recovery_required",
        ));
    }
    let target_credential =
        credential_from_launch(state, &provider_id, receipt.launch_reference()).await?;
    super::apply_locked(
        state,
        AgentRuntimeNativeRehostBodyV1 {
            schema_version: request.schema_version,
            agent_id: request.agent_id,
            operation_id: request.operation_id,
            provider_id,
            target_credential,
            source: resolution.source_generation().clone(),
            target: resolution.current_generation().clone(),
        },
        source,
    )
    .await
}

async fn credential_from_launch(
    state: &ServiceState,
    provider_id: &ProviderIdV1,
    launch_reference: Option<&str>,
) -> Result<AgentRuntimeNativeRehostCredentialV1, BackendDispatchError> {
    Ok(match launch_reference {
        None => AgentRuntimeNativeRehostCredentialV1::ProviderDefault,
        Some(reference) => {
            let credential = state
                .credential_profiles
                .registered_launch_reference(provider_id, reference)
                .await
                .map_err(credential_error)?;
            AgentRuntimeNativeRehostCredentialV1::CredentialReference {
                reference_id: credential.profile().reference_id.clone(),
            }
        }
    })
}

/// The caller holds the Agent operation lock and has observed a retired or
/// unavailable Stable native source. Publication consumes completed receipts;
/// it must never execute a native operation or take over a pending transition.
pub(crate) async fn publish_completed_successor_locked(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<bool, BackendDispatchError> {
    use hmux_client::recovery_journal::{
        ManagedRehostResolutionLookup, resolve_managed_rehost_current,
    };

    let source =
        source_projection::read(state, &selection.agent_id, &selection.provider_id).await?;
    if source.selection != *selection
        || source.authority != *authority
        || source.repair_record.is_some()
        || source.source_stopped
    {
        return Err(conflict());
    }
    let root = state.hmux_identity.discovery_root.clone();
    let workspace = authority.runtime_workspace_id.clone();
    let session = authority.binding.session_id.clone();
    let lookup = tokio::task::spawn_blocking(move || {
        resolve_managed_rehost_current(&root, &workspace, &session)
    })
    .await
    .map_err(|error| Stage::LineageResolution.unavailable(error.to_string()))?
    .map_err(|error| Stage::LineageResolution.unavailable(error))?;
    let resolution = match lookup {
        ManagedRehostResolutionLookup::NotFound => return Ok(false),
        ManagedRehostResolutionLookup::RetryRequired { .. } => {
            return Err(Stage::LineageResolution.unavailable("hmux_managed_rehost_retry_required"));
        }
        ManagedRehostResolutionLookup::Resolved(resolution) => resolution,
    };
    if !generation_matches_authority(resolution.source_generation(), authority)
        || resolution.provider_id() != selection.provider_id.as_str()
    {
        return Err(conflict());
    }
    let verified = verify_resolved_hmux(state, &resolution).await?;
    let target_credential = credential_from_launch(
        state,
        &selection.provider_id,
        verified.receipt.launch_reference(),
    )
    .await?;
    if !state.is_mutation_authority() {
        return Err("runtime_idle_authority_unavailable".into());
    }
    publish_verified_locked(
        state,
        AgentRuntimeNativeRehostBodyV1 {
            schema_version: AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1,
            agent_id: selection.agent_id.clone(),
            operation_id: OperationIdV1::new(verified.receipt.operation_id())
                .map_err(|_| conflict())?,
            provider_id: selection.provider_id.clone(),
            target_credential,
            source: resolution.source_generation().clone(),
            target: resolution.current_generation().clone(),
        },
        source,
        verified,
    )
    .await?;
    Ok(true)
}
