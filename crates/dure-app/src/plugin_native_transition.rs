use std::{error::Error, fmt};

use crate::{
    AgentInstallScopeV2, AgentNativePluginCliCommandV2, PluginApplyEffectDispositionV2,
    PluginApplyStepCheckpointV2, PluginApplyStepReconciliationV2, PluginNativeCommandOutcomeV2,
    PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativeStateObservationV2, PluginNativeTargetStateV2, PluginVersionV2,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginNativeExistingOwnershipV2 {
    DureOwned,
    Unproven,
}

pub struct PluginNativeMutationObservationV2<'a> {
    pub command: &'a AgentNativePluginCliCommandV2,
    pub expected_plugin_version: &'a PluginVersionV2,
    pub existing_ownership: PluginNativeExistingOwnershipV2,
    pub before: &'a PluginNativeTargetStateV2,
    pub after: &'a PluginNativeTargetStateV2,
}

pub struct PluginNativeCheckpointReconciliationV2<'a> {
    pub command: &'a AgentNativePluginCliCommandV2,
    pub expected_plugin_version: &'a PluginVersionV2,
    pub existing_ownership: PluginNativeExistingOwnershipV2,
    pub checkpoint: &'a PluginApplyStepCheckpointV2,
    pub observed: &'a PluginNativeStateObservationV2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeTransitionErrorV2 {
    ReadOnlyCommand,
    CollateralStateChanged,
    UnexpectedPostState,
    ExistingStateWouldBeOverwritten,
    OwnershipRequired,
    DestructiveDataRemoval,
    DependentStateConflict,
}

impl fmt::Display for PluginNativeTransitionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ReadOnlyCommand => "native plugin transition requires a mutation command",
            Self::CollateralStateChanged => {
                "native plugin mutation changed state outside its owned component"
            }
            Self::UnexpectedPostState => {
                "native plugin mutation did not produce its exact expected state"
            }
            Self::ExistingStateWouldBeOverwritten => {
                "native plugin mutation would overwrite unrecognized existing state"
            }
            Self::OwnershipRequired => {
                "native plugin removal requires durable Dure ownership evidence"
            }
            Self::DestructiveDataRemoval => {
                "native plugin removal must preserve provider-owned plugin data"
            }
            Self::DependentStateConflict => {
                "native plugin mutation conflicts with dependent target state"
            }
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeTransitionErrorV2 {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeReconciliationErrorV2 {
    InvalidCheckpointObservation,
    InvalidObservedState,
    MissingSuccessfulObservation,
    UnexpectedCheckpointOutcome,
}

impl fmt::Display for PluginNativeReconciliationErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidCheckpointObservation => {
                "native plugin checkpoint contains an invalid state observation"
            }
            Self::InvalidObservedState => {
                "native plugin reconciliation received an invalid state observation"
            }
            Self::MissingSuccessfulObservation => {
                "successful native plugin checkpoint has no after observation"
            }
            Self::UnexpectedCheckpointOutcome => {
                "native plugin checkpoint is not eligible for inspection recovery"
            }
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeReconciliationErrorV2 {}

pub fn classify_plugin_native_mutation(
    observation: PluginNativeMutationObservationV2<'_>,
) -> Result<PluginApplyEffectDispositionV2, PluginNativeTransitionErrorV2> {
    let PluginNativeMutationObservationV2 {
        command,
        expected_plugin_version,
        existing_ownership,
        before,
        after,
    } = observation;
    match command {
        AgentNativePluginCliCommandV2::AddMarketplace { scope, .. } => {
            require_unchanged_installation(before, after)?;
            require_expected_marketplace(&after.marketplace, scope)?;
            let disposition = classify_add(
                &before.marketplace,
                &after.marketplace,
                &PluginNativeMarketplaceStateV2::Absent,
                existing_ownership,
            )?;
            if disposition == PluginApplyEffectDispositionV2::CreatedDureOwned
                && after.installation != PluginNativeInstallationStateV2::Absent
            {
                return Err(PluginNativeTransitionErrorV2::DependentStateConflict);
            }
            Ok(disposition)
        }
        AgentNativePluginCliCommandV2::InstallPlugin { scope, .. } => {
            require_unchanged_marketplace(before, after)?;
            require_expected_marketplace(&after.marketplace, scope)
                .map_err(|_| PluginNativeTransitionErrorV2::DependentStateConflict)?;
            require_expected_installation(&after.installation, expected_plugin_version, scope)?;
            classify_add(
                &before.installation,
                &after.installation,
                &PluginNativeInstallationStateV2::Absent,
                existing_ownership,
            )
        }
        AgentNativePluginCliCommandV2::RemoveMarketplace { scope, .. } => {
            require_unchanged_installation(before, after)?;
            if after.installation != PluginNativeInstallationStateV2::Absent {
                return Err(PluginNativeTransitionErrorV2::DependentStateConflict);
            }
            if after.marketplace != PluginNativeMarketplaceStateV2::Absent {
                return Err(PluginNativeTransitionErrorV2::UnexpectedPostState);
            }
            classify_remove(
                &before.marketplace,
                &PluginNativeMarketplaceStateV2::Absent,
                |state| is_expected_marketplace(state, scope),
                existing_ownership,
            )
        }
        AgentNativePluginCliCommandV2::RemovePlugin {
            scope,
            preserve_data,
            ..
        } => {
            if !preserve_data {
                return Err(PluginNativeTransitionErrorV2::DestructiveDataRemoval);
            }
            require_unchanged_marketplace(before, after)?;
            if after.installation != PluginNativeInstallationStateV2::Absent {
                return Err(PluginNativeTransitionErrorV2::UnexpectedPostState);
            }
            classify_remove(
                &before.installation,
                &PluginNativeInstallationStateV2::Absent,
                |state| is_expected_installation(state, expected_plugin_version, scope),
                existing_ownership,
            )
        }
        AgentNativePluginCliCommandV2::ListMarketplaces { .. }
        | AgentNativePluginCliCommandV2::ListPlugins { .. } => {
            Err(PluginNativeTransitionErrorV2::ReadOnlyCommand)
        }
    }
}

pub fn reconcile_plugin_native_checkpoint(
    reconciliation: PluginNativeCheckpointReconciliationV2<'_>,
) -> Result<PluginApplyStepReconciliationV2, PluginNativeReconciliationErrorV2> {
    let PluginNativeCheckpointReconciliationV2 {
        command,
        expected_plugin_version,
        existing_ownership,
        checkpoint,
        observed,
    } = reconciliation;
    if !checkpoint.before.has_valid_digest()
        || checkpoint
            .after
            .as_ref()
            .is_some_and(|after| !after.has_valid_digest())
    {
        return Err(PluginNativeReconciliationErrorV2::InvalidCheckpointObservation);
    }
    if !observed.has_valid_digest() {
        return Err(PluginNativeReconciliationErrorV2::InvalidObservedState);
    }
    if checkpoint.outcome.is_none() && checkpoint.after.is_some() {
        return Err(PluginNativeReconciliationErrorV2::UnexpectedCheckpointOutcome);
    }

    match &checkpoint.outcome {
        None => {
            if observed == &checkpoint.before {
                return Ok(PluginApplyStepReconciliationV2::NotApplied);
            }
            Ok(classify_reconciled_mutation(
                command,
                expected_plugin_version,
                existing_ownership,
                &checkpoint.before.state,
                &observed.state,
            ))
        }
        Some(PluginNativeCommandOutcomeV2::Succeeded) => {
            let after = checkpoint
                .after
                .as_ref()
                .ok_or(PluginNativeReconciliationErrorV2::MissingSuccessfulObservation)?;
            if observed != after {
                return Ok(PluginApplyStepReconciliationV2::Diverged);
            }
            Ok(classify_reconciled_mutation(
                command,
                expected_plugin_version,
                existing_ownership,
                &checkpoint.before.state,
                &after.state,
            ))
        }
        Some(
            PluginNativeCommandOutcomeV2::ExitedNonzero { .. }
            | PluginNativeCommandOutcomeV2::TimedOut
            | PluginNativeCommandOutcomeV2::HostFailed { .. },
        ) => Err(PluginNativeReconciliationErrorV2::UnexpectedCheckpointOutcome),
    }
}

fn classify_reconciled_mutation(
    command: &AgentNativePluginCliCommandV2,
    expected_plugin_version: &PluginVersionV2,
    existing_ownership: PluginNativeExistingOwnershipV2,
    before: &PluginNativeTargetStateV2,
    after: &PluginNativeTargetStateV2,
) -> PluginApplyStepReconciliationV2 {
    match classify_plugin_native_mutation(PluginNativeMutationObservationV2 {
        command,
        expected_plugin_version,
        existing_ownership,
        before,
        after,
    }) {
        Ok(disposition) => PluginApplyStepReconciliationV2::Applied { disposition },
        Err(_) => PluginApplyStepReconciliationV2::Diverged,
    }
}

fn classify_add<T: Eq>(
    before: &T,
    after: &T,
    absent: &T,
    existing_ownership: PluginNativeExistingOwnershipV2,
) -> Result<PluginApplyEffectDispositionV2, PluginNativeTransitionErrorV2> {
    if before == absent {
        return Ok(PluginApplyEffectDispositionV2::CreatedDureOwned);
    }
    if before == after {
        return Ok(match existing_ownership {
            PluginNativeExistingOwnershipV2::DureOwned => {
                PluginApplyEffectDispositionV2::PreservedDureOwned
            }
            PluginNativeExistingOwnershipV2::Unproven => {
                PluginApplyEffectDispositionV2::PreservedExternal
            }
        });
    }
    Err(PluginNativeTransitionErrorV2::ExistingStateWouldBeOverwritten)
}

fn classify_remove<T: Eq>(
    before: &T,
    absent: &T,
    is_expected: impl FnOnce(&T) -> bool,
    existing_ownership: PluginNativeExistingOwnershipV2,
) -> Result<PluginApplyEffectDispositionV2, PluginNativeTransitionErrorV2> {
    if before == absent {
        return Ok(PluginApplyEffectDispositionV2::NoChange);
    }
    if !is_expected(before) {
        return Err(PluginNativeTransitionErrorV2::ExistingStateWouldBeOverwritten);
    }
    if existing_ownership != PluginNativeExistingOwnershipV2::DureOwned {
        return Err(PluginNativeTransitionErrorV2::OwnershipRequired);
    }
    Ok(PluginApplyEffectDispositionV2::RemovedDureOwned)
}

fn require_unchanged_marketplace(
    before: &PluginNativeTargetStateV2,
    after: &PluginNativeTargetStateV2,
) -> Result<(), PluginNativeTransitionErrorV2> {
    if before.marketplace == after.marketplace {
        Ok(())
    } else {
        Err(PluginNativeTransitionErrorV2::CollateralStateChanged)
    }
}

fn require_unchanged_installation(
    before: &PluginNativeTargetStateV2,
    after: &PluginNativeTargetStateV2,
) -> Result<(), PluginNativeTransitionErrorV2> {
    if before.installation == after.installation {
        Ok(())
    } else {
        Err(PluginNativeTransitionErrorV2::CollateralStateChanged)
    }
}

fn require_expected_marketplace(
    state: &PluginNativeMarketplaceStateV2,
    scope: &AgentInstallScopeV2,
) -> Result<(), PluginNativeTransitionErrorV2> {
    if is_expected_marketplace(state, scope) {
        Ok(())
    } else {
        Err(PluginNativeTransitionErrorV2::UnexpectedPostState)
    }
}

fn is_expected_marketplace(
    state: &PluginNativeMarketplaceStateV2,
    scope: &AgentInstallScopeV2,
) -> bool {
    matches!(
        state,
        PluginNativeMarketplaceStateV2::Registered {
            matches_expected_source: true,
            scope: actual_scope,
            ..
        } if actual_scope == scope
    )
}

fn require_expected_installation(
    state: &PluginNativeInstallationStateV2,
    version: &PluginVersionV2,
    scope: &AgentInstallScopeV2,
) -> Result<(), PluginNativeTransitionErrorV2> {
    if is_expected_installation(state, version, scope) {
        Ok(())
    } else {
        Err(PluginNativeTransitionErrorV2::UnexpectedPostState)
    }
}

fn is_expected_installation(
    state: &PluginNativeInstallationStateV2,
    version: &PluginVersionV2,
    scope: &AgentInstallScopeV2,
) -> bool {
    matches!(
        state,
        PluginNativeInstallationStateV2::Installed {
            version: actual_version,
            enabled: true,
            scope: actual_scope,
        } if actual_version == version && actual_scope == scope
    )
}
