use std::sync::Arc;

use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, DomainStoreErrorV1,
    OperationEventIdV1, OperationIdV1, PhysicalTargetKeyV2, PluginApplyCompensationLinkV2,
    PluginApplyEffectDispositionV2, PluginApplyJournalEventBodyV2, PluginApplyJournalEventV2,
    PluginApplyJournalStateV2, PluginApplyJournalStore, PluginApplyOperationKindV2,
    PluginApplyRecoveryStrategyV2, PluginApplyStepReconciliationV2, PluginApplyStepV2, PluginIdV2,
    PluginNativeApplyAuthorityStore, PluginNativeCommandOutcomeV2, PluginNativeInstallationStateV2,
    PluginNativeMarketplaceStateV2, PluginNativePhysicalTargetBindingV2,
    PluginNativePhysicalTargetDigestV2, PluginNativePhysicalTargetRoleV2,
    PluginNativeStateObservationV2, PluginNativeTargetStateV2, PluginResourcePathV2,
    PluginTargetStateDigestV2, PluginVersionV2, plan_plugin_apply_compensation,
    plugin_apply_compensation_identity, plugin_native_ownership_target,
};
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;

fn digest(fill: char) -> PluginTargetStateDigestV2 {
    PluginTargetStateDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64))).unwrap()
}

fn target_bindings() -> Vec<PluginNativePhysicalTargetBindingV2> {
    vec![target_binding(
        "codex.profile.default",
        PluginNativePhysicalTargetRoleV2::ProfileRoot,
        ['d', 'e', 'f'],
    )]
}

fn target_binding(
    key: &str,
    role: PluginNativePhysicalTargetRoleV2,
    fills: [char; 3],
) -> PluginNativePhysicalTargetBindingV2 {
    let digest = |fill: char| {
        PluginNativePhysicalTargetDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64)))
            .unwrap()
    };
    PluginNativePhysicalTargetBindingV2 {
        key: PhysicalTargetKeyV2::new(key).unwrap(),
        role,
        canonical_path_identity: digest(fills[0]),
        filesystem_object_identity: digest(fills[1]),
        authority_generation_identity: digest('0'),
        authority_identity: digest(fills[2]),
        binding_identity: digest(fills[2]),
    }
}

fn observation(fill: char) -> PluginNativeStateObservationV2 {
    PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
        marketplace: PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint: digest('c'),
            matches_expected_source: true,
            scope: AgentInstallScopeV2::Managed,
        },
        installation: if fill == 'b' {
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

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn install_step() -> PluginApplyStepV2 {
    PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        cli_version: PluginVersionV2::new("0.146.0").unwrap(),
        selector: selector(),
        registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: PhysicalTargetKeyV2::new("codex.profile.default").unwrap(),
        },
        command: AgentNativePluginCliCommandV2::InstallPlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    }
}

fn list_marketplaces_step() -> PluginApplyStepV2 {
    let mut step = install_step();
    step.command = AgentNativePluginCliCommandV2::ListMarketplaces {
        output: AgentNativePluginCliOutputV2::Json,
    };
    step
}

fn marketplace_source() -> AgentNativePluginMarketplaceSourceV2 {
    AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./agents/codex/.agents/plugins/marketplace.json")
            .unwrap(),
    }
}

fn event(
    operation: &str,
    sequence: u32,
    body: PluginApplyJournalEventBodyV2,
) -> PluginApplyJournalEventV2 {
    PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(format!("{operation}-event-{sequence}")).unwrap(),
        operation_id: OperationIdV1::new(operation).unwrap(),
        sequence,
        body,
        recorded_at_ms: 1_000 + i64::from(sequence),
    }
}

fn started(operation: &str, idempotency_key: &str) -> PluginApplyJournalEventV2 {
    event(
        operation,
        1,
        PluginApplyJournalEventBodyV2::Started {
            idempotency_key: idempotency_key.into(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: Some(target_bindings()),
            operation_kind: PluginApplyOperationKindV2::Install,
            steps: vec![install_step()],
        },
    )
}

#[tokio::test]
async fn append_replay_reconcile_and_rebuild_are_transactional() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();
    let start = started("plugin-operation-1", "plugin-request-1");
    let initial = store.append_plugin_apply_event(&start).await.unwrap();
    assert_eq!(initial.state, PluginApplyJournalStateV2::Applying);
    assert_eq!(
        store.append_plugin_apply_event(&start).await.unwrap(),
        initial
    );

    for next in [
        event(
            "plugin-operation-1",
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before: observation('a'),
            },
        ),
        event(
            "plugin-operation-1",
            3,
            PluginApplyJournalEventBodyV2::StepReconciled {
                step_index: 0,
                attempt: 1,
                observed: observation('a'),
                resolution: PluginApplyStepReconciliationV2::NotApplied,
            },
        ),
        event(
            "plugin-operation-1",
            4,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 2,
                before: observation('a'),
            },
        ),
        event(
            "plugin-operation-1",
            5,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 2,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after: observation('b'),
            },
        ),
        event(
            "plugin-operation-1",
            6,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 2,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
        event(
            "plugin-operation-1",
            7,
            PluginApplyJournalEventBodyV2::Succeeded,
        ),
    ] {
        store.append_plugin_apply_event(&next).await.unwrap();
    }

    let operation_id = OperationIdV1::new("plugin-operation-1").unwrap();
    let receipt = store
        .plugin_apply_receipt(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, PluginApplyJournalStateV2::Succeeded);
    assert_eq!(receipt.effects.len(), 1);
    let ownership_event_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_ownership_events")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let ownership_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_ownership")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(ownership_event_count, 1);
    assert_eq!(ownership_count, 1);
    let ownership_target = plugin_native_ownership_target(&install_step()).unwrap();
    let ownership = store
        .plugin_native_ownership(&ownership_target.key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ownership.target, ownership_target);

    sqlx::query("DELETE FROM plugin_apply_receipts")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.rebuild_plugin_apply_receipts().await.unwrap(), 1);
    assert_eq!(
        store.plugin_apply_receipt(&operation_id).await.unwrap(),
        Some(receipt)
    );
    sqlx::query("DELETE FROM plugin_native_ownership")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.rebuild_plugin_native_ownership().await.unwrap(), 1);
    assert_eq!(
        store
            .plugin_native_ownership(&ownership.target.key)
            .await
            .unwrap(),
        Some(ownership)
    );
}

#[tokio::test]
async fn conflicting_replays_and_stale_projections_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let start = started("plugin-operation-1", "plugin-request-1");
    store.append_plugin_apply_event(&start).await.unwrap();

    let mut conflicting = start.clone();
    conflicting.recorded_at_ms += 1;
    assert!(matches!(
        store.append_plugin_apply_event(&conflicting).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    sqlx::query(
        "UPDATE plugin_apply_receipts SET state = 'recovery_required' WHERE operation_id = ?1",
    )
    .bind(start.operation_id.as_str())
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.plugin_apply_receipt(&start.operation_id).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_plugin_apply_receipt",
            ..
        })
    ));

    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .plugin_apply_receipt(&start.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        PluginApplyJournalStateV2::Applying
    );
}

#[tokio::test]
async fn unsafe_ownership_effect_rolls_back_journal_and_projection_together() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();
    let operation = "unsafe-ownership-operation";
    for next in [
        started(operation, "unsafe-ownership-request"),
        event(
            operation,
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before: observation('a'),
            },
        ),
        event(
            operation,
            3,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after: PluginNativeStateObservationV2::new(PluginNativeTargetStateV2 {
                    marketplace: PluginNativeMarketplaceStateV2::Registered {
                        source_fingerprint: digest('d'),
                        matches_expected_source: true,
                        scope: AgentInstallScopeV2::Managed,
                    },
                    installation: PluginNativeInstallationStateV2::Absent,
                }),
            },
        ),
    ] {
        store.append_plugin_apply_event(&next).await.unwrap();
    }

    let unsafe_effect = event(
        operation,
        4,
        PluginApplyJournalEventBodyV2::EffectRecorded {
            step_index: 0,
            attempt: 1,
            disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
        },
    );
    assert!(matches!(
        store.append_plugin_apply_event(&unsafe_effect).await,
        Err(DomainStoreErrorV1::Storage {
            code: "invalid_plugin_native_ownership",
            ..
        })
    ));

    let event_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM plugin_apply_events WHERE operation_id = ?1")
            .bind(operation)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let ownership_event_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_ownership_events")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let receipt = store
        .plugin_apply_receipt(&OperationIdV1::new(operation).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event_count, 3);
    assert_eq!(ownership_event_count, 0);
    assert_eq!(receipt.last_sequence, 3);
}

#[tokio::test]
async fn compensation_completion_requires_the_exact_successful_child_stream() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let parent = "compensation-parent";
    let parent_id = OperationIdV1::new(parent).unwrap();
    let parent_events = [
        event(
            parent,
            1,
            PluginApplyJournalEventBodyV2::Started {
                idempotency_key: "compensation-parent-request".into(),
                plugin_id: PluginIdV2::new("dure.beads").unwrap(),
                plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
                compensation_for: None,
                target_bindings: Some(target_bindings()),
                operation_kind: PluginApplyOperationKindV2::Install,
                steps: vec![install_step(), list_marketplaces_step()],
            },
        ),
        event(
            parent,
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before: observation('a'),
            },
        ),
        event(
            parent,
            3,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after: observation('b'),
            },
        ),
        event(
            parent,
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
        event(
            parent,
            5,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 1,
                attempt: 1,
                before: observation('b'),
            },
        ),
        event(
            parent,
            6,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 1,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(2) },
                after: observation('b'),
            },
        ),
        event(
            parent,
            7,
            PluginApplyJournalEventBodyV2::RecoveryResumed {
                strategy: PluginApplyRecoveryStrategyV2::CompensateOwned,
            },
        ),
    ];
    let mut parent_receipt = None;
    for next in parent_events {
        parent_receipt = Some(store.append_plugin_apply_event(&next).await.unwrap());
    }
    let parent_receipt = parent_receipt.unwrap();
    let steps = plan_plugin_apply_compensation(&parent_receipt, &marketplace_source()).unwrap();
    let (child_id, child_idempotency_key) = plugin_apply_compensation_identity(&parent_id).unwrap();
    let link = PluginApplyCompensationLinkV2 {
        operation_id: child_id.clone(),
        idempotency_key: child_idempotency_key.clone(),
        marketplace_source: marketplace_source(),
        steps,
    };
    store
        .append_plugin_apply_event(&event(
            parent,
            8,
            PluginApplyJournalEventBodyV2::CompensationLinked { link: link.clone() },
        ))
        .await
        .unwrap();
    let completed = event(
        parent,
        9,
        PluginApplyJournalEventBodyV2::Compensated {
            operation_id: child_id.clone(),
        },
    );
    assert!(matches!(
        store.append_plugin_apply_event(&completed).await,
        Err(DomainStoreErrorV1::Storage {
            code: "invalid_plugin_apply_compensation",
            ..
        })
    ));

    let child = child_id.as_str();
    let child_step = link.steps[0].step.clone();
    for next in [
        event(
            child,
            1,
            PluginApplyJournalEventBodyV2::Started {
                idempotency_key: child_idempotency_key,
                plugin_id: PluginIdV2::new("dure.beads").unwrap(),
                plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
                compensation_for: Some(parent_id.clone()),
                target_bindings: Some(target_bindings()),
                operation_kind: PluginApplyOperationKindV2::Uninstall,
                steps: vec![child_step],
            },
        ),
        event(
            child,
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before: observation('b'),
            },
        ),
        event(
            child,
            3,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after: observation('a'),
            },
        ),
        event(
            child,
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::RemovedDureOwned,
            },
        ),
        event(child, 5, PluginApplyJournalEventBodyV2::Succeeded),
    ] {
        store.append_plugin_apply_event(&next).await.unwrap();
    }

    let receipt = store.append_plugin_apply_event(&completed).await.unwrap();
    assert_eq!(receipt.state, PluginApplyJournalStateV2::Compensated);
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .plugin_apply_receipt(&parent_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        PluginApplyJournalStateV2::Compensated
    );
}

#[tokio::test]
async fn reopening_fails_closed_when_ownership_ledger_indexes_are_corrupt() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let operation = "corrupt-ownership-operation";
    for next in [
        started(operation, "corrupt-ownership-request"),
        event(
            operation,
            2,
            PluginApplyJournalEventBodyV2::StepPrepared {
                step_index: 0,
                attempt: 1,
                before: observation('a'),
            },
        ),
        event(
            operation,
            3,
            PluginApplyJournalEventBodyV2::StepObserved {
                step_index: 0,
                attempt: 1,
                outcome: PluginNativeCommandOutcomeV2::Succeeded,
                after: observation('b'),
            },
        ),
        event(
            operation,
            4,
            PluginApplyJournalEventBodyV2::EffectRecorded {
                step_index: 0,
                attempt: 1,
                disposition: PluginApplyEffectDispositionV2::CreatedDureOwned,
            },
        ),
    ] {
        store.append_plugin_apply_event(&next).await.unwrap();
    }
    sqlx::query("UPDATE plugin_native_ownership_events SET action = 'released'")
        .execute(&store.pool)
        .await
        .unwrap();
    store.close().await;

    assert!(matches!(
        SqliteDomainStore::open(&path).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_plugin_native_ownership_event",
            ..
        })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_serialize_idempotency_key_ownership() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .append_plugin_apply_event(&started("plugin-operation-a", "shared-plugin-request"))
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .append_plugin_apply_event(&started("plugin-operation-b", "shared-plugin-request"))
            .await
    });

    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(DomainStoreErrorV1::IdempotencyConflict { .. })))
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_first_bind_serializes_conflicting_physical_identities() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let first_event = started("binding-race-a", "binding-race-a-request");
    let mut second_event = started("binding-race-b", "binding-race-b-request");
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings: second_bindings,
        ..
    } = &mut second_event.body
    else {
        unreachable!();
    };
    *second_bindings = Some(vec![target_binding(
        "codex.profile.default",
        PluginNativePhysicalTargetRoleV2::ProfileRoot,
        ['1', '2', '3'],
    )]);
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store.append_plugin_apply_event(&first_event).await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store.append_plugin_apply_event(&second_event).await
    });

    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "plugin_native_physical_target",
                    ..
                })
            ))
            .count(),
        1
    );

    let verifier = SqliteDomainStore::open(&path).await.unwrap();
    let event_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM plugin_apply_events WHERE operation_id IN ('binding-race-a', 'binding-race-b')",
    )
    .fetch_one(&verifier.pool)
    .await
    .unwrap();
    let binding_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_target_bindings")
            .fetch_one(&verifier.pool)
            .await
            .unwrap();
    assert_eq!(event_count, 1);
    assert_eq!(binding_count, 1);
}

#[tokio::test]
async fn physical_target_binding_is_immutable_rebuildable_and_conflict_atomic() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();
    store
        .append_plugin_apply_event(&started("binding-first", "binding-first-request"))
        .await
        .unwrap();

    let mut legacy = started("binding-legacy", "binding-legacy-request");
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings: legacy_bindings,
        ..
    } = &mut legacy.body
    else {
        unreachable!();
    };
    *legacy_bindings = None;
    assert!(matches!(
        store.append_plugin_apply_event(&legacy).await,
        Err(DomainStoreErrorV1::Storage {
            code: "legacy_plugin_native_target_unbound",
            ..
        })
    ));
    assert!(
        store
            .plugin_apply_receipt(&legacy.operation_id)
            .await
            .unwrap()
            .is_none()
    );

    let mut conflicting = started("binding-conflict", "binding-conflict-request");
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings: bindings_slot,
        ..
    } = &mut conflicting.body
    else {
        unreachable!();
    };
    *bindings_slot = Some(vec![target_binding(
        "codex.profile.default",
        PluginNativePhysicalTargetRoleV2::ProfileRoot,
        ['1', '2', '3'],
    )]);
    assert!(matches!(
        store.append_plugin_apply_event(&conflicting).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "plugin_native_physical_target",
            ..
        })
    ));
    assert!(
        store
            .plugin_apply_receipt(&conflicting.operation_id)
            .await
            .unwrap()
            .is_none()
    );

    sqlx::query("DELETE FROM plugin_native_target_bindings")
        .execute(&store.pool)
        .await
        .unwrap();
    let rebound = started("binding-after-erasure", "binding-after-erasure-request");
    assert!(matches!(
        store.append_plugin_apply_event(&rebound).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_plugin_native_target_binding_projection",
            ..
        })
    ));
    assert!(
        store
            .plugin_apply_receipt(&rebound.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.rebuild_plugin_native_target_bindings().await.unwrap(),
        1
    );
    store
        .validate_plugin_native_target_bindings(
            &OperationIdV1::new("binding-first").unwrap(),
            &target_bindings(),
        )
        .await
        .unwrap();

    store
        .append_plugin_apply_event(&started("binding-second", "binding-second-request"))
        .await
        .unwrap();
    sqlx::query(
        r#"
        UPDATE plugin_native_target_bindings
        SET bound_by_operation_id = 'binding-second',
            bound_by_event_id = 'binding-second-event-1',
            bound_at_ms = 1001
        WHERE physical_target_key = 'codex.profile.default'
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store
            .validate_plugin_native_target_bindings(
                &OperationIdV1::new("binding-first").unwrap(),
                &target_bindings(),
            )
            .await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_plugin_native_target_binding_projection",
            ..
        })
    ));
    assert_eq!(
        store.rebuild_plugin_native_target_bindings().await.unwrap(),
        1
    );
    let provenance: (String, String, i64) = sqlx::query_as(
        r#"
        SELECT bound_by_operation_id, bound_by_event_id, bound_at_ms
        FROM plugin_native_target_bindings
        WHERE physical_target_key = 'codex.profile.default'
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        provenance,
        ("binding-first".into(), "binding-first-event-1".into(), 1001,)
    );
}

#[tokio::test]
async fn binding_provenance_is_canonical_across_reverse_insert_vacuum_and_rebuild() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();
    let mut inserted_first = started("z-binding-source", "z-binding-source-request");
    inserted_first.recorded_at_ms = 2_000;
    let mut same_time_later_operation = started("y-binding-source", "y-binding-source-request");
    same_time_later_operation.recorded_at_ms = 1_000;
    let mut canonical = started("a-binding-source", "a-binding-source-request");
    canonical.recorded_at_ms = 1_000;

    for event in [&inserted_first, &same_time_later_operation, &canonical] {
        store.append_plugin_apply_event(event).await.unwrap();
    }

    let provenance = async {
        sqlx::query_as::<_, (String, String, i64)>(
            r#"
            SELECT bound_by_operation_id, bound_by_event_id, bound_at_ms
            FROM plugin_native_target_bindings
            WHERE physical_target_key = 'codex.profile.default'
            "#,
        )
        .fetch_one(&store.pool)
        .await
        .unwrap()
    };
    let expected = (
        canonical.operation_id.as_str().to_owned(),
        canonical.event_id.as_str().to_owned(),
        canonical.recorded_at_ms,
    );
    assert_eq!(provenance.await, expected);

    sqlx::query("VACUUM").execute(&store.pool).await.unwrap();
    store
        .validate_plugin_native_target_bindings(&inserted_first.operation_id, &target_bindings())
        .await
        .unwrap();
    let after_vacuum: (String, String, i64) = sqlx::query_as(
        r#"
        SELECT bound_by_operation_id, bound_by_event_id, bound_at_ms
        FROM plugin_native_target_bindings
        WHERE physical_target_key = 'codex.profile.default'
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(after_vacuum, expected);

    assert_eq!(
        store.rebuild_plugin_native_target_bindings().await.unwrap(),
        1
    );
    let after_rebuild: (String, String, i64) = sqlx::query_as(
        r#"
        SELECT bound_by_operation_id, bound_by_event_id, bound_at_ms
        FROM plugin_native_target_bindings
        WHERE physical_target_key = 'codex.profile.default'
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(after_rebuild, expected);
}

#[tokio::test]
async fn multi_target_conflict_rolls_back_every_missing_binding() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();
    let workspace_step = |profile_key: &str, workspace_key: &str| {
        let mut step = install_step();
        step.adapter = AgentAdapterIdV2::new("claude").unwrap();
        step.executable = AgentNativePluginExecutableV2::Claude;
        step.registration_target = AgentNativePluginRegistrationTargetV2::Workspace {
            profile_root_key: PhysicalTargetKeyV2::new(profile_key).unwrap(),
            workspace_root_key: PhysicalTargetKeyV2::new(workspace_key).unwrap(),
        };
        step.command = AgentNativePluginCliCommandV2::InstallPlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Project,
            output: AgentNativePluginCliOutputV2::Json,
        };
        step
    };
    let start = |operation: &str,
                 workspace_key: &str,
                 bindings: Vec<PluginNativePhysicalTargetBindingV2>| {
        event(
            operation,
            1,
            PluginApplyJournalEventBodyV2::Started {
                idempotency_key: format!("{operation}-request"),
                plugin_id: PluginIdV2::new("dure.beads").unwrap(),
                plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
                compensation_for: None,
                target_bindings: Some(bindings),
                operation_kind: PluginApplyOperationKindV2::Install,
                steps: vec![workspace_step("profile", workspace_key)],
            },
        )
    };
    let first = start(
        "batch-first",
        "workspace-old",
        vec![
            target_binding(
                "profile",
                PluginNativePhysicalTargetRoleV2::ProfileRoot,
                ['1', '2', '3'],
            ),
            target_binding(
                "workspace-old",
                PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
                ['4', '5', '6'],
            ),
        ],
    );
    store.append_plugin_apply_event(&first).await.unwrap();

    let conflicting = start(
        "batch-conflict",
        "workspace-new",
        vec![
            target_binding(
                "profile",
                PluginNativePhysicalTargetRoleV2::ProfileRoot,
                ['7', '8', '9'],
            ),
            target_binding(
                "workspace-new",
                PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
                ['a', 'b', 'c'],
            ),
        ],
    );
    assert!(matches!(
        store.append_plugin_apply_event(&conflicting).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_target_bindings")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let new_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM plugin_native_target_bindings WHERE physical_target_key = 'workspace-new'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(new_count, 0);

    sqlx::query(
        "DELETE FROM plugin_native_target_bindings WHERE physical_target_key = 'workspace-old'",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let after_erasure = start(
        "batch-after-erasure",
        "workspace-newer",
        vec![
            target_binding(
                "profile",
                PluginNativePhysicalTargetRoleV2::ProfileRoot,
                ['1', '2', '3'],
            ),
            target_binding(
                "workspace-newer",
                PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
                ['d', 'e', 'f'],
            ),
        ],
    );
    assert!(matches!(
        store.append_plugin_apply_event(&after_erasure).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_plugin_native_target_binding_projection",
            ..
        })
    ));
}
