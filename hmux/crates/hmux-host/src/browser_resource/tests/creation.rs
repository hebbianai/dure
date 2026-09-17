use super::*;
use crate::browser_resource::creation::BrowserPageCreationState;

#[test]
fn creation_accounts_the_native_target_before_action_completion() {
    let (mut host, lease, page) = setup();
    let request = action(&host, &lease, &page);
    let permit = host
        .begin_action(&lease.controller_id, &request, None)
        .unwrap();
    let creation = host.prepare_page_creation(&permit).unwrap();
    assert!(matches!(
        host.prepare_page_creation(&permit),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    ));
    let instance = BrowserInstanceId::new("instance").unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    assert_eq!(
        host.page_creation_state(&permit).unwrap(),
        Some(BrowserPageCreationState::Pending)
    );
    let target = BrowserTargetId::new("created").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    assert_eq!(
        host.page_creation_state(&permit).unwrap(),
        Some(BrowserPageCreationState::Accounted)
    );
    assert_eq!(host.instance_for_target(&target), Some(&instance));
    assert_eq!(
        host.begin_page_creation(&creation, &instance),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    );
    assert_eq!(
        host.reserve_created_page_target(&creation, BrowserTargetId::new("duplicate").unwrap()),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    );
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let created = host
        .register_page(
            instance,
            target.clone(),
            BrowserDocumentId::new("created-doc").unwrap(),
        )
        .unwrap();
    assert_eq!(host.target_for(&created), Ok(&target));
}

#[test]
fn queued_creation_cannot_outlive_its_action_even_when_operation_id_is_reused() {
    for rejected in [false, true] {
        let (mut host, lease, page) = setup();
        let request = action(&host, &lease, &page);
        let permit = host
            .begin_action(&lease.controller_id, &request, None)
            .unwrap();
        let creation = host.prepare_page_creation(&permit).unwrap();
        let instance = BrowserInstanceId::new("instance").unwrap();
        if rejected {
            host.begin_page_creation(&creation, &instance).unwrap();
            host.page_creation_rejected(&creation).unwrap();
            assert_eq!(
                host.begin_page_creation(&creation, &instance),
                Err(BrowserAdmissionError::CommandAlreadyDispatched)
            );
        }
        host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
        assert_eq!(
            host.begin_page_creation(&creation, &instance),
            Err(BrowserAdmissionError::PermitMismatch)
        );
        let mut next = action(&host, &lease, &page);
        next.operation_id = request.operation_id;
        let next_permit = host
            .begin_action(&lease.controller_id, &next, None)
            .unwrap();
        let next_creation = host.prepare_page_creation(&next_permit).unwrap();
        assert_eq!(
            host.begin_page_creation(&creation, &instance),
            Err(BrowserAdmissionError::PermitMismatch)
        );
        host.begin_page_creation(&next_creation, &instance).unwrap();
        host.created_page_retired(&next_creation).unwrap();
        assert_eq!(
            host.page_creation_state(&next_permit).unwrap(),
            Some(BrowserPageCreationState::Accounted)
        );
        host.finish_action(next_permit, BrowserActionOutcome::Completed)
            .unwrap();
        assert_eq!(host.owned_page_targets().len(), 1);
    }
}

#[test]
fn creation_rechecks_origin_and_capacity_before_native_dispatch() {
    for boundary in ["instance", "document", "capacity", "retirement"] {
        let (mut host, lease, page) = setup();
        let request = action(&host, &lease, &page);
        let permit = host
            .begin_action(&lease.controller_id, &request, None)
            .unwrap();
        let creation = host.prepare_page_creation(&permit).unwrap();
        let mut instance = BrowserInstanceId::new("instance").unwrap();
        let expected = match boundary {
            "instance" => {
                instance = BrowserInstanceId::new("other").unwrap();
                BrowserAdmissionError::InstanceMismatch
            }
            "document" => {
                host.document_committed(
                    &page.page_id,
                    BrowserDocumentId::new("new-document").unwrap(),
                )
                .unwrap();
                BrowserAdmissionError::DocumentChanged
            }
            "capacity" => {
                for i in 1..MAX_LIVE_PAGES {
                    host.reserve_page_target(
                        &resource(),
                        instance.clone(),
                        BrowserTargetId::new(format!("reserved:{i}")).unwrap(),
                    )
                    .unwrap();
                }
                BrowserAdmissionError::CapacityExceeded
            }
            "retirement" => {
                host.begin_retirement(&resource()).unwrap();
                BrowserAdmissionError::ResourceRetiring
            }
            _ => unreachable!(),
        };
        assert_eq!(
            host.begin_page_creation(&creation, &instance),
            Err(expected)
        );
        assert_eq!(
            host.page_creation_state(&permit).unwrap(),
            Some(BrowserPageCreationState::Prepared)
        );
        host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
    }
}
