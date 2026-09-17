use super::*;

#[test]
fn capture_lifetime_survives_documents_but_cannot_sample_after_finish_or_stop() {
    let (mut host, lease, page) = setup();
    let request = action(&host, &lease, &page);
    let admitted = host
        .begin_action(&lease.controller_id, &request, [])
        .unwrap();
    let prepared = host.prepare_recording(&admitted, true).unwrap();
    let capture = host.recording_acknowledged(prepared).unwrap().unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    let current = host
        .document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    assert!(host.recording_target(&capture).is_ok());
    host.recording_finished(&capture, true).unwrap();
    assert_eq!(
        host.recording_target(&capture),
        Err(BrowserAdmissionError::RecordingNotActive)
    );
    assert!(
        host.recording_status(&resource(), &page.page_id)
            .unwrap()
            .finished
    );
    let stop = action(&host, &lease, &current);
    let admitted = host.begin_action(&lease.controller_id, &stop, []).unwrap();
    let prepared = host.prepare_recording(&admitted, false).unwrap();
    host.recording_acknowledged(prepared).unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(
        host.recording_finished(&capture, true),
        Err(BrowserAdmissionError::RecordingNotActive)
    );
}

#[test]
fn unacknowledged_native_finish_fences_the_recording_instance_without_claiming_it_stopped() {
    let (mut host, lease, page) = setup();
    let request = action(&host, &lease, &page);
    let admitted = host
        .begin_action(&lease.controller_id, &request, [])
        .unwrap();
    let prepared = host.prepare_recording(&admitted, true).unwrap();
    let capture = host.recording_acknowledged(prepared).unwrap().unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    host.recording_finished(&capture, false).unwrap();
    let status = host.recording_status(&resource(), &page.page_id).unwrap();
    assert_eq!(status.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(!status.finished);
    assert_eq!(
        host.recording_target(&capture),
        Err(BrowserAdmissionError::OutcomeUnknown)
    );
}

#[test]
fn recording_survives_navigation_and_handoff_but_needs_current_action_authority() {
    let (mut host, lease, page) = setup();
    let start = action(&host, &lease, &page);
    let admitted = host.begin_action(&lease.controller_id, &start, []).unwrap();
    let recording = host.prepare_recording(&admitted, true).unwrap();
    assert_eq!(recording.recording(), &start.operation_id);
    assert!(host
        .recording_status(&resource(), &page.page_id)
        .unwrap()
        .operation_id
        .is_none());
    host.document_committed(
        &page.page_id,
        BrowserDocumentId::new("next-document").unwrap(),
    )
    .unwrap();
    host.request_control(controller("human"), Some(&lease))
        .unwrap();
    host.recording_acknowledged(recording).unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    let current = host.recording_status(&resource(), &page.page_id).unwrap();
    assert_ne!(current.page, page);
    assert_eq!(current.operation_id, Some(start.operation_id.clone()));
    denied(
        host.begin_action(&lease.controller_id, &start, []),
        BrowserAdmissionError::ControllerChanged,
    );
    let human = host.projection().controller.unwrap();
    let request = action(&host, &human, &current.page);
    let stop = host
        .begin_action(&human.controller_id, &request, [])
        .unwrap();
    assert!(matches!(
        host.prepare_recording(&stop, true),
        Err(BrowserAdmissionError::RecordingAlreadyActive)
    ));
    let stopped = host.prepare_recording(&stop, false).unwrap();
    assert_eq!(stopped.recording(), &start.operation_id);
    host.recording_acknowledged(stopped).unwrap();
    assert!(matches!(
        host.prepare_recording(&stop, false),
        Err(BrowserAdmissionError::RecordingNotActive)
    ));
    host.finish_action(stop, BrowserActionOutcome::Completed)
        .unwrap();
    assert!(host
        .recording_status(&resource(), &page.page_id)
        .unwrap()
        .operation_id
        .is_none());
}

#[test]
fn recording_acknowledgement_cannot_revive_a_closed_page_or_retiring_resource() {
    for close_page in [false, true] {
        let (mut host, lease, page) = setup();
        let request = action(&host, &lease, &page);
        let admitted = host
            .begin_action(&lease.controller_id, &request, [])
            .unwrap();
        let recording = host.prepare_recording(&admitted, true).unwrap();
        if close_page {
            host.page_closed(&page.page_id).unwrap();
        } else {
            host.begin_retirement(&resource()).unwrap();
        }
        assert_eq!(
            host.recording_acknowledged(recording),
            Err(if close_page {
                BrowserAdmissionError::PageGone
            } else {
                BrowserAdmissionError::ResourceRetiring
            })
        );
        host.finish_action(admitted, BrowserActionOutcome::OutcomeUnknown)
            .unwrap();
        assert!(matches!(
            host.projection().phase,
            BrowserResourcePhase::Retiring | BrowserResourcePhase::OutcomeUnknown
        ));
    }
}

#[test]
fn recording_observation_cannot_cross_resource_generation_or_page() {
    let (mut host, lease, page) = setup();
    let request = action(&host, &lease, &page);
    let admitted = host
        .begin_action(&lease.controller_id, &request, [])
        .unwrap();
    let recording = host.prepare_recording(&admitted, true).unwrap();
    host.recording_acknowledged(recording).unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("other").unwrap(),
            BrowserDocumentId::new("other-document").unwrap(),
        )
        .unwrap();
    assert!(host
        .recording_status(&resource(), &other.page_id)
        .unwrap()
        .operation_id
        .is_none());
    let mut forged = resource();
    forged.generation = BrowserResourceGeneration::new("next-generation").unwrap();
    assert_eq!(
        host.recording_status(&forged, &page.page_id),
        Err(BrowserAdmissionError::ResourceMismatch)
    );
}
