use super::*;

#[test]
fn semantic_idle_age_is_live_only_and_passive_output_does_not_reset_it() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let start = Instant::now() - Duration::from_secs(60);
    assert_eq!(replay.semantic_idle_ms_at(start), None);
    replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle),
            start,
        )
        .unwrap();
    assert_eq!(replay.semantic_idle_ms_at(Instant::now()), None);
    replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
            start,
        )
        .unwrap();
    let first = replay.snapshot(ScreenSnapshotProfile::Full).unwrap();
    assert!(first.semantic_idle_ms.unwrap() >= 60_000);
    replay.ingest_output(b"passive redraw\r\n").unwrap();
    let next = replay
        .snapshot(ScreenSnapshotProfile::ViewportOnly)
        .unwrap();
    assert_eq!(first.agent_runtime_state, next.agent_runtime_state);
    assert!(next.sequence_through > first.sequence_through);
    assert!(next.semantic_idle_ms >= first.semantic_idle_ms);
    let replacement = replay_with_limits(TerminalReplayLimits::default());
    assert_eq!(replacement.semantic_idle_ms_at(Instant::now()), None);
    let changed_at = replay.agent_runtime_changed_at;
    replay.agent_runtime_state.as_mut().unwrap().revision = u64::MAX;
    replay.record_controller_input();
    replay.record_controller_submit().unwrap();
    assert!(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                false
            ))
            .is_err()
    );
    assert_eq!(
        replay.agent_runtime_changed_at, changed_at,
        "failed folds cannot rewrite the idle clock"
    );
    assert_eq!(
        replay.semantic_idle_ms_at(Instant::now()),
        None,
        "failed input acknowledgement remains protected"
    );
}

#[test]
fn semantic_idle_age_survives_observers_but_not_activity_or_acknowledged_input() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let start = Instant::now();
    replay
        .apply_agent_state_report_at(
            state_report(
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                false,
            ),
            start,
        )
        .unwrap();
    assert_eq!(replay.semantic_idle_ms_at(start), None);
    let waiting_at = start + Duration::from_secs(1);
    let waiting = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        false,
    );
    replay
        .apply_agent_state_report_at(waiting.clone(), waiting_at)
        .unwrap();
    assert_eq!(replay.semantic_idle_ms_at(waiting_at), Some(0));
    let later = waiting_at + Duration::from_secs(3_600);
    assert_eq!(
        replay
            .apply_agent_state_report_at(waiting.clone(), later)
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert_eq!(replay.semantic_idle_ms_at(later), Some(3_600_000));
    assert_eq!(
        replay.semantic_idle_ms_at(start),
        None,
        "clock regression is unknown"
    );
    replay.record_controller_input();
    assert_eq!(replay.semantic_idle_ms_at(later), None);
    replay
        .apply_agent_state_report_at(waiting.clone(), later)
        .unwrap();
    assert_eq!(
        replay.semantic_idle_ms_at(later),
        None,
        "a repeated idle report cannot erase a draft"
    );
    replay.record_controller_submit().unwrap();
    assert_eq!(replay.semantic_idle_ms_at(later), None);
    replay.apply_agent_state_report_at(waiting, later).unwrap();
    assert_eq!(replay.semantic_idle_ms_at(later), Some(0));
    assert_eq!(
        replay.semantic_idle_ms_at(later + Duration::from_secs(2)),
        Some(2_000)
    );
    replay
        .apply_agent_state_report_at(
            state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::InputRequired,
                false,
            ),
            later,
        )
        .unwrap();
    assert_eq!(
        replay.semantic_idle_ms_at(later + Duration::from_secs(10)),
        None
    );
}

#[test]
fn existing_conversation_prompt_commits_written_submit_and_rearms_on_provider_waiting() {
    let (mut replay, waiting) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    assert_eq!(replay.prepare_agent_prompt(&target), Some(waiting.revision));
    replay.record_controller_input();
    assert!(replay.record_controller_submit().unwrap().is_none());
    assert_eq!(replay.agent_runtime_state(), Some(&waiting));
    assert!(replay.has_pending_controller_input());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
    assert_eq!(replay.prepare_agent_prompt(&target), None);
    assert!(
        replay
            .expire_agent_runtime_state(Instant::now() + Duration::from_secs(60))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap();
    assert!(replay.has_pending_controller_input());
    replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap();
    assert!(!replay.has_pending_controller_input());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
}

#[test]
fn provider_acknowledgement_preserves_a_newer_unsubmitted_draft() {
    for activity in [AgentRuntimeActivity::Working, AgentRuntimeActivity::Waiting] {
        let (mut replay, _) = provider_ready_for_agent_prompt();
        replay.record_controller_input();
        replay.record_controller_submit().unwrap();
        replay.record_controller_input();
        replay
            .apply_agent_state_report(state_report(activity, AgentRuntimeAttention::None, false))
            .unwrap();
        assert!(
            replay.has_pending_controller_input(),
            "provider progress cannot consume a newer draft"
        );
        replay.record_controller_submit().unwrap();
        replay
            .apply_agent_state_report(state_report(activity, AgentRuntimeAttention::None, false))
            .unwrap();
        assert!(
            !replay.has_pending_controller_input(),
            "a new semantic report acknowledges submitted input even without an activity change"
        );
    }
}

#[test]
fn input_acknowledgement_advances_revision_without_inventing_a_completed_turn() {
    for identified_completion in [false, true] {
        let (mut replay, waiting) = provider_ready_for_agent_prompt();
        let now = Instant::now();
        replay.record_controller_input();
        replay.record_controller_submit().unwrap();
        let mut report = state_report(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            identified_completion,
        );
        if identified_completion {
            report.turn_completion_id = Some("submitted-turn".into());
        }
        let acknowledged = applied(
            replay
                .apply_agent_state_report_at(report.clone(), now)
                .unwrap(),
        );
        assert!(acknowledged.revision > waiting.revision);
        assert_eq!(acknowledged.activity, waiting.activity);
        assert_eq!(acknowledged.attention, waiting.attention);
        assert_eq!(
            acknowledged.turn_completed_count,
            waiting.turn_completed_count
        );
        assert!(!replay.has_pending_controller_input());
        assert_eq!(
            replay.apply_agent_state_report_at(report, now).unwrap(),
            AgentStateReportFold::NoOp,
            "repeated idle evidence does not advance the acknowledged input epoch"
        );
        if identified_completion {
            let completed = replay
                .expire_agent_runtime_state(now + Duration::from_secs(1))
                .unwrap()
                .unwrap();
            assert_eq!(
                completed.turn_completed_count,
                waiting.turn_completed_count + 1
            );
            assert!(completed.revision > acknowledged.revision);
        }
    }
}

#[test]
fn exhausted_input_acknowledgement_preserves_pending_input_and_completion_state() {
    for identified_completion in [false, true] {
        let (mut replay, _) = provider_ready_for_agent_prompt();
        replay.agent_runtime_state.as_mut().unwrap().revision = u64::MAX;
        let mut pending = state_report(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            true,
        );
        pending.turn_completion_id = Some("previous-completion".into());
        assert_eq!(
            replay.apply_agent_state_report(pending).unwrap(),
            AgentStateReportFold::NoOp
        );
        let before_completion = replay.pending_turn_completion.clone();
        let before_ids = replay.accepted_turn_completion_ids.clone();
        replay.record_controller_input();
        replay.record_controller_submit().unwrap();
        let before = replay.agent_runtime_state().cloned();
        let mut report = state_report(
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            identified_completion,
        );
        if identified_completion {
            report.turn_completion_id = Some("uncommitted-turn".into());
        }
        assert_eq!(
            replay.apply_agent_state_report(report),
            Err(TerminalReplayError::StateRevisionExhausted)
        );
        assert_eq!(replay.agent_runtime_state(), before.as_ref());
        assert!(replay.has_pending_controller_input());
        assert_eq!(replay.pending_turn_completion, before_completion);
        assert_eq!(replay.accepted_turn_completion_ids, before_ids);
        assert_eq!(
            replay.agent_prompt_admission(&existing_conversation_prompt_target()),
            AgentPromptAdmission::Refused
        );
    }
}

#[test]
fn snapshot_fenced_report_cannot_acknowledge_intervening_submit() {
    let (mut replay, waiting) = provider_ready_for_agent_prompt();
    let mut report = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        false,
    );
    report.expected_observation = Some(crate::local_protocol::AgentStateReportObservationFence {
        terminal_epoch: waiting.terminal_epoch.clone(),
        runtime_revision: waiting.revision,
        output_sequence: replay.current_output_seq(),
    });
    replay.record_controller_input();
    replay.record_controller_submit().unwrap();
    assert_eq!(
        replay.apply_agent_state_report(report).unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(replay.has_pending_controller_input());
    assert_eq!(
        replay.agent_prompt_admission(&existing_conversation_prompt_target()),
        AgentPromptAdmission::Refused
    );
}

#[test]
fn delayed_completion_settlement_cannot_acknowledge_a_later_submit() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(
            state_report(
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                false,
            ),
            now,
        )
        .unwrap();
    let mut report = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    report.turn_completion_id = Some("previous-turn".into());
    assert_eq!(
        replay
            .apply_agent_state_report_at(report.clone(), now)
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    replay.record_controller_input();
    assert!(replay.record_controller_submit().unwrap().is_none());
    let completed = replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert_eq!(completed.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(completed.turn_completed_count, 1);
    assert!(replay.has_pending_controller_input());
    assert_eq!(
        replay.apply_agent_state_report(report).unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(
        replay.has_pending_controller_input(),
        "a duplicate completion is not a new input acknowledgement"
    );
}

#[test]
fn submit_preserves_semantic_activity_attention_and_deadline() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let now = Instant::now();
    let mut report = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    report.working_ttl_ms = Some(600_000);
    let working = applied(replay.apply_agent_state_report_at(report, now).unwrap());
    replay.record_controller_input();
    assert!(replay.record_controller_submit().unwrap().is_none());
    assert_eq!(replay.agent_runtime_state(), Some(&working));
    assert!(
        replay
            .expire_agent_runtime_state(now + Duration::from_secs(31))
            .unwrap()
            .is_none()
    );

    let attention = applied(
        replay
            .apply_agent_state_report(state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
                false,
            ))
            .unwrap(),
    );
    replay.record_controller_input();
    replay.record_controller_submit().unwrap();
    assert_eq!(replay.agent_runtime_state(), Some(&attention));
}

#[test]
fn orchestration_activity_has_the_same_authority_over_controller_input() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let waiting = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::OrchestrationEvent,
        ))
        .unwrap()
        .unwrap();
    replay.record_controller_input();
    assert!(replay.record_controller_submit().unwrap().is_none());
    assert_eq!(replay.agent_runtime_state(), Some(&waiting));
    assert!(replay.has_pending_controller_input());
    replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::OrchestrationEvent,
        ))
        .unwrap();
    assert!(!replay.has_pending_controller_input());
}

#[test]
fn failed_controller_projection_keeps_written_input_pending() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    replay.record_controller_input();
    replay
        .agent_runtime_state
        .as_mut()
        .expect("provider-ready fixture has runtime state")
        .revision = u64::MAX;

    assert_eq!(
        replay.observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ControllerInput,
        )),
        Err(TerminalReplayError::StateRevisionExhausted)
    );
    assert!(replay.has_pending_controller_input());
    assert_eq!(
        replay.agent_prompt_admission(&existing_conversation_prompt_target()),
        AgentPromptAdmission::Refused,
        "bytes already written must keep repeated prompt admission closed"
    );
}
