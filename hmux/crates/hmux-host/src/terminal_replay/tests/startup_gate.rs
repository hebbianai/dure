use super::*;
use crate::local_protocol::AgentStartupGate;

/// What a provider adapter reports when it read a signed-out account before
/// any conversation: the provider waits for a person at its sign-in screen.
fn sign_in_report() -> AgentStateReportObservation {
    let mut report = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::InputRequired,
        false,
    );
    report.startup_gate = Some(AgentStartupGate::Login);
    report
}

/// The Host keeps a reported sign-in gate exactly as long as the attention
/// it arrived with, so a provider that exits from that screen leaves a typed
/// cause. Nothing here reads terminal output.
#[test]
fn a_reported_sign_in_gate_lasts_for_its_attention_episode() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    let projection = applied(
        replay
            .apply_agent_state_report_at(sign_in_report(), now)
            .unwrap(),
    );
    assert_eq!(projection.attention, AgentRuntimeAttention::InputRequired);
    assert_eq!(replay.agent_startup_gate(), Some(AgentStartupGate::Login));

    // A waiting report without attention keeps the episode, and the gate.
    replay
        .apply_agent_state_report_at(
            state_report(
                AgentRuntimeActivity::Waiting,
                AgentRuntimeAttention::None,
                false,
            ),
            now,
        )
        .unwrap();
    assert_eq!(replay.agent_startup_gate(), Some(AgentStartupGate::Login));

    // Work after sign-in ends both.
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
    assert_eq!(replay.agent_startup_gate(), None);
}

#[test]
fn another_attention_without_the_gate_ends_it() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(sign_in_report(), now)
        .unwrap();
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
    assert_eq!(replay.agent_startup_gate(), None);
}

/// Choosing a sign-in method at the screen is input, not evidence that the
/// account signed in; the gate stays until the provider reports otherwise.
#[test]
fn input_at_the_sign_in_screen_keeps_the_gate() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .apply_agent_state_report_at(sign_in_report(), Instant::now())
        .unwrap();
    replay.record_controller_submit().unwrap();
    assert_eq!(replay.agent_startup_gate(), Some(AgentStartupGate::Login));
}
