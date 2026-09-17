use super::*;

pub(super) fn read_entries(
    entries: &[&mut JournalEntry],
    read: &(impl Fn(&JournalEntry) -> Result<Option<RecoveryRecord>, String> + Sync),
) -> Result<Vec<Option<RecoveryRecord>>, String> {
    if entries.len() < 16 {
        return entries.iter().map(|entry| read(entry)).collect();
    }
    let chunks: Vec<_> = entries.chunks(entries.len().div_ceil(4)).collect();
    let (local, workers) = chunks.split_last().expect("nonempty quota batch");
    let read_chunk = |chunk: &[&mut JournalEntry]| {
        #[cfg(test)]
        let before = RECORD_READ_COUNT.get();
        let result: Result<Vec<_>, String> = chunk.iter().map(|entry| read(entry)).collect();
        #[cfg(test)]
        let reads = RECORD_READ_COUNT.get() - before;
        #[cfg(not(test))]
        let reads = 0;
        (result, reads)
    };
    std::thread::scope(|scope| {
        let pending: Vec<_> = workers
            .iter()
            .map(|chunk| {
                std::thread::Builder::new()
                    .spawn_scoped(scope, || read_chunk(chunk))
                    // Resource pressure must not make a read-only scan fail.
                    .map_err(|_| read_chunk(chunk))
            })
            .collect();
        let local = read_chunk(local).0;
        // Join every worker before returning any error or releasing admission.
        // Keep chunk order so parallel reads preserve the serial error contract.
        let completed: Vec<_> = pending
            .into_iter()
            .map(|pending| match pending {
                Ok(worker) => match worker.join() {
                    Ok((result, _reads)) => {
                        #[cfg(test)]
                        RECORD_READ_COUNT.set(RECORD_READ_COUNT.get() + _reads);
                        result
                    }
                    Err(_) => Err("hmux_recovery_journal_failed: quota reader panicked".into()),
                },
                Err((result, _)) => result,
            })
            .collect();
        completed
            .into_iter()
            .chain([local])
            .collect::<Result<Vec<_>, _>>()
            .map(|chunks| chunks.into_iter().flatten().collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    fn entries(count: usize) -> Vec<JournalEntry> {
        let file = tempfile::NamedTempFile::new().unwrap();
        let identity = private_storage::file_identity(file.path()).unwrap();
        (0..count)
            .map(|index| JournalEntry {
                path: PathBuf::from(index.to_string()),
                kind: JournalEntryKind::OperationRecord(index.to_string()),
                bytes: 0,
                modified_unix_ms: 0,
                identity,
                record: None,
            })
            .collect()
    }

    #[test]
    fn necessary_quota_batch_reads_are_bounded_and_concurrent() {
        let mut entries = entries(32);
        let state = Mutex::new((0, 0, false));
        let gate = Condvar::new();
        let records = read_entries(&entries.iter_mut().collect::<Vec<_>>(), &|_| {
            let mut state = state.lock().unwrap();
            state.0 += 1;
            state.1 = state.1.max(state.0);
            if state.0 == 4 {
                state.2 = true;
                gate.notify_all();
            }
            let (mut state, timeout) = gate
                .wait_timeout_while(state, Duration::from_millis(500), |state| !state.2)
                .unwrap();
            if timeout.timed_out() {
                state.2 = true;
                gate.notify_all();
            }
            state.0 -= 1;
            Ok(None)
        })
        .unwrap();
        assert_eq!(records.len(), 32);
        let state = state.lock().unwrap();
        assert_eq!(
            state.0, 0,
            "all readers must finish before admission returns"
        );
        assert_eq!(state.1, 4, "use at most four concurrent readers");
    }

    #[test]
    fn small_quota_batch_stays_on_the_callers_thread() {
        let mut entries = entries(15);
        let caller = std::thread::current().id();
        let records = read_entries(&entries.iter_mut().collect::<Vec<_>>(), &|_| {
            assert_eq!(std::thread::current().id(), caller);
            Ok(None)
        })
        .unwrap();
        assert_eq!(records.len(), 15);
    }

    #[test]
    fn quota_errors_keep_entry_order_and_join_other_readers() {
        let mut entries = entries(32);
        let completed = Mutex::new(Vec::new());
        let error = read_entries(&entries.iter_mut().collect::<Vec<_>>(), &|entry| {
            let index: usize = entry.path.to_str().unwrap().parse().unwrap();
            if index == 0 {
                std::thread::sleep(Duration::from_millis(20));
                return Err("first entry".into());
            }
            if index == 8 {
                return Err("later entry".into());
            }
            completed.lock().unwrap().push(index);
            Ok(None)
        })
        .unwrap_err();
        assert_eq!(error, "first entry");
        let mut completed = completed.into_inner().unwrap();
        completed.sort();
        assert_eq!(completed, (16..32).collect::<Vec<_>>());
    }

    fn write_fixture(directory: &Path, index: usize, payload: &str) -> JournalEntry {
        let recovery_id = format!("quota-fixture-{index}");
        let record = RecoveryRecord {
            schema_version: RECOVERY_SCHEMA_VERSION,
            recovery_id: recovery_id.clone(),
            source_session_id: "source".into(),
            source_workspace_id: "workspace".into(),
            request_fingerprint: request_fingerprint(&[payload]),
            action: MANAGED_STOP_RECOVERY_ACTION.into(),
            created_unix_ms: 1,
            state: RecoveryRecordState::Reserved {
                resume_checkpoint: None,
                operation_checkpoint: Some(RecoveryOperationCheckpoint {
                    canonical_payload: payload.into(),
                    source_stop_receipt: None,
                    replacement_receipt: None,
                }),
            },
        };
        let path = directory.join(format!("operation_{}.json", digest(&recovery_id)));
        open_private_new(&path)
            .unwrap()
            .write_all(&serialize_record(&record).unwrap())
            .unwrap();
        JournalEntry {
            identity: private_storage::file_identity(&path).unwrap(),
            path,
            kind: JournalEntryKind::OperationRecord(digest(&recovery_id)),
            bytes: 0,
            modified_unix_ms: 1,
            record: None,
        }
    }

    #[test]
    fn quota_capacity_proof_does_not_read_a_later_unavailable_record() {
        let temp = tempfile::tempdir().unwrap();
        ensure_private_directory(temp.path()).unwrap();
        let admission = acquire_admission_lock(temp.path()).unwrap();
        let mut entries = entries(MAX_GENERAL_OPERATION_RECORDS);
        entries[0] = write_fixture(temp.path(), 0, "{}");
        let before = RECORD_READ_COUNT.get();
        let used = read_admitted_quota_bound(
            &admission,
            &mut entries,
            "general",
            MAX_GENERAL_OPERATION_RECORDS,
            MAX_GENERAL_OPERATION_RECORDS,
        )
        .unwrap();
        assert_eq!(used, MAX_GENERAL_OPERATION_RECORDS - 1);
        assert_eq!(RECORD_READ_COUNT.get() - before, 1);
        assert!(entries[0].record.is_some());
        assert!(entries[1..].iter().all(|entry| entry.record.is_none()));
    }

    #[test]
    fn quota_batch_preserves_full_validated_records_and_read_counts() {
        for bytes in [2_048, 8_192] {
            let temp = tempfile::tempdir().unwrap();
            let payload = serde_json::to_string(&vec!["x".repeat(64); bytes / 64]).unwrap();
            let mut entries: Vec<_> = (0..64)
                .map(|index| write_fixture(temp.path(), index, &payload))
                .collect();
            let batch: Vec<_> = entries.iter_mut().collect();
            let read = |entry: &JournalEntry| read_journal_entry_record(&entry.path, &entry.kind);
            let mut times = [Vec::new(), Vec::new()];
            for round in 0..8 {
                let mut records = [Vec::new(), Vec::new()];
                // Alternate first reader to avoid attributing warm-cache order
                // to concurrency. Timing is evidence, not a flaky speed gate.
                for mode in [round % 2, 1 - round % 2] {
                    let before = RECORD_READ_COUNT.get();
                    let started = std::time::Instant::now();
                    records[mode] = if mode == 0 {
                        batch
                            .iter()
                            .map(|entry| read(entry))
                            .collect::<Result<_, _>>()
                    } else {
                        read_entries(&batch, &read)
                    }
                    .unwrap();
                    times[mode].push(started.elapsed().as_micros());
                    assert_eq!(RECORD_READ_COUNT.get() - before, 64);
                }
                assert_eq!(
                    serde_json::to_value(&records[0]).unwrap(),
                    serde_json::to_value(&records[1]).unwrap()
                );
            }
            for samples in &mut times {
                samples.sort();
            }
            eprintln!(
                "64 quota records / {bytes} byte payload: serial median {} us, parallel median {} us",
                times[0][4], times[1][4]
            );
        }
    }
}
