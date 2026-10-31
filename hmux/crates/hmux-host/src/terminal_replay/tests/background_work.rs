use super::*;
use crate::local_protocol::AgentStateReportCausality;

fn report(
    sequence: u64,
    activity: AgentRuntimeActivity,
    background_work: bool,
) -> AgentStateReportObservation {
    let mut report = state_report(activity, AgentRuntimeAttention::None, false);
    report.background_work = background_work;
    report.working_ttl_ms = Some(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
    report.causality = Some(AgentStateReportCausality {
        sequence,
        work_id: Some("parent-turn".into()),
    });
    report
}

#[test]
fn a_turn_that_ended_with_background_work_admits_prompts_but_stays_busy() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(report(1, AgentRuntimeActivity::Working, false), now)
        .unwrap();
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    let ended = applied(
        replay
            .apply_agent_state_report_at(report(2, AgentRuntimeActivity::Waiting, true), now)
            .unwrap(),
    );
    assert_eq!(ended.activity, AgentRuntimeActivity::Working);
    assert!(ended.background_work);
    assert!(!ended.is_semantically_quiescent());
    assert!(!replay.is_semantically_quiescent());
    assert_eq!(replay.semantic_idle_ms_at(now), None);
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
    assert_eq!(replay.prepare_agent_prompt(&target), Some(ended.revision));

    // Silence neither revokes the ready prompt nor releases background work.
    let lease = Duration::from_millis(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS);
    assert!(
        replay
            .expire_agent_runtime_state(now + lease)
            .unwrap()
            .is_none()
    );
    assert_eq!(replay.agent_runtime_state(), Some(&ended));

    // A tool call inside background work keeps the ended turn ready.
    assert_eq!(
        replay
            .apply_agent_state_report_at(report(3, AgentRuntimeActivity::Working, true), now)
            .unwrap(),
        AgentStateReportFold::NoOp
    );
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );

    // A new foreground turn ends readiness, and background work observed
    // during it cannot restore readiness.
    let resumed = applied(
        replay
            .apply_agent_state_report_at(report(4, AgentRuntimeActivity::Working, false), now)
            .unwrap(),
    );
    assert!(!resumed.background_work);
    replay
        .apply_agent_state_report_at(report(5, AgentRuntimeActivity::Working, true), now)
        .unwrap();
    assert!(!replay.agent_runtime_state().unwrap().background_work);
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );
}

#[test]
fn background_work_cannot_grant_readiness_after_attention_or_survive_completion() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let target = existing_conversation_prompt_target();
    let now = Instant::now();
    replay
        .apply_agent_state_report_at(report(1, AgentRuntimeActivity::Waiting, true), now)
        .unwrap();
    let mut approval = report(2, AgentRuntimeActivity::Waiting, false);
    approval.attention = AgentRuntimeAttention::ApprovalRequired;
    approval.working_ttl_ms = None;
    assert!(!applied(replay.apply_agent_state_report_at(approval, now).unwrap()).background_work);
    let resumed = applied(
        replay
            .apply_agent_state_report_at(report(3, AgentRuntimeActivity::Working, true), now)
            .unwrap(),
    );
    assert_eq!(resumed.activity, AgentRuntimeActivity::Working);
    assert_eq!(resumed.attention, AgentRuntimeAttention::None);
    assert!(!resumed.background_work);
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Refused
    );

    let mut invalid = report(4, AgentRuntimeActivity::Waiting, true);
    invalid.attention = AgentRuntimeAttention::ApprovalRequired;
    assert_eq!(
        replay.apply_agent_state_report_at(invalid, now),
        Err(TerminalReplayError::InvalidAgentRuntimeState)
    );

    replay
        .apply_agent_state_report_at(report(5, AgentRuntimeActivity::Waiting, true), now)
        .unwrap();
    let mut completed = report(6, AgentRuntimeActivity::Waiting, false);
    completed.turn_completed = true;
    completed.turn_completion_id = Some("parent-turn".into());
    completed.working_ttl_ms = None;
    replay.apply_agent_state_report_at(completed, now).unwrap();
    replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap();
    let settled = replay.agent_runtime_state().unwrap();
    assert_eq!(settled.activity, AgentRuntimeActivity::Waiting);
    assert!(!settled.background_work);
    assert!(replay.is_semantically_quiescent());
    assert_eq!(
        replay.agent_prompt_admission(&target),
        AgentPromptAdmission::Eligible
    );
}
