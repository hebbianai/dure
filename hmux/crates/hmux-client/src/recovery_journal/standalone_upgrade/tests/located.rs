use super::*;
use crate::LocalSessionCatalog;

#[test]
fn target_history_never_commits_the_source_operation_before_its_original_journal() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        for bound in [false, true] {
            let destination = tempfile::tempdir().unwrap();
            let mut fixture =
                prepared_fixture_with_destination(action, bound, Some(destination.path()));
            fixture
                .operation
                .checkpoint_replacement_receipt(serde_json::to_string(&fixture.target).unwrap())
                .unwrap();
            let id = fixture.operation.recovery_id().to_string();
            let directory = fixture.root.path().join(".recovery");
            let completed =
                journal::completed_record(&fixture.operation.record, fixture.completion.clone())
                    .unwrap();
            {
                let _admission = journal::acquire_admission_lock(&directory).unwrap();
                compacted::publish(&directory, &completed).unwrap();
            }
            // Simulate a caller dying after immutable target history is durable
            // but before the original source journal commits Completed.
            drop(fixture.operation);
            for catalog in [
                LocalSessionCatalog::new(destination.path()),
                LocalSessionCatalog::with_read_only_discovery_roots(
                    destination.path(),
                    vec![fixture.root.path().to_path_buf()],
                )
                .unwrap(),
                LocalSessionCatalog::with_read_only_discovery_roots(
                    fixture.root.path(),
                    vec![destination.path().to_path_buf()],
                )
                .unwrap(),
            ] {
                let observed = read_operation(&catalog, &id, action).unwrap();
                let Some(StandaloneUpgradeOperation::Pending(pending)) = observed else {
                    panic!("target history must defer to the original pending operation");
                };
                assert_eq!(pending.operation_root(), fixture.root.path());
                assert!(matches!(
                    read_successor(
                        &catalog,
                        fixture.source.generation(),
                        fixture.source.provider_process()
                    )
                    .unwrap(),
                    Some(StandaloneUpgradeProgress::Pending(_)),
                ));
            }
            let target_catalog = LocalSessionCatalog::new(destination.path());
            let Some(StandaloneUpgradeOperation::Pending(pending)) =
                read_operation(&target_catalog, &id, action).unwrap()
            else {
                panic!("the original operation must still be recoverable");
            };
            let Some(RecoveryReservationState::Pending(mut operation)) = pending.reopen().unwrap()
            else {
                panic!("recovery must reopen the same original writer");
            };
            operation.complete(fixture.completion).unwrap();
            drop(operation);
            let assert_completed = || {
                let completed = read_completed(&target_catalog, &id, action)
                    .unwrap()
                    .unwrap();
                assert_eq!(completed.successor.target, fixture.target);
            };
            assert_completed();
            let collected = garbage_collect_completed(
                fixture.root.path(),
                RecoveryJournalGcPolicy {
                    minimum_completed_age: std::time::Duration::ZERO,
                    maximum_completed_records: 0,
                    maximum_completed_bytes: 0,
                    ..RecoveryJournalGcPolicy::default()
                },
            )
            .unwrap();
            assert_eq!(collected.removed_completed_records, 1);
            assert_completed();
        }
    }
}

#[test]
fn busy_target_history_never_blocks_while_holding_the_source_journal() {
    let destination = tempfile::tempdir().unwrap();
    let mut fixture =
        prepared_fixture_with_destination(SELECTED_BUILD_ACTION, true, Some(destination.path()));
    fixture
        .operation
        .checkpoint_replacement_receipt(serde_json::to_string(&fixture.target).unwrap())
        .unwrap();
    let target_recovery = destination.path().join(".recovery");
    journal::ensure_private_directory(&target_recovery).unwrap();
    let target_admission = journal::acquire_admission_lock(&target_recovery).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let completion = fixture.completion;
    let join = std::thread::spawn(move || {
        let mut operation = fixture.operation;
        let result = operation.complete(completion.clone());
        sender.send((operation, completion, result)).unwrap();
    });
    let immediate = receiver.recv_timeout(std::time::Duration::from_secs(3));
    let was_immediate = immediate.is_ok();
    // Always release the exact fixture lock and join, including behavioral RED.
    drop(target_admission);
    let (mut operation, completion, result) =
        immediate.unwrap_or_else(|_| receiver.recv().unwrap());
    join.join().unwrap();
    assert!(
        was_immediate,
        "source completion blocked behind a peer journal"
    );
    assert!(result.unwrap_err().starts_with("hmux_recovery_busy:"));
    assert!(matches!(
        operation.record.state,
        journal::RecoveryRecordState::Reserved { .. }
    ));
    operation.complete(completion).unwrap();
    assert!(matches!(
        operation.record.state,
        journal::RecoveryRecordState::Completed { .. }
    ));
}
