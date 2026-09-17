use super::*;
use crate::browser_network::BrowserNetworkId;
use hmux_session_protocol::browser_dialog::{
    BrowserDialogKind, BrowserDialogResponse, BrowserPromptText,
};

mod outcomes;
mod retirement;

fn fixture() -> (
    BrowserResourceHost,
    [BrowserInstanceId; 2],
    [BrowserPageIdentity; 2],
) {
    let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("resource").unwrap(),
        generation: BrowserResourceGeneration::new("generation").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
    });
    let instances = [
        BrowserInstanceId::new("instance:a").unwrap(),
        BrowserInstanceId::new("instance:b").unwrap(),
    ];
    let pages = std::array::from_fn(|index| {
        let target = BrowserTargetId::new(format!("target:{index}")).unwrap();
        let page = host
            .register_page(
                instances[index].clone(),
                target.clone(),
                BrowserDocumentId::new(format!("document:{index}")).unwrap(),
            )
            .unwrap();
        host.network()
            .attach(
                BrowserNetworkId::new(&format!("source:{index}")).unwrap(),
                target.clone(),
                target,
                true,
                Instant::now(),
            )
            .unwrap();
        page
    });
    (host, instances, pages)
}

#[test]
fn instance_census_retires_only_its_pages_and_reservations() {
    let (mut host, instances, pages) = fixture();
    let resource = host.projection().resource;
    let reserved = BrowserTargetId::new("reserved:b").unwrap();
    host.reserve_page_target(&resource, instances[1].clone(), reserved.clone())
        .unwrap();
    assert_eq!(
        host.register_page(
            instances[0].clone(),
            reserved.clone(),
            BrowserDocumentId::new("wrong-owner").unwrap()
        ),
        Err(BrowserAdmissionError::InstanceMismatch)
    );
    let snapshot = host
        .snapshot_observed(
            &pages[1],
            BTreeSet::from([BrowserElementId::new("element").unwrap()]),
        )
        .unwrap();
    host.reconcile_instance_pages(&instances[0], &BTreeSet::new(), Instant::now())
        .unwrap();
    assert_eq!(host.pages(), vec![pages[1].clone()]);
    assert_eq!(host.instance_for_target(&reserved), Some(&instances[1]));
    assert_eq!(host.instance_targets(&instances[1]).len(), 2);
    let reference = BrowserElementReference {
        snapshot,
        element: BrowserElementId::new("element").unwrap(),
    };
    assert!(host.validate_element(&reference).is_ok());
    host.register_page(
        instances[1].clone(),
        reserved,
        BrowserDocumentId::new("owned").unwrap(),
    )
    .unwrap();
    assert_eq!(host.pages().len(), 2);
    assert!(host.instance_targets(&instances[0]).is_empty());
}

#[test]
fn instance_loss_preserves_peer_network_and_an_admitted_dialog_response() {
    let (mut host, instances, pages) = fixture();
    let lease = host
        .request_control(BrowserControllerId::new("controller").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    host.dialog_opened(
        &pages[1],
        BrowserDialogSourceId::new("source:1").unwrap(),
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
    let authority = BrowserActionAuthority {
        lease: lease.clone(),
        page: pages[1].clone(),
        command_sequence: host.projection().next_command_sequence,
        operation_id: BrowserOperationId::new("peer-response").unwrap(),
    };
    let permit = host
        .begin_dialog_response(
            &lease.controller_id,
            &authority,
            &dialog.identity,
            BrowserDialogResponse::Accept {
                text: Some(BrowserPromptText::try_from(String::from("peer value")).unwrap()),
            },
        )
        .unwrap();
    host.instance_observation_lost(&instances[0]);
    assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
    assert!(
        !host
            .network_snapshot(&pages[0], Instant::now())
            .unwrap()
            .complete
    );
    assert!(
        host.network_snapshot(&pages[1], Instant::now())
            .unwrap()
            .complete
    );
    assert!(matches!(
        host.dialog_observation(&pages[0].page_id),
        Err(BrowserAdmissionError::DialogObservationLost)
    ));
    assert!(
        host.dialog_observation(&pages[1].page_id)
            .unwrap()
            .dialog
            .is_some()
    );
    assert_eq!(
        host.dispatch_dialog(&permit),
        Ok(&BrowserDialogSourceId::new("source:1").unwrap())
    );
    host.finish_dialog_response(permit, BrowserActionOutcome::Completed)
        .unwrap();
    host.dialog_closed(
        &BrowserDialogSourceId::new("source:1").unwrap(),
        Instant::now(),
    )
    .unwrap();
    assert!(
        host.execution_time(&host.target_for(&pages[1]).unwrap().clone(), Instant::now())
            .is_ok()
    );
}

#[test]
fn losing_the_instance_with_a_pending_dialog_preserves_the_outcome_fence() {
    let (mut host, instances, pages) = fixture();
    host.dialog_opened(
        &pages[0],
        BrowserDialogSourceId::new("source:0").unwrap(),
        BrowserDialogKind::Alert,
        ("Unresolved", "about:blank", ""),
        Instant::now(),
    )
    .unwrap();
    host.instance_observation_lost(&instances[0]);
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    assert!(
        host.network_snapshot(&pages[1], Instant::now())
            .unwrap()
            .complete
    );
    assert!(host.dialog_observation(&pages[1].page_id).is_ok());
}
