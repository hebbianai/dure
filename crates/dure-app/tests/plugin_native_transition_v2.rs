use dure_app::{
    AgentInstallScopeV2, AgentNativeMarketplaceNameV2, AgentNativePluginCliCommandV2,
    AgentNativePluginCliOutputV2, AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginSelectorV2, PluginApplyEffectDispositionV2, PluginApplyStepCheckpointV2,
    PluginApplyStepReconciliationV2, PluginNativeCheckpointReconciliationV2,
    PluginNativeCommandOutcomeV2, PluginNativeExistingOwnershipV2, PluginNativeInstallationStateV2,
    PluginNativeMarketplaceStateV2, PluginNativeMutationObservationV2,
    PluginNativeReconciliationErrorV2, PluginNativeStateObservationV2, PluginNativeTargetStateV2,
    PluginNativeTransitionErrorV2, PluginResourcePathV2, PluginTargetStateDigestV2,
    PluginVersionV2, classify_plugin_native_mutation, reconcile_plugin_native_checkpoint,
};

fn version(value: &str) -> PluginVersionV2 {
    PluginVersionV2::new(value).unwrap()
}

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
    }
}

fn marketplace(scope: AgentInstallScopeV2, source: &[u8]) -> PluginNativeMarketplaceStateV2 {
    PluginNativeMarketplaceStateV2::Registered {
        source_fingerprint: PluginTargetStateDigestV2::sha256(source),
        matches_expected_source: true,
        scope,
    }
}

fn installed(scope: AgentInstallScopeV2, version_value: &str) -> PluginNativeInstallationStateV2 {
    PluginNativeInstallationStateV2::Installed {
        version: version(version_value),
        enabled: true,
        scope,
    }
}

fn state(
    marketplace: PluginNativeMarketplaceStateV2,
    installation: PluginNativeInstallationStateV2,
) -> PluginNativeTargetStateV2 {
    PluginNativeTargetStateV2 {
        marketplace,
        installation,
    }
}

fn classify(
    command: &AgentNativePluginCliCommandV2,
    ownership: PluginNativeExistingOwnershipV2,
    before: &PluginNativeTargetStateV2,
    after: &PluginNativeTargetStateV2,
) -> Result<PluginApplyEffectDispositionV2, PluginNativeTransitionErrorV2> {
    classify_plugin_native_mutation(PluginNativeMutationObservationV2 {
        command,
        expected_plugin_version: &version("0.1.0"),
        existing_ownership: ownership,
        before,
        after,
    })
}

fn reconcile(
    command: &AgentNativePluginCliCommandV2,
    ownership: PluginNativeExistingOwnershipV2,
    before: &PluginNativeTargetStateV2,
    outcome: Option<PluginNativeCommandOutcomeV2>,
    after: Option<&PluginNativeTargetStateV2>,
    observed: &PluginNativeStateObservationV2,
) -> Result<PluginApplyStepReconciliationV2, PluginNativeReconciliationErrorV2> {
    let checkpoint = PluginApplyStepCheckpointV2 {
        step_index: 0,
        attempt: 1,
        before: PluginNativeStateObservationV2::new(before.clone()),
        outcome,
        after: after.cloned().map(PluginNativeStateObservationV2::new),
    };
    reconcile_plugin_native_checkpoint(PluginNativeCheckpointReconciliationV2 {
        command,
        expected_plugin_version: &version("0.1.0"),
        existing_ownership: ownership,
        checkpoint: &checkpoint,
        observed,
    })
}

#[test]
fn additions_create_new_state_and_preserve_existing_ownership() {
    let scope = AgentInstallScopeV2::Managed;
    let command = AgentNativePluginCliCommandV2::AddMarketplace {
        source: AgentNativePluginMarketplaceSourceV2 {
            resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
        },
        scope: scope.clone(),
        output: AgentNativePluginCliOutputV2::Json,
    };
    let absent = state(
        PluginNativeMarketplaceStateV2::Absent,
        PluginNativeInstallationStateV2::Absent,
    );
    let expected = state(
        marketplace(scope, b"expected"),
        PluginNativeInstallationStateV2::Absent,
    );

    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &absent,
            &expected,
        )
        .unwrap(),
        PluginApplyEffectDispositionV2::CreatedDureOwned
    );
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &expected,
            &expected,
        )
        .unwrap(),
        PluginApplyEffectDispositionV2::PreservedExternal
    );
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::DureOwned,
            &expected,
            &expected,
        )
        .unwrap(),
        PluginApplyEffectDispositionV2::PreservedDureOwned
    );
}

#[test]
fn additions_reject_foreign_replacement_and_collateral_changes() {
    let scope = AgentInstallScopeV2::Managed;
    let command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: scope.clone(),
        output: AgentNativePluginCliOutputV2::Json,
    };
    let registered = marketplace(scope.clone(), b"expected");
    let old = state(registered.clone(), installed(scope.clone(), "0.0.9"));
    let desired = state(registered.clone(), installed(scope.clone(), "0.1.0"));
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::DureOwned,
            &old,
            &desired,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::ExistingStateWouldBeOverwritten
    );

    let absent = state(registered, PluginNativeInstallationStateV2::Absent);
    let changed_marketplace = state(
        marketplace(scope.clone(), b"other"),
        installed(scope, "0.1.0"),
    );
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &absent,
            &changed_marketplace,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::CollateralStateChanged
    );

    let missing_marketplace = state(
        PluginNativeMarketplaceStateV2::Absent,
        installed(AgentInstallScopeV2::Managed, "0.1.0"),
    );
    let empty = state(
        PluginNativeMarketplaceStateV2::Absent,
        PluginNativeInstallationStateV2::Absent,
    );
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &empty,
            &missing_marketplace,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::DependentStateConflict
    );
}

#[test]
fn removals_require_exact_dure_owned_state() {
    let scope = AgentInstallScopeV2::Local;
    let command = AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: scope.clone(),
        preserve_data: true,
        output: AgentNativePluginCliOutputV2::HumanText,
    };
    let registered = marketplace(scope.clone(), b"expected");
    let before = state(registered.clone(), installed(scope.clone(), "0.1.0"));
    let after = state(registered, PluginNativeInstallationStateV2::Absent);

    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::DureOwned,
            &before,
            &after,
        )
        .unwrap(),
        PluginApplyEffectDispositionV2::RemovedDureOwned
    );
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &before,
            &after,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::OwnershipRequired
    );

    let drifted = state(after.marketplace.clone(), installed(scope, "0.2.0"));
    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::DureOwned,
            &drifted,
            &after,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::ExistingStateWouldBeOverwritten
    );
}

#[test]
fn successful_mutations_must_reach_the_exact_expected_post_state() {
    let scope = AgentInstallScopeV2::Managed;
    let command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: scope.clone(),
        output: AgentNativePluginCliOutputV2::Json,
    };
    let before = state(
        marketplace(scope.clone(), b"expected"),
        PluginNativeInstallationStateV2::Absent,
    );
    let disabled = state(
        before.marketplace.clone(),
        PluginNativeInstallationStateV2::Installed {
            version: version("0.1.0"),
            enabled: false,
            scope,
        },
    );

    assert_eq!(
        classify(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &before,
            &disabled,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::UnexpectedPostState
    );

    let destructive_remove = AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        preserve_data: false,
        output: AgentNativePluginCliOutputV2::Json,
    };
    assert_eq!(
        classify(
            &destructive_remove,
            PluginNativeExistingOwnershipV2::DureOwned,
            &disabled,
            &before,
        )
        .unwrap_err(),
        PluginNativeTransitionErrorV2::DestructiveDataRemoval
    );
}

#[test]
fn crash_reconciliation_distinguishes_not_applied_applied_and_diverged() {
    let scope = AgentInstallScopeV2::Managed;
    let command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: scope.clone(),
        output: AgentNativePluginCliOutputV2::Json,
    };
    let before = state(
        marketplace(scope.clone(), b"expected"),
        PluginNativeInstallationStateV2::Absent,
    );
    let after = state(
        before.marketplace.clone(),
        installed(scope.clone(), "0.1.0"),
    );

    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &before,
            None,
            None,
            &PluginNativeStateObservationV2::new(before.clone()),
        )
        .unwrap(),
        PluginApplyStepReconciliationV2::NotApplied
    );
    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &before,
            None,
            None,
            &PluginNativeStateObservationV2::new(after.clone()),
        )
        .unwrap(),
        PluginApplyStepReconciliationV2::Applied {
            disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
        }
    );

    let drifted = state(marketplace(scope, b"foreign"), after.installation.clone());
    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &before,
            None,
            None,
            &PluginNativeStateObservationV2::new(drifted),
        )
        .unwrap(),
        PluginApplyStepReconciliationV2::Diverged
    );
}

#[test]
fn persisted_success_reconciles_its_exact_snapshot_and_rejects_invalid_evidence() {
    let scope = AgentInstallScopeV2::Managed;
    let command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: scope.clone(),
        output: AgentNativePluginCliOutputV2::Json,
    };
    let desired = state(
        marketplace(scope, b"expected"),
        installed(AgentInstallScopeV2::Managed, "0.1.0"),
    );
    let observed = PluginNativeStateObservationV2::new(desired.clone());

    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &desired,
            Some(PluginNativeCommandOutcomeV2::Succeeded),
            Some(&desired),
            &observed,
        )
        .unwrap(),
        PluginApplyStepReconciliationV2::Applied {
            disposition: PluginApplyEffectDispositionV2::PreservedExternal,
        }
    );
    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &desired,
            Some(PluginNativeCommandOutcomeV2::Succeeded),
            None,
            &observed,
        )
        .unwrap_err(),
        PluginNativeReconciliationErrorV2::MissingSuccessfulObservation
    );

    let mut forged = observed;
    forged.digest = PluginTargetStateDigestV2::sha256(b"forged");
    assert_eq!(
        reconcile(
            &command,
            PluginNativeExistingOwnershipV2::Unproven,
            &desired,
            None,
            None,
            &forged,
        )
        .unwrap_err(),
        PluginNativeReconciliationErrorV2::InvalidObservedState
    );
}
