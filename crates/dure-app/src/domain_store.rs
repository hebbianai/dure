use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

pub(crate) use dure_app_protocol::validate_domain_id;
pub use dure_app_protocol::{DomainIdErrorV1, OperationIdV1};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    ClientViewAuthorityV1, ClientViewGenerationAdvanceRequestV1, ClientViewGenerationReceiptV1,
    ClientViewIdentityV1, ClientViewNamespaceV1, ClientViewRecordV1, ClientViewWriteReceiptV1,
    ClientViewWriteRequestV1, ProviderIdV1, RuntimeKindIdV1,
};

pub const MIN_SUPPORTED_STORE_SCHEMA_VERSION: u32 = 1;
pub const CURRENT_STORE_SCHEMA_VERSION: u32 = 51;
pub const CURRENT_STORE_READER_VERSION: u32 = 51;
pub const CURRENT_STORE_WRITER_VERSION: u32 = 51;
pub const AGENT_CHECKPOINT_SCHEMA_VERSION_V1: u16 = 1;

const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_LABEL_BYTES: usize = 512;
const MAX_TOKEN_BYTES: usize = 160;
const MAX_AGENT_CHECKPOINT_BYTES: usize = 4 * 1024;

macro_rules! durable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, DomainIdErrorV1> {
                let value = value.into();
                validate_domain_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

durable_id!(ProjectIdV1);
durable_id!(WorkspaceIdV1);
durable_id!(AgentIdV1);
durable_id!(ReviewIdV1);
durable_id!(OperationEventIdV1);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreSchemaInfoV1 {
    pub schema_version: u32,
    pub min_reader_version: u32,
    pub min_writer_version: u32,
}

impl StoreSchemaInfoV1 {
    pub fn current() -> Self {
        Self {
            schema_version: CURRENT_STORE_SCHEMA_VERSION,
            min_reader_version: MIN_SUPPORTED_STORE_SCHEMA_VERSION,
            min_writer_version: MIN_SUPPORTED_STORE_SCHEMA_VERSION,
        }
    }

    pub fn validate_for_current_host(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version < MIN_SUPPORTED_STORE_SCHEMA_VERSION {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "schema_too_old",
                detail: format!(
                    "schema {} is older than supported schema {}",
                    self.schema_version, MIN_SUPPORTED_STORE_SCHEMA_VERSION
                ),
            });
        }
        if self.min_reader_version > CURRENT_STORE_READER_VERSION {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "reader_too_old",
                detail: format!(
                    "database requires reader {}, host provides {}",
                    self.min_reader_version, CURRENT_STORE_READER_VERSION
                ),
            });
        }
        if self.min_writer_version > CURRENT_STORE_WRITER_VERSION {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "writer_too_old",
                detail: format!(
                    "database requires writer {}, host provides {}",
                    self.min_writer_version, CURRENT_STORE_WRITER_VERSION
                ),
            });
        }
        if self.schema_version > CURRENT_STORE_SCHEMA_VERSION {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "schema_from_newer_host",
                detail: format!(
                    "schema {} is newer than host schema {}",
                    self.schema_version, CURRENT_STORE_SCHEMA_VERSION
                ),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecordV1 {
    pub project_id: ProjectIdV1,
    pub root_path: String,
    pub display_name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ProjectRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_path("rootPath", &self.root_path)?;
        validate_label("displayName", &self.display_name)?;
        validate_timestamps(self.created_at_ms, self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecordV1 {
    pub workspace_id: WorkspaceIdV1,
    pub project_id: ProjectIdV1,
    pub root_path: String,
    pub base_commit_sha: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl WorkspaceRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_path("rootPath", &self.root_path)?;
        if let Some(base_commit_sha) = &self.base_commit_sha {
            validate_token("baseCommitSha", base_commit_sha)?;
        }
        validate_timestamps(self.created_at_ms, self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecordV1 {
    pub agent_id: AgentIdV1,
    pub workspace_id: WorkspaceIdV1,
    pub provider_id: ProviderIdV1,
    pub display_name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl AgentRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_label("displayName", &self.display_name)?;
        validate_timestamps(self.created_at_ms, self.updated_at_ms)
    }
}

/// A durable lookup hint for reconnecting an agent to an external session.
///
/// This record never establishes runtime liveness. In particular, the
/// credential reference is an opaque identifier, not credential material.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingRecordV1 {
    pub agent_id: AgentIdV1,
    pub runtime_kind_id: RuntimeKindIdV1,
    pub session_id: String,
    pub provider_conversation_id: Option<String>,
    pub credential_reference_id: Option<String>,
    pub binding_generation: i64,
    pub bound_at_ms: i64,
}

impl SessionBindingRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("sessionId", &self.session_id)?;
        if let Some(conversation_id) = &self.provider_conversation_id {
            validate_token("providerConversationId", conversation_id)?;
        }
        if let Some(credential_reference_id) = &self.credential_reference_id {
            validate_token("credentialReferenceId", credential_reference_id)?;
        }
        if self.binding_generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "bindingGeneration",
                reason: "must be positive".into(),
            });
        }
        validate_timestamp("boundAtMs", self.bound_at_ms)
    }
}

/// Durable exact runtime fence committed atomically with the logical Agent
/// session binding. Hmux remains the live authority and every operation must
/// revalidate this fence before using it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointBindingAuthorityV1 {
    pub schema_version: u16,
    pub binding: SessionBindingRecordV1,
    pub runtime_workspace_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub updated_at_ms: i64,
}

impl AgentCheckpointBindingAuthorityV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "schemaVersion",
                reason: "unsupported checkpoint binding authority schema".into(),
            });
        }
        self.binding.validate()?;
        for (field, value) in [
            ("runtimeWorkspaceId", &self.runtime_workspace_id),
            ("runnerPrincipal", &self.runner_principal),
            ("runnerInstance", &self.runner_instance),
            ("channelEpoch", &self.channel_epoch),
            ("hostInstanceId", &self.host_instance_id),
            ("terminalEpoch", &self.terminal_epoch),
        ] {
            validate_token(field, value)?;
        }
        validate_timestamp("updatedAtMs", self.updated_at_ms)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCheckpointObservationV1 {
    pub authority: AgentCheckpointBindingAuthorityV1,
    pub checkpoint: Option<AgentCheckpointRecordV1>,
}

/// Exact durable-agent binding presented by a checkpoint client.
///
/// This is an authorization fence for logical Agent state, not a claim about
/// runtime liveness. Hmux remains authoritative for the live session.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointIdentityV1 {
    pub agent_id: AgentIdV1,
    pub session_id: String,
    pub binding_generation: i64,
}

impl AgentCheckpointIdentityV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("sessionId", &self.session_id)?;
        if self.binding_generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "bindingGeneration",
                reason: "must be positive".into(),
            });
        }
        Ok(())
    }
}

/// One versioned logical Agent checkpoint shared by backend clients.
///
/// Pane layout, focus and terminal runtime fields are intentionally absent.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointRecordV1 {
    pub schema_version: u16,
    pub agent_id: AgentIdV1,
    pub checkpoint: String,
    pub revision: i64,
    pub updated_by_session_id: String,
    pub updated_by_binding_generation: i64,
    pub updated_at_ms: i64,
}

impl AgentCheckpointRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_agent_checkpoint_schema_version(self.schema_version)?;
        validate_agent_checkpoint_text(&self.checkpoint)?;
        if self.revision < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "revision",
                reason: "must be positive".into(),
            });
        }
        validate_token("updatedBySessionId", &self.updated_by_session_id)?;
        if self.updated_by_binding_generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "updatedByBindingGeneration",
                reason: "must be positive".into(),
            });
        }
        validate_timestamp("updatedAtMs", self.updated_at_ms)
    }

    /// Whether this record is consistent with the binding authority it was
    /// served under. Observation serves the CURRENT authority binding while
    /// the record keeps its write-time identity, which may lag by any number
    /// of generations after a rehost with no newer write. Two shapes are
    /// impossible from honest durable state and fail closed: a record
    /// claiming a generation beyond the serving authority, and a
    /// same-generation record whose writer session differs from the
    /// authority session.
    pub fn consistent_with_serving_binding(
        &self,
        binding_generation: i64,
        binding_session_id: &str,
    ) -> bool {
        binding_generation >= self.updated_by_binding_generation
            && (binding_generation != self.updated_by_binding_generation
                || binding_session_id == self.updated_by_session_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointWriteRequestV1 {
    pub schema_version: u16,
    pub identity: AgentCheckpointIdentityV1,
    pub idempotency_key: String,
    /// Zero means the logical Agent has no checkpoint yet.
    pub expected_revision: i64,
    pub checkpoint: String,
}

impl AgentCheckpointWriteRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_agent_checkpoint_schema_version(self.schema_version)?;
        self.identity.validate()?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        if self.expected_revision < 0 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "expectedRevision",
                reason: "must not be negative".into(),
            });
        }
        validate_agent_checkpoint_text(&self.checkpoint)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointWriteReceiptV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub record: AgentCheckpointRecordV1,
}

impl AgentCheckpointWriteReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_agent_checkpoint_schema_version(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        self.record.validate()
    }
}

/// Immutable identity for one diff-review target.
///
/// The path is a locator while `worktree_git_dir` is the Git worktree identity
/// checked whenever the review is reopened. The baseline is captured once and
/// never follows a moving branch ref.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTargetRecordV1 {
    pub review_id: ReviewIdV1,
    pub worktree_path: String,
    pub worktree_git_dir: String,
    pub base_ref: String,
    pub base_commit_sha: String,
    pub head_commit_sha: String,
    pub source_session_id: Option<String>,
    pub feedback_agent_id: Option<AgentIdV1>,
    pub created_at_ms: i64,
}

impl ReviewTargetRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_path("worktreePath", &self.worktree_path)?;
        validate_path("worktreeGitDir", &self.worktree_git_dir)?;
        validate_token("baseRef", &self.base_ref)?;
        validate_git_object_id("baseCommitSha", &self.base_commit_sha)?;
        validate_git_object_id("headCommitSha", &self.head_commit_sha)?;
        if let Some(session_id) = &self.source_session_id {
            validate_token("sourceSessionId", session_id)?;
        }
        validate_timestamp("createdAtMs", self.created_at_ms)
    }
}

/// Authoritative roots observed in the persisted Dock layout at one instant.
///
/// Reconciliation is last-observation-wins, except that an active root wins an
/// equal-timestamp race. That tie rule deliberately leaks rather than deleting
/// a review that another window can still restore.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTargetRootSnapshotV1 {
    pub active_review_ids: Vec<ReviewIdV1>,
    pub observed_at_ms: i64,
}

impl ReviewTargetRootSnapshotV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_timestamp("observedAtMs", self.observed_at_ms)?;
        let unique = self.active_review_ids.iter().collect::<BTreeSet<_>>();
        if unique.len() != self.active_review_ids.len() {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "activeReviewIds",
                reason: "must not contain duplicates".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTargetRetentionPolicyV1 {
    pub inactive_retention_ms: i64,
    pub max_inactive_targets: u32,
}

impl ReviewTargetRetentionPolicyV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.inactive_retention_ms < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "inactiveRetentionMs",
                reason: "must be positive".into(),
            });
        }
        if self.max_inactive_targets < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "maxInactiveTargets",
                reason: "must be positive".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTargetSweepReceiptV1 {
    pub active_targets: u64,
    pub inactive_targets: u64,
    pub deleted_targets: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OperationEventBodyV1 {
    Started {
        idempotency_key: String,
        operation_kind: String,
    },
    Progressed {
        stage: String,
    },
    Succeeded {
        result_code: Option<String>,
    },
    Failed {
        error_code: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEventV1 {
    pub event_id: OperationEventIdV1,
    pub operation_id: OperationIdV1,
    pub sequence: i64,
    pub body: OperationEventBodyV1,
    pub created_at_ms: i64,
}

impl OperationEventV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.sequence < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "sequence",
                reason: "must be positive".into(),
            });
        }
        validate_timestamp("createdAtMs", self.created_at_ms)?;
        match &self.body {
            OperationEventBodyV1::Started {
                idempotency_key,
                operation_kind,
            } => {
                validate_token("idempotencyKey", idempotency_key)?;
                validate_token("operationKind", operation_kind)
            }
            OperationEventBodyV1::Progressed { stage } => validate_token("stage", stage),
            OperationEventBodyV1::Succeeded { result_code } => {
                if let Some(result_code) = result_code {
                    validate_token("resultCode", result_code)?;
                }
                Ok(())
            }
            OperationEventBodyV1::Failed { error_code } => validate_token("errorCode", error_code),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationReceiptStateV1 {
    Running,
    Succeeded,
    Failed,
}

impl OperationReceiptStateV1 {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceiptV1 {
    pub operation_id: OperationIdV1,
    pub idempotency_key: String,
    pub operation_kind: String,
    pub state: OperationReceiptStateV1,
    pub last_sequence: i64,
    pub current_stage: Option<String>,
    pub terminal_code: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub fn fold_operation_events(
    events: &[OperationEventV1],
) -> Result<OperationReceiptV1, DomainStoreErrorV1> {
    let first = events
        .first()
        .ok_or(DomainStoreErrorV1::InvalidEventStream {
            reason: "operation has no events".into(),
        })?;
    first.validate()?;
    let OperationEventBodyV1::Started {
        idempotency_key,
        operation_kind,
    } = &first.body
    else {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "sequence 1 must be operation.started".into(),
        });
    };
    if first.sequence != 1 {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "the first event sequence must be 1".into(),
        });
    }

    let mut receipt = OperationReceiptV1 {
        operation_id: first.operation_id.clone(),
        idempotency_key: idempotency_key.clone(),
        operation_kind: operation_kind.clone(),
        state: OperationReceiptStateV1::Running,
        last_sequence: 1,
        current_stage: None,
        terminal_code: None,
        created_at_ms: first.created_at_ms,
        updated_at_ms: first.created_at_ms,
    };

    for (index, event) in events.iter().enumerate().skip(1) {
        event.validate()?;
        let expected_sequence =
            i64::try_from(index + 1).map_err(|_| DomainStoreErrorV1::InvalidEventStream {
                reason: "event stream is too large".into(),
            })?;
        if event.sequence != expected_sequence {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: format!(
                    "expected sequence {expected_sequence}, found {}",
                    event.sequence
                ),
            });
        }
        if event.operation_id != receipt.operation_id {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: "an event belongs to a different operation".into(),
            });
        }
        if event.created_at_ms < receipt.updated_at_ms {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: "event timestamps must be monotonic".into(),
            });
        }
        if receipt.state != OperationReceiptStateV1::Running {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: "events cannot follow a terminal event".into(),
            });
        }

        match &event.body {
            OperationEventBodyV1::Started { .. } => {
                return Err(DomainStoreErrorV1::InvalidEventStream {
                    reason: "operation.started may only appear at sequence 1".into(),
                });
            }
            OperationEventBodyV1::Progressed { stage } => {
                receipt.current_stage = Some(stage.clone());
            }
            OperationEventBodyV1::Succeeded { result_code } => {
                receipt.state = OperationReceiptStateV1::Succeeded;
                receipt.terminal_code.clone_from(result_code);
            }
            OperationEventBodyV1::Failed { error_code } => {
                receipt.state = OperationReceiptStateV1::Failed;
                receipt.terminal_code = Some(error_code.clone());
            }
        }
        receipt.last_sequence = event.sequence;
        receipt.updated_at_ms = event.created_at_ms;
    }

    Ok(receipt)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainStoreErrorV1 {
    InvalidRecord {
        field: &'static str,
        reason: String,
    },
    InvalidEventStream {
        reason: String,
    },
    NotFound {
        entity: &'static str,
        id: String,
    },
    IdentityConflict {
        entity: &'static str,
        id: String,
        reason: String,
    },
    IdempotencyConflict {
        reason: String,
    },
    RevisionConflict {
        agent_id: String,
        expected_revision: i64,
        actual_revision: Option<i64>,
    },
    ProviderLaunchDefaultsRevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    AgentSpawnPlanAdmissionRejected {
        code: &'static str,
    },
    ClientViewGenerationConflict {
        client_id: String,
        expected_generation: i64,
        actual_generation: Option<i64>,
    },
    ClientViewInstanceConflict {
        client_id: String,
        client_generation: i64,
    },
    ClientViewRevisionConflict {
        client_id: String,
        view_id: String,
        expected_revision: i64,
        actual_revision: Option<i64>,
    },
    Compatibility {
        code: &'static str,
        detail: String,
    },
    InterruptedMigration {
        from_version: u32,
        to_version: u32,
        backup_name: String,
    },
    Busy {
        operation: &'static str,
    },
    Storage {
        code: &'static str,
        detail: String,
    },
}

impl fmt::Display for DomainStoreErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRecord { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
            Self::InvalidEventStream { reason } => {
                write!(formatter, "invalid operation event stream: {reason}")
            }
            Self::NotFound { entity, id } => write!(formatter, "{entity} {id:?} was not found"),
            Self::IdentityConflict { entity, id, reason } => {
                write!(
                    formatter,
                    "{entity} {id:?} conflicts with durable identity: {reason}"
                )
            }
            Self::IdempotencyConflict { reason } => {
                write!(formatter, "idempotency conflict: {reason}")
            }
            Self::RevisionConflict {
                agent_id,
                expected_revision,
                actual_revision,
            } => write!(
                formatter,
                "agent checkpoint {agent_id:?} expected revision {expected_revision}, found {}",
                actual_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "no checkpoint".into())
            ),
            Self::ProviderLaunchDefaultsRevisionConflict {
                expected_revision,
                actual_revision,
            } => write!(
                formatter,
                "provider launch defaults expected revision {expected_revision}, found {actual_revision}"
            ),
            Self::AgentSpawnPlanAdmissionRejected { code } => {
                write!(formatter, "agent spawn plan admission rejected: {code}")
            }
            Self::ClientViewGenerationConflict {
                client_id,
                expected_generation,
                actual_generation,
            } => write!(
                formatter,
                "client view {client_id:?} expected generation {expected_generation}, found {}",
                actual_generation
                    .map(|generation| generation.to_string())
                    .unwrap_or_else(|| "no generation".into())
            ),
            Self::ClientViewInstanceConflict {
                client_id,
                client_generation,
            } => write!(
                formatter,
                "client view {client_id:?} generation {client_generation} belongs to a different instance"
            ),
            Self::ClientViewRevisionConflict {
                client_id,
                view_id,
                expected_revision,
                actual_revision,
            } => write!(
                formatter,
                "client view {client_id:?}/{view_id:?} expected revision {expected_revision}, found {}",
                actual_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "no view".into())
            ),
            Self::Compatibility { code, detail } => {
                write!(formatter, "store compatibility error {code}: {detail}")
            }
            Self::InterruptedMigration {
                from_version,
                to_version,
                backup_name,
            } => write!(
                formatter,
                "interrupted migration {from_version}->{to_version}; recover from {backup_name:?}"
            ),
            Self::Busy { operation } => write!(formatter, "store is busy during {operation}"),
            Self::Storage { code, detail } => {
                write!(formatter, "store error {code}: {detail}")
            }
        }
    }
}

impl std::error::Error for DomainStoreErrorV1 {}

pub type DomainStoreFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, DomainStoreErrorV1>> + Send + 'a>>;

pub trait DomainStore: Send + Sync {
    fn schema_info(&self) -> &StoreSchemaInfoV1;

    fn upsert_project<'a>(&'a self, record: &'a ProjectRecordV1) -> DomainStoreFuture<'a, ()>;

    fn project<'a>(
        &'a self,
        project_id: &'a ProjectIdV1,
    ) -> DomainStoreFuture<'a, Option<ProjectRecordV1>>;

    fn upsert_workspace<'a>(&'a self, record: &'a WorkspaceRecordV1) -> DomainStoreFuture<'a, ()>;

    fn workspace<'a>(
        &'a self,
        workspace_id: &'a WorkspaceIdV1,
    ) -> DomainStoreFuture<'a, Option<WorkspaceRecordV1>>;

    fn upsert_agent<'a>(&'a self, record: &'a AgentRecordV1) -> DomainStoreFuture<'a, ()>;

    fn agent<'a>(&'a self, agent_id: &'a AgentIdV1)
    -> DomainStoreFuture<'a, Option<AgentRecordV1>>;

    fn upsert_session_binding<'a>(
        &'a self,
        record: &'a SessionBindingRecordV1,
    ) -> DomainStoreFuture<'a, ()>;

    fn session_binding<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<SessionBindingRecordV1>>;

    fn upsert_agent_checkpoint_binding_authority<'a>(
        &'a self,
        record: &'a AgentCheckpointBindingAuthorityV1,
    ) -> DomainStoreFuture<'a, ()>;

    fn agent_checkpoint_binding_authority<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentCheckpointBindingAuthorityV1>>;

    /// Fills an unknown conversation only while the complete exact runtime
    /// authority is still current; an established identity is immutable.
    fn converge_agent_checkpoint_provider_conversation<'a>(
        &'a self,
        expected: &'a AgentCheckpointBindingAuthorityV1,
        provider_conversation_id: &'a str,
    ) -> DomainStoreFuture<'a, AgentCheckpointBindingAuthorityV1>;

    fn agent_checkpoint_observations<'a>(
        &'a self,
        agent_ids: &'a [AgentIdV1],
    ) -> DomainStoreFuture<'a, Vec<AgentCheckpointObservationV1>>;

    fn agent_checkpoint<'a>(
        &'a self,
        identity: &'a AgentCheckpointIdentityV1,
    ) -> DomainStoreFuture<'a, Option<AgentCheckpointRecordV1>>;

    fn write_agent_checkpoint<'a>(
        &'a self,
        request: &'a AgentCheckpointWriteRequestV1,
    ) -> DomainStoreFuture<'a, AgentCheckpointWriteReceiptV1>;

    fn client_view_authority<'a>(
        &'a self,
        namespace: &'a ClientViewNamespaceV1,
    ) -> DomainStoreFuture<'a, Option<ClientViewAuthorityV1>>;

    fn advance_client_view_generation<'a>(
        &'a self,
        request: &'a ClientViewGenerationAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, ClientViewGenerationReceiptV1>;

    fn client_view<'a>(
        &'a self,
        identity: &'a ClientViewIdentityV1,
    ) -> DomainStoreFuture<'a, Option<ClientViewRecordV1>>;

    fn write_client_view<'a>(
        &'a self,
        request: &'a ClientViewWriteRequestV1,
    ) -> DomainStoreFuture<'a, ClientViewWriteReceiptV1>;

    fn create_review_target<'a>(
        &'a self,
        record: &'a ReviewTargetRecordV1,
    ) -> DomainStoreFuture<'a, ()>;

    fn review_target<'a>(
        &'a self,
        review_id: &'a ReviewIdV1,
    ) -> DomainStoreFuture<'a, Option<ReviewTargetRecordV1>>;

    fn reconcile_review_target_roots<'a>(
        &'a self,
        snapshot: &'a ReviewTargetRootSnapshotV1,
        policy: &'a ReviewTargetRetentionPolicyV1,
    ) -> DomainStoreFuture<'a, ReviewTargetSweepReceiptV1>;

    fn append_operation_event<'a>(
        &'a self,
        event: &'a OperationEventV1,
    ) -> DomainStoreFuture<'a, OperationReceiptV1>;

    fn operation_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<OperationReceiptV1>>;

    fn rebuild_operation_receipts(&self) -> DomainStoreFuture<'_, usize>;
}

fn validate_path(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty() || value.len() > MAX_PATH_BYTES || value.contains('\0') {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must be a non-empty bounded path without NUL bytes".into(),
        });
    }
    Ok(())
}

pub(crate) fn validate_label(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty() || value.len() > MAX_LABEL_BYTES || value.chars().any(char::is_control) {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must be non-empty, bounded, and free of control characters".into(),
        });
    }
    Ok(())
}

pub(crate) fn validate_token(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty()
        || value.len() > MAX_TOKEN_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'/')
        })
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must be a bounded non-secret identifier token".into(),
        });
    }
    Ok(())
}

fn validate_agent_checkpoint_schema_version(schema_version: u16) -> Result<(), DomainStoreErrorV1> {
    if schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "schemaVersion",
            reason: format!(
                "must equal supported Agent checkpoint schema {}",
                AGENT_CHECKPOINT_SCHEMA_VERSION_V1
            ),
        });
    }
    Ok(())
}

fn validate_agent_checkpoint_text(value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.len() > MAX_AGENT_CHECKPOINT_BYTES || value.contains('\0') {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "checkpoint",
            reason: format!(
                "must be at most {MAX_AGENT_CHECKPOINT_BYTES} UTF-8 bytes and contain no NUL"
            ),
        });
    }
    Ok(())
}

fn validate_git_object_id(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must be a full 40- or 64-character hexadecimal Git object id".into(),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must not be negative".into(),
        });
    }
    Ok(())
}

fn validate_timestamps(created_at_ms: i64, updated_at_ms: i64) -> Result<(), DomainStoreErrorV1> {
    validate_timestamp("createdAtMs", created_at_ms)?;
    validate_timestamp("updatedAtMs", updated_at_ms)?;
    if updated_at_ms < created_at_ms {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "updatedAtMs",
            reason: "must not precede createdAtMs".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(sequence: i64, body: OperationEventBodyV1) -> OperationEventV1 {
        OperationEventV1 {
            event_id: OperationEventIdV1::new(format!("event-{sequence}")).unwrap(),
            operation_id: OperationIdV1::new("operation-1").unwrap(),
            sequence,
            body,
            created_at_ms: sequence * 10,
        }
    }

    #[test]
    fn served_record_consistency_accepts_lag_and_rejects_impossible_shapes() {
        let record = AgentCheckpointRecordV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            checkpoint: "written before rehost".into(),
            revision: 40,
            updated_by_session_id: "session-1".into(),
            updated_by_binding_generation: 2,
            updated_at_ms: 1_000,
        };
        // Same generation, same writer session — the steady state.
        assert!(record.consistent_with_serving_binding(2, "session-1"));
        // The authority advanced past the write (rehost, no newer write).
        assert!(record.consistent_with_serving_binding(3, "session-2"));
        // A record claiming a FUTURE generation cannot come from honest state.
        assert!(!record.consistent_with_serving_binding(1, "session-1"));
        // Same generation but a different writer session is inconsistent.
        assert!(!record.consistent_with_serving_binding(2, "session-2"));
    }

    #[test]
    fn durable_ids_validate_during_deserialization() {
        assert!(serde_json::from_str::<ProjectIdV1>("\"project-1\"").is_ok());
        assert!(serde_json::from_str::<ProjectIdV1>("\"../project\"").is_err());
    }

    #[test]
    fn agent_checkpoint_contract_is_bounded_and_excludes_presentation_state() {
        let request = AgentCheckpointWriteRequestV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            identity: AgentCheckpointIdentityV1 {
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                session_id: "session-1".into(),
                binding_generation: 1,
            },
            idempotency_key: "request-1".into(),
            expected_revision: 0,
            checkpoint: "audit complete".into(),
        };
        request.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({
                "schemaVersion": 1,
                "identity": {
                    "agentId": "agent-1",
                    "sessionId": "session-1",
                    "bindingGeneration": 1
                },
                "idempotencyKey": "request-1",
                "expectedRevision": 0,
                "checkpoint": "audit complete"
            })
        );

        let mut value = serde_json::to_value(&request).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("paneLayout".into(), serde_json::json!({ "focused": true }));
        assert!(serde_json::from_value::<AgentCheckpointWriteRequestV1>(value).is_err());

        let mut oversized = request;
        oversized.checkpoint = "x".repeat(MAX_AGENT_CHECKPOINT_BYTES + 1);
        assert!(matches!(
            oversized.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "checkpoint",
                ..
            })
        ));
    }

    #[test]
    fn review_target_requires_full_immutable_git_identity() {
        let mut target = ReviewTargetRecordV1 {
            review_id: ReviewIdV1::new("review-1").unwrap(),
            worktree_path: "/workspace/project/.worktrees/agent-1".into(),
            worktree_git_dir: "/workspace/project/.git/worktrees/agent-1".into(),
            base_ref: "origin/main".into(),
            base_commit_sha: "a".repeat(40),
            head_commit_sha: "b".repeat(40),
            source_session_id: Some("session-1".into()),
            feedback_agent_id: Some(AgentIdV1::new("agent-1").unwrap()),
            created_at_ms: 10,
        };
        target.validate().unwrap();

        target.base_commit_sha = "main".into();
        assert!(matches!(
            target.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "baseCommitSha",
                ..
            })
        ));
    }

    #[test]
    fn folds_a_contiguous_terminal_operation_stream() {
        let receipt = fold_operation_events(&[
            event(
                1,
                OperationEventBodyV1::Started {
                    idempotency_key: "request-1".into(),
                    operation_kind: "agent.create".into(),
                },
            ),
            event(
                2,
                OperationEventBodyV1::Progressed {
                    stage: "worktree.ready".into(),
                },
            ),
            event(
                3,
                OperationEventBodyV1::Succeeded {
                    result_code: Some("created".into()),
                },
            ),
        ])
        .unwrap();

        assert_eq!(receipt.state, OperationReceiptStateV1::Succeeded);
        assert_eq!(receipt.last_sequence, 3);
        assert_eq!(receipt.current_stage.as_deref(), Some("worktree.ready"));
        assert_eq!(receipt.terminal_code.as_deref(), Some("created"));
    }

    #[test]
    fn rejects_gaps_and_events_after_terminal_state() {
        let gap = [
            event(
                1,
                OperationEventBodyV1::Started {
                    idempotency_key: "request-1".into(),
                    operation_kind: "agent.create".into(),
                },
            ),
            event(
                3,
                OperationEventBodyV1::Progressed {
                    stage: "runtime.ready".into(),
                },
            ),
        ];
        assert!(
            fold_operation_events(&gap)
                .unwrap_err()
                .to_string()
                .contains("expected sequence 2")
        );

        let after_terminal = [
            gap[0].clone(),
            event(
                2,
                OperationEventBodyV1::Failed {
                    error_code: "preflight.failed".into(),
                },
            ),
            event(
                3,
                OperationEventBodyV1::Progressed {
                    stage: "runtime.ready".into(),
                },
            ),
        ];
        assert!(
            fold_operation_events(&after_terminal)
                .unwrap_err()
                .to_string()
                .contains("terminal event")
        );
    }

    #[test]
    fn future_schema_is_rejected_before_use() {
        let error = StoreSchemaInfoV1 {
            schema_version: CURRENT_STORE_SCHEMA_VERSION + 1,
            min_reader_version: CURRENT_STORE_READER_VERSION + 1,
            min_writer_version: CURRENT_STORE_WRITER_VERSION + 1,
        }
        .validate_for_current_host()
        .unwrap_err();

        assert!(matches!(
            error,
            DomainStoreErrorV1::Compatibility {
                code: "reader_too_old",
                ..
            }
        ));
    }
}
