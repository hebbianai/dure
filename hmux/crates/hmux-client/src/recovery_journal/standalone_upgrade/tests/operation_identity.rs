use super::*;
use crate::LocalSessionCatalog;

fn imported(destination: &std::path::Path, action: &'static str, name: &str) -> UpgradeFixture {
    let mut fixture = prepared_fixture_named(action, true, Some(destination), Some(name));
    fixture
        .operation
        .checkpoint_replacement_receipt(serde_json::to_string(&fixture.target).unwrap())
        .unwrap();
    fixture
}

fn collect(root: &std::path::Path) {
    let report = garbage_collect_completed(
        root,
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
}

#[test]
fn imported_history_cannot_redirect_a_local_pending_operation_with_the_same_id() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let local = pending_fixture(action);
        let mut remote = imported(local.root.path(), action, "remote");
        let id = local.operation.recovery_id().to_string();
        assert_eq!(remote.operation.recovery_id(), id);
        let saved = local.operation.operation_checkpoint().cloned();
        remote.operation.complete(remote.completion).unwrap();
        let catalog = LocalSessionCatalog::new(local.root.path());
        let Some(StandaloneUpgradeOperation::Pending(pending)) =
            read_operation(&catalog, &id, action).unwrap()
        else {
            panic!("an imported completion shadowed this namespace's original pending operation");
        };
        assert_eq!(pending.operation_root(), local.root.path());
        assert_eq!(local.operation.operation_checkpoint(), saved.as_ref());
        assert!(
            pending
                .reopen()
                .unwrap_err()
                .starts_with("hmux_recovery_busy:")
        );
        drop(local.operation);
        let Some(RecoveryReservationState::Pending(original)) = pending.reopen().unwrap() else {
            panic!("caller loss must reopen the same local operation");
        };
        assert_eq!(original.operation_checkpoint(), saved.as_ref());
    }
}

#[test]
fn independent_same_id_operations_complete_and_retire_without_erasing_peer_history() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let mut local = pending_fixture(action);
        let mut first = imported(local.root.path(), action, "first");
        let mut second = imported(local.root.path(), action, "second");
        let id = local.operation.recovery_id().to_string();
        assert_eq!(first.operation.recovery_id(), id);
        assert_eq!(second.operation.recovery_id(), id);
        local.operation.complete(local.completion).unwrap();
        first.operation.complete(first.completion).unwrap();
        second.operation.complete(second.completion).unwrap();
        drop(local.operation);
        drop(first.operation);
        drop(second.operation);
        for root in [local.root.path(), first.root.path(), second.root.path()] {
            collect(root);
        }
        let catalog = LocalSessionCatalog::new(local.root.path());
        assert_eq!(
            read_completed(&catalog, &id, action)
                .unwrap()
                .unwrap()
                .successor
                .target,
            local.target
        );
        for (source, target, create) in [
            (&local.source, &local.target, &local.create),
            (&first.source, &first.target, &first.create),
            (&second.source, &second.target, &second.create),
        ] {
            let Some(StandaloneUpgradeProgress::Completed(next)) =
                read_successor(&catalog, source.generation(), source.provider_process()).unwrap()
            else {
                panic!("exact source lineage was lost to an unrelated same-ID operation");
            };
            assert_eq!(&next.target, target);
            assert_eq!(
                read_compacted_launch(
                    &local.root.path().join(".recovery"),
                    target.generation(),
                    target.provider_process()
                )
                .unwrap()
                .as_ref(),
                Some(create)
            );
        }
        retire_launch_inputs(
            &catalog,
            first.target.generation(),
            first.target.provider_process(),
        )
        .unwrap();
        for root in [local.root.path(), first.root.path()] {
            assert!(
                read_compacted_launch(
                    &root.join(".recovery"),
                    first.target.generation(),
                    first.target.provider_process()
                )
                .unwrap()
                .is_none()
            );
        }
        assert_eq!(
            read_compacted_launch(
                &local.root.path().join(".recovery"),
                second.target.generation(),
                second.target.provider_process()
            )
            .unwrap(),
            Some(second.create)
        );
        assert_eq!(
            read_compacted_launch(
                &local.root.path().join(".recovery"),
                local.target.generation(),
                local.target.provider_process()
            )
            .unwrap(),
            Some(local.create)
        );
    }
}

#[test]
fn an_ambiguous_imported_id_never_prevents_exact_source_or_launch_lookup() {
    let destination = tempfile::tempdir().unwrap();
    let action = SELECTED_BUILD_ACTION;
    let mut first = imported(destination.path(), action, "first");
    let mut second = imported(destination.path(), action, "second");
    let id = first.operation.recovery_id().to_string();
    first.operation.complete(first.completion).unwrap();
    second.operation.complete(second.completion).unwrap();
    drop(first.operation);
    drop(second.operation);
    collect(first.root.path());
    collect(second.root.path());
    let catalog = LocalSessionCatalog::new(destination.path());
    let lookup = read_operation(&catalog, &id, action);
    assert!(
        lookup
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_idempotency_conflict:"))
    );
    for (source, target) in [
        (&first.source, &first.target),
        (&second.source, &second.target),
    ] {
        let Some(StandaloneUpgradeProgress::Completed(next)) =
            read_successor(&catalog, source.generation(), source.provider_process()).unwrap()
        else {
            panic!("operation-ID ambiguity cannot erase an exact source edge");
        };
        assert_eq!(&next.target, target);
        assert!(
            read_compacted_launch(
                &destination.path().join(".recovery"),
                target.generation(),
                target.provider_process()
            )
            .unwrap()
            .is_some()
        );
    }
}

#[test]
fn a_local_no_replacement_completion_is_not_absence_for_imported_id_lookup() {
    let local = tempfile::tempdir().unwrap();
    let action = CURRENT_BUILD_ACTION;
    let mut peer = imported(local.path(), action, "peer");
    let id = peer.operation.recovery_id().to_string();
    let checkpoint = checkpoint(serde_json::json!({"checkout": null}));
    let mut payload: serde_json::Value =
        serde_json::from_str(&checkpoint.canonical_payload).unwrap();
    payload["source"]["discoveryRoot"] = serde_json::to_value(local.path()).unwrap();
    payload["targetBuildId"] = "old".into();
    payload["replacement"] = serde_json::Value::Null;
    let RecoveryReservationState::Pending(mut operation) = reserve_prepared(
        local.path(),
        PreparedRecoveryIdentity {
            recovery_id: id.clone(),
            source_session_id: "source".into(),
            source_workspace_id: "workspace".into(),
            action,
            legacy_request_fingerprint: None,
        },
        Some(payload.to_string()),
    )
    .unwrap() else {
        panic!("the no-op is still an original operation");
    };
    operation
        .complete(RecoveryCompletion {
            target_session_id: "source".into(),
            target_workspace_id: "workspace".into(),
            target_build_id: "old".into(),
            action: action.into(),
            outcome: "already_current".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(operation);
    peer.operation.complete(peer.completion).unwrap();
    let catalog = LocalSessionCatalog::new(local.path());
    assert!(read_operation(&catalog, &id, action).unwrap().is_none());
    let both = LocalSessionCatalog::with_read_only_discovery_roots(
        local.path(),
        vec![peer.root.path().to_path_buf()],
    )
    .unwrap();
    assert!(
        read_operation(&both, &id, action)
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_idempotency_conflict:"))
    );
    let Some(journal::existing_operation::RecoveryOperationObservation::Completed {
        completion,
        ..
    }) = journal::existing_operation::read(local.path(), &id, action).unwrap()
    else {
        panic!("the original no-replacement completion must remain local");
    };
    assert_eq!(completion.outcome, "already_current");
}
