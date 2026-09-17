use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, OperationEventIdV1,
    OperationIdV1, PhysicalTargetKeyV2, PluginApplyCompensationLinkV2,
    PluginApplyEffectDispositionV2, PluginApplyJournalEventBodyV2, PluginApplyJournalEventV2,
    PluginApplyJournalStateV2, PluginApplyOperationKindV2, PluginApplyRecoveryDirectiveV2,
    PluginApplyRecoveryStrategyV2, PluginApplyStepReconciliationV2, PluginApplyStepV2, PluginIdV2,
    PluginNativeCommandOutcomeV2, PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativePhysicalTargetBindingV2, PluginNativePhysicalTargetDigestV2,
    PluginNativePhysicalTargetRoleV2, PluginNativeStateObservationV2, PluginNativeTargetStateV2,
    PluginResourcePathV2, PluginTargetStateDigestV2, PluginVersionV2, fold_plugin_apply_journal,
    plan_plugin_apply_compensation, plugin_apply_compensation_identity,
};

fn digest(fill: char) -> PluginTargetStateDigestV2 {
    PluginTargetStateDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64))).unwrap()
}

fn observation(fill: char) -> PluginNativeStateObservationV2 {
    PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
        marketplace: PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint: digest(fill),
            matches_expected_source: true,
            scope: AgentInstallScopeV2::Managed,
        },
        installation: PluginNativeInstallationStateV2::Absent,
    })
}

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn codex_step(command: AgentNativePluginCliCommandV2) -> PluginApplyStepV2 {
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

fn list_marketplaces() -> PluginApplyStepV2 {
    codex_step(AgentNativePluginCliCommandV2::ListMarketplaces {
        output: AgentNativePluginCliOutputV2::Json,
    })
}

fn install_plugin() -> PluginApplyStepV2 {
    codex_step(AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    })
}

fn install_plugin_at(profile_root_key: &str) -> PluginApplyStepV2 {
    let mut step = install_plugin();
    step.registration_target = AgentNativePluginRegistrationTargetV2::ManagedProfile {
        profile_root_key: PhysicalTargetKeyV2::new(profile_root_key).unwrap(),
    };
    step
}

fn start(steps: Vec<PluginApplyStepV2>) -> PluginApplyJournalEventV2 {
    event(
        1,
        PluginApplyJournalEventBodyV2::Started {
            idempotency_key: "plugin-install:dure.beads:1".into(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: None,
            operation_kind: PluginApplyOperationKindV2::Install,
            steps,
        },
    )
}

fn event(sequence: u32, body: PluginApplyJournalEventBodyV2) -> PluginApplyJournalEventV2 {
    PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(format!("plugin-event-{sequence}")).unwrap(),
        operation_id: OperationIdV1::new("plugin-operation-1").unwrap(),
        sequence,
        body,
        recorded_at_ms: 1_000 + i64::from(sequence),
    }
}

#[test]
fn started_binding_wire_preserves_exact_roles_and_legacy_absence() {
    let opaque = |fill: char| {
        PluginNativePhysicalTargetDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64)))
            .unwrap()
    };
    let binding = PluginNativePhysicalTargetBindingV2 {
        key: PhysicalTargetKeyV2::new("codex.profile.default").unwrap(),
        role: PluginNativePhysicalTargetRoleV2::ProfileRoot,
        canonical_path_identity: opaque('a'),
        filesystem_object_identity: opaque('b'),
        authority_generation_identity: opaque('c'),
        authority_identity: opaque('d'),
        binding_identity: opaque('e'),
    };
    let mut bound = start(vec![install_plugin()]);
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings, ..
    } = &mut bound.body
    else {
        unreachable!();
    };
    *target_bindings = Some(vec![binding.clone()]);
    let encoded = serde_json::to_value(&bound.body).unwrap();
    let decoded: PluginApplyJournalEventBodyV2 = serde_json::from_value(encoded.clone()).unwrap();
    bound.body = decoded;
    assert_eq!(
        fold_plugin_apply_journal(&[bound.clone()])
            .unwrap()
            .target_bindings,
        Some(vec![binding.clone()])
    );

    let mut wrong_role = bound.clone();
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings: Some(bindings),
        ..
    } = &mut wrong_role.body
    else {
        unreachable!();
    };
    bindings[0].role = PluginNativePhysicalTargetRoleV2::WorkspaceRoot;
    assert!(fold_plugin_apply_journal(&[wrong_role]).is_err());

    let mut legacy_json = encoded;
    legacy_json
        .as_object_mut()
        .unwrap()
        .remove("target_bindings");
    let legacy_body: PluginApplyJournalEventBodyV2 = serde_json::from_value(legacy_json).unwrap();
    let legacy = event(1, legacy_body);
    assert!(
        fold_plugin_apply_journal(&[legacy])
            .unwrap()
            .target_bindings
            .is_none()
    );
    let mut legacy_receipt_json =
        serde_json::to_value(fold_plugin_apply_journal(&[start(vec![install_plugin()])]).unwrap())
            .unwrap();
    legacy_receipt_json
        .as_object_mut()
        .unwrap()
        .remove("target_bindings");
    let legacy_receipt: dure_app::PluginApplyJournalReceiptV2 =
        serde_json::from_value(legacy_receipt_json).unwrap();
    assert!(legacy_receipt.target_bindings.is_none());
}

fn prepared(sequence: u32, step_index: u32, attempt: u32) -> PluginApplyJournalEventV2 {
    event(
        sequence,
        PluginApplyJournalEventBodyV2::StepPrepared {
            step_index,
            attempt,
            before: observation('a'),
        },
    )
}

fn observed(
    sequence: u32,
    step_index: u32,
    attempt: u32,
    outcome: PluginNativeCommandOutcomeV2,
) -> PluginApplyJournalEventV2 {
    observed_after(sequence, step_index, attempt, outcome, 'b')
}

fn observed_after(
    sequence: u32,
    step_index: u32,
    attempt: u32,
    outcome: PluginNativeCommandOutcomeV2,
    after: char,
) -> PluginApplyJournalEventV2 {
    event(
        sequence,
        PluginApplyJournalEventBodyV2::StepObserved {
            step_index,
            attempt,
            outcome,
            after: observation(after),
        },
    )
}

#[test]
fn folds_secret_free_read_and_owned_mutation_evidence_to_success() {
    let receipt = fold_plugin_apply_journal(&[
        start(vec![list_marketplaces(), install_plugin()]),
        prepared(2, 0, 1),
        observed(3, 0, 1, PluginNativeCommandOutcomeV2::Succeeded),
        prepared(4, 1, 1),
        observed(5, 1, 1, PluginNativeCommandOutcomeV2::Succeeded),
        event(
            6,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 1,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
        event(7, PluginApplyJournalEventBodyV2::Succeeded),
    ])
    .unwrap();

    assert_eq!(receipt.state, PluginApplyJournalStateV2::Succeeded);
    assert_eq!(receipt.next_step_index, 2);
    assert_eq!(receipt.effects.len(), 1);
    assert_eq!(
        receipt.effects[0].disposition,
        PluginApplyEffectDispositionV2::CreatedDureOwned
    );
    assert_eq!(receipt.recovery, PluginApplyRecoveryDirectiveV2::None);
    let encoded = serde_json::to_string(&receipt).unwrap();
    assert!(!encoded.contains("stdout"));
    assert!(!encoded.contains("stderr"));
    assert!(!encoded.contains("credential"));
}

#[test]
fn requires_inspection_when_a_command_or_effect_receipt_was_interrupted() {
    let before_execution =
        fold_plugin_apply_journal(&[start(vec![install_plugin()]), prepared(2, 0, 1)]).unwrap();
    assert_eq!(
        before_execution.state,
        PluginApplyJournalStateV2::InspectBeforeRetry
    );
    assert!(matches!(
        before_execution.recovery,
        PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { ref checkpoint }
            if checkpoint.step_index == 0
                && checkpoint.attempt == 1
                && checkpoint.outcome.is_none()
    ));

    let before_effect = fold_plugin_apply_journal(&[
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        observed(3, 0, 1, PluginNativeCommandOutcomeV2::Succeeded),
    ])
    .unwrap();
    assert_eq!(
        before_effect.state,
        PluginApplyJournalStateV2::InspectBeforeRetry
    );
    assert!(matches!(
        before_effect.recovery,
        PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { ref checkpoint }
            if checkpoint.outcome == Some(PluginNativeCommandOutcomeV2::Succeeded)
                && checkpoint.after.as_ref().map(|after| &after.digest)
                    == Some(&observation('b').digest)
    ));
}

#[test]
fn an_observed_unchanged_failure_is_reconciled_before_retry() {
    let receipt = fold_plugin_apply_journal(&[
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        observed_after(
            3,
            0,
            1,
            PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(2) },
            'a',
        ),
        event(
            4,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('a'),
                resolution: PluginApplyStepReconciliationV2::NotApplied,
            },
        ),
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

    let recovered = fold_plugin_apply_journal(&[
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        observed_after(
            3,
            0,
            1,
            PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(2) },
            'a',
        ),
        event(
            4,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('a'),
                resolution: PluginApplyStepReconciliationV2::NotApplied,
            },
        ),
        prepared(5, 0, 2),
        observed(6, 0, 2, PluginNativeCommandOutcomeV2::Succeeded),
        event(
            7,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 2,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
        event(8, PluginApplyJournalEventBodyV2::Succeeded),
    ])
    .unwrap();
    assert_eq!(recovered.state, PluginApplyJournalStateV2::Succeeded);
    assert_eq!(recovered.effects[0].attempt, 2);
}

#[test]
fn compensation_projects_only_operation_owned_effects_in_reverse_order() {
    let mut events = vec![
        start(vec![
            install_plugin_at("codex.profile.a"),
            install_plugin_at("codex.profile.b"),
            install_plugin_at("codex.profile.c"),
        ]),
        prepared(2, 0, 1),
        observed(3, 0, 1, PluginNativeCommandOutcomeV2::Succeeded),
        event(
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
        prepared(5, 1, 1),
        observed_after(6, 1, 1, PluginNativeCommandOutcomeV2::Succeeded, 'a'),
        event(
            7,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 1,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::PreservedExternal,
            },
        ),
        prepared(8, 2, 1),
        observed(9, 2, 1, PluginNativeCommandOutcomeV2::TimedOut),
        event(
            10,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 2,
                attempt: 1,
                observed: observation('b'),
                resolution: PluginApplyStepReconciliationV2::Diverged,
            },
        ),
        event(
            11,
            PluginApplyJournalEventBodyV2::RecoveryResumed {
                strategy: PluginApplyRecoveryStrategyV2::CompensateOwned,
            },
        ),
    ];
    let receipt = fold_plugin_apply_journal(&events).unwrap();

    assert_eq!(receipt.state, PluginApplyJournalStateV2::Compensating);
    assert!(matches!(
        receipt.recovery,
        PluginApplyRecoveryDirectiveV2::CompensateOwned { ref effects }
            if effects.len() == 1
                && effects[0].step_index == 0
                && effects[0].disposition
                    == PluginApplyEffectDispositionV2::CreatedDureOwned
    ));

    let marketplace_source = AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
    };
    let compensation_steps = plan_plugin_apply_compensation(&receipt, &marketplace_source).unwrap();
    let (compensation_operation_id, compensation_idempotency_key) =
        plugin_apply_compensation_identity(&receipt.operation_id).unwrap();
    let link = PluginApplyCompensationLinkV2 {
        operation_id: compensation_operation_id.clone(),
        idempotency_key: compensation_idempotency_key,
        marketplace_source,
        steps: compensation_steps,
    };
    events.push(event(
        12,
        PluginApplyJournalEventBodyV2::CompensationLinked { link: link.clone() },
    ));
    let linked = fold_plugin_apply_journal(&events).unwrap();
    assert_eq!(
        linked.recovery,
        PluginApplyRecoveryDirectiveV2::RunCompensation { link: link.clone() }
    );
    events.push(event(
        13,
        PluginApplyJournalEventBodyV2::Compensated {
            operation_id: compensation_operation_id,
        },
    ));
    let compensated = fold_plugin_apply_journal(&events).unwrap();
    assert_eq!(compensated.state, PluginApplyJournalStateV2::Compensated);
    assert_eq!(compensated.compensation, Some(link));
}

#[test]
fn reconciliation_resolves_crash_boundaries_without_blind_reexecution() {
    let not_applied = fold_plugin_apply_journal(&[
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        event(
            3,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('a'),
                resolution: PluginApplyStepReconciliationV2::NotApplied,
            },
        ),
    ])
    .unwrap();
    assert_eq!(not_applied.state, PluginApplyJournalStateV2::Applying);
    assert_eq!(
        not_applied.recovery,
        PluginApplyRecoveryDirectiveV2::Continue {
            step_index: 0,
            next_attempt: 2,
        }
    );

    let applied = fold_plugin_apply_journal(&[
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        observed(3, 0, 1, PluginNativeCommandOutcomeV2::Succeeded),
        event(
            4,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('b'),
                resolution: PluginApplyStepReconciliationV2::Applied {
                    disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
                },
            },
        ),
        event(5, PluginApplyJournalEventBodyV2::Succeeded),
    ])
    .unwrap();
    assert_eq!(applied.state, PluginApplyJournalStateV2::Succeeded);
    assert_eq!(applied.effects.len(), 1);

    let changed_but_claimed_unapplied = [
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        event(
            3,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('b'),
                resolution: PluginApplyStepReconciliationV2::NotApplied,
            },
        ),
    ];
    assert!(
        fold_plugin_apply_journal(&changed_but_claimed_unapplied)
            .unwrap_err()
            .to_string()
            .contains("preserve the before digest")
    );
}

#[test]
fn rejects_unsafe_lifecycle_commands_and_malformed_streams() {
    let mut self_compensation = start(vec![install_plugin()]);
    let PluginApplyJournalEventBodyV2::Started {
        compensation_for, ..
    } = &mut self_compensation.body
    else {
        unreachable!();
    };
    *compensation_for = Some(self_compensation.operation_id.clone());
    assert!(
        fold_plugin_apply_journal(&[self_compensation])
            .unwrap_err()
            .to_string()
            .contains("cannot reference itself")
    );

    let mut unsafe_remove = install_plugin();
    unsafe_remove.command = AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        preserve_data: false,
        output: AgentNativePluginCliOutputV2::Json,
    };
    let unsafe_uninstall = PluginApplyJournalEventV2 {
        body: PluginApplyJournalEventBodyV2::Started {
            idempotency_key: "plugin-uninstall:dure.beads:unsafe".into(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: None,
            operation_kind: PluginApplyOperationKindV2::Uninstall,
            steps: vec![unsafe_remove],
        },
        ..start(vec![install_plugin()])
    };
    assert!(
        fold_plugin_apply_journal(&[unsafe_uninstall])
            .unwrap_err()
            .to_string()
            .contains("preserve")
    );

    let remove_marketplace_during_install = start(vec![codex_step(
        AgentNativePluginCliCommandV2::RemoveMarketplace {
            marketplace: selector().marketplace,
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    )]);
    assert!(
        fold_plugin_apply_journal(&[remove_marketplace_during_install])
            .unwrap_err()
            .to_string()
            .contains("does not belong")
    );

    let gap = vec![start(vec![list_marketplaces()]), prepared(3, 0, 1)];
    assert!(
        fold_plugin_apply_journal(&gap)
            .unwrap_err()
            .to_string()
            .contains("expected sequence 2")
    );

    let premature_success = vec![
        start(vec![install_plugin()]),
        event(2, PluginApplyJournalEventBodyV2::Succeeded),
    ];
    assert!(
        fold_plugin_apply_journal(&premature_success)
            .unwrap_err()
            .to_string()
            .contains("every planned step")
    );

    let false_no_change = [
        start(vec![install_plugin()]),
        prepared(2, 0, 1),
        observed(3, 0, 1, PluginNativeCommandOutcomeV2::Succeeded),
        event(
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::NoChange,
            },
        ),
    ];
    assert!(
        fold_plugin_apply_journal(&false_no_change)
            .unwrap_err()
            .to_string()
            .contains("digest change")
    );

    assert!(
        fold_plugin_apply_journal(&[start(vec![install_plugin(), install_plugin()])])
            .unwrap_err()
            .to_string()
            .contains("repeat")
    );
}

#[test]
fn validates_digest_wire_values_and_uninstall_command_direction() {
    assert!(PluginTargetStateDigestV2::new(format!("sha256:{}", "A".repeat(64))).is_err());
    assert!(PluginTargetStateDigestV2::new("sha256:abcd").is_err());
    assert_eq!(
        serde_json::from_str::<PluginTargetStateDigestV2>(&format!(
            "\"sha256:{}\"",
            "c".repeat(64)
        ))
        .unwrap(),
        digest('c')
    );

    let mut forged = observation('a');
    forged.digest = digest('b');
    assert!(
        fold_plugin_apply_journal(&[
            start(vec![install_plugin()]),
            event(
                2,
                PluginApplyJournalEventBodyV2::StepPrepared {
                    step_index: 0,
                    attempt: 1,
                    before: forged,
                },
            ),
        ])
        .unwrap_err()
        .to_string()
        .contains("does not match its target digest")
    );

    let uninstall_with_install = PluginApplyJournalEventV2 {
        body: PluginApplyJournalEventBodyV2::Started {
            idempotency_key: "plugin-uninstall:dure.beads:1".into(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: None,
            operation_kind: PluginApplyOperationKindV2::Uninstall,
            steps: vec![install_plugin()],
        },
        ..start(vec![install_plugin()])
    };
    assert!(
        fold_plugin_apply_journal(&[uninstall_with_install])
            .unwrap_err()
            .to_string()
            .contains("lifecycle operation")
    );
}
