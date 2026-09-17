use super::*;

#[test]
fn a_bound_request_cannot_be_admitted_under_another_operation_id() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let root = tempfile::tempdir().unwrap();
        let checkpoint = checkpoint(serde_json::json!({"runtime": "/selected/runtime"}));
        let mut prepared: PreparedStandaloneUpgrade<serde_json::Value> =
            PreparedStandaloneUpgrade::read(&checkpoint).unwrap();
        let mut source = serde_json::to_value(&prepared.source).unwrap();
        source["discoveryRoot"] = serde_json::to_value(root.path()).unwrap();
        prepared.source = serde_json::from_value(source).unwrap();
        let create = prepared
            .replacement
            .take()
            .unwrap()
            .create
            .with_recovery_operation_id("different-operation")
            .unwrap();
        prepared.replacement = Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create,
            context: serde_json::json!({"runtime": "/selected/runtime"}),
        });
        let identity = PreparedRecoveryIdentity {
            recovery_id: "admitted-operation".into(),
            source_session_id: prepared.source.generation().fence.session_id.clone(),
            source_workspace_id: prepared.source.generation().fence.workspace_id.clone(),
            action,
            legacy_request_fingerprint: None,
        };
        let result = reserve_prepared(
            root.path(),
            identity,
            Some(serde_json::to_string(&prepared).unwrap()),
        );
        assert!(
            result.is_err(),
            "a wrong binding reached durable source admission"
        );
        assert_eq!(
            journal::inspect_existing(root.path())
                .unwrap()
                .operation_records,
            0
        );
    }
}

fn candidate(
    create: &StandaloneCreateRequest,
    action: &'static str,
    source: StandaloneReplacementSource,
) -> (PreparedRecoveryIdentity, String) {
    let create = create
        .clone()
        .without_recovery_identity()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new(
                format!("standalone_competing_{action}"),
                "competing-proof",
            )
            .unwrap()
            .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
            .with_source_predecessor(source.presentation_predecessor().unwrap())
            .unwrap(),
        )
        .unwrap();
    let identity = PreparedRecoveryIdentity {
        recovery_id: "competing-upgrade".into(),
        source_session_id: source.generation().fence.session_id.clone(),
        source_workspace_id: source.generation().fence.workspace_id.clone(),
        action,
        legacy_request_fingerprint: None,
    };
    let prepared = PreparedStandaloneUpgrade {
        source,
        source_build_id: "old".into(),
        target_build_id: "new".into(),
        replacement: Some(StandaloneUpgradeReplacement {
            discovery_root: None,
            create,
            context: if action == CURRENT_BUILD_ACTION {
                serde_json::json!({"checkout": null})
            } else {
                serde_json::json!({"runtime": "/selected/runtime"})
            },
        }),
    };
    (identity, serde_json::to_string(&prepared).unwrap())
}

#[test]
fn one_pending_source_has_only_one_upgrade_across_both_consumers() {
    for first in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        for second in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
            let fixture = prepared_fixture(first);
            let checkpoint = fixture.operation.operation_checkpoint().cloned();
            let (identity, payload) = candidate(&fixture.create, second, fixture.source.clone());
            let competing = reserve_prepared(fixture.root.path(), identity.clone(), Some(payload));
            assert!(
                competing
                    .err()
                    .is_some_and(|error| error.starts_with("hmux_recovery_source_busy:")),
                "{first} and {second} both reserved a replacement for one source"
            );
            assert_eq!(
                fixture.operation.operation_checkpoint(),
                checkpoint.as_ref()
            );
            assert!(
                journal::existing_operation::read(
                    fixture.root.path(),
                    &identity.recovery_id,
                    second
                )
                .unwrap()
                .is_none()
            );
        }
    }
}

#[test]
fn a_compacted_completion_still_owns_its_exact_source() {
    let mut fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let (identity, payload) = candidate(
        &fixture.create,
        CURRENT_BUILD_ACTION,
        fixture.source.clone(),
    );
    fixture
        .operation
        .complete(fixture.completion.clone())
        .unwrap();
    drop(fixture.operation);
    let report = garbage_collect_completed(
        fixture.root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    let competing = reserve_prepared(fixture.root.path(), identity, Some(payload));
    assert!(
        competing
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_source_busy:")),
        "compaction must not admit a second replacement of the same source generation"
    );
}

#[test]
fn a_new_generation_at_the_same_address_can_prepare_its_own_upgrade() {
    let fixture = prepared_fixture(SELECTED_BUILD_ACTION);
    let mut changed = serde_json::to_value(&fixture.source).unwrap();
    changed["generation"]["fence"]["terminalEpoch"] = "new-terminal".into();
    changed["generation"]["fence"]["hostInstanceId"] = "new-host".into();
    changed["providerProcess"]["start_marker"] = "new-provider".into();
    let source = serde_json::from_value(changed).unwrap();
    let (identity, payload) = candidate(&fixture.create, CURRENT_BUILD_ACTION, source);
    assert!(matches!(
        reserve_prepared(fixture.root.path(), identity, Some(payload)).unwrap(),
        RecoveryReservationState::Pending(_)
    ));
}

#[test]
fn legacy_first_payload_preparation_uses_the_same_source_admission() {
    let fixture = prepared_fixture(SELECTED_BUILD_ACTION);
    let (identity, payload) = candidate(
        &fixture.create,
        CURRENT_BUILD_ACTION,
        fixture.source.clone(),
    );
    let RecoveryReservationState::Pending(mut legacy) = journal::reserve(
        fixture.root.path(),
        journal::RecoveryIdentity {
            recovery_id: identity.recovery_id,
            source_session_id: identity.source_session_id,
            source_workspace_id: identity.source_workspace_id,
            action: identity.action,
            request_fingerprint: request_fingerprint(&["legacy-request"]),
        },
    )
    .unwrap() else {
        panic!("legacy fixture must be pending")
    };
    let admitted =
        legacy.prepare_operation_payload(journal::RecoveryOperationPayload::new(payload).unwrap());
    assert!(
        admitted
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_source_busy:")),
        "legacy preparation bypassed the source's already admitted replacement"
    );
    assert!(legacy.operation_checkpoint().is_none());
}

#[test]
fn caller_loss_keeps_source_ownership_and_allows_the_original_retry() {
    let fixture = prepared_fixture(SELECTED_BUILD_ACTION);
    let checkpoint = fixture.operation.operation_checkpoint().cloned();
    let original = PreparedRecoveryIdentity {
        recovery_id: fixture.operation.recovery_id().into(),
        source_session_id: fixture.source.generation().fence.session_id.clone(),
        source_workspace_id: fixture.source.generation().fence.workspace_id.clone(),
        action: SELECTED_BUILD_ACTION,
        legacy_request_fingerprint: None,
    };
    let (identity, payload) = candidate(&fixture.create, CURRENT_BUILD_ACTION, fixture.source);
    drop(fixture.operation);
    let competing = reserve_prepared(fixture.root.path(), identity, Some(payload));
    assert!(
        competing
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_source_busy:"))
    );
    let RecoveryReservationState::Pending(reopened) =
        reserve_prepared(fixture.root.path(), original, None).unwrap()
    else {
        panic!("caller loss must preserve the original pending operation")
    };
    assert!(reopened.was_existing());
    assert_eq!(reopened.operation_checkpoint(), checkpoint.as_ref());
}

fn fresh_candidate(
    root: &std::path::Path,
    action: &'static str,
) -> (PreparedRecoveryIdentity, String) {
    let mut saved = checkpoint(serde_json::json!({"runtime": "/selected/runtime"}));
    let mut payload: serde_json::Value = serde_json::from_str(&saved.canonical_payload).unwrap();
    payload["source"]["discoveryRoot"] =
        serde_json::to_value(crate::LocalSessionCatalog::new(root).discovery_root()).unwrap();
    saved.canonical_payload = payload.to_string();
    let prepared = read_upgrade(action, &saved).unwrap().unwrap();
    let (mut identity, payload) = candidate(
        &prepared.replacement.unwrap().create,
        action,
        prepared.source,
    );
    identity.recovery_id = request_fingerprint(&[action, "concurrent-upgrade"]);
    (identity, payload)
}

#[test]
fn concurrent_consumers_publish_exactly_one_source_owner() {
    let root = tempfile::tempdir().unwrap();
    assert_concurrent_admission(root.path(), [root.path(), root.path()]);
}

#[test]
fn concurrent_distinct_destinations_share_the_original_source_admission() {
    let source = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    assert_concurrent_admission(source.path(), [first.path(), second.path()]);
    for target in [first.path(), second.path()] {
        assert_eq!(
            journal::inspect_existing(target).unwrap().operation_records,
            0
        );
    }
}

fn assert_concurrent_admission(root: &std::path::Path, destinations: [&std::path::Path; 2]) {
    let barrier = std::sync::Barrier::new(2);
    let requests =
        [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION].map(|action| fresh_candidate(root, action));
    let outcomes = std::thread::scope(|scope| {
        let workers = requests
            .iter()
            .zip(destinations)
            .map(|((identity, payload), destination)| {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    reserve_prepared(destination, identity.clone(), Some(payload.clone()))
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut accepted = 0;
    let mut refused = 0;
    for (((identity, _), outcome), destination) in
        requests.into_iter().zip(outcomes).zip(destinations)
    {
        let stored =
            journal::existing_operation::read(root, &identity.recovery_id, identity.action)
                .unwrap();
        match outcome {
            Ok(RecoveryReservationState::Pending(operation)) => {
                accepted += 1;
                assert!(stored.is_some());
                let prepared =
                    read_upgrade(identity.action, operation.operation_checkpoint().unwrap())
                        .unwrap()
                        .unwrap();
                assert_eq!(prepared.source.discovery_root(), root);
                assert_eq!(
                    prepared.replacement.unwrap().discovery_root(root),
                    destination
                );
            }
            Err(error) if error.starts_with("hmux_recovery_source_busy:") => {
                refused += 1;
                assert!(stored.is_none());
            }
            _ => panic!("competing consumers must either own the source or observe its owner"),
        }
    }
    assert_eq!((accepted, refused), (1, 1));
}

#[test]
fn already_current_observation_does_not_claim_a_replacement_source() {
    let root = tempfile::tempdir().unwrap();
    let (identity, payload) = fresh_candidate(root.path(), CURRENT_BUILD_ACTION);
    let mut payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    payload["replacement"] = serde_json::Value::Null;
    let observation = reserve_prepared(root.path(), identity, Some(payload.to_string())).unwrap();
    let (identity, payload) = fresh_candidate(root.path(), SELECTED_BUILD_ACTION);
    assert!(matches!(
        reserve_prepared(root.path(), identity, Some(payload)).unwrap(),
        RecoveryReservationState::Pending(_)
    ));
    drop(observation);
}
