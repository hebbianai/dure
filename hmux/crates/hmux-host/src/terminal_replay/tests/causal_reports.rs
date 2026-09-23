use super::*;
use crate::local_protocol::AgentStateReportCausality;

#[test]
fn verified_conversation_continuation_keeps_turn_completion_live() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    let identity = |id: &str| {
        ProviderConversationIdentityObservation::new(
            "claude",
            id,
            ProviderConversationIdentitySource::ProviderEvent,
        )
    };
    replay
        .apply_agent_state_report_with_identity_at(
            causal(10, "parent-work", false),
            Some(identity("original")),
            now,
        )
        .unwrap();
    let before = replay.agent_runtime_state().cloned();
    assert_eq!(
        replay.apply_agent_state_report_with_identity_at(
            causal(11, "child-work", false),
            Some(identity("unrelated-child")),
            now,
        ),
        Err(TerminalReplayError::ProviderConversationIdentityConflict)
    );
    assert_eq!(replay.agent_runtime_state(), before.as_ref());

    let mut continued = identity("continued");
    continued.previous_conversation_id = Some("original".into());
    replay
        .apply_agent_state_report_with_identity_at(
            causal(12, "parent-work", false),
            Some(continued),
            now,
        )
        .unwrap();
    let current = replay.provider_conversation_identity().unwrap();
    assert_eq!(current.conversation_id, "continued");
    assert_eq!(current.revision, 2);
    replay
        .apply_agent_state_report_with_identity_at(
            causal(13, "parent-work", true),
            Some(identity("continued")),
            now,
        )
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        replay.agent_runtime_state().unwrap().activity,
        AgentRuntimeActivity::Waiting
    );
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        1
    );

    let stale = replay
        .apply_agent_state_report_with_identity_at(
            causal(11, "parent-work", false),
            Some(identity("original")),
            now,
        )
        .unwrap();
    assert_eq!(stale.0, AgentStateReportFold::NoOp);
    assert_eq!(
        replay
            .provider_conversation_identity()
            .unwrap()
            .conversation_id,
        "continued"
    );
    assert_eq!(
        replay.agent_runtime_state().unwrap().activity,
        AgentRuntimeActivity::Waiting
    );
}

#[test]
fn conversation_continuation_requires_the_exact_predecessor() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_with_identity_at(
            causal(10, "work", false),
            Some(ProviderConversationIdentityObservation::new(
                "claude",
                "current",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
            now,
        )
        .unwrap();
    for (provider, previous) in [("claude", "another"), ("codex", "current")] {
        let mut changed = ProviderConversationIdentityObservation::new(
            provider,
            "next",
            ProviderConversationIdentitySource::ProviderEvent,
        );
        changed.previous_conversation_id = Some(previous.into());
        assert_eq!(
            replay.apply_agent_state_report_with_identity_at(
                causal(11, "work", false),
                Some(changed),
                now,
            ),
            Err(TerminalReplayError::ProviderConversationIdentityConflict)
        );
        assert_eq!(
            replay
                .provider_conversation_identity()
                .unwrap()
                .conversation_id,
            "current"
        );
    }
}

fn causal(sequence: u64, work: &str, completed: bool) -> AgentStateReportObservation {
    let mut report = state_report(
        if completed {
            AgentRuntimeActivity::Waiting
        } else {
            AgentRuntimeActivity::Working
        },
        AgentRuntimeAttention::None,
        completed,
    );
    report.turn_completion_id = completed.then(|| work.to_string());
    report.causality = Some(AgentStateReportCausality {
        sequence,
        work_id: Some(work.to_string()),
    });
    report
}

#[test]
fn obsolete_completion_cannot_retire_new_work_even_with_a_later_delivery_sequence() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "old-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(2, "new-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(3, "old-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        replay.agent_runtime_state().unwrap().activity,
        AgentRuntimeActivity::Working
    );
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        0
    );
    assert!(!replay.is_semantically_quiescent());
}

#[test]
fn unseen_delayed_begin_cannot_replace_the_current_work_identity() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(20, "new-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(10, "unseen-old-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(11, "unseen-old-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(!replay.is_semantically_quiescent());
    replay
        .apply_agent_state_report_at(causal(21, "new-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        1
    );
}

#[test]
fn submitted_input_without_a_new_begin_cannot_be_acknowledged_by_old_completion() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "old-work", false), now)
        .unwrap();
    replay.record_controller_submit().unwrap();
    replay
        .apply_agent_state_report_at(causal(2, "old-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(replay.has_pending_controller_input());
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        0
    );
}

#[test]
fn stale_causal_report_cannot_change_conversation_identity() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_with_identity_at(
            causal(20, "current-work", false),
            Some(ProviderConversationIdentityObservation::new(
                "provider",
                "current-conversation",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
            now,
        )
        .unwrap();
    let before = replay.provider_conversation_identity().cloned();
    let result = replay
        .apply_agent_state_report_with_identity_at(
            causal(10, "old-work", false),
            Some(ProviderConversationIdentityObservation::new(
                "provider",
                "old-conversation",
                ProviderConversationIdentitySource::ProviderEvent,
            )),
            now,
        )
        .unwrap();
    assert_eq!(result.0, AgentStateReportFold::NoOp);
    assert!(!result.2);
    assert_eq!(replay.provider_conversation_identity(), before.as_ref());
}

#[test]
fn causal_settlement_is_not_readmitted_and_duplicates_do_not_extend_it() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "current-work", false), now)
        .unwrap();
    let completed = causal(2, "current-work", true);
    replay
        .apply_agent_state_report_at(completed.clone(), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(completed.clone(), now + Duration::from_millis(200))
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_millis(300))
        .unwrap();
    assert!(replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        1
    );
    assert_eq!(
        replay
            .apply_agent_state_report_at(completed, now + Duration::from_secs(1))
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        1
    );
}

#[test]
fn new_work_supersedes_a_pending_causal_completion() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "old-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(2, "old-work", true), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(3, "new-work", false), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_runtime_state().unwrap().turn_completed_count,
        0
    );
}

#[test]
fn unsequenced_work_requires_a_fresh_identified_begin_before_completion() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "old-work", false), now)
        .unwrap();
    let mut unknown = causal(2, "new-work", false);
    unknown.causality = None;
    replay.apply_agent_state_report_at(unknown, now).unwrap();
    replay
        .apply_agent_state_report_at(causal(3, "old-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(!replay.is_semantically_quiescent());
    replay
        .apply_agent_state_report_at(causal(4, "new-work", false), now)
        .unwrap();
    replay
        .apply_agent_state_report_at(causal(5, "new-work", true), now)
        .unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    assert!(replay.is_semantically_quiescent());
}

#[test]
fn first_causal_bootstrap_cannot_end_work_observed_before_it() {
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
    let mut bootstrap = causal(1, "bootstrap", false);
    bootstrap.activity = AgentRuntimeActivity::Waiting;
    bootstrap.causality.as_mut().unwrap().work_id = None;
    replay.apply_agent_state_report_at(bootstrap, now).unwrap();
    assert_eq!(
        replay.agent_runtime_state().unwrap().activity,
        AgentRuntimeActivity::Working
    );
    assert!(!replay.is_semantically_quiescent());
}

#[test]
fn first_causal_bootstrap_cannot_acknowledge_submitted_input() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
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
    replay.record_controller_submit().unwrap();
    let mut bootstrap = causal(1, "bootstrap", false);
    bootstrap.activity = AgentRuntimeActivity::Waiting;
    bootstrap.causality.as_mut().unwrap().work_id = None;
    replay.apply_agent_state_report_at(bootstrap, now).unwrap();
    assert!(replay.has_pending_controller_input());
    assert!(!replay.is_semantically_quiescent());
}

#[test]
fn invalid_causal_report_cannot_publish_identity_or_advance_the_watermark() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "current-work", false), now)
        .unwrap();
    let before = replay.report_causality.clone();
    for report in [causal(0, "invalid-sequence", false), causal(2, "", false)] {
        assert_eq!(
            replay.apply_agent_state_report_with_identity_at(
                report,
                Some(ProviderConversationIdentityObservation::new(
                    "provider",
                    "unexpected-conversation",
                    ProviderConversationIdentitySource::ProviderEvent
                )),
                now
            ),
            Err(TerminalReplayError::InvalidAgentRuntimeState)
        );
        assert!(replay.provider_conversation_identity().is_none());
        assert_eq!(replay.report_causality, before);
    }
}

#[test]
fn late_state_failure_restores_causal_identity_and_watermark() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(causal(1, "current-work", false), now)
        .unwrap();
    replay.agent_runtime_state.as_mut().unwrap().revision = u64::MAX;
    let before = replay.report_causality.clone();
    let mut permission = causal(2, "current-work", false);
    permission.activity = AgentRuntimeActivity::Waiting;
    permission.attention = AgentRuntimeAttention::ApprovalRequired;
    assert_eq!(
        replay.apply_agent_state_report_with_identity_at(
            permission,
            Some(ProviderConversationIdentityObservation::new(
                "provider",
                "new-conversation",
                ProviderConversationIdentitySource::ProviderEvent
            )),
            now
        ),
        Err(TerminalReplayError::StateRevisionExhausted)
    );
    assert!(replay.provider_conversation_identity().is_none());
    assert_eq!(replay.report_causality, before);
}
