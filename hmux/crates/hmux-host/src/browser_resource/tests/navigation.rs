use super::*;

#[test]
fn navigation_continuation_requires_its_active_operation_and_observed_document() {
    let (mut host, lease, page) = setup();
    let mut permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    let navigation = host.prepare_action_navigation(&permit).unwrap();
    let committed = BrowserDocumentId::new("acknowledged-loader").unwrap();
    host.document_committed(&page.page_id, committed.clone())
        .unwrap();
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    host.continue_action_navigation(&mut permit, navigation, &committed)
        .unwrap();
    assert_eq!(host.dispatch_target(&permit).unwrap().as_str(), "target:1");
    assert_eq!(host.dispatch_frame(&permit), Ok(None));

    let navigation = host.prepare_action_navigation(&permit).unwrap();
    host.document_committed(
        &page.page_id,
        BrowserDocumentId::new("unrelated-loader").unwrap(),
    )
    .unwrap();
    assert_eq!(
        host.continue_action_navigation(&mut permit, navigation, &committed),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::DocumentChanged)
    );
}

#[test]
fn navigation_witness_cannot_cross_operations_references_or_retirement() {
    let (mut host, lease, page) = setup();
    let observed = reference(&mut host, &page);
    let permit = host
        .begin_action(
            &lease.controller_id,
            &action(&host, &lease, &page),
            [&observed],
        )
        .unwrap();
    assert!(matches!(
        host.prepare_action_navigation(&permit),
        Err(BrowserAdmissionError::PermitMismatch)
    ));
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    let stale = host.prepare_action_navigation(&permit).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let mut next = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    let document = BrowserDocumentId::new("document:1").unwrap();
    assert_eq!(
        host.continue_action_navigation(&mut next, stale, &document),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    let retiring = host.prepare_action_navigation(&next).unwrap();
    host.begin_retirement(&resource()).unwrap();
    assert_eq!(
        host.continue_action_navigation(&mut next, retiring, &document),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
}
