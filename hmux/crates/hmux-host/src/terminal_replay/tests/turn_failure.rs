use super::*;
use crate::local_protocol::AgentTurnFailure;

/// What a provider adapter reports when the provider's turn ended on a typed
/// API failure, such as a rate limit: the prompt is idle and nothing runs.
fn failed_turn_report(failure: AgentTurnFailure) -> AgentStateReportObservation {
    let mut report = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::Error,
        false,
    );
    report.turn_failure = Some(failure);
    report
}

/// The Host projects the reported failure beside its error, for exactly the
/// error episode it arrived with, and never infers it from terminal output.
#[test]
fn a_reported_turn_failure_lasts_for_its_error_episode() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    let failed = applied(
        replay
            .apply_agent_state_report_at(failed_turn_report(AgentTurnFailure::RateLimit), now)
            .unwrap(),
    );
    assert_eq!(failed.attention, AgentRuntimeAttention::Error);
    assert_eq!(failed.turn_failure, Some(AgentTurnFailure::RateLimit));
    assert!(failed.attention_id.is_some());
    assert!(failed.is_settled_turn_failure());

    // An idle report keeps the episode, its identity and its failure.
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
    let kept = replay.agent_runtime_state().unwrap().clone();
    assert_eq!(kept.turn_failure, Some(AgentTurnFailure::RateLimit));
    assert_eq!(kept.attention_id, failed.attention_id);

    // A new turn ends both.
    let working = applied(
        replay
            .apply_agent_state_report_at(
                state_report(
                    AgentRuntimeActivity::Working,
                    AgentRuntimeAttention::None,
                    false,
                ),
                now,
            )
            .unwrap(),
    );
    assert_eq!(working.turn_failure, None);
    assert_eq!(working.attention_id, None);
}

#[test]
fn another_attention_ends_the_failure() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(failed_turn_report(AgentTurnFailure::UsageLimit), now)
        .unwrap();
    let asking = applied(
        replay
            .apply_agent_state_report_at(
                state_report(
                    AgentRuntimeActivity::Waiting,
                    AgentRuntimeAttention::InputRequired,
                    false,
                ),
                now,
            )
            .unwrap(),
    );
    assert_eq!(asking.turn_failure, None);
}

/// A failure that differs from the episode's is a projection change, so
/// observers see the latest reason.
#[test]
fn a_new_reason_in_the_same_episode_is_published() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(failed_turn_report(AgentTurnFailure::ProviderError), now)
        .unwrap();
    let limited = applied(
        replay
            .apply_agent_state_report_at(failed_turn_report(AgentTurnFailure::UsageLimit), now)
            .unwrap(),
    );
    assert_eq!(limited.turn_failure, Some(AgentTurnFailure::UsageLimit));
}

/// A settled failure admits a fenced managed stop, but it is never idle:
/// semantic idle age, and with it hibernation, stays quiescence-only.
#[test]
fn a_settled_turn_failure_is_a_stop_boundary_but_never_idle() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(failed_turn_report(AgentTurnFailure::RateLimit), now)
        .unwrap();
    assert!(replay.is_stop_boundary());
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(
        replay.semantic_idle_ms_at(now + Duration::from_secs(60)),
        None
    );
}

/// A turn that ended on an error its reporter did not name is settled too:
/// the reason is only what recovery acts on. A turn that is still running is
/// never a stop boundary.
#[test]
fn an_error_without_a_typed_failure_is_a_stop_boundary_but_a_running_turn_is_not() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
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
    assert!(!replay.is_stop_boundary());
    let failed = applied(
        replay
            .apply_agent_state_report_at(
                state_report(
                    AgentRuntimeActivity::Waiting,
                    AgentRuntimeAttention::Error,
                    false,
                ),
                now,
            )
            .unwrap(),
    );
    assert_eq!(failed.turn_failure, None);
    assert!(replay.is_stop_boundary());
    assert!(!replay.is_semantically_quiescent());
}

/// Unsent input at the prompt is the person's, so no automatic stop may
/// discard it.
#[test]
fn pending_input_at_a_failed_turn_keeps_the_session() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .apply_agent_state_report_at(
            failed_turn_report(AgentTurnFailure::RateLimit),
            Instant::now(),
        )
        .unwrap();
    replay.record_controller_input();
    assert!(!replay.is_stop_boundary());
}

/// A person who touched the terminal after the failure may be answering it
/// there, so the failure no longer admits an automatic stop.
#[test]
fn key_input_since_the_failure_keeps_the_session() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    replay
        .apply_agent_state_report_at(
            failed_turn_report(AgentTurnFailure::RateLimit),
            Instant::now(),
        )
        .unwrap();
    replay.record_controller_key_input();
    assert!(!replay.is_stop_boundary());
}
