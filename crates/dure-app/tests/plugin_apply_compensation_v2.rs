use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, OperationIdV1,
    PhysicalTargetKeyV2, PluginApplyCompensationLinkV2, PluginApplyCompensationPlanErrorV2,
    PluginApplyEffectDispositionV2, PluginApplyEffectReceiptV2, PluginApplyJournalReceiptV2,
    PluginApplyJournalStateV2, PluginApplyOperationKindV2, PluginApplyRecoveryDirectiveV2,
    PluginApplyStepV2, PluginIdV2, PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativeStateObservationV2, PluginNativeTargetStateV2, PluginResourcePathV2,
    PluginTargetStateDigestV2, PluginVersionV2, create_plugin_apply_compensation_started_event,
    plan_plugin_apply_compensation, plugin_apply_compensation_identity,
    validate_plugin_apply_compensation_completion, validate_plugin_apply_compensation_link,
};

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn step(command: AgentNativePluginCliCommandV2) -> PluginApplyStepV2 {
    PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        cli_version: PluginVersionV2::new("0.146.0").unwrap(),
        selector: selector(),
        registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex.profile.default").unwrap(),
        },
        command,
    }
}

fn state(marketplace: bool, plugin: bool) -> PluginNativeStateObservationV2 {
    PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
        marketplace: if marketplace {
            PluginNativeMarketplaceStateV2::Registered {
                source_fingerprint: PluginTargetStateDigestV2::sha256("marketplace"),
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Managed,
            }
        } else {
            PluginNativeMarketplaceStateV2::Absent
        },
        installation: if plugin {
            PluginNativeInstallationStateV2::Installed {
                version: PluginVersionV2::new("1.0.0").unwrap(),
                enabled: true,
                scope: AgentInstallScopeV2::Managed,
            }
        } else {
            PluginNativeInstallationStateV2::Absent
        },
    })
}

fn effect(
    step_index: u32,
    mutation: PluginApplyStepV2,
    before: PluginNativeStateObservationV2,
    after: PluginNativeStateObservationV2,
    disposition: PluginApplyEffectDispositionV2,
) -> PluginApplyEffectReceiptV2 {
    PluginApplyEffectReceiptV2 {
        step_index,
        attempt: 1,
        step: mutation,
        before,
        after,
        disposition,
    }
}

fn receipt(
    operation_kind: PluginApplyOperationKindV2,
    effects: Vec<PluginApplyEffectReceiptV2>,
) -> PluginApplyJournalReceiptV2 {
    PluginApplyJournalReceiptV2 {
        operation_id: OperationIdV1::new("plugin-compensation").unwrap(),
        idempotency_key: "plugin-compensation-request".into(),
        plugin_id: PluginIdV2::new("dure.beads").unwrap(),
        plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
        compensation_for: None,
        target_bindings: None,
        operation_kind,
        steps: effects.iter().map(|effect| effect.step.clone()).collect(),
        state: PluginApplyJournalStateV2::Compensating,
        last_sequence: 10,
        next_step_index: effects.len() as u32,
        recovery: PluginApplyRecoveryDirectiveV2::CompensateOwned {
            effects: effects.iter().rev().cloned().collect(),
        },
        effects,
        compensation: None,
        last_failure: None,
        created_at_ms: 1,
        updated_at_ms: 10,
    }
}

fn marketplace_source() -> AgentNativePluginMarketplaceSourceV2 {
    AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./agents/codex/.agents/plugins/marketplace.json")
            .unwrap(),
    }
}

#[test]
fn install_compensation_removes_owned_plugin_before_marketplace_and_preserves_data() {
    let add_marketplace = step(AgentNativePluginCliCommandV2::AddMarketplace {
        source: marketplace_source(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let install_plugin = step(AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let receipt = receipt(
        PluginApplyOperationKindV2::Install,
        vec![
            effect(
                0,
                add_marketplace,
                state(false, false),
                state(true, false),
                PluginApplyEffectDispositionV2::CreatedDureOwned,
            ),
            effect(
                1,
                install_plugin,
                state(true, false),
                state(true, true),
                PluginApplyEffectDispositionV2::CreatedDureOwned,
            ),
        ],
    );

    let plan = plan_plugin_apply_compensation(&receipt, &marketplace_source()).unwrap();
    assert_eq!(plan.len(), 2);
    assert!(matches!(
        plan[0].step.command,
        AgentNativePluginCliCommandV2::RemovePlugin {
            preserve_data: true,
            ..
        }
    ));
    assert!(matches!(
        plan[1].step.command,
        AgentNativePluginCliCommandV2::RemoveMarketplace { .. }
    ));
    assert_eq!(plan[0].expected_before, state(true, true));
    assert_eq!(plan[0].expected_after, state(true, false));
    assert_eq!(plan[1].expected_before, state(true, false));
    assert_eq!(plan[1].expected_after, state(false, false));
}

#[test]
fn uninstall_compensation_restores_marketplace_before_plugin() {
    let remove_plugin = step(AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        preserve_data: true,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let remove_marketplace = step(AgentNativePluginCliCommandV2::RemoveMarketplace {
        marketplace: selector().marketplace,
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let receipt = receipt(
        PluginApplyOperationKindV2::Uninstall,
        vec![
            effect(
                0,
                remove_plugin,
                state(true, true),
                state(true, false),
                PluginApplyEffectDispositionV2::RemovedDureOwned,
            ),
            effect(
                1,
                remove_marketplace,
                state(true, false),
                state(false, false),
                PluginApplyEffectDispositionV2::RemovedDureOwned,
            ),
        ],
    );

    let plan = plan_plugin_apply_compensation(&receipt, &marketplace_source()).unwrap();
    assert!(matches!(
        plan[0].step.command,
        AgentNativePluginCliCommandV2::AddMarketplace { .. }
    ));
    assert!(matches!(
        plan[1].step.command,
        AgentNativePluginCliCommandV2::InstallPlugin { .. }
    ));
}

#[test]
fn compensation_requires_the_durable_compensating_state() {
    let mut receipt = receipt(PluginApplyOperationKindV2::Install, Vec::new());
    receipt.state = PluginApplyJournalStateV2::RecoveryRequired;
    assert_eq!(
        plan_plugin_apply_compensation(&receipt, &marketplace_source()),
        Err(PluginApplyCompensationPlanErrorV2::RecoveryNotCompensating)
    );

    receipt.state = PluginApplyJournalStateV2::Compensating;
    assert_eq!(
        plan_plugin_apply_compensation(&receipt, &marketplace_source()),
        Err(PluginApplyCompensationPlanErrorV2::NoOwnedEffects)
    );
}

#[test]
fn completion_requires_the_exact_linked_successful_child() {
    let mut parent = receipt(
        PluginApplyOperationKindV2::Install,
        vec![effect(
            0,
            step(AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            }),
            state(true, false),
            state(true, true),
            PluginApplyEffectDispositionV2::CreatedDureOwned,
        )],
    );
    let steps = plan_plugin_apply_compensation(&parent, &marketplace_source()).unwrap();
    let (operation_id, idempotency_key) =
        plugin_apply_compensation_identity(&parent.operation_id).unwrap();
    let link = PluginApplyCompensationLinkV2 {
        operation_id: operation_id.clone(),
        idempotency_key: idempotency_key.clone(),
        marketplace_source: marketplace_source(),
        steps,
    };
    parent.compensation = Some(link.clone());
    parent.recovery = PluginApplyRecoveryDirectiveV2::RunCompensation { link: link.clone() };

    let mut child = PluginApplyJournalReceiptV2 {
        operation_id,
        idempotency_key,
        plugin_id: parent.plugin_id.clone(),
        plugin_version: parent.plugin_version.clone(),
        compensation_for: Some(parent.operation_id.clone()),
        target_bindings: parent.target_bindings.clone(),
        operation_kind: PluginApplyOperationKindV2::Uninstall,
        steps: link
            .steps
            .iter()
            .map(|compensation| compensation.step.clone())
            .collect(),
        state: PluginApplyJournalStateV2::Succeeded,
        last_sequence: 5,
        next_step_index: 1,
        recovery: PluginApplyRecoveryDirectiveV2::None,
        effects: Vec::new(),
        compensation: None,
        last_failure: None,
        created_at_ms: 11,
        updated_at_ms: 15,
    };
    assert_eq!(
        validate_plugin_apply_compensation_completion(&parent, &child),
        Ok(())
    );

    child.compensation_for = None;
    assert_eq!(
        validate_plugin_apply_compensation_completion(&parent, &child),
        Err(PluginApplyCompensationPlanErrorV2::InvalidCompletion)
    );
}

#[test]
fn linked_child_start_is_deterministic_and_bound_to_the_trusted_marketplace_source() {
    let mut parent = receipt(
        PluginApplyOperationKindV2::Install,
        vec![effect(
            0,
            step(AgentNativePluginCliCommandV2::AddMarketplace {
                source: marketplace_source(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            }),
            state(false, false),
            state(true, false),
            PluginApplyEffectDispositionV2::CreatedDureOwned,
        )],
    );
    let steps = plan_plugin_apply_compensation(&parent, &marketplace_source()).unwrap();
    let (operation_id, idempotency_key) =
        plugin_apply_compensation_identity(&parent.operation_id).unwrap();
    let link = PluginApplyCompensationLinkV2 {
        operation_id,
        idempotency_key,
        marketplace_source: marketplace_source(),
        steps,
    };
    parent.compensation = Some(link.clone());
    parent.recovery = PluginApplyRecoveryDirectiveV2::RunCompensation { link };

    assert_eq!(
        validate_plugin_apply_compensation_link(&parent, &marketplace_source()),
        Ok(())
    );
    let first =
        create_plugin_apply_compensation_started_event(&parent, &marketplace_source()).unwrap();
    let second =
        create_plugin_apply_compensation_started_event(&parent, &marketplace_source()).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        first.operation_id,
        parent.compensation.as_ref().unwrap().operation_id
    );
    assert!(matches!(
        first.body,
        dure_app::PluginApplyJournalEventBodyV2::Started {
            compensation_for: Some(ref operation_id),
            operation_kind: PluginApplyOperationKindV2::Uninstall,
            ..
        } if operation_id == &parent.operation_id
    ));

    let other_source = AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./other-marketplace.json").unwrap(),
    };
    assert_eq!(
        validate_plugin_apply_compensation_link(&parent, &other_source),
        Err(PluginApplyCompensationPlanErrorV2::InvalidLink)
    );
}
