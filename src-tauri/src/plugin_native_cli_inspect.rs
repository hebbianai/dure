use dure_app::{
    compile_agent_native_plugin_cli_invocation, AgentInstallScopeV2, AgentNativePluginCliCommandV2,
    AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginRegistrationTargetV2, PluginApplyStepV2,
    PluginNativeCommandOutcomeV2, PluginNativeStateObservationV2,
};
use std::{error::Error, fmt};

use crate::plugin_native_cli::{
    execute_prepared_plugin_native_cli_command, prepare_plugin_native_cli_command,
    resolve_plugin_native_package_resource, resolve_plugin_native_physical_target,
    PluginNativeCliExecution, PluginNativeCliHostContext, PluginNativeCliPrepareError,
    PreparedPluginNativeCliCommand,
};
use crate::plugin_native_cli_state::{
    inspect_claude_plugin_target_state, inspect_codex_plugin_target_state,
    ClaudePluginTargetRoot, ClaudePluginTargetStateInspection, PluginNativeCliStateError,
};
use crate::plugin_native_target_binding::{
    execute_bound_plugin_native_cli_command, prepare_bound_plugin_native_cli_command,
    PluginNativeTargetBindingHostError, PluginNativeTargetLeases,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeCliInspectError {
    ReadOnlyStep,
    InvalidRegistrationTarget,
    Invocation,
    Preparation(PluginNativeCliPrepareError),
    TargetBinding(PluginNativeTargetBindingHostError),
    MarketplaceListFailed(PluginNativeCommandOutcomeV2),
    PluginListFailed(PluginNativeCommandOutcomeV2),
    State(PluginNativeCliStateError),
    UnstableState,
}

impl fmt::Display for PluginNativeCliInspectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ReadOnlyStep => "native plugin inspection requires a mutation step",
            Self::InvalidRegistrationTarget => {
                "native plugin inspection has an invalid registration target"
            }
            Self::Invocation => "native plugin inspection command is invalid",
            Self::Preparation(_) => "native plugin inspection target is unavailable",
            Self::TargetBinding(_) => "native plugin inspection target binding changed",
            Self::MarketplaceListFailed(_) => "native plugin marketplace inspection failed",
            Self::PluginListFailed(_) => "native plugin installation inspection failed",
            Self::State(_) => "native plugin CLI returned inconsistent state",
            Self::UnstableState => "native plugin state changed during inspection",
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeCliInspectError {}

#[derive(Clone, Copy)]
pub struct PluginNativeCliInspection<'a> {
    pub step: &'a PluginApplyStepV2,
    pub marketplace_source: &'a AgentNativePluginMarketplaceSourceV2,
    pub host: &'a PluginNativeCliHostContext<'a>,
}

pub fn inspect_bound_plugin_native_cli_target(
    inspection: PluginNativeCliInspection<'_>,
    leases: &PluginNativeTargetLeases,
) -> Result<PluginNativeStateObservationV2, PluginNativeCliInspectError> {
    inspect_with(
        inspection,
        Some(leases),
        execute_prepared_plugin_native_cli_command,
    )
}

fn inspect_with(
    inspection: PluginNativeCliInspection<'_>,
    leases: Option<&PluginNativeTargetLeases>,
    mut execute: impl FnMut(&PreparedPluginNativeCliCommand) -> PluginNativeCliExecution,
) -> Result<PluginNativeStateObservationV2, PluginNativeCliInspectError> {
    let first = inspect_once(&inspection, leases, &mut execute)?;
    let second = inspect_once(&inspection, leases, &mut execute)?;
    if first != second {
        return Err(PluginNativeCliInspectError::UnstableState);
    }
    Ok(first)
}

fn inspect_once(
    inspection: &PluginNativeCliInspection<'_>,
    leases: Option<&PluginNativeTargetLeases>,
    execute: &mut impl FnMut(&PreparedPluginNativeCliCommand) -> PluginNativeCliExecution,
) -> Result<PluginNativeStateObservationV2, PluginNativeCliInspectError> {
    let scope =
        command_scope(&inspection.step.command).ok_or(PluginNativeCliInspectError::ReadOnlyStep)?;
    let expected_source = resolve_plugin_native_package_resource(
        inspection.host,
        &inspection.marketplace_source.resource,
    )
    .map_err(PluginNativeCliInspectError::Preparation)?;
    let marketplace_step = inspection_step(
        inspection.step,
        AgentNativePluginCliCommandV2::ListMarketplaces {
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    let plugin_step = inspection_step(
        inspection.step,
        AgentNativePluginCliCommandV2::ListPlugins {
            marketplace: inspection.step.selector.marketplace.clone(),
            include_available: true,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    let marketplace = execute_inspection(&marketplace_step, inspection.host, leases, execute).map_err(
        |error| match error {
            InspectionCommandError::Invocation => PluginNativeCliInspectError::Invocation,
            InspectionCommandError::Preparation(error) => {
                PluginNativeCliInspectError::Preparation(error)
            }
            InspectionCommandError::TargetBinding(error) => {
                PluginNativeCliInspectError::TargetBinding(error)
            }
            InspectionCommandError::Execution(outcome) => {
                PluginNativeCliInspectError::MarketplaceListFailed(outcome)
            }
        },
    )?;
    let plugins =
        execute_inspection(&plugin_step, inspection.host, leases, execute).map_err(
            |error| match error {
                InspectionCommandError::Invocation => PluginNativeCliInspectError::Invocation,
                InspectionCommandError::Preparation(error) => {
                    PluginNativeCliInspectError::Preparation(error)
                }
                InspectionCommandError::TargetBinding(error) => {
                    PluginNativeCliInspectError::TargetBinding(error)
                }
                InspectionCommandError::Execution(outcome) => {
                    PluginNativeCliInspectError::PluginListFailed(outcome)
                }
            },
        )?;
    let state = match inspection.step.executable {
        AgentNativePluginExecutableV2::Codex => inspect_codex_plugin_target_state(
            &marketplace,
            &plugins,
            &inspection.step.selector.marketplace,
            &inspection.step.selector.plugin,
            &expected_source,
            scope,
        ),
        AgentNativePluginExecutableV2::Claude => {
            let (home_key, workspace_key) = match &inspection.step.registration_target {
                AgentNativePluginRegistrationTargetV2::User { profile_root_key } => {
                    (profile_root_key, None)
                }
                AgentNativePluginRegistrationTargetV2::Workspace {
                    profile_root_key,
                    workspace_root_key,
                } => (profile_root_key, Some(workspace_root_key)),
                AgentNativePluginRegistrationTargetV2::ManagedProfile { .. } => {
                    return Err(PluginNativeCliInspectError::InvalidRegistrationTarget);
                }
            };
            match leases {
                Some(leases) => {
                    let home = leases
                        .directory(inspection.host, home_key)
                        .map_err(PluginNativeCliInspectError::TargetBinding)?;
                    let workspace = workspace_key
                        .map(|key| {
                            leases
                                .directory(inspection.host, key)
                                .map(ClaudePluginTargetRoot::Directory)
                                .map_err(PluginNativeCliInspectError::TargetBinding)
                        })
                        .transpose()?;
                    inspect_claude_plugin_target_state(ClaudePluginTargetStateInspection {
                        marketplace_output: &marketplace,
                        plugin_output: &plugins,
                        marketplace: &inspection.step.selector.marketplace,
                        plugin: &inspection.step.selector.plugin,
                        expected_source: &expected_source,
                        scope,
                        home_root: ClaudePluginTargetRoot::Directory(home),
                        workspace_root: workspace,
                    })
                }
                None => {
                    let home = resolve_plugin_native_physical_target(inspection.host, home_key)
                        .map_err(PluginNativeCliInspectError::Preparation)?;
                    let workspace = workspace_key
                        .map(|key| {
                            resolve_plugin_native_physical_target(inspection.host, key)
                                .map_err(PluginNativeCliInspectError::Preparation)
                        })
                        .transpose()?;
                    inspect_claude_plugin_target_state(ClaudePluginTargetStateInspection {
                        marketplace_output: &marketplace,
                        plugin_output: &plugins,
                        marketplace: &inspection.step.selector.marketplace,
                        plugin: &inspection.step.selector.plugin,
                        expected_source: &expected_source,
                        scope,
                        home_root: ClaudePluginTargetRoot::Path(&home),
                        workspace_root: workspace
                            .as_deref()
                            .map(ClaudePluginTargetRoot::Path),
                    })
                }
            }
        }
    }
    .map_err(PluginNativeCliInspectError::State)?;
    Ok(PluginNativeStateObservationV2::new(state))
}

enum InspectionCommandError {
    Invocation,
    Preparation(PluginNativeCliPrepareError),
    TargetBinding(PluginNativeTargetBindingHostError),
    Execution(PluginNativeCommandOutcomeV2),
}

fn execute_inspection(
    step: &PluginApplyStepV2,
    host: &PluginNativeCliHostContext<'_>,
    leases: Option<&PluginNativeTargetLeases>,
    execute: &mut impl FnMut(&PreparedPluginNativeCliCommand) -> PluginNativeCliExecution,
) -> Result<Vec<u8>, InspectionCommandError> {
    let invocation = compile_agent_native_plugin_cli_invocation(step)
        .map_err(|_| InspectionCommandError::Invocation)?;
    let execution = match leases {
        Some(leases) => {
            let prepared = prepare_bound_plugin_native_cli_command(&invocation, host, leases)
                .map_err(InspectionCommandError::TargetBinding)?;
            execute_bound_plugin_native_cli_command(&prepared)
                .map_err(InspectionCommandError::TargetBinding)?
        }
        None => {
            let prepared = prepare_plugin_native_cli_command(&invocation, host)
                .map_err(InspectionCommandError::Preparation)?;
            execute(&prepared)
        }
    };
    if execution.outcome() != &PluginNativeCommandOutcomeV2::Succeeded {
        return Err(InspectionCommandError::Execution(
            execution.outcome().clone(),
        ));
    }
    Ok(execution.stdout().to_vec())
}

fn inspection_step(
    source: &PluginApplyStepV2,
    command: AgentNativePluginCliCommandV2,
) -> PluginApplyStepV2 {
    let mut step = source.clone();
    step.command = command;
    step
}

fn command_scope(command: &AgentNativePluginCliCommandV2) -> Option<&AgentInstallScopeV2> {
    match command {
        AgentNativePluginCliCommandV2::AddMarketplace { scope, .. }
        | AgentNativePluginCliCommandV2::RemoveMarketplace { scope, .. }
        | AgentNativePluginCliCommandV2::InstallPlugin { scope, .. }
        | AgentNativePluginCliCommandV2::RemovePlugin { scope, .. } => Some(scope),
        AgentNativePluginCliCommandV2::ListMarketplaces { .. }
        | AgentNativePluginCliCommandV2::ListPlugins { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{
        AgentAdapterIdV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
        AgentNativePluginNameV2, AgentNativePluginSelectorV2, PhysicalTargetKeyV2,
        PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2, PluginResourcePathV2,
        PluginVersionV2,
    };
    use std::collections::BTreeMap;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn executable(path: &Path) {
        fs::write(path, b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    fn selector() -> AgentNativePluginSelectorV2 {
        AgentNativePluginSelectorV2 {
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        }
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        executable: PathBuf,
        package: PathBuf,
        source: PathBuf,
        neutral: PathBuf,
        workspace: PathBuf,
        profile_key: PhysicalTargetKeyV2,
        workspace_key: PhysicalTargetKeyV2,
        targets: BTreeMap<PhysicalTargetKeyV2, PathBuf>,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let executable_path = temp.path().join("agent");
            let package = temp.path().join("package");
            let source = package.join("agents/codex");
            let neutral = temp.path().join("neutral");
            let profile = temp.path().join("profile");
            let workspace = temp.path().join("workspace");
            executable(&executable_path);
            fs::create_dir_all(&source).unwrap();
            for directory in [&neutral, &profile, &workspace] {
                fs::create_dir(directory).unwrap();
            }
            let profile_key = PhysicalTargetKeyV2::new("profile").unwrap();
            let workspace_key = PhysicalTargetKeyV2::new("workspace").unwrap();
            let targets = BTreeMap::from([
                (profile_key.clone(), profile.clone()),
                (workspace_key.clone(), workspace.clone()),
            ]);
            Self {
                _temp: temp,
                executable: executable_path,
                package,
                source,
                neutral,
                workspace,
                profile_key,
                workspace_key,
                targets,
            }
        }

        fn source(&self) -> AgentNativePluginMarketplaceSourceV2 {
            AgentNativePluginMarketplaceSourceV2 {
                resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
            }
        }
    }

    fn step(
        executable: AgentNativePluginExecutableV2,
        target: AgentNativePluginRegistrationTargetV2,
        scope: AgentInstallScopeV2,
    ) -> PluginApplyStepV2 {
        PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("dure.beads").unwrap(),
            adapter: AgentAdapterIdV2::new(executable.as_str()).unwrap(),
            executable,
            cli_version: PluginVersionV2::new("1.0.0").unwrap(),
            selector: selector(),
            registration_target: target,
            command: AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector(),
                scope,
                output: AgentNativePluginCliOutputV2::HumanText,
            },
        }
    }

    fn success(stdout: String) -> PluginNativeCliExecution {
        PluginNativeCliExecution::captured(
            PluginNativeCommandOutcomeV2::Succeeded,
            stdout.into_bytes(),
        )
    }

    #[test]
    fn codex_inspection_composes_exact_list_outputs_in_the_managed_profile() {
        let fixture = Fixture::new();
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let step = step(
            AgentNativePluginExecutableV2::Codex,
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: fixture.profile_key.clone(),
            },
            AgentInstallScopeV2::Managed,
        );
        let source = fixture.source();
        let host = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &fixture.executable,
            executable_version: &version,
            package_root: &fixture.package,
            neutral_working_directory: &fixture.neutral,
            physical_targets: &fixture.targets,
        };
        let mut calls = 0;
        let observation = inspect_with(
            PluginNativeCliInspection {
                step: &step,
                marketplace_source: &source,
                host: &host,
            },
            None,
            |prepared| {
                calls += 1;
                let arguments = prepared.command().arguments();
                assert_eq!(arguments[0], OsStr::new("plugin"));
                if arguments[1] == OsStr::new("marketplace") {
                    success(
                        serde_json::json!({
                            "marketplaces": [{
                                "name": "dure-bundled",
                                "marketplaceSource": {
                                    "sourceType": "local",
                                    "source": fixture.source,
                                },
                            }],
                        })
                        .to_string(),
                    )
                } else {
                    success(
                        serde_json::json!({
                            "installed": [{
                                "pluginId": "dure-beads@dure-bundled",
                                "version": "1.0.0",
                                "installed": true,
                                "enabled": true,
                            }],
                        })
                        .to_string(),
                    )
                }
            },
        )
        .unwrap();

        assert_eq!(calls, 4);
        assert!(observation.has_valid_digest());
        assert!(matches!(
            observation.state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Managed,
                ..
            }
        ));
        assert!(matches!(
            observation.state.installation,
            PluginNativeInstallationStateV2::Installed {
                scope: AgentInstallScopeV2::Managed,
                ..
            }
        ));
    }

    #[test]
    fn claude_inspection_uses_the_exact_workspace_scope_declaration() {
        let fixture = Fixture::new();
        let settings_directory = fixture.workspace.join(".claude");
        fs::create_dir(&settings_directory).unwrap();
        fs::write(
            settings_directory.join("settings.local.json"),
            serde_json::json!({
                "extraKnownMarketplaces": {
                    "dure-bundled": {
                        "source": {
                            "source": "directory",
                            "path": fixture.source,
                        },
                    },
                },
            })
            .to_string(),
        )
        .unwrap();
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let step = step(
            AgentNativePluginExecutableV2::Claude,
            AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key: fixture.profile_key.clone(),
                workspace_root_key: fixture.workspace_key.clone(),
            },
            AgentInstallScopeV2::Local,
        );
        let source = fixture.source();
        let host = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Claude,
            executable_path: &fixture.executable,
            executable_version: &version,
            package_root: &fixture.package,
            neutral_working_directory: &fixture.neutral,
            physical_targets: &fixture.targets,
        };
        let observation = inspect_with(
            PluginNativeCliInspection {
                step: &step,
                marketplace_source: &source,
                host: &host,
            },
            None,
            |prepared| {
                let arguments = prepared.command().arguments();
                if arguments[1] == OsStr::new("marketplace") {
                    success(
                        serde_json::json!([{
                            "name": "dure-bundled",
                            "source": "directory",
                            "path": fixture.source,
                        }])
                        .to_string(),
                    )
                } else {
                    success(
                        serde_json::json!({
                            "installed": [{
                                "id": "dure-beads@dure-bundled",
                                "version": "1.0.0",
                                "scope": "local",
                                "enabled": true,
                                "projectPath": fixture.workspace,
                            }],
                        })
                        .to_string(),
                    )
                }
            },
        )
        .unwrap();

        assert!(observation.has_valid_digest());
        assert!(matches!(
            observation.state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));
        assert!(matches!(
            observation.state.installation,
            PluginNativeInstallationStateV2::Installed {
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));
    }

    #[test]
    fn inspection_stops_after_a_failed_marketplace_list() {
        let fixture = Fixture::new();
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let step = step(
            AgentNativePluginExecutableV2::Codex,
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: fixture.profile_key.clone(),
            },
            AgentInstallScopeV2::Managed,
        );
        let source = fixture.source();
        let host = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &fixture.executable,
            executable_version: &version,
            package_root: &fixture.package,
            neutral_working_directory: &fixture.neutral,
            physical_targets: &fixture.targets,
        };
        let mut calls = 0;
        let error = inspect_with(
            PluginNativeCliInspection {
                step: &step,
                marketplace_source: &source,
                host: &host,
            },
            None,
            |_| {
                calls += 1;
                PluginNativeCliExecution::captured(
                    PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(2) },
                    b"ignored provider output".to_vec(),
                )
            },
        )
        .unwrap_err();

        assert_eq!(calls, 1);
        assert_eq!(
            error,
            PluginNativeCliInspectError::MarketplaceListFailed(
                PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(2) }
            )
        );
    }

    #[test]
    fn inspection_rejects_two_different_consecutive_snapshots() {
        let fixture = Fixture::new();
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let step = step(
            AgentNativePluginExecutableV2::Codex,
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: fixture.profile_key.clone(),
            },
            AgentInstallScopeV2::Managed,
        );
        let source = fixture.source();
        let host = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &fixture.executable,
            executable_version: &version,
            package_root: &fixture.package,
            neutral_working_directory: &fixture.neutral,
            physical_targets: &fixture.targets,
        };
        let mut calls = 0;
        let error = inspect_with(
            PluginNativeCliInspection {
                step: &step,
                marketplace_source: &source,
                host: &host,
            },
            None,
            |prepared| {
                calls += 1;
                if prepared.command().arguments()[1] == OsStr::new("marketplace") {
                    success(
                        serde_json::json!({
                            "marketplaces": [{
                                "name": "dure-bundled",
                                "marketplaceSource": {
                                    "sourceType": "local",
                                    "source": fixture.source,
                                },
                            }],
                        })
                        .to_string(),
                    )
                } else {
                    success(
                        serde_json::json!({
                            "installed": [{
                                "pluginId": "dure-beads@dure-bundled",
                                "version": if calls == 2 { "1.0.0" } else { "1.1.0" },
                                "installed": true,
                                "enabled": true,
                            }],
                        })
                        .to_string(),
                    )
                }
            },
        )
        .unwrap_err();

        assert_eq!(calls, 4);
        assert_eq!(error, PluginNativeCliInspectError::UnstableState);
    }
}
