use std::{error::Error, fmt};

use crate::{
    AgentIntegrationIdV2, AgentNativePluginCliCommandV2, AgentNativePluginCliPlanV2,
    OperationEventIdV1, OperationIdV1, PluginApplyJournalErrorV2, PluginApplyJournalEventBodyV2,
    PluginApplyJournalEventV2, PluginApplyOperationKindV2, PluginApplyStepV2, PluginIdV2,
    PluginNativePhysicalTargetBindingV2, PluginTargetStateDigestV2, PluginVersionV2,
    fold_plugin_apply_journal,
};

pub struct PluginApplyStartRequestV2<'a> {
    pub operation_id: &'a OperationIdV1,
    pub idempotency_key: &'a str,
    pub plugin_id: &'a PluginIdV2,
    pub plugin_version: &'a PluginVersionV2,
    pub integration_id: &'a AgentIntegrationIdV2,
    pub target_bindings: &'a [PluginNativePhysicalTargetBindingV2],
    pub operation_kind: PluginApplyOperationKindV2,
    pub plan: &'a AgentNativePluginCliPlanV2,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginApplyStartErrorV2 {
    MissingCommand { command: &'static str },
    DuplicateCommand { command: &'static str },
    InvalidCommandOrder,
    EventIdentity,
    Journal(PluginApplyJournalErrorV2),
}

impl fmt::Display for PluginApplyStartErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingCommand { command } => {
                write!(formatter, "plugin apply plan is missing {command}")
            }
            Self::DuplicateCommand { command } => {
                write!(formatter, "plugin apply plan contains duplicate {command}")
            }
            Self::InvalidCommandOrder => {
                formatter.write_str("plugin apply mutation commands are in an unsafe order")
            }
            Self::EventIdentity => {
                formatter.write_str("plugin apply start event identity is invalid")
            }
            Self::Journal(error) => write!(formatter, "plugin apply start is invalid: {error}"),
        }
    }
}

impl Error for PluginApplyStartErrorV2 {}

pub fn create_plugin_apply_started_event(
    request: PluginApplyStartRequestV2<'_>,
) -> Result<PluginApplyJournalEventV2, PluginApplyStartErrorV2> {
    let commands = lifecycle_commands(&request)?;
    let steps = commands
        .into_iter()
        .map(|command| PluginApplyStepV2 {
            integration_id: request.integration_id.clone(),
            adapter: request.plan.adapter.clone(),
            executable: request.plan.executable.clone(),
            cli_version: request.plan.cli_version.clone(),
            selector: request.plan.selector.clone(),
            registration_target: request.plan.registration_target.clone(),
            command: command.clone(),
        })
        .collect();
    let identity = PluginTargetStateDigestV2::sha256(format!(
        "dure-plugin-apply-start/v2\0{}",
        request.operation_id.as_str()
    ));
    let event_id = OperationEventIdV1::new(format!(
        "plugin-start-{}",
        identity
            .as_str()
            .strip_prefix("sha256:")
            .expect("target digests always have a sha256 prefix")
    ))
    .map_err(|_| PluginApplyStartErrorV2::EventIdentity)?;
    let event = PluginApplyJournalEventV2 {
        event_id,
        operation_id: request.operation_id.clone(),
        sequence: 1,
        body: PluginApplyJournalEventBodyV2::Started {
            idempotency_key: request.idempotency_key.to_owned(),
            plugin_id: request.plugin_id.clone(),
            plugin_version: request.plugin_version.clone(),
            compensation_for: None,
            target_bindings: Some(request.target_bindings.to_vec()),
            operation_kind: request.operation_kind,
            steps,
        },
        recorded_at_ms: request.recorded_at_ms,
    };
    fold_plugin_apply_journal(std::slice::from_ref(&event))
        .map_err(PluginApplyStartErrorV2::Journal)?;
    Ok(event)
}

fn lifecycle_commands<'a>(
    request: &'a PluginApplyStartRequestV2<'_>,
) -> Result<Vec<&'a AgentNativePluginCliCommandV2>, PluginApplyStartErrorV2> {
    let expected = match request.operation_kind {
        PluginApplyOperationKindV2::Install => [
            MutationCommand::AddMarketplace,
            MutationCommand::InstallPlugin,
        ],
        PluginApplyOperationKindV2::Uninstall => [
            MutationCommand::RemovePlugin,
            MutationCommand::RemoveMarketplace,
        ],
    };
    let mut selected = Vec::with_capacity(expected.len());
    let mut previous_index = None;
    for expected_command in expected {
        let matches = request
            .plan
            .commands
            .iter()
            .enumerate()
            .filter(|(_, command)| expected_command.matches(command))
            .collect::<Vec<_>>();
        let (index, command) = match matches.as_slice() {
            [] => {
                return Err(PluginApplyStartErrorV2::MissingCommand {
                    command: expected_command.name(),
                });
            }
            [entry] => *entry,
            _ => {
                return Err(PluginApplyStartErrorV2::DuplicateCommand {
                    command: expected_command.name(),
                });
            }
        };
        if previous_index.is_some_and(|previous| previous >= index) {
            return Err(PluginApplyStartErrorV2::InvalidCommandOrder);
        }
        previous_index = Some(index);
        selected.push(command);
    }
    Ok(selected)
}

#[derive(Clone, Copy)]
enum MutationCommand {
    AddMarketplace,
    InstallPlugin,
    RemovePlugin,
    RemoveMarketplace,
}

impl MutationCommand {
    fn matches(self, command: &AgentNativePluginCliCommandV2) -> bool {
        matches!(
            (self, command),
            (
                Self::AddMarketplace,
                AgentNativePluginCliCommandV2::AddMarketplace { .. }
            ) | (
                Self::InstallPlugin,
                AgentNativePluginCliCommandV2::InstallPlugin { .. }
            ) | (
                Self::RemovePlugin,
                AgentNativePluginCliCommandV2::RemovePlugin { .. }
            ) | (
                Self::RemoveMarketplace,
                AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
            )
        )
    }

    const fn name(self) -> &'static str {
        match self {
            Self::AddMarketplace => "add_marketplace",
            Self::InstallPlugin => "install_plugin",
            Self::RemovePlugin => "remove_plugin",
            Self::RemoveMarketplace => "remove_marketplace",
        }
    }
}
