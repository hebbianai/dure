use super::*;
use hmux_session_protocol::browser_resource::*;
use std::time::Duration;

fn id(value: &str) -> BrowserNetworkId {
    BrowserNetworkId::new(value).unwrap()
}

fn setup() -> (BrowserResourceHost, BrowserPageIdentity, Instant) {
    let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:1").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    });
    let target = BrowserTargetId::new("target:1").unwrap();
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new("document:1").unwrap(),
        )
        .unwrap();
    let now = Instant::now();
    host.network()
        .attach(id("source:1"), target.clone(), target, true, now)
        .unwrap();
    (host, page, now)
}

fn history_permit(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
) -> crate::browser_resource::BrowserActionPermit {
    let caller = BrowserControllerId::new("history-agent").unwrap();
    let lease = host.projection().controller.unwrap_or_else(|| {
        host.request_control(caller.clone(), None)
            .unwrap()
            .controller
            .unwrap()
    });
    let authority = BrowserActionAuthority {
        lease,
        page: page.clone(),
        operation_id: BrowserOperationId::new(format!(
            "history-{}",
            host.projection().next_command_sequence
        ))
        .unwrap(),
        command_sequence: host.projection().next_command_sequence,
    };
    host.begin_action(&caller, &authority, []).unwrap()
}

fn request_metadata(
    body: &str,
) -> hmux_session_protocol::browser_network_capture::BrowserNetworkRequestDetails {
    hmux_session_protocol::browser_network_capture::BrowserNetworkRequestDetails {
        url: "https://fixture/한글".into(),
        headers: vec![],
        post_data: Some(body.into()),
        wall_time: 1700000000.0,
        timestamp: 1.0,
        truncated: false,
    }
}

fn sequence(value: &str) -> BrowserNetworkSequence {
    serde_json::from_value(serde_json::json!(value)).unwrap()
}

#[test]
fn history_clear_preserves_pending_lifetimes_har_and_other_pages_without_resurrection() {
    let (mut host, page, now) = setup();
    let other_target = BrowserTargetId::new("other").unwrap();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            other_target.clone(),
            BrowserDocumentId::new("other").unwrap(),
        )
        .unwrap();
    host.network()
        .attach(id("other"), other_target.clone(), other_target, true, now)
        .unwrap();
    let target = host.target_for(&page).unwrap().clone();
    host.network().start_capture(&target);
    for (source, name) in [
        ("source:1", "completed"),
        ("source:1", "pending"),
        ("other", "peer"),
    ] {
        host.network()
            .started(
                &id(source),
                id(name),
                ("https://fixture/", "GET", "Fetch"),
                now,
            )
            .unwrap();
        host.network()
            .observed_request_details(&id(source), &id(name), request_metadata(name));
        if name != "pending" {
            host.network()
                .completed(&id(source), &id(name), Ok(()), now);
        }
    }
    let before = host.network_snapshot(&page, now).unwrap();
    let old = before.requests[1].sequence.clone();
    let peer = serde_json::to_value(host.network_snapshot(&other, now).unwrap()).unwrap();
    let permit = history_permit(&mut host, &page);
    assert_eq!(host.clear_network(&permit).unwrap(), 2);
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let cleared = host
        .network_snapshot(&page, now + Duration::from_secs(5))
        .unwrap();
    assert!(cleared.requests.is_empty() && !cleared.idle && cleared.complete);
    assert_eq!(cleared.pending, 1);
    assert!(host.network_read(&page, sequence(&old)).unwrap().is_none());
    assert_eq!(
        serde_json::to_value(host.network_snapshot(&other, now).unwrap()).unwrap(),
        peer
    );
    host.network().completed(
        &id("source:1"),
        &id("pending"),
        Ok(()),
        now + Duration::from_secs(6),
    );
    let drained = host
        .network_snapshot(&page, now + Duration::from_millis(6500))
        .unwrap();
    assert!(drained.requests.is_empty() && drained.idle);
    assert_eq!(drained.pending, 0);
    let captured = host.network().stop_capture(&page, &target);
    assert_eq!(captured.entries.len(), 2);
    assert!(captured
        .entries
        .iter()
        .all(|entry| entry.request.state == BrowserNetworkState::Finished));
    host.network()
        .started(
            &id("source:1"),
            id("new"),
            ("https://fixture/new", "GET", "Fetch"),
            now,
        )
        .unwrap();
    assert_eq!(host.network_snapshot(&page, now).unwrap().requests.len(), 1);
    let stale = history_permit(&mut host, &page);
    host.document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    assert_eq!(
        host.clear_network(&stale),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert!(host.network_read(&page, sequence(&old)).is_err());
}

#[test]
fn request_detail_uses_issued_sequences_and_never_reads_a_reused_native_id() {
    let (mut host, page, now) = setup();
    for name in ["redirect", "final"] {
        host.network()
            .started(
                &id("source:1"),
                id("same"),
                ("https://fixture/", "POST", "Fetch"),
                now,
            )
            .unwrap();
        host.network().observed_request_details(
            &id("source:1"),
            &id("same"),
            request_metadata(name),
        );
    }
    host.network().response(&id("source:1"), &id("same"), 201);
    host.network()
        .observed_body_received(&id("source:1"), &id("same"), 3, 6);
    host.network()
        .completed(&id("source:1"), &id("same"), Ok(()), now);
    let first = host.network_read(&page, sequence("1")).unwrap().unwrap();
    assert_eq!(first.detail.request.state, BrowserNetworkState::Redirected);
    assert_eq!(
        first.detail.details.unwrap().post_data.as_deref(),
        Some("redirect")
    );
    assert!(first.body_source.is_none());
    let second = host.network_read(&page, sequence("2")).unwrap().unwrap();
    assert_eq!(
        second.detail.details.unwrap().post_data.as_deref(),
        Some("final")
    );
    assert_eq!(second.body_source, Some((id("source:1"), id("same"))));
    assert_eq!(second.decoded_bytes, Some(6));
    host.network()
        .started(
            &id("source:1"),
            id("same"),
            ("https://fixture/reused", "GET", "Fetch"),
            now,
        )
        .unwrap();
    assert!(host
        .network_read(&page, sequence("2"))
        .unwrap()
        .unwrap()
        .body_source
        .is_none());
    assert!(host
        .network_read(&page, sequence("3"))
        .unwrap()
        .unwrap()
        .body_source
        .is_none());
    host.network()
        .completed(&id("source:1"), &id("same"), Ok(()), now);
    host.network().detach(&id("source:1"), now);
    assert!(host
        .network_read(&page, sequence("3"))
        .unwrap()
        .unwrap()
        .body_source
        .is_none());
    assert!(host.network_read(&page, sequence("999")).unwrap().is_none());
}

#[test]
fn history_metadata_and_eviction_are_bounded_and_clear_returns_only_its_pages_capacity() {
    let (mut host, page, now) = setup();
    let body = "x".repeat(64 * 1024);
    for n in 0..260 {
        let request = id(&format!("request:{n}"));
        host.network()
            .started(
                &id("source:1"),
                request.clone(),
                ("https://fixture/", "POST", "Fetch"),
                now,
            )
            .unwrap();
        let mut details = request_metadata(&body);
        details.headers.push(
            hmux_session_protocol::browser_network_capture::BrowserNetworkHeader {
                name: "X-Test".into(),
                value: "y".repeat(8 * 1024),
            },
        );
        host.network()
            .observed_request_details(&id("source:1"), &request, details);
        host.network()
            .completed(&id("source:1"), &request, Ok(()), now);
        assert!(host.network().metadata_bytes <= 16 * 1024 * 1024);
    }
    let before = host.network_snapshot(&page, now).unwrap();
    assert!(before.history_truncated);
    assert_eq!(before.requests.len(), 256);
    assert!(host.network_read(&page, sequence("1")).unwrap().is_none());
    assert!(before.requests.iter().any(|entry| host
        .network_read(&page, sequence(&entry.sequence))
        .unwrap()
        .unwrap()
        .detail
        .metadata_truncated));
    let permit = history_permit(&mut host, &page);
    assert_eq!(host.clear_network(&permit).unwrap(), 256);
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(host.network().metadata_bytes, 0);
    assert!(!host.network_snapshot(&page, now).unwrap().history_truncated);
    host.network()
        .started(
            &id("source:1"),
            id("new"),
            ("https://fixture/", "POST", "Fetch"),
            now,
        )
        .unwrap();
    host.network()
        .observed_request_details(&id("source:1"), &id("new"), request_metadata("복구"));
    let read = host.network_read(&page, sequence("261")).unwrap().unwrap();
    assert!(!read.detail.metadata_truncated);
    assert_eq!(
        read.detail.details.unwrap().post_data.as_deref(),
        Some("복구")
    );
}

#[test]
fn requests_started_before_observation_and_response_headers_prevent_idle() {
    let (mut host, page, now) = setup();
    host.network()
        .started(
            &id("source:1"),
            id("request:1"),
            ("https://example.test/slow", "GET", "Fetch"),
            now,
        )
        .unwrap();
    host.network()
        .response(&id("source:1"), &id("request:1"), 200);
    let headers = host
        .network_snapshot(&page, now + Duration::from_secs(9))
        .unwrap();
    assert!(headers.complete);
    assert!(!headers.idle);
    assert_eq!(headers.pending, 1);
    assert_eq!(headers.requests[0].status, Some(200));
    host.network().finish(
        &id("source:1"),
        &id("request:1"),
        BrowserNetworkState::Finished,
        None,
        now + Duration::from_secs(10),
    );
    assert!(
        !host
            .network_snapshot(&page, now + Duration::from_millis(10_499))
            .unwrap()
            .idle
    );
    assert!(
        host.network_snapshot(&page, now + Duration::from_millis(10_500))
            .unwrap()
            .idle
    );
}

#[test]
fn sources_with_identical_request_ids_remain_isolated_and_follow_page_document() {
    let (mut host, page, now) = setup();
    let target = BrowserTargetId::new("target:2").unwrap();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new("document:2").unwrap(),
        )
        .unwrap();
    host.network()
        .attach(id("source:2"), target.clone(), target, true, now)
        .unwrap();
    for source in ["source:1", "source:2"] {
        host.network()
            .started(
                &id(source),
                id("same"),
                ("https://example.test/", "GET", "Document"),
                now,
            )
            .unwrap();
    }
    host.network().finish(
        &id("source:1"),
        &id("same"),
        BrowserNetworkState::Finished,
        None,
        now,
    );
    assert!(
        host.network_snapshot(&page, now + Duration::from_secs(1))
            .unwrap()
            .idle
    );
    assert_eq!(
        host.network_snapshot(&other, now + Duration::from_secs(1))
            .unwrap()
            .pending,
        1
    );
    let replacement = host
        .document_committed(
            &other.page_id,
            BrowserDocumentId::new("document:3").unwrap(),
        )
        .unwrap();
    assert!(matches!(
        host.network_snapshot(&other, now),
        Err(BrowserAdmissionError::DocumentChanged)
    ));
    assert_eq!(host.network_snapshot(&replacement, now).unwrap().pending, 1);
}

#[test]
fn redirect_hops_and_failures_complete_once_and_history_never_evicts_active_work() {
    let (mut host, page, now) = setup();
    host.network()
        .started(&id("source:1"), id("held"), ("held", "GET", "Fetch"), now)
        .unwrap();
    for n in 0..300 {
        host.network()
            .started(
                &id("source:1"),
                id("redirect"),
                (&format!("url:{n}"), "GET", "Document"),
                now,
            )
            .unwrap();
    }
    host.network().finish(
        &id("source:1"),
        &id("redirect"),
        BrowserNetworkState::Failed,
        Some("connection refused"),
        now,
    );
    let snapshot = host
        .network_snapshot(&page, now + Duration::from_secs(2))
        .unwrap();
    assert!(snapshot.complete && snapshot.history_truncated && !snapshot.idle);
    assert_eq!(snapshot.pending, 1);
    assert_eq!(snapshot.requests.len(), MAX_HISTORY + 1);
    assert_eq!(snapshot.requests[0].url, "held");
    assert_eq!(
        snapshot.requests.last().unwrap().state,
        BrowserNetworkState::Failed
    );
}

#[test]
fn overflow_and_disconnect_cannot_publish_false_idle() {
    let (mut host, page, now) = setup();
    for n in 0..MAX_PENDING {
        host.network()
            .started(
                &id("source:1"),
                id(&format!("request:{n}")),
                ("url", "GET", "Fetch"),
                now,
            )
            .unwrap();
    }
    assert_eq!(
        host.network().started(
            &id("source:1"),
            id("overflow"),
            ("url", "GET", "Fetch"),
            now
        ),
        Err("browser_network_pending_limit")
    );
    host.network().detach(&id("source:1"), now);
    let snapshot = host
        .network_snapshot(&page, now + Duration::from_secs(10))
        .unwrap();
    assert!(!snapshot.complete && !snapshot.idle);
    assert_eq!(snapshot.pending, MAX_PENDING);
    assert!(snapshot.quiet_ms.is_none());
}

#[test]
fn late_observation_and_connection_loss_remain_incomplete() {
    let (mut host, page, now) = setup();
    let target = host.target_for(&page).unwrap().clone();
    host.network()
        .attach(
            id("late:iframe"),
            BrowserTargetId::new("iframe:1").unwrap(),
            target,
            false,
            now,
        )
        .unwrap();
    assert!(
        !host
            .network_snapshot(&page, now + Duration::from_secs(2))
            .unwrap()
            .complete
    );
    let (mut host, page, now) = setup();
    let target = host.target_for(&page).unwrap().clone();
    host.network()
        .observation_lost(&BTreeSet::from([target.clone()]));
    assert!(
        !host
            .network_snapshot(&page, now + Duration::from_secs(2))
            .unwrap()
            .idle
    );
}

#[test]
fn page_retirement_releases_only_its_network_state() {
    let (mut host, page, now) = setup();
    host.network()
        .started(&id("source:1"), id("held"), ("url", "GET", "Fetch"), now)
        .unwrap();
    host.page_closed(&page.page_id).unwrap();
    assert!(matches!(
        host.network_snapshot(&page, now),
        Err(BrowserAdmissionError::PageGone)
    ));
    assert!(host.network().pending.is_empty());
    assert!(host.network().source_target(&id("source:1")).is_none());
}

#[test]
fn child_source_can_finish_the_same_pages_parent_request() {
    let (mut host, page, now) = setup();
    let target = host.target_for(&page).unwrap().clone();
    host.network()
        .started(
            &id("source:1"),
            id("document-request"),
            ("https://other.test/frame", "GET", "Document"),
            now,
        )
        .unwrap();
    host.network()
        .attach(
            id("child:1"),
            BrowserTargetId::new("iframe:1").unwrap(),
            target,
            true,
            now,
        )
        .unwrap();
    host.network()
        .response(&id("child:1"), &id("document-request"), 200);
    host.network().finish(
        &id("child:1"),
        &id("document-request"),
        BrowserNetworkState::Finished,
        None,
        now,
    );
    let snapshot = host
        .network_snapshot(&page, now + Duration::from_secs(1))
        .unwrap();
    assert!(snapshot.idle && snapshot.complete);
    assert_eq!(snapshot.requests.len(), 1);
    assert_eq!(snapshot.requests[0].state, BrowserNetworkState::Finished);
}

#[test]
fn metadata_truncation_preserves_unicode_and_large_sequence_identity() {
    let (mut host, page, now) = setup();
    host.network().next_sequence = 9_007_199_254_740_992;
    let url = format!("https://example.test/{}", "한".repeat(1024));
    host.network()
        .started(&id("source:1"), id("long"), (&url, "GET", "Fetch"), now)
        .unwrap();
    host.network()
        .completed(&id("source:1"), &id("long"), Ok(()), now);
    let snapshot = host
        .network_snapshot(&page, now + Duration::from_secs(1))
        .unwrap();
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(json["requests"][0]["sequence"], "9007199254740993");
    assert!(snapshot.requests[0].metadata_truncated);
    assert!(url.starts_with(&snapshot.requests[0].url));
    assert!(snapshot.requests[0].url.len() <= 1024);
    assert!(snapshot.idle);
    assert!(BrowserNetworkId::new(&"x".repeat(161)).is_err());
}

#[test]
fn source_closure_does_not_finish_requests_that_can_migrate_between_processes() {
    let (mut host, page, now) = setup();
    let target = host.target_for(&page).unwrap().clone();
    let child_target = BrowserTargetId::new("child-target:1").unwrap();
    host.network()
        .attach(
            id("child:1"),
            child_target.clone(),
            target.clone(),
            true,
            now,
        )
        .unwrap();
    host.network()
        .started(&id("child:1"), id("held"), ("url", "GET", "Fetch"), now)
        .unwrap();
    host.network().detach(&id("child:1"), now);
    host.network().reconcile_sources(
        &BTreeSet::from([target.clone()]),
        &BTreeSet::from([target.clone(), child_target]),
        now,
    );
    let lost = host
        .network_snapshot(&page, now + Duration::from_secs(1))
        .unwrap();
    assert!(!lost.complete && !lost.idle);
    assert_eq!(lost.pending, 1);
    host.network().reconcile_sources(
        &BTreeSet::from([target.clone()]),
        &BTreeSet::from([target.clone()]),
        now + Duration::from_secs(2),
    );
    let closed = host
        .network_snapshot(&page, now + Duration::from_millis(2500))
        .unwrap();
    assert!(!closed.complete && !closed.idle);
    assert_eq!(closed.pending, 1);
    host.network().completed(
        &id("source:1"),
        &id("held"),
        Ok(()),
        now + Duration::from_secs(3),
    );
    host.network().reconcile_sources(
        &BTreeSet::from([target.clone()]),
        &BTreeSet::from([target]),
        now + Duration::from_secs(3),
    );
    let finished = host
        .network_snapshot(&page, now + Duration::from_millis(3500))
        .unwrap();
    assert!(finished.complete && finished.idle);
    assert_eq!(finished.pending, 0);
    assert_eq!(finished.requests[0].state, BrowserNetworkState::Finished);
}

#[test]
fn sequence_exhaustion_permanently_invalidates_observation() {
    let (mut host, page, now) = setup();
    host.network().next_sequence = u64::MAX;
    assert_eq!(
        host.network().started(
            &id("source:1"),
            id("request:1"),
            ("url", "GET", "Fetch"),
            now
        ),
        Err("browser_network_sequence_exhausted")
    );
    assert!(
        !host
            .network_snapshot(&page, now + Duration::from_secs(1))
            .unwrap()
            .complete
    );
}

#[test]
fn attached_source_survives_a_census_that_does_not_yet_list_its_target() {
    let (mut host, page, now) = setup();
    let target = host.target_for(&page).unwrap().clone();
    let child = id("provisional-child");
    host.network()
        .attach(
            child.clone(),
            BrowserTargetId::new("provisional-target").unwrap(),
            target.clone(),
            true,
            now,
        )
        .unwrap();
    host.network().reconcile_sources(
        &BTreeSet::from([target.clone()]),
        &BTreeSet::from([target.clone()]),
        now,
    );
    assert!(host.network().source_is_attached(&child));
    host.network()
        .started(&child, id("fetch"), ("url", "GET", "Fetch"), now)
        .unwrap();
    assert_eq!(host.network_snapshot(&page, now).unwrap().pending, 1);
    host.network().completed(&child, &id("fetch"), Ok(()), now);
    host.network().detach(&child, now);
    host.network().reconcile_sources(
        &BTreeSet::from([target.clone()]),
        &BTreeSet::from([target]),
        now,
    );
    assert!(!host.network().sources().contains(&child));
    let finished = host
        .network_snapshot(&page, now + Duration::from_secs(1))
        .unwrap();
    assert!(finished.complete && finished.idle);
}
