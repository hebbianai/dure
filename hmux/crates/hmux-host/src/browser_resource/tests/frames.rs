use super::*;

fn id(value: &str) -> BrowserFrameId {
    BrowserFrameId::new(value).unwrap()
}
fn observe(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
    name: &str,
    parent: Option<&str>,
    document: &str,
) -> BrowserFrameIdentity {
    host.frame_document_observed(
        page,
        id(name),
        parent.map(id),
        BrowserDocumentId::new(document).unwrap(),
    )
    .unwrap();
    host.frame_identity(page, &id(name)).unwrap()
}
fn select(
    host: &mut BrowserResourceHost,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    frame: Option<&BrowserFrameIdentity>,
) {
    let permit = host
        .begin_action(&lease.controller_id, &action(host, lease, page), [])
        .unwrap();
    host.select_frame(&permit, frame).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
}

#[test]
fn selection_expires_refs_and_scopes_only_its_owned_page() {
    let (mut host, lease, page) = setup();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("peer").unwrap(),
            BrowserDocumentId::new("peer-document").unwrap(),
        )
        .unwrap();
    let frame = observe(&mut host, &page, "child", Some("root"), "doc-child");
    let old = reference(&mut host, &page);
    let peer = reference(&mut host, &other);
    select(&mut host, &lease, &page, Some(&frame));
    assert_eq!(host.selected_frame(&page), Ok(Some(frame)));
    assert_eq!(
        host.validate_element(&old),
        Err(BrowserAdmissionError::SnapshotChanged)
    );
    assert_eq!(host.validate_element(&peer), Ok(&peer.element));
    assert_eq!(host.selected_frame(&other), Ok(None));
    assert_eq!(host.projection().controller, Some(lease));
}

#[test]
fn selecting_the_same_document_preserves_references_and_admitted_dispatch() {
    let (mut host, lease, page) = setup();
    let frame = observe(&mut host, &page, "child", Some("root"), "child-doc");
    for selected in [None, Some(&frame), None] {
        select(&mut host, &lease, &page, selected);
        let observed = reference(&mut host, &page);
        let permit = host
            .begin_action(
                &lease.controller_id,
                &action(&host, &lease, &page),
                [&observed],
            )
            .unwrap();
        let before = host.projection();
        host.select_frame(&permit, selected).unwrap();
        assert_eq!(host.projection(), before);
        assert_eq!(host.validate_element(&observed), Ok(&observed.element));
        assert_eq!(host.dispatch_frame(&permit), Ok(selected.cloned()));
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
}

#[test]
fn child_navigation_fences_an_admitted_action_without_changing_top_document() {
    let (mut host, lease, page) = setup();
    let frame = observe(&mut host, &page, "child", Some("root"), "doc-one");
    select(&mut host, &lease, &page, Some(&frame));
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    let newer = observe(&mut host, &page, "child", Some("root"), "doc-two");
    assert_ne!(frame, newer);
    assert_eq!(host.page_identity(&page.page_id), Ok(page.clone()));
    assert_eq!(
        host.dispatch_frame(&permit),
        Err(BrowserAdmissionError::FrameChanged)
    );
    assert!(host.dispatch_target(&permit).is_ok());
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert_eq!(host.selected_frame(&page), Ok(Some(newer)));
}

#[test]
fn removal_of_an_ancestor_does_not_fall_back_and_explicit_main_recovers() {
    let (mut host, lease, page) = setup();
    observe(&mut host, &page, "outer", Some("root"), "outer-doc");
    let frame = observe(&mut host, &page, "nested", Some("outer"), "nested-doc");
    select(&mut host, &lease, &page, Some(&frame));
    let old = reference(&mut host, &page);
    host.frame_removed(&page, &id("outer")).unwrap();
    assert_eq!(
        host.selected_frame(&page),
        Err(BrowserAdmissionError::FrameGone)
    );
    assert_eq!(
        host.validate_element(&old),
        Err(BrowserAdmissionError::SnapshotChanged)
    );
    observe(
        &mut host,
        &page,
        "nested",
        Some("root"),
        "reused-id-document",
    );
    assert_eq!(
        host.selected_frame(&page),
        Err(BrowserAdmissionError::FrameGone)
    );
    let replacement = observe(&mut host, &page, "new-child", Some("root"), "replacement");
    assert_eq!(
        host.selected_frame(&page),
        Err(BrowserAdmissionError::FrameGone)
    );
    select(&mut host, &lease, &page, None);
    assert_eq!(host.selected_frame(&page), Ok(None));
    select(&mut host, &lease, &page, Some(&replacement));
    assert_eq!(host.selected_frame(&page), Ok(Some(replacement)));
}

#[test]
fn a_handoff_drains_the_permit_and_invalidates_frame_refs() {
    let (mut host, lease, page) = setup();
    let frame = observe(&mut host, &page, "child", Some("root"), "child-doc");
    select(&mut host, &lease, &page, Some(&frame));
    let old = reference(&mut host, &page);
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [&old])
        .unwrap();
    let human = BrowserControllerId::new("human").unwrap();
    host.request_control(human.clone(), Some(&lease)).unwrap();
    assert_eq!(host.dispatch_frame(&permit), Ok(Some(frame.clone())));
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(host.projection().controller.unwrap().controller_id, human);
    assert_eq!(
        host.validate_element(&old),
        Err(BrowserAdmissionError::SnapshotChanged)
    );
    assert_eq!(host.selected_frame(&page), Ok(Some(frame)));
    assert!(matches!(
        host.begin_action(&lease.controller_id, &action(&host, &lease, &page), []),
        Err(BrowserAdmissionError::ControllerChanged)
    ));
}

#[test]
fn a_frame_from_another_page_or_document_cannot_be_selected() {
    let (mut host, lease, page) = setup();
    let frame = observe(&mut host, &page, "child", Some("root"), "old");
    observe(&mut host, &page, "child", Some("root"), "new");
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    assert_eq!(
        host.select_frame(&permit, Some(&frame)),
        Err(BrowserAdmissionError::FrameChanged)
    );
    let mut foreign = frame;
    foreign.page.page_id = BrowserPageId::new("other").unwrap();
    assert_eq!(
        host.select_frame(&permit, Some(&foreign)),
        Err(BrowserAdmissionError::PageGone)
    );
    assert_eq!(host.selected_frame(&page), Ok(None));
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
}

#[test]
fn top_navigation_resets_frame_selection_and_reused_ids_get_new_identity() {
    let (mut host, lease, page) = setup();
    let frame = observe(&mut host, &page, "child", Some("root"), "child-doc");
    select(&mut host, &lease, &page, Some(&frame));
    let next = host
        .document_committed(&page.page_id, BrowserDocumentId::new("new-top").unwrap())
        .unwrap();
    assert_eq!(host.selected_frame(&next), Ok(None));
    assert_eq!(
        host.validate_frame(&frame),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    let next_frame = observe(&mut host, &next, "child", Some("root"), "child-doc");
    assert_ne!(next_frame, frame);
}
