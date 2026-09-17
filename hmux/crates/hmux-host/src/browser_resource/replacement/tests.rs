use super::*;

mod observation;

fn setup() -> (
    BrowserResourceHost,
    BrowserControllerLease,
    Vec<BrowserPageIdentity>,
) {
    let resource = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("replacement").unwrap(),
        generation: BrowserResourceGeneration::new("generation").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
    };
    let mut host = BrowserResourceHost::new(resource);
    let pages = [0, 2]
        .into_iter()
        .map(|i| {
            host.register_page(
                BrowserInstanceId::new(format!("instance:{i}")).unwrap(),
                BrowserTargetId::new(format!("target:{i}")).unwrap(),
                BrowserDocumentId::new(format!("document:{i}")).unwrap(),
            )
            .unwrap()
        })
        .collect();
    let lease = host
        .request_control(BrowserControllerId::new("controller").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    (host, lease, pages)
}

fn permit(
    host: &mut BrowserResourceHost,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> BrowserActionPermit {
    let sequence = host.projection().next_command_sequence;
    host.begin_action(
        &lease.controller_id,
        &BrowserActionAuthority {
            lease: lease.clone(),
            page: page.clone(),
            command_sequence: sequence,
            operation_id: BrowserOperationId::new(format!("replace:{sequence}")).unwrap(),
        },
        None,
    )
    .unwrap()
}

fn prepared(host: &mut BrowserResourceHost, action: &BrowserActionPermit) -> BrowserTargetId {
    let instance = BrowserInstanceId::new("instance:1").unwrap();
    let creation = host.prepare_page_replacement(action, &instance).unwrap();
    host.register_instance_binding(&action.resource, instance.clone())
        .unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new("target:replacement").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    assert_eq!(
        host.observe_page_document(
            instance,
            target.clone(),
            BrowserDocumentId::new("document:replacement").unwrap()
        )
        .unwrap(),
        None
    );
    target
}

#[test]
fn replacement_preserves_logical_identity_and_owns_old_target_until_native_absence() {
    let (mut host, lease, pages) = setup();
    let reference = BrowserElementReference {
        snapshot: host
            .snapshot_observed(&pages[0], [BrowserElementId::new("e1").unwrap()].into())
            .unwrap(),
        element: BrowserElementId::new("e1").unwrap(),
    };
    let peer = host
        .snapshot_observed(&pages[1], [BrowserElementId::new("peer").unwrap()].into())
        .unwrap();
    let mut permit = permit(&mut host, &lease, &pages[0]);
    let candidate = prepared(&mut host, &permit);
    assert_eq!(host.pages(), pages);
    assert_eq!(host.page_for_target(&candidate), None);
    let next_page = host.next_page;
    let (next, old) = host.replace_page_binding(&mut permit, &candidate).unwrap();
    assert_eq!(
        host.next_page, next_page,
        "replacement allocates no logical page ID"
    );
    assert_eq!(next.page_id, pages[0].page_id);
    assert_eq!(
        next.document_revision.get(),
        pages[0].document_revision.get() + 1
    );
    assert_eq!(host.target_for(&next).unwrap(), &candidate);
    assert_eq!(host.dispatch_target(&permit).unwrap(), &candidate);
    assert_eq!(
        host.instance_for_page(&next.page_id).unwrap().as_str(),
        "instance:1"
    );
    assert_eq!(
        host.validate_element(&reference),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert_eq!(host.pages(), vec![next.clone(), pages[1].clone()]);
    assert_eq!(
        host.target_for(&pages[0]),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert!(
        host.validate_element(&BrowserElementReference {
            snapshot: peer,
            element: BrowserElementId::new("peer").unwrap()
        })
        .is_ok()
    );
    assert!(host.owns_page_target(old.target()));
    assert!(host.page_target_is_retiring(old.target()));
    assert_eq!(
        host.register_page(
            old.instance().clone(),
            old.target().clone(),
            BrowserDocumentId::new("late").unwrap()
        ),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    host.reconcile_instance_pages(
        old.instance(),
        &[old.target().clone()].into(),
        Instant::now(),
    )
    .unwrap();
    assert!(host.owns_page_target(old.target()));
    host.reconcile_instance_pages(old.instance(), &BTreeSet::new(), Instant::now())
        .unwrap();
    assert!(host.owns_page_target(old.target()));
    host.replaced_target_retired(&old).unwrap();
    assert!(!host.owns_page_target(old.target()));
    assert_eq!(host.page_identity(&next.page_id).unwrap(), next);
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(host.projection().controller, Some(lease));
}

#[test]
fn replacement_rejects_stale_source_wrong_candidate_and_exhausted_revision_without_mutation() {
    let (mut host, lease, pages) = setup();
    let mut permit = permit(&mut host, &lease, &pages[0]);
    let candidate = prepared(&mut host, &permit);
    let before = host.projection();
    permit.page.document_revision = NonZeroU64::new(2).unwrap();
    assert_eq!(
        host.replace_page_binding(&mut permit, &candidate)
            .unwrap_err(),
        BrowserAdmissionError::DocumentChanged
    );
    assert_eq!(host.projection(), before);
    assert_eq!(host.pages(), pages);
    permit.page = pages[0].clone();
    assert_eq!(
        host.replace_page_binding(&mut permit, &BrowserTargetId::new("wrong").unwrap())
            .unwrap_err(),
        BrowserAdmissionError::PermitMismatch
    );
    host.revision = NonZeroU64::MAX;
    assert_eq!(
        host.replace_page_binding(&mut permit, &candidate)
            .unwrap_err(),
        BrowserAdmissionError::RevisionExhausted
    );
    assert_eq!(host.pages(), pages);
    assert!(!host.page_target_is_retiring(&BrowserTargetId::new("target:0").unwrap()));
}

#[test]
fn retiring_replacement_cannot_move_a_live_page() {
    let (mut host, lease, pages) = setup();
    let mut permit = permit(&mut host, &lease, &pages[0]);
    let candidate = prepared(&mut host, &permit);
    host.begin_instance_retirement(
        &pages[0].resource,
        &BrowserInstanceId::new("instance:1").unwrap(),
    )
    .unwrap();
    let before = host.projection();
    assert_eq!(
        host.replace_page_binding(&mut permit, &candidate)
            .unwrap_err(),
        BrowserAdmissionError::ResourceRetiring
    );
    assert_eq!(host.projection(), before);
    assert_eq!(host.pages(), pages);
}

#[test]
fn replacement_waits_for_held_input_and_finishes_the_existing_handoff() {
    use hmux_session_protocol::browser_keyboard::BrowserKey;
    let (mut host, lease, pages) = setup();
    let key_action = permit(&mut host, &lease, &pages[0]);
    let key = BrowserKey::try_from(String::from("Shift")).unwrap();
    let pressed = host.prepare_key(&key_action, key, true).unwrap();
    host.keyboard_applied(pressed).unwrap();
    host.finish_action(key_action, BrowserActionOutcome::Completed)
        .unwrap();
    let mut replacement = permit(&mut host, &lease, &pages[0]);
    let candidate = prepared(&mut host, &replacement);
    let human = BrowserControllerId::new("human").unwrap();
    host.request_control(human.clone(), Some(&lease)).unwrap();
    let before = host.projection();
    assert_eq!(
        host.replace_page_binding(&mut replacement, &candidate)
            .unwrap_err(),
        BrowserAdmissionError::ActionInFlight
    );
    assert_eq!(host.projection(), before);
    let released = host
        .keyboard_release_before_action(&replacement, true)
        .unwrap()
        .unwrap();
    host.keyboard_applied(released).unwrap();
    let (page, _) = host
        .replace_page_binding(&mut replacement, &candidate)
        .unwrap();
    assert_eq!(host.projection().controller, Some(lease));
    assert_eq!(host.projection().requested_controller, Some(human.clone()));
    host.finish_action(replacement, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(host.projection().controller.unwrap().controller_id, human);
    assert!(host.projection().keyboard.is_none());
    assert_eq!(host.page_identity(&pages[0].page_id).unwrap(), page);
}

#[test]
fn replacement_at_page_and_instance_capacity_consumes_only_its_existing_logical_slot() {
    for existing in [false, true] {
        let (mut host, lease, _) = setup();
        for i in 2..MAX_LIVE_PAGES {
            host.register_page(
                BrowserInstanceId::new(format!("full:{i}")).unwrap(),
                BrowserTargetId::new(format!("full:{i}")).unwrap(),
                BrowserDocumentId::new(format!("full:{i}")).unwrap(),
            )
            .unwrap();
        }
        let pages = host.pages();
        assert_eq!(pages.len(), MAX_LIVE_PAGES);
        assert_eq!(host.instance_binding_ids().len(), MAX_LIVE_PAGES);
        assert_eq!(
            host.reserve_page_target(
                &pages[0].resource,
                BrowserInstanceId::new("instance:0").unwrap(),
                BrowserTargetId::new("extra").unwrap()
            ),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        let mut action = permit(&mut host, &lease, &pages[0]);
        let instance = BrowserInstanceId::new(if existing {
            "instance:2"
        } else {
            "new:instance"
        })
        .unwrap();
        let creation = host.prepare_page_replacement(&action, &instance).unwrap();
        if !existing {
            host.register_instance_binding(&pages[0].resource, instance.clone())
                .unwrap();
        }
        host.begin_page_creation(&creation, &instance).unwrap();
        let target = BrowserTargetId::new("replacement").unwrap();
        host.reserve_created_page_target(&creation, target.clone())
            .unwrap();
        assert_eq!(
            host.register_instance_binding(
                &pages[0].resource,
                BrowserInstanceId::new("unadmitted").unwrap()
            ),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        assert_eq!(
            host.observe_page_document(
                instance.clone(),
                target.clone(),
                BrowserDocumentId::new("replacement").unwrap()
            )
            .unwrap(),
            None
        );
        assert_eq!(host.pages(), pages);
        assert_eq!(host.live_page_capacity(), MAX_LIVE_PAGES);
        assert_eq!(
            host.register_page(
                instance.clone(),
                target.clone(),
                BrowserDocumentId::new("bypass").unwrap()
            ),
            Err(BrowserAdmissionError::PermitMismatch)
        );
        let (next, old) = host.replace_page_binding(&mut action, &target).unwrap();
        assert_eq!(host.pages().len(), MAX_LIVE_PAGES);
        assert_eq!(host.live_page_capacity(), MAX_LIVE_PAGES);
        assert_eq!(host.instance_for_page(&next.page_id).unwrap(), &instance);
        assert_eq!(
            host.reserve_page_target(
                &next.resource,
                instance,
                BrowserTargetId::new("still-extra").unwrap()
            ),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        host.replaced_target_retired(&old).unwrap();
        host.begin_instance_retirement(&next.resource, old.instance())
            .unwrap();
        host.instance_binding_retired(&next.resource, old.instance())
            .unwrap();
        host.finish_action(action, BrowserActionOutcome::Completed)
            .unwrap();
        assert_eq!(
            host.instance_binding_ids().len(),
            MAX_LIVE_PAGES - usize::from(existing)
        );
    }
}

#[test]
fn replacement_requires_exact_observed_destination_and_retains_cleanup_during_close() {
    let (mut host, lease, pages) = setup();
    let mut action = permit(&mut host, &lease, &pages[0]);
    let instance = BrowserInstanceId::new("instance:1").unwrap();
    let creation = host.prepare_page_replacement(&action, &instance).unwrap();
    host.register_instance_binding(&pages[0].resource, instance.clone())
        .unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new("replacement").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    assert_eq!(
        host.replace_page_binding(&mut action, &target).unwrap_err(),
        BrowserAdmissionError::PermitMismatch
    );
    assert_eq!(
        host.observe_page_document(
            BrowserInstanceId::new("wrong").unwrap(),
            target.clone(),
            BrowserDocumentId::new("wrong").unwrap()
        ),
        Err(BrowserAdmissionError::InstanceMismatch)
    );
    host.observe_page_document(
        instance,
        target.clone(),
        BrowserDocumentId::new("prepared").unwrap(),
    )
    .unwrap();
    host.begin_retirement(&pages[0].resource).unwrap();
    assert_eq!(
        host.replace_page_binding(&mut action, &target).unwrap_err(),
        BrowserAdmissionError::ResourceRetiring
    );
    assert_eq!(host.pages(), pages);
    assert!(host.owns_page_target(&target));
    assert!(host.page_target_is_retiring(&target));
    host.engine_exited(&pages[0].resource).unwrap();
    assert!(host.pages().is_empty());
    assert!(host.owned_page_targets().is_empty());
}
