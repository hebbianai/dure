use super::*;
use std::num::NonZeroU64;
use std::time::Instant;

fn id(value: &str) -> BrowserNetworkId {
    BrowserNetworkId::new(value).unwrap()
}

fn page(host: &mut BrowserResourceHost, name: &str) -> BrowserPageIdentity {
    let target = BrowserTargetId::new(name).unwrap();
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new(name).unwrap(),
        )
        .unwrap();
    host.network()
        .attach(id(name), target.clone(), target, true, Instant::now())
        .unwrap();
    page
}

fn setup() -> (BrowserResourceHost, BrowserPageIdentity) {
    let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("r").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    });
    let page = page(&mut host, "page");
    (host, page)
}

fn message(text: &str) -> BrowserConsoleMessage<'_> {
    BrowserConsoleMessage {
        kind: BrowserConsoleKind::Console,
        level: "log",
        text,
        timestamp: 1700000000000.25,
        url: Some("https://example.test/한글"),
        line: Some(4),
        column: Some(8),
    }
}

fn snapshot(
    host: &BrowserResourceHost,
    page: &BrowserPageIdentity,
    query: BrowserConsoleQuery,
) -> BrowserConsoleSnapshot {
    host.console_snapshot(&page.resource, &page.page_id, query)
        .unwrap()
}

fn authority(host: &mut BrowserResourceHost, page: &BrowserPageIdentity) -> BrowserActionAuthority {
    let controller = BrowserControllerId::new("agent").unwrap();
    let lease = host
        .request_control(controller, None)
        .unwrap()
        .controller
        .unwrap();
    BrowserActionAuthority {
        lease,
        page: page.clone(),
        operation_id: BrowserOperationId::new("clear").unwrap(),
        command_sequence: host.projection().next_command_sequence,
    }
}

#[test]
fn exception_filter_precedes_limits_and_cursors_without_rewriting_history() {
    let (mut host, selected) = setup();
    let peer = page(&mut host, "peer");
    host.console.sequence = 9007199254740992;
    for name in ["first", "second", "third"] {
        host.console_observed(
            &id("page"),
            BrowserConsoleMessage {
                kind: BrowserConsoleKind::Exception,
                ..message(name)
            },
        )
        .unwrap();
        for _ in 0..110 {
            host.console_observed(&id("page"), message("ordinary"))
                .unwrap();
        }
    }
    host.console_observed(
        &id("peer"),
        BrowserConsoleMessage {
            kind: BrowserConsoleKind::Exception,
            ..message("peer exception")
        },
    )
    .unwrap();
    let before = serde_json::to_value(snapshot(&host, &selected, Default::default())).unwrap();
    let control = host.projection();
    let first = snapshot(
        &host,
        &selected,
        serde_json::from_value(serde_json::json!({"kind":"exception","limit":2})).unwrap(),
    );
    assert_eq!(
        first
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["second", "third"]
    );
    assert!(first.truncated && !first.history_truncated);
    assert!(
        first
            .entries
            .iter()
            .all(|entry| entry.kind == BrowserConsoleKind::Exception)
    );
    let older = snapshot(
        &host,
        &selected,
        serde_json::from_value(
            serde_json::json!({"kind":"exception","limit":2,"before":first.next_before.unwrap()}),
        )
        .unwrap(),
    );
    assert_eq!(older.entries.len(), 1);
    assert_eq!(older.entries[0].text, "first");
    assert_eq!(older.entries[0].sequence, "9007199254740993");
    assert!(!older.truncated && older.next_before.is_none());
    assert_eq!(host.projection(), control);
    assert_eq!(
        serde_json::to_value(snapshot(&host, &selected, Default::default())).unwrap(),
        before
    );
    assert_eq!(
        snapshot(&host, &peer, Default::default()).entries[0].text,
        "peer exception"
    );
}

#[test]
fn selective_clear_preserves_other_kinds_peers_loss_evidence_and_monotonic_sequences() {
    let (mut host, selected) = setup();
    let peer = page(&mut host, "peer");
    // Evict ordinary page history before clearing its retained exceptions.
    for _ in 0..=MAX_ENTRIES {
        host.console_observed(&id("page"), message("ordinary"))
            .unwrap();
    }
    for source in ["page", "peer"] {
        host.console_observed(
            &id(source),
            BrowserConsoleMessage {
                kind: BrowserConsoleKind::Exception,
                ..message("한글 예외")
            },
        )
        .unwrap();
    }
    let before = snapshot(&host, &selected, Default::default());
    assert!(before.history_truncated);
    let sequence = host.console.sequence;
    let peer_before = serde_json::to_value(snapshot(&host, &peer, Default::default())).unwrap();
    let bytes = host.console.bytes;
    let auth = authority(&mut host, &selected);
    let permit = host
        .begin_action(&auth.lease.controller_id, &auth, [])
        .unwrap();
    assert_eq!(
        host.clear_console(&permit, Some(BrowserConsoleKind::Exception))
            .unwrap(),
        1
    );
    assert_eq!(
        host.clear_console(&permit, Some(BrowserConsoleKind::Exception))
            .unwrap(),
        0
    );
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let after = snapshot(&host, &selected, Default::default());
    assert!(
        after.history_truncated
            && after
                .entries
                .iter()
                .all(|entry| entry.kind == BrowserConsoleKind::Console)
    );
    assert!(!after.entries.is_empty());
    assert_eq!(
        serde_json::to_value(snapshot(&host, &peer, Default::default())).unwrap(),
        peer_before
    );
    assert!(host.console.bytes < bytes);
    assert_eq!(
        host.console.bytes,
        host.console
            .entries
            .iter()
            .map(|entry| entry.bytes)
            .sum::<usize>()
    );
    assert_eq!(host.console.sequence, sequence);
    host.console_observed(
        &id("page"),
        BrowserConsoleMessage {
            kind: BrowserConsoleKind::Exception,
            ..message("new exception")
        },
    )
    .unwrap();
    let errors = snapshot(
        &host,
        &selected,
        serde_json::from_value(serde_json::json!({"kind":"exception"})).unwrap(),
    );
    assert_eq!(errors.entries.len(), 1);
    assert_eq!(errors.entries[0].sequence, (sequence + 1).to_string());
    let stale = BrowserActionAuthority {
        lease: host.projection().controller.unwrap(),
        page: selected.clone(),
        operation_id: BrowserOperationId::new("stale-errors").unwrap(),
        command_sequence: host.projection().next_command_sequence,
    };
    let permit = host
        .begin_action(&stale.lease.controller_id, &stale, [])
        .unwrap();
    host.document_committed(
        &selected.page_id,
        BrowserDocumentId::new("new-document").unwrap(),
    )
    .unwrap();
    assert_eq!(
        host.clear_console(&permit, Some(BrowserConsoleKind::Exception)),
        Err(BrowserAdmissionError::DocumentChanged)
    );
}

#[test]
fn page_frames_and_workers_share_history_without_changing_control_or_document_identity() {
    let (mut host, first) = setup();
    let other = page(&mut host, "other");
    let target = host.target_for(&first).unwrap().clone();
    for source in ["frame", "worker"] {
        host.network()
            .attach(
                id(source),
                BrowserTargetId::new(source).unwrap(),
                target.clone(),
                true,
                Instant::now(),
            )
            .unwrap();
    }
    let before = host.projection();
    for source in ["page", "frame", "worker", "other"] {
        host.console_observed(&id(source), message(source)).unwrap();
    }
    assert_eq!(before, host.projection());
    let observed = snapshot(&host, &first, Default::default());
    assert_eq!(
        observed
            .entries
            .iter()
            .map(|entry| entry.source.as_str())
            .collect::<Vec<_>>(),
        ["page", "frame", "worker"]
    );
    assert_eq!(
        snapshot(&host, &other, Default::default()).entries[0].text,
        "other"
    );
    let replacement = host
        .document_committed(
            &first.page_id,
            BrowserDocumentId::new("new-document").unwrap(),
        )
        .unwrap();
    let observed = snapshot(&host, &first, Default::default());
    assert_eq!(observed.page, replacement);
    assert_eq!(observed.entries.len(), 3);
    assert_eq!(
        observed.entries[0].url.as_deref(),
        Some("https://example.test/한글")
    );
    assert_eq!(observed.entries[0].line, Some(4));
    assert_eq!(observed.entries[0].timestamp, 1700000000000.25);
    let mut wrong = first.resource.clone();
    wrong.generation = BrowserResourceGeneration::new("stale").unwrap();
    assert!(matches!(
        host.console_snapshot(&wrong, &first.page_id, Default::default()),
        Err(BrowserAdmissionError::ResourceMismatch)
    ));
}

#[test]
fn detached_and_closed_sources_cannot_recreate_history_and_exit_releases_it() {
    let (mut host, first) = setup();
    let other = page(&mut host, "other");
    host.console_observed(&id("page"), message("first"))
        .unwrap();
    host.network().detach(&id("page"), Instant::now());
    host.console_observed(&id("page"), message("late")).unwrap();
    host.console_observed(&id("unknown"), message("unknown"))
        .unwrap();
    assert_eq!(snapshot(&host, &first, Default::default()).entries.len(), 1);
    host.console_observed(&id("other"), message("other"))
        .unwrap();
    host.page_closed(&first.page_id).unwrap();
    host.console_observed(&id("page"), message("closed"))
        .unwrap();
    assert!(matches!(
        host.console_snapshot(&first.resource, &first.page_id, Default::default()),
        Err(BrowserAdmissionError::PageGone)
    ));
    assert_eq!(host.console.entries.len(), 1);
    assert_eq!(
        snapshot(&host, &other, Default::default()).entries[0].text,
        "other"
    );
    host.engine_exited(&first.resource).unwrap();
    assert_eq!(host.console.bytes, 0);
    assert!(host.console.entries.is_empty() && host.console.truncated.is_empty());
}

#[test]
fn pagination_preserves_large_sequence_values_and_does_not_duplicate_new_entries() {
    let (mut host, page) = setup();
    host.console.sequence = 9_007_199_254_740_992;
    for text in ["first", "second", "third"] {
        host.console_observed(&id("page"), message(text)).unwrap();
    }
    let first = snapshot(
        &host,
        &page,
        serde_json::from_str(r#"{"limit":2}"#).unwrap(),
    );
    assert_eq!(
        first
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["second", "third"]
    );
    assert!(first.truncated && !first.history_truncated);
    assert_eq!(first.next_before.as_deref(), Some("9007199254740994"));
    host.console_observed(&id("page"), message("new")).unwrap();
    let next = snapshot(
        &host,
        &page,
        BrowserConsoleQuery {
            limit: 2.try_into().unwrap(),
            before: Some(first.next_before.unwrap().try_into().unwrap()),
            ..Default::default()
        },
    );
    assert_eq!(next.entries.len(), 1);
    assert_eq!(next.entries[0].sequence, "9007199254740993");
    assert_eq!(next.entries[0].text, "first");
    assert!(!next.truncated);
    assert!(next.next_before.is_none());
}

#[test]
fn history_and_response_byte_limits_preserve_unicode_and_report_exact_eviction_scope() {
    let (mut host, first) = setup();
    let other = page(&mut host, "other");
    host.console_observed(&id("other"), message("other"))
        .unwrap();
    for _ in 0..MAX_ENTRIES {
        host.console_observed(&id("page"), message("short"))
            .unwrap();
    }
    assert_eq!(host.console.entries.len(), MAX_ENTRIES);
    assert!(snapshot(&host, &other, Default::default()).history_truncated);
    assert!(!snapshot(&host, &first, Default::default()).history_truncated);
    let text = "한".repeat(64 * 1024);
    let url = "글".repeat(8192);
    for _ in 0..100 {
        let mut observed = message(&text);
        observed.url = Some(&url);
        host.console_observed(&id("page"), observed).unwrap();
    }
    assert!(host.console.bytes <= MAX_HISTORY_BYTES);
    let read = snapshot(
        &host,
        &first,
        serde_json::from_str(r#"{"limit":1000}"#).unwrap(),
    );
    assert!(read.history_truncated && read.truncated && read.next_before.is_some());
    let entry_bytes: usize = read
        .entries
        .iter()
        .map(|entry| serde_json::to_vec(entry).unwrap().len())
        .sum();
    assert!(entry_bytes <= MAX_RESPONSE_BYTES);
    assert!(read.entries.len() < host.console.entries.len());
    for entry in read.entries {
        assert!(entry.metadata_truncated);
        assert!(text.starts_with(&entry.text) && entry.text.len() <= 64 * 1024);
        let observed_url = entry.url.unwrap();
        assert!(url.starts_with(&observed_url) && observed_url.len() <= 8192);
    }
}

#[test]
fn clear_uses_exact_existing_permit_and_cannot_clear_another_page_or_replay() {
    let (mut host, first) = setup();
    let other = page(&mut host, "other");
    let command = authority(&mut host, &first);
    for source in ["page", "other"] {
        host.console_observed(&id(source), message(source)).unwrap();
    }
    let mut stale = command.clone();
    stale.lease.epoch = NonZeroU64::new(99).unwrap();
    assert!(matches!(
        host.begin_action(&command.lease.controller_id, &stale, []),
        Err(BrowserAdmissionError::ControllerChanged)
    ));
    let permit = host
        .begin_action(&command.lease.controller_id, &command, [])
        .unwrap();
    assert_eq!(host.clear_console(&permit, None).unwrap(), 1);
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(
        snapshot(&host, &other, Default::default()).entries[0].text,
        "other"
    );
    assert!(
        snapshot(&host, &first, Default::default())
            .entries
            .is_empty()
    );
    host.console_observed(&id("page"), message("later"))
        .unwrap();
    assert!(matches!(
        host.begin_action(&command.lease.controller_id, &command, []),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    ));
    assert_eq!(
        snapshot(&host, &first, Default::default()).entries[0].sequence,
        "3"
    );
    let mut next = command;
    next.command_sequence = host.projection().next_command_sequence;
    let permit = host
        .begin_action(&next.lease.controller_id, &next, [])
        .unwrap();
    host.document_committed(&first.page_id, BrowserDocumentId::new("new").unwrap())
        .unwrap();
    assert!(matches!(
        host.clear_console(&permit, None),
        Err(BrowserAdmissionError::DocumentChanged)
    ));
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert_eq!(
        snapshot(&host, &first, Default::default()).entries[0].text,
        "later"
    );
}

#[test]
fn invalid_time_and_sequence_exhaustion_never_wrap_or_partially_append() {
    let (mut host, page) = setup();
    for timestamp in [f64::NAN, f64::INFINITY, -1.0] {
        let mut observed = message("invalid");
        observed.timestamp = timestamp;
        assert_eq!(
            host.console_observed(&id("page"), observed),
            Err("browser_console_timestamp_invalid")
        );
    }
    host.console.sequence = u64::MAX;
    assert_eq!(
        host.console_observed(&id("page"), message("overflow")),
        Err("browser_console_sequence_exhausted")
    );
    assert!(
        snapshot(&host, &page, Default::default())
            .entries
            .is_empty()
    );
    assert_eq!(host.console.bytes, 0);
}
