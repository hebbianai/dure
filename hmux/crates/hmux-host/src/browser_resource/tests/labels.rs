use super::*;

fn named_page(
    host: &mut BrowserResourceHost,
    lease: &BrowserControllerLease,
    source: &BrowserPageIdentity,
    target: &str,
) -> BrowserPageIdentity {
    let permit = host
        .begin_action(&lease.controller_id, &action(host, lease, source), None)
        .unwrap();
    host.reserve_creation_label(&permit, BrowserPageLabel::new("docs").unwrap())
        .unwrap();
    let creation = host.prepare_page_creation(&permit).unwrap();
    let instance = host.instance_for_page(&source.page_id).unwrap().clone();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new(target).unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    host.register_page(
        instance,
        target,
        BrowserDocumentId::new("named-document").unwrap(),
    )
    .unwrap()
}

#[test]
fn labels_follow_exact_created_targets_across_late_observation_and_close() {
    let (mut host, lease, source) = setup();
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &source), None)
        .unwrap();
    let label = BrowserPageLabel::new("docs").unwrap();
    host.reserve_creation_label(&permit, label.clone()).unwrap();
    assert_eq!(
        host.reserve_creation_label(&permit, label.clone()),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    );
    let creation = host.prepare_page_creation(&permit).unwrap();
    let instance = BrowserInstanceId::new("instance").unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new("named-target").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();

    let duplicate = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &source), None)
        .unwrap();
    assert_eq!(
        host.reserve_creation_label(&duplicate, label.clone()),
        Err(BrowserAdmissionError::PageLabelTaken)
    );
    assert_eq!(host.page_creation_state(&duplicate).unwrap(), None);
    host.finish_action(duplicate, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    let popup = host
        .register_page(
            instance.clone(),
            BrowserTargetId::new("other-target").unwrap(),
            BrowserDocumentId::new("popup").unwrap(),
        )
        .unwrap();
    assert_eq!(host.page_label(&popup).unwrap(), None);
    let named = host
        .register_page(instance, target, BrowserDocumentId::new("named").unwrap())
        .unwrap();
    assert_eq!(host.page_label(&named).unwrap(), Some(&label));
    assert_eq!(host.page_label(&source).unwrap(), None);
    host.page_closed(&named.page_id).unwrap();
    assert_eq!(
        host.page_label(&named),
        Err(BrowserAdmissionError::PageGone)
    );
    let reused = named_page(&mut host, &lease, &source, "reused-target");
    assert_ne!(reused.page_id, named.page_id);
    assert_eq!(host.page_label(&reused).unwrap(), Some(&label));
}

#[test]
fn labels_survive_document_profile_replacement_and_control_handoff() {
    let (mut host, lease, source) = setup();
    let named = named_page(&mut host, &lease, &source, "named-target");
    let navigated = host
        .document_committed(&named.page_id, BrowserDocumentId::new("navigated").unwrap())
        .unwrap();
    let label = BrowserPageLabel::new("docs").unwrap();
    assert_eq!(
        host.page_label(&named),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert_eq!(host.page_label(&navigated).unwrap(), Some(&label));
    let mut permit = host
        .begin_action(
            &lease.controller_id,
            &action(&host, &lease, &navigated),
            None,
        )
        .unwrap();
    let instance = BrowserInstanceId::new("replacement-instance").unwrap();
    let creation = host.prepare_page_replacement(&permit, &instance).unwrap();
    host.register_instance_binding(&source.resource, instance.clone())
        .unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new("replacement-target").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    host.observe_page_document(
        instance,
        target.clone(),
        BrowserDocumentId::new("replacement-document").unwrap(),
    )
    .unwrap();
    let (replaced, retired) = host.replace_page_binding(&mut permit, &target).unwrap();
    host.replaced_target_retired(&retired).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(replaced.page_id, named.page_id);
    assert_eq!(host.page_label(&replaced).unwrap(), Some(&label));
    let next = host
        .request_control(controller("human"), Some(&lease))
        .unwrap()
        .controller
        .unwrap();
    assert_eq!(host.page_label(&replaced).unwrap(), Some(&label));
    let duplicate = host
        .begin_action(&next.controller_id, &action(&host, &next, &source), None)
        .unwrap();
    assert_eq!(
        host.reserve_creation_label(&duplicate, label),
        Err(BrowserAdmissionError::PageLabelTaken)
    );
    host.finish_action(duplicate, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
}

#[test]
fn rejected_creations_release_names_and_late_assignment_is_rejected() {
    let (mut host, lease, source) = setup();
    for native_rejection in [false, true] {
        let permit = host
            .begin_action(&lease.controller_id, &action(&host, &lease, &source), None)
            .unwrap();
        host.reserve_creation_label(&permit, BrowserPageLabel::new("docs").unwrap())
            .unwrap();
        let creation = host.prepare_page_creation(&permit).unwrap();
        if native_rejection {
            host.begin_page_creation(&creation, &BrowserInstanceId::new("instance").unwrap())
                .unwrap();
            host.page_creation_rejected(&creation).unwrap();
        }
        host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
    }
    let page = named_page(&mut host, &lease, &source, "after-rejections");
    assert_eq!(host.page_label(&page).unwrap().unwrap().as_str(), "docs");
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &source), None)
        .unwrap();
    host.prepare_page_creation(&permit).unwrap();
    assert_eq!(
        host.reserve_creation_label(&permit, BrowserPageLabel::new("late").unwrap()),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    );
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
}

#[test]
fn the_same_name_belongs_independently_to_each_resource_even_with_a_shared_instance() {
    let (mut first, lease, source) = setup();
    named_page(&mut first, &lease, &source, "first-named");
    let mut identity = resource();
    identity.resource_id = BrowserResourceId::new("peer-resource").unwrap();
    let mut peer = BrowserResourceHost::new(identity);
    let page = peer
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("peer-target").unwrap(),
            BrowserDocumentId::new("peer-doc").unwrap(),
        )
        .unwrap();
    let lease = peer
        .request_control(controller("cli"), None)
        .unwrap()
        .controller
        .unwrap();
    let named = named_page(&mut peer, &lease, &page, "peer-named");
    assert_eq!(peer.page_label(&named).unwrap().unwrap().as_str(), "docs");
    let foreign = first
        .pages()
        .into_iter()
        .find(|page| first.page_label(page).unwrap().is_some())
        .unwrap();
    assert_eq!(
        peer.page_label(&foreign),
        Err(BrowserAdmissionError::ResourceMismatch)
    );
}
