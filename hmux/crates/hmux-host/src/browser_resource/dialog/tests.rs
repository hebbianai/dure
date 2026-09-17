use super::*;

fn setup() -> (
    BrowserResourceHost,
    BrowserControllerLease,
    BrowserPageIdentity,
) {
    let resource = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("r").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let mut host = BrowserResourceHost::new(resource);
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("target").unwrap(),
            BrowserDocumentId::new("document").unwrap(),
        )
        .unwrap();
    let lease = host
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    (host, lease, page)
}

fn authority(
    host: &BrowserResourceHost,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> BrowserActionAuthority {
    let sequence = host.projection().next_command_sequence;
    BrowserActionAuthority {
        lease: lease.clone(),
        page: page.clone(),
        operation_id: BrowserOperationId::new(format!("op:{sequence}")).unwrap(),
        command_sequence: sequence,
    }
}

fn source() -> BrowserDialogSourceId {
    BrowserDialogSourceId::new("source").unwrap()
}
fn opened(host: &mut BrowserResourceHost, page: &BrowserPageIdentity) -> BrowserDialogIdentity {
    host.dialog_opened(
        page,
        source(),
        BrowserDialogKind::Prompt,
        ("question", "https://example.test", "default"),
        Instant::now(),
    )
    .unwrap();
    host.dialog_observation(&page.page_id)
        .unwrap()
        .dialog
        .unwrap()
        .identity
}
fn accept() -> BrowserDialogResponse {
    BrowserDialogResponse::Accept {
        text: Some("한글".to_owned().try_into().unwrap()),
    }
}
fn respond(
    host: &mut BrowserResourceHost,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    dialog: &BrowserDialogIdentity,
) -> BrowserDialogPermit {
    host.begin_dialog_response(
        &lease.controller_id,
        &authority(host, lease, page),
        dialog,
        accept(),
    )
    .unwrap()
}

#[test]
fn suspended_input_and_response_both_drain_before_control_changes() {
    for response_finishes_first in [false, true] {
        let (mut host, lease, page) = setup();
        let input = host
            .begin_action(&lease.controller_id, &authority(&host, &lease, &page), [])
            .unwrap();
        let dialog = opened(&mut host, &page);
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        let permit = respond(&mut host, &lease, &page, &dialog);
        assert_eq!(host.dispatch_dialog(&permit).unwrap(), &source());
        assert!(matches!(
            host.begin_action(&lease.controller_id, &authority(&host, &lease, &page), []),
            Err(BrowserAdmissionError::ControlTransferPending)
        ));
        assert!(host.projection().in_flight.is_some());
        assert!(host.projection().dialog_response.is_some());
        host.dialog_closed(&source(), Instant::now()).unwrap();
        if response_finishes_first {
            host.finish_dialog_response(permit, BrowserActionOutcome::Completed)
                .unwrap();
            assert_eq!(host.projection().controller.as_ref(), Some(&lease));
            host.finish_action(input, BrowserActionOutcome::Completed)
                .unwrap();
        } else {
            host.finish_action(input, BrowserActionOutcome::Completed)
                .unwrap();
            assert_eq!(host.projection().controller.as_ref(), Some(&lease));
            host.finish_dialog_response(permit, BrowserActionOutcome::Completed)
                .unwrap();
        }
        let final_state = host.projection();
        assert_eq!(
            final_state.controller.unwrap().controller_id.as_str(),
            "human"
        );
        assert!(final_state.in_flight.is_none() && final_state.dialog_response.is_none());
    }
}

#[test]
fn response_authority_is_exact_and_rejections_do_not_consume_a_sequence() {
    let (mut host, lease, page) = setup();
    let dialog = opened(&mut host, &page);
    let command = authority(&host, &lease, &page);
    let before = host.projection();
    for variant in 0..7 {
        let mut proposed = command.clone();
        let mut observed = dialog.clone();
        let mut caller = lease.controller_id.clone();
        let expected = match variant {
            0 => {
                caller = BrowserControllerId::new("other").unwrap();
                BrowserAdmissionError::CallerMismatch
            }
            1 => {
                proposed.lease.epoch = NonZeroU64::new(2).unwrap();
                BrowserAdmissionError::ControllerChanged
            }
            2 => {
                proposed.lease.resource.generation = BrowserResourceGeneration::new("old").unwrap();
                BrowserAdmissionError::ResourceMismatch
            }
            3 => {
                observed.revision = NonZeroU64::new(99).unwrap();
                BrowserAdmissionError::DialogChanged
            }
            4 => {
                proposed.command_sequence = NonZeroU64::new(99).unwrap();
                BrowserAdmissionError::CommandSequenceGap
            }
            5 => {
                proposed.page.document_revision = NonZeroU64::new(99).unwrap();
                BrowserAdmissionError::DocumentChanged
            }
            _ => {
                proposed.page.page_id = BrowserPageId::new("other").unwrap();
                BrowserAdmissionError::PageGone
            }
        };
        assert!(
            matches!(host.begin_dialog_response(&caller,&proposed,&observed,accept()),Err(error) if error == expected)
        );
        assert_eq!(host.projection(), before);
    }
    let permit = respond(&mut host, &lease, &page, &dialog);
    assert!(matches!(
        host.begin_dialog_response(&lease.controller_id, &command, &dialog, accept()),
        Err(BrowserAdmissionError::CommandAlreadyDispatched)
    ));
    assert!(matches!(
        host.begin_action(&lease.controller_id, &authority(&host, &lease, &page), []),
        Err(BrowserAdmissionError::ActionInFlight)
    ));
    assert!(matches!(
        host.begin_dialog_response(
            &lease.controller_id,
            &authority(&host, &lease, &page),
            &dialog,
            accept()
        ),
        Err(BrowserAdmissionError::ActionInFlight)
    ));
    host.finish_dialog_response(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    assert!(
        host.dialog_observation(&page.page_id)
            .unwrap()
            .dialog
            .is_some()
    );
    let next = respond(&mut host, &lease, &page, &dialog);
    assert_eq!(host.dispatch_dialog(&next).unwrap(), &source());
}

#[test]
fn a_late_response_cannot_clear_or_answer_the_next_dialog() {
    let (mut host, lease, page) = setup();
    let first = opened(&mut host, &page);
    let permit = respond(&mut host, &lease, &page, &first);
    host.dialog_closed(&source(), Instant::now()).unwrap();
    let second = opened(&mut host, &page);
    assert_ne!(first, second);
    assert!(matches!(
        host.dispatch_dialog(&permit),
        Err(BrowserAdmissionError::DialogChanged)
    ));
    host.finish_dialog_response(permit, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(
        host.dialog_observation(&page.page_id)
            .unwrap()
            .dialog
            .unwrap()
            .identity,
        second
    );
    assert!(matches!(
        host.begin_dialog_response(
            &lease.controller_id,
            &authority(&host, &lease, &page),
            &first,
            accept()
        ),
        Err(BrowserAdmissionError::DialogChanged)
    ));
}

#[test]
fn page_document_and_retirement_changes_invalidate_undispatched_responses() {
    for change in 0..3 {
        let (mut host, lease, page) = setup();
        let dialog = opened(&mut host, &page);
        let permit = respond(&mut host, &lease, &page, &dialog);
        let expected = match change {
            0 => {
                host.document_committed(
                    &page.page_id,
                    BrowserDocumentId::new("replacement").unwrap(),
                )
                .unwrap();
                BrowserAdmissionError::DocumentChanged
            }
            1 => {
                host.page_closed(&page.page_id).unwrap();
                BrowserAdmissionError::PageGone
            }
            _ => {
                host.begin_retirement(&lease.resource).unwrap();
                BrowserAdmissionError::ResourceRetiring
            }
        };
        assert!(matches!(host.dispatch_dialog(&permit),Err(error) if error == expected));
        host.finish_dialog_response(permit, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
        host.engine_exited(&lease.resource).unwrap();
        assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
        assert!(host.projection().dialog_response.is_none());
    }
}

#[test]
fn lost_response_fences_even_when_the_triggering_input_completes_later() {
    let (mut host, lease, page) = setup();
    let input = host
        .begin_action(&lease.controller_id, &authority(&host, &lease, &page), [])
        .unwrap();
    let dialog = opened(&mut host, &page);
    let permit = respond(&mut host, &lease, &page, &dialog);
    host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
        .unwrap();
    host.dialog_closed(&source(), Instant::now()).unwrap();
    host.finish_dialog_response(permit, BrowserActionOutcome::OutcomeUnknown)
        .unwrap();
    host.finish_action(input, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(
        host.projection().phase,
        BrowserResourcePhase::OutcomeUnknown
    );
    assert_eq!(host.projection().controller.as_ref(), Some(&lease));
    assert!(matches!(
        host.begin_action(&lease.controller_id, &authority(&host, &lease, &page), []),
        Err(BrowserAdmissionError::OutcomeUnknown)
    ));
}

#[test]
fn dialog_text_is_bounded_without_losing_utf8_and_only_prompts_accept_text() {
    let (mut host, lease, page) = setup();
    let text = "한".repeat(MAX_DIALOG_TEXT_BYTES);
    host.dialog_opened(
        &page,
        source(),
        BrowserDialogKind::Alert,
        (&text, &text, &text),
        Instant::now(),
    )
    .unwrap();
    let dialog = host
        .dialog_observation(&page.page_id)
        .unwrap()
        .dialog
        .unwrap();
    assert!(dialog.truncated);
    assert_eq!(dialog.message.len(), MAX_DIALOG_TEXT_BYTES - 1);
    assert!(dialog.message.chars().all(|character| character == '한'));
    let before = host.projection();
    assert!(matches!(
        host.begin_dialog_response(
            &lease.controller_id,
            &authority(&host, &lease, &page),
            &dialog.identity,
            accept()
        ),
        Err(BrowserAdmissionError::DialogResponseInvalid)
    ));
    assert_eq!(host.projection(), before);
    assert!(
        host.begin_dialog_response(
            &lease.controller_id,
            &authority(&host, &lease, &page),
            &dialog.identity,
            BrowserDialogResponse::Dismiss {}
        )
        .is_ok()
    );
}

#[test]
fn observation_loss_never_reports_a_known_absent_dialog_or_retargets_a_source() {
    let (mut host, lease, page) = setup();
    let dialog = opened(&mut host, &page);
    host.dialog_source_detached(&BrowserDialogSourceId::new("unrelated").unwrap());
    assert!(host.dialog_observation(&page.page_id).is_ok());
    host.dialog_source_detached(&source());
    assert!(matches!(
        host.dialog_observation(&page.page_id),
        Err(BrowserAdmissionError::DialogObservationLost)
    ));
    assert!(matches!(
        host.begin_dialog_response(
            &lease.controller_id,
            &authority(&host, &lease, &page),
            &dialog,
            accept()
        ),
        Err(BrowserAdmissionError::OutcomeUnknown)
    ));
    host.engine_exited(&lease.resource).unwrap();
}

#[test]
fn execution_clock_excludes_only_observed_dialog_intervals_on_its_page() {
    let (mut host, _, page) = setup();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("other-target").unwrap(),
            BrowserDocumentId::new("other-document").unwrap(),
        )
        .unwrap();
    let target = host.target_for(&page).unwrap().clone();
    let other_target = host.target_for(&other).unwrap().clone();
    let start = Instant::now();
    let initial = host.execution_time(&target, start).unwrap().elapsed;
    let other_initial = host.execution_time(&other_target, start).unwrap().elapsed;
    host.dialog_opened(
        &page,
        source(),
        BrowserDialogKind::Prompt,
        ("wait", "url", ""),
        start + Duration::from_secs(1),
    )
    .unwrap();
    let suspended = host
        .execution_time(&target, start + Duration::from_secs(60))
        .unwrap();
    assert!(suspended.suspended);
    assert_eq!(suspended.elapsed - initial, Duration::from_secs(1));
    assert_eq!(
        host.execution_time(&other_target, start + Duration::from_secs(60))
            .unwrap()
            .elapsed
            - other_initial,
        Duration::from_secs(60)
    );
    host.dialog_closed(&source(), start + Duration::from_secs(61))
        .unwrap();
    assert_eq!(
        host.execution_time(&target, start + Duration::from_secs(63))
            .unwrap()
            .elapsed
            - initial,
        Duration::from_secs(3)
    );
    host.dialog_opened(
        &page,
        source(),
        BrowserDialogKind::Prompt,
        ("next", "url", ""),
        start + Duration::from_secs(64),
    )
    .unwrap();
    host.dialog_closed(&source(), start + Duration::from_secs(70))
        .unwrap();
    let finished = host
        .execution_time(&target, start + Duration::from_secs(71))
        .unwrap();
    assert!(!finished.suspended);
    assert_eq!(finished.elapsed - initial, Duration::from_secs(5));
    host.dialog_observation_lost(&BrowserInstanceId::new("instance").unwrap());
    assert!(matches!(
        host.execution_time(&target, start + Duration::from_secs(72)),
        Err(BrowserAdmissionError::DialogObservationLost)
    ));
}
