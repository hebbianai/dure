use super::*;
use crate::browser_resource::tracing::*;
use hmux_session_protocol::browser_tracing::*;

#[test]
fn retained_interval_stop_after_page_close_keeps_controller_sequence_and_handoff_fences() {
    for mode in [BrowserTracingMode::Trace, BrowserTracingMode::Profiler] {
        let (mut host, controller, page) = setup();
        let instance = BrowserInstanceId::new("instance").unwrap();
        let foreign = BrowserInstanceId::new("foreign").unwrap();
        host.register_instance_binding(&resource(), foreign.clone())
            .unwrap();
        let start = action(&host, &controller, &page);
        let admitted = host
            .begin_action(&controller.controller_id, &start, [])
            .unwrap();
        let mut tracing = BrowserTracingHost::new(instance.clone(), resource());
        let lease = tracing
            .start(
                &host.prepare_tracing(&admitted).unwrap(),
                mode,
                BrowserTracingScope::Browser,
            )
            .unwrap();
        tracing.started(&lease).unwrap();
        host.finish_action(admitted, BrowserActionOutcome::Completed)
            .unwrap();
        host.page_closed(&page.page_id).unwrap();
        assert!(host.pages().is_empty());
        assert_eq!(tracing.status(&resource()).interval.unwrap().origin, page);

        let authority = BrowserTracingStopAuthority {
            lease: controller.clone(),
            command_sequence: host.projection().next_command_sequence,
            operation_id: BrowserOperationId::new("retained-stop").unwrap(),
            instance_id: instance,
            recording: start.operation_id,
        };
        let mut wrong = authority.clone();
        wrong.recording = BrowserOperationId::new("different-recording").unwrap();
        denied(
            tracing.begin_stop(&mut host, &controller.controller_id, &wrong),
            BrowserAdmissionError::PermitMismatch,
        );
        wrong = authority.clone();
        wrong.instance_id = foreign;
        denied(
            tracing.begin_stop(&mut host, &controller.controller_id, &wrong),
            BrowserAdmissionError::InstanceMismatch,
        );
        wrong = authority.clone();
        wrong.command_sequence = NonZeroU64::new(wrong.command_sequence.get() + 1).unwrap();
        denied(
            tracing.begin_stop(&mut host, &controller.controller_id, &wrong),
            BrowserAdmissionError::CommandSequenceGap,
        );
        wrong = authority.clone();
        wrong.lease.resource.generation = BrowserResourceGeneration::new("other").unwrap();
        denied(
            tracing.begin_stop(&mut host, &controller.controller_id, &wrong),
            BrowserAdmissionError::ResourceMismatch,
        );
        assert_eq!(
            host.projection().next_command_sequence,
            authority.command_sequence
        );

        let human = host
            .request_control(super::controller("human"), Some(&controller))
            .unwrap()
            .controller
            .unwrap();
        denied(
            tracing.begin_stop(&mut host, &controller.controller_id, &authority),
            BrowserAdmissionError::ControllerChanged,
        );
        let authority = BrowserTracingStopAuthority {
            lease: human.clone(),
            ..authority
        };
        let permit = tracing
            .begin_stop(&mut host, &human.controller_id, &authority)
            .unwrap();
        assert_eq!(permit.lease(), &lease);
        wrong = authority.clone();
        wrong.command_sequence = host.projection().next_command_sequence;
        denied(
            tracing.begin_stop(&mut host, &human.controller_id, &wrong),
            BrowserAdmissionError::ActionInFlight,
        );
        host.request_control(super::controller("next"), Some(&human))
            .unwrap();
        assert_eq!(host.projection().controller, Some(human.clone()));
        host.dispatch_tracing_stop(&permit).unwrap();
        tracing.require_stop(&permit).unwrap();
        tracing.finished(permit.lease(), true).unwrap();
        tracing.release(permit.lease()).unwrap();
        let completed = host
            .finish_tracing_stop(permit, BrowserActionOutcome::Completed)
            .unwrap();
        assert_eq!(
            completed.controller.unwrap().controller_id,
            super::controller("next")
        );
        assert!(completed.in_flight.is_none());
        assert!(!tracing.status(&resource()).busy);
    }
}

#[test]
fn task_scope_blocks_new_peers_and_prior_sharing_never_becomes_exclusive() {
    let (mut host, controller, page) = setup();
    let authority = action(&host, &controller, &page);
    let action = host
        .begin_action(&controller.controller_id, &authority, [])
        .unwrap();
    let permit = host.prepare_tracing(&action).unwrap();
    let mut tracing =
        BrowserTracingHost::new(BrowserInstanceId::new("instance").unwrap(), resource());
    let mut peer = resource();
    peer.generation = BrowserResourceGeneration::new("peer").unwrap();
    for mode in [BrowserTracingMode::Trace, BrowserTracingMode::Profiler] {
        let lease = tracing
            .start(&permit, mode, BrowserTracingScope::Task)
            .unwrap();
        assert_eq!(
            tracing.admit_resource(&peer),
            Err(BrowserAdmissionError::TracingAlreadyActive)
        );
        tracing.admit_resource(&resource()).unwrap();
        tracing.finished(&lease, true).unwrap();
        // Completion still retains the output interval and its scope.
        assert_eq!(
            tracing.admit_resource(&peer),
            Err(BrowserAdmissionError::TracingAlreadyActive)
        );
        tracing.release(&lease).unwrap();
    }
    tracing.admit_resource(&peer).unwrap();
    tracing.admit_resource(&resource()).unwrap();
    assert_eq!(
        tracing.start(
            &permit,
            BrowserTracingMode::Trace,
            BrowserTracingScope::Task
        ),
        Err(BrowserAdmissionError::TracingScopeRequired)
    );
    tracing
        .start(
            &permit,
            BrowserTracingMode::Trace,
            BrowserTracingScope::Browser,
        )
        .unwrap();
    tracing.admit_resource(&peer).unwrap();
}

#[test]
fn stop_requires_original_resource_interval_and_rejects_stale_completion() {
    let (mut host, controller, page) = setup();
    let start = action(&host, &controller, &page);
    let action_permit = host
        .begin_action(&controller.controller_id, &start, [])
        .unwrap();
    let permit = host.prepare_tracing(&action_permit).unwrap();
    let mut tracing =
        BrowserTracingHost::new(BrowserInstanceId::new("instance").unwrap(), resource());
    let first = tracing
        .start(
            &permit,
            BrowserTracingMode::Trace,
            BrowserTracingScope::Browser,
        )
        .unwrap();
    assert_eq!(
        tracing.start(
            &permit,
            BrowserTracingMode::Profiler,
            BrowserTracingScope::Browser
        ),
        Err(BrowserAdmissionError::TracingAlreadyActive)
    );
    let mut peer_resource = resource();
    peer_resource.resource_id = BrowserResourceId::new("peer").unwrap();
    let mut peer = BrowserResourceHost::new(peer_resource);
    let peer_page = peer
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("peer-target").unwrap(),
            BrowserDocumentId::new("peer-document").unwrap(),
        )
        .unwrap();
    let peer_controller = peer
        .request_control(controller.controller_id.clone(), None)
        .unwrap()
        .controller
        .unwrap();
    let request = action(&peer, &peer_controller, &peer_page);
    let peer_action = peer
        .begin_action(&peer_controller.controller_id, &request, [])
        .unwrap();
    let peer_permit = peer.prepare_tracing(&peer_action).unwrap();
    assert_eq!(
        tracing.stop(&peer_permit, &start.operation_id),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    let observed = tracing.status(&peer_page.resource);
    assert!(observed.busy);
    assert!(observed.interval.is_none());
    assert_eq!(
        tracing.stop(&permit, &BrowserOperationId::new("wrong").unwrap()),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(tracing.stop(&permit, &start.operation_id).unwrap(), first);
    tracing.finished(&first, false).unwrap();
    assert_eq!(
        tracing
            .status(&page.resource)
            .interval
            .unwrap()
            .cleanup_confirmed,
        Some(false)
    );
    assert_eq!(
        tracing.release(&first),
        Err(BrowserAdmissionError::OutcomeUnknown)
    );
    tracing.finished(&first, true).unwrap();
    tracing.release(&first).unwrap();
    let second = tracing
        .start(
            &permit,
            BrowserTracingMode::Profiler,
            BrowserTracingScope::Browser,
        )
        .unwrap();
    assert_ne!(first, second);
    assert_eq!(
        tracing.release(&first),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(
        tracing.finished(&first, true),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    assert_eq!(
        tracing.status(&page.resource).interval.unwrap().mode,
        BrowserTracingMode::Profiler
    );
}

#[test]
fn current_input_authority_can_stop_after_navigation_and_handoff_on_the_same_instance() {
    let (mut host, controller, page) = setup();
    let start = action(&host, &controller, &page);
    let admitted = host
        .begin_action(&controller.controller_id, &start, [])
        .unwrap();
    let permit = host.prepare_tracing(&admitted).unwrap();
    let mut tracing =
        BrowserTracingHost::new(BrowserInstanceId::new("instance").unwrap(), resource());
    let lease = tracing
        .start(
            &permit,
            BrowserTracingMode::Trace,
            BrowserTracingScope::Task,
        )
        .unwrap();
    tracing.started(&lease).unwrap();
    host.finish_action(admitted, BrowserActionOutcome::Completed)
        .unwrap();
    let current = host
        .document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    let human = host
        .request_control(super::controller("human"), Some(&controller))
        .unwrap()
        .controller
        .unwrap();
    denied(
        host.begin_action(&controller.controller_id, &start, []),
        BrowserAdmissionError::ControllerChanged,
    );
    let request = action(&host, &human, &current);
    let admitted = host
        .begin_action(&human.controller_id, &request, [])
        .unwrap();
    let permit = host.prepare_tracing(&admitted).unwrap();
    assert_eq!(tracing.stop(&permit, &start.operation_id).unwrap(), lease);
    let mut foreign =
        BrowserTracingHost::new(BrowserInstanceId::new("foreign").unwrap(), resource());
    assert_eq!(
        foreign.start(
            &permit,
            BrowserTracingMode::Trace,
            BrowserTracingScope::Browser
        ),
        Err(BrowserAdmissionError::InstanceMismatch)
    );
}
