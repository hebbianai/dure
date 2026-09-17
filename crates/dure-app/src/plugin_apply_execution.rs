use std::{error::Error, fmt};

use crate::{
    AgentNativePluginCliCommandV2, PluginApplyEffectDispositionV2, PluginApplyJournalEventBodyV2,
    PluginApplyJournalReceiptV2, PluginApplyJournalStateV2, PluginApplyRecoveryDirectiveV2,
    PluginApplyRecoveryStrategyV2, PluginApplyStepCheckpointV2, PluginApplyStepReconciliationV2,
    PluginNativeCheckpointReconciliationV2, PluginNativeCommandOutcomeV2,
    PluginNativeExistingOwnershipV2, PluginNativeMutationObservationV2,
    PluginNativeReconciliationErrorV2, PluginNativeStateObservationV2, PluginVersionV2,
    classify_plugin_native_mutation, reconcile_plugin_native_checkpoint,
};

pub struct PluginApplyStepCompletionV2<'a> {
    pub command: &'a AgentNativePluginCliCommandV2,
    pub expected_plugin_version: &'a PluginVersionV2,
    pub existing_ownership: PluginNativeExistingOwnershipV2,
    pub checkpoint: &'a PluginApplyStepCheckpointV2,
    pub outcome: &'a PluginNativeCommandOutcomeV2,
    pub after: &'a PluginNativeStateObservationV2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginApplyExecutionDecisionErrorV2 {
    InvalidBeforeObservation,
    InvalidAfterObservation,
    CheckpointAlreadyObserved,
    RecoveryNotRequired,
    ForwardRecoveryUnsafe,
    CompensationUnavailable,
    NestedCompensationForbidden,
    Reconciliation(PluginNativeReconciliationErrorV2),
}

impl fmt::Display for PluginApplyExecutionDecisionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBeforeObservation => {
                formatter.write_str("plugin apply checkpoint has an invalid before observation")
            }
            Self::InvalidAfterObservation => {
                formatter.write_str("plugin apply completion has an invalid after observation")
            }
            Self::CheckpointAlreadyObserved => {
                formatter.write_str("plugin apply checkpoint already contains an outcome")
            }
            Self::RecoveryNotRequired => {
                formatter.write_str("plugin apply operation does not require recovery")
            }
            Self::ForwardRecoveryUnsafe => {
                formatter.write_str("plugin apply target changed and cannot retry forward")
            }
            Self::CompensationUnavailable => {
                formatter.write_str("plugin apply operation has no owned effect to compensate")
            }
            Self::NestedCompensationForbidden => {
                formatter.write_str("plugin apply compensation child cannot compensate recursively")
            }
            Self::Reconciliation(error) => error.fmt(formatter),
        }
    }
}

impl Error for PluginApplyExecutionDecisionErrorV2 {}

pub fn prepare_plugin_apply_step(
    step_index: u32,
    attempt: u32,
    before: PluginNativeStateObservationV2,
) -> Result<PluginApplyJournalEventBodyV2, PluginApplyExecutionDecisionErrorV2> {
    if !before.has_valid_digest() {
        return Err(PluginApplyExecutionDecisionErrorV2::InvalidBeforeObservation);
    }
    Ok(PluginApplyJournalEventBodyV2::StepPrepared {
        step_index,
        attempt,
        before,
    })
}

pub fn complete_plugin_apply_step(
    completion: PluginApplyStepCompletionV2<'_>,
) -> Result<Vec<PluginApplyJournalEventBodyV2>, PluginApplyExecutionDecisionErrorV2> {
    let PluginApplyStepCompletionV2 {
        command,
        expected_plugin_version,
        existing_ownership,
        checkpoint,
        outcome,
        after,
    } = completion;
    if !checkpoint.before.has_valid_digest() {
        return Err(PluginApplyExecutionDecisionErrorV2::InvalidBeforeObservation);
    }
    if checkpoint.outcome.is_some() || checkpoint.after.is_some() {
        return Err(PluginApplyExecutionDecisionErrorV2::CheckpointAlreadyObserved);
    }
    if !after.has_valid_digest() {
        return Err(PluginApplyExecutionDecisionErrorV2::InvalidAfterObservation);
    }

    let mut events = vec![PluginApplyJournalEventBodyV2::StepObserved {
        step_index: checkpoint.step_index,
        attempt: checkpoint.attempt,
        outcome: outcome.clone(),
        after: after.clone(),
    }];
    if !is_mutation(command) {
        return Ok(events);
    }
    let classification = classify_plugin_native_mutation(PluginNativeMutationObservationV2 {
        command,
        expected_plugin_version,
        existing_ownership,
        before: &checkpoint.before.state,
        after: &after.state,
    });
    if outcome != &PluginNativeCommandOutcomeV2::Succeeded && after == &checkpoint.before {
        events.push(PluginApplyJournalEventBodyV2::StepReconciled {
            step_index: checkpoint.step_index,
            attempt: checkpoint.attempt,
            observed: after.clone(),
            resolution: PluginApplyStepReconciliationV2::NotApplied,
        });
        return Ok(events);
    }
    match classification {
        Ok(disposition) => events.push(PluginApplyJournalEventBodyV2::EffectRecorded {
            step_index: checkpoint.step_index,
            attempt: checkpoint.attempt,
            disposition,
        }),
        Err(_) => events.push(PluginApplyJournalEventBodyV2::StepReconciled {
            step_index: checkpoint.step_index,
            attempt: checkpoint.attempt,
            observed: after.clone(),
            resolution: PluginApplyStepReconciliationV2::Diverged,
        }),
    }
    Ok(events)
}

pub fn reconcile_plugin_apply_step(
    reconciliation: PluginNativeCheckpointReconciliationV2<'_>,
) -> Result<PluginApplyJournalEventBodyV2, PluginApplyExecutionDecisionErrorV2> {
    let step_index = reconciliation.checkpoint.step_index;
    let attempt = reconciliation.checkpoint.attempt;
    let observed = reconciliation.observed.clone();
    let resolution = reconcile_plugin_native_checkpoint(reconciliation)
        .map_err(PluginApplyExecutionDecisionErrorV2::Reconciliation)?;
    Ok(PluginApplyJournalEventBodyV2::StepReconciled {
        step_index,
        attempt,
        observed,
        resolution,
    })
}

pub fn select_plugin_apply_recovery(
    receipt: &PluginApplyJournalReceiptV2,
    strategy: PluginApplyRecoveryStrategyV2,
) -> Result<PluginApplyJournalEventBodyV2, PluginApplyExecutionDecisionErrorV2> {
    if receipt.state != PluginApplyJournalStateV2::RecoveryRequired {
        return Err(PluginApplyExecutionDecisionErrorV2::RecoveryNotRequired);
    }
    let PluginApplyRecoveryDirectiveV2::ChooseRecovery { checkpoint, .. } = &receipt.recovery
    else {
        return Err(PluginApplyExecutionDecisionErrorV2::RecoveryNotRequired);
    };
    match strategy {
        PluginApplyRecoveryStrategyV2::Forward => {
            if checkpoint.after.as_ref().map(|after| &after.digest)
                != Some(&checkpoint.before.digest)
            {
                return Err(PluginApplyExecutionDecisionErrorV2::ForwardRecoveryUnsafe);
            }
        }
        PluginApplyRecoveryStrategyV2::CompensateOwned => {
            if receipt.compensation_for.is_some() {
                return Err(PluginApplyExecutionDecisionErrorV2::NestedCompensationForbidden);
            }
            if !receipt.effects.iter().any(|effect| {
                matches!(
                    effect.disposition,
                    PluginApplyEffectDispositionV2::CreatedDureOwned
                        | PluginApplyEffectDispositionV2::RemovedDureOwned
                )
            }) {
                return Err(PluginApplyExecutionDecisionErrorV2::CompensationUnavailable);
            }
        }
    }
    Ok(PluginApplyJournalEventBodyV2::RecoveryResumed { strategy })
}

fn is_mutation(command: &AgentNativePluginCliCommandV2) -> bool {
    matches!(
        command,
        AgentNativePluginCliCommandV2::AddMarketplace { .. }
            | AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
            | AgentNativePluginCliCommandV2::InstallPlugin { .. }
            | AgentNativePluginCliCommandV2::RemovePlugin { .. }
    )
}
