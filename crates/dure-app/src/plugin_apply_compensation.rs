use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

use crate::{
    AgentNativePluginCliCommandV2, AgentNativePluginMarketplaceSourceV2,
    PluginApplyEffectDispositionV2, PluginApplyEffectReceiptV2, PluginApplyJournalReceiptV2,
    PluginApplyJournalStateV2, PluginApplyRecoveryDirectiveV2, PluginApplyStepV2,
    PluginNativeStateObservationV2,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyCompensationStepV2 {
    pub source_effect: PluginApplyEffectReceiptV2,
    pub step: PluginApplyStepV2,
    pub expected_before: PluginNativeStateObservationV2,
    pub expected_after: PluginNativeStateObservationV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyCompensationLinkV2 {
    pub operation_id: crate::OperationIdV1,
    pub idempotency_key: String,
    pub marketplace_source: AgentNativePluginMarketplaceSourceV2,
    pub steps: Vec<PluginApplyCompensationStepV2>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginApplyCompensationPlanErrorV2 {
    RecoveryNotCompensating,
    RecoveryMismatch,
    NoOwnedEffects,
    InvalidOwnedEffect,
    InvalidIdentity,
    InvalidLink,
    InvalidCompletion,
    Journal(crate::PluginApplyJournalErrorV2),
}

impl fmt::Display for PluginApplyCompensationPlanErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::RecoveryNotCompensating => {
                "plugin apply receipt is not ready for owned-effect compensation"
            }
            Self::RecoveryMismatch => {
                "plugin apply compensation directive differs from its owned effects"
            }
            Self::NoOwnedEffects => "plugin apply operation has no owned effects to compensate",
            Self::InvalidOwnedEffect => {
                "plugin apply owned effect cannot be mapped to an exact inverse command"
            }
            Self::InvalidIdentity => "plugin apply compensation identity is invalid",
            Self::InvalidLink => {
                "plugin apply compensation link does not match the trusted inverse plan"
            }
            Self::InvalidCompletion => {
                "plugin apply compensation child does not prove exact successful completion"
            }
            Self::Journal(_) => "plugin apply compensation child event is invalid",
        };
        formatter.write_str(message)
    }
}

impl Error for PluginApplyCompensationPlanErrorV2 {}

pub fn plugin_apply_compensation_identity(
    parent_operation_id: &crate::OperationIdV1,
) -> Result<(crate::OperationIdV1, String), PluginApplyCompensationPlanErrorV2> {
    let digest = crate::PluginTargetStateDigestV2::sha256(format!(
        "dure-plugin-compensation-operation/v2\0{}",
        parent_operation_id.as_str()
    ));
    let hex = digest
        .as_str()
        .strip_prefix("sha256:")
        .ok_or(PluginApplyCompensationPlanErrorV2::InvalidIdentity)?;
    let operation_id = crate::OperationIdV1::new(format!("plugin-compensation-{hex}"))
        .map_err(|_| PluginApplyCompensationPlanErrorV2::InvalidIdentity)?;
    Ok((operation_id, format!("plugin-compensation:{hex}")))
}

pub fn plan_plugin_apply_compensation(
    receipt: &PluginApplyJournalReceiptV2,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> Result<Vec<PluginApplyCompensationStepV2>, PluginApplyCompensationPlanErrorV2> {
    if receipt.state != PluginApplyJournalStateV2::Compensating {
        return Err(PluginApplyCompensationPlanErrorV2::RecoveryNotCompensating);
    }

    let effects = receipt
        .effects
        .iter()
        .rev()
        .filter(|effect| {
            matches!(
                effect.disposition,
                PluginApplyEffectDispositionV2::CreatedDureOwned
                    | PluginApplyEffectDispositionV2::RemovedDureOwned
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if effects.is_empty() {
        return Err(PluginApplyCompensationPlanErrorV2::NoOwnedEffects);
    }
    if !matches!(
        &receipt.recovery,
        PluginApplyRecoveryDirectiveV2::CompensateOwned {
            effects: directed
        } if directed == &effects
    ) {
        return Err(PluginApplyCompensationPlanErrorV2::RecoveryMismatch);
    }
    let plan = build_plugin_apply_compensation_steps(effects.iter().collect(), marketplace_source)?;
    validate_plugin_apply_compensation_steps(
        &receipt.operation_kind,
        &receipt.effects,
        marketplace_source,
        &plan,
    )?;
    Ok(plan)
}

pub fn validate_plugin_apply_compensation_link(
    receipt: &PluginApplyJournalReceiptV2,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> Result<(), PluginApplyCompensationPlanErrorV2> {
    let link = receipt
        .compensation
        .as_ref()
        .ok_or(PluginApplyCompensationPlanErrorV2::InvalidLink)?;
    if receipt.state != crate::PluginApplyJournalStateV2::Compensating
        || !matches!(
            &receipt.recovery,
            PluginApplyRecoveryDirectiveV2::RunCompensation { link: directive }
                if directive == link
        )
    {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidLink);
    }
    let effects = receipt
        .effects
        .iter()
        .rev()
        .filter(|effect| {
            matches!(
                effect.disposition,
                PluginApplyEffectDispositionV2::CreatedDureOwned
                    | PluginApplyEffectDispositionV2::RemovedDureOwned
            )
        })
        .collect::<Vec<_>>();
    let expected = build_plugin_apply_compensation_steps(effects, marketplace_source)?;
    validate_plugin_apply_compensation_steps(
        &receipt.operation_kind,
        &receipt.effects,
        marketplace_source,
        &expected,
    )?;
    if &link.marketplace_source != marketplace_source || link.steps != expected {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidLink);
    }
    let (operation_id, idempotency_key) =
        plugin_apply_compensation_identity(&receipt.operation_id)?;
    if link.operation_id != operation_id || link.idempotency_key != idempotency_key {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidLink);
    }
    Ok(())
}

pub fn create_plugin_apply_compensation_started_event(
    parent: &PluginApplyJournalReceiptV2,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> Result<crate::PluginApplyJournalEventV2, PluginApplyCompensationPlanErrorV2> {
    validate_plugin_apply_compensation_link(parent, marketplace_source)?;
    let link = parent
        .compensation
        .as_ref()
        .ok_or(PluginApplyCompensationPlanErrorV2::InvalidLink)?;
    let operation_kind = match parent.operation_kind {
        crate::PluginApplyOperationKindV2::Install => crate::PluginApplyOperationKindV2::Uninstall,
        crate::PluginApplyOperationKindV2::Uninstall => crate::PluginApplyOperationKindV2::Install,
    };
    let identity = crate::PluginTargetStateDigestV2::sha256(format!(
        "dure-plugin-compensation-start/v2\0{}",
        link.operation_id.as_str()
    ));
    let hex = identity
        .as_str()
        .strip_prefix("sha256:")
        .ok_or(PluginApplyCompensationPlanErrorV2::InvalidIdentity)?;
    let event = crate::PluginApplyJournalEventV2 {
        event_id: crate::OperationEventIdV1::new(format!("plugin-compensation-start-{hex}"))
            .map_err(|_| PluginApplyCompensationPlanErrorV2::InvalidIdentity)?,
        operation_id: link.operation_id.clone(),
        sequence: 1,
        body: crate::PluginApplyJournalEventBodyV2::Started {
            idempotency_key: link.idempotency_key.clone(),
            plugin_id: parent.plugin_id.clone(),
            plugin_version: parent.plugin_version.clone(),
            compensation_for: Some(parent.operation_id.clone()),
            target_bindings: parent.target_bindings.clone(),
            operation_kind,
            steps: link
                .steps
                .iter()
                .map(|compensation| compensation.step.clone())
                .collect(),
        },
        recorded_at_ms: parent.updated_at_ms.saturating_add(1),
    };
    crate::fold_plugin_apply_journal(std::slice::from_ref(&event))
        .map_err(PluginApplyCompensationPlanErrorV2::Journal)?;
    Ok(event)
}

pub fn validate_plugin_apply_compensation_steps(
    operation_kind: &crate::PluginApplyOperationKindV2,
    effects: &[PluginApplyEffectReceiptV2],
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
    steps: &[PluginApplyCompensationStepV2],
) -> Result<(), PluginApplyCompensationPlanErrorV2> {
    let owned_effects = effects
        .iter()
        .rev()
        .filter(|effect| {
            matches!(
                effect.disposition,
                PluginApplyEffectDispositionV2::CreatedDureOwned
                    | PluginApplyEffectDispositionV2::RemovedDureOwned
            )
        })
        .collect::<Vec<_>>();
    if owned_effects.is_empty() {
        return Err(PluginApplyCompensationPlanErrorV2::NoOwnedEffects);
    }
    if owned_effects.len() != steps.len()
        || owned_effects
            .iter()
            .zip(steps)
            .any(|(effect, step)| *effect != &step.source_effect)
        || owned_effects.iter().any(|effect| {
            !matches!(
                (operation_kind, &effect.disposition),
                (
                    crate::PluginApplyOperationKindV2::Install,
                    PluginApplyEffectDispositionV2::CreatedDureOwned,
                ) | (
                    crate::PluginApplyOperationKindV2::Uninstall,
                    PluginApplyEffectDispositionV2::RemovedDureOwned,
                )
            )
        })
        || steps.iter().any(|step| {
            step.expected_before != step.source_effect.after
                || step.expected_after != step.source_effect.before
                || !is_exact_inverse(step, marketplace_source)
        })
        || steps
            .windows(2)
            .any(|pair| pair[0].expected_after != pair[1].expected_before)
    {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidOwnedEffect);
    }
    Ok(())
}

pub fn validate_plugin_apply_compensation_completion(
    parent: &PluginApplyJournalReceiptV2,
    child: &PluginApplyJournalReceiptV2,
) -> Result<(), PluginApplyCompensationPlanErrorV2> {
    validate_plugin_apply_compensation_child(parent, child)?;
    if child.state != crate::PluginApplyJournalStateV2::Succeeded
        || child.recovery != PluginApplyRecoveryDirectiveV2::None
    {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidCompletion);
    }
    Ok(())
}

pub fn validate_plugin_apply_compensation_child(
    parent: &PluginApplyJournalReceiptV2,
    child: &PluginApplyJournalReceiptV2,
) -> Result<(), PluginApplyCompensationPlanErrorV2> {
    let link = parent
        .compensation
        .as_ref()
        .ok_or(PluginApplyCompensationPlanErrorV2::InvalidCompletion)?;
    let valid_parent_state = match (&parent.state, &parent.recovery) {
        (
            crate::PluginApplyJournalStateV2::Compensating,
            PluginApplyRecoveryDirectiveV2::RunCompensation { link: directive },
        ) => directive == link,
        (crate::PluginApplyJournalStateV2::Compensated, PluginApplyRecoveryDirectiveV2::None) => {
            true
        }
        _ => false,
    };
    let expected_kind = match parent.operation_kind {
        crate::PluginApplyOperationKindV2::Install => crate::PluginApplyOperationKindV2::Uninstall,
        crate::PluginApplyOperationKindV2::Uninstall => crate::PluginApplyOperationKindV2::Install,
    };
    let expected_steps = link
        .steps
        .iter()
        .map(|compensation| compensation.step.clone())
        .collect::<Vec<_>>();
    if !valid_parent_state
        || child.operation_id != link.operation_id
        || child.idempotency_key != link.idempotency_key
        || child.compensation_for.as_ref() != Some(&parent.operation_id)
        || child.plugin_id != parent.plugin_id
        || child.plugin_version != parent.plugin_version
        || child.target_bindings != parent.target_bindings
        || child.operation_kind != expected_kind
        || child.steps != expected_steps
        || child.compensation.is_some()
    {
        return Err(PluginApplyCompensationPlanErrorV2::InvalidCompletion);
    }
    validate_plugin_apply_compensation_steps(
        &parent.operation_kind,
        &parent.effects,
        &link.marketplace_source,
        &link.steps,
    )?;
    Ok(())
}

fn is_exact_inverse(
    compensation: &PluginApplyCompensationStepV2,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> bool {
    let source = &compensation.source_effect;
    if compensation.step.integration_id != source.step.integration_id
        || compensation.step.adapter != source.step.adapter
        || compensation.step.executable != source.step.executable
        || compensation.step.cli_version != source.step.cli_version
        || compensation.step.selector != source.step.selector
        || compensation.step.registration_target != source.step.registration_target
    {
        return false;
    }
    match (
        &source.disposition,
        &source.step.command,
        &compensation.step.command,
    ) {
        (
            PluginApplyEffectDispositionV2::CreatedDureOwned,
            AgentNativePluginCliCommandV2::AddMarketplace {
                scope: source_scope,
                output: source_output,
                ..
            },
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace,
                scope,
                output,
            },
        ) => {
            marketplace == &source.step.selector.marketplace
                && scope == source_scope
                && output == source_output
        }
        (
            PluginApplyEffectDispositionV2::CreatedDureOwned,
            AgentNativePluginCliCommandV2::InstallPlugin {
                scope: source_scope,
                output: source_output,
                ..
            },
            AgentNativePluginCliCommandV2::RemovePlugin {
                selector,
                scope,
                preserve_data,
                output,
            },
        ) => {
            selector == &source.step.selector
                && scope == source_scope
                && *preserve_data
                && output == source_output
        }
        (
            PluginApplyEffectDispositionV2::RemovedDureOwned,
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                scope: source_scope,
                output: source_output,
                ..
            },
            AgentNativePluginCliCommandV2::AddMarketplace {
                source,
                scope,
                output,
            },
        ) => source == marketplace_source && scope == source_scope && output == source_output,
        (
            PluginApplyEffectDispositionV2::RemovedDureOwned,
            AgentNativePluginCliCommandV2::RemovePlugin {
                scope: source_scope,
                output: source_output,
                ..
            },
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector,
                scope,
                output,
            },
        ) => selector == &source.step.selector && scope == source_scope && output == source_output,
        _ => false,
    }
}

fn build_plugin_apply_compensation_steps(
    effects: Vec<&PluginApplyEffectReceiptV2>,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> Result<Vec<PluginApplyCompensationStepV2>, PluginApplyCompensationPlanErrorV2> {
    effects
        .into_iter()
        .map(|effect| inverse_step(effect, marketplace_source))
        .collect()
}

fn inverse_step(
    effect: &PluginApplyEffectReceiptV2,
    marketplace_source: &AgentNativePluginMarketplaceSourceV2,
) -> Result<PluginApplyCompensationStepV2, PluginApplyCompensationPlanErrorV2> {
    let command = match (&effect.disposition, &effect.step.command) {
        (
            PluginApplyEffectDispositionV2::CreatedDureOwned,
            AgentNativePluginCliCommandV2::AddMarketplace { scope, output, .. },
        ) => AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace: effect.step.selector.marketplace.clone(),
            scope: scope.clone(),
            output: output.clone(),
        },
        (
            PluginApplyEffectDispositionV2::CreatedDureOwned,
            AgentNativePluginCliCommandV2::InstallPlugin { scope, output, .. },
        ) => AgentNativePluginCliCommandV2::RemovePlugin {
            selector: effect.step.selector.clone(),
            scope: scope.clone(),
            preserve_data: true,
            output: output.clone(),
        },
        (
            PluginApplyEffectDispositionV2::RemovedDureOwned,
            AgentNativePluginCliCommandV2::RemoveMarketplace { scope, output, .. },
        ) => AgentNativePluginCliCommandV2::AddMarketplace {
            source: marketplace_source.clone(),
            scope: scope.clone(),
            output: output.clone(),
        },
        (
            PluginApplyEffectDispositionV2::RemovedDureOwned,
            AgentNativePluginCliCommandV2::RemovePlugin { scope, output, .. },
        ) => AgentNativePluginCliCommandV2::InstallPlugin {
            selector: effect.step.selector.clone(),
            scope: scope.clone(),
            output: output.clone(),
        },
        _ => return Err(PluginApplyCompensationPlanErrorV2::InvalidOwnedEffect),
    };
    let mut step = effect.step.clone();
    step.command = command;
    Ok(PluginApplyCompensationStepV2 {
        source_effect: effect.clone(),
        step,
        expected_before: effect.after.clone(),
        expected_after: effect.before.clone(),
    })
}
