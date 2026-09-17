use super::*;

#[test]
fn independent_processes_share_one_retry_and_contiguous_sequence() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::write(root.join("owned-journal-test"), b"spawn-journal-v1").unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut writers = Vec::new();
    for writer in 0..4 {
        writers.push(
            std::process::Command::new(&executable)
                .args([
                    "--exact",
                    "spawn::journal_tests::process_writer",
                    "--ignored",
                    "--nocapture",
                ])
                .env("DURE_QA_JOURNAL_PROCESS_ROOT", &root)
                .env("DURE_QA_JOURNAL_PROCESS_WRITER", writer.to_string())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn(),
        );
    }
    // Reconcile every child before asserting, including a failed sibling.
    let results: Vec<_> = writers
        .into_iter()
        .map(|writer| writer.and_then(|child| child.wait_with_output()))
        .collect();
    for result in results {
        let result = result.unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
    }
    let receipts = list_running_in(&root).unwrap();
    assert_eq!(receipts.len(), 1);
    let id = receipts[0]["receiptId"].as_str().unwrap();
    let events = read_events_in(&root, id).unwrap();
    assert_eq!(events.len(), 41);
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event["seq"], sequence);
    }
}

#[test]
#[ignore = "child process entry point for the owned journal concurrency test"]
fn process_writer() {
    let root = PathBuf::from(std::env::var("DURE_QA_JOURNAL_PROCESS_ROOT").unwrap());
    assert_eq!(root.canonicalize().unwrap(), root);
    assert_eq!(
        std::fs::read(root.join("owned-journal-test")).unwrap(),
        b"spawn-journal-v1",
    );
    let writer = std::env::var("DURE_QA_JOURNAL_PROCESS_WRITER").unwrap();
    let created =
        create_saga_in(&root, json!({ "writer": writer }), Some("shared".into())).unwrap();
    let id = created["receiptId"].as_str().unwrap();
    for _ in 0..10 {
        append_event_in(
            &root,
            id,
            &json!({ "event": "step_started", "step": "preflight" }),
        )
        .unwrap();
    }
}

#[test]
fn an_unpublished_legacy_utf8_tail_does_not_block_a_different_retry_key() {
    let directory = tempfile::tempdir().unwrap();
    let incomplete = journal_path_in(directory.path(), "sp_interrupted").unwrap();
    let bytes = b"{\"event\":\"saga_created\",\"request\":\"\xea\xb0";
    std::fs::write(&incomplete, bytes).unwrap();
    let created = create_saga_in(
        directory.path(),
        json!({ "target": "independent-host" }),
        Some("different-key".into()),
    )
    .unwrap();
    assert_eq!(created["receipt"]["request"]["target"], "independent-host");
    assert_eq!(
        receipt_by_key_in(directory.path(), "different-key")
            .unwrap()
            .unwrap()["receiptId"],
        created["receiptId"],
    );
    assert_eq!(std::fs::read(incomplete).unwrap(), bytes);
}

#[test]
fn interrupted_tail_keeps_prior_records_and_does_not_swallow_the_next_append() {
    for tail in [
        b"{\"event\":\"step_star".as_slice(),
        b"{\"event\":\"evidence\",\"text\":\"\xea\xb0".as_slice(),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let created = create_saga_in(
            directory.path(),
            json!({ "target": "original-host" }),
            Some("interrupted".into()),
        )
        .unwrap();
        let id = created["receiptId"].as_str().unwrap();
        let path = journal_path_in(directory.path(), id).unwrap();
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(tail)
            .unwrap();
        let before = std::fs::read(&path).unwrap();

        let recovered = read_receipt_from_disk_in(directory.path(), id).unwrap();
        assert_eq!(recovered["request"]["target"], "original-host");
        let appended = append_event_in(
            directory.path(),
            id,
            &json!({ "event": "step_started", "step": "pane" }),
        )
        .unwrap();
        assert_eq!(appended["steps"][3]["status"], "running");
        let events = read_events_in(directory.path(), id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["seq"], 1);
        // Preserve the interrupted bytes for diagnosis; only add a boundary.
        assert!(std::fs::read(&path).unwrap().starts_with(&before));

        let completed = append_event_in(
            directory.path(),
            id,
            &json!({ "event": "step_succeeded", "step": "pane" }),
        )
        .unwrap();
        assert_eq!(completed["steps"][3]["status"], "ok");
        let events = read_events_in(directory.path(), id).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[2]["seq"], 2);
    }
}

#[test]
fn complete_unterminated_record_is_retained_before_the_next_append() {
    let directory = tempfile::tempdir().unwrap();
    let created = create_saga_in(directory.path(), json!({}), Some("complete".into())).unwrap();
    let id = created["receiptId"].as_str().unwrap();
    let path = journal_path_in(directory.path(), id).unwrap();
    let complete = serde_json::to_vec(&json!({
        "v": 1, "receiptId": id, "seq": 1, "at": 2,
        "event": "step_started", "step": "pane",
    }))
    .unwrap();
    File::options()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&complete)
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let appended = append_event_in(
        directory.path(),
        id,
        &json!({ "event": "step_succeeded", "step": "pane" }),
    )
    .unwrap();
    assert_eq!(appended["steps"][3]["status"], "ok");
    let events = read_events_in(directory.path(), id).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[1]["seq"], 1);
    assert_eq!(events[2]["seq"], 2);
    assert!(std::fs::read(&path).unwrap().starts_with(&before));
}

#[test]
fn ordinary_append_keeps_the_existing_single_line_separator() {
    let directory = tempfile::tempdir().unwrap();
    let created = create_saga_in(directory.path(), json!({}), None).unwrap();
    let id = created["receiptId"].as_str().unwrap();
    append_event_in(
        directory.path(),
        id,
        &json!({ "event": "step_started", "step": "pane" }),
    )
    .unwrap();
    let bytes = std::fs::read(journal_path_in(directory.path(), id).unwrap()).unwrap();
    assert!(bytes.ends_with(b"\n"));
    assert!(!bytes.windows(2).any(|pair| pair == b"\n\n"));
}
