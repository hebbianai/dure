use super::*;

fn authority(host: &mut BrowserResourceHost, page: &BrowserPageIdentity) -> BrowserActionAuthority {
    let lease = host
        .request_control(BrowserControllerId::new("controller").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    BrowserActionAuthority {
        lease,
        page: page.clone(),
        command_sequence: host.projection().next_command_sequence,
        operation_id: BrowserOperationId::new("operation").unwrap(),
    }
}

#[test]
fn retirement_preserves_peer_identity_references_network_and_admitted_action() {
    let (mut host, instances, pages) = fixture();
    let resource = host.projection().resource;
    let request = authority(&mut host, &pages[1]);
    let reference = BrowserElementReference {
        snapshot: host
            .snapshot_observed(
                &pages[1],
                BTreeSet::from([BrowserElementId::new("element").unwrap()]),
            )
            .unwrap(),
        element: BrowserElementId::new("element").unwrap(),
    };
    let permit = host
        .begin_action(&request.lease.controller_id, &request, [&reference])
        .unwrap();
    host.begin_instance_retirement(&resource, &instances[0])
        .unwrap();
    assert!(
        !host
            .instance_binding_retired(&resource, &instances[0])
            .unwrap()
    );
    assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
    assert_eq!(host.projection().controller, Some(request.lease));
    assert_eq!(host.pages(), vec![pages[1].clone()]);
    assert!(host.validate_element(&reference).is_ok());
    assert!(
        host.network_snapshot(&pages[1], Instant::now())
            .unwrap()
            .complete
    );
    assert_eq!(
        host.dispatch_target(&permit),
        Ok(&BrowserTargetId::new("target:1").unwrap())
    );
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    host.begin_instance_retirement(&resource, &instances[1])
        .unwrap();
    assert_eq!(host.projection().phase, BrowserResourcePhase::Retiring);
    assert!(
        host.instance_binding_retired(&resource, &instances[1])
            .unwrap()
    );
    assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
    assert!(host.pages().is_empty());
    assert_eq!(host.projection().controller, None);
}

#[test]
fn retirement_fences_queued_creation_actions_registration_and_renderer_clock() {
    let (mut host, instances, pages) = fixture();
    let resource = host.projection().resource;
    let request = authority(&mut host, &pages[0]);
    let permit = host
        .begin_action(&request.lease.controller_id, &request, None)
        .unwrap();
    let creation = host.prepare_page_creation(&permit).unwrap();
    let target = host.target_for(&pages[0]).unwrap().clone();
    host.begin_instance_retirement(&resource, &instances[0])
        .unwrap();
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    assert_eq!(
        host.begin_page_creation(&creation, &instances[0]),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    assert_eq!(
        host.reserve_page_target(
            &resource,
            instances[0].clone(),
            BrowserTargetId::new("late-reserved").unwrap()
        ),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    assert_eq!(
        host.register_page(
            instances[0].clone(),
            BrowserTargetId::new("late-page").unwrap(),
            BrowserDocumentId::new("late-document").unwrap()
        ),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    let mut next = request;
    next.command_sequence = host.projection().next_command_sequence;
    assert!(matches!(
        host.begin_action(&next.lease.controller_id, &next, None),
        Err(BrowserAdmissionError::ResourceRetiring)
    ));
    let peer_target = host.target_for(&pages[1]).unwrap();
    assert!(host.execution_time(peer_target, Instant::now()).is_ok());
    assert!(matches!(
        host.execution_time(&target, Instant::now()),
        Err(BrowserAdmissionError::ResourceRetiring)
    ));
}

#[test]
fn empty_census_and_closed_pages_do_not_claim_instance_retirement() {
    for reserved_only in [false, true] {
        let (mut host, instances, pages) = fixture();
        let resource = host.projection().resource;
        for (instance, page) in instances.iter().zip(&pages) {
            host.page_closed(&page.page_id).unwrap();
            if reserved_only {
                host.reserve_page_target(
                    &resource,
                    instance.clone(),
                    BrowserTargetId::new(format!("reserved:{}", instance.as_str())).unwrap(),
                )
                .unwrap();
            }
            host.reconcile_instance_pages(instance, &BTreeSet::new(), Instant::now())
                .unwrap();
        }
        assert!(host.pages().is_empty());
        assert!(host.owned_page_targets().is_empty());
        host.begin_instance_retirement(&resource, &instances[0])
            .unwrap();
        assert!(
            !host
                .instance_binding_retired(&resource, &instances[0])
                .unwrap()
        );
        assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
        host.begin_instance_retirement(&resource, &instances[1])
            .unwrap();
        assert!(
            host.instance_binding_retired(&resource, &instances[1])
                .unwrap()
        );
        assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
    }
}

#[test]
fn pending_creation_cannot_recreate_a_retired_instance_binding() {
    let (mut host, instances, pages) = fixture();
    let resource = host.projection().resource;
    let request = authority(&mut host, &pages[0]);
    let action = host
        .begin_action(&request.lease.controller_id, &request, None)
        .unwrap();
    let creation = host.prepare_page_creation(&action).unwrap();
    host.begin_page_creation(&creation, &instances[0]).unwrap();
    host.begin_instance_retirement(&resource, &instances[0])
        .unwrap();
    assert!(
        !host
            .instance_binding_retired(&resource, &instances[0])
            .unwrap()
    );
    let target = BrowserTargetId::new("late-created-target").unwrap();
    assert_eq!(
        host.reserve_created_page_target(&creation, target.clone()),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    assert_eq!(host.instance_for_target(&target), None);
    assert_eq!(host.pages(), vec![pages[1].clone()]);
}

#[test]
fn retirement_preserves_peer_dialog_dispatch_and_existing_unknown_outcome() {
    for unknown_outcome in [false, true] {
        let (mut host, instances, pages) = fixture();
        let resource = host.projection().resource;
        let request = authority(&mut host, &pages[1]);
        if unknown_outcome {
            let permit = host
                .begin_action(&request.lease.controller_id, &request, None)
                .unwrap();
            host.finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
                .unwrap();
            host.begin_instance_retirement(&resource, &instances[0])
                .unwrap();
            assert!(
                !host
                    .instance_binding_retired(&resource, &instances[0])
                    .unwrap()
            );
            assert_eq!(
                host.projection().phase,
                BrowserResourcePhase::OutcomeUnknown
            );
        } else {
            let source = BrowserDialogSourceId::new("source:1").unwrap();
            host.dialog_opened(
                &pages[1],
                source.clone(),
                BrowserDialogKind::Prompt,
                ("Peer prompt", "about:blank", ""),
                Instant::now(),
            )
            .unwrap();
            let dialog = host
                .dialog_observation(&pages[1].page_id)
                .unwrap()
                .dialog
                .unwrap();
            let permit = host
                .begin_dialog_response(
                    &request.lease.controller_id,
                    &request,
                    &dialog.identity,
                    BrowserDialogResponse::Accept {
                        text: Some(
                            BrowserPromptText::try_from(String::from("peer value")).unwrap(),
                        ),
                    },
                )
                .unwrap();
            host.begin_instance_retirement(&resource, &instances[0])
                .unwrap();
            assert!(
                !host
                    .instance_binding_retired(&resource, &instances[0])
                    .unwrap()
            );
            assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
            assert_eq!(host.dispatch_dialog(&permit), Ok(&source));
            host.finish_dialog_response(permit, BrowserActionOutcome::Completed)
                .unwrap();
        }
    }
}

#[test]
fn stale_and_repeated_retirement_callbacks_do_not_mutate_or_reopen_resource() {
    let (mut host, instances, _) = fixture();
    let resource = host.projection().resource;
    let before = host.projection();
    let unknown = BrowserInstanceId::new("unknown").unwrap();
    host.begin_instance_retirement(&resource, &unknown).unwrap();
    assert!(!host.instance_binding_retired(&resource, &unknown).unwrap());
    let mut stale = resource.clone();
    stale.generation = BrowserResourceGeneration::new("stale").unwrap();
    assert!(
        host.begin_instance_retirement(&stale, &instances[0])
            .is_err()
    );
    assert!(
        host.instance_binding_retired(&stale, &instances[0])
            .is_err()
    );
    assert_eq!(host.projection(), before);
    host.begin_retirement(&resource).unwrap();
    for (index, instance) in instances.iter().enumerate() {
        host.begin_instance_retirement(&resource, instance).unwrap();
        let fenced = host.projection();
        host.begin_instance_retirement(&resource, instance).unwrap();
        assert_eq!(host.projection(), fenced);
        assert_eq!(
            host.instance_binding_retired(&resource, instance).unwrap(),
            index == 1
        );
        let completed = host.projection();
        assert_eq!(
            completed.phase,
            if index == 1 {
                BrowserResourcePhase::Closed
            } else {
                BrowserResourcePhase::Retiring
            }
        );
        assert_eq!(
            host.instance_binding_retired(&resource, instance).unwrap(),
            index == 1
        );
        assert_eq!(host.projection(), completed);
    }
}

#[test]
fn closing_pages_cannot_bypass_owned_instance_capacity() {
    let (mut host, existing, pages) = fixture();
    let resource = host.projection().resource;
    for page in pages {
        host.page_closed(&page.page_id).unwrap();
    }
    for index in 2..MAX_LIVE_PAGES {
        let page = host
            .register_page(
                BrowserInstanceId::new(format!("instance:{index}")).unwrap(),
                BrowserTargetId::new(format!("target:{index}")).unwrap(),
                BrowserDocumentId::new(format!("document:{index}")).unwrap(),
            )
            .unwrap();
        host.page_closed(&page.page_id).unwrap();
    }
    let extra = BrowserInstanceId::new("extra").unwrap();
    let target = BrowserTargetId::new("extra-target").unwrap();
    assert_eq!(
        host.reserve_page_target(&resource, extra.clone(), target.clone()),
        Err(BrowserAdmissionError::CapacityExceeded)
    );
    host.reserve_page_target(&resource, existing[1].clone(), target.clone())
        .unwrap();
    host.reconcile_instance_pages(&existing[1], &BTreeSet::new(), Instant::now())
        .unwrap();
    host.begin_instance_retirement(&resource, &existing[0])
        .unwrap();
    assert!(
        !host
            .instance_binding_retired(&resource, &existing[0])
            .unwrap()
    );
    host.reserve_page_target(&resource, extra.clone(), target.clone())
        .unwrap();
    assert_eq!(host.instance_for_target(&target), Some(&extra));
}
