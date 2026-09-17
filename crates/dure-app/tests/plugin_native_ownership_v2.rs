use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginNameV2, AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2,
    PhysicalTargetKeyV2, PluginApplyStepV2, PluginNativeOwnedComponentV2,
    PluginNativeOwnershipChangeV2, PluginNativeOwnershipErrorV2,
    PluginNativeOwnershipLedgerEventBodyV2, PluginNativeOwnershipLedgerEventV2,
    PluginNativeOwnershipReceiptV2, PluginResourcePathV2, PluginTargetStateDigestV2,
    PluginVersionV2, derive_plugin_native_ownership_ledger_event,
    fold_plugin_native_ownership_ledger, plugin_native_ownership_target,
};
use dure_app::{
    OperationEventIdV1, OperationIdV1, PluginApplyEffectDispositionV2,
    PluginApplyJournalEventBodyV2, PluginApplyJournalEventV2, PluginApplyOperationKindV2,
    PluginIdV2, PluginNativeCommandOutcomeV2, PluginNativeInstallationStateV2,
    PluginNativeMarketplaceStateV2, PluginNativeStateObservationV2, PluginNativeTargetStateV2,
    fold_plugin_apply_journal,
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

#[test]
fn add_and_remove_share_the_same_component_ownership_key() {
    let add_marketplace = step(AgentNativePluginCliCommandV2::AddMarketplace {
        source: dure_app::AgentNativePluginMarketplaceSourceV2 {
            resource: PluginResourcePathV2::new("./agents/codex/.agents/plugins/marketplace.json")
                .unwrap(),
        },
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let remove_marketplace = step(AgentNativePluginCliCommandV2::RemoveMarketplace {
        marketplace: selector().marketplace,
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let install_plugin = step(AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let remove_plugin = step(AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        preserve_data: true,
        output: AgentNativePluginCliOutputV2::Json,
    });

    let marketplace_add = plugin_native_ownership_target(&add_marketplace).unwrap();
    let marketplace_remove = plugin_native_ownership_target(&remove_marketplace).unwrap();
    let plugin_install = plugin_native_ownership_target(&install_plugin).unwrap();
    let plugin_remove = plugin_native_ownership_target(&remove_plugin).unwrap();

    assert_eq!(marketplace_add, marketplace_remove);
    assert_eq!(plugin_install, plugin_remove);
    assert_eq!(
        marketplace_add.component,
        PluginNativeOwnedComponentV2::Marketplace
    );
    assert_eq!(
        plugin_install.component,
        PluginNativeOwnedComponentV2::Plugin
    );
    assert_ne!(marketplace_add.key, plugin_install.key);
    assert!(marketplace_add.key.as_str().starts_with("sha256:"));
}

#[test]
fn key_separates_physical_target_scope_and_selector() {
    let command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    };
    let baseline = step(command.clone());

    let mut other_target = baseline.clone();
    other_target.registration_target = AgentNativePluginRegistrationTargetV2::ManagedProfile {
        profile_root_key: PhysicalTargetKeyV2::new("codex.profile.other").unwrap(),
    };
    let claude_selector = selector();
    let claude_project = PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new("dure.beads.claude").unwrap(),
        adapter: AgentAdapterIdV2::new("claude").unwrap(),
        executable: AgentNativePluginExecutableV2::Claude,
        cli_version: PluginVersionV2::new("2.1.220").unwrap(),
        selector: claude_selector.clone(),
        registration_target: AgentNativePluginRegistrationTargetV2::Workspace {
            profile_root_key: PhysicalTargetKeyV2::new("claude.profile.default").unwrap(),
            workspace_root_key: PhysicalTargetKeyV2::new("workspace.example").unwrap(),
        },
        command: AgentNativePluginCliCommandV2::InstallPlugin {
            selector: claude_selector.clone(),
            scope: AgentInstallScopeV2::Project,
            output: AgentNativePluginCliOutputV2::HumanText,
        },
    };
    let mut claude_local = claude_project.clone();
    claude_local.command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: claude_selector,
        scope: AgentInstallScopeV2::Local,
        output: AgentNativePluginCliOutputV2::HumanText,
    };
    let mut invalid_scope = baseline.clone();
    invalid_scope.command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::User,
        output: AgentNativePluginCliOutputV2::Json,
    };
    let mut other_selector = baseline.clone();
    other_selector.selector.plugin = AgentNativePluginNameV2::new("another-plugin").unwrap();
    other_selector.command = AgentNativePluginCliCommandV2::InstallPlugin {
        selector: other_selector.selector.clone(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    };

    let baseline_key = plugin_native_ownership_target(&baseline).unwrap().key;
    assert_ne!(
        baseline_key,
        plugin_native_ownership_target(&other_target).unwrap().key
    );
    assert_ne!(
        plugin_native_ownership_target(&claude_project).unwrap().key,
        plugin_native_ownership_target(&claude_local).unwrap().key
    );
    assert_ne!(
        baseline_key,
        plugin_native_ownership_target(&other_selector).unwrap().key
    );
    assert_eq!(
        plugin_native_ownership_target(&invalid_scope),
        Err(PluginNativeOwnershipErrorV2::InvalidRegistrationTarget)
    );
}

#[test]
fn read_only_commands_and_mismatched_adapters_cannot_claim_ownership() {
    let read_only = step(AgentNativePluginCliCommandV2::ListMarketplaces {
        output: AgentNativePluginCliOutputV2::Json,
    });
    assert_eq!(
        plugin_native_ownership_target(&read_only),
        Err(PluginNativeOwnershipErrorV2::ReadOnlyCommand)
    );

    let mut mismatched = step(AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    mismatched.adapter = AgentAdapterIdV2::new("claude").unwrap();
    assert_eq!(
        plugin_native_ownership_target(&mismatched),
        Err(PluginNativeOwnershipErrorV2::AdapterMismatch)
    );
}

fn ownership_receipt(operation: &str, event: &str) -> PluginNativeOwnershipReceiptV2 {
    let target =
        plugin_native_ownership_target(&step(AgentNativePluginCliCommandV2::InstallPlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        }))
        .unwrap();
    PluginNativeOwnershipReceiptV2 {
        target,
        owner_plugin_id: PluginIdV2::new("dure.beads").unwrap(),
        owner_plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
        owner_integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        owner_operation_id: OperationIdV1::new(operation).unwrap(),
        owner_event_id: OperationEventIdV1::new(event).unwrap(),
        owner_step_index: 1,
        owner_attempt: 1,
        after_digest: PluginTargetStateDigestV2::sha256("installed"),
        claimed_at_ms: 10,
    }
}

fn claim_event(ownership: PluginNativeOwnershipReceiptV2) -> PluginNativeOwnershipLedgerEventV2 {
    PluginNativeOwnershipLedgerEventV2 {
        revision: 1,
        journal_event_id: ownership.owner_event_id.clone(),
        operation_id: ownership.owner_operation_id.clone(),
        step_index: ownership.owner_step_index,
        attempt: ownership.owner_attempt,
        recorded_at_ms: ownership.claimed_at_ms,
        body: PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership },
    }
}

#[test]
fn ownership_ledger_claims_and_consumes_exact_receipts() {
    let ownership = ownership_receipt("install-operation", "install-effect");
    let claim = claim_event(ownership.clone());
    let release = PluginNativeOwnershipLedgerEventV2 {
        revision: 2,
        journal_event_id: OperationEventIdV1::new("uninstall-effect").unwrap(),
        operation_id: OperationIdV1::new("uninstall-operation").unwrap(),
        step_index: 0,
        attempt: 1,
        body: PluginNativeOwnershipLedgerEventBodyV2::Released {
            ownership: ownership.clone(),
            disposition: PluginApplyEffectDispositionV2::RemovedDureOwned,
        },
        recorded_at_ms: 20,
    };

    let projection = fold_plugin_native_ownership_ledger(std::slice::from_ref(&claim)).unwrap();
    assert_eq!(projection.get(&ownership.target.key), Some(&ownership));
    assert!(
        fold_plugin_native_ownership_ledger(&[claim, release])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ownership_ledger_rejects_duplicate_claims_and_stale_releases() {
    let ownership = ownership_receipt("install-operation", "install-effect");
    let claim = claim_event(ownership.clone());
    let mut duplicate = claim.clone();
    duplicate.revision = 2;
    assert!(matches!(
        fold_plugin_native_ownership_ledger(&[claim.clone(), duplicate]),
        Err(PluginNativeOwnershipErrorV2::InvalidLedger { .. })
    ));

    let mut stale_ownership = ownership.clone();
    stale_ownership.owner_operation_id = OperationIdV1::new("other-operation").unwrap();
    let stale_release = PluginNativeOwnershipLedgerEventV2 {
        revision: 2,
        journal_event_id: OperationEventIdV1::new("uninstall-effect").unwrap(),
        operation_id: OperationIdV1::new("uninstall-operation").unwrap(),
        step_index: 0,
        attempt: 1,
        body: PluginNativeOwnershipLedgerEventBodyV2::Released {
            ownership: stale_ownership,
            disposition: PluginApplyEffectDispositionV2::NoChange,
        },
        recorded_at_ms: 20,
    };
    assert!(matches!(
        fold_plugin_native_ownership_ledger(&[claim, stale_release]),
        Err(PluginNativeOwnershipErrorV2::InvalidLedger { .. })
    ));
}

fn apply_event(
    operation: &str,
    sequence: u32,
    body: PluginApplyJournalEventBodyV2,
) -> PluginApplyJournalEventV2 {
    PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(format!("{operation}-event-{sequence}")).unwrap(),
        operation_id: OperationIdV1::new(operation).unwrap(),
        sequence,
        body,
        recorded_at_ms: 100 + i64::from(sequence),
    }
}

fn observation(installed: bool) -> PluginNativeStateObservationV2 {
    PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
        marketplace: PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint: PluginTargetStateDigestV2::sha256("marketplace"),
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

fn folded_effect(
    operation: &str,
    operation_kind: PluginApplyOperationKindV2,
    mutation_step: PluginApplyStepV2,
    before: PluginNativeStateObservationV2,
    after: PluginNativeStateObservationV2,
    disposition: PluginApplyEffectDispositionV2,
) -> (
    Vec<PluginApplyJournalEventV2>,
    dure_app::PluginApplyJournalReceiptV2,
) {
    let events = vec![
        apply_event(
            operation,
            1,
            PluginApplyJournalEventBodyV2::Started {
                idempotency_key: format!("{operation}-request"),
                plugin_id: PluginIdV2::new("dure.beads").unwrap(),
                plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
                compensation_for: None,
                target_bindings: None,
                operation_kind,
                steps: vec![mutation_step],
            },
        ),
        apply_event(
            operation,
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before,
            },
        ),
        apply_event(
            operation,
            3,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after,
            },
        ),
        apply_event(
            operation,
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition,
            },
        ),
    ];
    let receipt = fold_plugin_apply_journal(&events).unwrap();
    (events, receipt)
}

#[test]
fn ownership_change_derives_claim_and_rejects_a_fabricated_existing_owner() {
    let install = step(AgentNativePluginCliCommandV2::InstallPlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let (events, receipt) = folded_effect(
        "install-operation",
        PluginApplyOperationKindV2::Install,
        install,
        observation(false),
        observation(true),
        PluginApplyEffectDispositionV2::CreatedDureOwned,
    );
    let effect_event = events.last().unwrap();
    let derived = derive_plugin_native_ownership_ledger_event(PluginNativeOwnershipChangeV2 {
        revision: 1,
        journal_event: effect_event,
        receipt: &receipt,
        existing: None,
    })
    .unwrap()
    .unwrap();
    let PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } = &derived.body else {
        panic!("install effect did not derive an ownership claim");
    };
    assert_eq!(ownership.owner_event_id, effect_event.event_id);
    assert_eq!(ownership.after_digest, receipt.effects[0].after.digest);

    assert!(matches!(
        derive_plugin_native_ownership_ledger_event(PluginNativeOwnershipChangeV2 {
            revision: 2,
            journal_event: effect_event,
            receipt: &receipt,
            existing: Some(ownership),
        }),
        Err(PluginNativeOwnershipErrorV2::InvalidChange { .. })
    ));
}

#[test]
fn no_change_uninstall_consumes_a_current_ownership_receipt() {
    let ownership = ownership_receipt("install-operation", "install-effect");
    let remove = step(AgentNativePluginCliCommandV2::RemovePlugin {
        selector: selector(),
        scope: AgentInstallScopeV2::Managed,
        preserve_data: true,
        output: AgentNativePluginCliOutputV2::Json,
    });
    let absent = observation(false);
    let (events, receipt) = folded_effect(
        "uninstall-operation",
        PluginApplyOperationKindV2::Uninstall,
        remove,
        absent.clone(),
        absent,
        PluginApplyEffectDispositionV2::NoChange,
    );
    let derived = derive_plugin_native_ownership_ledger_event(PluginNativeOwnershipChangeV2 {
        revision: 2,
        journal_event: events.last().unwrap(),
        receipt: &receipt,
        existing: Some(&ownership),
    })
    .unwrap()
    .unwrap();
    assert!(matches!(
        derived.body,
        PluginNativeOwnershipLedgerEventBodyV2::Released {
            disposition: PluginApplyEffectDispositionV2::NoChange,
            ..
        }
    ));
}
