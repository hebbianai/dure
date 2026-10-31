use super::*;

fn working_report() -> AgentStateReportObservation {
    let mut report = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    report.working_ttl_ms = Some(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
    report
}

fn waiting_report() -> AgentStateReportObservation {
    state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        false,
    )
}

/// Claude Code runs no hook when a person interrupts a turn with Escape, so
/// the provider's working lease would refuse every inbox prompt until a later
/// turn reports. The Escape itself admits prompts while the pane stays busy
/// for idle replacement, account switches and hibernation; the lease is not
/// shortened, and the next provider report decides.
#[test]
fn escape_during_a_provider_working_turn_admits_prompts_but_stays_busy() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();
    let working = applied(
        replay
            .apply_agent_state_report_at(working_report(), now)
            .unwrap(),
    );
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    replay.record_controller_interrupt_request();
    assert!(replay.has_interrupt_request());
    // The request is not a guess about the provider: the projection stays
    // working, so nothing treats the pane as idle.
    assert_eq!(replay.agent_runtime_state(), Some(&working));
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(replay.semantic_idle_ms_at(now), None);
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
    assert_eq!(replay.prepare_agent_prompt(&target), Some(working.revision));

    // Silence neither ends the lease nor withdraws the request.
    let lease = Duration::from_millis(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
    assert!(
        replay
            .expire_agent_runtime_state(now + lease)
            .unwrap()
            .is_none()
    );
    assert_eq!(replay.agent_runtime_state(), Some(&working));
    assert!(replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    // The turn goes on: a later tool call reports working again. The
    // projection is unchanged, yet the report withdraws the request.
    assert_eq!(
        replay
            .apply_agent_state_report_at(working_report(), now + lease)
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(!replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    // The turn's own Stop report grants the ordinary ready prompt.
    replay.record_controller_interrupt_request();
    assert!(replay.has_interrupt_request());
    let ended = applied(
        replay
            .apply_agent_state_report_at(waiting_report(), now + lease)
            .unwrap(),
    );
    assert!(!replay.has_interrupt_request());
    assert_eq!(ended.activity, AgentRuntimeActivity::Waiting);
    assert!(replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
}

/// The admitted prompt, or a person's own Enter, starts a turn with its own
/// reports: the request ends with the submit, and the new turn waits for its
/// provider acknowledgement like any other.
#[test]
fn an_accepted_submit_ends_the_interrupt_request() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(working_report(), now)
        .unwrap();
    replay.record_controller_interrupt_request();
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    assert_eq!(replay.record_controller_submit().unwrap(), None);
    assert!(!replay.has_interrupt_request());
    assert!(replay.has_pending_controller_input());
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    let acknowledged = applied(
        replay
            .apply_agent_state_report_at(working_report(), now)
            .unwrap(),
    );
    assert_eq!(acknowledged.activity, AgentRuntimeActivity::Working);
    assert!(!replay.has_pending_controller_input());
    assert!(!replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
}

/// Escape is an interrupt only during a provider-reported working turn. An
/// idle prompt, a prompt that needs attention, a turn that ended with
/// background work, a legacy controller estimate and a session without a
/// runtime projection record nothing beyond the control write.
#[test]
fn escape_outside_a_provider_working_turn_records_no_request() {
    let (mut replay, waiting) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();

    replay.record_controller_interrupt_request();
    assert!(!replay.has_interrupt_request());
    assert_eq!(replay.agent_runtime_state(), Some(&waiting));
    assert!(replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    // Escape may dismiss an approval prompt, but only the provider's report
    // says what the turn did next.
    replay
        .apply_agent_state_report_at(
            state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::ApprovalRequired,
                false,
            ),
            now,
        )
        .unwrap();
    replay.record_controller_interrupt_request();
    assert!(!replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    // A turn that ended with background work already has a ready prompt.
    let mut ended = waiting_report();
    ended.background_work = true;
    ended.working_ttl_ms = Some(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
    let ended = applied(replay.apply_agent_state_report_at(ended, now).unwrap());
    assert!(ended.background_work);
    replay.record_controller_interrupt_request();
    assert!(!replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    // A legacy controller estimate has no provider authority to widen.
    let mut legacy = replay_with_limits(TerminalReplayLimits::default());
    legacy
        .observe_agent_runtime_state(AgentRuntimeObservation::working(
            AgentRuntimeStateSource::ControllerInput,
        ))
        .unwrap();
    legacy.record_controller_interrupt_request();
    assert!(!legacy.has_interrupt_request());

    let mut unobserved = replay_with_limits(TerminalReplayLimits::default());
    unobserved.record_controller_interrupt_request();
    assert!(!unobserved.has_interrupt_request());
}

/// A report the Host ignores or cannot apply says nothing new about the turn,
/// so the request stands; the transactional report path restores it with the
/// other facts it rolls back.
#[test]
fn a_report_the_host_ignores_or_cannot_apply_leaves_the_request_standing() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(working_report(), now)
        .unwrap();
    replay.record_controller_interrupt_request();

    // A report fenced to an observation the Host has moved past.
    let mut stale = waiting_report();
    stale.expected_observation = Some(crate::local_protocol::AgentStateReportObservationFence {
        terminal_epoch: replay.fence().terminal_epoch.clone(),
        runtime_revision: 0,
        output_sequence: replay.current_output_seq(),
    });
    assert_eq!(
        replay.apply_agent_state_report_at(stale, now).unwrap(),
        AgentStateReportFold::NoOp
    );
    assert!(replay.has_interrupt_request());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    // A report whose fold fails after the Host started applying it.
    replay.agent_runtime_state.as_mut().unwrap().revision = u64::MAX;
    assert!(matches!(
        replay.apply_agent_state_report_with_identity_at(waiting_report(), None, now),
        Err(TerminalReplayError::StateRevisionExhausted)
    ));
    assert!(replay.has_interrupt_request());
    assert_eq!(
        replay.agent_runtime_state().unwrap().activity,
        AgentRuntimeActivity::Working
    );
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
}
