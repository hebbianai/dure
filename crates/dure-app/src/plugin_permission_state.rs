//! Durable, filesystem-independent plugin permission decisions and execution leases.
//!
//! Review decisions and enablement are intentionally separate. Every new decision disables the
//! plugin, and every state change advances an enablement epoch so an older enable or execution
//! lease cannot become valid again after a disable/enable cycle. This module validates journal
//! events but owns no filesystem, process, Tauri, or native-agent integration behavior.

use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{
    PermissionKindIdV2, PluginIdV2, PluginPermissionPlanDigestV2, PluginPermissionPlanV2,
    PluginPermissionReviewProjectionDigestV2, PluginPermissionReviewProjectionV2,
    PluginWorkspaceIdentityV2,
};

pub const PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2: u16 = 2;
pub const PLUGIN_PERMISSION_DECISION_CHECKPOINT_SCHEMA_VERSION_V2: u16 = 2;
/// Regular per-key journal capacity. One additional event is reserved exclusively for a new
/// explicit disable while the plugin is enabled.
pub const MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2: usize = 4_096;
pub const MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2: usize =
    MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 + 1;
const MAX_REQUEST_ID_BYTES: usize = 160;

/// A bounded idempotency key supplied by the host for one state transition request.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PluginPermissionDecisionRequestIdV2(String);

impl PluginPermissionDecisionRequestIdV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, PluginPermissionDecisionErrorV2> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_REQUEST_ID_BYTES
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(PluginPermissionDecisionErrorV2::InvalidRequestId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionRequestIdV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// Durable identity for one plugin inside one host-produced opaque workspace identity.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDecisionKeyV2 {
    schema_version: u16,
    workspace_identity: PluginWorkspaceIdentityV2,
    plugin_id: PluginIdV2,
}

impl PluginPermissionDecisionKeyV2 {
    pub fn new(workspace_identity: PluginWorkspaceIdentityV2, plugin_id: PluginIdV2) -> Self {
        Self {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            workspace_identity,
            plugin_id,
        }
    }

    pub fn from_plan(plan: &PluginPermissionPlanV2) -> Self {
        Self::new(
            plan.workspace_identity().clone(),
            plan.identity().plugin_id().clone(),
        )
    }

    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn workspace_identity(&self) -> &PluginWorkspaceIdentityV2 {
        &self.workspace_identity
    }

    pub fn plugin_id(&self) -> &PluginIdV2 {
        &self.plugin_id
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionKeyV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedKey {
            schema_version: u16,
            workspace_identity: PluginWorkspaceIdentityV2,
            plugin_id: PluginIdV2,
        }

        let persisted = PersistedKey::deserialize(deserializer)?;
        validate_schema_version(persisted.schema_version).map_err(serde::de::Error::custom)?;
        Ok(Self::new(persisted.workspace_identity, persisted.plugin_id))
    }
}

/// Exact review binding derived only from canonical plan getters.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDecisionBindingV2 {
    schema_version: u16,
    key: PluginPermissionDecisionKeyV2,
    plan_digest: PluginPermissionPlanDigestV2,
}

impl PluginPermissionDecisionBindingV2 {
    pub fn from_plan(plan: &PluginPermissionPlanV2) -> Self {
        Self {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key: PluginPermissionDecisionKeyV2::from_plan(plan),
            plan_digest: plan.digest().clone(),
        }
    }

    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.key
    }

    pub fn plan_digest(&self) -> &PluginPermissionPlanDigestV2 {
        &self.plan_digest
    }

    pub fn matches_plan(&self, plan: &PluginPermissionPlanV2) -> bool {
        self == &Self::from_plan(plan)
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionBindingV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedBinding {
            schema_version: u16,
            key: PluginPermissionDecisionKeyV2,
            plan_digest: PluginPermissionPlanDigestV2,
        }

        let persisted = PersistedBinding::deserialize(deserializer)?;
        validate_schema_version(persisted.schema_version).map_err(serde::de::Error::custom)?;
        Ok(Self {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key: persisted.key,
            plan_digest: persisted.plan_digest,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionDecisionV2 {
    Approve,
    Defer,
    Reject,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionEnablementV2 {
    Disabled,
    Enabled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginPermissionDecisionEventBodyV2 {
    /// Legacy digest-only decision retained for replay compatibility. New
    /// decision requests always emit `DecisionRecordedWithReview`.
    DecisionRecorded {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
    },
    DecisionRecordedWithReview {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
        review_projection: PluginPermissionReviewProjectionV2,
    },
    Enabled {
        binding: PluginPermissionDecisionBindingV2,
    },
    Disabled,
}

/// Strict persisted event. Revisions serialize as decimal strings so accidental wire reuse never
/// truncates a `u64` through JavaScript number semantics.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDecisionEventV2 {
    schema_version: u16,
    key: PluginPermissionDecisionKeyV2,
    request_id: PluginPermissionDecisionRequestIdV2,
    #[serde(with = "decimal_u64")]
    expected_record_revision: u64,
    #[serde(with = "decimal_u64")]
    record_revision: u64,
    #[serde(with = "decimal_u64")]
    decision_revision: u64,
    #[serde(with = "decimal_u64")]
    enablement_epoch: u64,
    body: PluginPermissionDecisionEventBodyV2,
}

impl PluginPermissionDecisionEventV2 {
    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.key
    }

    pub fn request_id(&self) -> &PluginPermissionDecisionRequestIdV2 {
        &self.request_id
    }

    pub fn expected_record_revision(&self) -> u64 {
        self.expected_record_revision
    }

    pub fn record_revision(&self) -> u64 {
        self.record_revision
    }

    pub fn decision_revision(&self) -> u64 {
        self.decision_revision
    }

    pub fn enablement_epoch(&self) -> u64 {
        self.enablement_epoch
    }

    pub fn body(&self) -> &PluginPermissionDecisionEventBodyV2 {
        &self.body
    }

    fn validate_local(&self) -> Result<(), PluginPermissionDecisionErrorV2> {
        validate_schema_version(self.schema_version)?;
        let expected_record_revision = self.expected_record_revision.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "record_revision",
            },
        )?;
        if self.record_revision != expected_record_revision {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "record_revision",
                expected: expected_record_revision,
                actual: self.record_revision,
            });
        }
        if self.enablement_epoch == 0 {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "enablement_epoch",
                expected: 1,
                actual: 0,
            });
        }
        match &self.body {
            PluginPermissionDecisionEventBodyV2::DecisionRecorded { binding, .. }
            | PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview { binding, .. }
            | PluginPermissionDecisionEventBodyV2::Enabled { binding } => {
                if binding.key() != &self.key {
                    return Err(PluginPermissionDecisionErrorV2::BindingKeyMismatch);
                }
            }
            PluginPermissionDecisionEventBodyV2::Disabled => {}
        }
        if let PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
            binding,
            review_projection,
            ..
        } = &self.body
        {
            if review_projection.plan_digest() != binding.plan_digest() {
                return Err(PluginPermissionDecisionErrorV2::ReviewProjectionPlanDigestMismatch);
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionEventV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedEvent {
            schema_version: u16,
            key: PluginPermissionDecisionKeyV2,
            request_id: PluginPermissionDecisionRequestIdV2,
            #[serde(with = "decimal_u64")]
            expected_record_revision: u64,
            #[serde(with = "decimal_u64")]
            record_revision: u64,
            #[serde(with = "decimal_u64")]
            decision_revision: u64,
            #[serde(with = "decimal_u64")]
            enablement_epoch: u64,
            body: PluginPermissionDecisionEventBodyV2,
        }

        let persisted = PersistedEvent::deserialize(deserializer)?;
        let event = Self {
            schema_version: persisted.schema_version,
            key: persisted.key,
            request_id: persisted.request_id,
            expected_record_revision: persisted.expected_record_revision,
            record_revision: persisted.record_revision,
            decision_revision: persisted.decision_revision,
            enablement_epoch: persisted.enablement_epoch,
            body: persisted.body,
        };
        event.validate_local().map_err(serde::de::Error::custom)?;
        Ok(event)
    }
}

/// Content-addressed request metadata retained by a compacted permission checkpoint.
///
/// A reviewed decision keeps its validated plan and review-projection digests instead of a second
/// copy of the potentially large historical projection. Exact request replay supplies that
/// projection again and is accepted only when both digests match. Legacy digest-only decisions
/// remain distinguishable so their historical event can be reconstructed exactly. SHA-256
/// collision resistance is therefore part of this content-identity contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginPermissionDecisionReplayBodyV2 {
    DecisionRecorded {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
    },
    DecisionRecordedWithReview {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
        review_projection_digest: PluginPermissionReviewProjectionDigestV2,
    },
    Enabled {
        binding: PluginPermissionDecisionBindingV2,
    },
    Disabled,
}

impl PluginPermissionDecisionReplayBodyV2 {
    fn from_event_body(body: &PluginPermissionDecisionEventBodyV2) -> Self {
        match body {
            PluginPermissionDecisionEventBodyV2::DecisionRecorded { binding, decision } => {
                Self::DecisionRecorded {
                    binding: binding.clone(),
                    decision: *decision,
                }
            }
            PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                binding,
                decision,
                review_projection,
            } => Self::DecisionRecordedWithReview {
                binding: binding.clone(),
                decision: *decision,
                review_projection_digest: review_projection.digest().clone(),
            },
            PluginPermissionDecisionEventBodyV2::Enabled { binding } => Self::Enabled {
                binding: binding.clone(),
            },
            PluginPermissionDecisionEventBodyV2::Disabled => Self::Disabled,
        }
    }

    fn binding(&self) -> Option<&PluginPermissionDecisionBindingV2> {
        match self {
            Self::DecisionRecorded { binding, .. }
            | Self::DecisionRecordedWithReview { binding, .. }
            | Self::Enabled { binding } => Some(binding),
            Self::Disabled => None,
        }
    }

    fn matches_event_body(&self, body: &PluginPermissionDecisionEventBodyV2) -> bool {
        match (self, body) {
            (
                Self::DecisionRecorded {
                    binding: previous_binding,
                    decision: previous_decision,
                },
                PluginPermissionDecisionEventBodyV2::DecisionRecorded { binding, decision },
            ) => previous_binding == binding && previous_decision == decision,
            (
                Self::DecisionRecordedWithReview {
                    binding: previous_binding,
                    decision: previous_decision,
                    review_projection_digest,
                },
                PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                    binding,
                    decision,
                    review_projection,
                },
            ) => {
                previous_binding == binding
                    && previous_decision == decision
                    && review_projection_digest == review_projection.digest()
            }
            (
                Self::Enabled {
                    binding: previous_binding,
                },
                PluginPermissionDecisionEventBodyV2::Enabled { binding },
            ) => previous_binding == binding,
            (Self::Disabled, PluginPermissionDecisionEventBodyV2::Disabled) => true,
            _ => false,
        }
    }

    fn matches_request_body(&self, body: &PluginPermissionDecisionEventBodyV2) -> bool {
        if self.matches_event_body(body) {
            return true;
        }
        matches!(
            (self, body),
            (
                Self::DecisionRecorded {
                    binding: previous_binding,
                    decision: previous_decision,
                },
                PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                    binding,
                    decision,
                    ..
                },
            ) if previous_binding == binding && previous_decision == decision
        )
    }

    fn reconstruct_event_body(
        &self,
        requested_body: &PluginPermissionDecisionEventBodyV2,
    ) -> PluginPermissionDecisionEventBodyV2 {
        match self {
            Self::DecisionRecorded { binding, decision } => {
                PluginPermissionDecisionEventBodyV2::DecisionRecorded {
                    binding: binding.clone(),
                    decision: *decision,
                }
            }
            Self::DecisionRecordedWithReview {
                binding, decision, ..
            } => {
                let PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                    review_projection,
                    ..
                } = requested_body
                else {
                    unreachable!("reviewed replay bodies are checked before reconstruction")
                };
                PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                    binding: binding.clone(),
                    decision: *decision,
                    review_projection: review_projection.clone(),
                }
            }
            Self::Enabled { binding } => PluginPermissionDecisionEventBodyV2::Enabled {
                binding: binding.clone(),
            },
            Self::Disabled => PluginPermissionDecisionEventBodyV2::Disabled,
        }
    }
}

/// One locally strict replay token. Key, ordering, transition, and counter coherence are validated
/// only in the context of a `PluginPermissionDecisionFoldCheckpointV2`; standalone deserialization
/// is not authority validation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDecisionReplayReceiptV2 {
    schema_version: u16,
    request_id: PluginPermissionDecisionRequestIdV2,
    #[serde(with = "decimal_u64")]
    expected_record_revision: u64,
    #[serde(with = "decimal_u64")]
    record_revision: u64,
    #[serde(with = "decimal_u64")]
    decision_revision: u64,
    #[serde(with = "decimal_u64")]
    enablement_epoch: u64,
    explicit_enabled_to_disabled: bool,
    body: PluginPermissionDecisionReplayBodyV2,
}

impl PluginPermissionDecisionReplayReceiptV2 {
    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn request_id(&self) -> &PluginPermissionDecisionRequestIdV2 {
        &self.request_id
    }

    pub fn expected_record_revision(&self) -> u64 {
        self.expected_record_revision
    }

    pub fn record_revision(&self) -> u64 {
        self.record_revision
    }

    pub fn decision_revision(&self) -> u64 {
        self.decision_revision
    }

    pub fn enablement_epoch(&self) -> u64 {
        self.enablement_epoch
    }

    /// True only when replaying the preceding receipts proves this was a transition from enabled
    /// to an explicit disabled event. The outer store decides whether that eligible transition
    /// actually occupied global or per-key emergency capacity.
    pub fn explicit_enabled_to_disabled(&self) -> bool {
        self.explicit_enabled_to_disabled
    }

    pub fn body(&self) -> &PluginPermissionDecisionReplayBodyV2 {
        &self.body
    }

    fn from_event(
        event: &PluginPermissionDecisionEventV2,
        explicit_enabled_to_disabled: bool,
    ) -> Self {
        Self {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            request_id: event.request_id.clone(),
            expected_record_revision: event.expected_record_revision,
            record_revision: event.record_revision,
            decision_revision: event.decision_revision,
            enablement_epoch: event.enablement_epoch,
            explicit_enabled_to_disabled,
            body: PluginPermissionDecisionReplayBodyV2::from_event_body(&event.body),
        }
    }

    fn validate_local(&self) -> Result<(), PluginPermissionDecisionErrorV2> {
        validate_schema_version(self.schema_version)?;
        let expected_record_revision = self.expected_record_revision.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "record_revision",
            },
        )?;
        if self.record_revision != expected_record_revision {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "record_revision",
                expected: expected_record_revision,
                actual: self.record_revision,
            });
        }
        if self.enablement_epoch == 0 {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "enablement_epoch",
                expected: 1,
                actual: 0,
            });
        }
        Ok(())
    }

    fn matches_event(&self, event: &PluginPermissionDecisionEventV2) -> bool {
        self.request_id == event.request_id
            && self.expected_record_revision == event.expected_record_revision
            && self.record_revision == event.record_revision
            && self.decision_revision == event.decision_revision
            && self.enablement_epoch == event.enablement_epoch
            && self.body.matches_event_body(&event.body)
    }

    fn reconstruct_event(
        &self,
        key: PluginPermissionDecisionKeyV2,
        requested_body: &PluginPermissionDecisionEventBodyV2,
    ) -> PluginPermissionDecisionEventV2 {
        PluginPermissionDecisionEventV2 {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key,
            request_id: self.request_id.clone(),
            expected_record_revision: self.expected_record_revision,
            record_revision: self.record_revision,
            decision_revision: self.decision_revision,
            enablement_epoch: self.enablement_epoch,
            body: self.body.reconstruct_event_body(requested_body),
        }
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionReplayReceiptV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedReceipt {
            schema_version: u16,
            request_id: PluginPermissionDecisionRequestIdV2,
            #[serde(with = "decimal_u64")]
            expected_record_revision: u64,
            #[serde(with = "decimal_u64")]
            record_revision: u64,
            #[serde(with = "decimal_u64")]
            decision_revision: u64,
            #[serde(with = "decimal_u64")]
            enablement_epoch: u64,
            explicit_enabled_to_disabled: bool,
            body: PluginPermissionDecisionReplayBodyV2,
        }

        let persisted = PersistedReceipt::deserialize(deserializer)?;
        let receipt = Self {
            schema_version: persisted.schema_version,
            request_id: persisted.request_id,
            expected_record_revision: persisted.expected_record_revision,
            record_revision: persisted.record_revision,
            decision_revision: persisted.decision_revision,
            enablement_epoch: persisted.enablement_epoch,
            explicit_enabled_to_disabled: persisted.explicit_enabled_to_disabled,
            body: persisted.body,
        };
        receipt.validate_local().map_err(serde::de::Error::custom)?;
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RecordedPluginPermissionDecisionV2 {
    binding: PluginPermissionDecisionBindingV2,
    decision: PluginPermissionDecisionV2,
    review_projection: Option<PluginPermissionReviewProjectionV2>,
}

/// Derived current state. It is intentionally non-Serde so only a validated event fold creates it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPermissionDecisionStateV2 {
    key: PluginPermissionDecisionKeyV2,
    record_revision: u64,
    decision_revision: u64,
    enablement_epoch: u64,
    decision: Option<RecordedPluginPermissionDecisionV2>,
    enablement: PluginPermissionEnablementV2,
}

impl PluginPermissionDecisionStateV2 {
    pub fn initial(key: PluginPermissionDecisionKeyV2) -> Self {
        Self {
            key,
            record_revision: 0,
            decision_revision: 0,
            enablement_epoch: 0,
            decision: None,
            enablement: PluginPermissionEnablementV2::Disabled,
        }
    }

    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.key
    }

    pub fn record_revision(&self) -> u64 {
        self.record_revision
    }

    pub fn decision_revision(&self) -> u64 {
        self.decision_revision
    }

    pub fn enablement_epoch(&self) -> u64 {
        self.enablement_epoch
    }

    pub fn decision(&self) -> Option<PluginPermissionDecisionV2> {
        self.decision.as_ref().map(|recorded| recorded.decision)
    }

    pub fn decision_binding(&self) -> Option<&PluginPermissionDecisionBindingV2> {
        self.decision.as_ref().map(|recorded| &recorded.binding)
    }

    pub fn reviewed_projection(&self) -> Option<&PluginPermissionReviewProjectionV2> {
        self.decision
            .as_ref()
            .and_then(|recorded| recorded.review_projection.as_ref())
    }

    pub fn enablement(&self) -> PluginPermissionEnablementV2 {
        self.enablement
    }

    fn transition(
        &self,
        event: &PluginPermissionDecisionEventV2,
    ) -> Result<Self, PluginPermissionDecisionErrorV2> {
        event.validate_local()?;
        if event.key != self.key {
            return Err(PluginPermissionDecisionErrorV2::KeyMismatch);
        }
        if event.expected_record_revision != self.record_revision {
            return Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
                expected: event.expected_record_revision,
                actual: self.record_revision,
            });
        }

        let next_record_revision = self.record_revision.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "record_revision",
            },
        )?;
        if event.record_revision != next_record_revision {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "record_revision",
                expected: next_record_revision,
                actual: event.record_revision,
            });
        }
        let next_enablement_epoch = self.enablement_epoch.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "enablement_epoch",
            },
        )?;
        if event.enablement_epoch != next_enablement_epoch {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "enablement_epoch",
                expected: next_enablement_epoch,
                actual: event.enablement_epoch,
            });
        }

        let mut next = self.clone();
        next.record_revision = next_record_revision;
        next.enablement_epoch = next_enablement_epoch;
        match &event.body {
            body @ (PluginPermissionDecisionEventBodyV2::DecisionRecorded { .. }
            | PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview { .. }) => {
                let (binding, decision, review_projection) = match body {
                    PluginPermissionDecisionEventBodyV2::DecisionRecorded { binding, decision } => {
                        (binding, decision, None)
                    }
                    PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                        binding,
                        decision,
                        review_projection,
                    } => (binding, decision, Some(review_projection.clone())),
                    _ => unreachable!("decision body was matched above"),
                };
                let next_decision_revision = self.decision_revision.checked_add(1).ok_or(
                    PluginPermissionDecisionErrorV2::RevisionOverflow {
                        field: "decision_revision",
                    },
                )?;
                if event.decision_revision != next_decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: next_decision_revision,
                        actual: event.decision_revision,
                    });
                }
                next.decision_revision = next_decision_revision;
                next.decision = Some(RecordedPluginPermissionDecisionV2 {
                    binding: binding.clone(),
                    decision: *decision,
                    review_projection,
                });
                next.enablement = PluginPermissionEnablementV2::Disabled;
            }
            PluginPermissionDecisionEventBodyV2::Enabled { binding } => {
                if event.decision_revision != self.decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: self.decision_revision,
                        actual: event.decision_revision,
                    });
                }
                let Some(recorded) = &self.decision else {
                    return Err(PluginPermissionDecisionErrorV2::DecisionNotApproved);
                };
                if recorded.decision != PluginPermissionDecisionV2::Approve {
                    return Err(PluginPermissionDecisionErrorV2::DecisionNotApproved);
                }
                if &recorded.binding != binding {
                    return Err(PluginPermissionDecisionErrorV2::ApprovedBindingMismatch);
                }
                next.enablement = PluginPermissionEnablementV2::Enabled;
            }
            PluginPermissionDecisionEventBodyV2::Disabled => {
                if event.decision_revision != self.decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: self.decision_revision,
                        actual: event.decision_revision,
                    });
                }
                next.enablement = PluginPermissionEnablementV2::Disabled;
            }
        }
        Ok(next)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PluginPermissionDecisionCheckpointCurrentDecisionV2 {
    None,
    Legacy {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
    },
    Reviewed {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
        review_projection: PluginPermissionReviewProjectionV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginPermissionDecisionCheckpointStateV2 {
    key: PluginPermissionDecisionKeyV2,
    #[serde(with = "decimal_u64")]
    record_revision: u64,
    #[serde(with = "decimal_u64")]
    decision_revision: u64,
    #[serde(with = "decimal_u64")]
    enablement_epoch: u64,
    decision: PluginPermissionDecisionCheckpointCurrentDecisionV2,
    enablement: PluginPermissionEnablementV2,
}

/// Strict, backend-only fold checkpoint used as the semantic payload of journal compaction.
///
/// This DTO intentionally is not a TypeScript contract. Its fields remain private so adapters use
/// the same semantic restore validation instead of setters. Validation does not authenticate
/// checkpoint bytes: adapters must accept them only from the same owner-protected, generation-
/// bound authority as the original journal.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissionDecisionFoldCheckpointV2 {
    schema_version: u16,
    state: PluginPermissionDecisionCheckpointStateV2,
    #[serde(with = "decimal_u64")]
    observed_event_count: u64,
    replay_receipts: Vec<PluginPermissionDecisionReplayReceiptV2>,
}

impl PluginPermissionDecisionFoldCheckpointV2 {
    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.state.key
    }

    pub fn record_revision(&self) -> u64 {
        self.state.record_revision
    }

    pub fn decision_revision(&self) -> u64 {
        self.state.decision_revision
    }

    pub fn enablement_epoch(&self) -> u64 {
        self.state.enablement_epoch
    }

    pub fn decision(&self) -> Option<PluginPermissionDecisionV2> {
        match &self.state.decision {
            PluginPermissionDecisionCheckpointCurrentDecisionV2::None => None,
            PluginPermissionDecisionCheckpointCurrentDecisionV2::Legacy { decision, .. }
            | PluginPermissionDecisionCheckpointCurrentDecisionV2::Reviewed { decision, .. } => {
                Some(*decision)
            }
        }
    }

    pub fn decision_binding(&self) -> Option<&PluginPermissionDecisionBindingV2> {
        match &self.state.decision {
            PluginPermissionDecisionCheckpointCurrentDecisionV2::None => None,
            PluginPermissionDecisionCheckpointCurrentDecisionV2::Legacy { binding, .. }
            | PluginPermissionDecisionCheckpointCurrentDecisionV2::Reviewed { binding, .. } => {
                Some(binding)
            }
        }
    }

    pub fn reviewed_projection(&self) -> Option<&PluginPermissionReviewProjectionV2> {
        match &self.state.decision {
            PluginPermissionDecisionCheckpointCurrentDecisionV2::Reviewed {
                review_projection,
                ..
            } => Some(review_projection),
            PluginPermissionDecisionCheckpointCurrentDecisionV2::None
            | PluginPermissionDecisionCheckpointCurrentDecisionV2::Legacy { .. } => None,
        }
    }

    pub fn enablement(&self) -> PluginPermissionEnablementV2 {
        self.state.enablement
    }

    pub fn observed_event_count(&self) -> usize {
        usize::try_from(self.observed_event_count)
            .expect("validated checkpoint observation count always fits usize")
    }

    /// Receipts are serialized in original record-revision order.
    pub fn replay_receipts(&self) -> &[PluginPermissionDecisionReplayReceiptV2] {
        &self.replay_receipts
    }

    pub fn explicit_enabled_to_disabled_event_count(&self) -> usize {
        self.replay_receipts
            .iter()
            .filter(|receipt| receipt.explicit_enabled_to_disabled())
            .count()
    }

    fn from_fold(
        fold: &PluginPermissionDecisionFoldV2,
    ) -> Result<Self, PluginPermissionDecisionErrorV2> {
        if fold.observed_events != fold.receipts_by_request.len() {
            return Err(
                PluginPermissionDecisionErrorV2::InvalidCheckpointObservedEventCount {
                    observed: fold.observed_events as u64,
                    recorded: fold.receipts_by_request.len(),
                },
            );
        }
        let decision = match &fold.state.decision {
            None => PluginPermissionDecisionCheckpointCurrentDecisionV2::None,
            Some(recorded) => match &recorded.review_projection {
                None => PluginPermissionDecisionCheckpointCurrentDecisionV2::Legacy {
                    binding: recorded.binding.clone(),
                    decision: recorded.decision,
                },
                Some(review_projection) => {
                    PluginPermissionDecisionCheckpointCurrentDecisionV2::Reviewed {
                        binding: recorded.binding.clone(),
                        decision: recorded.decision,
                        review_projection: review_projection.clone(),
                    }
                }
            },
        };
        let mut replay_receipts = fold
            .receipts_by_request
            .values()
            .cloned()
            .collect::<Vec<_>>();
        replay_receipts.sort_by_key(|receipt| receipt.record_revision);
        Ok(Self {
            schema_version: PLUGIN_PERMISSION_DECISION_CHECKPOINT_SCHEMA_VERSION_V2,
            state: PluginPermissionDecisionCheckpointStateV2 {
                key: fold.state.key.clone(),
                record_revision: fold.state.record_revision,
                decision_revision: fold.state.decision_revision,
                enablement_epoch: fold.state.enablement_epoch,
                decision,
                enablement: fold.state.enablement,
            },
            observed_event_count: fold.observed_events as u64,
            replay_receipts,
        })
    }

    fn validate(&self) -> Result<(), PluginPermissionDecisionErrorV2> {
        restore_plugin_permission_decision_checkpoint(self).map(|_| ())
    }
}

impl<'de> Deserialize<'de> for PluginPermissionDecisionFoldCheckpointV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedCheckpoint {
            schema_version: u16,
            state: PluginPermissionDecisionCheckpointStateV2,
            #[serde(with = "decimal_u64")]
            observed_event_count: u64,
            #[serde(deserialize_with = "bounded_replay_receipts::deserialize")]
            replay_receipts: Vec<PluginPermissionDecisionReplayReceiptV2>,
        }

        let persisted = PersistedCheckpoint::deserialize(deserializer)?;
        let checkpoint = Self {
            schema_version: persisted.schema_version,
            state: persisted.state,
            observed_event_count: persisted.observed_event_count,
            replay_receipts: persisted.replay_receipts,
        };
        checkpoint.validate().map_err(serde::de::Error::custom)?;
        Ok(checkpoint)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginPermissionDecisionEventDispositionV2 {
    Applied,
    ExactReplay,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPermissionDecisionEventApplicationV2 {
    /// Current fold state, not the historical state immediately after a replayed event.
    state: PluginPermissionDecisionStateV2,
    disposition: PluginPermissionDecisionEventDispositionV2,
}

impl PluginPermissionDecisionEventApplicationV2 {
    pub fn state(&self) -> &PluginPermissionDecisionStateV2 {
        &self.state
    }

    pub fn disposition(&self) -> PluginPermissionDecisionEventDispositionV2 {
        self.disposition
    }
}

/// Stateful replay accumulator retaining bounded request receipts across event tails and
/// compaction checkpoints.
pub struct PluginPermissionDecisionFoldV2 {
    state: PluginPermissionDecisionStateV2,
    receipts_by_request:
        BTreeMap<PluginPermissionDecisionRequestIdV2, PluginPermissionDecisionReplayReceiptV2>,
    observed_events: usize,
}

impl PluginPermissionDecisionFoldV2 {
    pub fn new(key: PluginPermissionDecisionKeyV2) -> Self {
        Self {
            state: PluginPermissionDecisionStateV2::initial(key),
            receipts_by_request: BTreeMap::new(),
            observed_events: 0,
        }
    }

    pub fn from_events(
        key: PluginPermissionDecisionKeyV2,
        events: &[PluginPermissionDecisionEventV2],
    ) -> Result<Self, PluginPermissionDecisionErrorV2> {
        if events.len() > MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2 {
            return Err(PluginPermissionDecisionErrorV2::EventLimitExceeded);
        }
        let mut fold = Self::new(key);
        for event in events {
            apply_plugin_permission_decision_event(&mut fold, event)?;
        }
        Ok(fold)
    }

    pub fn state(&self) -> &PluginPermissionDecisionStateV2 {
        &self.state
    }

    /// Includes exact persisted-event observations as well as newly applied logical events.
    pub fn observed_event_count(&self) -> usize {
        self.observed_events
    }

    pub fn prior_request_count(&self) -> usize {
        self.receipts_by_request.len()
    }

    /// Returns metadata in stable request-ID order. The checkpoint wire reorders it by original
    /// record revision so restore can prove that revisions are contiguous.
    pub fn prior_request_metadata(
        &self,
    ) -> impl ExactSizeIterator<Item = &PluginPermissionDecisionReplayReceiptV2> {
        self.receipts_by_request.values()
    }

    pub fn prior_request_metadata_for(
        &self,
        request_id: &PluginPermissionDecisionRequestIdV2,
    ) -> Option<&PluginPermissionDecisionReplayReceiptV2> {
        self.receipts_by_request.get(request_id)
    }

    /// Creates a checkpoint only from a canonical durable fold. Exact event observations are
    /// useful for duplicate detection but are not durable records and therefore cannot be
    /// compacted without their original order. Store journals already reject such duplicates.
    pub fn checkpoint(
        &self,
    ) -> Result<PluginPermissionDecisionFoldCheckpointV2, PluginPermissionDecisionErrorV2> {
        PluginPermissionDecisionFoldCheckpointV2::from_fold(self)
    }

    pub fn from_checkpoint(
        checkpoint: &PluginPermissionDecisionFoldCheckpointV2,
    ) -> Result<Self, PluginPermissionDecisionErrorV2> {
        restore_plugin_permission_decision_checkpoint(checkpoint)
    }

    pub fn into_state(self) -> PluginPermissionDecisionStateV2 {
        self.state
    }
}

pub fn apply_plugin_permission_decision_event(
    fold: &mut PluginPermissionDecisionFoldV2,
    event: &PluginPermissionDecisionEventV2,
) -> Result<PluginPermissionDecisionEventApplicationV2, PluginPermissionDecisionErrorV2> {
    event.validate_local()?;
    if event.key() != fold.state.key() {
        return Err(PluginPermissionDecisionErrorV2::KeyMismatch);
    }
    if let Some(previous) = fold.receipts_by_request.get(event.request_id()) {
        if !previous.matches_event(event) {
            return Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict {
                request_id: event.request_id().clone(),
            });
        }
        fold.observed_events = next_observed_event_count(fold.observed_events, false)?;
        return Ok(PluginPermissionDecisionEventApplicationV2 {
            state: fold.state.clone(),
            disposition: PluginPermissionDecisionEventDispositionV2::ExactReplay,
        });
    }

    let uses_emergency_disable_reserve = fold.state.enablement()
        == PluginPermissionEnablementV2::Enabled
        && matches!(event.body(), PluginPermissionDecisionEventBodyV2::Disabled);
    let next_state = fold.state.transition(event)?;
    let observed_events =
        next_observed_event_count(fold.observed_events, uses_emergency_disable_reserve)?;
    fold.receipts_by_request.insert(
        event.request_id().clone(),
        PluginPermissionDecisionReplayReceiptV2::from_event(event, uses_emergency_disable_reserve),
    );
    fold.state = next_state.clone();
    fold.observed_events = observed_events;
    Ok(PluginPermissionDecisionEventApplicationV2 {
        state: next_state,
        disposition: PluginPermissionDecisionEventDispositionV2::Applied,
    })
}

pub fn fold_plugin_permission_decision_events(
    key: PluginPermissionDecisionKeyV2,
    events: &[PluginPermissionDecisionEventV2],
) -> Result<PluginPermissionDecisionStateV2, PluginPermissionDecisionErrorV2> {
    Ok(PluginPermissionDecisionFoldV2::from_events(key, events)?.into_state())
}

enum PluginPermissionDecisionRequestActionV2 {
    Decide {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
        review_projection: PluginPermissionReviewProjectionV2,
    },
    Enable {
        binding: PluginPermissionDecisionBindingV2,
    },
    Disable,
}

impl PluginPermissionDecisionRequestActionV2 {
    fn body(&self) -> PluginPermissionDecisionEventBodyV2 {
        match self {
            Self::Decide {
                binding,
                decision,
                review_projection,
            } => PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
                binding: binding.clone(),
                decision: *decision,
                review_projection: review_projection.clone(),
            },
            Self::Enable { binding } => PluginPermissionDecisionEventBodyV2::Enabled {
                binding: binding.clone(),
            },
            Self::Disable => PluginPermissionDecisionEventBodyV2::Disabled,
        }
    }
}

/// Non-wire request used to create or idempotently replay one durable event.
pub struct PluginPermissionDecisionRequestV2 {
    key: PluginPermissionDecisionKeyV2,
    request_id: PluginPermissionDecisionRequestIdV2,
    expected_record_revision: u64,
    action: PluginPermissionDecisionRequestActionV2,
}

impl PluginPermissionDecisionRequestV2 {
    pub fn decide(
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        plan: &PluginPermissionPlanV2,
        decision: PluginPermissionDecisionV2,
    ) -> Self {
        let binding = PluginPermissionDecisionBindingV2::from_plan(plan);
        Self {
            key: binding.key().clone(),
            request_id,
            expected_record_revision,
            action: PluginPermissionDecisionRequestActionV2::Decide {
                binding,
                decision,
                review_projection: plan.review_projection().clone(),
            },
        }
    }

    pub fn enable(
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        current_plan: &PluginPermissionPlanV2,
    ) -> Self {
        let binding = PluginPermissionDecisionBindingV2::from_plan(current_plan);
        Self {
            key: binding.key().clone(),
            request_id,
            expected_record_revision,
            action: PluginPermissionDecisionRequestActionV2::Enable { binding },
        }
    }

    pub fn disable(
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        key: PluginPermissionDecisionKeyV2,
    ) -> Self {
        Self {
            key,
            request_id,
            expected_record_revision,
            action: PluginPermissionDecisionRequestActionV2::Disable,
        }
    }

    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.key
    }

    pub fn request_id(&self) -> &PluginPermissionDecisionRequestIdV2 {
        &self.request_id
    }

    pub fn expected_record_revision(&self) -> u64 {
        self.expected_record_revision
    }
}

pub struct PluginPermissionDecisionRequestApplicationV2 {
    event: PluginPermissionDecisionEventV2,
    /// Current fold state. An exact replay after later transitions does not reconstruct the old
    /// response state, so callers must not infer the requested enablement from the disposition.
    state: PluginPermissionDecisionStateV2,
    disposition: PluginPermissionDecisionEventDispositionV2,
}

impl PluginPermissionDecisionRequestApplicationV2 {
    pub fn event(&self) -> &PluginPermissionDecisionEventV2 {
        &self.event
    }

    pub fn event_to_append(&self) -> Option<&PluginPermissionDecisionEventV2> {
        (self.disposition == PluginPermissionDecisionEventDispositionV2::Applied)
            .then_some(&self.event)
    }

    pub fn state(&self) -> &PluginPermissionDecisionStateV2 {
        &self.state
    }

    pub fn disposition(&self) -> PluginPermissionDecisionEventDispositionV2 {
        self.disposition
    }

    pub fn into_event(self) -> PluginPermissionDecisionEventV2 {
        self.event
    }
}

pub fn apply_plugin_permission_decision_request(
    fold: &mut PluginPermissionDecisionFoldV2,
    request: PluginPermissionDecisionRequestV2,
) -> Result<PluginPermissionDecisionRequestApplicationV2, PluginPermissionDecisionErrorV2> {
    if request.key != *fold.state.key() {
        return Err(PluginPermissionDecisionErrorV2::KeyMismatch);
    }
    let requested_body = request.action.body();
    if let Some(previous) = fold.receipts_by_request.get(&request.request_id) {
        if previous.expected_record_revision() != request.expected_record_revision
            || !previous.body.matches_request_body(&requested_body)
        {
            return Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict {
                request_id: request.request_id,
            });
        }
        let event = previous.reconstruct_event(request.key, &requested_body);
        return Ok(PluginPermissionDecisionRequestApplicationV2 {
            event,
            state: fold.state.clone(),
            disposition: PluginPermissionDecisionEventDispositionV2::ExactReplay,
        });
    }
    if request.expected_record_revision != fold.state.record_revision() {
        return Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
            expected: request.expected_record_revision,
            actual: fold.state.record_revision(),
        });
    }

    let record_revision = fold.state.record_revision().checked_add(1).ok_or(
        PluginPermissionDecisionErrorV2::RevisionOverflow {
            field: "record_revision",
        },
    )?;
    let decision_revision = match requested_body {
        PluginPermissionDecisionEventBodyV2::DecisionRecorded { .. }
        | PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview { .. } => {
            fold.state.decision_revision().checked_add(1).ok_or(
                PluginPermissionDecisionErrorV2::RevisionOverflow {
                    field: "decision_revision",
                },
            )?
        }
        _ => fold.state.decision_revision(),
    };
    let enablement_epoch = fold.state.enablement_epoch().checked_add(1).ok_or(
        PluginPermissionDecisionErrorV2::RevisionOverflow {
            field: "enablement_epoch",
        },
    )?;
    let event = PluginPermissionDecisionEventV2 {
        schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
        key: request.key,
        request_id: request.request_id,
        expected_record_revision: request.expected_record_revision,
        record_revision,
        decision_revision,
        enablement_epoch,
        body: requested_body,
    };
    let application = apply_plugin_permission_decision_event(fold, &event)?;
    Ok(PluginPermissionDecisionRequestApplicationV2 {
        event,
        state: application.state,
        disposition: application.disposition,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RestoredPluginPermissionDecisionIdentityV2 {
    Legacy {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
    },
    Reviewed {
        binding: PluginPermissionDecisionBindingV2,
        decision: PluginPermissionDecisionV2,
        review_projection_digest: PluginPermissionReviewProjectionDigestV2,
    },
}

fn restore_plugin_permission_decision_checkpoint(
    checkpoint: &PluginPermissionDecisionFoldCheckpointV2,
) -> Result<PluginPermissionDecisionFoldV2, PluginPermissionDecisionErrorV2> {
    validate_checkpoint_schema_version(checkpoint.schema_version)?;
    if checkpoint.replay_receipts.len()
        > MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    {
        return Err(PluginPermissionDecisionErrorV2::EventLimitExceeded);
    }

    let observed_events = usize::try_from(checkpoint.observed_event_count).map_err(|_| {
        PluginPermissionDecisionErrorV2::InvalidCheckpointObservedEventCount {
            observed: checkpoint.observed_event_count,
            recorded: checkpoint.replay_receipts.len(),
        }
    })?;
    if observed_events != checkpoint.replay_receipts.len()
        || observed_events > MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    {
        return Err(
            PluginPermissionDecisionErrorV2::InvalidCheckpointObservedEventCount {
                observed: checkpoint.observed_event_count,
                recorded: checkpoint.replay_receipts.len(),
            },
        );
    }

    let key = checkpoint.state.key.clone();
    let mut record_revision = 0_u64;
    let mut decision_revision = 0_u64;
    let mut enablement_epoch = 0_u64;
    let mut decision: Option<RestoredPluginPermissionDecisionIdentityV2> = None;
    let mut enablement = PluginPermissionEnablementV2::Disabled;
    let mut receipts_by_request = BTreeMap::new();
    let mut last_event_used_disable_reserve = false;

    for receipt in &checkpoint.replay_receipts {
        receipt.validate_local()?;
        if receipts_by_request.contains_key(receipt.request_id()) {
            return Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict {
                request_id: receipt.request_id().clone(),
            });
        }
        if receipt.expected_record_revision != record_revision {
            return Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
                expected: receipt.expected_record_revision,
                actual: record_revision,
            });
        }
        let next_record_revision = record_revision.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "record_revision",
            },
        )?;
        if receipt.record_revision != next_record_revision {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "record_revision",
                expected: next_record_revision,
                actual: receipt.record_revision,
            });
        }
        let next_enablement_epoch = enablement_epoch.checked_add(1).ok_or(
            PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "enablement_epoch",
            },
        )?;
        if receipt.enablement_epoch != next_enablement_epoch {
            return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                field: "enablement_epoch",
                expected: next_enablement_epoch,
                actual: receipt.enablement_epoch,
            });
        }
        if let Some(binding) = receipt.body.binding() {
            if binding.key() != &key {
                return Err(PluginPermissionDecisionErrorV2::BindingKeyMismatch);
            }
        }

        let previous_enablement = enablement;
        match &receipt.body {
            PluginPermissionDecisionReplayBodyV2::DecisionRecorded {
                binding,
                decision: next,
            } => {
                let next_decision_revision = decision_revision.checked_add(1).ok_or(
                    PluginPermissionDecisionErrorV2::RevisionOverflow {
                        field: "decision_revision",
                    },
                )?;
                if receipt.decision_revision != next_decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: next_decision_revision,
                        actual: receipt.decision_revision,
                    });
                }
                decision_revision = next_decision_revision;
                decision = Some(RestoredPluginPermissionDecisionIdentityV2::Legacy {
                    binding: binding.clone(),
                    decision: *next,
                });
                enablement = PluginPermissionEnablementV2::Disabled;
            }
            PluginPermissionDecisionReplayBodyV2::DecisionRecordedWithReview {
                binding,
                decision: next,
                review_projection_digest,
            } => {
                let next_decision_revision = decision_revision.checked_add(1).ok_or(
                    PluginPermissionDecisionErrorV2::RevisionOverflow {
                        field: "decision_revision",
                    },
                )?;
                if receipt.decision_revision != next_decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: next_decision_revision,
                        actual: receipt.decision_revision,
                    });
                }
                decision_revision = next_decision_revision;
                decision = Some(RestoredPluginPermissionDecisionIdentityV2::Reviewed {
                    binding: binding.clone(),
                    decision: *next,
                    review_projection_digest: review_projection_digest.clone(),
                });
                enablement = PluginPermissionEnablementV2::Disabled;
            }
            PluginPermissionDecisionReplayBodyV2::Enabled { binding } => {
                if receipt.decision_revision != decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: decision_revision,
                        actual: receipt.decision_revision,
                    });
                }
                let Some(current) = &decision else {
                    return Err(PluginPermissionDecisionErrorV2::DecisionNotApproved);
                };
                let (approved_binding, approved_decision) = match current {
                    RestoredPluginPermissionDecisionIdentityV2::Legacy { binding, decision }
                    | RestoredPluginPermissionDecisionIdentityV2::Reviewed {
                        binding,
                        decision,
                        ..
                    } => (binding, decision),
                };
                if *approved_decision != PluginPermissionDecisionV2::Approve {
                    return Err(PluginPermissionDecisionErrorV2::DecisionNotApproved);
                }
                if approved_binding != binding {
                    return Err(PluginPermissionDecisionErrorV2::ApprovedBindingMismatch);
                }
                enablement = PluginPermissionEnablementV2::Enabled;
            }
            PluginPermissionDecisionReplayBodyV2::Disabled => {
                if receipt.decision_revision != decision_revision {
                    return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
                        field: "decision_revision",
                        expected: decision_revision,
                        actual: receipt.decision_revision,
                    });
                }
                enablement = PluginPermissionEnablementV2::Disabled;
            }
        }
        let explicit_enabled_to_disabled = previous_enablement
            == PluginPermissionEnablementV2::Enabled
            && matches!(receipt.body, PluginPermissionDecisionReplayBodyV2::Disabled);
        if receipt.explicit_enabled_to_disabled != explicit_enabled_to_disabled {
            return Err(PluginPermissionDecisionErrorV2::CheckpointStateMismatch {
                field: "receipt_explicit_enabled_to_disabled",
            });
        }
        last_event_used_disable_reserve = explicit_enabled_to_disabled;
        record_revision = next_record_revision;
        enablement_epoch = next_enablement_epoch;
        receipts_by_request.insert(receipt.request_id.clone(), receipt.clone());
    }

    if observed_events == MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
        && !last_event_used_disable_reserve
    {
        return Err(PluginPermissionDecisionErrorV2::InvalidEmergencyDisableReserve);
    }
    if checkpoint.state.record_revision != record_revision {
        return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
            field: "checkpoint_record_revision",
            expected: record_revision,
            actual: checkpoint.state.record_revision,
        });
    }
    if checkpoint.state.decision_revision != decision_revision {
        return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
            field: "checkpoint_decision_revision",
            expected: decision_revision,
            actual: checkpoint.state.decision_revision,
        });
    }
    if checkpoint.state.enablement_epoch != enablement_epoch {
        return Err(PluginPermissionDecisionErrorV2::CounterMismatch {
            field: "checkpoint_enablement_epoch",
            expected: enablement_epoch,
            actual: checkpoint.state.enablement_epoch,
        });
    }
    if checkpoint.state.enablement != enablement {
        return Err(PluginPermissionDecisionErrorV2::CheckpointStateMismatch {
            field: "enablement",
        });
    }

    let recorded_decision = match (&decision, &checkpoint.state.decision) {
        (None, PluginPermissionDecisionCheckpointCurrentDecisionV2::None) => None,
        (
            Some(RestoredPluginPermissionDecisionIdentityV2::Legacy {
                binding: expected_binding,
                decision: expected_decision,
            }),
            PluginPermissionDecisionCheckpointCurrentDecisionV2::Legacy { binding, decision },
        ) if expected_binding == binding && expected_decision == decision => {
            Some(RecordedPluginPermissionDecisionV2 {
                binding: binding.clone(),
                decision: *decision,
                review_projection: None,
            })
        }
        (
            Some(RestoredPluginPermissionDecisionIdentityV2::Reviewed {
                binding: expected_binding,
                decision: expected_decision,
                review_projection_digest,
            }),
            PluginPermissionDecisionCheckpointCurrentDecisionV2::Reviewed {
                binding,
                decision,
                review_projection,
            },
        ) if expected_binding == binding
            && expected_decision == decision
            && review_projection.plan_digest() == binding.plan_digest()
            && review_projection.digest() == review_projection_digest =>
        {
            Some(RecordedPluginPermissionDecisionV2 {
                binding: binding.clone(),
                decision: *decision,
                review_projection: Some(review_projection.clone()),
            })
        }
        _ => {
            return Err(PluginPermissionDecisionErrorV2::CheckpointStateMismatch {
                field: "decision",
            });
        }
    };

    Ok(PluginPermissionDecisionFoldV2 {
        state: PluginPermissionDecisionStateV2 {
            key,
            record_revision,
            decision_revision,
            enablement_epoch,
            decision: recorded_decision,
            enablement,
        },
        receipts_by_request,
        observed_events,
    })
}

/// Opaque authority evidence for one exact permission value at one exact state generation.
///
/// It cannot be serialized or exported to TypeScript and carries no native agent-install scope.
pub struct PluginPermissionExecutionLeaseV2 {
    key: PluginPermissionDecisionKeyV2,
    binding: PluginPermissionDecisionBindingV2,
    record_revision: u64,
    decision_revision: u64,
    enablement_epoch: u64,
    permission_kind: PermissionKindIdV2,
    parameter: String,
    value: String,
}

impl PluginPermissionExecutionLeaseV2 {
    pub fn key(&self) -> &PluginPermissionDecisionKeyV2 {
        &self.key
    }

    pub fn record_revision(&self) -> u64 {
        self.record_revision
    }

    pub fn decision_revision(&self) -> u64 {
        self.decision_revision
    }

    pub fn enablement_epoch(&self) -> u64 {
        self.enablement_epoch
    }

    pub fn permission_kind(&self) -> &PermissionKindIdV2 {
        &self.permission_kind
    }

    pub fn parameter(&self) -> &str {
        &self.parameter
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

pub fn evaluate_plugin_permission_execution(
    state: &PluginPermissionDecisionStateV2,
    current_plan: &PluginPermissionPlanV2,
    permission_kind: &PermissionKindIdV2,
    parameter: &str,
    value: &str,
) -> Result<PluginPermissionExecutionLeaseV2, PluginPermissionExecutionErrorV2> {
    let binding = PluginPermissionDecisionBindingV2::from_plan(current_plan);
    if binding.key() != state.key() {
        return Err(PluginPermissionExecutionErrorV2::StateKeyMismatch);
    }
    let Some(recorded) = &state.decision else {
        return Err(PluginPermissionExecutionErrorV2::NoApprovedDecision);
    };
    if recorded.decision != PluginPermissionDecisionV2::Approve {
        return Err(PluginPermissionExecutionErrorV2::NoApprovedDecision);
    }
    if recorded.binding != binding {
        return Err(PluginPermissionExecutionErrorV2::StalePlanBinding);
    }
    if state.enablement != PluginPermissionEnablementV2::Enabled {
        return Err(PluginPermissionExecutionErrorV2::Disabled);
    }

    let permission = current_plan
        .permissions()
        .iter()
        .find(|permission| &permission.kind == permission_kind)
        .ok_or_else(
            || PluginPermissionExecutionErrorV2::PermissionKindNotGranted {
                kind: permission_kind.clone(),
            },
        )?;
    let values = permission.parameters.get(parameter).ok_or_else(|| {
        PluginPermissionExecutionErrorV2::PermissionParameterNotGranted {
            kind: permission_kind.clone(),
            parameter: parameter.to_owned(),
        }
    })?;
    if !values.iter().any(|allowed| allowed == value) {
        return Err(
            PluginPermissionExecutionErrorV2::PermissionValueNotGranted {
                kind: permission_kind.clone(),
                parameter: parameter.to_owned(),
                value: value.to_owned(),
            },
        );
    }

    Ok(PluginPermissionExecutionLeaseV2 {
        key: state.key.clone(),
        binding,
        record_revision: state.record_revision,
        decision_revision: state.decision_revision,
        enablement_epoch: state.enablement_epoch,
        permission_kind: permission_kind.clone(),
        parameter: parameter.to_owned(),
        value: value.to_owned(),
    })
}

pub fn revalidate_plugin_permission_execution_lease(
    lease: &PluginPermissionExecutionLeaseV2,
    state: &PluginPermissionDecisionStateV2,
    current_plan: &PluginPermissionPlanV2,
) -> Result<(), PluginPermissionExecutionErrorV2> {
    if lease.key != *state.key()
        || lease.record_revision != state.record_revision()
        || lease.decision_revision != state.decision_revision()
        || lease.enablement_epoch != state.enablement_epoch()
    {
        return Err(PluginPermissionExecutionErrorV2::StaleLease);
    }
    let current = evaluate_plugin_permission_execution(
        state,
        current_plan,
        &lease.permission_kind,
        &lease.parameter,
        &lease.value,
    )?;
    if current.binding != lease.binding {
        return Err(PluginPermissionExecutionErrorV2::StaleLease);
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginPermissionDecisionErrorV2 {
    InvalidRequestId,
    UnsupportedSchemaVersion {
        found: u16,
    },
    KeyMismatch,
    BindingKeyMismatch,
    ReviewProjectionPlanDigestMismatch,
    RecordRevisionConflict {
        expected: u64,
        actual: u64,
    },
    CounterMismatch {
        field: &'static str,
        expected: u64,
        actual: u64,
    },
    RevisionOverflow {
        field: &'static str,
    },
    DuplicateRequestConflict {
        request_id: PluginPermissionDecisionRequestIdV2,
    },
    DecisionNotApproved,
    ApprovedBindingMismatch,
    EventLimitExceeded,
    InvalidCheckpointObservedEventCount {
        observed: u64,
        recorded: usize,
    },
    InvalidEmergencyDisableReserve,
    CheckpointStateMismatch {
        field: &'static str,
    },
}

impl fmt::Display for PluginPermissionDecisionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequestId => formatter
                .write_str("plugin permission request ID must be a bounded ASCII identifier"),
            Self::UnsupportedSchemaVersion { found } => write!(
                formatter,
                "unsupported plugin permission decision schema version {found}"
            ),
            Self::KeyMismatch => {
                formatter.write_str("plugin permission event belongs to a different key")
            }
            Self::BindingKeyMismatch => {
                formatter.write_str("plugin permission binding belongs to a different event key")
            }
            Self::ReviewProjectionPlanDigestMismatch => formatter.write_str(
                "plugin permission review projection belongs to a different plan digest",
            ),
            Self::RecordRevisionConflict { expected, actual } => write!(
                formatter,
                "plugin permission record revision conflict: expected {expected}, current {actual}"
            ),
            Self::CounterMismatch {
                field,
                expected,
                actual,
            } => write!(
                formatter,
                "plugin permission {field} must be {expected}, found {actual}"
            ),
            Self::RevisionOverflow { field } => {
                write!(formatter, "plugin permission {field} overflowed")
            }
            Self::DuplicateRequestConflict { request_id } => write!(
                formatter,
                "plugin permission request {} was replayed with different input",
                request_id.as_str()
            ),
            Self::DecisionNotApproved => {
                formatter.write_str("the current plugin permission decision is not approved")
            }
            Self::ApprovedBindingMismatch => {
                formatter.write_str("the current approved plugin permission binding does not match")
            }
            Self::EventLimitExceeded => write!(
                formatter,
                "plugin permission journal exceeds {MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2} regular events plus its enabled-to-disabled reserve"
            ),
            Self::InvalidCheckpointObservedEventCount { observed, recorded } => write!(
                formatter,
                "plugin permission checkpoint observed {observed} events for {recorded} recorded requests"
            ),
            Self::InvalidEmergencyDisableReserve => formatter.write_str(
                "plugin permission checkpoint reserve is not an enabled-to-disabled transition",
            ),
            Self::CheckpointStateMismatch { field } => write!(
                formatter,
                "plugin permission checkpoint {field} does not match its replay receipts"
            ),
        }
    }
}

impl Error for PluginPermissionDecisionErrorV2 {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginPermissionExecutionErrorV2 {
    StateKeyMismatch,
    NoApprovedDecision,
    StalePlanBinding,
    Disabled,
    PermissionKindNotGranted {
        kind: PermissionKindIdV2,
    },
    PermissionParameterNotGranted {
        kind: PermissionKindIdV2,
        parameter: String,
    },
    PermissionValueNotGranted {
        kind: PermissionKindIdV2,
        parameter: String,
        value: String,
    },
    StaleLease,
}

impl fmt::Display for PluginPermissionExecutionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StateKeyMismatch => {
                formatter.write_str("the plugin permission state belongs to a different plan key")
            }
            Self::NoApprovedDecision => {
                formatter.write_str("the current plugin permission plan is not approved")
            }
            Self::StalePlanBinding => formatter
                .write_str("the approved plugin permission plan binding is no longer current"),
            Self::Disabled => formatter.write_str("plugin permission execution is disabled"),
            Self::PermissionKindNotGranted { kind } => write!(
                formatter,
                "plugin permission kind {} is not granted",
                kind.as_str()
            ),
            Self::PermissionParameterNotGranted { kind, parameter } => write!(
                formatter,
                "plugin permission {} parameter {parameter} is not granted",
                kind.as_str()
            ),
            Self::PermissionValueNotGranted {
                kind,
                parameter,
                value,
            } => write!(
                formatter,
                "plugin permission {} parameter {parameter} value {value:?} is not granted",
                kind.as_str()
            ),
            Self::StaleLease => formatter.write_str("plugin permission execution lease is stale"),
        }
    }
}

impl Error for PluginPermissionExecutionErrorV2 {}

fn validate_schema_version(version: u16) -> Result<(), PluginPermissionDecisionErrorV2> {
    if version == PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2 {
        Ok(())
    } else {
        Err(PluginPermissionDecisionErrorV2::UnsupportedSchemaVersion { found: version })
    }
}

fn validate_checkpoint_schema_version(version: u16) -> Result<(), PluginPermissionDecisionErrorV2> {
    if version == PLUGIN_PERMISSION_DECISION_CHECKPOINT_SCHEMA_VERSION_V2 {
        Ok(())
    } else {
        Err(PluginPermissionDecisionErrorV2::UnsupportedSchemaVersion { found: version })
    }
}

fn next_observed_event_count(
    observed_events: usize,
    uses_emergency_disable_reserve: bool,
) -> Result<usize, PluginPermissionDecisionErrorV2> {
    let next = observed_events
        .checked_add(1)
        .ok_or(PluginPermissionDecisionErrorV2::EventLimitExceeded)?;
    if next <= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
        || (next == MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
            && uses_emergency_disable_reserve)
    {
        Ok(next)
    } else {
        Err(PluginPermissionDecisionErrorV2::EventLimitExceeded)
    }
}

mod decimal_u64 {
    use super::*;

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(serde::de::Error::custom(
                "revision must be a canonical unsigned decimal string",
            ));
        }
        value.parse().map_err(serde::de::Error::custom)
    }
}

mod bounded_replay_receipts {
    use std::fmt;

    use serde::de::{Error as _, SeqAccess, Visitor};

    use super::*;

    pub fn deserialize<'de, D>(
        deserializer: D,
    ) -> Result<Vec<PluginPermissionDecisionReplayReceiptV2>, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ReplayReceiptsVisitor;

        impl<'de> Visitor<'de> for ReplayReceiptsVisitor {
            type Value = Vec<PluginPermissionDecisionReplayReceiptV2>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(
                    formatter,
                    "at most {MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2} plugin permission replay receipts"
                )
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let capacity = sequence
                    .size_hint()
                    .unwrap_or(0)
                    .min(MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2);
                let mut receipts = Vec::with_capacity(capacity);
                while let Some(receipt) = sequence.next_element()? {
                    if receipts.len()
                        == MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
                    {
                        return Err(A::Error::invalid_length(receipts.len() + 1, &self));
                    }
                    receipts.push(receipt);
                }
                Ok(receipts)
            }
        }

        deserializer.deserialize_seq(ReplayReceiptsVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission_fixture(
        enablement: PluginPermissionEnablementV2,
    ) -> (
        PluginPermissionDecisionFoldV2,
        PluginPermissionDecisionBindingV2,
    ) {
        let key = PluginPermissionDecisionKeyV2::new(
            PluginWorkspaceIdentityV2::from_host_hmac(format!("sha256:{}", "a".repeat(64)))
                .unwrap(),
            PluginIdV2::new("dure.fixture").unwrap(),
        );
        let binding = PluginPermissionDecisionBindingV2 {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key: key.clone(),
            plan_digest: PluginPermissionPlanDigestV2::new(format!("sha256:{}", "b".repeat(64)))
                .unwrap(),
        };
        let state = PluginPermissionDecisionStateV2 {
            key,
            record_revision: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 as u64,
            decision_revision: 1,
            enablement_epoch: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 as u64,
            decision: Some(RecordedPluginPermissionDecisionV2 {
                binding: binding.clone(),
                decision: PluginPermissionDecisionV2::Approve,
                review_projection: None,
            }),
            enablement,
        };
        (
            PluginPermissionDecisionFoldV2 {
                state,
                receipts_by_request: BTreeMap::new(),
                observed_events: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
            },
            binding,
        )
    }

    fn next_fixture_event(
        fold: &PluginPermissionDecisionFoldV2,
        request_id: &str,
        body: PluginPermissionDecisionEventBodyV2,
    ) -> PluginPermissionDecisionEventV2 {
        PluginPermissionDecisionEventV2 {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key: fold.state.key().clone(),
            request_id: PluginPermissionDecisionRequestIdV2::new(request_id).unwrap(),
            expected_record_revision: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 as u64,
            record_revision: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2 as u64,
            decision_revision: 1,
            enablement_epoch: MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2 as u64,
            body,
        }
    }

    #[test]
    fn enabled_plugin_can_use_emergency_disable_reserve_at_active_limit() {
        let (mut fold, _) = permission_fixture(PluginPermissionEnablementV2::Enabled);
        let event = next_fixture_event(
            &fold,
            "emergency-disable",
            PluginPermissionDecisionEventBodyV2::Disabled,
        );

        let application = apply_plugin_permission_decision_event(&mut fold, &event).unwrap();

        assert_eq!(
            application.disposition(),
            PluginPermissionDecisionEventDispositionV2::Applied
        );
        assert_eq!(
            application.state().enablement(),
            PluginPermissionEnablementV2::Disabled
        );
        assert_eq!(
            fold.observed_events,
            MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
        );
    }

    #[test]
    fn non_disable_event_cannot_use_emergency_reserve_at_active_limit() {
        let (mut fold, binding) = permission_fixture(PluginPermissionEnablementV2::Enabled);
        let original_state = fold.state.clone();
        let event = next_fixture_event(
            &fold,
            "enable-again",
            PluginPermissionDecisionEventBodyV2::Enabled { binding },
        );

        assert_eq!(
            apply_plugin_permission_decision_event(&mut fold, &event),
            Err(PluginPermissionDecisionErrorV2::EventLimitExceeded)
        );
        assert_eq!(fold.state, original_state);
        assert_eq!(
            fold.observed_events,
            MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
        );
    }

    #[test]
    fn already_disabled_plugin_cannot_use_emergency_reserve_at_active_limit() {
        let (mut fold, _) = permission_fixture(PluginPermissionEnablementV2::Disabled);
        let original_state = fold.state.clone();
        let event = next_fixture_event(
            &fold,
            "disable-again",
            PluginPermissionDecisionEventBodyV2::Disabled,
        );

        assert_eq!(
            apply_plugin_permission_decision_event(&mut fold, &event),
            Err(PluginPermissionDecisionErrorV2::EventLimitExceeded)
        );
        assert_eq!(fold.state, original_state);
        assert_eq!(
            fold.observed_events,
            MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
        );
    }

    #[test]
    fn overflowing_internal_counters_fail_closed() {
        let key = PluginPermissionDecisionKeyV2::new(
            PluginWorkspaceIdentityV2::from_host_hmac(format!("sha256:{}", "a".repeat(64)))
                .unwrap(),
            PluginIdV2::new("dure.fixture").unwrap(),
        );
        let state = PluginPermissionDecisionStateV2 {
            key: key.clone(),
            record_revision: u64::MAX,
            decision_revision: u64::MAX,
            enablement_epoch: u64::MAX,
            decision: None,
            enablement: PluginPermissionEnablementV2::Disabled,
        };
        let event = PluginPermissionDecisionEventV2 {
            schema_version: PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2,
            key,
            request_id: PluginPermissionDecisionRequestIdV2::new("overflow").unwrap(),
            expected_record_revision: u64::MAX,
            record_revision: 0,
            decision_revision: u64::MAX,
            enablement_epoch: 0,
            body: PluginPermissionDecisionEventBodyV2::Disabled,
        };
        assert!(matches!(
            state.transition(&event),
            Err(PluginPermissionDecisionErrorV2::RevisionOverflow {
                field: "record_revision"
            })
        ));
    }
}
