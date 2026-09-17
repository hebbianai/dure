use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    AgentExecutionProfileV1, AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, ProjectIdV1,
    ProviderIdV1, ProviderPermissionModeV1,
};

pub const SCHEDULE_SCHEMA_VERSION_V1: u16 = 1;
pub const SCHEDULE_OCCURRENCE_SCHEMA_VERSION_V2: u16 = 2;
const MAX_NAME_BYTES: usize = 256;
const MAX_EXPRESSION_BYTES: usize = 256;
const MAX_TIMEZONE_BYTES: usize = 128;
const MAX_PROMPT_BYTES: usize = 16 * 1024;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 160;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ScheduleIdV1(String);

impl ScheduleIdV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, ScheduleMutationErrorV1> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 160
            || !value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "scheduleId",
                code: "invalid_identifier",
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ScheduleIdV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ScheduleIdV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRunTemplateV1 {
    pub project_id: ProjectIdV1,
    pub provider_id: ProviderIdV1,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<ProviderPermissionModeV1>,
    #[serde(
        default = "default_execution_profile",
        skip_serializing_if = "is_default_execution_profile"
    )]
    pub execution_profile: AgentExecutionProfileV1,
    #[serde(default, skip_serializing_if = "ScheduleWorkspacePolicyV1::is_default")]
    pub worktree: ScheduleWorkspacePolicyV1,
}

fn default_execution_profile() -> AgentExecutionProfileV1 {
    AgentExecutionProfileV1::ProviderDefault
}

fn is_default_execution_profile(value: &AgentExecutionProfileV1) -> bool {
    *value == AgentExecutionProfileV1::ProviderDefault
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScheduleWorkspacePolicyV1 {
    Dedicated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_commit_sha: Option<String>,
    },
}

impl Default for ScheduleWorkspacePolicyV1 {
    fn default() -> Self {
        Self::Dedicated {
            base_commit_sha: None,
        }
    }
}

impl ScheduleWorkspacePolicyV1 {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

impl ScheduleRunTemplateV1 {
    pub fn validate(&self) -> Result<(), ScheduleMutationErrorV1> {
        self.execution_profile
            .validate()
            .map_err(|_| ScheduleMutationErrorV1::Invalid {
                field: "runTemplate.executionProfile",
                code: "invalid_reference",
            })?;
        let ScheduleWorkspacePolicyV1::Dedicated { base_commit_sha } = &self.worktree;
        if base_commit_sha.as_ref().is_some_and(|sha| {
            !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "runTemplate.worktree.baseCommitSha",
                code: "invalid_commit",
            });
        }
        validate_prompt(&self.prompt)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulePutRequestV1 {
    pub schema_version: u16,
    pub schedule_id: ScheduleIdV1,
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub name: String,
    pub enabled: bool,
    pub expression: String,
    pub timezone: String,
    pub run_template: ScheduleRunTemplateV1,
}

impl SchedulePutRequestV1 {
    pub fn validate(&self) -> Result<(), ScheduleMutationErrorV1> {
        validate_schema(self.schema_version)?;
        validate_text("name", &self.name, MAX_NAME_BYTES)?;
        validate_text("expression", &self.expression, MAX_EXPRESSION_BYTES)?;
        validate_text("timezone", &self.timezone, MAX_TIMEZONE_BYTES)?;
        validate_idempotency_key(&self.idempotency_key)?;
        self.run_template.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDeleteRequestV1 {
    pub schema_version: u16,
    pub schedule_id: ScheduleIdV1,
    pub expected_revision: u64,
    pub idempotency_key: String,
}

impl ScheduleDeleteRequestV1 {
    pub fn validate(&self) -> Result<(), ScheduleMutationErrorV1> {
        validate_schema(self.schema_version)?;
        if self.expected_revision == 0 {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "expectedRevision",
                code: "must_be_positive",
            });
        }
        validate_idempotency_key(&self.idempotency_key)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRecordV1 {
    pub schema_version: u16,
    pub schedule_id: ScheduleIdV1,
    pub revision: u64,
    pub name: String,
    pub enabled: bool,
    pub expression: String,
    pub timezone: String,
    pub run_template: ScheduleRunTemplateV1,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at_ms: Option<i64>,
}

impl ScheduleRecordV1 {
    pub fn validate(&self) -> Result<(), ScheduleMutationErrorV1> {
        validate_schema(self.schema_version)?;
        if self.revision == 0 {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "revision",
                code: "must_be_positive",
            });
        }
        validate_text("name", &self.name, MAX_NAME_BYTES)?;
        validate_text("expression", &self.expression, MAX_EXPRESSION_BYTES)?;
        validate_text("timezone", &self.timezone, MAX_TIMEZONE_BYTES)?;
        validate_timestamp("createdAtMs", self.created_at_ms)?;
        validate_timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.updated_at_ms < self.created_at_ms
            || self
                .deleted_at_ms
                .is_some_and(|deleted_at_ms| deleted_at_ms < self.updated_at_ms)
        {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "timestamps",
                code: "not_monotonic",
            });
        }
        self.run_template.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleLaunchStateV1 {
    Pending,
    Started,
    Failed,
}

impl ScheduleLaunchStateV1 {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Started => "started",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScheduleTriggerV1 {
    Scheduled { scheduled_for_ms: i64 },
    Manual,
}

impl ScheduleTriggerV1 {
    pub fn scheduled_for_ms(&self) -> Option<i64> {
        match self {
            Self::Scheduled { scheduled_for_ms } => Some(*scheduled_for_ms),
            Self::Manual => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRunSummaryV1 {
    pub run_id: String,
    pub task_id: String,
    pub dispatch_id: String,
    pub generation: u64,
    pub workspace_id: String,
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleOccurrenceRecordV2 {
    pub schema_version: u16,
    pub schedule_id: ScheduleIdV1,
    pub schedule_revision: u64,
    pub trigger: ScheduleTriggerV1,
    pub idempotency_key: String,
    pub launch_state: ScheduleLaunchStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<ScheduleRunSummaryV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ScheduleOccurrenceRecordV2 {
    pub fn validate(&self) -> Result<(), ScheduleMutationErrorV1> {
        if self.schema_version != SCHEDULE_OCCURRENCE_SCHEMA_VERSION_V2 {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "schemaVersion",
                code: "unsupported",
            });
        }
        if self.schedule_revision == 0 {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "scheduleRevision",
                code: "must_be_positive",
            });
        }
        if self
            .trigger
            .scheduled_for_ms()
            .is_some_and(|ms| ms < 0 || ms % 60_000 != 0)
        {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "scheduledForMs",
                code: "invalid_minute",
            });
        }
        validate_idempotency_key(&self.idempotency_key)?;
        if self.operation_id.as_deref().is_some_and(invalid_token)
            || self.error_code.as_deref().is_some_and(invalid_token)
        {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "occurrenceOutcome",
                code: "invalid_identifier",
            });
        }
        let valid_outcome = match self.launch_state {
            ScheduleLaunchStateV1::Pending => self.error_code.is_none(),
            ScheduleLaunchStateV1::Started => {
                self.operation_id.is_some() && self.error_code.is_none()
            }
            ScheduleLaunchStateV1::Failed => self.error_code.is_some(),
        };
        if !valid_outcome {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "occurrenceOutcome",
                code: "inconsistent_state",
            });
        }
        validate_timestamp("createdAtMs", self.created_at_ms)?;
        validate_timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.updated_at_ms < self.created_at_ms {
            return Err(ScheduleMutationErrorV1::Invalid {
                field: "timestamps",
                code: "not_monotonic",
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleMutationErrorV1 {
    Invalid {
        field: &'static str,
        code: &'static str,
    },
    NotFound,
    Deleted,
    RevisionConflict {
        expected: u64,
        actual: Option<u64>,
    },
    IdempotencyConflict,
    Storage {
        code: &'static str,
    },
}

impl fmt::Display for ScheduleMutationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { field, code } => write!(formatter, "invalid {field}: {code}"),
            Self::NotFound => formatter.write_str("schedule was not found"),
            Self::Deleted => formatter.write_str("schedule was deleted"),
            Self::RevisionConflict { expected, actual } => write!(
                formatter,
                "schedule expected revision {expected}, found {}",
                actual.map_or_else(|| "none".into(), |value| value.to_string())
            ),
            Self::IdempotencyConflict => formatter.write_str("schedule idempotency conflict"),
            Self::Storage { code } => write!(formatter, "schedule storage error: {code}"),
        }
    }
}

impl std::error::Error for ScheduleMutationErrorV1 {}

fn validate_schema(schema_version: u16) -> Result<(), ScheduleMutationErrorV1> {
    if schema_version != SCHEDULE_SCHEMA_VERSION_V1 {
        return Err(ScheduleMutationErrorV1::Invalid {
            field: "schemaVersion",
            code: "unsupported",
        });
    }
    Ok(())
}

fn validate_text(
    field: &'static str,
    value: &str,
    maximum_bytes: usize,
) -> Result<(), ScheduleMutationErrorV1> {
    if value.is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control) {
        return Err(ScheduleMutationErrorV1::Invalid {
            field,
            code: "invalid_text",
        });
    }
    Ok(())
}

fn validate_prompt(value: &str) -> Result<(), ScheduleMutationErrorV1> {
    if value.is_empty()
        || value.len() > MAX_PROMPT_BYTES
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(ScheduleMutationErrorV1::Invalid {
            field: "runTemplate.prompt",
            code: "invalid_text",
        });
    }
    Ok(())
}

fn validate_idempotency_key(value: &str) -> Result<(), ScheduleMutationErrorV1> {
    if invalid_token(value) {
        return Err(ScheduleMutationErrorV1::Invalid {
            field: "idempotencyKey",
            code: "invalid_identifier",
        });
    }
    Ok(())
}

fn invalid_token(value: &str) -> bool {
    value.is_empty()
        || value.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn validate_timestamp(field: &'static str, value: i64) -> Result<(), ScheduleMutationErrorV1> {
    if value < 0 {
        return Err(ScheduleMutationErrorV1::Invalid {
            field,
            code: "must_be_non_negative",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SchedulePutRequestV1 {
        SchedulePutRequestV1 {
            schema_version: 1,
            schedule_id: ScheduleIdV1::new("morning-triage").unwrap(),
            expected_revision: 0,
            idempotency_key: "schedule-put-1".into(),
            name: "Morning triage".into(),
            enabled: true,
            expression: "0 9 * * 1-5".into(),
            timezone: "Asia/Seoul".into(),
            run_template: ScheduleRunTemplateV1 {
                project_id: ProjectIdV1::new("dure").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                prompt: "triage ready work".into(),
                model: None,
                effort: None,
                permission_mode: Some(ProviderPermissionModeV1::Default),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                worktree: ScheduleWorkspacePolicyV1::default(),
            },
        }
    }

    #[test]
    fn validates_one_provider_neutral_run_template() {
        assert_eq!(request().validate(), Ok(()));
    }

    #[test]
    fn rejects_control_bytes_and_unbounded_prompts() {
        let mut invalid = request();
        invalid.run_template.prompt = "secret\u{0}".into();
        assert!(matches!(
            invalid.validate(),
            Err(ScheduleMutationErrorV1::Invalid {
                field: "runTemplate.prompt",
                ..
            })
        ));
    }
}
