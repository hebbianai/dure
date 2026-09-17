use super::*;
use crate::browser_resource::{BrowserActionPermit, BrowserAdmissionError, BrowserResourceHost};
use hmux_session_protocol::browser_resource::*;

fn id(value: &str) -> BrowserNetworkId {
    BrowserNetworkId::new(value).unwrap()
}
fn target(value: &str) -> BrowserTargetId {
    BrowserTargetId::new(value).unwrap()
}
fn setup() -> (BrowserResourceHost, BrowserPageIdentity) {
    let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("r").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    });
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target("page"),
            BrowserDocumentId::new("doc").unwrap(),
        )
        .unwrap();
    host.network()
        .attach(
            id("page"),
            target("page"),
            target("page"),
            true,
            Instant::now(),
        )
        .unwrap();
    (host, page)
}
fn details(text: &str) -> BrowserNetworkRequestDetails {
    BrowserNetworkRequestDetails {
        url: format!("https://example.test/{text}"),
        headers: vec![],
        post_data: Some(text.into()),
        wall_time: 1700000000.123,
        timestamp: 10.0,
        truncated: false,
    }
}
fn start(network: &mut BrowserNetworkHost, source: &str, request: &str, text: &str) {
    network
        .started(
            &id(source),
            id(request),
            ("https://example.test/", "POST", "Fetch"),
            Instant::now(),
        )
        .unwrap();
    network.capture_request_details(&id(source), &id(request), details(text));
}
fn permit(host: &mut BrowserResourceHost, page: &BrowserPageIdentity) -> BrowserActionPermit {
    let caller = BrowserControllerId::new("agent").unwrap();
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
            "capture:{}",
            host.projection().next_command_sequence
        ))
        .unwrap(),
        command_sequence: host.projection().next_command_sequence,
    };
    host.begin_action(&caller, &authority, []).unwrap()
}

#[test]
fn recording_interval_and_neighbor_use_the_same_pending_lifetimes() {
    let (mut host, page) = setup();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target("other"),
            BrowserDocumentId::new("otherdoc").unwrap(),
        )
        .unwrap();
    let n = host.network();
    n.attach(
        id("other"),
        target("other"),
        target("other"),
        true,
        Instant::now(),
    )
    .unwrap();
    start(n, "page", "before", "before");
    n.start_capture(&target("page"));
    n.start_capture(&target("other"));
    start(n, "page", "inside", "한글");
    start(n, "other", "inside", "neighbor");
    n.completed(&id("page"), &id("before"), Ok(()), Instant::now());
    n.response(&id("page"), &id("inside"), 201);
    n.capture_body_received(&id("page"), &id("inside"), 12, 24);
    n.completed(&id("page"), &id("inside"), Ok(()), Instant::now());
    let captured = n.stop_capture(&page, &target("page"));
    assert_eq!(captured.entries.len(), 1);
    assert_eq!(
        captured.entries[0].details.post_data.as_deref(),
        Some("한글")
    );
    assert_eq!(captured.entries[0].request.status, Some(201));
    assert_eq!(captured.entries[0].body_size, Some(12));
    assert!(captured.complete && !captured.truncated);
    assert_eq!(
        n.snapshot(&page, &target("page"), Instant::now())
            .requests
            .len(),
        2
    );
    assert_eq!(
        n.snapshot(&other, &target("other"), Instant::now()).pending,
        1
    );
    assert_eq!(n.capture_status(&other, &target("other")).recorded, 1);
    let neighbor = n.stop_capture(&other, &target("other"));
    assert_eq!(
        neighbor.entries[0].request.state,
        BrowserNetworkState::Pending
    );
    assert_eq!((n.capture_count, n.capture_bytes), (0, 0));
}

#[test]
fn redirect_hops_failed_requests_and_pending_entries_keep_numeric_order() {
    let (mut host, page) = setup();
    let n = host.network();
    n.next_sequence = 9_007_199_254_740_991;
    n.start_capture(&target("page"));
    start(n, "page", "same", "redirect");
    n.response(&id("page"), &id("same"), 302);
    start(n, "page", "same", "destination");
    n.completed(&id("page"), &id("same"), Err("failed"), Instant::now());
    start(n, "page", "pending", "pending");
    let output = n.stop_capture(&page, &target("page"));
    assert_eq!(
        output
            .entries
            .iter()
            .map(|entry| entry.request.state)
            .collect::<Vec<_>>(),
        [
            BrowserNetworkState::Redirected,
            BrowserNetworkState::Failed,
            BrowserNetworkState::Pending
        ]
    );
    assert_eq!(output.entries[0].request.status, Some(302));
    assert_eq!(output.entries[1].request.error.as_deref(), Some("failed"));
    assert_eq!(output.entries[1].request.sequence, "9007199254740993");
    assert_eq!(n.pending.len(), 1);
}

#[test]
fn restart_drops_old_capture_details_without_finishing_requests() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    start(n, "page", "old", "old");
    assert_eq!(n.capture_count, 1);
    n.start_capture(&target("page"));
    assert_eq!((n.capture_count, n.capture_bytes), (0, 0));
    n.completed(&id("page"), &id("old"), Ok(()), Instant::now());
    start(n, "page", "new", "new");
    let output = n.stop_capture(&page, &target("page"));
    assert_eq!(output.entries.len(), 1);
    assert_eq!(output.entries[0].details.post_data.as_deref(), Some("new"));
    assert!(n.stop_capture(&page, &target("page")).entries.is_empty());
    assert_eq!(n.pending.len(), 1);
}

#[test]
fn resource_limits_report_capture_loss_without_corrupting_request_idle() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    start(n, "page", "large", &"x".repeat(MAX_CAPTURE_BYTES));
    n.completed(&id("page"), &id("large"), Ok(()), Instant::now());
    assert!(!n.capture_status(&page, &target("page")).complete);
    assert_eq!(n.capture_count, 0);
    n.start_capture(&target("page"));
    for i in 0..=MAX_CAPTURE_ENTRIES {
        let request = format!("request:{i}");
        start(n, "page", &request, "small");
        n.completed(&id("page"), &id(&request), Ok(()), Instant::now());
    }
    assert_eq!(n.capture_count, MAX_CAPTURE_ENTRIES);
    assert!(n.capture_bytes <= MAX_CAPTURE_BYTES);
    let output = n.stop_capture(&page, &target("page"));
    assert!(output.truncated && !output.complete);
    assert_eq!(output.entries.len(), MAX_CAPTURE_ENTRIES);
    assert!(
        n.snapshot(
            &page,
            &target("page"),
            Instant::now() + std::time::Duration::from_secs(1)
        )
        .idle
    );
    assert_eq!((n.capture_count, n.capture_bytes), (0, 0));
}

#[test]
fn exact_permit_fences_transitions_and_page_closure_releases_capture() {
    let (mut host, page) = setup();
    let allowed = permit(&mut host, &page);
    host.start_network_capture(&allowed).unwrap();
    host.finish_action(allowed, BrowserActionOutcome::Completed)
        .unwrap();
    start(host.network(), "page", "inside", "inside");
    let stale = permit(&mut host, &page);
    host.document_committed(&page.page_id, BrowserDocumentId::new("newdoc").unwrap())
        .unwrap();
    assert!(matches!(
        host.stop_network_capture(&stale, true),
        Err(BrowserAdmissionError::DocumentChanged)
    ));
    host.finish_action(stale, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    let status = host
        .network_capture_status(&page.resource, &page.page_id, true)
        .unwrap();
    assert!(status.recording);
    assert_ne!(status.page, page);
    assert_eq!(status.recorded, 1);
    host.page_closed(&page.page_id).unwrap();
    assert_eq!(
        (host.network.capture_count, host.network.capture_bytes),
        (0, 0)
    );
    assert!(host.network.captures.is_empty());
}

#[test]
fn observation_loss_and_truncated_metadata_are_explicit_in_export() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    n.started(
        &id("page"),
        id("request"),
        ("url", "GET", "Fetch"),
        Instant::now(),
    )
    .unwrap();
    let mut truncated = details("truncated");
    truncated.truncated = true;
    n.capture_request_details(&id("page"), &id("request"), truncated);
    n.observation_lost(&BTreeSet::from([target("page")]));
    let output = n.stop_capture(&page, &target("page"));
    assert!(!output.complete && output.truncated);
    assert_eq!(output.entries.len(), 1);
}

fn response() -> BrowserNetworkResponseDetails {
    BrowserNetworkResponseDetails {
        status_text: "OK".into(),
        protocol: "http/1.1".into(),
        headers: vec![],
        mime_type: "text/plain".into(),
        encoded_data_length: None,
        timing: None,
        truncated: false,
    }
}
fn extra(name: &str, value: &str) -> Vec<BrowserNetworkHeader> {
    vec![BrowserNetworkHeader {
        name: name.into(),
        value: value.into(),
    }]
}

#[test]
fn out_of_order_headers_join_the_completed_hop_and_never_move_to_a_redirect() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Cookie", "a=first"),
        None,
        false,
    );
    start(n, "page", "same", "first");
    n.capture_response_details(&id("page"), &id("same"), response(), true);
    n.response(&id("page"), &id("same"), 302);
    start(n, "page", "same", "second");
    n.capture_response_details(&id("page"), &id("same"), response(), true);
    n.completed(&id("page"), &id("same"), Ok(()), Instant::now());
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Set-Cookie", "a=first"),
        Some(302),
        false,
    );
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Cookie", "a=second"),
        None,
        false,
    );
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Set-Cookie", "a=second"),
        Some(200),
        false,
    );
    let output = n.stop_capture(&page, &target("page"));
    assert!(output.complete && !output.truncated);
    assert_eq!(output.entries[0].details.headers[0].value, "a=first");
    assert_eq!(
        output.entries[0].response.as_ref().unwrap().headers[0].value,
        "a=first"
    );
    assert_eq!(output.entries[0].request.status, Some(302));
    assert_eq!(output.entries[1].request.status, Some(200));
    assert_eq!(output.entries[1].details.headers[0].value, "a=second");
    assert_eq!(
        output.entries[1].response.as_ref().unwrap().headers[0].value,
        "a=second"
    );
    assert_eq!(
        (n.capture_count, n.capture_extra_count, n.capture_bytes),
        (0, 0, 0)
    );
}

#[test]
fn redirect_without_extra_headers_cannot_steal_the_next_hops_early_fragment() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    start(n, "page", "same", "noextra");
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Cookie", "next=yes"),
        None,
        false,
    );
    n.capture_response_details(&id("page"), &id("same"), response(), false);
    start(n, "page", "same", "hasextra");
    n.capture_response_details(&id("page"), &id("same"), response(), true);
    n.capture_extra_headers(
        &id("page"),
        &id("same"),
        extra("Set-Cookie", "next=yes"),
        Some(200),
        false,
    );
    let output = n.stop_capture(&page, &target("page"));
    assert!(output.entries[0].details.headers.is_empty());
    assert_eq!(output.entries[1].details.headers[0].value, "next=yes");
    assert!(!output.truncated);
}

#[test]
fn missing_and_overflowed_header_fragments_report_loss_and_release_their_budget() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    start(n, "page", "missing", "missing");
    n.capture_response_details(&id("page"), &id("missing"), response(), true);
    assert!(!n.capture_status(&page, &target("page")).complete);
    let output = n.stop_capture(&page, &target("page"));
    assert!(output.truncated && !output.complete);
    n.start_capture(&target("page"));
    for _ in 0..1025 {
        n.capture_extra_headers(
            &id("page"),
            &id("orphan"),
            extra("Cookie", "x=y"),
            None,
            false,
        );
    }
    assert_eq!(n.capture_extra_count, 1024);
    let output = n.stop_capture(&page, &target("page"));
    assert!(output.truncated && !output.complete);
    assert_eq!(
        (n.capture_count, n.capture_extra_count, n.capture_bytes),
        (0, 0, 0)
    );
}

#[test]
fn requests_in_flight_before_start_and_their_redirects_stay_outside_the_interval() {
    let (mut host, page) = setup();
    let n = host.network();
    start(n, "page", "old", "outside");
    n.start_capture(&target("page"));
    n.capture_extra_headers(
        &id("page"),
        &id("old"),
        extra("Cookie", "old=secret"),
        None,
        false,
    );
    n.capture_response_details(&id("page"), &id("old"), response(), true);
    start(n, "page", "old", "redirect-of-old-request");
    n.capture_response_details(&id("page"), &id("old"), response(), true);
    n.capture_extra_headers(
        &id("page"),
        &id("old"),
        extra("Set-Cookie", "old=response"),
        Some(302),
        false,
    );
    n.completed(&id("page"), &id("old"), Ok(()), Instant::now());
    start(n, "page", "inside", "inside");
    n.capture_response_details(&id("page"), &id("inside"), response(), false);
    n.completed(&id("page"), &id("inside"), Ok(()), Instant::now());
    let capture = n.stop_capture(&page, &target("page"));
    assert_eq!(
        capture.entries.len(),
        1,
        "pre-interval headers must not be rebound to a redirect"
    );
    assert_eq!(
        capture.entries[0].details.post_data.as_deref(),
        Some("inside")
    );
    assert!(capture.complete && !capture.truncated);
    assert_eq!(
        n.snapshot(&page, &target("page"), Instant::now())
            .requests
            .len(),
        3
    );
    assert_eq!(
        (n.capture_count, n.capture_bytes, n.capture_extra_count),
        (0, 0, 0)
    );
}

#[test]
fn request_metadata_loss_is_not_hidden_by_complete_header_fragments() {
    let (mut host, page) = setup();
    let n = host.network();
    n.start_capture(&target("page"));
    n.started(
        &id("page"),
        id("request"),
        ("https://example.test/", &"M".repeat(33), "Fetch"),
        Instant::now(),
    )
    .unwrap();
    n.capture_request_details(&id("page"), &id("request"), details("body"));
    n.capture_response_details(&id("page"), &id("request"), response(), false);
    n.completed(&id("page"), &id("request"), Ok(()), Instant::now());
    assert!(!n.capture_status(&page, &target("page")).complete);
    let capture = n.stop_capture(&page, &target("page"));
    assert!(capture.truncated && !capture.complete);
    assert!(capture.entries[0].request.metadata_truncated);
}
