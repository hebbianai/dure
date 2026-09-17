use super::*;

fn setup() -> (BrowserResourceHost, BrowserActionPermit, BrowserInstanceId) {
    let resource = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("creation:destination").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let mut host = BrowserResourceHost::new(resource.clone());
    let page = host
        .register_page(
            BrowserInstanceId::new("origin").unwrap(),
            BrowserTargetId::new("page").unwrap(),
            BrowserDocumentId::new("doc").unwrap(),
        )
        .unwrap();
    let destination = BrowserInstanceId::new("destination").unwrap();
    host.register_instance_binding(&resource, destination.clone())
        .unwrap();
    let lease = host
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    let authority = BrowserActionAuthority {
        lease: lease.clone(),
        page,
        command_sequence: host.projection().next_command_sequence,
        operation_id: BrowserOperationId::new("creation").unwrap(),
    };
    let permit = host
        .begin_action(&lease.controller_id, &authority, None)
        .unwrap();
    (host, permit, destination)
}

#[test]
fn destination_creation_retains_its_actual_owner_through_pending_and_accounted_states() {
    let (mut host, permit, destination) = setup();
    let creation = host
        .prepare_page_creation_in(&permit, &destination)
        .unwrap();
    assert_eq!(
        host.created_page_target(&permit),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(
        host.page_creation_instance(&permit).unwrap(),
        Some(&destination)
    );
    assert_eq!(
        host.begin_page_creation(&creation, &BrowserInstanceId::new("origin").unwrap()),
        Err(BrowserAdmissionError::InstanceMismatch)
    );
    assert_eq!(
        host.page_creation_state(&permit).unwrap(),
        Some(BrowserPageCreationState::Prepared)
    );
    host.begin_page_creation(&creation, &destination).unwrap();
    assert_eq!(
        host.created_page_target(&permit),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(
        host.page_creation_instance(&permit).unwrap(),
        Some(&destination)
    );
    assert_eq!(
        host.page_creation_state(&permit).unwrap(),
        Some(BrowserPageCreationState::Pending)
    );
    let target = BrowserTargetId::new("created").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    assert_eq!(host.created_page_target(&permit), Ok(&target));
    assert_eq!(host.instance_for_target(&target), Some(&destination));
    assert_eq!(
        host.page_creation_state(&permit).unwrap(),
        Some(BrowserPageCreationState::Accounted)
    );
    assert_eq!(
        host.page_creation_instance(&permit).unwrap(),
        Some(&destination)
    );
}

#[test]
fn destination_creation_rechecks_both_lifetimes_and_the_origin_document() {
    for boundary in ["destination", "origin", "document", "action"] {
        let (mut host, permit, destination) = setup();
        let creation = host
            .prepare_page_creation_in(&permit, &destination)
            .unwrap();
        let expected = match boundary {
            "destination" => {
                host.begin_instance_retirement(&permit.resource, &destination)
                    .unwrap();
                BrowserAdmissionError::ResourceRetiring
            }
            "origin" => {
                host.begin_instance_retirement(
                    &permit.resource,
                    &BrowserInstanceId::new("origin").unwrap(),
                )
                .unwrap();
                BrowserAdmissionError::ResourceRetiring
            }
            "document" => {
                host.document_committed(
                    &permit.page.page_id,
                    BrowserDocumentId::new("new").unwrap(),
                )
                .unwrap();
                BrowserAdmissionError::DocumentChanged
            }
            "action" => {
                host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
                    .unwrap();
                BrowserAdmissionError::PermitMismatch
            }
            _ => unreachable!(),
        };
        let before = host.projection();
        assert_eq!(
            host.begin_page_creation(&creation, &destination),
            Err(expected)
        );
        assert_eq!(host.projection(), before);
        assert_eq!(host.owned_page_targets().len(), 1);
    }
}
