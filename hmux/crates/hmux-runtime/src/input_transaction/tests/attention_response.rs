use super::*;
use hmux_host::local_protocol::{AgentApprovalChoice, AgentApprovalRequest};
use hmux_host::terminal_replay::AgentStateReportFold;
use terminal_state_protocol::{AttentionResponseInputIntent, KeyInputIntent};

/// A provider that asked to run one command and waits for the answer.
fn awaiting_approval() -> (SessionHost, String) {
    let mut host = ready_host(false);
    let fold = host
        .apply_agent_state_report(
            &fence(),
            AgentStateReportObservation {
                approval_request: Some(AgentApprovalRequest {
                    tool_name: "Bash".into(),
                    summary: "cargo test".into(),
                    choices: vec![AgentApprovalChoice::Approve, AgentApprovalChoice::Deny],
                }),
                progress: None,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::ApprovalRequired,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                expected_observation: None,
                background_work: false,
                startup_gate: None,
                turn_failure: None,
            },
        )
        .unwrap();
    let AgentStateReportFold::Applied(projection) = fold else {
        panic!("the approval should apply, got {fold:?}");
    };
    (host, projection.attention_id.expect("an approval is named"))
}

fn answer(attention_id: &str, key: &str) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::AttentionResponse(
            AttentionResponseInputIntent {
                expected_attention_id: attention_id.into(),
                keys: vec![KeyInputIntent {
                    key: key.into(),
                    code: String::new(),
                    modifiers: 0,
                    repeat: false,
                }],
            },
        )),
    }
}

fn answer_admission(input: &InputIntent) -> InputAdmission {
    InputAdmission::from_validated_structured(
        input.intent.as_ref().unwrap(),
        None,
        false,
        "claude",
        false,
        true,
    )
    .unwrap()
}

fn apply(
    host: &mut SessionHost,
    scanner: &mut SubmitScanner,
    input: PtyInput<'_>,
    effect: ControllerInputEffect,
    admission: InputAdmission,
    writes: &mut Vec<Vec<u8>>,
) -> InputTransactionOutcome {
    apply_input_transaction(host, &fence(), scanner, input, effect, admission, |bytes| {
        writes.push(bytes.to_vec());
        PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
    })
    .unwrap()
    .outcome
}

fn apply_answer(
    host: &mut SessionHost,
    scanner: &mut SubmitScanner,
    intent: &InputIntent,
    writes: &mut Vec<Vec<u8>>,
) -> InputTransactionOutcome {
    let effect =
        ControllerInputEffect::from_non_resize_structured(intent.intent.as_ref().unwrap()).unwrap();
    apply(
        host,
        scanner,
        PtyInput::Structured(intent),
        effect,
        answer_admission(intent),
        writes,
    )
}

#[test]
fn an_answer_lands_once_and_leaves_no_draft_behind() {
    let (mut host, attention_id) = awaiting_approval();
    let mut scanner = SubmitScanner::default();
    let mut writes = Vec::new();
    let approve = answer(&attention_id, "1");

    assert_eq!(
        apply_answer(&mut host, &mut scanner, &approve, &mut writes),
        InputTransactionOutcome::Written
    );
    assert_eq!(writes, vec![b"1".to_vec()]);
    assert!(
        !host.has_unsubmitted_controller_draft(&fence()).unwrap(),
        "choosing an option types nothing into the prompt"
    );
    // The same card pressed twice, or from a second device, answers nothing.
    assert_eq!(
        apply_answer(&mut host, &mut scanner, &approve, &mut writes),
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AttentionChanged)
    );
    assert_eq!(writes.len(), 1);
}

#[test]
fn an_approval_answered_in_the_terminal_refuses_a_stale_card() {
    let (mut host, attention_id) = awaiting_approval();
    let mut scanner = SubmitScanner::default();
    let mut writes = Vec::new();
    assert_eq!(
        apply(
            &mut host,
            &mut scanner,
            PtyInput::Bytes(b"\r"),
            ControllerInputEffect::DraftCapable,
            InputAdmission::Ordinary,
            &mut writes,
        ),
        InputTransactionOutcome::Written
    );
    assert_eq!(
        apply_answer(
            &mut host,
            &mut scanner,
            &answer(&attention_id, "1"),
            &mut writes
        ),
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AttentionChanged)
    );
    assert_eq!(
        writes,
        vec![b"\r".to_vec()],
        "nothing after the person's answer"
    );
}

#[test]
fn focus_reports_do_not_count_as_an_answer() {
    let (mut host, attention_id) = awaiting_approval();
    let mut scanner = SubmitScanner::default();
    let mut writes = Vec::new();
    assert_eq!(
        apply(
            &mut host,
            &mut scanner,
            PtyInput::Bytes(b"\x1b[O"),
            ControllerInputEffect::ControlOnly,
            InputAdmission::Ordinary,
            &mut writes,
        ),
        InputTransactionOutcome::Written
    );
    assert_eq!(
        apply_answer(
            &mut host,
            &mut scanner,
            &answer(&attention_id, "1"),
            &mut writes
        ),
        InputTransactionOutcome::Written
    );
}

#[test]
fn an_answer_for_another_attention_or_none_refuses_without_a_byte() {
    let (mut host, _) = awaiting_approval();
    let mut scanner = SubmitScanner::default();
    let mut writes = Vec::new();
    assert_eq!(
        apply_answer(
            &mut host,
            &mut scanner,
            &answer("attention-elsewhere", "1"),
            &mut writes
        ),
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AttentionChanged)
    );
    let mut idle = ready_host(false);
    assert_eq!(
        apply_answer(
            &mut idle,
            &mut scanner,
            &answer("attention-1", "1"),
            &mut writes
        ),
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AttentionChanged)
    );
    assert!(writes.is_empty());
}

#[test]
fn an_answer_requires_its_negotiated_capability() {
    let intent = answer("attention-1", "1");
    assert_eq!(
        InputAdmission::from_validated_structured(
            intent.intent.as_ref().unwrap(),
            Some(AgentPromptCapabilitySelection::Targeted),
            true,
            "claude",
            true,
            false,
        ),
        Err(hmux_runtime_contract::TERMINAL_ATTENTION_RESPONSE_INPUT_CAPABILITY)
    );
}
