use super::*;

mod creation;
mod frames;
mod labels;
mod navigation;
mod recording;
mod selection;
mod storage;
mod tracing;

fn resource() -> BrowserResourceIdentity {
    BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:1").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    }
}

fn controller(name: &str) -> BrowserControllerId {
    BrowserControllerId::new(name).unwrap()
}

fn setup() -> (
    BrowserResourceHost,
    BrowserControllerLease,
    BrowserPageIdentity,
) {
    let mut host = BrowserResourceHost::new(resource());
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("target:1").unwrap(),
            BrowserDocumentId::new("document:1").unwrap(),
        )
        .unwrap();
    let lease = host
        .request_control(controller("cli"), None)
        .unwrap()
        .controller
        .unwrap();
    (host, lease, page)
}

fn action(
    host: &BrowserResourceHost,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> BrowserActionAuthority {
    let sequence = host.projection().next_command_sequence;
    BrowserActionAuthority {
        lease: lease.clone(),
        page: page.clone(),
        operation_id: BrowserOperationId::new(format!("operation:{sequence}")).unwrap(),
        command_sequence: sequence,
    }
}

fn reference(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
) -> BrowserElementReference {
    BrowserElementReference {
        snapshot: host
            .snapshot_observed(page, [BrowserElementId::new("e1").unwrap()].into())
            .unwrap(),
        element: BrowserElementId::new("e1").unwrap(),
    }
}

fn denied<T>(result: Result<T, BrowserAdmissionError>, expected: BrowserAdmissionError) {
    assert!(matches!(result, Err(error) if error == expected));
}

#[test]
fn unobserved_elements_do_not_consume_input_authority() {
    let (mut host, lease, page) = setup();
    let observed = reference(&mut host, &page);
    let mut forged = observed.clone();
    forged.element = BrowserElementId::new("e2").unwrap();
    let before = host.projection();
    let request = action(&host, &lease, &page);
    denied(
        host.begin_action(&lease.controller_id, &request, Some(&forged)),
        BrowserAdmissionError::ElementNotObserved,
    );
    assert_eq!(host.projection(), before);
    denied(
        host.begin_action(&lease.controller_id, &request, [&observed, &forged]),
        BrowserAdmissionError::ElementNotObserved,
    );
    assert_eq!(host.projection(), before);
    let permit = host
        .begin_action(&lease.controller_id, &request, Some(&observed))
        .unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();

    let replacement = host
        .snapshot_observed(&page, [forged.element.clone()].into())
        .unwrap();
    let old_element_in_new_snapshot = BrowserElementReference {
        snapshot: replacement.clone(),
        element: observed.element,
    };
    assert_eq!(
        host.validate_element(&old_element_in_new_snapshot),
        Err(BrowserAdmissionError::ElementNotObserved)
    );
    forged.snapshot = replacement;
    assert!(host.validate_element(&forged).is_ok());
}

#[test]
fn oversized_snapshot_preserves_the_previous_observation() {
    let (mut host, _, page) = setup();
    let observed = reference(&mut host, &page);
    let before = host.projection();
    let elements = (1..=MAX_SNAPSHOT_ELEMENTS + 1)
        .map(|number| BrowserElementId::new(format!("e{number}")).unwrap())
        .collect();
    assert_eq!(
        host.snapshot_observed(&page, elements),
        Err(BrowserAdmissionError::CapacityExceeded)
    );
    assert_eq!(host.projection(), before);
    assert!(host.validate_element(&observed).is_ok());
}

#[test]
fn observers_do_not_acquire_control_or_change_lifetime() {
    let (host, lease, _) = setup();
    let first = host.projection();
    assert_eq!(host.projection(), first);
    assert_eq!(host.projection().controller, Some(lease));
    assert_eq!(host.projection().phase, BrowserResourcePhase::Ready);
}

#[test]
fn handoff_fences_new_input_then_drains_the_one_admitted_action() {
    let (mut host, cli, page) = setup();
    let old_ref = reference(&mut host, &page);
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, Some(&old_ref))
        .unwrap();
    assert_eq!(host.dispatch_target(&permit).unwrap().as_str(), "target:1");
    let pending = host
        .request_control(controller("pane"), Some(&cli))
        .unwrap();
    assert_eq!(pending.controller, Some(cli.clone()));
    assert_eq!(pending.requested_controller, Some(controller("pane")));
    assert_eq!(host.dispatch_target(&permit).unwrap().as_str(), "target:1");
    let next = action(&host, &cli, &page);
    denied(
        host.begin_action(&cli.controller_id, &next, None),
        BrowserAdmissionError::ControlTransferPending,
    );
    let done = host
        .finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let pane = done.controller.unwrap();
    assert!(pane.epoch > cli.epoch);
    assert_eq!(pane.controller_id, controller("pane"));
    assert!(done.in_flight.is_none());
    assert!(done.requested_controller.is_none());
    denied(
        host.begin_action(&cli.controller_id, &next, None),
        BrowserAdmissionError::ControllerChanged,
    );
    let next = action(&host, &pane, &page);
    denied(
        host.begin_action(&pane.controller_id, &next, Some(&old_ref)),
        BrowserAdmissionError::SnapshotChanged,
    );
    let fresh = reference(&mut host, &page);
    let permit = host
        .begin_action(&pane.controller_id, &next, Some(&fresh))
        .unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
}

#[test]
fn lost_completion_response_does_not_dispatch_a_click_twice() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    let mut effects = 0;
    let permit = host
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    effects += 1;
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    match host.begin_action(&cli.controller_id, &request, None) {
        Ok(_) => effects += 1,
        Err(error) => assert_eq!(error, BrowserAdmissionError::CommandAlreadyDispatched),
    }
    assert_eq!(effects, 1);
    let mut gap = action(&host, &cli, &page);
    gap.command_sequence = gap.command_sequence.checked_add(1).unwrap();
    denied(
        host.begin_action(&cli.controller_id, &gap, None),
        BrowserAdmissionError::CommandSequenceGap,
    );
}

#[test]
fn authenticated_caller_and_every_resource_identity_field_are_required() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    denied(
        host.begin_action(&controller("unrelated"), &request, None),
        BrowserAdmissionError::CallerMismatch,
    );
    for field in 0..3 {
        let mut foreign = request.clone();
        match field {
            0 => foreign.lease.resource.workspace_id = BrowserWorkspaceId::new("other").unwrap(),
            1 => foreign.lease.resource.resource_id = BrowserResourceId::new("other").unwrap(),
            _ => {
                foreign.lease.resource.generation = BrowserResourceGeneration::new("other").unwrap()
            }
        }
        denied(
            host.begin_action(&cli.controller_id, &foreign, None),
            BrowserAdmissionError::ResourceMismatch,
        );
    }
    let mut foreign = request.clone();
    foreign.page.resource.generation = BrowserResourceGeneration::new("other").unwrap();
    denied(
        host.begin_action(&cli.controller_id, &foreign, None),
        BrowserAdmissionError::ResourceMismatch,
    );
    assert_eq!(host.projection().next_command_sequence, NonZeroU64::MIN);
}

#[test]
fn unknown_effect_blocks_input_and_handoff_until_exact_engine_retirement() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    host.request_control(controller("pane"), Some(&cli))
        .unwrap();
    let unknown = host
        .finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    assert_eq!(unknown.phase, BrowserResourcePhase::OutcomeUnknown);
    assert_eq!(unknown.controller, Some(cli.clone()));
    let next = action(&host, &cli, &page);
    denied(
        host.begin_action(&cli.controller_id, &next, None),
        BrowserAdmissionError::OutcomeUnknown,
    );
    assert_eq!(
        host.request_control(controller("pane"), Some(&cli)),
        Err(BrowserAdmissionError::OutcomeUnknown)
    );
    assert_eq!(host.projection(), unknown);
    let mut wrong_generation = resource();
    wrong_generation.generation = BrowserResourceGeneration::new("new").unwrap();
    assert_eq!(
        host.engine_exited(&wrong_generation),
        Err(BrowserAdmissionError::ResourceMismatch)
    );
    host.begin_retirement(&resource()).unwrap();
    host.engine_exited(&resource()).unwrap();
    assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
    denied(
        host.begin_action(&cli.controller_id, &next, None),
        BrowserAdmissionError::ResourceClosed,
    );
}

#[test]
fn navigation_and_new_snapshots_revoke_element_bindings() {
    let (mut host, _, page) = setup();
    let original = reference(&mut host, &page);
    assert!(host.validate_element(&original).is_ok());
    assert_eq!(
        host.document_committed(&page.page_id, BrowserDocumentId::new("document:1").unwrap())
            .unwrap(),
        page
    );
    assert!(host.validate_element(&original).is_ok());
    let fresh = reference(&mut host, &page);
    assert_eq!(
        host.validate_element(&original),
        Err(BrowserAdmissionError::SnapshotChanged)
    );
    assert!(host.validate_element(&fresh).is_ok());
    let navigated = host
        .document_committed(&page.page_id, BrowserDocumentId::new("document:2").unwrap())
        .unwrap();
    assert!(navigated.document_revision > page.document_revision);
    assert_eq!(
        host.validate_element(&fresh),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert_eq!(
        host.target_for(&page),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert_eq!(host.target_for(&navigated).unwrap().as_str(), "target:1");
}

#[test]
fn closing_and_recreating_a_page_never_reuses_its_old_binding() {
    let (mut host, cli, page) = setup();
    let old_ref = reference(&mut host, &page);
    host.page_closed(&page.page_id).unwrap();
    let new_page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("target:1").unwrap(),
            BrowserDocumentId::new("document:1").unwrap(),
        )
        .unwrap();
    assert_ne!(page.page_id, new_page.page_id);
    assert_eq!(
        host.validate_element(&old_ref),
        Err(BrowserAdmissionError::PageGone)
    );
    let next = action(&host, &cli, &new_page);
    denied(
        host.begin_action(&cli.controller_id, &next, Some(&old_ref)),
        BrowserAdmissionError::DocumentChanged,
    );
}

#[test]
fn rejected_before_dispatch_drains_handoff_without_an_effect() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    host.request_control(controller("pane"), Some(&cli))
        .unwrap();
    let done = host
        .finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert_eq!(done.controller.unwrap().controller_id, controller("pane"));
    assert_eq!(done.phase, BrowserResourcePhase::Ready);
    assert!(done.in_flight.is_none());
}

#[test]
fn late_unknown_completion_cannot_reverse_retirement() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    host.begin_retirement(&resource()).unwrap();
    let done = host
        .finish_action(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    assert_eq!(done.phase, BrowserResourcePhase::Retiring);
    host.engine_exited(&resource()).unwrap();
    assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
}

#[test]
fn old_engine_completion_cannot_mutate_a_successor_generation() {
    let (mut predecessor, cli, page) = setup();
    let request = action(&predecessor, &cli, &page);
    let permit = predecessor
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    let mut identity = resource();
    identity.generation = BrowserResourceGeneration::new("generation:2").unwrap();
    let mut successor = BrowserResourceHost::new(identity);
    let before = successor.projection();
    assert_eq!(
        successor.finish_action(permit, BrowserActionOutcome::Completed),
        Err(BrowserAdmissionError::ResourceMismatch)
    );
    assert_eq!(successor.projection(), before);
}

#[test]
fn a_document_commit_while_awaiting_the_engine_prevents_dispatch() {
    let (mut host, cli, page) = setup();
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, None)
        .unwrap();
    host.document_committed(&page.page_id, BrowserDocumentId::new("document:2").unwrap())
        .unwrap();
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert!(host.projection().in_flight.is_none());
}

#[test]
fn a_new_snapshot_or_retirement_revokes_a_not_yet_dispatched_permit() {
    let (mut host, cli, page) = setup();
    let old = reference(&mut host, &page);
    let request = action(&host, &cli, &page);
    let permit = host
        .begin_action(&cli.controller_id, &request, Some(&old))
        .unwrap();
    reference(&mut host, &page);
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::SnapshotChanged)
    );
    host.begin_retirement(&resource()).unwrap();
    assert_eq!(
        host.dispatch_target(&permit),
        Err(BrowserAdmissionError::ResourceRetiring)
    );
    let done = host
        .finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert_eq!(done.phase, BrowserResourcePhase::Retiring);
}
