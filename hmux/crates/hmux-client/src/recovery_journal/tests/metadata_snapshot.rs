use super::*;

#[test]
fn scan_metadata_and_identity_describe_the_same_file_when_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("journal");
    ensure_private_directory(&directory).unwrap();
    let path = directory.join(format!("operation_{}.json", digest("snapshot")));
    let mut original = open_private_new(&path).unwrap();
    original.write_all(b"old").unwrap();
    original
        .set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
        .unwrap();
    let original_identity = private_storage::file_identity(&path).unwrap();

    let replacement_path = temp.path().join("replacement");
    let mut replacement = open_private_new(&replacement_path).unwrap();
    replacement.write_all(b"replacement").unwrap();
    replacement
        .set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(2)))
        .unwrap();
    let retained_original = temp.path().join("original");
    JOURNAL_AFTER_METADATA_READ.with_borrow_mut(|observer| {
        *observer = Some(Box::new(move |path| {
            fs::rename(path, &retained_original).unwrap();
            fs::rename(&replacement_path, path).unwrap();
        }));
    });

    let entries = scan_journal(&directory, false).unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.bytes, 3);
    assert_eq!(entry.modified_unix_ms, 1_000);
    assert_eq!(
        entry.identity, original_identity,
        "the size, timestamp and identity must come from the same observation"
    );
    assert!(
        ensure_planned_open_file(entry, &File::open(&path).unwrap()).is_err(),
        "the later open-file fence must still reject the replacement"
    );
}

#[test]
fn one_metadata_observation_preserves_journal_facts_and_reports_matched_cost() {
    let temp = tempfile::tempdir().unwrap();
    let paths: Vec<_> = (0..1_024)
        .map(|index| {
            let path = temp.path().join(format!("source_{index:032x}.lock"));
            open_private_new(&path).unwrap();
            path
        })
        .collect();
    let mut times = [Vec::new(), Vec::new()];
    for round in 0..8 {
        let mut facts = [Vec::new(), Vec::new()];
        // Alternate reader order over identical files; timings are evidence,
        // not a speed threshold that depends on unrelated machine load.
        for mode in [round % 2, 1 - round % 2] {
            let started = std::time::Instant::now();
            facts[mode] = paths
                .iter()
                .map(|path| {
                    let snapshot = if mode == 0 {
                        let metadata = fs::symlink_metadata(path).unwrap();
                        let identity = private_storage::file_identity(path).unwrap();
                        private_storage::PrivateFileMetadata { identity, metadata }
                    } else {
                        private_storage::file_metadata(path).unwrap()
                    };
                    (
                        snapshot.identity,
                        snapshot.metadata.len(),
                        metadata_time_ms(&snapshot.metadata).unwrap(),
                    )
                })
                .collect();
            times[mode].push(started.elapsed().as_micros());
        }
        assert_eq!(facts[0], facts[1]);
    }
    for samples in &mut times {
        samples.sort();
    }
    eprintln!(
        "1024 private journal entries: separate observations median {} us, single observation median {} us",
        times[0][4], times[1][4]
    );
}
