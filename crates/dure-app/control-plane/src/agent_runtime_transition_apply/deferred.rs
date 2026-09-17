//! Headless entry points reuse transition admission, fenced stop, and recovery.
use super::*;
use dure_app::AgentRuntimeTransitionWakeRequestV1;

pub(crate) mod idle;
pub(crate) mod idle_checkpoint;
mod idle_policy;
mod idle_window;
mod reclamation;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HibernateBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: AgentIdV1,
    pub(crate) expected_source_revision: i64,
    #[serde(default)]
    pub(crate) expected_idle: Option<ObservedIdleV1>,
}

/// The idle observer supplies its original source, not a request to find a new
/// idle generation. The existing transition journal retains the admitted fence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObservedIdleV1 {
    pub(crate) source_authority: AgentRuntimeBindingAuthorityV1,
    pub(crate) runtime_revision: u64,
    pub(crate) observed_through_output_seq: u64,
}

impl ObservedIdleV1 {
    fn policy(&self) -> AgentRuntimeSourceStopPolicyV1 {
        AgentRuntimeSourceStopPolicyV1::PreserveObserved {
            runtime_revision: self.runtime_revision,
            observed_through_output_seq: self.observed_through_output_seq,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WakeBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: AgentIdV1,
    pub(crate) operation_id: OperationIdV1,
    pub(crate) expected_journal_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expected_provider_conversation_ref: Option<String>,
}

pub(crate) async fn hibernate(
    state: &ServiceState,
    attempt_id: &str,
    body: HibernateBodyV1,
) -> Result<AgentRuntimeProjectionInspectObservationV1, crate::BackendDispatchError> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
        || body.expected_source_revision < 1
        || body.expected_idle.as_ref().is_some_and(|idle| {
            idle.runtime_revision == 0
                || idle.source_authority.provider_conversation_ref().is_none()
                || !matches!(
                    idle.source_authority,
                    AgentRuntimeBindingAuthorityV1::NativeCli { .. }
                )
        })
    {
        return Err("agent_runtime_hibernate_request_invalid".into());
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    if !state.is_mutation_authority() {
        return Err("recovering: backend authority is switching generations".into());
    }
    let source_stop_policy = body.expected_idle.as_ref().map_or(
        AgentRuntimeSourceStopPolicyV1::Preserve,
        ObservedIdleV1::policy,
    );
    let (operation_id, idempotency_key) = runtime_operation_identity(
        b"dure-agent-runtime-hibernate-attempt/v1\0",
        &[attempt_id.as_bytes()],
    )?;
    if let Some(existing) = state
        .store
        .agent_runtime_transition_by_idempotency_key(&idempotency_key)
        .await
        .map_err(store_error)?
    {
        if existing.intent.source.agent_id != body.agent_id
            || existing.intent.source.revision != body.expected_source_revision
            || existing.deferred_target.is_none()
            || existing.intent.source_stop_policy != source_stop_policy
            || body
                .expected_idle
                .as_ref()
                .is_some_and(|idle| existing.intent.source_authority != idle.source_authority)
        {
            return Err("agent_runtime_transition_idempotency_conflict".into());
        }
        // Response loss never authorizes another stop, including after wake.
        return inspect_projection_locked(state, body.agent_id)
            .await
            .map_err(Into::into);
    }
    let (source, authority) =
        match crate::agent_runtime_projection::read_locked(state, &body.agent_id).await? {
            crate::agent_runtime_projection::AgentRuntimeObservedV1::Stable {
                selection,
                authority,
            } => (selection, authority),
            _ => return Err("agent_runtime_hibernate_source_unavailable".into()),
        };
    if let Some(expected) = &body.expected_idle {
        if expected.source_authority != *authority
            || source.revision != body.expected_source_revision
        {
            return Err("agent_runtime_transition_conflict".into());
        }
    }
    let target_execution_profile = match (&*authority, &source.execution_profile) {
        (
            AgentRuntimeBindingAuthorityV1::NativeCli { .. },
            AgentExecutionProfileV1::CredentialReference {
                reference_id,
                credential_generation: None,
            },
        ) => {
            // Legacy adoption knows the logical account, not the generation
            // used by the running process. Pin only its future resume target;
            // normal admission and launch still verify the registered directory.
            let registered = state
                .credential_profiles
                .registered_reference(&source.provider_id, reference_id)
                .await
                .map_err(|error| error.code().to_string())?;
            Some(AgentExecutionProfileV1::CredentialReference {
                reference_id: reference_id.clone(),
                credential_generation: Some(registered.profile().credential_generation.clone()),
            })
        }
        _ => None,
    };
    let transition_body = AgentRuntimeTransitionApplyBodyV1 {
        schema_version: body.schema_version,
        agent_id: body.agent_id.clone(),
        expected_source_revision: Some(body.expected_source_revision),
        source_stop_policy,
        target_interaction_profile: source.interaction_profile,
        target_execution_profile,
        target_launch_selection: None,
    };
    let admission = admission::load_or_admit_with_activation(
        state,
        &transition_body,
        operation_id,
        idempotency_key,
        &request_replay::fingerprint(&transition_body)?,
        admission::TargetActivation::Deferred,
    )
    .await?;
    let AdmissionOutcome::Transition(transition) = admission else {
        return Err("agent_runtime_transition_conflict".into());
    };
    state.agent_runtime_recovery_wake.notify_one();
    // A retained source is a refusal, not a successful hibernation. Only the
    // deferred stop boundary is projected as sleeping.
    let outcome = drive_locked(state, *transition).await?;
    if !matches!(outcome, TransitionDriveOutcome::Deferred) {
        drive_outcome(outcome)?;
    }
    inspect_projection_locked(state, body.agent_id)
        .await
        .map_err(Into::into)
}

pub(crate) async fn wake(
    state: &ServiceState,
    attempt_id: &str,
    body: WakeBodyV1,
) -> Result<AgentRuntimeProjectionInspectObservationV1, crate::BackendDispatchError> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
        || body.expected_journal_revision < 1
    {
        return Err("agent_runtime_wake_request_invalid".into());
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    if !state.is_mutation_authority() {
        return Err("recovering: backend authority is switching generations".into());
    }
    let current = state
        .store
        .agent_runtime_transition(&body.operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_wake_transition_unavailable".to_string())?;
    if current.intent.source.agent_id != body.agent_id {
        return Err("agent_runtime_transition_conflict".into());
    }
    // A historical pane cannot wake a different conversation and only discover
    // that mismatch after launch. The journal remains the identity authority.
    if body
        .expected_provider_conversation_ref
        .as_deref()
        .is_some_and(|expected| {
            current.intent.provider_conversation_ref.as_option() != Some(expected)
        })
    {
        return Err("agent_runtime_transition_conflict".into());
    }
    // Bind replay to the exact journal cycle and revision, as repair does. An
    // earlier input cannot authorize a later hibernation of this same Agent.
    let canonical = serde_json::to_string(&body)
        .map_err(|_| "agent_runtime_wake_request_invalid".to_string())?;
    let (wake_operation_id, _) = runtime_operation_identity(
        b"dure-agent-runtime-wake-attempt/v1\0",
        &[canonical.as_bytes(), attempt_id.as_bytes()],
    )?;
    let authorization = state
        .store
        .authorize_agent_runtime_transition_wake(&AgentRuntimeTransitionWakeRequestV1 {
            schema_version: body.schema_version,
            operation_id: body.operation_id,
            expected_journal_revision: body.expected_journal_revision,
            wake_operation_id,
            woken_at_ms: clock_at_least(current.updated_at_ms)?,
        })
        .await
        .map_err(store_error)?;
    if let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(transition) = authorization {
        state.agent_runtime_recovery_wake.notify_one();
        drive_outcome(drive_locked(state, transition).await?)?;
    }
    inspect_projection_locked(state, body.agent_id)
        .await
        .map_err(Into::into)
}
