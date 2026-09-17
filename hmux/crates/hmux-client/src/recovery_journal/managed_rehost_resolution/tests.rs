use super::*;
use std::sync::{Barrier, mpsc};

#[test]
fn concurrent_managed_resolution_does_not_wait_for_another_reader() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let reader = open_private_lock(&directory.join(ADMISSION_LOCK_NAME)).unwrap();
    FileExt::lock_shared(&reader).unwrap();
    let callers = 12;
    let barrier = Arc::new(Barrier::new(callers + 1));
    let (send, receive) = mpsc::channel();
    let workers: Vec<_> = (0..callers)
        .map(|index| {
            let root = temp.path().to_owned();
            let barrier = barrier.clone();
            let send = send.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = resolve_managed_rehost_current(
                    &root,
                    "workspace-readers",
                    &format!("source-{index}"),
                );
                send.send(result).unwrap();
            })
        })
        .collect();
    drop(send);
    barrier.wait();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut completed_while_read_locked = 0;
    while completed_while_read_locked < callers {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let Ok(result) = receive.recv_timeout(remaining) else {
            break;
        };
        assert!(matches!(
            result.unwrap(),
            ManagedRehostResolutionLookup::NotFound
        ));
        completed_while_read_locked += 1;
    }
    // Release the fixture before asserting so RED also joins every worker.
    FileExt::unlock(&reader).unwrap();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(
        completed_while_read_locked, callers,
        "read-only managed resolution must coexist with another journal reader"
    );
}

fn directory(root: &Path) -> PathBuf {
    let directory = root.join(".recovery");
    ensure_private_directory(&directory).unwrap();
    directory
}

fn pending(root: &Path, operation: &str, source: &str) {
    let result = reserve(
        root,
        RecoveryIdentity {
            recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation}"),
            source_session_id: source.into(),
            source_workspace_id: "workspace".into(),
            request_fingerprint: request_fingerprint(&[operation]),
            action: MANAGED_REHOST_RECOVERY_ACTION,
        },
    )
    .unwrap();
    assert!(matches!(result, RecoveryReservationState::Pending(_)));
}

#[test]
fn concurrent_readers_share_one_fenced_scan_of_a_large_journal() {
    let temp = tempfile::tempdir().unwrap();
    let directory = directory(temp.path());
    pending(temp.path(), "pending", "source");
    for index in 0..1_680 {
        let path = directory.join(format!("operation_{}.lock", digest(&index.to_string())));
        open_private_lock(&path).unwrap();
    }

    // Admit an overlapping cohort before any member finishes preparation.
    let readers: Vec<_> = (0..12)
        .map(|_| ReadFlight::join(&directory).unwrap())
        .collect();
    let barrier = Arc::new(Barrier::new(readers.len()));
    std::thread::scope(|scope| {
        let workers: Vec<_> = readers.iter().map(|reader| {
            let barrier = barrier.clone();
            let directory = &directory;
            scope.spawn(move || {
                barrier.wait();
                let snapshot = reader.snapshot().unwrap();
                assert!(matches!(
                    resolve_snapshot(directory, &snapshot.records, "workspace", "source").unwrap(),
                    ManagedRehostResolutionLookup::RetryRequired { operation_id } if operation_id == "pending"
                ));
                snapshot as *const Snapshot as usize
            })
        }).collect();
        let snapshots: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(
            snapshots.iter().all(|snapshot| *snapshot == snapshots[0]),
            "overlapping callers must consume one scan, not twelve equivalent scans"
        );
    });

    let writer = open_private_lock(&directory.join(ADMISSION_LOCK_NAME)).unwrap();
    assert_eq!(
        FileExt::try_lock_exclusive(&writer).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(readers);
    FileExt::try_lock_exclusive(&writer).unwrap();
    FileExt::unlock(&writer).unwrap();
}

#[test]
fn completed_preparation_closes_the_cohort_and_drops_its_snapshot_after_readers_exit() {
    let temp = tempfile::tempdir().unwrap();
    let directory = directory(temp.path());
    let first = ReadFlight::join(&directory).unwrap();
    let overlapping = ReadFlight::join(&directory).unwrap();
    assert!(Arc::ptr_eq(&first, &overlapping));
    assert!(first.snapshot().unwrap().records.is_empty());
    let later = ReadFlight::join(&directory).unwrap();
    assert!(
        !Arc::ptr_eq(&first, &later),
        "new readers must not extend an old transaction"
    );
    let weak = Arc::downgrade(&first);
    drop(first);
    drop(overlapping);
    assert!(
        weak.upgrade().is_none(),
        "no persistent snapshot may retain the writer fence"
    );

    pending(temp.path(), "new-operation", "new-source");
    let snapshot = later.snapshot().unwrap();
    assert!(matches!(
        resolve_snapshot(&directory, &snapshot.records, "workspace", "new-source").unwrap(),
        ManagedRehostResolutionLookup::RetryRequired { operation_id } if operation_id == "new-operation"
    ));
}

#[test]
fn failed_scan_releases_admission_and_does_not_poison_the_next_transaction() {
    let temp = tempfile::tempdir().unwrap();
    let directory = directory(temp.path());
    let invalid = directory.join(format!("operation_{}.json", digest("invalid")));
    open_private_new(&invalid)
        .unwrap()
        .write_all(b"invalid json")
        .unwrap();
    let first = ReadFlight::join(&directory).unwrap();
    assert!(first.snapshot().is_err());
    let writer = open_private_lock(&directory.join(ADMISSION_LOCK_NAME)).unwrap();
    FileExt::try_lock_exclusive(&writer).unwrap();
    fs::remove_file(&invalid).unwrap();
    FileExt::unlock(&writer).unwrap();
    pending(temp.path(), "after-repair", "source");
    assert!(matches!(
        resolve_managed_rehost_current(temp.path(), "workspace", "source").unwrap(),
        ManagedRehostResolutionLookup::RetryRequired { operation_id } if operation_id == "after-repair"
    ));
}

#[test]
fn a_busy_root_does_not_hold_the_process_wide_reader_registry() {
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let first_directory = directory(first_root.path());
    directory(second_root.path());
    let writer = acquire_admission_lock(&first_directory).unwrap();
    let first = ReadFlight::join(&first_directory).unwrap();
    let worker =
        std::thread::spawn(move || first.snapshot().map(|snapshot| snapshot.records.len()));
    let (send, receive) = mpsc::channel();
    let root = second_root.path().to_owned();
    let other = std::thread::spawn(move || {
        send.send(resolve_managed_rehost_current(&root, "workspace", "source"))
            .unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(5));
    drop(writer);
    worker.join().unwrap().unwrap();
    other.join().unwrap();
    assert!(matches!(
        result.unwrap().unwrap(),
        ManagedRehostResolutionLookup::NotFound
    ));
}
