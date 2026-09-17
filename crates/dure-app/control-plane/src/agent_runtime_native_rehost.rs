use std::path::PathBuf;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1,
    AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1, AgentIdV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeNativeRehostCommitV1,
    AgentRuntimeNativeRehostReceiptV1, AgentRuntimeNativeRehostRepairTransitionV1,
    AgentRuntimeNativeRehostSourceV1, AgentRuntimeSelectionV1, OperationIdV1, ProviderIdV1,
    ProviderLaunchReferenceV1, ProviderPermissionModeV1, SessionBindingRecordV1,
};
use hmux_client::recovery_journal::read_completed_managed_rehost_receipt;
use hmux_client::{
    ManagedCreateReceipt, ManagedRehostGeneration, ManagedRehostReceipt,
    ManagedRehostReconcileRequest, ManagedRehostResolution, ManagedStopReceipt,
};
use serde::Deserialize;

use crate::structured_provider_runtime::retire_transition_replacement_source;
use crate::{BackendDispatchError, HmuxStopFence, ServiceState, provider_permission};

mod failure;
pub(crate) mod request;
mod source_projection;

use failure::{Stage, conflict, credential_error, retirement_error};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeNativeRehostBodyV1 {
    schema_version: u16,
    agent_id: AgentIdV1,
    operation_id: OperationIdV1,
    provider_id: ProviderIdV1,
    target_credential: AgentRuntimeNativeRehostCredentialV1,
    source: ManagedRehostGeneration,
    target: ManagedRehostGeneration,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeNativeResumeBodyV1 {
    schema_version: u16,
    agent_id: AgentIdV1,
    operation_id: OperationIdV1,
    provider_id: ProviderIdV1,
    target_credential: AgentRuntimeNativeRehostCredentialV1,
    provider_conversation_ref: String,
    permission_mode: ProviderPermissionModeV1,
    launch_idempotency_key: OperationIdV1,
    target: ManagedRehostGeneration,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AgentRuntimeNativeRehostCredentialV1 {
    ProviderDefault,
    CredentialReference {
        #[serde(rename = "referenceId")]
        reference_id: String,
    },
}

impl AgentRuntimeNativeRehostCredentialV1 {
    fn reference_id(&self) -> Option<&str> {
        match self {
            Self::ProviderDefault => None,
            Self::CredentialReference { reference_id } => Some(reference_id),
        }
    }

    fn validate(&self) -> Result<(), BackendDispatchError> {
        match self {
            Self::ProviderDefault => Ok(()),
            Self::CredentialReference { reference_id } => {
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: reference_id.clone(),
                    credential_generation: None,
                }
                .validate()
                .map_err(|_| conflict())
            }
        }
    }

    fn matches_execution_profile(&self, profile: &AgentExecutionProfileV1) -> bool {
        match (self, profile) {
            (Self::ProviderDefault, AgentExecutionProfileV1::ProviderDefault) => true,
            (
                Self::CredentialReference { reference_id },
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: selected,
                    ..
                },
            ) => reference_id == selected,
            _ => false,
        }
    }

    fn execution_profile(&self) -> AgentExecutionProfileV1 {
        match self {
            Self::ProviderDefault => AgentExecutionProfileV1::ProviderDefault,
            Self::CredentialReference { reference_id } => {
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: reference_id.clone(),
                    credential_generation: None,
                }
            }
        }
    }
}

struct VerifiedRehostLineage {
    prefix_receipts: Vec<ManagedRehostReceipt>,
    receipt: ManagedRehostReceipt,
    provider_conversation_id: Option<String>,
    permission_mode: ProviderPermissionModeV1,
}

async fn retire_failed_structured_replacement(
    state: &ServiceState,
    transition: &dure_app::AgentRuntimeTransitionRecordV1,
) -> Result<Option<dure_app::AgentRuntimeReplacementAuthorityV1>, BackendDispatchError> {
    let Some(authority) = transition.replacement_authority.as_ref() else {
        return Ok(None);
    };
    if !matches!(
        &authority.0,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }
    ) {
        return Err(conflict());
    }
    retire_transition_replacement_source(&state.structured_runtimes, transition)
        .await
        .map_err(retirement_error)
}

fn replacement_authority_updated_at(
    authority: Option<&dure_app::AgentRuntimeReplacementAuthorityV1>,
) -> i64 {
    match authority.map(|authority| &authority.0) {
        Some(AgentRuntimeBindingAuthorityV1::NativeCli { authority }) => authority.updated_at_ms,
        Some(AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding }) => {
            binding.updated_at_ms
        }
        None => 0,
    }
}

async fn verified_target_credential(
    state: &ServiceState,
    provider_id: &ProviderIdV1,
    expected_reference: Option<&str>,
    observed_launch_reference: Option<&str>,
) -> Result<
    Option<super::provider_credential_profile::RegisteredProviderCredentialProfileV1>,
    BackendDispatchError,
> {
    let (Some(expected_reference), Some(observed_launch_reference)) =
        (expected_reference, observed_launch_reference)
    else {
        return if expected_reference.is_none() && observed_launch_reference.is_none() {
            Ok(None)
        } else {
            Err(conflict())
        };
    };
    let observed = match state
        .credential_profiles
        .registered_launch_reference(provider_id, observed_launch_reference)
        .await
    {
        Ok(observed) => observed,
        Err(error) => return Err(credential_error(error)),
    };
    if observed_launch_reference == expected_reference {
        return if observed.profile().reference_id == expected_reference {
            Ok(Some(observed))
        } else {
            Err(conflict())
        };
    }
    let expected = state
        .credential_profiles
        .registered_reference(provider_id, expected_reference)
        .await
        .map_err(credential_error)?;
    if observed.profile() != expected.profile() {
        return Err(conflict());
    }
    Ok(Some(expected))
}

fn generation_matches_authority(
    generation: &ManagedRehostGeneration,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> bool {
    generation.session_id() == authority.binding.session_id
        && generation.workspace_id() == authority.runtime_workspace_id
        && generation.runner_principal() == authority.runner_principal
        && generation.runner_instance() == authority.runner_instance
        && generation.channel_epoch() == authority.channel_epoch
        && generation.host_instance_id() == authority.host_instance_id
        && generation.terminal_epoch() == authority.terminal_epoch
}

fn generation_matches_durable_source(
    generation: &ManagedRehostGeneration,
    source: &AgentRuntimeNativeRehostSourceV1,
) -> bool {
    generation.session_id() == source.session_id.as_str()
        && generation.workspace_id() == source.workspace_id.as_str()
        && generation.runner_principal() == source.runner_principal.as_str()
        && generation.runner_instance() == source.runner_instance.as_str()
        && generation.channel_epoch() == source.channel_epoch.as_str()
        && generation.host_instance_id() == source.host_instance_id.as_str()
        && generation.terminal_epoch() == source.terminal_epoch.as_str()
}

fn generation_matches_stop(
    generation: &ManagedRehostGeneration,
    receipt: &ManagedStopReceipt,
) -> bool {
    generation.session_id() == receipt.session_id()
        && generation.workspace_id() == receipt.workspace_id()
        && generation.runner_principal() == receipt.runner_principal()
        && generation.runner_instance() == receipt.runner_instance()
        && generation.channel_epoch() == receipt.channel_epoch().to_string()
        && generation.host_instance_id() == receipt.host_instance_id()
        && generation.terminal_epoch() == receipt.terminal_epoch()
}

fn generation_matches_create(
    generation: &ManagedRehostGeneration,
    receipt: &ManagedCreateReceipt,
) -> bool {
    let Some(fence) = receipt.generation_fence() else {
        return false;
    };
    generation.session_id() == receipt.session_id()
        && generation.workspace_id() == receipt.workspace_id()
        && generation.runner_principal() == fence.runner_principal()
        && generation.runner_instance() == fence.runner_instance()
        && generation.channel_epoch() == fence.channel_epoch().to_string()
        && generation.host_instance_id() == fence.host_instance_id()
        && generation.terminal_epoch() == fence.terminal_epoch()
}

fn create_matches_authority(
    receipt: &ManagedCreateReceipt,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> bool {
    let Some(fence) = receipt.generation_fence() else {
        return false;
    };
    receipt.session_id() == authority.binding.session_id
        && receipt.workspace_id() == authority.runtime_workspace_id
        && fence.runner_principal() == authority.runner_principal
        && fence.runner_instance() == authority.runner_instance
        && fence.channel_epoch().to_string() == authority.channel_epoch
        && fence.host_instance_id() == authority.host_instance_id
        && fence.terminal_epoch() == authority.terminal_epoch
}

fn durable_source_matches_create(
    source: &AgentRuntimeNativeRehostSourceV1,
    receipt: &ManagedCreateReceipt,
) -> bool {
    let Some(fence) = receipt.generation_fence() else {
        return false;
    };
    source.session_id == receipt.session_id()
        && source.workspace_id == receipt.workspace_id()
        && source.runner_principal == fence.runner_principal()
        && source.runner_instance == fence.runner_instance()
        && source.channel_epoch == fence.channel_epoch().to_string()
        && source.host_instance_id == fence.host_instance_id()
        && source.terminal_epoch == fence.terminal_epoch()
}

fn create_matches_stop(create: &ManagedCreateReceipt, stop: &ManagedStopReceipt) -> bool {
    let Some(fence) = create.generation_fence() else {
        return false;
    };
    create.session_id() == stop.session_id()
        && create.workspace_id() == stop.workspace_id()
        && fence.runner_principal() == stop.runner_principal()
        && fence.runner_instance() == stop.runner_instance()
        && fence.channel_epoch() == stop.channel_epoch()
        && fence.host_instance_id() == stop.host_instance_id()
        && fence.terminal_epoch() == stop.terminal_epoch()
}

fn is_durable_replay(
    body: &AgentRuntimeNativeRehostBodyV1,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> bool {
    selection.selected_by_operation_id.as_ref() == Some(&body.operation_id)
        && body
            .target_credential
            .matches_execution_profile(&selection.execution_profile)
        && generation_matches_authority(&body.target, authority)
}

async fn durable_receipt(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<AgentRuntimeNativeRehostReceiptV1, BackendDispatchError> {
    let receipt = state
        .store
        .agent_runtime_native_rehost_receipt(agent_id)
        .await
        .map_err(|error| Stage::ReceiptRead.store_error(error))?
        .ok_or_else(conflict)?;
    receipt
        .validate_for(selection, authority)
        .map_err(|error| Stage::ReceiptRead.store_error(error))?;
    Ok(receipt)
}

fn durable_receipt_matches_verified_edge(
    request_source: &ManagedRehostGeneration,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
    durable: &AgentRuntimeNativeRehostReceiptV1,
    edge: &ManagedRehostReceipt,
    preceding_edges: &[ManagedRehostReceipt],
) -> bool {
    selection.permission_mode
        == provider_permission::from_hmux(edge.replacement_receipt().permission_mode())
        && !edge.conversation_id().is_some_and(|conversation_id| {
            authority.binding.provider_conversation_id.as_deref() != Some(conversation_id)
        })
        && durable.launch_idempotency_key.as_str() == edge.replacement_receipt().idempotency_key()
        && durable
            .provider_launch_reference
            .as_ref()
            .map(ProviderLaunchReferenceV1::as_str)
            == edge.launch_reference()
        && (generation_matches_durable_source(request_source, &durable.source)
            || preceding_edges.iter().any(|receipt| {
                durable_source_matches_create(&durable.source, receipt.replacement_receipt())
            }))
}

async fn classify_verified_source(
    state: &ServiceState,
    body: &AgentRuntimeNativeRehostBodyV1,
    selection: AgentRuntimeSelectionV1,
    authority: AgentCheckpointBindingAuthorityV1,
    source_stopped: bool,
    verified: &VerifiedRehostLineage,
) -> Result<(AgentRuntimeSelectionV1, AgentCheckpointBindingAuthorityV1), BackendDispatchError> {
    if generation_matches_authority(&body.source, &authority) {
        return Ok((selection, authority));
    }
    if source_stopped
        && body.source.workspace_id() == authority.runtime_workspace_id
        && verified
            .provider_conversation_id
            .as_deref()
            .is_some_and(|conversation_id| {
                authority.binding.provider_conversation_id.as_deref() == Some(conversation_id)
            })
    {
        return Ok((selection, authority));
    }

    let Some(selected_operation_id) = selection.selected_by_operation_id.as_ref() else {
        return Err(conflict());
    };
    let mut candidates = verified
        .prefix_receipts
        .iter()
        .enumerate()
        .filter(|(_, receipt)| {
            receipt.operation_id() == selected_operation_id.as_str()
                && create_matches_authority(receipt.replacement_receipt(), &authority)
        });
    let Some((prefix_index, prefix)) = candidates.next() else {
        return Err(conflict());
    };
    if candidates.next().is_some() {
        return Err(conflict());
    }

    let durable = durable_receipt(state, &body.agent_id, &selection, &authority).await?;
    if !durable_receipt_matches_verified_edge(
        &body.source,
        &selection,
        &authority,
        &durable,
        prefix,
        &verified.prefix_receipts[..prefix_index],
    ) {
        return Err(conflict());
    }
    Ok((selection, authority))
}

async fn read_receipt(
    discovery_root: PathBuf,
    operation_id: String,
    source_session_id: String,
    source_workspace_id: String,
) -> Result<ManagedRehostReceipt, BackendDispatchError> {
    tokio::task::spawn_blocking(move || {
        let request = ManagedRehostReconcileRequest::by_operation_identity(
            operation_id,
            source_session_id,
            source_workspace_id,
        )
        .map_err(|_| conflict())?;
        read_completed_managed_rehost_receipt(&discovery_root, &request)
            .map_err(|error| Stage::ReceiptRead.unavailable(error))?
            .ok_or_else(|| {
                Stage::ReceiptRead.unavailable("hmux_managed_rehost_receipt_unavailable")
            })
    })
    .await
    .map_err(|error| Stage::ReceiptRead.unavailable(error.to_string()))?
}

async fn verify_hmux(
    state: &ServiceState,
    body: &AgentRuntimeNativeRehostBodyV1,
) -> Result<VerifiedRehostLineage, BackendDispatchError> {
    body.source.validate().map_err(|_| conflict())?;
    body.target.validate().map_err(|_| conflict())?;
    if body.source.session_id() == body.target.session_id()
        || body.source.workspace_id() != body.target.workspace_id()
    {
        return Err(conflict());
    }
    let resolution_value = super::query_hmux_sessions(
        &state.hmux_identity,
        &[
            "managed-rehost-resolve".into(),
            "--session".into(),
            body.source.session_id().into(),
            "--workspace".into(),
            body.source.workspace_id().into(),
        ],
    )
    .await
    .map_err(|error| Stage::LineageResolution.unavailable(error))?;
    let resolution: ManagedRehostResolution =
        serde_json::from_value(resolution_value).map_err(|_| conflict())?;
    resolution.validate().map_err(|_| conflict())?;
    if resolution.source_generation() != &body.source
        || resolution.current_generation() != &body.target
        || resolution.provider_id() != body.provider_id.as_str()
        || resolution.operation_ids().last().map(String::as_str) != Some(body.operation_id.as_str())
    {
        return Err(conflict());
    }

    verify_resolved_hmux(state, &resolution).await
}

async fn verify_resolved_hmux(
    state: &ServiceState,
    resolution: &ManagedRehostResolution,
) -> Result<VerifiedRehostLineage, BackendDispatchError> {
    resolution.validate().map_err(|_| conflict())?;
    let source = resolution.source_generation();
    let target = resolution.current_generation();

    let mut previous_replacement: Option<ManagedCreateReceipt> = None;
    let mut receipts = Vec::with_capacity(resolution.operation_ids().len());
    for operation_id in resolution.operation_ids() {
        let (source_session_id, source_workspace_id) = previous_replacement
            .as_ref()
            .map(|receipt| {
                (
                    receipt.session_id().to_string(),
                    receipt.workspace_id().to_string(),
                )
            })
            .unwrap_or_else(|| {
                (
                    source.session_id().to_string(),
                    source.workspace_id().to_string(),
                )
            });
        let receipt = read_receipt(
            state.hmux_identity.discovery_root.clone(),
            operation_id.clone(),
            source_session_id,
            source_workspace_id,
        )
        .await?;
        if receipt.operation_id() != operation_id
            || receipt.replacement_receipt().provider_id() != resolution.provider_id()
            || !previous_replacement.as_ref().map_or_else(
                || generation_matches_stop(source, receipt.source_stop_receipt()),
                |previous| create_matches_stop(previous, receipt.source_stop_receipt()),
            )
        {
            return Err(conflict());
        }
        previous_replacement = Some(receipt.replacement_receipt().clone());
        receipts.push(receipt);
    }
    let final_receipt = receipts.pop().ok_or_else(conflict)?;
    if !generation_matches_create(target, final_receipt.replacement_receipt())
        || final_receipt.replacement_receipt().permission_mode() != resolution.permission_mode()
    {
        return Err(conflict());
    }

    let target_inspection = super::query_hmux_for_runtime_transition(
        &state.hmux_identity,
        target.session_id(),
        target.workspace_id(),
        &HmuxStopFence {
            runner_principal: target.runner_principal().into(),
            runner_instance: target.runner_instance().into(),
            channel_epoch: target.channel_epoch().into(),
            host_instance_id: target.host_instance_id().into(),
            terminal_epoch: target.terminal_epoch().into(),
        },
    )
    .await
    .map_err(|error| Stage::TargetObservation.unavailable(error.code()))?;
    if target_inspection.provider_id != resolution.provider_id() {
        return Err(conflict());
    }
    let receipt_conversation = final_receipt.conversation_id();
    let observed_conversation = target_inspection
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.as_str());
    if receipt_conversation
        .zip(observed_conversation)
        .is_some_and(|(receipt, observed)| receipt != observed)
    {
        return Err(conflict());
    }
    Ok(VerifiedRehostLineage {
        prefix_receipts: receipts,
        provider_conversation_id: receipt_conversation
            .or(observed_conversation)
            .map(str::to_owned),
        permission_mode: provider_permission::from_hmux(resolution.permission_mode()),
        receipt: final_receipt,
    })
}

async fn verify_resume_target(
    state: &ServiceState,
    body: &AgentRuntimeNativeResumeBodyV1,
) -> Result<(), BackendDispatchError> {
    body.target.validate().map_err(|_| conflict())?;
    if !super::valid_token(&body.provider_conversation_ref) {
        return Err(conflict());
    }
    let target = super::query_hmux_with_lifecycle(
        &state.hmux_identity,
        body.target.session_id(),
        body.target.workspace_id(),
        &HmuxStopFence {
            runner_principal: body.target.runner_principal().into(),
            runner_instance: body.target.runner_instance().into(),
            channel_epoch: body.target.channel_epoch().into(),
            host_instance_id: body.target.host_instance_id().into(),
            terminal_epoch: body.target.terminal_epoch().into(),
        },
        false,
    )
    .await
    .map_err(|error| Stage::TargetObservation.unavailable(error.code()))?;
    if target.provider_id != body.provider_id.as_str()
        || target
            .provider_conversation_identity
            .as_ref()
            .is_some_and(|identity| identity.conversation_id != body.provider_conversation_ref)
    {
        return Err(conflict());
    }
    Ok(())
}

fn resume_replays_selected_target(
    body: &AgentRuntimeNativeResumeBodyV1,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> bool {
    selection.selected_by_operation_id.as_ref() == Some(&body.operation_id)
        && selection.provider_id == body.provider_id
        && selection.permission_mode == body.permission_mode
        && body
            .target_credential
            .matches_execution_profile(&selection.execution_profile)
        && authority.binding.provider_conversation_id.as_deref()
            == Some(body.provider_conversation_ref.as_str())
        && generation_matches_authority(&body.target, authority)
}

/// Publish an already-ready exact Resume target. Historical client source
/// identity never enters this operation; the locked backend projection is the
/// sole compare-and-swap source, and any failed replacement remains untouched.
pub(crate) async fn apply_resume(
    state: &ServiceState,
    body: AgentRuntimeNativeResumeBodyV1,
) -> Result<
    super::agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    BackendDispatchError,
> {
    if body.schema_version != AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1 {
        return Err(conflict());
    }
    body.target_credential.validate()?;

    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    // Verification belongs inside the projection CAS. Otherwise an older
    // target can verify, wait behind a newer Resume, and then overwrite the
    // newer backend projection after Hmux has already retired it.
    verify_resume_target(state, &body).await?;
    let source_projection::NativeSourceProjection {
        selection,
        authority,
        repair_record,
        source_stopped: _,
        updated_at_ms: source_updated_at_ms,
    } = source_projection::read(state, &body.agent_id, &body.provider_id).await?;

    if resume_replays_selected_target(&body, &selection, &authority) {
        let receipt = durable_receipt(state, &body.agent_id, &selection, &authority).await?;
        if receipt.launch_idempotency_key != body.launch_idempotency_key {
            return Err(conflict());
        }
        return super::agent_runtime_transition_apply::native_rehost_receipt(
            &selection, &authority, &receipt,
        )
        .map_err(|_| conflict());
    }

    let target_execution_profile = body.target_credential.execution_profile();
    let committed_at_ms = super::now_ms()
        .map_err(|error| Stage::Clock.unavailable(error.to_string()))?
        .max(selection.updated_at_ms)
        .max(authority.updated_at_ms)
        .max(source_updated_at_ms);
    let target_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: body.agent_id.clone(),
            runtime_kind_id: authority.binding.runtime_kind_id.clone(),
            session_id: body.target.session_id().into(),
            provider_conversation_id: Some(body.provider_conversation_ref.clone()),
            credential_reference_id: body.target_credential.reference_id().map(str::to_owned),
            binding_generation: authority
                .binding
                .binding_generation
                .checked_add(1)
                .ok_or_else(conflict)?,
            bound_at_ms: committed_at_ms,
        },
        runtime_workspace_id: body.target.workspace_id().into(),
        runner_principal: body.target.runner_principal().into(),
        runner_instance: body.target.runner_instance().into(),
        channel_epoch: body.target.channel_epoch().into(),
        host_instance_id: body.target.host_instance_id().into(),
        terminal_epoch: body.target.terminal_epoch().into(),
        updated_at_ms: committed_at_ms,
    };
    let repair_transition =
        repair_record.map(|transition| AgentRuntimeNativeRehostRepairTransitionV1 {
            operation_id: transition.intent.operation_id,
            expected_journal_revision: transition.journal_revision,
            retain_replacement_authority: true,
            retired_replacement_authority: None,
        });
    let committed = state
        .store
        .commit_agent_runtime_native_rehost(&AgentRuntimeNativeRehostCommitV1 {
            schema_version: AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1,
            operation_id: body.operation_id,
            request_source: AgentRuntimeNativeRehostSourceV1::from_authority(&authority),
            source_selection: selection,
            source_authority: authority,
            repair_transition,
            target_authority,
            target_execution_profile,
            target_permission_mode: body.permission_mode,
            target_launch_idempotency_key: body.launch_idempotency_key,
            // Credential identity and the provider's opaque launch reference
            // are separate domains. Target-first Resume does not receive the
            // latter from Hmux, so it must remain unknown.
            target_provider_launch_reference: None,
            committed_at_ms,
        })
        .await
        .map_err(|error| Stage::Publication.store_error(error))?;
    super::agent_runtime_transition_apply::native_rehost_receipt(
        &committed.selection,
        &committed.authority,
        &committed.receipt,
    )
    .map_err(|_| conflict())
}

pub(crate) async fn apply(
    state: &ServiceState,
    body: AgentRuntimeNativeRehostBodyV1,
) -> Result<
    super::agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    BackendDispatchError,
> {
    if body.schema_version != AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1 {
        return Err(conflict());
    }
    body.target_credential.validate()?;
    body.source.validate().map_err(|_| conflict())?;
    body.target.validate().map_err(|_| conflict())?;
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    let source = source_projection::read(state, &body.agent_id, &body.provider_id).await?;
    apply_locked(state, body, source).await
}

async fn apply_locked(
    state: &ServiceState,
    body: AgentRuntimeNativeRehostBodyV1,
    source: source_projection::NativeSourceProjection,
) -> Result<
    super::agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    BackendDispatchError,
> {
    let selection = &source.selection;
    let authority = &source.authority;
    if is_durable_replay(&body, selection, authority) {
        let receipt = durable_receipt(state, &body.agent_id, selection, authority).await?;
        if !generation_matches_durable_source(&body.source, &receipt.source) {
            let verified = verify_hmux(state, &body).await?;
            if !durable_receipt_matches_verified_edge(
                &body.source,
                selection,
                authority,
                &receipt,
                &verified.receipt,
                &verified.prefix_receipts,
            ) {
                return Err(conflict());
            }
        }
        return super::agent_runtime_transition_apply::native_rehost_receipt(
            selection, authority, &receipt,
        )
        .map_err(|_| conflict());
    }

    let verified = verify_hmux(state, &body).await?;
    publish_verified_locked(state, body, source, verified).await
}

async fn publish_verified_locked(
    state: &ServiceState,
    body: AgentRuntimeNativeRehostBodyV1,
    source: source_projection::NativeSourceProjection,
    verified: VerifiedRehostLineage,
) -> Result<
    super::agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    BackendDispatchError,
> {
    let source_projection::NativeSourceProjection {
        selection,
        authority,
        repair_record,
        source_stopped,
        updated_at_ms: source_updated_at_ms,
    } = source;
    let (selection, authority) = classify_verified_source(
        state,
        &body,
        selection,
        authority,
        source_stopped,
        &verified,
    )
    .await?;
    let resolved = verified_target_credential(
        state,
        &body.provider_id,
        body.target_credential.reference_id(),
        verified.receipt.launch_reference(),
    )
    .await?;
    let target_execution_profile =
        resolved
            .as_ref()
            .map_or(AgentExecutionProfileV1::ProviderDefault, |profile| {
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: profile.profile().reference_id.clone(),
                    credential_generation: Some(profile.profile().credential_generation.clone()),
                }
            });
    let retired_replacement_authority = match repair_record.as_ref() {
        Some(transition) => retire_failed_structured_replacement(state, transition).await?,
        None => None,
    };
    let retirement_updated_at_ms =
        replacement_authority_updated_at(retired_replacement_authority.as_ref());
    let repair_transition =
        repair_record.map(|transition| AgentRuntimeNativeRehostRepairTransitionV1 {
            operation_id: transition.intent.operation_id,
            expected_journal_revision: transition.journal_revision,
            retain_replacement_authority: false,
            retired_replacement_authority,
        });
    let committed_at_ms = super::now_ms()
        .map_err(|error| Stage::Clock.unavailable(error.to_string()))?
        .max(selection.updated_at_ms)
        .max(authority.updated_at_ms)
        .max(source_updated_at_ms)
        .max(retirement_updated_at_ms);
    let target_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: body.agent_id.clone(),
            runtime_kind_id: authority.binding.runtime_kind_id.clone(),
            session_id: body.target.session_id().into(),
            provider_conversation_id: verified.provider_conversation_id.clone(),
            credential_reference_id: match &target_execution_profile {
                AgentExecutionProfileV1::ProviderDefault => None,
                AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                    Some(reference_id.clone())
                }
            },
            binding_generation: authority
                .binding
                .binding_generation
                .checked_add(1)
                .ok_or_else(conflict)?,
            bound_at_ms: committed_at_ms,
        },
        runtime_workspace_id: body.target.workspace_id().into(),
        runner_principal: body.target.runner_principal().into(),
        runner_instance: body.target.runner_instance().into(),
        channel_epoch: body.target.channel_epoch().into(),
        host_instance_id: body.target.host_instance_id().into(),
        terminal_epoch: body.target.terminal_epoch().into(),
        updated_at_ms: committed_at_ms,
    };
    let committed = state
        .store
        .commit_agent_runtime_native_rehost(&AgentRuntimeNativeRehostCommitV1 {
            schema_version: AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1,
            operation_id: body.operation_id.clone(),
            request_source: AgentRuntimeNativeRehostSourceV1 {
                session_id: body.source.session_id().into(),
                workspace_id: body.source.workspace_id().into(),
                runner_principal: body.source.runner_principal().into(),
                runner_instance: body.source.runner_instance().into(),
                channel_epoch: body.source.channel_epoch().into(),
                host_instance_id: body.source.host_instance_id().into(),
                terminal_epoch: body.source.terminal_epoch().into(),
            },
            source_selection: selection,
            source_authority: authority,
            repair_transition,
            target_authority,
            target_execution_profile,
            target_permission_mode: verified.permission_mode.clone(),
            target_launch_idempotency_key: OperationIdV1::new(
                verified.receipt.replacement_receipt().idempotency_key(),
            )
            .map_err(|_| conflict())?,
            target_provider_launch_reference: verified
                .receipt
                .launch_reference()
                .map(ProviderLaunchReferenceV1::new)
                .transpose()
                .map_err(|error| Stage::Publication.store_error(error))?,
            committed_at_ms,
        })
        .await
        .map_err(|error| Stage::Publication.store_error(error))?;
    super::agent_runtime_transition_apply::native_rehost_receipt(
        &committed.selection,
        &committed.authority,
        &committed.receipt,
    )
    .map_err(|_| conflict())
}

#[cfg(test)]
mod credential_contract_tests {
    use super::*;

    #[test]
    fn native_rehost_credential_uses_the_canonical_execution_profile_domain() {
        let canonical: AgentRuntimeNativeRehostCredentialV1 =
            serde_json::from_value(serde_json::json!({
                "kind": "credential_reference",
                "referenceId": "credential-profile",
            }))
            .unwrap();
        canonical.validate().unwrap();

        let provider_launch_reference: AgentRuntimeNativeRehostCredentialV1 =
            serde_json::from_value(serde_json::json!({
                "kind": "credential_reference",
                "referenceId": "credential+profile",
            }))
            .unwrap();
        let error = provider_launch_reference.validate().unwrap_err();
        assert_eq!(error.code, "agent_runtime_native_rehost_conflict");
    }
}
