use std::error::Error;
use std::fmt;

use dure_app::{
    AgentNativePluginCliCommandV2, AgentNativePluginMarketplaceSourceV2, DomainStoreErrorV1,
    OperationEventIdV1, OperationIdV1, PluginApplyCompensationLinkV2,
    PluginApplyCompensationPlanErrorV2, PluginApplyExecutionDecisionErrorV2,
    PluginApplyJournalEventBodyV2, PluginApplyJournalEventV2, PluginApplyJournalReceiptV2,
    PluginApplyJournalStateV2, PluginApplyJournalStore, PluginApplyRecoveryDirectiveV2,
    PluginApplyRecoveryStrategyV2, PluginApplyStepCompletionV2, PluginApplyStepV2,
    PluginNativeApplyAuthorityStore,
    PluginNativeCheckpointReconciliationV2, PluginNativeExistingOwnershipV2,
    PluginTargetStateDigestV2, compile_agent_native_plugin_cli_invocation,
    complete_plugin_apply_step, create_plugin_apply_compensation_started_event,
    plan_plugin_apply_compensation, plugin_apply_compensation_identity,
    plugin_native_ownership_target, prepare_plugin_apply_step, reconcile_plugin_apply_step,
    select_plugin_apply_recovery, validate_plugin_apply_compensation_child,
    validate_plugin_apply_compensation_completion, validate_plugin_apply_compensation_link,
};

use crate::plugin_native_cli::{PluginNativeCliHostContext, PluginNativeCliPrepareError};
use crate::plugin_native_cli_inspect::{
    inspect_bound_plugin_native_cli_target, PluginNativeCliInspectError, PluginNativeCliInspection,
};
use crate::plugin_native_target_binding::{
    execute_bound_plugin_native_cli_command, prepare_bound_plugin_native_cli_command,
    resolve_plugin_native_target_leases, PluginNativeTargetBindingAuthority,
    PluginNativeTargetBindingHostError, PluginNativeTargetExecutionLease,
    PluginNativeTargetExecutionLeaseDisposition, PluginNativeTargetLeases,
};

const MAX_PLUGIN_NATIVE_STEP_ATTEMPTS: u32 = 3;

#[derive(Default)]
pub struct PluginNativeApplyExecutor {
    gate: tokio::sync::Mutex<()>,
}

pub struct PluginNativeApplyExecutorRequest<'a> {
    pub operation_id: &'a OperationIdV1,
    pub marketplace_source: &'a AgentNativePluginMarketplaceSourceV2,
    pub host: &'a PluginNativeCliHostContext<'a>,
    pub target_binding_authority: &'a PluginNativeTargetBindingAuthority,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeApplyExecutorOutcomeV2 {
    Succeeded(PluginApplyJournalReceiptV2),
    Compensated(PluginApplyJournalReceiptV2),
    RecoveryRequired(PluginApplyJournalReceiptV2),
    CompensationRequired(PluginApplyJournalReceiptV2),
    AttemptsExhausted(PluginApplyJournalReceiptV2),
    ExecutionInProgress(PluginApplyJournalReceiptV2),
}

#[derive(Debug)]
pub enum PluginNativeApplyExecutorError {
    OperationMissing,
    InvalidStepIndex,
    ReadOnlyStep,
    OwnershipRequired,
    OwnershipBindingRequired,
    OwnershipTarget,
    Invocation,
    Preparation(PluginNativeCliPrepareError),
    Inspection(PluginNativeCliInspectError),
    TargetBinding(PluginNativeTargetBindingHostError),
    Decision(PluginApplyExecutionDecisionErrorV2),
    CompensationPlan(PluginApplyCompensationPlanErrorV2),
    Store(DomainStoreErrorV1),
    EventIdentity,
    SequenceOverflow,
    ExecutionInProgress,
}

impl fmt::Display for PluginNativeApplyExecutorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::OperationMissing => "plugin apply operation does not exist",
            Self::InvalidStepIndex => "plugin apply receipt references an invalid step",
            Self::ReadOnlyStep => "plugin apply executor received a read-only plan step",
            Self::OwnershipRequired => {
                "plugin apply removal requires durable Dure ownership evidence"
            }
            Self::OwnershipBindingRequired => {
                "plugin apply removal ownership is not bound to the current physical target"
            }
            Self::OwnershipTarget => "plugin apply ownership target is invalid",
            Self::Invocation => "plugin apply command is invalid",
            Self::Preparation(_) => "plugin apply command target is unavailable",
            Self::Inspection(_) => "plugin apply target inspection failed",
            Self::TargetBinding(_) => "plugin apply physical target binding changed",
            Self::Decision(_) => "plugin apply outcome could not be recorded safely",
            Self::CompensationPlan(_) => {
                "plugin apply compensation could not be planned or verified safely"
            }
            Self::Store(_) => "plugin apply journal storage failed",
            Self::EventIdentity => "plugin apply event identity could not be generated",
            Self::SequenceOverflow => "plugin apply event sequence overflowed",
            Self::ExecutionInProgress => "another process is executing a native plugin operation",
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeApplyExecutorError {}

impl PluginNativeApplyExecutor {
    pub async fn advance<S: PluginApplyJournalStore + PluginNativeApplyAuthorityStore>(
        &self,
        store: &S,
        request: PluginNativeApplyExecutorRequest<'_>,
    ) -> Result<PluginNativeApplyExecutorOutcomeV2, PluginNativeApplyExecutorError> {
        let _guard = self.gate.lock().await;
        let receipt = store
            .plugin_apply_receipt(request.operation_id)
            .await
            .map_err(PluginNativeApplyExecutorError::Store)?
            .ok_or(PluginNativeApplyExecutorError::OperationMissing)?;
        let execution_targets = validated_target_leases(store, &receipt, &request).await?;
        let execution_lease = match execution_targets
            .try_acquire_execution_lease()
            .map_err(PluginNativeApplyExecutorError::TargetBinding)?
        {
            PluginNativeTargetExecutionLeaseDisposition::Acquired(lease) => lease,
            PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                return Ok(PluginNativeApplyExecutorOutcomeV2::ExecutionInProgress(
                    receipt,
                ));
            }
        };
        advance_plugin_native_apply(store, request, &execution_targets, &execution_lease).await
    }

    pub async fn resume_recovery<S: PluginApplyJournalStore + PluginNativeApplyAuthorityStore>(
        &self,
        store: &S,
        request: PluginNativeApplyExecutorRequest<'_>,
        strategy: PluginApplyRecoveryStrategyV2,
    ) -> Result<PluginApplyJournalReceiptV2, PluginNativeApplyExecutorError> {
        let _guard = self.gate.lock().await;
        let receipt = store
            .plugin_apply_receipt(request.operation_id)
            .await
            .map_err(PluginNativeApplyExecutorError::Store)?
            .ok_or(PluginNativeApplyExecutorError::OperationMissing)?;
        let execution_targets = validated_target_leases(store, &receipt, &request).await?;
        let execution_lease = match execution_targets
            .try_acquire_execution_lease()
            .map_err(PluginNativeApplyExecutorError::TargetBinding)?
        {
            PluginNativeTargetExecutionLeaseDisposition::Acquired(lease) => lease,
            PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                return Err(PluginNativeApplyExecutorError::ExecutionInProgress);
            }
        };
        let receipt = store
            .plugin_apply_receipt(request.operation_id)
            .await
            .map_err(PluginNativeApplyExecutorError::Store)?
            .ok_or(PluginNativeApplyExecutorError::OperationMissing)?;
        validate_locked_target_leases(
            store,
            &receipt,
            &request,
            &execution_targets,
            &execution_lease,
        )
        .await?;
        let body = select_plugin_apply_recovery(&receipt, strategy)
            .map_err(PluginNativeApplyExecutorError::Decision)?;
        append_body(store, &receipt, body).await
    }
}

async fn advance_plugin_native_apply<
    S: PluginApplyJournalStore + PluginNativeApplyAuthorityStore,
>(
    store: &S,
    request: PluginNativeApplyExecutorRequest<'_>,
    execution_targets: &PluginNativeTargetLeases,
    execution_lease: &PluginNativeTargetExecutionLease<'_>,
) -> Result<PluginNativeApplyExecutorOutcomeV2, PluginNativeApplyExecutorError> {
    loop {
        let receipt = store
            .plugin_apply_receipt(request.operation_id)
            .await
            .map_err(PluginNativeApplyExecutorError::Store)?
            .ok_or(PluginNativeApplyExecutorError::OperationMissing)?;
        validate_locked_target_leases(
            store,
            &receipt,
            &request,
            execution_targets,
            execution_lease,
        )
        .await?;
        match receipt.recovery.clone() {
            PluginApplyRecoveryDirectiveV2::Continue {
                step_index,
                next_attempt,
            } => {
                if step_index as usize == receipt.steps.len() {
                    let receipt =
                        append_body(store, &receipt, PluginApplyJournalEventBodyV2::Succeeded)
                            .await?;
                    return Ok(PluginNativeApplyExecutorOutcomeV2::Succeeded(receipt));
                }
                if next_attempt > MAX_PLUGIN_NATIVE_STEP_ATTEMPTS {
                    return Ok(PluginNativeApplyExecutorOutcomeV2::AttemptsExhausted(
                        receipt,
                    ));
                }
                let step = receipt
                    .steps
                    .get(step_index as usize)
                    .ok_or(PluginNativeApplyExecutorError::InvalidStepIndex)?;
                require_mutation(step)?;
                let ownership = ownership_for_step(store, &receipt, step).await?;
                let before = inspect_bound_plugin_native_cli_target(PluginNativeCliInspection {
                    step,
                    marketplace_source: request.marketplace_source,
                    host: request.host,
                }, execution_targets)
                .map_err(PluginNativeApplyExecutorError::Inspection)?;
                execution_targets
                    .validate(request.host)
                    .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
                let prepared_receipt = append_body(
                    store,
                    &receipt,
                    prepare_plugin_apply_step(step_index, next_attempt, before)
                        .map_err(PluginNativeApplyExecutorError::Decision)?,
                )
                .await?;
                let checkpoint = match &prepared_receipt.recovery {
                    PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } => checkpoint,
                    _ => continue,
                };
                let invocation = compile_agent_native_plugin_cli_invocation(step)
                    .map_err(|_| PluginNativeApplyExecutorError::Invocation)?;
                let prepared = prepare_bound_plugin_native_cli_command(
                    &invocation,
                    request.host,
                    execution_targets,
                )
                .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
                let execution = execute_bound_plugin_native_cli_command(&prepared)
                    .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
                let after = inspect_bound_plugin_native_cli_target(PluginNativeCliInspection {
                    step,
                    marketplace_source: request.marketplace_source,
                    host: request.host,
                }, execution_targets)
                .map_err(PluginNativeApplyExecutorError::Inspection)?;
                execution_targets
                    .validate(request.host)
                    .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
                let bodies = complete_plugin_apply_step(PluginApplyStepCompletionV2 {
                    command: &step.command,
                    expected_plugin_version: &receipt.plugin_version,
                    existing_ownership: ownership,
                    checkpoint,
                    outcome: execution.outcome(),
                    after: &after,
                })
                .map_err(PluginNativeApplyExecutorError::Decision)?;
                let mut current = prepared_receipt;
                for body in bodies {
                    current = append_body(store, &current, body).await?;
                }
            }
            PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } => {
                let step = receipt
                    .steps
                    .get(checkpoint.step_index as usize)
                    .ok_or(PluginNativeApplyExecutorError::InvalidStepIndex)?;
                require_mutation(step)?;
                let ownership = ownership_for_step(store, &receipt, step).await?;
                let observed = inspect_bound_plugin_native_cli_target(PluginNativeCliInspection {
                    step,
                    marketplace_source: request.marketplace_source,
                    host: request.host,
                }, execution_targets)
                .map_err(PluginNativeApplyExecutorError::Inspection)?;
                execution_targets
                    .validate(request.host)
                    .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
                let body = reconcile_plugin_apply_step(PluginNativeCheckpointReconciliationV2 {
                    command: &step.command,
                    expected_plugin_version: &receipt.plugin_version,
                    existing_ownership: ownership,
                    checkpoint: &checkpoint,
                    observed: &observed,
                })
                .map_err(PluginNativeApplyExecutorError::Decision)?;
                append_body(store, &receipt, body).await?;
            }
            PluginApplyRecoveryDirectiveV2::ChooseRecovery { .. } => {
                return Ok(PluginNativeApplyExecutorOutcomeV2::RecoveryRequired(
                    receipt,
                ));
            }
            PluginApplyRecoveryDirectiveV2::CompensateOwned { .. } => {
                let steps =
                    plan_plugin_apply_compensation(&receipt, request.marketplace_source)
                        .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                let (operation_id, idempotency_key) =
                    plugin_apply_compensation_identity(&receipt.operation_id)
                        .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                append_body(
                    store,
                    &receipt,
                    PluginApplyJournalEventBodyV2::CompensationLinked {
                        link: PluginApplyCompensationLinkV2 {
                            operation_id,
                            idempotency_key,
                            marketplace_source: request.marketplace_source.clone(),
                            steps,
                        },
                    },
                )
                .await?;
            }
            PluginApplyRecoveryDirectiveV2::RunCompensation { link } => {
                validate_plugin_apply_compensation_link(&receipt, request.marketplace_source)
                    .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                let child = match store
                    .plugin_apply_receipt(&link.operation_id)
                    .await
                    .map_err(PluginNativeApplyExecutorError::Store)?
                {
                    Some(child) => child,
                    None => {
                        let started = create_plugin_apply_compensation_started_event(
                            &receipt,
                            request.marketplace_source,
                        )
                        .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                        store
                            .append_plugin_apply_event(&started)
                            .await
                            .map_err(PluginNativeApplyExecutorError::Store)?
                    }
                };
                validate_plugin_apply_compensation_child(&receipt, &child)
                    .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                let child_operation_id = link.operation_id.clone();
                let child_outcome = Box::pin(advance_plugin_native_apply(
                    store,
                    PluginNativeApplyExecutorRequest {
                        operation_id: &child_operation_id,
                        marketplace_source: request.marketplace_source,
                        host: request.host,
                        target_binding_authority: request.target_binding_authority,
                    },
                    execution_targets,
                    execution_lease,
                ))
                .await?;
                match child_outcome {
                    PluginNativeApplyExecutorOutcomeV2::Succeeded(child) => {
                        validate_plugin_apply_compensation_completion(&receipt, &child)
                            .map_err(PluginNativeApplyExecutorError::CompensationPlan)?;
                        let receipt = append_body(
                            store,
                            &receipt,
                            PluginApplyJournalEventBodyV2::Compensated {
                                operation_id: child.operation_id,
                            },
                        )
                        .await?;
                        return Ok(PluginNativeApplyExecutorOutcomeV2::Compensated(receipt));
                    }
                    PluginNativeApplyExecutorOutcomeV2::Compensated(_) => {
                        return Err(PluginNativeApplyExecutorError::CompensationPlan(
                            PluginApplyCompensationPlanErrorV2::InvalidCompletion,
                        ));
                    }
                    PluginNativeApplyExecutorOutcomeV2::RecoveryRequired(_)
                    | PluginNativeApplyExecutorOutcomeV2::CompensationRequired(_)
                    | PluginNativeApplyExecutorOutcomeV2::AttemptsExhausted(_)
                    | PluginNativeApplyExecutorOutcomeV2::ExecutionInProgress(_) => {
                        return Ok(PluginNativeApplyExecutorOutcomeV2::CompensationRequired(
                            receipt,
                        ));
                    }
                }
            }
            PluginApplyRecoveryDirectiveV2::None => {
                return Ok(
                    if receipt.state == PluginApplyJournalStateV2::Compensated {
                        PluginNativeApplyExecutorOutcomeV2::Compensated(receipt)
                    } else {
                        PluginNativeApplyExecutorOutcomeV2::Succeeded(receipt)
                    },
                );
            }
        }
    }
}

fn require_mutation(step: &PluginApplyStepV2) -> Result<(), PluginNativeApplyExecutorError> {
    if matches!(
        step.command,
        AgentNativePluginCliCommandV2::AddMarketplace { .. }
            | AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
            | AgentNativePluginCliCommandV2::InstallPlugin { .. }
            | AgentNativePluginCliCommandV2::RemovePlugin { .. }
    ) {
        Ok(())
    } else {
        Err(PluginNativeApplyExecutorError::ReadOnlyStep)
    }
}

async fn ownership_for_step<S: PluginApplyJournalStore>(
    store: &S,
    receipt: &PluginApplyJournalReceiptV2,
    step: &PluginApplyStepV2,
) -> Result<PluginNativeExistingOwnershipV2, PluginNativeApplyExecutorError> {
    let target = plugin_native_ownership_target(step)
        .map_err(|_| PluginNativeApplyExecutorError::OwnershipTarget)?;
    let ownership_receipt = store
        .plugin_native_ownership(&target.key)
        .await
        .map_err(PluginNativeApplyExecutorError::Store)?;
    let ownership = match ownership_receipt {
        Some(ownership_receipt) => {
            let owner = store
                .plugin_apply_receipt(&ownership_receipt.owner_operation_id)
                .await
                .map_err(PluginNativeApplyExecutorError::Store)?
                .ok_or(PluginNativeApplyExecutorError::OwnershipBindingRequired)?;
            match (&owner.target_bindings, &receipt.target_bindings) {
                (Some(owner), Some(current)) if owner == current => {
                    PluginNativeExistingOwnershipV2::DureOwned
                }
                _ => return Err(PluginNativeApplyExecutorError::OwnershipBindingRequired),
            }
        }
        None => PluginNativeExistingOwnershipV2::Unproven,
    };
    if matches!(
        step.command,
        AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
            | AgentNativePluginCliCommandV2::RemovePlugin { .. }
    ) && ownership != PluginNativeExistingOwnershipV2::DureOwned
    {
        return Err(PluginNativeApplyExecutorError::OwnershipRequired);
    }
    Ok(ownership)
}

async fn validated_target_leases<
    S: PluginApplyJournalStore + PluginNativeApplyAuthorityStore,
>(
    store: &S,
    receipt: &PluginApplyJournalReceiptV2,
    request: &PluginNativeApplyExecutorRequest<'_>,
) -> Result<PluginNativeTargetLeases, PluginNativeApplyExecutorError> {
    let leases = resolve_plugin_native_target_leases(
        &receipt.steps,
        request.host,
        request.target_binding_authority,
    )
    .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
    store
        .validate_plugin_native_target_bindings(&receipt.operation_id, leases.bindings())
        .await
        .map_err(PluginNativeApplyExecutorError::Store)?;
    leases
        .validate(request.host)
        .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
    Ok(leases)
}

async fn validate_locked_target_leases<
    S: PluginApplyJournalStore + PluginNativeApplyAuthorityStore,
>(
    store: &S,
    receipt: &PluginApplyJournalReceiptV2,
    request: &PluginNativeApplyExecutorRequest<'_>,
    execution_targets: &PluginNativeTargetLeases,
    execution_lease: &PluginNativeTargetExecutionLease<'_>,
) -> Result<(), PluginNativeApplyExecutorError> {
    execution_lease
        .validate_bindings(receipt.target_bindings.as_deref())
        .map_err(PluginNativeApplyExecutorError::TargetBinding)?;
    store
        .validate_plugin_native_target_bindings(
            &receipt.operation_id,
            execution_targets.bindings(),
        )
        .await
        .map_err(PluginNativeApplyExecutorError::Store)?;
    execution_targets
        .validate(request.host)
        .map_err(PluginNativeApplyExecutorError::TargetBinding)
}

async fn append_body<S: PluginApplyJournalStore>(
    store: &S,
    receipt: &PluginApplyJournalReceiptV2,
    body: PluginApplyJournalEventBodyV2,
) -> Result<PluginApplyJournalReceiptV2, PluginNativeApplyExecutorError> {
    let sequence = receipt
        .last_sequence
        .checked_add(1)
        .ok_or(PluginNativeApplyExecutorError::SequenceOverflow)?;
    let identity = PluginTargetStateDigestV2::sha256(format!(
        "dure-plugin-apply-event/v2\0{}\0{sequence}",
        receipt.operation_id.as_str()
    ));
    let event_id = OperationEventIdV1::new(format!(
        "plugin-event-{}",
        identity
            .as_str()
            .strip_prefix("sha256:")
            .expect("target digests always have a sha256 prefix")
    ))
    .map_err(|_| PluginNativeApplyExecutorError::EventIdentity)?;
    let recorded_at_ms = receipt.updated_at_ms.saturating_add(1);
    store
        .append_plugin_apply_event(&PluginApplyJournalEventV2 {
            event_id,
            operation_id: receipt.operation_id.clone(),
            sequence,
            body,
            recorded_at_ms,
        })
        .await
        .map_err(PluginNativeApplyExecutorError::Store)
}

#[cfg(all(test, unix))]
#[path = "plugin_native_apply_executor_tests.rs"]
mod tests;
