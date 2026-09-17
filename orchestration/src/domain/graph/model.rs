use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_NODES: usize = 64;
pub const MAX_EDGES: usize = 256;
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_DEFINITION_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinition {
    pub schema_version: u16,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNode {
    pub node_id: String,
    pub name: String,
    pub action: ActionRef,
    pub inputs: BTreeMap<String, InputBinding>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRef {
    pub action_id: String,
    pub version: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowEdge {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InputBinding {
    Literal { value: Value },
    Output { node_id: String, field: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Json,
}

impl FieldType {
    pub fn accepts(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Number => value.is_number(),
            Self::Boolean => value.is_boolean(),
            Self::Json => true,
        }
    }

    pub(crate) fn accepts_type(self, source: Self) -> bool {
        self == Self::Json || self == source
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldContract {
    pub value_type: FieldType,
    pub required: bool,
    pub accepts_output: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionContract {
    pub action: ActionRef,
    pub inputs: BTreeMap<String, FieldContract>,
    pub outputs: BTreeMap<String, FieldContract>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl GraphIssue {
    pub(crate) fn new(code: &str, node: Option<&str>, field: Option<&str>) -> Self {
        Self {
            code: code.into(),
            node_id: node.map(str::to_owned),
            field: field.map(str::to_owned),
        }
    }
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

impl WorkflowDefinition {
    /// Drafts may contain unresolved mappings. Structural bounds still apply
    /// before persistence; activation performs contract and dependency checks.
    pub fn validate_draft(&self) -> Result<(), GraphIssue> {
        if self.schema_version != 1 {
            return Err(GraphIssue::new("schema_unsupported", None, None));
        }
        if self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return Err(GraphIssue::new("graph_too_large", None, None));
        }
        if serde_json::to_vec(self).map_or(true, |value| value.len() > MAX_DEFINITION_BYTES) {
            return Err(GraphIssue::new("graph_too_large", None, None));
        }
        let mut identifiers = std::collections::BTreeSet::new();
        for node in &self.nodes {
            if !valid_id(&node.node_id) || !identifiers.insert(&node.node_id) {
                return Err(GraphIssue::new(
                    "node_id_invalid",
                    Some(&node.node_id),
                    None,
                ));
            }
            if node.name.trim().is_empty()
                || node.name.len() > 256
                || node.name.chars().any(char::is_control)
            {
                return Err(GraphIssue::new(
                    "node_name_invalid",
                    Some(&node.node_id),
                    None,
                ));
            }
            if !valid_id(&node.action.action_id)
                || node.action.version == 0
                || node.inputs.len() > 32
            {
                return Err(GraphIssue::new("action_invalid", Some(&node.node_id), None));
            }
            for (field, binding) in &node.inputs {
                let valid = valid_id(field)
                    && match binding {
                        InputBinding::Literal { value } => serde_json::to_vec(value)
                            .is_ok_and(|bytes| bytes.len() <= MAX_VALUE_BYTES),
                        InputBinding::Output { node_id, field } => {
                            valid_id(node_id) && valid_id(field)
                        }
                    };
                if !valid {
                    return Err(GraphIssue::new(
                        "input_invalid",
                        Some(&node.node_id),
                        Some(field),
                    ));
                }
            }
        }
        if self
            .edges
            .iter()
            .any(|edge| !valid_id(&edge.source) || !valid_id(&edge.target))
        {
            return Err(GraphIssue::new("edge_invalid", None, None));
        }
        Ok(())
    }
}
