use super::*;
use hmux_session_protocol::browser_pointer::{
    BrowserMouseButton, BrowserPointerAction, PointerAction,
};

fn request(host: &mut BrowserResourceHost, page: &BrowserPageIdentity) -> BrowserActionAuthority {
    let lease = match host.projection().controller {
        Some(lease) => lease,
        None => host
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .unwrap()
            .controller
            .unwrap(),
    };
    let sequence = host.projection().next_command_sequence;
    BrowserActionAuthority {
        lease,
        page: page.clone(),
        command_sequence: sequence,
        operation_id: BrowserOperationId::new(format!("operation:{sequence}")).unwrap(),
    }
}

fn retire(host: &mut BrowserResourceHost, instance: &BrowserInstanceId) {
    let resource = host.projection().resource;
    host.begin_instance_retirement(&resource, instance).unwrap();
    assert!(!host.instance_binding_retired(&resource, instance).unwrap());
}

fn third(host: &mut BrowserResourceHost) -> BrowserPageIdentity {
    host.register_page(
        BrowserInstanceId::new("instance:c").unwrap(),
        BrowserTargetId::new("target:c").unwrap(),
        BrowserDocumentId::new("document:c").unwrap(),
    )
    .unwrap()
}

#[test]
fn uncertain_action_requires_exact_owner_retirement_before_peer_handoff() {
    let (mut host, instances, pages) = fixture();
    let request = request(&mut host, &pages[0]);
    let permit = host
        .begin_action(&request.lease.controller_id, &request, None)
        .unwrap();
    host.request_control(
        BrowserControllerId::new("human").unwrap(),
        Some(&request.lease),
    )
    .unwrap();
    host.finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    host.page_closed(&pages[0].page_id).unwrap();
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    assert!(host.projection().in_flight.is_some());
    retire(&mut host, &instances[0]);
    let after = host.projection();
    assert_eq!(after.phase, BrowserResourcePhase::Ready);
    assert!(after.in_flight.is_none() && after.requested_controller.is_none());
    assert_eq!(after.controller.unwrap().controller_id.as_str(), "human");
    assert_eq!(host.pages(), vec![pages[1].clone()]);
}

#[test]
fn late_action_completion_cannot_fence_a_new_action_after_its_owner_retired() {
    let (mut host, instances, pages) = fixture();
    let old = request(&mut host, &pages[0]);
    let permit = host
        .begin_action(&old.lease.controller_id, &old, None)
        .unwrap();
    retire(&mut host, &instances[0]);
    let next = request(&mut host, &pages[1]);
    let next = host
        .begin_action(&next.lease.controller_id, &next, None)
        .unwrap();
    let before = host.projection();
    assert_eq!(
        host.finish_action(permit, BrowserActionOutcome::OutcomeUnknown),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(host.projection(), before);
    assert!(host.dispatch_target(&next).is_ok());
    host.finish_action(next, BrowserActionOutcome::Completed)
        .unwrap();
}

#[test]
fn cross_instance_creation_retains_uncertainty_until_both_effect_owners_retire() {
    for accounted in [false, true] {
        let (mut host, instances, pages) = fixture();
        let untouched = third(&mut host);
        let request = request(&mut host, &pages[0]);
        let permit = host
            .begin_action(&request.lease.controller_id, &request, None)
            .unwrap();
        let creation = host
            .prepare_page_creation_in(&permit, &instances[1])
            .unwrap();
        host.begin_page_creation(&creation, &instances[1]).unwrap();
        if accounted {
            host.reserve_created_page_target(&creation, BrowserTargetId::new("created:b").unwrap())
                .unwrap();
        }
        host.finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
            .unwrap();
        retire(&mut host, &instances[0]);
        assert_eq!(
            host.projection().phase,
            BrowserResourcePhase::OutcomeUnknown
        );
        assert!(host.projection().in_flight.is_some());
        retire(&mut host, &instances[1]);
        assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
        assert!(host.projection().in_flight.is_none());
        assert_eq!(host.pages(), vec![untouched]);
        assert!(host.begin_page_creation(&creation, &instances[1]).is_err());
    }
}

#[test]
fn additional_dialog_uncertainty_after_action_loss_keeps_its_own_owner_fenced() {
    let (mut host, instances, pages) = fixture();
    let untouched = third(&mut host);
    host.dialog_opened(
        &pages[1],
        BrowserDialogSourceId::new("dialog:b").unwrap(),
        BrowserDialogKind::Prompt,
        ("Unresolved peer", "about:blank", ""),
        Instant::now(),
    )
    .unwrap();
    let request = request(&mut host, &pages[0]);
    let permit = host
        .begin_action(&request.lease.controller_id, &request, None)
        .unwrap();
    host.finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    host.dialog_observation_lost(&instances[1]);
    retire(&mut host, &instances[0]);
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    assert!(host.projection().in_flight.is_none());
    host.page_closed(&pages[1].page_id).unwrap();
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    retire(&mut host, &instances[1]);
    assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
    assert_eq!(host.pages(), vec![untouched]);
}

#[test]
fn uncertain_dialog_response_is_reconciled_only_by_its_owner_retirement() {
    let (mut host, instances, pages) = fixture();
    let request = request(&mut host, &pages[0]);
    host.dialog_opened(
        &pages[0],
        BrowserDialogSourceId::new("dialog:a").unwrap(),
        BrowserDialogKind::Alert,
        ("Alert", "about:blank", ""),
        Instant::now(),
    )
    .unwrap();
    let dialog = host
        .dialog_observation(&pages[0].page_id)
        .unwrap()
        .dialog
        .unwrap();
    let permit = host
        .begin_dialog_response(
            &request.lease.controller_id,
            &request,
            &dialog.identity,
            BrowserDialogResponse::Accept { text: None },
        )
        .unwrap();
    host.finish_dialog_response(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    host.page_closed(&pages[0].page_id).unwrap();
    assert!(host.projection().dialog_response.is_some());
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    retire(&mut host, &instances[0]);
    assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
    assert!(host.projection().dialog_response.is_none());
    assert_eq!(host.pages(), vec![pages[1].clone()]);
}

#[test]
fn lost_key_and_pointer_transfer_wait_for_native_owner_before_handoff() {
    for keyboard in [false, true] {
        let (mut host, instances, pages) = fixture();
        let request = request(&mut host, &pages[0]);
        let permit = host
            .begin_action(&request.lease.controller_id, &request, None)
            .unwrap();
        if keyboard {
            let press = host
                .prepare_key(&permit, String::from("Control").try_into().unwrap(), true)
                .unwrap();
            host.keyboard_applied(press).unwrap();
        } else {
            let press = host
                .prepare_pointer(
                    &permit,
                    BrowserPointerAction::try_from(PointerAction::Down {
                        button: BrowserMouseButton::Left,
                        x: Some(1.0),
                        y: Some(1.0),
                    })
                    .unwrap(),
                )
                .unwrap();
            host.pointer_applied(press).unwrap();
        }
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
        host.request_control(
            BrowserControllerId::new("human").unwrap(),
            Some(&request.lease),
        )
        .unwrap();
        if keyboard {
            let release = host.keyboard_release_for_transfer().unwrap().unwrap();
            host.keyboard_delivery_unknown(release).unwrap();
        } else {
            let release = host.pointer_release_for_transfer().unwrap().unwrap();
            host.pointer_delivery_unknown(release).unwrap();
        }
        host.page_closed(&pages[0].page_id).unwrap();
        assert_eq!(
            host.projection().phase,
            BrowserResourcePhase::OutcomeUnknown
        );
        retire(&mut host, &instances[0]);
        let after = host.projection();
        assert_eq!(after.phase, BrowserResourcePhase::Ready);
        assert_eq!(after.controller.unwrap().controller_id.as_str(), "human");
        assert!(after.keyboard.is_none() && after.pointer.is_none());
    }
}
