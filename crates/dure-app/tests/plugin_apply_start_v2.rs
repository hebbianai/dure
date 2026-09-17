use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginCliPlanV2,
    AgentNativePluginExecutableV2, AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, OperationIdV1,
    PhysicalTargetKeyV2, PluginApplyJournalEventBodyV2, PluginApplyOperationKindV2,
    PluginApplyStartErrorV2, PluginApplyStartRequestV2, PluginIdV2,
    PluginNativePhysicalTargetBindingV2, PluginNativePhysicalTargetDigestV2,
    PluginNativePhysicalTargetRoleV2, PluginResourcePathV2, PluginVersionV2,
    create_plugin_apply_started_event,
};

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn plan() -> AgentNativePluginCliPlanV2 {
    let selector = selector();
    let source = AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
    };
    AgentNativePluginCliPlanV2 {
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        cli_version: PluginVersionV2::new("1.0.0").unwrap(),
        selector: selector.clone(),
        registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex.profile.test").unwrap(),
        },
        commands: vec![
            AgentNativePluginCliCommandV2::ListMarketplaces {
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::AddMarketplace {
                source,
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::ListPlugins {
                marketplace: selector.marketplace.clone(),
                include_available: true,
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector.clone(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::RemovePlugin {
                selector: selector.clone(),
                scope: AgentInstallScopeV2::Managed,
                preserve_data: true,
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace: selector.marketplace,
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        ],
    }
}

fn event(
    plan: &AgentNativePluginCliPlanV2,
    operation_kind: PluginApplyOperationKindV2,
) -> Result<dure_app::PluginApplyJournalEventV2, PluginApplyStartErrorV2> {
    let digest = |fill: char| {
        PluginNativePhysicalTargetDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64)))
            .unwrap()
    };
    let target_bindings = [PluginNativePhysicalTargetBindingV2 {
        key: PhysicalTargetKeyV2::new("codex.profile.test").unwrap(),
        role: PluginNativePhysicalTargetRoleV2::ProfileRoot,
        canonical_path_identity: digest('a'),
        filesystem_object_identity: digest('b'),
        authority_generation_identity: digest('d'),
        authority_identity: digest('c'),
        binding_identity: digest('e'),
    }];
    create_plugin_apply_started_event(PluginApplyStartRequestV2 {
        operation_id: &OperationIdV1::new("plugin-operation-test").unwrap(),
        idempotency_key: "plugin-request-test",
        plugin_id: &PluginIdV2::new("dure.beads").unwrap(),
        plugin_version: &PluginVersionV2::new("1.0.0").unwrap(),
        integration_id: &AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        target_bindings: &target_bindings,
        operation_kind,
        plan,
        recorded_at_ms: 1_000,
    })
}

#[test]
fn install_and_uninstall_start_with_only_the_ordered_mutations() {
    let plan = plan();
    let install = event(&plan, PluginApplyOperationKindV2::Install).unwrap();
    let uninstall = event(&plan, PluginApplyOperationKindV2::Uninstall).unwrap();

    assert_eq!(install.sequence, 1);
    assert_eq!(
        install.event_id,
        event(&plan, PluginApplyOperationKindV2::Install)
            .unwrap()
            .event_id
    );
    let PluginApplyJournalEventBodyV2::Started {
        steps,
        target_bindings,
        ..
    } = install.body
    else {
        panic!("start builder must emit a Started event");
    };
    assert_eq!(target_bindings.unwrap().len(), 1);
    assert!(matches!(
        steps[0].command,
        AgentNativePluginCliCommandV2::AddMarketplace { .. }
    ));
    assert!(matches!(
        steps[1].command,
        AgentNativePluginCliCommandV2::InstallPlugin { .. }
    ));

    let PluginApplyJournalEventBodyV2::Started { steps, .. } = uninstall.body else {
        panic!("start builder must emit a Started event");
    };
    assert!(matches!(
        steps[0].command,
        AgentNativePluginCliCommandV2::RemovePlugin { .. }
    ));
    assert!(matches!(
        steps[1].command,
        AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
    ));
}

#[test]
fn missing_duplicate_and_reordered_mutations_fail_closed() {
    let mut missing = plan();
    missing
        .commands
        .retain(|command| !matches!(command, AgentNativePluginCliCommandV2::InstallPlugin { .. }));
    assert_eq!(
        event(&missing, PluginApplyOperationKindV2::Install),
        Err(PluginApplyStartErrorV2::MissingCommand {
            command: "install_plugin"
        })
    );

    let mut duplicate = plan();
    duplicate.commands.push(duplicate.commands[1].clone());
    assert_eq!(
        event(&duplicate, PluginApplyOperationKindV2::Install),
        Err(PluginApplyStartErrorV2::DuplicateCommand {
            command: "add_marketplace"
        })
    );

    let mut reordered = plan();
    reordered.commands.swap(1, 3);
    assert_eq!(
        event(&reordered, PluginApplyOperationKindV2::Install),
        Err(PluginApplyStartErrorV2::InvalidCommandOrder)
    );
}
