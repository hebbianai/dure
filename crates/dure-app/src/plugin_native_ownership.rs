use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativePluginCliCommandV2,
    AgentNativePluginRegistrationTargetV2, OperationEventIdV1, OperationIdV1,
    PluginApplyEffectDispositionV2, PluginApplyStepV2, PluginIdV2, PluginTargetStateDigestV2,
    PluginVersionV2,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginNativeOwnedComponentV2 {
    Marketplace,
    Plugin,
}

impl PluginNativeOwnedComponentV2 {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Marketplace => "marketplace",
            Self::Plugin => "plugin",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PluginNativeOwnershipKeyV2(String);

impl PluginNativeOwnershipKeyV2 {
    fn sha256(value: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(value.as_ref());
        Self(format!("sha256:{digest:x}"))
    }

    pub fn new(value: impl Into<String>) -> Result<Self, PluginNativeOwnershipErrorV2> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(PluginNativeOwnershipErrorV2::InvalidKey);
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginNativeOwnershipErrorV2::InvalidKey);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginNativeOwnershipKeyV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativeOwnershipTargetV2 {
    pub key: PluginNativeOwnershipKeyV2,
    pub component: PluginNativeOwnedComponentV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativeOwnershipReceiptV2 {
    pub target: PluginNativeOwnershipTargetV2,
    pub owner_plugin_id: PluginIdV2,
    pub owner_plugin_version: PluginVersionV2,
    pub owner_integration_id: AgentIntegrationIdV2,
    pub owner_operation_id: OperationIdV1,
    pub owner_event_id: OperationEventIdV1,
    pub owner_step_index: u32,
    pub owner_attempt: u32,
    pub after_digest: PluginTargetStateDigestV2,
    pub claimed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginNativeOwnershipLedgerEventBodyV2 {
    Claimed {
        ownership: PluginNativeOwnershipReceiptV2,
    },
    Released {
        ownership: PluginNativeOwnershipReceiptV2,
        disposition: PluginApplyEffectDispositionV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativeOwnershipLedgerEventV2 {
    pub revision: u64,
    pub journal_event_id: OperationEventIdV1,
    pub operation_id: OperationIdV1,
    pub step_index: u32,
    pub attempt: u32,
    pub body: PluginNativeOwnershipLedgerEventBodyV2,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeOwnershipErrorV2 {
    InvalidKey,
    AdapterMismatch,
    InvalidRegistrationTarget,
    SelectorMismatch,
    ReadOnlyCommand,
    InvalidLedger { reason: String },
    InvalidChange { reason: String },
}

impl fmt::Display for PluginNativeOwnershipErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidKey => "native plugin ownership key is not a lowercase SHA-256 digest",
            Self::AdapterMismatch => {
                "native plugin ownership target has a mismatched adapter and executable"
            }
            Self::InvalidRegistrationTarget => {
                "native plugin ownership target does not match its executable and scope"
            }
            Self::SelectorMismatch => {
                "native plugin ownership target has inconsistent command selectors"
            }
            Self::ReadOnlyCommand => "read-only native plugin commands do not own state",
            Self::InvalidLedger { reason } => {
                write!(
                    formatter,
                    "invalid native plugin ownership ledger: {reason}"
                )?;
                return Ok(());
            }
            Self::InvalidChange { reason } => {
                write!(
                    formatter,
                    "invalid native plugin ownership change: {reason}"
                )?;
                return Ok(());
            }
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeOwnershipErrorV2 {}

pub fn plugin_native_ownership_target(
    step: &PluginApplyStepV2,
) -> Result<PluginNativeOwnershipTargetV2, PluginNativeOwnershipErrorV2> {
    if !step.executable.matches_adapter(&step.adapter) {
        return Err(PluginNativeOwnershipErrorV2::AdapterMismatch);
    }
    let (component, scope) = match &step.command {
        AgentNativePluginCliCommandV2::AddMarketplace { scope, .. } => {
            (PluginNativeOwnedComponentV2::Marketplace, scope)
        }
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace, scope, ..
        } => {
            if marketplace != &step.selector.marketplace {
                return Err(PluginNativeOwnershipErrorV2::SelectorMismatch);
            }
            (PluginNativeOwnedComponentV2::Marketplace, scope)
        }
        AgentNativePluginCliCommandV2::InstallPlugin { scope, .. }
        | AgentNativePluginCliCommandV2::RemovePlugin { scope, .. } => {
            let selector = match &step.command {
                AgentNativePluginCliCommandV2::InstallPlugin { selector, .. }
                | AgentNativePluginCliCommandV2::RemovePlugin { selector, .. } => selector,
                _ => unreachable!("the outer match selected a plugin mutation"),
            };
            if selector != &step.selector {
                return Err(PluginNativeOwnershipErrorV2::SelectorMismatch);
            }
            (PluginNativeOwnedComponentV2::Plugin, scope)
        }
        AgentNativePluginCliCommandV2::ListMarketplaces { .. }
        | AgentNativePluginCliCommandV2::ListPlugins { .. } => {
            return Err(PluginNativeOwnershipErrorV2::ReadOnlyCommand);
        }
    };
    if !registration_target_matches(&step.executable, scope, &step.registration_target) {
        return Err(PluginNativeOwnershipErrorV2::InvalidRegistrationTarget);
    }

    let mut identity = String::from("dure-plugin-native-ownership/v2\0");
    push_field(&mut identity, component.as_str());
    push_field(&mut identity, step.executable.as_str());
    push_field(&mut identity, step.adapter.as_str());
    push_scope(&mut identity, scope);
    push_registration_target(&mut identity, &step.registration_target);
    push_field(&mut identity, step.selector.marketplace.as_str());
    if component == PluginNativeOwnedComponentV2::Plugin {
        push_field(&mut identity, step.selector.plugin.as_str());
    }

    Ok(PluginNativeOwnershipTargetV2 {
        key: PluginNativeOwnershipKeyV2::sha256(identity),
        component,
    })
}

pub fn fold_plugin_native_ownership_ledger(
    events: &[PluginNativeOwnershipLedgerEventV2],
) -> Result<
    BTreeMap<PluginNativeOwnershipKeyV2, PluginNativeOwnershipReceiptV2>,
    PluginNativeOwnershipErrorV2,
> {
    let mut projection = BTreeMap::new();
    let mut previous_revision = 0_u64;
    for event in events {
        if event.revision == 0 || event.revision <= previous_revision {
            return Err(invalid_ledger(
                "revisions must be positive and strictly increasing",
            ));
        }
        if event.recorded_at_ms < 0 {
            return Err(invalid_ledger("event timestamp must be non-negative"));
        }
        match &event.body {
            PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } => {
                if ownership.owner_operation_id != event.operation_id
                    || ownership.owner_event_id != event.journal_event_id
                    || ownership.owner_step_index != event.step_index
                    || ownership.owner_attempt != event.attempt
                    || ownership.claimed_at_ms != event.recorded_at_ms
                {
                    return Err(invalid_ledger(
                        "claim identity must match its source journal event",
                    ));
                }
                if projection
                    .insert(ownership.target.key.clone(), ownership.clone())
                    .is_some()
                {
                    return Err(invalid_ledger(
                        "a component cannot be claimed while it is already owned",
                    ));
                }
            }
            PluginNativeOwnershipLedgerEventBodyV2::Released {
                ownership,
                disposition,
            } => {
                if !matches!(
                    disposition,
                    PluginApplyEffectDispositionV2::RemovedDureOwned
                        | PluginApplyEffectDispositionV2::NoChange
                ) {
                    return Err(invalid_ledger(
                        "release disposition must consume existing ownership",
                    ));
                }
                let Some(current) = projection.remove(&ownership.target.key) else {
                    return Err(invalid_ledger(
                        "a component cannot be released without current ownership",
                    ));
                };
                if current != *ownership {
                    return Err(invalid_ledger(
                        "release receipt does not match the current owner",
                    ));
                }
            }
        }
        previous_revision = event.revision;
    }
    Ok(projection)
}

pub struct PluginNativeOwnershipChangeV2<'a> {
    pub revision: u64,
    pub journal_event: &'a crate::PluginApplyJournalEventV2,
    pub receipt: &'a crate::PluginApplyJournalReceiptV2,
    pub existing: Option<&'a PluginNativeOwnershipReceiptV2>,
}

pub fn plugin_native_ownership_target_for_journal_event(
    journal_event: &crate::PluginApplyJournalEventV2,
    receipt: &crate::PluginApplyJournalReceiptV2,
) -> Result<Option<PluginNativeOwnershipTargetV2>, PluginNativeOwnershipErrorV2> {
    let Some((step_index, attempt, disposition)) = journal_effect(journal_event) else {
        return Ok(None);
    };
    validate_journal_effect(journal_event, receipt, step_index, attempt, &disposition)?;
    let effect = receipt
        .effects
        .last()
        .expect("validated ownership journal events have an effect receipt");
    plugin_native_ownership_target(&effect.step).map(Some)
}

pub fn derive_plugin_native_ownership_ledger_event(
    change: PluginNativeOwnershipChangeV2<'_>,
) -> Result<Option<PluginNativeOwnershipLedgerEventV2>, PluginNativeOwnershipErrorV2> {
    let PluginNativeOwnershipChangeV2 {
        revision,
        journal_event,
        receipt,
        existing,
    } = change;
    let Some((step_index, attempt, disposition)) = journal_effect(journal_event) else {
        return Ok(None);
    };
    if revision == 0 {
        return Err(invalid_change("ownership ledger revision must be positive"));
    }
    validate_journal_effect(journal_event, receipt, step_index, attempt, &disposition)?;
    let effect = receipt
        .effects
        .last()
        .expect("validated ownership journal events have an effect receipt");
    let target = plugin_native_ownership_target(&effect.step)?;
    if existing.is_some_and(|ownership| ownership.target != target) {
        return Err(invalid_change(
            "existing ownership belongs to a different native component",
        ));
    }
    let classified =
        crate::classify_plugin_native_mutation(crate::PluginNativeMutationObservationV2 {
            command: &effect.step.command,
            expected_plugin_version: &receipt.plugin_version,
            existing_ownership: if existing.is_some() {
                crate::PluginNativeExistingOwnershipV2::DureOwned
            } else {
                crate::PluginNativeExistingOwnershipV2::Unproven
            },
            before: &effect.before.state,
            after: &effect.after.state,
        })
        .map_err(|error| invalid_change(format!("effect transition is unsafe: {error}")))?;
    if classified != disposition {
        return Err(invalid_change(
            "effect disposition differs from the classified state transition",
        ));
    }

    let body = match (&receipt.operation_kind, &disposition, existing) {
        (
            crate::PluginApplyOperationKindV2::Install,
            crate::PluginApplyEffectDispositionV2::CreatedDureOwned,
            None,
        ) => PluginNativeOwnershipLedgerEventBodyV2::Claimed {
            ownership: PluginNativeOwnershipReceiptV2 {
                target,
                owner_plugin_id: receipt.plugin_id.clone(),
                owner_plugin_version: receipt.plugin_version.clone(),
                owner_integration_id: effect.step.integration_id.clone(),
                owner_operation_id: receipt.operation_id.clone(),
                owner_event_id: journal_event.event_id.clone(),
                owner_step_index: step_index,
                owner_attempt: attempt,
                after_digest: effect.after.digest.clone(),
                claimed_at_ms: journal_event.recorded_at_ms,
            },
        },
        (
            crate::PluginApplyOperationKindV2::Uninstall,
            crate::PluginApplyEffectDispositionV2::RemovedDureOwned
            | crate::PluginApplyEffectDispositionV2::NoChange,
            Some(ownership),
        ) => PluginNativeOwnershipLedgerEventBodyV2::Released {
            ownership: ownership.clone(),
            disposition,
        },
        (
            crate::PluginApplyOperationKindV2::Install,
            crate::PluginApplyEffectDispositionV2::PreservedDureOwned,
            Some(_),
        )
        | (
            crate::PluginApplyOperationKindV2::Install,
            crate::PluginApplyEffectDispositionV2::PreservedExternal,
            None,
        ) => return Ok(None),
        _ => {
            return Err(invalid_change(
                "effect disposition does not match current durable ownership",
            ));
        }
    };
    Ok(Some(PluginNativeOwnershipLedgerEventV2 {
        revision,
        journal_event_id: journal_event.event_id.clone(),
        operation_id: journal_event.operation_id.clone(),
        step_index,
        attempt,
        body,
        recorded_at_ms: journal_event.recorded_at_ms,
    }))
}

fn validate_journal_effect(
    journal_event: &crate::PluginApplyJournalEventV2,
    receipt: &crate::PluginApplyJournalReceiptV2,
    step_index: u32,
    attempt: u32,
    disposition: &crate::PluginApplyEffectDispositionV2,
) -> Result<(), PluginNativeOwnershipErrorV2> {
    if receipt.operation_id != journal_event.operation_id
        || receipt.last_sequence != journal_event.sequence
        || receipt.updated_at_ms != journal_event.recorded_at_ms
    {
        return Err(invalid_change(
            "journal event and folded receipt identities do not match",
        ));
    }
    let effect = receipt.effects.last().ok_or_else(|| {
        invalid_change("an ownership journal event did not produce an effect receipt")
    })?;
    if effect.step_index != step_index
        || effect.attempt != attempt
        || &effect.disposition != disposition
    {
        return Err(invalid_change(
            "journal event does not match the latest folded effect",
        ));
    }
    Ok(())
}

fn journal_effect(
    event: &crate::PluginApplyJournalEventV2,
) -> Option<(u32, u32, crate::PluginApplyEffectDispositionV2)> {
    match &event.body {
        crate::PluginApplyJournalEventBodyV2::EffectRecorded {
            step_index,
            attempt,
            disposition,
        }
        | crate::PluginApplyJournalEventBodyV2::StepReconciled {
            step_index,
            attempt,
            resolution: crate::PluginApplyStepReconciliationV2::Applied { disposition },
            ..
        } => Some((*step_index, *attempt, disposition.clone())),
        _ => None,
    }
}

fn invalid_ledger(reason: impl Into<String>) -> PluginNativeOwnershipErrorV2 {
    PluginNativeOwnershipErrorV2::InvalidLedger {
        reason: reason.into(),
    }
}

fn invalid_change(reason: impl Into<String>) -> PluginNativeOwnershipErrorV2 {
    PluginNativeOwnershipErrorV2::InvalidChange {
        reason: reason.into(),
    }
}

fn registration_target_matches(
    executable: &crate::AgentNativePluginExecutableV2,
    scope: &AgentInstallScopeV2,
    target: &AgentNativePluginRegistrationTargetV2,
) -> bool {
    matches!(
        (executable, scope, target),
        (
            crate::AgentNativePluginExecutableV2::Codex,
            AgentInstallScopeV2::Managed,
            AgentNativePluginRegistrationTargetV2::ManagedProfile { .. },
        ) | (
            crate::AgentNativePluginExecutableV2::Claude,
            AgentInstallScopeV2::User,
            AgentNativePluginRegistrationTargetV2::User { .. },
        ) | (
            crate::AgentNativePluginExecutableV2::Claude,
            AgentInstallScopeV2::Project | AgentInstallScopeV2::Local,
            AgentNativePluginRegistrationTargetV2::Workspace { .. },
        )
    )
}

fn push_field(identity: &mut String, value: &str) {
    identity.push_str(value);
    identity.push('\0');
}

fn push_scope(identity: &mut String, scope: &AgentInstallScopeV2) {
    let value = match scope {
        AgentInstallScopeV2::User => "user",
        AgentInstallScopeV2::Project => "project",
        AgentInstallScopeV2::Local => "local",
        AgentInstallScopeV2::Managed => "managed",
    };
    push_field(identity, value);
}

fn push_registration_target(identity: &mut String, target: &AgentNativePluginRegistrationTargetV2) {
    match target {
        AgentNativePluginRegistrationTargetV2::ManagedProfile { profile_root_key } => {
            push_field(identity, "managed_profile");
            push_field(identity, profile_root_key.as_str());
        }
        AgentNativePluginRegistrationTargetV2::User { profile_root_key } => {
            push_field(identity, "user");
            push_field(identity, profile_root_key.as_str());
        }
        AgentNativePluginRegistrationTargetV2::Workspace {
            profile_root_key,
            workspace_root_key,
        } => {
            push_field(identity, "workspace");
            push_field(identity, profile_root_key.as_str());
            push_field(identity, workspace_root_key.as_str());
        }
    }
}
