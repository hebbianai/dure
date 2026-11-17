use super::*;
use crate::local_protocol::{AgentApprovalChoice, AgentApprovalRequest};

fn request(summary: &str) -> AgentApprovalRequest {
    AgentApprovalRequest {
        tool_name: "Bash".into(),
        summary: summary.into(),
        choices: vec![
            AgentApprovalChoice::Approve,
            AgentApprovalChoice::ApproveAlways,
            AgentApprovalChoice::Deny,
        ],
    }
}

fn asks(summary: &str) -> AgentStateReportObservation {
    let mut report = state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::ApprovalRequired,
        false,
    );
    report.approval_request = Some(request(summary));
    report
}

fn blocked() -> AgentStateReportObservation {
    state_report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::ApprovalRequired,
        false,
    )
}

fn working() -> AgentStateReportObservation {
    state_report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    )
}

#[test]
fn the_request_rides_with_its_approval_and_ends_with_it() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let asked = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    assert_eq!(asked.approval_request.as_deref(), Some(&request("ls")));
    let attention_id = asked.attention_id.clone().expect("approval is named");

    // The provider's own notice of the same prompt carries no content; it
    // neither erases the request nor renames the approval.
    assert_eq!(
        replay.apply_agent_state_report(blocked()).unwrap(),
        AgentStateReportFold::NoOp
    );
    let current = replay.agent_runtime_state.clone().unwrap();
    assert_eq!(current.attention_id.as_deref(), Some(attention_id.as_str()));
    assert_eq!(current.approval_request.as_deref(), Some(&request("ls")));

    let resumed = applied(replay.apply_agent_state_report(working()).unwrap());
    assert_eq!(resumed.approval_request, None);
    assert_eq!(resumed.attention_id, None);
}

#[test]
fn a_notice_that_arrives_first_is_completed_by_the_request_without_a_new_name() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let notice = applied(replay.apply_agent_state_report(blocked()).unwrap());
    assert_eq!(notice.approval_request, None);
    let completed = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    assert_eq!(completed.attention_id, notice.attention_id);
    assert_eq!(completed.approval_request.as_deref(), Some(&request("ls")));
}

#[test]
fn every_reported_request_is_its_own_approval() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    let first = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    let second = applied(
        replay
            .apply_agent_state_report(asks("rm -rf build"))
            .unwrap(),
    );
    assert_ne!(first.attention_id, second.attention_id);
    let first_id = first.attention_id.unwrap();
    assert!(!replay.attention_response_admitted(&first_id));
    assert!(replay.attention_response_admitted(second.attention_id.as_deref().unwrap()));

    // The same command asked again is a second prompt: an answer given to
    // the first, here or in the terminal, cannot answer this one.
    replay.record_controller_key_input();
    let again = applied(
        replay
            .apply_agent_state_report(asks("rm -rf build"))
            .unwrap(),
    );
    assert_ne!(again.attention_id, second.attention_id);
    assert!(replay.attention_response_admitted(again.attention_id.as_deref().unwrap()));
}

#[test]
fn an_answer_is_admitted_only_for_the_current_unanswered_approval() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    assert!(!replay.attention_response_admitted("attention-1"));
    let asked = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    let attention_id = asked.attention_id.unwrap();
    assert!(replay.attention_response_admitted(&attention_id));
    assert!(!replay.attention_response_admitted("attention-elsewhere"));

    // A person answered in the terminal: the card that still shows the same
    // approval must not type into whatever the provider does next.
    replay.record_controller_key_input();
    assert!(!replay.attention_response_admitted(&attention_id));

    // The next approval starts unanswered again.
    applied(replay.apply_agent_state_report(working()).unwrap());
    let next = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    assert!(replay.attention_response_admitted(next.attention_id.as_deref().unwrap()));
}

#[test]
fn key_input_before_an_approval_does_not_answer_it() {
    let (mut replay, _) = provider_ready_for_agent_prompt();
    replay.record_controller_key_input();
    let asked = applied(replay.apply_agent_state_report(asks("ls")).unwrap());
    assert!(replay.attention_response_admitted(asked.attention_id.as_deref().unwrap()));
}
