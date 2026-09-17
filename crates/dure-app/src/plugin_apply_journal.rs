use std::{error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativePluginCliCommandV2,
    AgentNativePluginExecutableV2, AgentNativePluginRegistrationTargetV2,
    AgentNativePluginSelectorV2, DomainStoreFuture, OperationEventIdV1, OperationIdV1,
    PluginApplyCompensationLinkV2, PluginIdV2, PluginNativePhysicalTargetBindingV2,
    PluginNativeStateObservationV2, PluginVersionV2, plugin_apply_compensation_identity,
    validate_plugin_apply_compensation_steps, validate_plugin_native_physical_target_bindings,
};

const MAX_PLUGIN_APPLY_EVENTS: usize = 16_384;
const MAX_PLUGIN_APPLY_STEPS: usize = 256;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct PluginTargetStateDigestV2(String);

impl PluginTargetStateDigestV2 {
    pub fn sha256(value: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(value.as_ref());
        Self(format!("sha256:{digest:x}"))
    }

    pub fn new(value: impl Into<String>) -> Result<Self, PluginApplyJournalErrorV2> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "targetStateDigest",
                reason: "must use a sha256: prefix".into(),
            });
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "targetStateDigest",
                reason: "must contain 64 lowercase hexadecimal characters".into(),
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginTargetStateDigestV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginApplyOperationKindV2 {
    Install,
    Uninstall,
}

impl PluginApplyOperationKindV2 {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Uninstall => "uninstall",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginNativeCommandHostFailureV2 {
    Spawn,
    OutputCapture,
    ProcessWait,
    Cleanup,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginNativeCommandOutcomeV2 {
    Succeeded,
    ExitedNonzero {
        exit_code: Option<i32>,
    },
    TimedOut,
    HostFailed {
        stage: PluginNativeCommandHostFailureV2,
    },
}

impl PluginNativeCommandOutcomeV2 {
    fn succeeded(&self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginApplyEffectDispositionV2 {
    CreatedDureOwned,
    RemovedDureOwned,
    PreservedDureOwned,
    PreservedExternal,
    NoChange,
}

impl PluginApplyEffectDispositionV2 {
    fn requires_compensation(&self) -> bool {
        matches!(self, Self::CreatedDureOwned | Self::RemovedDureOwned)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginApplyRecoveryStrategyV2 {
    Forward,
    CompensateOwned,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginApplyStepReconciliationV2 {
    NotApplied,
    Applied {
        disposition: PluginApplyEffectDispositionV2,
    },
    Diverged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyStepV2 {
    pub integration_id: AgentIntegrationIdV2,
    pub adapter: AgentAdapterIdV2,
    pub executable: AgentNativePluginExecutableV2,
    pub cli_version: PluginVersionV2,
    pub selector: AgentNativePluginSelectorV2,
    pub registration_target: AgentNativePluginRegistrationTargetV2,
    pub command: AgentNativePluginCliCommandV2,
}

impl PluginApplyStepV2 {
    fn is_mutation(&self) -> bool {
        matches!(
            self.command,
            AgentNativePluginCliCommandV2::AddMarketplace { .. }
                | AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
                | AgentNativePluginCliCommandV2::InstallPlugin { .. }
                | AgentNativePluginCliCommandV2::RemovePlugin { .. }
        )
    }

    fn validate(
        &self,
        operation_kind: &PluginApplyOperationKindV2,
    ) -> Result<(), PluginApplyJournalErrorV2> {
        if !self.executable.matches_adapter(&self.adapter) {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "steps.adapter",
                reason: "must match the native CLI executable".into(),
            });
        }
        match (&self.executable, &self.registration_target) {
            (
                AgentNativePluginExecutableV2::Codex,
                AgentNativePluginRegistrationTargetV2::ManagedProfile { .. },
            )
            | (
                AgentNativePluginExecutableV2::Claude,
                AgentNativePluginRegistrationTargetV2::User { .. }
                | AgentNativePluginRegistrationTargetV2::Workspace { .. },
            ) => {}
            _ => {
                return Err(PluginApplyJournalErrorV2::InvalidEvent {
                    field: "steps.registrationTarget",
                    reason: "is not valid for the native CLI executable".into(),
                });
            }
        }

        match (&self.command, operation_kind) {
            (
                AgentNativePluginCliCommandV2::RemovePlugin { .. },
                PluginApplyOperationKindV2::Install,
            )
            | (
                AgentNativePluginCliCommandV2::RemoveMarketplace { .. },
                PluginApplyOperationKindV2::Install,
            )
            | (
                AgentNativePluginCliCommandV2::AddMarketplace { .. }
                | AgentNativePluginCliCommandV2::InstallPlugin { .. },
                PluginApplyOperationKindV2::Uninstall,
            ) => {
                return Err(PluginApplyJournalErrorV2::InvalidEvent {
                    field: "steps.command",
                    reason: "does not belong to the lifecycle operation".into(),
                });
            }
            _ => {}
        }

        match &self.command {
            AgentNativePluginCliCommandV2::ListMarketplaces { .. } => Ok(()),
            AgentNativePluginCliCommandV2::AddMarketplace { scope, .. } => {
                self.validate_scope(scope)
            }
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace, scope, ..
            } => {
                if marketplace != &self.selector.marketplace {
                    return Err(PluginApplyJournalErrorV2::InvalidEvent {
                        field: "steps.command.marketplace",
                        reason: "must match the step selector".into(),
                    });
                }
                self.validate_scope(scope)
            }
            AgentNativePluginCliCommandV2::ListPlugins { marketplace, .. } => {
                if marketplace != &self.selector.marketplace {
                    return Err(PluginApplyJournalErrorV2::InvalidEvent {
                        field: "steps.command.marketplace",
                        reason: "must match the step selector".into(),
                    });
                }
                Ok(())
            }
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector, scope, ..
            } => {
                self.validate_selector(selector)?;
                self.validate_scope(scope)
            }
            AgentNativePluginCliCommandV2::RemovePlugin {
                selector,
                scope,
                preserve_data,
                ..
            } => {
                self.validate_selector(selector)?;
                self.validate_scope(scope)?;
                if !preserve_data {
                    return Err(PluginApplyJournalErrorV2::InvalidEvent {
                        field: "steps.command.preserveData",
                        reason: "must preserve native plugin data".into(),
                    });
                }
                Ok(())
            }
        }
    }

    fn validate_selector(
        &self,
        selector: &AgentNativePluginSelectorV2,
    ) -> Result<(), PluginApplyJournalErrorV2> {
        if selector != &self.selector {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "steps.command.selector",
                reason: "must match the step selector".into(),
            });
        }
        Ok(())
    }

    fn validate_scope(&self, scope: &AgentInstallScopeV2) -> Result<(), PluginApplyJournalErrorV2> {
        let valid = matches!(
            (&self.executable, scope, &self.registration_target,),
            (
                AgentNativePluginExecutableV2::Codex,
                AgentInstallScopeV2::Managed,
                AgentNativePluginRegistrationTargetV2::ManagedProfile { .. },
            ) | (
                AgentNativePluginExecutableV2::Claude,
                AgentInstallScopeV2::User,
                AgentNativePluginRegistrationTargetV2::User { .. },
            ) | (
                AgentNativePluginExecutableV2::Claude,
                AgentInstallScopeV2::Project | AgentInstallScopeV2::Local,
                AgentNativePluginRegistrationTargetV2::Workspace { .. },
            )
        );
        if !valid {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "steps.command.scope",
                reason: "does not match the exact registration target".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginApplyJournalEventBodyV2 {
    Started {
        idempotency_key: String,
        plugin_id: PluginIdV2,
        plugin_version: PluginVersionV2,
        #[serde(default)]
        compensation_for: Option<OperationIdV1>,
        #[serde(default)]
        target_bindings: Option<Vec<PluginNativePhysicalTargetBindingV2>>,
        operation_kind: PluginApplyOperationKindV2,
        steps: Vec<PluginApplyStepV2>,
    },
    StepPrepared {
        step_index: u32,
        attempt: u32,
        before: PluginNativeStateObservationV2,
    },
    StepObserved {
        step_index: u32,
        attempt: u32,
        outcome: PluginNativeCommandOutcomeV2,
        after: PluginNativeStateObservationV2,
    },
    EffectRecorded {
        step_index: u32,
        attempt: u32,
        disposition: PluginApplyEffectDispositionV2,
    },
    StepReconciled {
        step_index: u32,
        attempt: u32,
        observed: PluginNativeStateObservationV2,
        resolution: PluginApplyStepReconciliationV2,
    },
    RecoveryResumed {
        strategy: PluginApplyRecoveryStrategyV2,
    },
    CompensationLinked {
        link: PluginApplyCompensationLinkV2,
    },
    Compensated {
        operation_id: OperationIdV1,
    },
    Succeeded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyJournalEventV2 {
    pub event_id: OperationEventIdV1,
    pub operation_id: OperationIdV1,
    pub sequence: u32,
    pub body: PluginApplyJournalEventBodyV2,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyStepCheckpointV2 {
    pub step_index: u32,
    pub attempt: u32,
    pub before: PluginNativeStateObservationV2,
    pub outcome: Option<PluginNativeCommandOutcomeV2>,
    pub after: Option<PluginNativeStateObservationV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyEffectReceiptV2 {
    pub step_index: u32,
    pub attempt: u32,
    pub step: PluginApplyStepV2,
    pub before: PluginNativeStateObservationV2,
    pub after: PluginNativeStateObservationV2,
    pub disposition: PluginApplyEffectDispositionV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginApplyJournalStateV2 {
    Applying,
    InspectBeforeRetry,
    RecoveryRequired,
    Compensating,
    Compensated,
    Succeeded,
}

impl PluginApplyJournalStateV2 {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Applying => "applying",
            Self::InspectBeforeRetry => "inspect_before_retry",
            Self::RecoveryRequired => "recovery_required",
            Self::Compensating => "compensating",
            Self::Compensated => "compensated",
            Self::Succeeded => "succeeded",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginApplyRecoveryDirectiveV2 {
    Continue {
        step_index: u32,
        next_attempt: u32,
    },
    InspectBeforeRetry {
        checkpoint: PluginApplyStepCheckpointV2,
    },
    ChooseRecovery {
        checkpoint: PluginApplyStepCheckpointV2,
        next_attempt: u32,
    },
    CompensateOwned {
        effects: Vec<PluginApplyEffectReceiptV2>,
    },
    RunCompensation {
        link: PluginApplyCompensationLinkV2,
    },
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginApplyJournalReceiptV2 {
    pub operation_id: OperationIdV1,
    pub idempotency_key: String,
    pub plugin_id: PluginIdV2,
    pub plugin_version: PluginVersionV2,
    pub compensation_for: Option<OperationIdV1>,
    #[serde(default)]
    pub target_bindings: Option<Vec<PluginNativePhysicalTargetBindingV2>>,
    pub operation_kind: PluginApplyOperationKindV2,
    pub steps: Vec<PluginApplyStepV2>,
    pub state: PluginApplyJournalStateV2,
    pub last_sequence: u32,
    pub next_step_index: u32,
    pub recovery: PluginApplyRecoveryDirectiveV2,
    pub effects: Vec<PluginApplyEffectReceiptV2>,
    pub compensation: Option<PluginApplyCompensationLinkV2>,
    pub last_failure: Option<PluginApplyStepCheckpointV2>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub trait PluginApplyJournalStore: Send + Sync {
    fn append_plugin_apply_event<'a>(
        &'a self,
        event: &'a PluginApplyJournalEventV2,
    ) -> DomainStoreFuture<'a, PluginApplyJournalReceiptV2>;

    fn plugin_apply_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<PluginApplyJournalReceiptV2>>;

    fn plugin_native_ownership<'a>(
        &'a self,
        ownership_key: &'a crate::PluginNativeOwnershipKeyV2,
    ) -> DomainStoreFuture<'a, Option<crate::PluginNativeOwnershipReceiptV2>>;

    fn rebuild_plugin_apply_receipts(&self) -> DomainStoreFuture<'_, usize>;

    fn rebuild_plugin_native_ownership(&self) -> DomainStoreFuture<'_, usize>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginApplyJournalErrorV2 {
    InvalidEvent { field: &'static str, reason: String },
    InvalidStream { reason: String },
}

impl fmt::Display for PluginApplyJournalErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEvent { field, reason } => {
                write!(
                    formatter,
                    "invalid plugin apply event field {field}: {reason}"
                )
            }
            Self::InvalidStream { reason } => {
                write!(formatter, "invalid plugin apply event stream: {reason}")
            }
        }
    }
}

impl Error for PluginApplyJournalErrorV2 {}

pub fn fold_plugin_apply_journal(
    events: &[PluginApplyJournalEventV2],
) -> Result<PluginApplyJournalReceiptV2, PluginApplyJournalErrorV2> {
    if events.len() > MAX_PLUGIN_APPLY_EVENTS {
        return Err(invalid_stream(format!(
            "operation exceeds {MAX_PLUGIN_APPLY_EVENTS} journal events"
        )));
    }
    let first = events
        .first()
        .ok_or_else(|| invalid_stream("operation has no events"))?;
    validate_event_record(first)?;
    if first.sequence != 1 {
        return Err(invalid_stream("the first event sequence must be 1"));
    }
    let PluginApplyJournalEventBodyV2::Started {
        idempotency_key,
        plugin_id,
        plugin_version,
        compensation_for,
        target_bindings,
        operation_kind,
        steps,
    } = &first.body
    else {
        return Err(invalid_stream("sequence 1 must be plugin apply started"));
    };
    validate_started(
        idempotency_key,
        operation_kind,
        steps,
        target_bindings.as_deref(),
    )?;
    if compensation_for.as_ref() == Some(&first.operation_id) {
        return Err(invalid_stream(
            "a compensation operation cannot reference itself",
        ));
    }

    let mut state = PluginApplyJournalStateV2::Applying;
    let mut next_step_index = 0_u32;
    let mut attempts = vec![0_u32; steps.len()];
    let mut checkpoint: Option<PluginApplyStepCheckpointV2> = None;
    let mut pending_effect: Option<PluginApplyStepCheckpointV2> = None;
    let mut failed_checkpoint: Option<PluginApplyStepCheckpointV2> = None;
    let mut effects = Vec::new();
    let mut compensation: Option<PluginApplyCompensationLinkV2> = None;
    let mut updated_at_ms = first.recorded_at_ms;

    for (offset, event) in events.iter().enumerate().skip(1) {
        validate_event_record(event)?;
        let expected_sequence =
            u32::try_from(offset + 1).map_err(|_| invalid_stream("event stream is too large"))?;
        if event.sequence != expected_sequence {
            return Err(invalid_stream(format!(
                "expected sequence {expected_sequence}, found {}",
                event.sequence
            )));
        }
        if event.operation_id != first.operation_id {
            return Err(invalid_stream("an event belongs to a different operation"));
        }
        if event.recorded_at_ms < updated_at_ms {
            return Err(invalid_stream("event timestamps must be monotonic"));
        }
        if matches!(
            state,
            PluginApplyJournalStateV2::Compensated | PluginApplyJournalStateV2::Succeeded
        ) {
            return Err(invalid_stream("events cannot follow a terminal event"));
        }

        match &event.body {
            PluginApplyJournalEventBodyV2::Started { .. } => {
                return Err(invalid_stream(
                    "plugin apply started may only appear at sequence 1",
                ));
            }
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index,
                attempt,
                before,
            } => {
                validate_observation(before, "step preparation")?;
                if state != PluginApplyJournalStateV2::Applying
                    || checkpoint.is_some()
                    || pending_effect.is_some()
                    || *step_index != next_step_index
                {
                    return Err(invalid_stream(
                        "step preparation does not match the next runnable step",
                    ));
                }
                let attempt_slot = attempts
                    .get_mut(*step_index as usize)
                    .ok_or_else(|| invalid_stream("step index is outside the plan"))?;
                let expected_attempt = attempt_slot
                    .checked_add(1)
                    .ok_or_else(|| invalid_stream("step attempt overflowed"))?;
                if *attempt != expected_attempt {
                    return Err(invalid_stream(format!(
                        "expected step attempt {expected_attempt}, found {attempt}"
                    )));
                }
                *attempt_slot = *attempt;
                checkpoint = Some(PluginApplyStepCheckpointV2 {
                    step_index: *step_index,
                    attempt: *attempt,
                    before: before.clone(),
                    outcome: None,
                    after: None,
                });
            }
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index,
                attempt,
                outcome,
                after,
            } => {
                validate_observation(after, "step outcome")?;
                let mut observed = checkpoint
                    .take()
                    .ok_or_else(|| invalid_stream("step outcome has no prepared checkpoint"))?;
                if observed.step_index != *step_index || observed.attempt != *attempt {
                    return Err(invalid_stream(
                        "step outcome does not match the prepared checkpoint",
                    ));
                }
                observed.outcome = Some(outcome.clone());
                observed.after = Some(after.clone());
                if steps[*step_index as usize].is_mutation() {
                    pending_effect = Some(observed);
                } else if outcome.succeeded() {
                    next_step_index = next_step_index
                        .checked_add(1)
                        .ok_or_else(|| invalid_stream("step index overflowed"))?;
                } else {
                    failed_checkpoint = Some(observed);
                    state = PluginApplyJournalStateV2::RecoveryRequired;
                }
            }
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index,
                attempt,
                disposition,
            } => {
                let observed = pending_effect
                    .take()
                    .ok_or_else(|| invalid_stream("effect has no successful mutation"))?;
                if observed.step_index != *step_index || observed.attempt != *attempt {
                    return Err(invalid_stream(
                        "effect does not match the successful mutation",
                    ));
                }
                let after = observed
                    .after
                    .clone()
                    .ok_or_else(|| invalid_stream("successful mutation has no after digest"))?;
                validate_effect_disposition(
                    operation_kind,
                    &steps[*step_index as usize],
                    &observed.before.digest,
                    &after.digest,
                    disposition,
                )?;
                effects.push(PluginApplyEffectReceiptV2 {
                    step_index: *step_index,
                    attempt: *attempt,
                    step: steps[*step_index as usize].clone(),
                    before: observed.before,
                    after,
                    disposition: disposition.clone(),
                });
                next_step_index = next_step_index
                    .checked_add(1)
                    .ok_or_else(|| invalid_stream("step index overflowed"))?;
            }
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index,
                attempt,
                observed,
                resolution,
            } => {
                validate_observation(observed, "step reconciliation")?;
                let mut uncertain = match (checkpoint.take(), pending_effect.take()) {
                    (Some(checkpoint), None) | (None, Some(checkpoint)) => checkpoint,
                    (None, None) => {
                        return Err(invalid_stream(
                            "step reconciliation has no uncertain checkpoint",
                        ));
                    }
                    (Some(_), Some(_)) => {
                        return Err(invalid_stream(
                            "step reconciliation found multiple uncertain checkpoints",
                        ));
                    }
                };
                if uncertain.step_index != *step_index || uncertain.attempt != *attempt {
                    return Err(invalid_stream(
                        "step reconciliation does not match the uncertain checkpoint",
                    ));
                }
                match resolution {
                    PluginApplyStepReconciliationV2::NotApplied => {
                        if uncertain.outcome == Some(PluginNativeCommandOutcomeV2::Succeeded) {
                            return Err(invalid_stream(
                                "an observed successful mutation needs an ownership disposition",
                            ));
                        }
                        if uncertain.before.digest != observed.digest {
                            return Err(invalid_stream(
                                "not-applied reconciliation must preserve the before digest",
                            ));
                        }
                    }
                    PluginApplyStepReconciliationV2::Applied { disposition } => {
                        if !steps[*step_index as usize].is_mutation() {
                            return Err(invalid_stream(
                                "a read-only step cannot record a mutation effect",
                            ));
                        }
                        uncertain.after = Some(observed.clone());
                        validate_effect_disposition(
                            operation_kind,
                            &steps[*step_index as usize],
                            &uncertain.before.digest,
                            &observed.digest,
                            disposition,
                        )?;
                        effects.push(PluginApplyEffectReceiptV2 {
                            step_index: *step_index,
                            attempt: *attempt,
                            step: steps[*step_index as usize].clone(),
                            before: uncertain.before,
                            after: observed.clone(),
                            disposition: disposition.clone(),
                        });
                        next_step_index = next_step_index
                            .checked_add(1)
                            .ok_or_else(|| invalid_stream("step index overflowed"))?;
                    }
                    PluginApplyStepReconciliationV2::Diverged => {
                        uncertain.after = Some(observed.clone());
                        failed_checkpoint = Some(uncertain);
                        state = PluginApplyJournalStateV2::RecoveryRequired;
                    }
                }
            }
            PluginApplyJournalEventBodyV2::RecoveryResumed { strategy } => {
                if state != PluginApplyJournalStateV2::RecoveryRequired {
                    return Err(invalid_stream(
                        "recovery can only resume after an observed command failure",
                    ));
                }
                match strategy {
                    PluginApplyRecoveryStrategyV2::Forward => {
                        let failure = failed_checkpoint
                            .as_ref()
                            .ok_or_else(|| invalid_stream("recovery has no failed checkpoint"))?;
                        if failure.after.as_ref().map(|after| &after.digest)
                            != Some(&failure.before.digest)
                        {
                            return Err(invalid_stream(
                                "forward retry requires an unchanged target digest",
                            ));
                        }
                        state = PluginApplyJournalStateV2::Applying;
                        failed_checkpoint = None;
                    }
                    PluginApplyRecoveryStrategyV2::CompensateOwned => {
                        if compensation_for.is_some() {
                            return Err(invalid_stream(
                                "a compensation child cannot start nested compensation",
                            ));
                        }
                        state = PluginApplyJournalStateV2::Compensating;
                    }
                }
            }
            PluginApplyJournalEventBodyV2::CompensationLinked { link } => {
                if state != PluginApplyJournalStateV2::Compensating || compensation.is_some() {
                    return Err(invalid_stream(
                        "compensation can only be linked once after recovery resumes",
                    ));
                }
                if link.operation_id == first.operation_id {
                    return Err(invalid_stream(
                        "compensation operation must differ from its parent",
                    ));
                }
                let (expected_operation_id, expected_idempotency_key) =
                    plugin_apply_compensation_identity(&first.operation_id)
                        .map_err(|error| invalid_stream(error.to_string()))?;
                if link.operation_id != expected_operation_id
                    || link.idempotency_key != expected_idempotency_key
                {
                    return Err(invalid_stream(
                        "compensation link identity is not deterministic for its parent",
                    ));
                }
                if !valid_idempotency_key(&link.idempotency_key) {
                    return Err(invalid_stream(
                        "compensation idempotency key is not a bounded stable identifier",
                    ));
                }
                validate_plugin_apply_compensation_steps(
                    operation_kind,
                    &effects,
                    &link.marketplace_source,
                    &link.steps,
                )
                .map_err(|error| invalid_stream(error.to_string()))?;
                compensation = Some(link.clone());
            }
            PluginApplyJournalEventBodyV2::Compensated { operation_id } => {
                let link = compensation.as_ref().ok_or_else(|| {
                    invalid_stream("compensation cannot complete before its child is linked")
                })?;
                if state != PluginApplyJournalStateV2::Compensating
                    || operation_id != &link.operation_id
                {
                    return Err(invalid_stream(
                        "compensation completion does not match the linked child",
                    ));
                }
                state = PluginApplyJournalStateV2::Compensated;
            }
            PluginApplyJournalEventBodyV2::Succeeded => {
                if state != PluginApplyJournalStateV2::Applying
                    || checkpoint.is_some()
                    || pending_effect.is_some()
                    || next_step_index as usize != steps.len()
                {
                    return Err(invalid_stream(
                        "operation cannot succeed before every planned step is recorded",
                    ));
                }
                state = PluginApplyJournalStateV2::Succeeded;
            }
        }
        updated_at_ms = event.recorded_at_ms;
    }

    if state == PluginApplyJournalStateV2::Applying
        && (checkpoint.is_some() || pending_effect.is_some())
    {
        state = PluginApplyJournalStateV2::InspectBeforeRetry;
    }
    let recovery = match state {
        PluginApplyJournalStateV2::Applying => PluginApplyRecoveryDirectiveV2::Continue {
            step_index: next_step_index,
            next_attempt: next_attempt(&attempts, next_step_index),
        },
        PluginApplyJournalStateV2::InspectBeforeRetry => {
            PluginApplyRecoveryDirectiveV2::InspectBeforeRetry {
                checkpoint: checkpoint
                    .or(pending_effect)
                    .ok_or_else(|| invalid_stream("inspection has no checkpoint"))?,
            }
        }
        PluginApplyJournalStateV2::RecoveryRequired => {
            let checkpoint = failed_checkpoint
                .clone()
                .ok_or_else(|| invalid_stream("recovery has no failed checkpoint"))?;
            PluginApplyRecoveryDirectiveV2::ChooseRecovery {
                next_attempt: next_attempt(&attempts, checkpoint.step_index),
                checkpoint,
            }
        }
        PluginApplyJournalStateV2::Compensating => match compensation.clone() {
            Some(link) => PluginApplyRecoveryDirectiveV2::RunCompensation { link },
            None => {
                let compensatable = effects
                    .iter()
                    .rev()
                    .filter(|effect| effect.disposition.requires_compensation())
                    .cloned()
                    .collect();
                PluginApplyRecoveryDirectiveV2::CompensateOwned {
                    effects: compensatable,
                }
            }
        },
        PluginApplyJournalStateV2::Compensated | PluginApplyJournalStateV2::Succeeded => {
            PluginApplyRecoveryDirectiveV2::None
        }
    };

    Ok(PluginApplyJournalReceiptV2 {
        operation_id: first.operation_id.clone(),
        idempotency_key: idempotency_key.clone(),
        plugin_id: plugin_id.clone(),
        plugin_version: plugin_version.clone(),
        compensation_for: compensation_for.clone(),
        target_bindings: target_bindings.clone(),
        operation_kind: operation_kind.clone(),
        steps: steps.clone(),
        state,
        last_sequence: events.last().expect("non-empty event stream").sequence,
        next_step_index,
        recovery,
        effects,
        compensation,
        last_failure: failed_checkpoint,
        created_at_ms: first.recorded_at_ms,
        updated_at_ms,
    })
}

fn validate_observation(
    observation: &PluginNativeStateObservationV2,
    context: &str,
) -> Result<(), PluginApplyJournalErrorV2> {
    if observation.has_valid_digest() {
        Ok(())
    } else {
        Err(invalid_stream(format!(
            "{context} state does not match its target digest"
        )))
    }
}

fn validate_effect_disposition(
    operation_kind: &PluginApplyOperationKindV2,
    step: &PluginApplyStepV2,
    before_digest: &PluginTargetStateDigestV2,
    after_digest: &PluginTargetStateDigestV2,
    disposition: &PluginApplyEffectDispositionV2,
) -> Result<(), PluginApplyJournalErrorV2> {
    if !step.is_mutation() {
        return Err(invalid_stream(
            "a read-only step cannot record an ownership effect",
        ));
    }
    let changed = before_digest != after_digest;
    let should_change = matches!(
        disposition,
        PluginApplyEffectDispositionV2::CreatedDureOwned
            | PluginApplyEffectDispositionV2::RemovedDureOwned
    );
    if changed != should_change {
        return Err(invalid_stream(
            "effect disposition does not match the observed target digest change",
        ));
    }
    if matches!(
        (operation_kind, disposition),
        (
            PluginApplyOperationKindV2::Install,
            PluginApplyEffectDispositionV2::RemovedDureOwned,
        ) | (
            PluginApplyOperationKindV2::Uninstall,
            PluginApplyEffectDispositionV2::CreatedDureOwned,
        )
    ) {
        return Err(invalid_stream(
            "effect disposition points in the wrong lifecycle direction",
        ));
    }
    Ok(())
}

fn validate_started(
    idempotency_key: &str,
    operation_kind: &PluginApplyOperationKindV2,
    steps: &[PluginApplyStepV2],
    target_bindings: Option<&[PluginNativePhysicalTargetBindingV2]>,
) -> Result<(), PluginApplyJournalErrorV2> {
    if !valid_idempotency_key(idempotency_key) {
        return Err(PluginApplyJournalErrorV2::InvalidEvent {
            field: "idempotencyKey",
            reason: "must be a bounded stable token".into(),
        });
    }
    if steps.is_empty() || steps.len() > MAX_PLUGIN_APPLY_STEPS {
        return Err(PluginApplyJournalErrorV2::InvalidEvent {
            field: "steps",
            reason: format!(
                "must contain between 1 and {MAX_PLUGIN_APPLY_STEPS} exact native commands"
            ),
        });
    }
    for (index, step) in steps.iter().enumerate() {
        step.validate(operation_kind)?;
        if steps[..index].contains(step) {
            return Err(PluginApplyJournalErrorV2::InvalidEvent {
                field: "steps",
                reason: "must not repeat an identical native command".into(),
            });
        }
    }
    if let Some(target_bindings) = target_bindings {
        validate_plugin_native_physical_target_bindings(steps, target_bindings).map_err(
            |error| PluginApplyJournalErrorV2::InvalidEvent {
                field: "targetBindings",
                reason: error.to_string(),
            },
        )?;
    }
    Ok(())
}

fn valid_idempotency_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn validate_event_record(
    event: &PluginApplyJournalEventV2,
) -> Result<(), PluginApplyJournalErrorV2> {
    if event.sequence < 1 {
        return Err(PluginApplyJournalErrorV2::InvalidEvent {
            field: "sequence",
            reason: "must be positive".into(),
        });
    }
    if event.recorded_at_ms < 0 {
        return Err(PluginApplyJournalErrorV2::InvalidEvent {
            field: "recordedAtMs",
            reason: "must be non-negative".into(),
        });
    }
    Ok(())
}

fn next_attempt(attempts: &[u32], step_index: u32) -> u32 {
    attempts
        .get(step_index as usize)
        .copied()
        .unwrap_or(0)
        .saturating_add(1)
}

fn invalid_stream(reason: impl Into<String>) -> PluginApplyJournalErrorV2 {
    PluginApplyJournalErrorV2::InvalidStream {
        reason: reason.into(),
    }
}
