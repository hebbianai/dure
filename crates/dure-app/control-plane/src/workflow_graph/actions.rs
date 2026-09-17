use std::collections::BTreeMap;

use agent_orchestration::domain::graph::{
    ActionContract, ActionRef, CompiledWorkflow, FieldContract, FieldType, GraphIssue,
    InputBinding, WorkflowDefinition,
};

use crate::ServiceState;

pub(super) fn contracts() -> Vec<ActionContract> {
    fn field(value_type: FieldType, required: bool, accepts_output: bool) -> FieldContract {
        FieldContract {
            value_type,
            required,
            accepts_output,
        }
    }
    fn fields<const N: usize>(
        items: [(&str, FieldContract); N],
    ) -> BTreeMap<String, FieldContract> {
        items
            .into_iter()
            .map(|(name, field)| (name.to_owned(), field))
            .collect()
    }
    use FieldType::{Json, Number, String as Text};
    vec![
        ActionContract {
            action: ActionRef {
                action_id: "command".into(),
                version: 1,
            },
            inputs: fields([
                ("script", field(Text, true, false)),
                ("directory", field(Text, false, false)),
                ("projectId", field(Text, false, false)),
                ("stdin", field(Text, false, true)),
                ("timeoutSeconds", field(Number, false, false)),
            ]),
            outputs: fields([
                ("stdout", field(Text, true, false)),
                ("stderr", field(Text, true, false)),
                ("exitCode", field(Number, true, false)),
                ("directory", field(Text, true, false)),
            ]),
        },
        ActionContract {
            action: ActionRef {
                action_id: "agent".into(),
                version: 1,
            },
            inputs: fields([
                ("projectId", field(Text, true, false)),
                ("providerId", field(Text, true, false)),
                ("prompt", field(Text, true, false)),
                ("input", field(Text, false, true)),
                ("executionProfile", field(Json, false, false)),
                ("permissionMode", field(Text, false, false)),
                ("timeoutSeconds", field(Number, false, false)),
            ]),
            outputs: fields([("resultMarkdown", field(Text, true, false))]),
        },
    ]
}

pub(super) async fn compile(
    state: &ServiceState,
    definition: WorkflowDefinition,
) -> Result<CompiledWorkflow, Vec<GraphIssue>> {
    let graph = CompiledWorkflow::parse(definition, &contracts())?;
    let mut issues = Vec::new();
    for node in &graph.definition().nodes {
        let literal = |field: &str| match node.inputs.get(field) {
            Some(InputBinding::Literal { value }) => Some(value),
            _ => None,
        };
        let text = |field: &str| {
            literal(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
        };
        let mut invalid = |code: &str, field: &str| {
            issues.push(GraphIssue {
                code: code.into(),
                node_id: Some(node.node_id.clone()),
                field: Some(field.into()),
            })
        };
        match node.action.action_id.as_str() {
            "command" => {
                if text("script").trim().is_empty()
                    || text("script").len() > 16384
                    || text("script").contains('\0')
                {
                    invalid("command_script_invalid", "script");
                }
                let inputs = node
                    .inputs
                    .iter()
                    .filter_map(|(key, binding)| match binding {
                        InputBinding::Literal { value } => Some((key.clone(), value.clone())),
                        _ => None,
                    })
                    .collect();
                if command_directory(state, &inputs).await.is_none() {
                    invalid("command_directory_invalid", "directory");
                }
                if literal("timeoutSeconds").is_some_and(|value| {
                    value
                        .as_u64()
                        .is_none_or(|seconds| !(1..=300).contains(&seconds))
                }) {
                    invalid("command_timeout_invalid", "timeoutSeconds");
                }
            }
            "agent" => {
                if text("prompt").trim().is_empty() || text("prompt").len() > 16384 {
                    invalid("agent_prompt_invalid", "prompt");
                }
                if !crate::valid_token(text("providerId")) {
                    invalid("agent_provider_invalid", "providerId");
                }
                match crate::projects_catalog(state).await {
                    Ok(catalog) if catalog.project(text("projectId")).is_some() => {}
                    _ => invalid("agent_project_unavailable", "projectId"),
                }
                if literal("executionProfile").is_some_and(|value| {
                    serde_json::from_value::<dure_app::AgentExecutionProfileV1>(value.clone())
                        .is_err()
                }) {
                    invalid("agent_execution_profile_invalid", "executionProfile");
                }
                if literal("permissionMode").is_some_and(|value| {
                    serde_json::from_value::<dure_app::AgentSpawnPermissionModeV1>(value.clone())
                        .is_err()
                }) {
                    invalid("agent_permission_mode_invalid", "permissionMode");
                }
                if literal("timeoutSeconds").is_some_and(|value| {
                    value
                        .as_u64()
                        .is_none_or(|seconds| !(1..=86400).contains(&seconds))
                }) {
                    invalid("agent_timeout_invalid", "timeoutSeconds");
                }
            }
            _ => invalid("action_unsupported", "action"),
        }
    }
    if issues.is_empty() {
        Ok(graph)
    } else {
        Err(issues)
    }
}

pub(super) async fn command_directory(
    state: &ServiceState,
    inputs: &agent_orchestration::domain::graph::ActionValues,
) -> Option<std::path::PathBuf> {
    let text = |field: &str| {
        inputs
            .get(field)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let path = match (text("directory"), text("projectId")) {
        (Some(directory), None) => std::path::PathBuf::from(directory),
        (None, Some(project)) => crate::projects_catalog(state)
            .await
            .ok()?
            .project(project)?
            .root()
            .to_path_buf(),
        _ => return None,
    };
    if !path.is_absolute() || !path.is_dir() {
        return None;
    }
    let directory = std::fs::canonicalize(path).ok()?;
    directory.to_str()?;
    Some(directory)
}
