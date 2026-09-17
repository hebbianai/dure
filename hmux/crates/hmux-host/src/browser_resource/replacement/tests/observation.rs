use super::*;

#[test]
fn admitted_page_observation_survives_unknown_outcome_without_reopening_action_authority() {
    let (mut host, lease, pages) = setup();
    let action = permit(&mut host, &lease, &pages[0]);
    host.finish_action(action, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    let instance = host.instance_for_page(&pages[0].page_id).unwrap().clone();
    let target = BrowserTargetId::new("target:0").unwrap();
    let observed = host.observe_page_document(
        instance.clone(),
        target.clone(),
        BrowserDocumentId::new("late").unwrap(),
    );
    assert!(observed.is_ok(), "{observed:?}");
    let next = observed.unwrap().unwrap();
    assert_eq!(next.page_id, pages[0].page_id);
    assert_eq!(
        next.document_revision.get(),
        pages[0].document_revision.get() + 1
    );
    assert_eq!(host.pages(), vec![next.clone(), pages[1].clone()]);
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    let authority = BrowserActionAuthority {
        lease: lease.clone(),
        page: next,
        command_sequence: host.projection().next_command_sequence,
        operation_id: BrowserOperationId::new("forbidden").unwrap(),
    };
    assert_eq!(
        host.begin_action(&lease.controller_id, &authority, None)
            .err(),
        Some(BrowserAdmissionError::OutcomeUnknown)
    );
    assert_eq!(
        host.register_page(
            instance.clone(),
            BrowserTargetId::new("unadmitted").unwrap(),
            BrowserDocumentId::new("new").unwrap()
        ),
        Err(BrowserAdmissionError::OutcomeUnknown)
    );
    host.begin_retirement(&lease.resource).unwrap();
    let before = host.pages();
    assert_eq!(
        host.observe_page_document(
            instance.clone(),
            target.clone(),
            BrowserDocumentId::new("after-close").unwrap()
        ),
        Ok(None)
    );
    assert_eq!(host.pages(), before);
    assert!(host.owns_page_target(&target));
    assert_eq!(
        host.observe_page_document(
            BrowserInstanceId::new("wrong").unwrap(),
            target,
            BrowserDocumentId::new("wrong").unwrap()
        ),
        Err(BrowserAdmissionError::InstanceMismatch)
    );
}

#[test]
fn pending_creation_observation_retains_cleanup_without_publishing_after_cancellation() {
    for replacement in [false, true] {
        let (mut host, lease, pages) = setup();
        let action = permit(&mut host, &lease, &pages[0]);
        let instance = host.instance_for_page(&pages[1].page_id).unwrap().clone();
        let creation = if replacement {
            host.prepare_page_replacement(&action, &instance)
        } else {
            host.prepare_page_creation_in(&action, &instance)
        }
        .unwrap();
        host.begin_page_creation(&creation, &instance).unwrap();
        let target = BrowserTargetId::new("pending").unwrap();
        host.reserve_created_page_target(&creation, target.clone())
            .unwrap();
        host.finish_action(action, BrowserActionOutcome::OutcomeUnknown)
            .unwrap();
        let before_revision = host.projection().revision;
        let observed = host.observe_page_document(
            instance.clone(),
            target.clone(),
            BrowserDocumentId::new("late").unwrap(),
        );
        assert_eq!(observed, Ok(None));
        assert_eq!(host.pages(), pages);
        assert_eq!(host.projection().revision, before_revision);
        assert_eq!(host.instance_for_target(&target), Some(&instance));
        host.begin_retirement(&lease.resource).unwrap();
        assert_eq!(
            host.observe_page_document(
                instance,
                target.clone(),
                BrowserDocumentId::new("after-close").unwrap()
            ),
            Ok(None)
        );
        assert_eq!(host.pages(), pages);
        assert!(host.page_target_is_retiring(&target));
    }
}
