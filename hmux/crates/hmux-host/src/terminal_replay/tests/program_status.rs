use super::*;
use crate::local_protocol::{ProgramStatusBlockedKind, ProgramStatusState};

const PROBE: &[u8] = b"\x1b]7501;?\x1b\\";

fn running_agent() -> (TerminalReplay, AgentRuntimeStateProjection) {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let runtime = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap()
        .unwrap();
    (replay, runtime)
}

fn status_state(projection: &AgentRuntimeStateProjection) -> Option<ProgramStatusState> {
    projection
        .program_status
        .as_ref()
        .map(|status| status.state)
}

#[test]
fn the_support_probe_is_answered_ahead_of_the_device_attributes_reply() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let ingested = replay.ingest_output(&[PROBE, b"\x1b[c"].concat()).unwrap();
    assert!(
        ingested.pty_replies.starts_with(PROBE),
        "programs treat a DA1 reply that arrives first as no support"
    );
    assert!(
        ingested.pty_replies.len() > PROBE.len(),
        "the engine still answers DA1 after the probe"
    );
    assert!(ingested.agent_runtime_state.is_none());

    let split = replay.ingest_output(&PROBE[..4]).unwrap();
    assert!(split.pty_replies.is_empty());
    let completed = replay.ingest_output(&PROBE[4..]).unwrap();
    assert_eq!(completed.pty_replies, PROBE);
}

#[test]
fn a_report_republishes_only_presentation_and_never_semantics() {
    let (mut replay, runtime) = running_agent();
    let changed_at = replay.agent_runtime_changed_at;
    let ingested = replay
        .ingest_output(b"\x1b]7501;state=blocked:kind=permission:app=claude-code\x07")
        .unwrap();
    let published = ingested
        .agent_runtime_state
        .clone()
        .expect("the program's new status is published");

    assert_eq!(published.revision, runtime.revision + 1);
    assert_eq!(published.observed_through_output_seq, ingested.output_seq);
    assert_eq!(
        (
            published.lifecycle,
            published.activity,
            published.attention,
            published.attention_id.as_deref(),
            published.source,
            published.turn_completed_count,
        ),
        (
            runtime.lifecycle,
            runtime.activity,
            runtime.attention,
            runtime.attention_id.as_deref(),
            runtime.source,
            runtime.turn_completed_count,
        ),
        "a program's self-report is never a Host semantic fact"
    );
    let status = published.program_status.as_ref().unwrap();
    assert_eq!(status.state, ProgramStatusState::Blocked);
    assert_eq!(
        status.blocked_kind,
        Some(ProgramStatusBlockedKind::Permission)
    );
    assert_eq!(status.app.as_deref(), Some("claude-code"));
    assert_eq!(replay.agent_runtime_state.as_ref(), Some(&published));
    assert_eq!(
        replay.agent_runtime_changed_at, changed_at,
        "presentation does not reset semantic idle age"
    );

    let repeated = replay
        .ingest_output(b"\x1b]7501;state=blocked:kind=permission:app=claude-code\x07")
        .unwrap();
    assert!(repeated.agent_runtime_state.is_none());
    assert!(
        replay
            .ingest_output(b"ordinary output")
            .unwrap()
            .agent_runtime_state
            .is_none()
    );
}

#[test]
fn a_prompt_ends_the_reported_activity() {
    let (mut replay, _) = running_agent();
    replay
        .ingest_output(b"\x1b]7501;state=working:progress=60\x07")
        .unwrap();
    let cleared = replay
        .ingest_output(b"\x1b]133;A\x07")
        .unwrap()
        .agent_runtime_state
        .expect("removing the record is a change");
    assert_eq!(cleared.program_status, None);
}

#[test]
fn a_status_reported_before_the_agent_starts_is_not_the_agents() {
    let mut replay = replay_with_limits(TerminalReplayLimits::default());
    let ingested = replay
        .ingest_output(b"\x1b]7501;state=error:app=make\x07")
        .unwrap();
    assert!(
        ingested.agent_runtime_state.is_none(),
        "no agent to annotate yet"
    );

    let runtime = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProcessLifecycle,
        ))
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime.program_status, None,
        "an earlier command's failure is not the starting agent's"
    );
    let reported = replay
        .ingest_output(b"\x1b]7501;state=idle:app=claude-code\x07")
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(status_state(&reported), Some(ProgramStatusState::Idle));
}

#[test]
fn a_report_while_a_turn_completion_settles_does_not_cancel_it() {
    let (mut replay, _) = running_agent();
    let now = Instant::now();
    applied(
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
    let mut completion = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    completion.turn_completion_id = Some("turn-1".into());
    assert_eq!(
        replay.apply_agent_state_report_at(completion, now).unwrap(),
        AgentStateReportFold::NoOp,
        "an identified completion settles before it is published"
    );

    // The program announces the same boundary through its own status.
    assert!(
        replay
            .ingest_output(b"\x1b]7501;state=idle\x07")
            .unwrap()
            .agent_runtime_state
            .is_some()
    );

    let settled = replay
        .expire_agent_runtime_state(now + Duration::from_secs(1))
        .unwrap()
        .expect("the settled completion is still published");
    assert_eq!(settled.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(settled.turn_completed_count, 1);
    assert_eq!(status_state(&settled), Some(ProgramStatusState::Idle));
}

#[test]
fn a_report_does_not_cancel_a_working_lease() {
    // Enter in a pane without hooks: a 30 second controller estimate.
    let (mut replay, _) = running_agent();
    let now = Instant::now();
    replay
        .observe_agent_runtime_state_at(
            AgentRuntimeObservation::new(
                AgentRuntimeLifecycle::Running,
                AgentRuntimeActivity::Working,
                AgentRuntimeAttention::None,
                AgentRuntimeStateSource::ControllerInput,
            ),
            now,
        )
        .unwrap();
    assert!(
        replay
            .ingest_output(b"\x1b]7501;state=working\x07")
            .unwrap()
            .agent_runtime_state
            .is_some()
    );

    let expired = replay
        .expire_agent_runtime_state(now + Duration::from_secs(60))
        .unwrap()
        .expect("the controller estimate still expires after the report");
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(status_state(&expired), Some(ProgramStatusState::Working));
}

#[test]
fn the_agents_exit_ends_its_status_and_a_successor_starts_without_it() {
    let (mut replay, _) = running_agent();
    replay
        .ingest_output(b"\x1b]7501;state=error:msg=YnVpbGQgZmFpbGVk\x07")
        .unwrap();
    let message = |replay: &TerminalReplay| {
        replay
            .agent_runtime_state
            .as_ref()
            .and_then(|state| state.program_status.as_ref())
            .and_then(|status| status.message.clone())
    };
    assert_eq!(message(&replay).as_deref(), Some("build failed"));

    let exited = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::exited())
        .unwrap()
        .unwrap();
    assert_eq!(exited.program_status, None);

    // Process discovery only seeds an absent projection; a typed provider
    // fact starts the successor in this terminal.
    let successor = replay
        .observe_agent_runtime_state(AgentRuntimeObservation::waiting(
            AgentRuntimeStateSource::ProviderEvent,
        ))
        .unwrap()
        .unwrap();
    assert_eq!(successor.lifecycle, AgentRuntimeLifecycle::Running);
    assert_eq!(
        successor.program_status, None,
        "a persistent error from the previous agent is not the successor's"
    );
}

#[test]
fn an_exited_agent_publishes_no_program_status() {
    let (mut replay, _) = running_agent();
    replay
        .observe_agent_runtime_state(AgentRuntimeObservation::exited())
        .unwrap()
        .unwrap();
    assert!(
        replay
            .ingest_output(b"\x1b]7501;state=working\x07")
            .unwrap()
            .agent_runtime_state
            .is_none()
    );
}
