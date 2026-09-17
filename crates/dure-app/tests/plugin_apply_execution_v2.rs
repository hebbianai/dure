use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginNameV2, AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2,
    OperationEventIdV1, OperationIdV1, PhysicalTargetKeyV2, PluginApplyJournalEventBodyV2,
    PluginApplyJournalEventV2, PluginApplyJournalStateV2, PluginApplyOperationKindV2,
    PluginApplyRecoveryDirectiveV2, PluginApplyRecoveryStrategyV2, PluginApplyStepCompletionV2,
    PluginApplyStepV2, PluginIdV2, PluginNativeCommandOutcomeV2, PluginNativeExistingOwnershipV2,
    PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativeStateObservationV2, PluginNativeTargetStateV2, PluginTargetStateDigestV2,
    PluginVersionV2, complete_plugin_apply_step, fold_plugin_apply_journal,
    prepare_plugin_apply_step, select_plugin_apply_recovery,
};

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
    }
}

fn command() -> AgentNativePluginCliCommandV2 {
    AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    }
}

fn step() -> PluginApplyStepV2 {
    PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        cli_version: PluginVersionV2::new("0.146.0").unwrap(),
        selector: selector(),
        registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex.profile.default").unwrap(),
        },
        command: command(),
    }
}

fn state(installed: bool, source: &[u8]) -> PluginNativeStateObservationV2 {
    PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
        marketplace: PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint: PluginTargetStateDigestV2::sha256(source),
            matches_expected_source: true,
            scope: AgentInstallScopeV2::Managed,
        },
        installation: if installed {
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

fn event(sequence: u32, body: PluginApplyJournalEventBodyV2) -> PluginApplyJournalEventV2 {
    PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(format!("event-{sequence}")).unwrap(),
        operation_id: OperationIdV1::new("operation-1").unwrap(),
        sequence,
        body,
        recorded_at_ms: i64::from(sequence),
    }
}

fn started() -> PluginApplyJournalEventV2 {
    event(
        1,
        PluginApplyJournalEventBodyV2::Started {
            idempotency_key: "install:dure-beads:1".into(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: None,
            operation_kind: PluginApplyOperationKindV2::Install,
            steps: vec![step()],
        },
    )
}

#[test]
fn successful_owned_creation_emits_observation_then_effect() {
    let before = state(false, b"expected");
    let prepared = prepare_plugin_apply_step(0, 1, before).unwrap();
    let prepared_receipt =
        fold_plugin_apply_journal(&[started(), event(2, prepared.clone())]).unwrap();
    let PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } =
        prepared_receipt.recovery
    else {
        panic!("prepared mutation must require inspection");
    };

    let bodies = complete_plugin_apply_step(PluginApplyStepCompletionV2 {
        command: &command(),
        expected_plugin_version: &PluginVersionV2::new("1.0.0").unwrap(),
        existing_ownership: PluginNativeExistingOwnershipV2::Unproven,
        checkpoint: &checkpoint,
        outcome: &PluginNativeCommandOutcomeV2::Succeeded,
        after: &state(true, b"expected"),
    })
    .unwrap();
    assert_eq!(bodies.len(), 2);

    let receipt = fold_plugin_apply_journal(&[
        started(),
        event(2, prepared),
        event(3, bodies[0].clone()),
        event(4, bodies[1].clone()),
        event(5, PluginApplyJournalEventBodyV2::Succeeded),
    ])
    .unwrap();
    assert_eq!(receipt.state, PluginApplyJournalStateV2::Succeeded);
    assert_eq!(receipt.effects.len(), 1);
}

#[test]
fn unsafe_post_state_is_persisted_as_divergence() {
    let before = state(false, b"expected");
    let prepared = prepare_plugin_apply_step(0, 1, before).unwrap();
    let prepared_receipt =
        fold_plugin_apply_journal(&[started(), event(2, prepared.clone())]).unwrap();
    let PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } =
        prepared_receipt.recovery
    else {
        panic!("prepared mutation must require inspection");
    };

    let bodies = complete_plugin_apply_step(PluginApplyStepCompletionV2 {
        command: &command(),
        expected_plugin_version: &PluginVersionV2::new("1.0.0").unwrap(),
        existing_ownership: PluginNativeExistingOwnershipV2::Unproven,
        checkpoint: &checkpoint,
        outcome: &PluginNativeCommandOutcomeV2::Succeeded,
        after: &state(true, b"changed"),
    })
    .unwrap();
    assert!(matches!(
        bodies.as_slice(),
        [
            PluginApplyJournalEventBodyV2::StepObserved { .. },
            PluginApplyJournalEventBodyV2::StepReconciled {
                resolution: dure_app::PluginApplyStepReconciliationV2::Diverged,
                ..
            }
        ]
    ));

    let receipt = fold_plugin_apply_journal(&[
        started(),
        event(2, prepared),
        event(3, bodies[0].clone()),
        event(4, bodies[1].clone()),
    ])
    .unwrap();
    assert_eq!(receipt.state, PluginApplyJournalStateV2::RecoveryRequired);
}

#[test]
fn unchanged_failed_command_is_recorded_and_retried() {
    let before = state(false, b"expected");
    let prepared = prepare_plugin_apply_step(0, 1, before).unwrap();
    let prepared_receipt =
        fold_plugin_apply_journal(&[started(), event(2, prepared.clone())]).unwrap();
    let PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } =
        prepared_receipt.recovery
    else {
        panic!("prepared mutation must require inspection");
    };
    let bodies = complete_plugin_apply_step(PluginApplyStepCompletionV2 {
        command: &command(),
        expected_plugin_version: &PluginVersionV2::new("1.0.0").unwrap(),
        existing_ownership: PluginNativeExistingOwnershipV2::Unproven,
        checkpoint: &checkpoint,
        outcome: &PluginNativeCommandOutcomeV2::TimedOut,
        after: &state(false, b"expected"),
    })
    .unwrap();

    assert!(matches!(
        bodies.as_slice(),
        [
            PluginApplyJournalEventBodyV2::StepObserved {
                outcome: PluginNativeCommandOutcomeV2::TimedOut,
                ..
            },
            PluginApplyJournalEventBodyV2::StepReconciled {
                resolution: dure_app::PluginApplyStepReconciliationV2::NotApplied,
                ..
            }
        ]
    ));
    let receipt = fold_plugin_apply_journal(&[
        started(),
        event(2, prepared),
        event(3, bodies[0].clone()),
        event(4, bodies[1].clone()),
    ])
    .unwrap();
    assert_eq!(receipt.state, PluginApplyJournalStateV2::Applying);
    assert_eq!(
        receipt.recovery,
        PluginApplyRecoveryDirectiveV2::Continue {
            step_index: 0,
            next_attempt: 2,
        }
    );
}

#[test]
fn recovery_selection_requires_safe_forward_or_owned_compensation_evidence() {
    let before = state(false, b"expected");
    let prepared = prepare_plugin_apply_step(0, 1, before).unwrap();
    let prepared_receipt =
        fold_plugin_apply_journal(&[started(), event(2, prepared.clone())]).unwrap();
    let PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { checkpoint } =
        prepared_receipt.recovery
    else {
        panic!("prepared mutation must require inspection");
    };
    let bodies = complete_plugin_apply_step(PluginApplyStepCompletionV2 {
        command: &command(),
        expected_plugin_version: &PluginVersionV2::new("1.0.0").unwrap(),
        existing_ownership: PluginNativeExistingOwnershipV2::Unproven,
        checkpoint: &checkpoint,
        outcome: &PluginNativeCommandOutcomeV2::Succeeded,
        after: &state(true, b"changed"),
    })
    .unwrap();
    let receipt = fold_plugin_apply_journal(&[
        started(),
        event(2, prepared),
        event(3, bodies[0].clone()),
        event(4, bodies[1].clone()),
    ])
    .unwrap();

    assert_eq!(
        select_plugin_apply_recovery(&receipt, PluginApplyRecoveryStrategyV2::Forward),
        Err(dure_app::PluginApplyExecutionDecisionErrorV2::ForwardRecoveryUnsafe)
    );
    assert_eq!(
        select_plugin_apply_recovery(&receipt, PluginApplyRecoveryStrategyV2::CompensateOwned),
        Err(dure_app::PluginApplyExecutionDecisionErrorV2::CompensationUnavailable)
    );

    let mut safe_forward = receipt.clone();
    let PluginApplyRecoveryDirectiveV2::ChooseRecovery { checkpoint, .. } =
        &mut safe_forward.recovery
    else {
        panic!("receipt must require a recovery choice");
    };
    checkpoint.after = Some(checkpoint.before.clone());
    assert_eq!(
        select_plugin_apply_recovery(&safe_forward, PluginApplyRecoveryStrategyV2::Forward),
        Ok(PluginApplyJournalEventBodyV2::RecoveryResumed {
            strategy: PluginApplyRecoveryStrategyV2::Forward,
        })
    );

    let mut owned = receipt;
    owned.effects.push(dure_app::PluginApplyEffectReceiptV2 {
        step_index: 0,
        attempt: 1,
        step: step(),
        before: state(false, b"expected"),
        after: state(true, b"expected"),
        disposition: dure_app::PluginApplyEffectDispositionV2::CreatedDureOwned,
    });
    assert_eq!(
        select_plugin_apply_recovery(&owned, PluginApplyRecoveryStrategyV2::CompensateOwned),
        Ok(PluginApplyJournalEventBodyV2::RecoveryResumed {
            strategy: PluginApplyRecoveryStrategyV2::CompensateOwned,
        })
    );

    owned.compensation_for = Some(OperationIdV1::new("compensation-parent").unwrap());
    assert_eq!(
        select_plugin_apply_recovery(&owned, PluginApplyRecoveryStrategyV2::CompensateOwned),
        Err(dure_app::PluginApplyExecutionDecisionErrorV2::NestedCompensationForbidden)
    );
}
