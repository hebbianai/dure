use serde::{Deserialize, Serialize};

use super::model::{GraphIssue, WorkflowDefinition, valid_id};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowTrigger {
    Manual,
    Schedule {
        expression: String,
        timezone: String,
    },
}

impl WorkflowTrigger {
    pub fn validate(&self) -> Result<(), GraphIssue> {
        if let Self::Schedule {
            expression,
            timezone,
        } = self
        {
            if [expression, timezone].iter().any(|value| {
                value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
            }) {
                return Err(GraphIssue::new("trigger_invalid", None, None));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPutRequest {
    pub schema_version: u16,
    pub workflow_id: String,
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub name: String,
    pub definition: WorkflowDefinition,
    pub trigger: WorkflowTrigger,
}

impl WorkflowPutRequest {
    pub fn validate(&self) -> Result<(), GraphIssue> {
        validate_identity(
            self.schema_version,
            &self.workflow_id,
            &self.idempotency_key,
        )?;
        if self.expected_revision >= i64::MAX as u64
            || self.name.trim().is_empty()
            || self.name.len() > 256
            || self.name.chars().any(char::is_control)
        {
            return Err(GraphIssue::new("workflow_request_invalid", None, None));
        }
        self.definition.validate_draft()?;
        self.trigger.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowChangeRequest {
    pub schema_version: u16,
    pub workflow_id: String,
    pub expected_revision: u64,
    pub idempotency_key: String,
}

impl WorkflowChangeRequest {
    pub fn validate(&self) -> Result<(), GraphIssue> {
        validate_identity(
            self.schema_version,
            &self.workflow_id,
            &self.idempotency_key,
        )?;
        if self.expected_revision == 0 || self.expected_revision >= i64::MAX as u64 {
            return Err(GraphIssue::new("workflow_request_invalid", None, None));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRecord {
    pub schema_version: u16,
    pub workflow_id: String,
    pub revision: u64,
    pub name: String,
    pub definition: WorkflowDefinition,
    pub trigger: WorkflowTrigger,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_version: Option<u64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSummary {
    pub schema_version: u16,
    pub workflow_id: String,
    pub revision: u64,
    pub name: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_version: Option<u64>,
    pub node_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersion {
    pub schema_version: u16,
    pub workflow_id: String,
    pub version: u64,
    pub source_revision: u64,
    pub name: String,
    pub definition: WorkflowDefinition,
    pub trigger: WorkflowTrigger,
    pub digest: String,
    pub created_at_ms: i64,
}

fn validate_identity(schema: u16, workflow: &str, key: &str) -> Result<(), GraphIssue> {
    if schema != 1 || !valid_id(workflow) || !valid_id(key) {
        return Err(GraphIssue::new("workflow_request_invalid", None, None));
    }
    Ok(())
}
