use std::{error::Error, fmt};

use crate::{
    AgentInstallScopeV2, AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2,
    AgentNativePluginExecutableV2, AgentNativePluginRegistrationTargetV2,
    AgentNativePluginSelectorV2, PhysicalTargetKeyV2, PluginApplyStepV2, PluginResourcePathV2,
    PluginVersionV2,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentNativePluginCliArgumentV2 {
    Literal(String),
    PackageResource(PluginResourcePathV2),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentNativePluginCliEnvironmentV2 {
    CodexHome {
        profile_root_key: PhysicalTargetKeyV2,
    },
    ClaudeHome {
        profile_root_key: PhysicalTargetKeyV2,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentNativePluginCliWorkingDirectoryV2 {
    HostNeutral,
    Workspace {
        workspace_root_key: PhysicalTargetKeyV2,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentNativePluginCliInvocationV2 {
    executable: AgentNativePluginExecutableV2,
    cli_version: PluginVersionV2,
    arguments: Vec<AgentNativePluginCliArgumentV2>,
    environment: Vec<AgentNativePluginCliEnvironmentV2>,
    working_directory: AgentNativePluginCliWorkingDirectoryV2,
    output: AgentNativePluginCliOutputV2,
}

impl AgentNativePluginCliInvocationV2 {
    pub fn executable(&self) -> &AgentNativePluginExecutableV2 {
        &self.executable
    }

    pub fn cli_version(&self) -> &PluginVersionV2 {
        &self.cli_version
    }

    pub fn arguments(&self) -> &[AgentNativePluginCliArgumentV2] {
        &self.arguments
    }

    pub fn environment(&self) -> &[AgentNativePluginCliEnvironmentV2] {
        &self.environment
    }

    pub fn working_directory(&self) -> &AgentNativePluginCliWorkingDirectoryV2 {
        &self.working_directory
    }

    pub fn output(&self) -> &AgentNativePluginCliOutputV2 {
        &self.output
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentNativePluginCliInvocationErrorV2 {
    ExecutableMismatch,
    InvalidRegistrationTarget,
    InvalidScope,
    InvalidOutput,
    MarketplaceMismatch,
    SelectorMismatch,
    PluginDataRemovalForbidden,
}

impl fmt::Display for AgentNativePluginCliInvocationErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ExecutableMismatch => "native plugin executable does not match its adapter",
            Self::InvalidRegistrationTarget => {
                "native plugin command has an invalid registration target"
            }
            Self::InvalidScope => "native plugin command scope does not match its exact target",
            Self::InvalidOutput => "native plugin command requests unsupported output",
            Self::MarketplaceMismatch => {
                "native plugin list marketplace does not match the step selector"
            }
            Self::SelectorMismatch => {
                "native plugin command selector does not match the step selector"
            }
            Self::PluginDataRemovalForbidden => {
                "native plugin removal must preserve persistent plugin data"
            }
        };
        formatter.write_str(message)
    }
}

impl Error for AgentNativePluginCliInvocationErrorV2 {}

pub fn compile_agent_native_plugin_cli_invocation(
    step: &PluginApplyStepV2,
) -> Result<AgentNativePluginCliInvocationV2, AgentNativePluginCliInvocationErrorV2> {
    if !step.executable.matches_adapter(&step.adapter) {
        return Err(AgentNativePluginCliInvocationErrorV2::ExecutableMismatch);
    }
    let (environment, working_directory) = execution_route(step)?;
    let output = command_output(&step.command);
    validate_output(&step.executable, &step.command, output)?;
    let arguments = command_arguments(step)?;
    Ok(AgentNativePluginCliInvocationV2 {
        executable: step.executable.clone(),
        cli_version: step.cli_version.clone(),
        arguments,
        environment,
        working_directory,
        output: output.clone(),
    })
}

fn execution_route(
    step: &PluginApplyStepV2,
) -> Result<
    (
        Vec<AgentNativePluginCliEnvironmentV2>,
        AgentNativePluginCliWorkingDirectoryV2,
    ),
    AgentNativePluginCliInvocationErrorV2,
> {
    match (&step.executable, &step.registration_target) {
        (
            AgentNativePluginExecutableV2::Codex,
            AgentNativePluginRegistrationTargetV2::ManagedProfile { profile_root_key },
        ) => Ok((
            vec![AgentNativePluginCliEnvironmentV2::CodexHome {
                profile_root_key: profile_root_key.clone(),
            }],
            AgentNativePluginCliWorkingDirectoryV2::HostNeutral,
        )),
        (
            AgentNativePluginExecutableV2::Claude,
            AgentNativePluginRegistrationTargetV2::User { profile_root_key },
        ) => Ok((
            vec![AgentNativePluginCliEnvironmentV2::ClaudeHome {
                profile_root_key: profile_root_key.clone(),
            }],
            AgentNativePluginCliWorkingDirectoryV2::HostNeutral,
        )),
        (
            AgentNativePluginExecutableV2::Claude,
            AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key,
                workspace_root_key,
            },
        ) => Ok((
            vec![AgentNativePluginCliEnvironmentV2::ClaudeHome {
                profile_root_key: profile_root_key.clone(),
            }],
            AgentNativePluginCliWorkingDirectoryV2::Workspace {
                workspace_root_key: workspace_root_key.clone(),
            },
        )),
        _ => Err(AgentNativePluginCliInvocationErrorV2::InvalidRegistrationTarget),
    }
}

fn command_output(command: &AgentNativePluginCliCommandV2) -> &AgentNativePluginCliOutputV2 {
    match command {
        AgentNativePluginCliCommandV2::ListMarketplaces { output }
        | AgentNativePluginCliCommandV2::AddMarketplace { output, .. }
        | AgentNativePluginCliCommandV2::RemoveMarketplace { output, .. }
        | AgentNativePluginCliCommandV2::ListPlugins { output, .. }
        | AgentNativePluginCliCommandV2::InstallPlugin { output, .. }
        | AgentNativePluginCliCommandV2::RemovePlugin { output, .. } => output,
    }
}

fn validate_output(
    executable: &AgentNativePluginExecutableV2,
    command: &AgentNativePluginCliCommandV2,
    output: &AgentNativePluginCliOutputV2,
) -> Result<(), AgentNativePluginCliInvocationErrorV2> {
    let expected = match (executable, command) {
        (
            _,
            AgentNativePluginCliCommandV2::ListMarketplaces { .. }
            | AgentNativePluginCliCommandV2::ListPlugins { .. },
        )
        | (AgentNativePluginExecutableV2::Codex, _) => AgentNativePluginCliOutputV2::Json,
        (AgentNativePluginExecutableV2::Claude, _) => AgentNativePluginCliOutputV2::HumanText,
    };
    if output == &expected {
        Ok(())
    } else {
        Err(AgentNativePluginCliInvocationErrorV2::InvalidOutput)
    }
}

fn command_arguments(
    step: &PluginApplyStepV2,
) -> Result<Vec<AgentNativePluginCliArgumentV2>, AgentNativePluginCliInvocationErrorV2> {
    let mut arguments = match &step.command {
        AgentNativePluginCliCommandV2::ListMarketplaces { .. } => {
            literals(&["plugin", "marketplace", "list"])
        }
        AgentNativePluginCliCommandV2::AddMarketplace { source, scope, .. } => {
            validate_scope(step, scope)?;
            let mut arguments = literals(&["plugin", "marketplace", "add"]);
            arguments.push(AgentNativePluginCliArgumentV2::PackageResource(
                source.resource.clone(),
            ));
            arguments
        }
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace, scope, ..
        } => {
            if marketplace != &step.selector.marketplace {
                return Err(AgentNativePluginCliInvocationErrorV2::MarketplaceMismatch);
            }
            validate_scope(step, scope)?;
            let mut arguments = literals(&["plugin", "marketplace", "remove"]);
            arguments.push(literal(marketplace.as_str()));
            arguments
        }
        AgentNativePluginCliCommandV2::ListPlugins {
            marketplace,
            include_available,
            ..
        } => {
            if marketplace != &step.selector.marketplace {
                return Err(AgentNativePluginCliInvocationErrorV2::MarketplaceMismatch);
            }
            let mut arguments = literals(&["plugin", "list"]);
            if step.executable == AgentNativePluginExecutableV2::Codex {
                arguments.extend(literals(&[
                    "--marketplace",
                    step.selector.marketplace.as_str(),
                ]));
            }
            if *include_available {
                arguments.push(literal("--available"));
            }
            arguments
        }
        AgentNativePluginCliCommandV2::InstallPlugin {
            selector, scope, ..
        } => {
            validate_selector(step, selector)?;
            validate_scope(step, scope)?;
            let mut arguments = match step.executable {
                AgentNativePluginExecutableV2::Codex => literals(&["plugin", "add"]),
                AgentNativePluginExecutableV2::Claude => literals(&["plugin", "install"]),
            };
            arguments.push(literal(&selector_argument(selector)));
            arguments
        }
        AgentNativePluginCliCommandV2::RemovePlugin {
            selector,
            scope,
            preserve_data,
            ..
        } => {
            validate_selector(step, selector)?;
            validate_scope(step, scope)?;
            if !preserve_data {
                return Err(AgentNativePluginCliInvocationErrorV2::PluginDataRemovalForbidden);
            }
            let mut arguments = match step.executable {
                AgentNativePluginExecutableV2::Codex => literals(&["plugin", "remove"]),
                AgentNativePluginExecutableV2::Claude => literals(&["plugin", "uninstall"]),
            };
            arguments.push(literal(&selector_argument(selector)));
            arguments
        }
    };

    match step.executable {
        AgentNativePluginExecutableV2::Codex => arguments.push(literal("--json")),
        AgentNativePluginExecutableV2::Claude => match &step.command {
            AgentNativePluginCliCommandV2::AddMarketplace { scope, .. }
            | AgentNativePluginCliCommandV2::RemoveMarketplace { scope, .. }
            | AgentNativePluginCliCommandV2::InstallPlugin { scope, .. }
            | AgentNativePluginCliCommandV2::RemovePlugin { scope, .. } => {
                arguments.extend(literals(&["--scope", scope_argument(scope)?]));
                if matches!(
                    &step.command,
                    AgentNativePluginCliCommandV2::RemovePlugin { .. }
                ) {
                    arguments.push(literal("--keep-data"));
                }
            }
            AgentNativePluginCliCommandV2::ListMarketplaces { .. }
            | AgentNativePluginCliCommandV2::ListPlugins { .. } => {
                arguments.push(literal("--json"));
            }
        },
    }
    Ok(arguments)
}

fn validate_selector(
    step: &PluginApplyStepV2,
    selector: &AgentNativePluginSelectorV2,
) -> Result<(), AgentNativePluginCliInvocationErrorV2> {
    if selector == &step.selector {
        Ok(())
    } else {
        Err(AgentNativePluginCliInvocationErrorV2::SelectorMismatch)
    }
}

fn validate_scope(
    step: &PluginApplyStepV2,
    scope: &AgentInstallScopeV2,
) -> Result<(), AgentNativePluginCliInvocationErrorV2> {
    let valid = matches!(
        (&step.executable, scope, &step.registration_target),
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
    if valid {
        Ok(())
    } else {
        Err(AgentNativePluginCliInvocationErrorV2::InvalidScope)
    }
}

fn scope_argument(
    scope: &AgentInstallScopeV2,
) -> Result<&'static str, AgentNativePluginCliInvocationErrorV2> {
    match scope {
        AgentInstallScopeV2::User => Ok("user"),
        AgentInstallScopeV2::Project => Ok("project"),
        AgentInstallScopeV2::Local => Ok("local"),
        AgentInstallScopeV2::Managed => Err(AgentNativePluginCliInvocationErrorV2::InvalidScope),
    }
}

fn selector_argument(selector: &AgentNativePluginSelectorV2) -> String {
    format!(
        "{}@{}",
        selector.plugin.as_str(),
        selector.marketplace.as_str()
    )
}

fn literals(values: &[&str]) -> Vec<AgentNativePluginCliArgumentV2> {
    values.iter().map(|value| literal(value)).collect()
}

fn literal(value: &str) -> AgentNativePluginCliArgumentV2 {
    AgentNativePluginCliArgumentV2::Literal(value.to_owned())
}
