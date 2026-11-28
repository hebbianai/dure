use super::*;

#[test]
fn acknowledged_input_never_revalidates_a_pre_input_quiescence_fence() {
    use crate::local_protocol::{AgentRuntimeStateSource, ManagedProviderStopQuiescenceFence};
    let mut host = host();
    let current = fence("runner-1", 1, "terminal-1");
    let waiting = AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent);
    let before = host
        .observe_agent_runtime_state(&current, waiting)
        .unwrap()
        .unwrap();
    let previous = ManagedProviderStopQuiescenceFence {
        terminal_epoch: before.terminal_epoch.clone(),
        runtime_revision: before.revision,
        observed_through_output_seq: host.current_output_seq(),
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &previous)
            .unwrap()
    );
    host.record_controller_input(&current).unwrap();
    host.record_controller_submit(&current).unwrap();
    host.observe_agent_runtime_state(&current, waiting).unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &previous)
            .unwrap(),
        "a semantic acknowledgement must retire idle evidence captured before the submitted input"
    );
    let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full).unwrap();
    let after = snapshot.agent_runtime_state.unwrap();
    assert!(after.revision > before.revision);
    assert_eq!(after.turn_completed_count, before.turn_completed_count);
    assert_eq!(snapshot.controller_input_pending, Some(false));
    let fresh = ManagedProviderStopQuiescenceFence {
        terminal_epoch: after.terminal_epoch,
        runtime_revision: after.revision,
        observed_through_output_seq: snapshot.sequence_through,
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &fresh)
            .unwrap()
    );
    assert!(
        host.observe_agent_runtime_state(&current, waiting)
            .unwrap()
            .is_none()
    );
    assert!(
        host.matches_agent_runtime_quiescence(&current, &fresh)
            .unwrap()
    );
}

#[test]
fn inspection_and_stop_share_pending_input_until_submission_is_acknowledged() {
    use crate::local_protocol::{AgentRuntimeStateSource, ManagedProviderStopQuiescenceFence};
    let mut host = host();
    let current = fence("runner-1", 1, "terminal-1");
    let waiting = AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent);
    host.observe_agent_runtime_state(&current, waiting).unwrap();

    let assert_protection = |host: &SessionHost, pending: bool| {
        let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full).unwrap();
        let (metadata, _) = host.inspect_metadata(&current).unwrap();
        assert_eq!(snapshot.controller_input_pending, Some(pending));
        assert_eq!(metadata.controller_input_pending, Some(pending));
        let runtime = snapshot.agent_runtime_state.unwrap();
        assert_eq!(
            runtime.activity,
            crate::local_protocol::AgentRuntimeActivity::Waiting
        );
        let fence = ManagedProviderStopQuiescenceFence {
            terminal_epoch: runtime.terminal_epoch,
            runtime_revision: runtime.revision,
            observed_through_output_seq: snapshot.sequence_through,
        };
        assert_eq!(
            host.matches_agent_runtime_quiescence(&current, &fence)
                .unwrap(),
            !pending
        );
    };

    assert_protection(&host, false);
    host.record_controller_input(&current).unwrap();
    assert_protection(&host, true);
    host.observe_agent_runtime_state(&current, waiting).unwrap();
    assert_protection(&host, true);
    host.record_controller_submit(&current).unwrap();
    assert_protection(&host, true);
    host.observe_agent_runtime_state(&current, waiting).unwrap();
    assert_protection(&host, false);
    host.record_controller_submit(&current).unwrap();
    host.record_controller_input(&current).unwrap();
    host.observe_agent_runtime_state(&current, waiting).unwrap();
    assert_protection(&host, true);
}

#[test]
fn quiescence_fence_pairs_the_waiting_revision_with_a_current_output_snapshot() {
    let mut host = host();
    let current = fence("runner-1", 1, "terminal-1");
    let waiting = host
        .observe_agent_runtime_state(
            &current,
            AgentRuntimeObservation::waiting(
                crate::local_protocol::AgentRuntimeStateSource::ProviderEvent,
            ),
        )
        .unwrap()
        .unwrap();
    let expected = crate::local_protocol::ManagedProviderStopQuiescenceFence {
        terminal_epoch: waiting.terminal_epoch.clone(),
        runtime_revision: waiting.revision,
        observed_through_output_seq: waiting.observed_through_output_seq,
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &expected)
            .unwrap()
    );

    host.ingest_output(&current, b"late provider output")
        .unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &expected)
            .unwrap(),
        "output after the captured high-water invalidates its quiescence fence"
    );

    let refreshed = crate::local_protocol::ManagedProviderStopQuiescenceFence {
        terminal_epoch: waiting.terminal_epoch.clone(),
        runtime_revision: waiting.revision,
        observed_through_output_seq: waiting.observed_through_output_seq + 1,
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &refreshed)
            .unwrap(),
        "the same typed waiting revision can be paired with a later exact output snapshot"
    );

    host.record_controller_input(&current).unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &refreshed)
            .unwrap(),
        "an unsubmitted controller draft prevents automatic replacement"
    );

    host.observe_agent_runtime_state(
        &current,
        AgentRuntimeObservation::working(
            crate::local_protocol::AgentRuntimeStateSource::ControllerInput,
        ),
    )
    .unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &expected)
            .unwrap()
    );

    let controller_waiting = host
        .expire_agent_runtime_state(
            &current,
            Instant::now() + std::time::Duration::from_secs(31),
        )
        .unwrap()
        .expect("the controller working claim must expire");
    let controller_waiting_fence = crate::local_protocol::ManagedProviderStopQuiescenceFence {
        terminal_epoch: controller_waiting.terminal_epoch,
        runtime_revision: controller_waiting.revision,
        observed_through_output_seq: controller_waiting.observed_through_output_seq,
    };
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &controller_waiting_fence)
            .unwrap(),
        "controller expiry is not provider-authored quiescence"
    );
}

#[test]
fn semantic_working_expiry_cannot_authorize_idle_stop() {
    use crate::local_protocol::{AgentRuntimeStateSource, ManagedProviderStopQuiescenceFence};
    for source in [
        AgentRuntimeStateSource::ProviderEvent,
        AgentRuntimeStateSource::OrchestrationEvent,
    ] {
        let mut host = host();
        let current = fence("runner-1", 1, "terminal-1");
        host.observe_agent_runtime_state(&current, AgentRuntimeObservation::working(source))
            .unwrap();
        host.expire_agent_runtime_state(
            &current,
            Instant::now() + std::time::Duration::from_secs(600),
        )
        .unwrap();
        let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full).unwrap();
        let observed = snapshot.agent_runtime_state.unwrap();
        let expected = ManagedProviderStopQuiescenceFence {
            terminal_epoch: observed.terminal_epoch.clone(),
            runtime_revision: observed.revision,
            observed_through_output_seq: host.current_output_seq(),
        };
        assert!(
            !host
                .matches_agent_runtime_quiescence(&current, &expected)
                .unwrap(),
            "an expired semantic working lease is not a completed task"
        );
        let waiting = host
            .observe_agent_runtime_state(&current, AgentRuntimeObservation::waiting(source))
            .unwrap()
            .unwrap();
        let expected = ManagedProviderStopQuiescenceFence {
            terminal_epoch: waiting.terminal_epoch,
            runtime_revision: waiting.revision,
            observed_through_output_seq: host.current_output_seq(),
        };
        assert!(
            host.matches_agent_runtime_quiescence(&current, &expected)
                .unwrap(),
            "a later explicit idle report restores idle-stop authority"
        );
    }
}

#[test]
fn process_existence_cannot_authorize_idle_stop() {
    use crate::local_protocol::{AgentRuntimeStateSource, ManagedProviderStopQuiescenceFence};
    let mut host = host();
    let current = fence("runner-1", 1, "terminal-1");
    host.observe_agent_runtime_state(
        &current,
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle),
    )
    .unwrap();
    let snapshot = host.current_snapshot(ScreenSnapshotProfile::Full).unwrap();
    let observed = snapshot.agent_runtime_state.unwrap();
    let expected = ManagedProviderStopQuiescenceFence {
        terminal_epoch: observed.terminal_epoch.clone(),
        runtime_revision: observed.revision,
        observed_through_output_seq: host.current_output_seq(),
    };
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &expected)
            .unwrap(),
        "a running process does not prove that its provider is idle"
    );
}

/// A turn that settled on a typed API failure admits the exact fenced stop
/// a managed account switch needs, and nothing later: new output or a new
/// runtime revision refuses the same fence.
#[test]
fn a_settled_turn_failure_admits_only_its_exact_stop_fence() {
    use crate::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentTurnFailure,
        ManagedProviderStopQuiescenceFence,
    };
    use crate::terminal_replay::AgentStateReportObservation;
    let report = |activity, attention, turn_failure| AgentStateReportObservation {
        progress: None,
        activity,
        attention,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        expected_observation: None,
        background_work: false,
        startup_gate: None,
        approval_request: None,
        turn_failure,
    };
    let mut host = host();
    let current = fence("runner-1", 1, "terminal-1");
    let AgentStateReportFold::Applied(failed) = host
        .apply_agent_state_report(
            &current,
            report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::Error,
                Some(AgentTurnFailure::RateLimit),
            ),
        )
        .unwrap()
    else {
        panic!("the failure report must apply");
    };
    let at_failure = ManagedProviderStopQuiescenceFence {
        terminal_epoch: failed.terminal_epoch.clone(),
        runtime_revision: failed.revision,
        observed_through_output_seq: host.current_output_seq(),
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &at_failure)
            .unwrap()
    );

    host.ingest_output(&current, b"late provider output")
        .unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &at_failure)
            .unwrap(),
        "output after the captured failure invalidates its fence"
    );

    let after_output = ManagedProviderStopQuiescenceFence {
        observed_through_output_seq: host.current_output_seq(),
        ..at_failure.clone()
    };
    assert!(
        host.matches_agent_runtime_quiescence(&current, &after_output)
            .unwrap()
    );
    host.apply_agent_state_report(
        &current,
        report(
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
            None,
        ),
    )
    .unwrap();
    assert!(
        !host
            .matches_agent_runtime_quiescence(&current, &after_output)
            .unwrap(),
        "a new turn retires the failure's stop authority"
    );

    // An error its reporter did not name is just as settled, so it admits its
    // exact stop fence too; only recovery needs the reason.
    let mut host = super::host();
    let AgentStateReportFold::Applied(untyped) = host
        .apply_agent_state_report(
            &current,
            report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::Error,
                None,
            ),
        )
        .unwrap()
    else {
        panic!("the error report must apply");
    };
    assert!(
        host.matches_agent_runtime_quiescence(
            &current,
            &ManagedProviderStopQuiescenceFence {
                terminal_epoch: untyped.terminal_epoch.clone(),
                runtime_revision: untyped.revision,
                observed_through_output_seq: host.current_output_seq(),
            },
        )
        .unwrap()
    );
}
