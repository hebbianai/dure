use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1, AgentClientMessageIdV1,
    AgentDispatchStopStateV1, AgentDispatchStopStore, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionProfileV1, AgentProviderConversationPlanV1,
    AgentProviderPromptTargetV1, AgentRuntimeSelectionV1, AgentRuntimeTransitionStore,
    AgentSpawnEffortSelectionV1, AgentSpawnJournalEventBodyV1, AgentSpawnJournalEventV1,
    AgentSpawnJournalReceiptV1, AgentSpawnJournalStateV1, AgentSpawnJournalStore,
    AgentSpawnLaunchPlanV1, AgentSpawnModelSelectionV1, AgentSpawnPermissionModeV1,
    AgentSpawnPlanTokenV1, AgentSpawnRecoveryDirectiveV1, AgentSpawnStageDispositionV1,
    AgentSpawnStageEvidenceV1, AgentSpawnStageInputsV1, AgentSpawnStageV1,
    AgentSpawnTerminalOutcomeV1, AgentSpawnWorktreePolicyV1, AgentTurnEffectReceiptV1,
    AgentTurnEffectStateV1, AgentTurnIdV1, DomainStore, OperationEventIdV1, OperationIdV1,
    ProviderIdV1, SessionBindingRecordV1, WorkflowPromptActivityObservationRequestV1,
    WorkflowPromptActivityObserver, WorkflowPromptActivityStateV1, WorkflowPromptDeliverer,
    WorkflowPromptDeliveryIntentV1, WorkflowPromptDeliveryRequestV1, WorkflowSessionGenerationV1,
    WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchRequestV1,
    agent_provider_launch_prompt_is_valid, structured_prompt_identity,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::ProviderStateEnvironment;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::agent_spawn_support::{random_nonce, store_error};
use crate::project_catalog::ProjectAuthority;
use crate::provider_credential_profile::ProviderCredentialProfileRegistry;
use crate::workflow_launch::CredentialAwareWorkflowSessionLauncher;
use crate::workspace_git::{WorkspaceAcquireRequest, WorkspaceAcquirer, WorkspaceHandle};

const MAX_PROMPT_BYTES: usize = 16 * 1024;

mod workspace;
use workspace::{
    record_checkout_registration, resolve_workspace, validate_workspace_handle, workspace_request,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSpawnApplyBody {
    pub(crate) schema_version: u16,
    pub(crate) operation_id: OperationIdV1,
    pub(crate) plan_token: AgentSpawnPlanTokenV1,
    pub(crate) expected_last_sequence: u32,
    #[serde(default)]
    pub(crate) prompt: Option<String>,
}

pub(crate) struct AgentSpawnExecution<'a> {
    pub(crate) project_root: PathBuf,
    pub(crate) project_display_name: String,
    pub(crate) workspace_acquirer: &'a dyn WorkspaceAcquirer,
    pub(crate) launch: AgentSpawnLaunchExecution<'a>,
}

pub(crate) type ProviderStatePreparationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProviderStateEnvironment, String>> + Send + 'a>>;

pub(crate) trait AgentSpawnProviderStatePreparer: Send + Sync {
    fn prepare<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
        execution_profile: &'a AgentExecutionProfileV1,
    ) -> ProviderStatePreparationFuture<'a>;
}

impl AgentSpawnProviderStatePreparer for ProviderCredentialProfileRegistry<SqliteDomainStore> {
    fn prepare<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
        execution_profile: &'a AgentExecutionProfileV1,
    ) -> ProviderStatePreparationFuture<'a> {
        Box::pin(async move {
            self.prepare_for_launch(provider_id, execution_profile)
                .await
                .map(|prepared| prepared.environment())
                .map_err(|error| error.code().to_string())
        })
    }
}

pub(crate) enum AgentSpawnLaunchExecution<'a> {
    NativeCli {
        provider_executable: String,
        provider_arguments: Vec<String>,
        provider_resume_arguments: Option<Vec<String>>,
        prompt_target: AgentProviderPromptTargetV1,
        launcher: &'a dyn CredentialAwareWorkflowSessionLauncher,
        provider_state_preparer: &'a dyn AgentSpawnProviderStatePreparer,
        prompt_deliverer: &'a dyn WorkflowPromptDeliverer,
        /// Writing the prompt into the PTY is not evidence that the provider
        /// read it — a spawn once reported success for an agent that had been
        /// handed nothing (2026-09-01). The stage commits only after the
        /// provider reacts, and this is who watches for that.
        prompt_activity_observer: &'a dyn WorkflowPromptActivityObserver,
    },
    StructuredProtocol {
        launcher: &'a dyn StructuredAgentSessionLauncher,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct StructuredAgentLaunchRequest {
    pub(crate) agent_id: AgentIdV1,
    pub(crate) execution_profile: AgentExecutionProfileV1,
    pub(crate) permission_mode: AgentSpawnPermissionModeV1,
    pub(crate) model: Option<AgentSpawnModelSelectionV1>,
    pub(crate) effort: Option<AgentSpawnEffortSelectionV1>,
    pub(crate) provider_conversation_ref: AgentProviderConversationPlanV1,
}

#[derive(Clone, Debug)]
pub(crate) struct StructuredAgentPromptRequest {
    pub(crate) binding: AgentInteractionBindingV1,
    pub(crate) turn_id: AgentTurnIdV1,
    pub(crate) client_message_id: AgentClientMessageIdV1,
    pub(crate) input: String,
    pub(crate) requested_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StructuredAgentLaunchFailure {
    pub(crate) code: String,
    /// What the failing layer said, when it said anything — the host's stderr
    /// tail, say. Rides to the receipt so an operator reading a failed spawn
    /// sees the cause, not only the code (2026-08-31: a day was spent
    /// rediscovering a cause the backend already knew).
    pub(crate) detail: Option<String>,
}

pub(crate) type StructuredLaunchFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<AgentInteractionBindingV1, StructuredAgentLaunchFailure>>
            + Send
            + 'a,
    >,
>;
pub(crate) type StructuredPromptFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<AgentTurnEffectReceiptV1, StructuredAgentLaunchFailure>>
            + Send
            + 'a,
    >,
>;

pub(crate) trait StructuredAgentSessionLauncher: Send + Sync {
    fn launch(&self, request: StructuredAgentLaunchRequest) -> StructuredLaunchFuture<'_>;
    fn start_turn(&self, request: StructuredAgentPromptRequest) -> StructuredPromptFuture<'_>;
}

pub(crate) async fn authorize(
    store: &SqliteDomainStore,
    backend_id: &str,
    body: &AgentSpawnApplyBody,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    if body.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
        || body.expected_last_sequence < 1
        || body.prompt.as_ref().is_some_and(|prompt| {
            prompt.is_empty()
                || prompt.len() > MAX_PROMPT_BYTES
                || prompt
                    .chars()
                    .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        })
    {
        return Err("agent_spawn_apply_request_invalid".into());
    }
    let receipt = store
        .agent_spawn_receipt(&body.operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_spawn_operation_not_found".to_string())?;
    if receipt.plan.plan_token != body.plan_token || receipt.plan.authority.backend_id != backend_id
    {
        return Err("agent_spawn_apply_authority_mismatch".into());
    }
    if receipt.last_sequence != body.expected_last_sequence
        && !(receipt.state == AgentSpawnJournalStateV1::Succeeded
            && body.expected_last_sequence < receipt.last_sequence)
    {
        return Err("agent_spawn_revision_conflict".into());
    }
    match (&receipt.plan.request.prompt_digest, &body.prompt) {
        (None, None) => {}
        (Some(expected), Some(prompt))
            if *expected == dure_app::AgentSpawnPromptDigestV1::sha256(prompt) => {}
        _ => return Err("agent_spawn_prompt_mismatch".into()),
    }
    if receipt.state != AgentSpawnJournalStateV1::Succeeded {
        let stop = store
            .agent_dispatch_stop_for_spawn_operation(&receipt.operation_id)
            .await
            .map_err(store_error)?;
        if stop.is_some_and(|stop| !matches!(stop.state(), AgentDispatchStopStateV1::Superseded)) {
            return Err("agent_spawn_stop_in_progress".into());
        }
    }
    Ok(receipt)
}

pub(crate) fn validate_project_authority(
    receipt: &AgentSpawnJournalReceiptV1,
    project: &ProjectAuthority,
) -> Result<(), String> {
    let projection = project.projection();
    if projection.id != receipt.plan.authority.project_id.as_str()
        || projection.root_id != receipt.plan.authority.root_id
        || projection.repository_id != receipt.plan.authority.repository_id
    {
        return Err("agent_spawn_project_authority_changed".into());
    }
    Ok(())
}

/// Terminal and journal-only transitions must replay without consulting mutable adapters.
pub(crate) fn requires_external_context(receipt: &AgentSpawnJournalReceiptV1) -> bool {
    !matches!(
        receipt.recovery,
        AgentSpawnRecoveryDirectiveV1::None
            | AgentSpawnRecoveryDirectiveV1::Finish
            | AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { .. }
    )
}

pub(crate) async fn apply(
    store: &SqliteDomainStore,
    mut receipt: AgentSpawnJournalReceiptV1,
    body: &AgentSpawnApplyBody,
    execution: Option<AgentSpawnExecution<'_>>,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    let mut workspace_root = None;
    loop {
        match receipt.recovery.clone() {
            AgentSpawnRecoveryDirectiveV1::None => return Ok(receipt),
            AgentSpawnRecoveryDirectiveV1::Finish => {
                receipt = append(store, &receipt, AgentSpawnJournalEventBodyV1::Succeeded).await?;
            }
            AgentSpawnRecoveryDirectiveV1::Continue {
                stage,
                next_attempt,
            } => {
                if stage != AgentSpawnStageV1::Worktree && workspace_root.is_none() {
                    workspace_root =
                        Some(resolve_workspace(store, &mut receipt, execution.as_ref()).await?);
                }
                receipt = prepare_stage(store, &receipt, stage, next_attempt).await?;
                receipt = execute_prepared_stage(
                    store,
                    receipt,
                    next_attempt,
                    body,
                    execution.as_ref(),
                    workspace_root.as_deref(),
                )
                .await?;
                if requires_client_action(&receipt.recovery) {
                    return Ok(receipt);
                }
            }
            AgentSpawnRecoveryDirectiveV1::InspectBeforeRetry { attempt, inputs } => {
                if inputs.stage() != AgentSpawnStageV1::Worktree && workspace_root.is_none() {
                    workspace_root =
                        Some(resolve_workspace(store, &mut receipt, execution.as_ref()).await?);
                }
                receipt = execute_prepared_stage(
                    store,
                    receipt,
                    attempt,
                    body,
                    execution.as_ref(),
                    workspace_root.as_deref(),
                )
                .await?;
                if requires_client_action(&receipt.recovery) {
                    return Ok(receipt);
                }
            }
            AgentSpawnRecoveryDirectiveV1::RetryRequired {
                stage,
                failed_attempt,
                ..
            } => {
                receipt = append(
                    store,
                    &receipt,
                    AgentSpawnJournalEventBodyV1::RetryAuthorized {
                        stage,
                        failed_attempt,
                    },
                )
                .await?;
            }
            AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { .. } => return Ok(receipt),
        }
    }
}

fn requires_client_action(recovery: &AgentSpawnRecoveryDirectiveV1) -> bool {
    matches!(
        recovery,
        AgentSpawnRecoveryDirectiveV1::InspectBeforeRetry { .. }
            | AgentSpawnRecoveryDirectiveV1::RetryRequired { .. }
            | AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { .. }
    )
}

async fn prepare_stage(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    stage: AgentSpawnStageV1,
    attempt: u32,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    let plan = &receipt.plan;
    let inputs = match stage {
        AgentSpawnStageV1::Worktree => AgentSpawnStageInputsV1::Worktree {
            workspace_id: plan.workspace_id.clone(),
            project_root_id: plan.authority.root_id.clone(),
            repository_id: plan.authority.repository_id.clone(),
            policy: plan.request.worktree.clone(),
        },
        AgentSpawnStageV1::RuntimeLaunch => {
            let (session_id, runtime) = native_launch(plan)?;
            AgentSpawnStageInputsV1::RuntimeLaunch {
                agent_id: plan.agent_id.clone(),
                workspace_id: plan.workspace_id.clone(),
                session_id: session_id.into(),
                runtime_kind_id: runtime.runtime_kind_id.clone(),
                provider_id: plan.request.provider_id.clone(),
                provider_conversation_ref: plan.request.provider_conversation_ref.clone(),
                permission_mode: plan.request.permission_mode.clone(),
                setup_command: plan.request.setup_command.clone(),
                model: plan.request.model.clone(),
                effort: plan.request.effort.clone(),
            }
        }
        AgentSpawnStageV1::PromptDelivery => {
            let session_id = runtime_session(receipt)?.session_id;
            AgentSpawnStageInputsV1::PromptDelivery {
                session_id,
                prompt_digest: plan
                    .request
                    .prompt_digest
                    .clone()
                    .ok_or_else(|| "agent_spawn_prompt_mismatch".to_string())?,
            }
        }
        AgentSpawnStageV1::StructuredLaunch => AgentSpawnStageInputsV1::StructuredLaunch {
            agent_id: plan.agent_id.clone(),
            workspace_id: plan.workspace_id.clone(),
            provider_id: plan.request.provider_id.clone(),
            execution_profile: plan.request.execution_profile.clone(),
            provider_conversation_ref: plan.request.provider_conversation_ref.clone(),
        },
        AgentSpawnStageV1::StructuredPromptDelivery => {
            let binding = structured_binding(receipt)?;
            let (turn_id, client_message_id) = structured_prompt_identity(&plan.operation_id)
                .ok_or_else(|| "agent_spawn_structured_prompt_identity_invalid".to_string())?;
            AgentSpawnStageInputsV1::StructuredPromptDelivery {
                interaction_session_id: binding.interaction_session_id.clone(),
                runtime: binding.runtime.clone(),
                turn_id,
                client_message_id,
                prompt_digest: plan
                    .request
                    .prompt_digest
                    .clone()
                    .ok_or_else(|| "agent_spawn_prompt_mismatch".to_string())?,
            }
        }
    };
    append(
        store,
        receipt,
        AgentSpawnJournalEventBodyV1::StagePrepared { attempt, inputs },
    )
    .await
}

async fn execute_prepared_stage(
    store: &SqliteDomainStore,
    receipt: AgentSpawnJournalReceiptV1,
    attempt: u32,
    body: &AgentSpawnApplyBody,
    execution: Option<&AgentSpawnExecution<'_>>,
    workspace_root: Option<&str>,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    let inputs = match &receipt.recovery {
        AgentSpawnRecoveryDirectiveV1::InspectBeforeRetry { inputs, .. }
        | AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { inputs, .. } => inputs,
        _ => return Err("agent_spawn_journal_state_invalid".into()),
    };
    if matches!(
        inputs.stage(),
        AgentSpawnStageV1::RuntimeLaunch | AgentSpawnStageV1::StructuredLaunch
    ) {
        let execution =
            execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
        let workspace_root =
            workspace_root.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
        if let Err(error_code) = crate::agent_spawn_records::prepare(
            store,
            &receipt,
            &execution.project_root,
            &execution.project_display_name,
            workspace_root,
            clock_ms()?.max(receipt.updated_at_ms),
        )
        .await
        {
            return append(
                store,
                &receipt,
                AgentSpawnJournalEventBodyV1::StageFailed {
                    stage: inputs.stage(),
                    attempt,
                    error_code,
                    error_detail: None,
                    may_have_written: None,
                },
            )
            .await;
        }
    }
    match inputs.stage() {
        AgentSpawnStageV1::Worktree => {
            let execution =
                execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let request = workspace_request(&receipt, execution)?;
            match execution.workspace_acquirer.acquire(request).await {
                Ok(handle) => {
                    validate_workspace_handle(&receipt, &handle)?;
                    let receipt = record_checkout_registration(store, receipt, &handle).await?;
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageCommitted {
                            attempt,
                            evidence: AgentSpawnStageEvidenceV1::Worktree {
                                workspace_id: receipt.plan.workspace_id.clone(),
                                disposition: handle.disposition,
                                lease: handle.lease,
                            },
                        },
                    )
                    .await
                }
                Err(failure) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::Worktree,
                            attempt,
                            error_code: failure.code,
                            error_detail: failure.detail,
                            may_have_written: None,
                        },
                    )
                    .await
                }
            }
        }
        AgentSpawnStageV1::RuntimeLaunch => {
            let execution =
                execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let AgentSpawnLaunchExecution::NativeCli {
                provider_executable,
                provider_arguments,
                provider_resume_arguments,
                prompt_target,
                launcher,
                provider_state_preparer,
                ..
            } = &execution.launch
            else {
                return Err("agent_spawn_execution_context_mismatch".into());
            };
            let workspace_root = workspace_root
                .ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let (session_id, runtime) = native_launch(&receipt.plan)?;
            let initial_prompt = body
                .prompt
                .as_ref()
                .filter(|prompt| {
                    *prompt_target == AgentProviderPromptTargetV1::LaunchArgument
                        && agent_provider_launch_prompt_is_valid(prompt)
                })
                .cloned();
            let initial_prompt_accepted = initial_prompt.is_some();
            let launch = WorkflowSessionLaunchRequestV1 {
                runtime_kind_id: runtime.runtime_kind_id.clone(),
                launch_idempotency_key: format!(
                    "spawn-runtime:{}",
                    receipt.plan.operation_id.as_str()
                ),
                session_id: session_id.into(),
                workspace_id: receipt.plan.workspace_id.as_str().into(),
                provider_id: receipt.plan.request.provider_id.clone(),
                provider_conversation_ref: receipt
                    .plan
                    .request
                    .provider_conversation_ref
                    .as_option()
                    .map(str::to_string),
                permission_mode: receipt.plan.request.permission_mode.clone(),
                provider_executable: provider_executable.clone(),
                provider_arguments: provider_arguments.clone(),
                provider_resume: dure_app::WorkflowSessionResumePlanV1::from_arguments(
                    provider_resume_arguments.clone(),
                    &receipt.plan.request.execution_profile,
                ),
                initial_prompt,
                working_directory: workspace_root.into(),
                prelaunch_command: receipt.plan.request.setup_command.clone(),
            };
            launch
                .validate()
                .map_err(|_| "agent_spawn_runtime_request_invalid".to_string())?;
            let provider_state_environment = provider_state_preparer
                .prepare(
                    &receipt.plan.request.provider_id,
                    &receipt.plan.request.execution_profile,
                )
                .await?;
            match launcher
                .launch_with_provider_state(launch.clone(), provider_state_environment, None)
                .await
            {
                Ok(launch_receipt) if launch_receipt.validate_for_request(&launch).is_ok() => {
                    let WorkflowSessionLaunchReceiptV1 {
                        launch_idempotency_key,
                        session,
                    } = launch_receipt;
                    match persist_native_runtime_selection(store, &receipt, &session).await {
                        Ok(()) => {
                            append(
                                store,
                                &receipt,
                                AgentSpawnJournalEventBodyV1::StageCommitted {
                                    attempt,
                                    evidence: AgentSpawnStageEvidenceV1::RuntimeLaunch {
                                        session,
                                        launch_idempotency_key: Some(launch_idempotency_key),
                                        initial_prompt_accepted,
                                    },
                                },
                            )
                            .await
                        }
                        Err(error_code) => {
                            append(
                                store,
                                &receipt,
                                AgentSpawnJournalEventBodyV1::StageFailed {
                                    stage: AgentSpawnStageV1::RuntimeLaunch,
                                    attempt,
                                    error_code,
                                    error_detail: None,
                                    may_have_written: None,
                                },
                            )
                            .await
                        }
                    }
                }
                Ok(_) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::Terminated {
                            outcome: AgentSpawnTerminalOutcomeV1::ManualInterventionRequired,
                            error_code: "agent_spawn_runtime_identity_mismatch".into(),
                        },
                    )
                    .await
                }
                Err(failure) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::RuntimeLaunch,
                            attempt,
                            error_code: failure.code,
                            error_detail: None,
                            may_have_written: None,
                        },
                    )
                    .await
                }
            }
        }
        AgentSpawnStageV1::PromptDelivery => {
            let execution =
                execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let AgentSpawnLaunchExecution::NativeCli {
                prompt_deliverer,
                prompt_activity_observer,
                ..
            } = &execution.launch
            else {
                return Err("agent_spawn_execution_context_mismatch".into());
            };
            let prompt = body
                .prompt
                .clone()
                .ok_or_else(|| "agent_spawn_prompt_mismatch".to_string())?;
            let session = runtime_session(&receipt)?;
            let session_id = session.session_id.clone();
            if runtime_launch_accepted_initial_prompt(&receipt) {
                return append(
                    store,
                    &receipt,
                    AgentSpawnJournalEventBodyV1::StageCommitted {
                        attempt,
                        evidence: AgentSpawnStageEvidenceV1::PromptDelivery {
                            session_id,
                            delivery_id: format!(
                                "launch-prompt:{}",
                                receipt.plan.operation_id.as_str()
                            ),
                        },
                    },
                )
                .await;
            }
            let delivery_session = session.clone();
            let (_, runtime) = native_launch(&receipt.plan)?;
            let delivery = WorkflowPromptDeliveryRequestV1 {
                runtime_kind_id: runtime.runtime_kind_id.clone(),
                delivery_idempotency_key: format!(
                    "spawn-prompt:{}",
                    receipt.plan.operation_id.as_str()
                ),
                session,
                intent: WorkflowPromptDeliveryIntentV1::FreshAgent,
                handoff: prompt,
            };
            match prompt_deliverer.deliver(delivery).await {
                Ok(evidence) => {
                    let delivery_id = delivery_evidence_id(&evidence);
                    // Bytes reaching the PTY is not the task being taken up.
                    // The provider has to react, or the spawn says so instead
                    // of handing back a success for an idle agent.
                    if let Some(failure) = prompt_went_unanswered(
                        *prompt_activity_observer,
                        runtime,
                        &delivery_session,
                        &evidence,
                    )
                    .await
                    {
                        return append(
                            store,
                            &receipt,
                            AgentSpawnJournalEventBodyV1::StageFailed {
                                stage: AgentSpawnStageV1::PromptDelivery,
                                attempt,
                                error_code: "agent_spawn_prompt_unanswered".into(),
                                error_detail: Some(failure),
                                may_have_written: Some(true),
                            },
                        )
                        .await;
                    }
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageCommitted {
                            attempt,
                            evidence: AgentSpawnStageEvidenceV1::PromptDelivery {
                                session_id,
                                delivery_id,
                            },
                        },
                    )
                    .await
                }
                Err(failure) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::PromptDelivery,
                            attempt,
                            error_code: failure.code,
                            error_detail: None,
                            may_have_written: Some(failure.may_have_written),
                        },
                    )
                    .await
                }
            }
        }
        AgentSpawnStageV1::StructuredLaunch => {
            let execution =
                execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let AgentSpawnLaunchExecution::StructuredProtocol { launcher } = &execution.launch
            else {
                return Err("agent_spawn_execution_context_mismatch".into());
            };
            let request = StructuredAgentLaunchRequest {
                agent_id: receipt.plan.agent_id.clone(),
                execution_profile: receipt.plan.request.execution_profile.clone(),
                permission_mode: receipt.plan.request.permission_mode.clone(),
                model: receipt.plan.request.model.clone(),
                effort: receipt.plan.request.effort.clone(),
                provider_conversation_ref: receipt.plan.request.provider_conversation_ref.clone(),
            };
            match launcher.launch(request).await {
                Ok(binding) if exact_structured_identity(&receipt, &binding) => {
                    match persist_structured_runtime_selection(store, &receipt, &binding).await {
                        Ok(()) => {
                            append(
                                store,
                                &receipt,
                                AgentSpawnJournalEventBodyV1::StageCommitted {
                                    attempt,
                                    evidence: AgentSpawnStageEvidenceV1::StructuredLaunch {
                                        binding,
                                    },
                                },
                            )
                            .await
                        }
                        Err(error_code) => {
                            append(
                                store,
                                &receipt,
                                AgentSpawnJournalEventBodyV1::StageFailed {
                                    stage: AgentSpawnStageV1::StructuredLaunch,
                                    attempt,
                                    error_code,
                                    error_detail: None,
                                    may_have_written: None,
                                },
                            )
                            .await
                        }
                    }
                }
                Ok(_) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::Terminated {
                            outcome: AgentSpawnTerminalOutcomeV1::ManualInterventionRequired,
                            error_code: "agent_spawn_structured_identity_mismatch".into(),
                        },
                    )
                    .await
                }
                Err(failure) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::StructuredLaunch,
                            attempt,
                            error_code: failure.code,
                            error_detail: failure.detail,
                            may_have_written: None,
                        },
                    )
                    .await
                }
            }
        }
        AgentSpawnStageV1::StructuredPromptDelivery => {
            let execution =
                execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
            let AgentSpawnLaunchExecution::StructuredProtocol { launcher } = &execution.launch
            else {
                return Err("agent_spawn_execution_context_mismatch".into());
            };
            let prompt = body
                .prompt
                .clone()
                .ok_or_else(|| "agent_spawn_prompt_mismatch".to_string())?;
            let binding = structured_binding(&receipt)?.clone();
            let AgentSpawnStageInputsV1::StructuredPromptDelivery {
                interaction_session_id,
                runtime,
                turn_id,
                client_message_id,
                ..
            } = inputs
            else {
                return Err("agent_spawn_journal_state_invalid".into());
            };
            let request = StructuredAgentPromptRequest {
                binding: binding.clone(),
                turn_id: turn_id.clone(),
                client_message_id: client_message_id.clone(),
                input: prompt,
                requested_at_ms: clock_ms()?,
            };
            match launcher.start_turn(request).await {
                Ok(effect)
                    if effect.state == AgentTurnEffectStateV1::Accepted
                        && effect.intent.interaction_session_id == *interaction_session_id
                        && effect.intent.runtime == *runtime
                        && effect.intent.turn_id == *turn_id
                        && effect.intent.client_message_id == *client_message_id =>
                {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageCommitted {
                            attempt,
                            evidence: AgentSpawnStageEvidenceV1::StructuredPromptDelivery {
                                interaction_session_id: binding.interaction_session_id,
                                runtime: binding.runtime,
                                turn_id: turn_id.clone(),
                                client_message_id: client_message_id.clone(),
                            },
                        },
                    )
                    .await
                }
                Ok(_) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::StructuredPromptDelivery,
                            attempt,
                            error_code: "agent_spawn_structured_prompt_failed".into(),
                            error_detail: None,
                            may_have_written: None,
                        },
                    )
                    .await
                }
                Err(failure) => {
                    append(
                        store,
                        &receipt,
                        AgentSpawnJournalEventBodyV1::StageFailed {
                            stage: AgentSpawnStageV1::StructuredPromptDelivery,
                            attempt,
                            error_code: failure.code,
                            error_detail: failure.detail,
                            may_have_written: None,
                        },
                    )
                    .await
                }
            }
        }
    }
}

async fn persist_native_runtime_selection(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    session: &WorkflowSessionGenerationV1,
) -> Result<(), String> {
    let (_, runtime) = native_launch(&receipt.plan)?;
    let observed_at_ms = clock_ms()?.max(receipt.updated_at_ms);
    let credential_reference_id = match &receipt.plan.request.execution_profile {
        AgentExecutionProfileV1::ProviderDefault => None,
        AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
            Some(reference_id.clone())
        }
    };
    let existing = store
        .agent_checkpoint_binding_authority(&receipt.plan.agent_id)
        .await
        .map_err(|_| "agent_spawn_native_binding_failed".to_string())?;
    let exact = existing.as_ref().is_some_and(|authority| {
        authority.binding.runtime_kind_id == runtime.runtime_kind_id
            && authority.binding.session_id == session.session_id
            && authority.binding.credential_reference_id == credential_reference_id
            && authority.binding.provider_conversation_id.as_deref()
                == receipt.plan.request.provider_conversation_ref.as_option()
            && authority.runtime_workspace_id == session.workspace_id
            && authority.runner_principal == session.runner_principal
            && authority.runner_instance == session.runner_instance
            && authority.channel_epoch == session.channel_epoch
            && authority.host_instance_id == session.host_instance_id
            && authority.terminal_epoch == session.terminal_epoch
    });
    if !exact {
        let binding_generation = existing.as_ref().map_or(Ok(1), |authority| {
            authority
                .binding
                .binding_generation
                .checked_add(1)
                .ok_or_else(|| "agent_spawn_native_binding_failed".to_string())
        })?;
        store
            .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
                schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                binding: SessionBindingRecordV1 {
                    agent_id: receipt.plan.agent_id.clone(),
                    runtime_kind_id: runtime.runtime_kind_id.clone(),
                    session_id: session.session_id.clone(),
                    provider_conversation_id: receipt
                        .plan
                        .request
                        .provider_conversation_ref
                        .as_option()
                        .map(str::to_string),
                    credential_reference_id,
                    binding_generation,
                    bound_at_ms: observed_at_ms,
                },
                runtime_workspace_id: session.workspace_id.clone(),
                runner_principal: session.runner_principal.clone(),
                runner_instance: session.runner_instance.clone(),
                channel_epoch: session.channel_epoch.clone(),
                host_instance_id: session.host_instance_id.clone(),
                terminal_epoch: session.terminal_epoch.clone(),
                updated_at_ms: observed_at_ms,
            })
            .await
            .map_err(|_| "agent_spawn_native_binding_failed".to_string())?;
    }
    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: receipt.plan.agent_id.clone(),
            provider_id: receipt.plan.request.provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: receipt.plan.request.execution_profile.clone(),
            permission_mode: receipt.plan.request.permission_mode.clone(),
            model: receipt.plan.request.model.clone(),
            effort: receipt.plan.request.effort.clone(),
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: receipt.created_at_ms,
        })
        .await
        .map_err(|_| "agent_spawn_runtime_selection_failed".to_string())?;
    Ok(())
}

async fn persist_structured_runtime_selection(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    binding: &AgentInteractionBindingV1,
) -> Result<(), String> {
    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: binding.agent_id.clone(),
            provider_id: binding.provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: binding.execution_profile.clone(),
            permission_mode: receipt.plan.request.permission_mode.clone(),
            model: receipt.plan.request.model.clone(),
            effort: receipt.plan.request.effort.clone(),
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: receipt.created_at_ms,
        })
        .await
        .map_err(|_| "agent_spawn_runtime_selection_failed".to_string())?;
    Ok(())
}

fn exact_structured_identity(
    receipt: &AgentSpawnJournalReceiptV1,
    binding: &AgentInteractionBindingV1,
) -> bool {
    matches!(
        receipt.plan.launch,
        AgentSpawnLaunchPlanV1::StructuredProtocol
    ) && binding.agent_id == receipt.plan.agent_id
        && binding.provider_id == receipt.plan.request.provider_id
        && binding.execution_profile == receipt.plan.request.execution_profile
        && receipt
            .plan
            .request
            .provider_conversation_ref
            .as_option()
            .is_none_or(|expected| binding.provider_conversation_ref.as_deref() == Some(expected))
}

fn native_launch(
    plan: &dure_app::AgentSpawnPlanV1,
) -> Result<(&str, &dure_app::AgentSpawnRuntimePlanV1), String> {
    match &plan.launch {
        AgentSpawnLaunchPlanV1::NativeCli {
            session_id,
            runtime,
        } => Ok((session_id, runtime)),
        AgentSpawnLaunchPlanV1::StructuredProtocol => {
            Err("agent_spawn_interaction_profile_mismatch".into())
        }
    }
}

fn structured_binding(
    receipt: &AgentSpawnJournalReceiptV1,
) -> Result<&AgentInteractionBindingV1, String> {
    receipt
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            AgentSpawnStageEvidenceV1::StructuredLaunch { binding } => Some(binding),
            _ => None,
        })
        .ok_or_else(|| "agent_spawn_structured_receipt_missing".to_string())
}

fn runtime_session(
    receipt: &AgentSpawnJournalReceiptV1,
) -> Result<WorkflowSessionGenerationV1, String> {
    receipt
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => Some(session.clone()),
            _ => None,
        })
        .ok_or_else(|| "agent_spawn_runtime_receipt_missing".to_string())
}

fn runtime_launch_accepted_initial_prompt(receipt: &AgentSpawnJournalReceiptV1) -> bool {
    receipt.completed.iter().any(|stage| {
        matches!(
            &stage.evidence,
            AgentSpawnStageEvidenceV1::RuntimeLaunch {
                initial_prompt_accepted: true,
                ..
            }
        )
    })
}

/// Watches for the provider reacting to a prompt that has already reached the
/// PTY. Returns the evidence of a non-answer when the provider stayed silent,
/// or None when it reacted.
///
/// Why the spawn waits at all: the delivery receipt proves the bytes were
/// written, and nothing more. A provider that never read them — because the
/// terminal was still running something else, or because its input loop was
/// not up — leaves an agent sitting with no task, and the saga used to call
/// that success (2026-09-01).
async fn prompt_went_unanswered(
    observer: &dyn WorkflowPromptActivityObserver,
    runtime: &dure_app::AgentSpawnRuntimePlanV1,
    session: &WorkflowSessionGenerationV1,
    evidence: &dure_app::WorkflowPromptDeliveryEvidenceV1,
) -> Option<String> {
    let observation = WorkflowPromptActivityObservationRequestV1 {
        runtime_kind_id: runtime.runtime_kind_id.clone(),
        session: session.clone(),
        input_baseline_output_sequence: evidence.input_baseline_output_sequence().into(),
    };
    match observer.observe(observation).await {
        Ok(activity) => match activity.state {
            WorkflowPromptActivityStateV1::Observed => None,
            WorkflowPromptActivityStateV1::Stalled => Some(format!(
                "the provider produced no output after the prompt (through output seq {})",
                activity.observed_output_seq
            )),
            WorkflowPromptActivityStateV1::Failed => Some(format!(
                "prompt activity could not be observed ({})",
                activity.error_code.unwrap_or_else(|| "unknown".into())
            )),
        },
        Err(failure) => Some(format!(
            "prompt activity could not be observed ({})",
            failure.code
        )),
    }
}

fn delivery_evidence_id(evidence: &dure_app::WorkflowPromptDeliveryEvidenceV1) -> String {
    let mut hash = Sha256::new();
    for value in evidence.delivery_identity_parts() {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let digest = format!("{:x}", hash.finalize());
    format!("delivery-{}", &digest[..32])
}

async fn append(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    body: AgentSpawnJournalEventBodyV1,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    let sequence = receipt
        .last_sequence
        .checked_add(1)
        .ok_or_else(|| "agent_spawn_journal_exhausted".to_string())?;
    let nonce = random_nonce()?;
    let recorded_at_ms = clock_ms()?.max(receipt.updated_at_ms);
    store
        .append_agent_spawn_event(&AgentSpawnJournalEventV1 {
            event_id: OperationEventIdV1::new(format!("spawn-event-{nonce}"))
                .map_err(|_| "agent_spawn_journal_event_invalid".to_string())?,
            operation_id: receipt.operation_id.clone(),
            sequence,
            plan_token: receipt.plan.plan_token.clone(),
            body,
            recorded_at_ms,
        })
        .await
        .map_err(store_error)
}

fn clock_ms() -> Result<i64, String> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "agent_spawn_clock_unavailable".to_string())?
        .as_millis();
    i64::try_from(value).map_err(|_| "agent_spawn_clock_unavailable".to_string())
}

#[cfg(test)]
#[path = "agent_spawn_apply_tests.rs"]
mod tests;
