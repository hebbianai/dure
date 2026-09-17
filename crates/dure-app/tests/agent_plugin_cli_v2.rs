use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCapabilityV2, AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2,
    AgentNativePluginCliProbeV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2, AgentNativePluginSelectorV2,
    PluginResourcePathV2, PluginVersionV2,
};

#[test]
fn probe_contract_carries_observed_capabilities_without_inferring_them_from_version() {
    let probe = AgentNativePluginCliProbeV2 {
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        version: PluginVersionV2::new("0.146.0").unwrap(),
        capabilities: vec![
            AgentNativePluginCliCapabilityV2::MarketplaceListJson,
            AgentNativePluginCliCapabilityV2::PluginInstall,
        ],
    };

    assert!(probe.executable.matches_adapter(&probe.adapter));
    assert_eq!(
        serde_json::to_value(&probe).unwrap(),
        serde_json::json!({
            "adapter": "codex",
            "executable": "codex",
            "version": "0.146.0",
            "capabilities": ["marketplace_list_json", "plugin_install"],
        })
    );
}

#[test]
fn executable_identity_is_exact_and_does_not_alias_an_unknown_adapter() {
    let unknown = AgentAdapterIdV2::new("codex-wrapper").unwrap();

    assert!(!AgentNativePluginExecutableV2::Codex.matches_adapter(&unknown));
    assert_eq!(AgentNativePluginExecutableV2::Claude.as_str(), "claude");
}

#[test]
fn semantic_commands_bind_marketplace_resources_and_preserve_uninstall_data_intent() {
    let selector = AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    };
    let commands = vec![
        AgentNativePluginCliCommandV2::AddMarketplace {
            source: AgentNativePluginMarketplaceSourceV2 {
                resource: PluginResourcePathV2::new("./agents/claude").unwrap(),
            },
            scope: AgentInstallScopeV2::Project,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
        AgentNativePluginCliCommandV2::RemovePlugin {
            selector: selector.clone(),
            scope: AgentInstallScopeV2::Project,
            preserve_data: true,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace: selector.marketplace,
            scope: AgentInstallScopeV2::Project,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
    ];

    assert_eq!(
        serde_json::to_value(commands).unwrap(),
        serde_json::json!([
            {
                "kind": "add_marketplace",
                "source": {"resource": "./agents/claude"},
                "scope": "project",
                "output": "human_text",
            },
            {
                "kind": "remove_plugin",
                "selector": {
                    "plugin": "dure-beads",
                    "marketplace": "dure-bundled",
                },
                "scope": "project",
                "preserve_data": true,
                "output": "human_text",
            },
            {
                "kind": "remove_marketplace",
                "marketplace": "dure-bundled",
                "scope": "project",
                "output": "human_text",
            },
        ])
    );
}
