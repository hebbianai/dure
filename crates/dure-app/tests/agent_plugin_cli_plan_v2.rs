use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCapabilityV2, AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2,
    AgentNativePluginCliPlanErrorV2, AgentNativePluginCliPlanRequestV2,
    AgentNativePluginCliProbeV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PhysicalTargetKeyV2,
    PluginResourcePathV2, PluginVersionV2, plan_agent_native_plugin_cli,
};

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn request(
    adapter: &str,
    scope: AgentInstallScopeV2,
    registration_target: AgentNativePluginRegistrationTargetV2,
) -> AgentNativePluginCliPlanRequestV2 {
    AgentNativePluginCliPlanRequestV2 {
        adapter: AgentAdapterIdV2::new(adapter).unwrap(),
        source: AgentNativePluginMarketplaceSourceV2 {
            resource: PluginResourcePathV2::new(format!("./agents/{adapter}")).unwrap(),
        },
        selector: selector(),
        scope,
        registration_target,
    }
}

fn probe(
    adapter: &str,
    executable: AgentNativePluginExecutableV2,
    capabilities: Vec<AgentNativePluginCliCapabilityV2>,
) -> AgentNativePluginCliProbeV2 {
    AgentNativePluginCliProbeV2 {
        adapter: AgentAdapterIdV2::new(adapter).unwrap(),
        executable,
        version: PluginVersionV2::new("1.2.3").unwrap(),
        capabilities,
    }
}

fn common_capabilities() -> Vec<AgentNativePluginCliCapabilityV2> {
    vec![
        AgentNativePluginCliCapabilityV2::MarketplaceListJson,
        AgentNativePluginCliCapabilityV2::MarketplaceAdd,
        AgentNativePluginCliCapabilityV2::MarketplaceRemove,
        AgentNativePluginCliCapabilityV2::PluginListJson,
        AgentNativePluginCliCapabilityV2::PluginInstall,
        AgentNativePluginCliCapabilityV2::PluginRemove,
    ]
}

#[test]
fn codex_plan_requires_a_managed_profile_and_json_mutations() {
    let request = request(
        "codex",
        AgentInstallScopeV2::Managed,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
        },
    );
    let mut capabilities = common_capabilities();
    capabilities.push(AgentNativePluginCliCapabilityV2::JsonMutationOutput);

    let plan = plan_agent_native_plugin_cli(
        &request,
        &[probe(
            "codex",
            AgentNativePluginExecutableV2::Codex,
            capabilities,
        )],
    )
    .unwrap();

    assert_eq!(plan.commands.len(), 6);
    assert!(matches!(
        plan.commands[3],
        AgentNativePluginCliCommandV2::InstallPlugin {
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
            ..
        }
    ));
}

#[test]
fn claude_plan_binds_project_scope_to_an_exact_workspace_and_preserves_data() {
    let request = request(
        "claude",
        AgentInstallScopeV2::Project,
        AgentNativePluginRegistrationTargetV2::Workspace {
            profile_root_key: PhysicalTargetKeyV2::new("claude-profile").unwrap(),
            workspace_root_key: PhysicalTargetKeyV2::new("workspace-six").unwrap(),
        },
    );
    let mut capabilities = common_capabilities();
    capabilities.push(AgentNativePluginCliCapabilityV2::ProjectScope);

    let plan = plan_agent_native_plugin_cli(
        &request,
        &[probe(
            "claude",
            AgentNativePluginExecutableV2::Claude,
            capabilities,
        )],
    )
    .unwrap();

    assert!(matches!(
        plan.commands[4],
        AgentNativePluginCliCommandV2::RemovePlugin {
            scope: AgentInstallScopeV2::Project,
            preserve_data: true,
            output: AgentNativePluginCliOutputV2::HumanText,
            ..
        }
    ));
    assert!(matches!(
        plan.commands[5],
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            scope: AgentInstallScopeV2::Project,
            output: AgentNativePluginCliOutputV2::HumanText,
            ..
        }
    ));
}

#[test]
fn planner_fails_closed_for_missing_capabilities_and_ambiguous_targets() {
    let request = request(
        "claude",
        AgentInstallScopeV2::Project,
        AgentNativePluginRegistrationTargetV2::User {
            profile_root_key: PhysicalTargetKeyV2::new("claude-profile").unwrap(),
        },
    );
    let capabilities = common_capabilities();
    assert_eq!(
        plan_agent_native_plugin_cli(
            &request,
            &[probe(
                "claude",
                AgentNativePluginExecutableV2::Claude,
                capabilities,
            )],
        ),
        Err(AgentNativePluginCliPlanErrorV2::MissingCapability {
            adapter: AgentAdapterIdV2::new("claude").unwrap(),
            capability: AgentNativePluginCliCapabilityV2::ProjectScope,
        })
    );

    let mut capabilities = common_capabilities();
    capabilities.push(AgentNativePluginCliCapabilityV2::ProjectScope);
    assert_eq!(
        plan_agent_native_plugin_cli(
            &request,
            &[probe(
                "claude",
                AgentNativePluginExecutableV2::Claude,
                capabilities,
            )],
        ),
        Err(
            AgentNativePluginCliPlanErrorV2::AmbiguousRegistrationTarget {
                adapter: AgentAdapterIdV2::new("claude").unwrap(),
                scope: AgentInstallScopeV2::Project,
            }
        )
    );
}

#[test]
fn planner_rejects_duplicate_probes_capabilities_and_executable_mismatches() {
    let request = request(
        "codex",
        AgentInstallScopeV2::Managed,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
        },
    );
    let valid_probe = probe(
        "codex",
        AgentNativePluginExecutableV2::Codex,
        common_capabilities(),
    );
    assert!(matches!(
        plan_agent_native_plugin_cli(&request, &[valid_probe.clone(), valid_probe]),
        Err(AgentNativePluginCliPlanErrorV2::DuplicateProbe { .. })
    ));

    let duplicate = vec![
        AgentNativePluginCliCapabilityV2::MarketplaceListJson,
        AgentNativePluginCliCapabilityV2::MarketplaceListJson,
    ];
    assert!(matches!(
        plan_agent_native_plugin_cli(
            &request,
            &[probe(
                "codex",
                AgentNativePluginExecutableV2::Codex,
                duplicate
            )]
        ),
        Err(AgentNativePluginCliPlanErrorV2::DuplicateCapability { .. })
    ));
    assert!(matches!(
        plan_agent_native_plugin_cli(
            &request,
            &[probe(
                "codex",
                AgentNativePluginExecutableV2::Claude,
                common_capabilities()
            )]
        ),
        Err(AgentNativePluginCliPlanErrorV2::ExecutableMismatch { .. })
    ));
}

#[test]
fn planner_rejects_unknown_adapters_missing_probes_and_unsupported_scopes() {
    let unknown = request(
        "wrapper",
        AgentInstallScopeV2::Managed,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("wrapper-profile").unwrap(),
        },
    );
    assert!(matches!(
        plan_agent_native_plugin_cli(&unknown, &[]),
        Err(AgentNativePluginCliPlanErrorV2::UnsupportedAdapter { .. })
    ));

    let codex = request(
        "codex",
        AgentInstallScopeV2::Managed,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
        },
    );
    assert!(matches!(
        plan_agent_native_plugin_cli(&codex, &[]),
        Err(AgentNativePluginCliPlanErrorV2::MissingProbe { .. })
    ));

    let claude = request(
        "claude",
        AgentInstallScopeV2::Managed,
        AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("claude-profile").unwrap(),
        },
    );
    assert!(matches!(
        plan_agent_native_plugin_cli(
            &claude,
            &[probe(
                "claude",
                AgentNativePluginExecutableV2::Claude,
                common_capabilities(),
            )],
        ),
        Err(AgentNativePluginCliPlanErrorV2::UnsupportedScope { .. })
    ));
}
