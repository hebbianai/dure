use super::*;
use crate::local_protocol::{AGENT_PROGRESS_QUIET_MS, AgentProgressPhase, AgentProgressReport};

fn progress(sequence: u64, phase: AgentProgressPhase) -> AgentStateReportObservation {
    let mut report = state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    report.progress = Some(AgentProgressReport {
        source_id: "driver-1".into(),
        sequence,
        phase,
        turn_id: Some("turn-1".into()),
        message_turns: vec![],
    });
    report
}

#[test]
fn agent_progress_quiet_event_is_once_and_does_not_complete_or_exit() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    let report = progress(1, AgentProgressPhase::Thinking);
    let first = applied(
        replay
            .apply_agent_state_report_at(report.clone(), now)
            .unwrap(),
    );
    let deadline = now + Duration::from_millis(AGENT_PROGRESS_QUIET_MS);
    assert!(
        replay
            .expire_agent_runtime_state(deadline - Duration::from_millis(1))
            .unwrap()
            .is_none()
    );
    // Delivery retries are not provider activity and must not refresh the clock.
    replay
        .apply_agent_state_report_at(report, deadline - Duration::from_secs(1))
        .unwrap();
    let quiet = replay
        .expire_agent_runtime_state(deadline)
        .unwrap()
        .unwrap();
    assert!(quiet.progress.as_ref().unwrap().progress_unconfirmed);
    assert_eq!(quiet.revision, first.revision + 1);
    assert_eq!(quiet.activity, AgentRuntimeActivity::Working);
    assert_eq!(quiet.lifecycle, AgentRuntimeLifecycle::Running);
    assert_eq!(quiet.turn_completed_count, 0);
    assert!(
        replay
            .expire_agent_runtime_state(deadline + Duration::from_secs(90))
            .unwrap()
            .is_none()
    );
    let resumed = applied(
        replay
            .apply_agent_state_report_at(progress(2, AgentProgressPhase::Thinking), deadline)
            .unwrap(),
    );
    assert!(!resumed.progress.unwrap().progress_unconfirmed);
}

#[test]
fn agent_progress_tools_approvals_old_hosts_and_polling_do_not_raise_false_stalls() {
    for phase in [AgentProgressPhase::ToolRunning, AgentProgressPhase::Waiting] {
        let mut replay = replay_with_limits(TerminalReplayLimits::default());
        let now = Instant::now();
        replay
            .apply_agent_state_report_at(progress(1, phase), now)
            .unwrap();
        assert!(
            replay
                .expire_agent_runtime_state(now + Duration::from_secs(1000))
                .unwrap()
                .is_none()
        );
    }
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(progress(1, AgentProgressPhase::Thinking), now)
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
    assert!(
        replay
            .expire_agent_runtime_state(now + Duration::from_secs(1000))
            .unwrap()
            .is_none()
    );
}

#[test]
fn agent_progress_invalid_report_does_not_mutate_projection() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    let before = applied(
        replay
            .apply_agent_state_report_at(progress(1, AgentProgressPhase::Thinking), now)
            .unwrap(),
    );
    assert!(
        replay
            .apply_agent_state_report_at(progress(0, AgentProgressPhase::Thinking), now)
            .is_err()
    );
    assert_eq!(replay.agent_runtime_state.as_ref(), Some(&before));
}
