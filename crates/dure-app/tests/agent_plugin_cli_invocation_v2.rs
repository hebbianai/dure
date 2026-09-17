use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliArgumentV2, AgentNativePluginCliCommandV2,
    AgentNativePluginCliEnvironmentV2, AgentNativePluginCliInvocationErrorV2,
    AgentNativePluginCliOutputV2, AgentNativePluginCliWorkingDirectoryV2,
    AgentNativePluginExecutableV2, AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PhysicalTargetKeyV2,
    PluginApplyStepV2, PluginResourcePathV2, PluginVersionV2,
    compile_agent_native_plugin_cli_invocation,
};

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn step(
    executable: AgentNativePluginExecutableV2,
    target: AgentNativePluginRegistrationTargetV2,
    command: AgentNativePluginCliCommandV2,
) -> PluginApplyStepV2 {
    PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new(executable.as_str()).unwrap(),
        adapter: AgentAdapterIdV2::new(executable.as_str()).unwrap(),
        executable,
        cli_version: PluginVersionV2::new("1.2.3").unwrap(),
        selector: selector(),
        registration_target: target,
        command,
    }
}

fn literals(invocation: &[AgentNativePluginCliArgumentV2]) -> Vec<&str> {
    invocation
        .iter()
        .map(|argument| match argument {
            AgentNativePluginCliArgumentV2::Literal(value) => value.as_str(),
            AgentNativePluginCliArgumentV2::PackageResource(resource) => resource.as_str(),
        })
        .collect()
}

#[test]
fn codex_invocations_route_to_the_managed_profile_without_shell_arguments() {
    let target = AgentNativePluginRegistrationTargetV2::ManagedProfile {
        profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
    };
    let install = step(
        AgentNativePluginExecutableV2::Codex,
        target.clone(),
        AgentNativePluginCliCommandV2::InstallPlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    let invocation = compile_agent_native_plugin_cli_invocation(&install).unwrap();

    assert_eq!(
        literals(invocation.arguments()),
        ["plugin", "add", "dure-beads@dure-bundled", "--json"]
    );
    assert_eq!(
        invocation.environment(),
        [AgentNativePluginCliEnvironmentV2::CodexHome {
            profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
        }]
    );
    assert_eq!(
        invocation.working_directory(),
        &AgentNativePluginCliWorkingDirectoryV2::HostNeutral
    );

    let add_marketplace = step(
        AgentNativePluginExecutableV2::Codex,
        target,
        AgentNativePluginCliCommandV2::AddMarketplace {
            source: AgentNativePluginMarketplaceSourceV2 {
                resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
            },
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    let invocation = compile_agent_native_plugin_cli_invocation(&add_marketplace).unwrap();
    assert_eq!(
        literals(invocation.arguments()),
        ["plugin", "marketplace", "add", "./agents/codex", "--json"]
    );
    assert!(matches!(
        invocation.arguments()[3],
        AgentNativePluginCliArgumentV2::PackageResource(_)
    ));
}

#[test]
fn codex_list_is_filtered_to_the_exact_marketplace() {
    let invocation = compile_agent_native_plugin_cli_invocation(&step(
        AgentNativePluginExecutableV2::Codex,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
        },
        AgentNativePluginCliCommandV2::ListPlugins {
            marketplace: selector().marketplace,
            include_available: true,
            output: AgentNativePluginCliOutputV2::Json,
        },
    ))
    .unwrap();
    assert_eq!(
        literals(invocation.arguments()),
        [
            "plugin",
            "list",
            "--marketplace",
            "dure-bundled",
            "--available",
            "--json"
        ]
    );
}

#[test]
fn claude_invocations_bind_scope_to_the_workspace_and_preserve_data() {
    let target = AgentNativePluginRegistrationTargetV2::Workspace {
        profile_root_key: PhysicalTargetKeyV2::new("claude-profile").unwrap(),
        workspace_root_key: PhysicalTargetKeyV2::new("workspace-six").unwrap(),
    };
    let uninstall = step(
        AgentNativePluginExecutableV2::Claude,
        target.clone(),
        AgentNativePluginCliCommandV2::RemovePlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Local,
            preserve_data: true,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
    );
    let invocation = compile_agent_native_plugin_cli_invocation(&uninstall).unwrap();

    assert_eq!(
        literals(invocation.arguments()),
        [
            "plugin",
            "uninstall",
            "dure-beads@dure-bundled",
            "--scope",
            "local",
            "--keep-data"
        ]
    );
    assert_eq!(
        invocation.working_directory(),
        &AgentNativePluginCliWorkingDirectoryV2::Workspace {
            workspace_root_key: PhysicalTargetKeyV2::new("workspace-six").unwrap(),
        }
    );
    assert_eq!(
        invocation.environment(),
        [AgentNativePluginCliEnvironmentV2::ClaudeHome {
            profile_root_key: PhysicalTargetKeyV2::new("claude-profile").unwrap(),
        }]
    );

    let remove_marketplace = step(
        AgentNativePluginExecutableV2::Claude,
        target,
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace: selector().marketplace,
            scope: AgentInstallScopeV2::Local,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
    );
    let invocation = compile_agent_native_plugin_cli_invocation(&remove_marketplace).unwrap();
    assert_eq!(
        literals(invocation.arguments()),
        [
            "plugin",
            "marketplace",
            "remove",
            "dure-bundled",
            "--scope",
            "local"
        ]
    );
}

#[test]
fn compiler_rejects_output_selector_scope_and_destructive_removal_drift() {
    let codex_target = AgentNativePluginRegistrationTargetV2::ManagedProfile {
        profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
    };
    let wrong_output = step(
        AgentNativePluginExecutableV2::Codex,
        codex_target.clone(),
        AgentNativePluginCliCommandV2::ListMarketplaces {
            output: AgentNativePluginCliOutputV2::HumanText,
        },
    );
    assert_eq!(
        compile_agent_native_plugin_cli_invocation(&wrong_output),
        Err(AgentNativePluginCliInvocationErrorV2::InvalidOutput)
    );

    let wrong_selector = AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("foreign").unwrap(),
        marketplace: selector().marketplace,
    };
    let install = step(
        AgentNativePluginExecutableV2::Codex,
        codex_target.clone(),
        AgentNativePluginCliCommandV2::InstallPlugin {
            selector: wrong_selector,
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    assert_eq!(
        compile_agent_native_plugin_cli_invocation(&install),
        Err(AgentNativePluginCliInvocationErrorV2::SelectorMismatch)
    );

    let wrong_scope = step(
        AgentNativePluginExecutableV2::Codex,
        codex_target.clone(),
        AgentNativePluginCliCommandV2::InstallPlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::User,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    assert_eq!(
        compile_agent_native_plugin_cli_invocation(&wrong_scope),
        Err(AgentNativePluginCliInvocationErrorV2::InvalidScope)
    );

    let destructive = step(
        AgentNativePluginExecutableV2::Codex,
        codex_target,
        AgentNativePluginCliCommandV2::RemovePlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Managed,
            preserve_data: false,
            output: AgentNativePluginCliOutputV2::Json,
        },
    );
    assert_eq!(
        compile_agent_native_plugin_cli_invocation(&destructive),
        Err(AgentNativePluginCliInvocationErrorV2::PluginDataRemovalForbidden)
    );
}
