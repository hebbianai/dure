use prost::Message;
use terminal_state_protocol::{
    AgentPromptInputIntent, ExistingConversationPromptTarget, FreshAgentPromptTarget, InputFailed,
    InputFailureReason, InputIntent, InputReceipt, InputWrittenToPty, KeyInputIntent,
    ProcessObservedFreshAgentPromptTarget, ResizeAppliedToTerminal, ResizeReceipt,
    TerminalStateRecord, TextInputIntent, WheelAppliedToViewport, WheelReceipt, WheelWrittenToPty,
    agent_prompt_input_intent, decode_record, encode_record, encode_record_for_minor, input_intent,
    input_receipt, resize_receipt, terminal_state_record, validate_input_intent,
    validate_input_receipt, validate_record, validate_resize_receipt, validate_wheel_receipt,
    wheel_receipt,
};

const INPUT_RECEIPT_KIND: u8 = 10;
const RESIZE_RECEIPT_KIND: u8 = 11;

#[derive(Clone, PartialEq, Message)]
struct LegacyAgentPromptInputIntent {
    #[prost(bytes = "vec", tag = "1")]
    utf8: Vec<u8>,
    #[prost(uint32, tag = "2")]
    admission_wait_ms: u32,
}

#[derive(Clone, PartialEq, Message)]
struct FutureInputWrittenToPty {
    #[prost(uint64, optional, tag = "1")]
    input_baseline_output_sequence: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureInputReceipt {
    #[prost(uint64, tag = "1")]
    in_reply_to_record_id: u64,
    #[prost(message, optional, tag = "10")]
    written_to_pty: Option<FutureInputWrittenToPty>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureResizeAppliedToTerminal {
    #[prost(uint32, tag = "1")]
    columns: u32,
    #[prost(uint32, tag = "2")]
    rows: u32,
}

#[derive(Clone, PartialEq, Message)]
struct FutureResizeReceipt {
    #[prost(uint64, tag = "1")]
    in_reply_to_record_id: u64,
    #[prost(message, optional, tag = "10")]
    applied_to_terminal: Option<FutureResizeAppliedToTerminal>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureReceiptRecord {
    #[prost(uint32, tag = "1")]
    schema_minor: u32,
    #[prost(string, tag = "2")]
    terminal_epoch: String,
    #[prost(uint64, tag = "3")]
    through_output_seq: u64,
    #[prost(uint64, tag = "4")]
    state_revision: u64,
    #[prost(message, optional, tag = "19")]
    input_receipt: Option<FutureInputReceipt>,
    #[prost(message, optional, tag = "20")]
    resize_receipt: Option<FutureResizeReceipt>,
}

fn envelope(kind: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(20 + payload.len());
    bytes.extend_from_slice(b"TSPB");
    bytes.push(1);
    bytes.push(4);
    bytes.push(kind);
    bytes.push(0);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&41_u64.to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes
}

#[test]
fn input_receipt_is_a_correlated_binary_final_outcome() {
    let encoded = envelope(
        INPUT_RECEIPT_KIND,
        FutureReceiptRecord {
            schema_minor: 4,
            terminal_epoch: "terminal-receipt-red".into(),
            through_output_seq: 9,
            state_revision: 7,
            input_receipt: Some(FutureInputReceipt {
                in_reply_to_record_id: 17,
                written_to_pty: Some(FutureInputWrittenToPty {
                    input_baseline_output_sequence: Some(0),
                }),
            }),
            resize_receipt: None,
        }
        .encode_to_vec(),
    );

    let decoded = decode_record(&encoded).expect("binary input receipts must decode");
    let reencoded = encode_record(42, &decoded.record).expect("binary input receipts must encode");
    let future = FutureReceiptRecord::decode(&reencoded[20..]).unwrap();
    let future_receipt = future.input_receipt.unwrap();
    assert_eq!(future_receipt.in_reply_to_record_id, 17);
    assert_eq!(
        future_receipt
            .written_to_pty
            .unwrap()
            .input_baseline_output_sequence,
        Some(0),
    );
}

#[test]
fn input_receipt_baseline_is_optional_and_bounded_by_its_record_high_water() {
    let receipt_record = |input_baseline_output_sequence, through_output_seq| TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: "terminal-input-baseline".into(),
        through_output_seq,
        state_revision: 1,
        body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
            in_reply_to_record_id: 17,
            outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                input_baseline_output_sequence,
                agent_runtime_revision: None,
            })),
        })),
    };

    validate_record(&receipt_record(None, 0)).expect("older Host receipt remains valid");
    validate_record(&receipt_record(Some(0), 0)).expect("zero baseline is present and valid");
    validate_record(&receipt_record(Some(u64::MAX), u64::MAX))
        .expect("baseline equal to the outer high-water is valid");
    assert!(matches!(
        validate_record(&receipt_record(Some(2), 1)),
        Err(terminal_state_protocol::ProtocolError::InvalidRecord(
            "input receipt write baseline exceeds its output high-water"
        ))
    ));
}

#[test]
fn agent_prompt_receipt_requires_one_complete_nonzero_host_proof() {
    let receipt = |input_baseline_output_sequence, agent_runtime_revision| InputReceipt {
        in_reply_to_record_id: 17,
        outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
            input_baseline_output_sequence,
            agent_runtime_revision,
        })),
    };

    assert!(validate_input_receipt(&receipt(Some(0), Some(1))).is_ok());
    assert!(validate_input_receipt(&receipt(None, Some(1))).is_err());
    assert!(validate_input_receipt(&receipt(Some(0), Some(0))).is_err());
}

#[test]
fn resize_receipt_carries_the_applied_geometry_without_a_controller_generation() {
    let encoded = envelope(
        RESIZE_RECEIPT_KIND,
        FutureReceiptRecord {
            schema_minor: 4,
            terminal_epoch: "terminal-receipt-red".into(),
            through_output_seq: 9,
            state_revision: 7,
            input_receipt: None,
            resize_receipt: Some(FutureResizeReceipt {
                in_reply_to_record_id: 18,
                applied_to_terminal: Some(FutureResizeAppliedToTerminal {
                    columns: 132,
                    rows: 43,
                }),
            }),
        }
        .encode_to_vec(),
    );

    let decoded = decode_record(&encoded).expect("binary resize receipts must decode");
    let reencoded = encode_record(43, &decoded.record).expect("binary resize receipts must encode");
    let future = FutureReceiptRecord::decode(&reencoded[20..]).unwrap();
    let applied = future.resize_receipt.unwrap().applied_to_terminal.unwrap();
    assert_eq!((applied.columns, applied.rows), (132, 43));
}

#[test]
fn wheel_receipt_names_exactly_one_final_sink_and_intent_sequence() {
    for outcome in [
        wheel_receipt::Outcome::WrittenToPty(WheelWrittenToPty {
            applied_intent_seq: 3,
        }),
        wheel_receipt::Outcome::AppliedToViewport(WheelAppliedToViewport {
            applied_intent_seq: 3,
        }),
    ] {
        let receipt = WheelReceipt {
            in_reply_to_record_id: 19,
            outcome: Some(outcome),
        };
        validate_wheel_receipt(&receipt).unwrap();
        let encoded = encode_record_for_minor(
            5,
            44,
            &TerminalStateRecord {
                schema_minor: 5,
                terminal_epoch: "terminal-wheel-receipt".into(),
                through_output_seq: 9,
                state_revision: 7,
                body: Some(terminal_state_record::Body::WheelReceipt(receipt)),
            },
        )
        .unwrap();
        let decoded = decode_record(&encoded).unwrap();
        let Some(terminal_state_record::Body::WheelReceipt(receipt)) = decoded.record.body else {
            panic!("wheel receipt did not preserve its typed outcome");
        };
        assert_eq!(receipt.in_reply_to_record_id, 19);
        assert!(matches!(
            receipt.outcome,
            Some(
                wheel_receipt::Outcome::WrittenToPty(WheelWrittenToPty {
                    applied_intent_seq: 3,
                }) | wheel_receipt::Outcome::AppliedToViewport(WheelAppliedToViewport {
                    applied_intent_seq: 3,
                })
            )
        ));
    }
}

#[test]
fn receipts_reject_missing_correlation_non_final_states_and_invalid_geometry() {
    assert!(
        validate_input_receipt(&InputReceipt {
            in_reply_to_record_id: 0,
            outcome: Some(input_receipt::Outcome::WrittenToPty(
                terminal_state_protocol::InputWrittenToPty::default(),
            )),
        })
        .is_err()
    );
    assert!(
        validate_input_receipt(&InputReceipt {
            in_reply_to_record_id: 1,
            outcome: None,
        })
        .is_err()
    );
    assert!(
        validate_input_receipt(&InputReceipt {
            in_reply_to_record_id: 1,
            outcome: Some(input_receipt::Outcome::Failed(InputFailed {
                reason: InputFailureReason::Unspecified as i32,
                detail: None,
            })),
        })
        .is_err()
    );
    assert!(
        validate_resize_receipt(&ResizeReceipt {
            in_reply_to_record_id: 1,
            outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
                ResizeAppliedToTerminal {
                    columns: 0,
                    rows: 24,
                },
            )),
        })
        .is_err()
    );
}

#[test]
fn semantic_text_is_utf8_and_key_modifiers_are_bounded_before_transport() {
    assert!(
        validate_input_intent(&InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: vec![0xff],
            })),
        })
        .is_err()
    );
    assert!(
        validate_input_intent(&InputIntent {
            intent: Some(input_intent::Intent::Key(KeyInputIntent {
                key: "Enter".into(),
                code: "Enter".into(),
                modifiers: 1 << 12,
                repeat: false,
            })),
        })
        .is_err()
    );
}

#[test]
fn fresh_agent_prompt_admission_wait_is_bounded_before_transport() {
    let prompt = |admission_wait_ms, target| InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: b"ship it".to_vec(),
            admission_wait_ms,
            target: Some(target),
        })),
    };

    for target in [
        agent_prompt_input_intent::Target::FreshAgent(FreshAgentPromptTarget {}),
        agent_prompt_input_intent::Target::ProcessObservedFreshAgent(
            ProcessObservedFreshAgentPromptTarget {},
        ),
    ] {
        validate_input_intent(&prompt(10_000, target.clone())).unwrap();
        assert!(validate_input_intent(&prompt(10_001, target)).is_err());
    }
}

#[test]
fn fresh_agent_prompt_is_explicit_and_legacy_remains_decodable() {
    let current = AgentPromptInputIntent {
        utf8: b"ship it".to_vec(),
        admission_wait_ms: 0,
        target: Some(agent_prompt_input_intent::Target::FreshAgent(
            FreshAgentPromptTarget {},
        )),
    };
    let legacy = LegacyAgentPromptInputIntent::decode(current.encode_to_vec().as_slice())
        .expect("an old Host ignores the additive target field");
    assert_eq!(legacy.utf8, current.utf8);
    assert_eq!(legacy.admission_wait_ms, current.admission_wait_ms);
    let process_observed = AgentPromptInputIntent {
        target: Some(
            agent_prompt_input_intent::Target::ProcessObservedFreshAgent(
                ProcessObservedFreshAgentPromptTarget {},
            ),
        ),
        ..current.clone()
    };
    let legacy = LegacyAgentPromptInputIntent::decode(process_observed.encode_to_vec().as_slice())
        .expect("an old Host ignores the additive process-observed target field");
    assert_eq!(legacy.utf8, process_observed.utf8);
    assert_eq!(legacy.admission_wait_ms, process_observed.admission_wait_ms);
    validate_input_intent(&InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: b"ship it".to_vec(),
            admission_wait_ms: 0,
            target: None,
        })),
    })
    .expect("the legacy capability boundary owns target-less normalization");
}

#[test]
fn existing_conversation_prompt_requires_an_exact_non_waiting_target() {
    let prompt = |admission_wait_ms, provider: &str, conversation: &str| InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: b"continue".to_vec(),
            admission_wait_ms,
            target: Some(agent_prompt_input_intent::Target::ExistingConversation(
                ExistingConversationPromptTarget {
                    expected_provider_id: provider.into(),
                    expected_conversation_id: conversation.into(),
                },
            )),
        })),
    };

    validate_input_intent(&prompt(0, "codex", "conversation-1")).unwrap();
    validate_input_intent(&prompt(0, &"p".repeat(256), "conversation-1")).unwrap();
    assert!(validate_input_intent(&prompt(0, &"p".repeat(257), "conversation-1")).is_err());
    assert!(validate_input_intent(&prompt(1, "codex", "conversation-1")).is_err());
    assert!(validate_input_intent(&prompt(0, "", "conversation-1")).is_err());
    assert!(validate_input_intent(&prompt(0, "codex", "")).is_err());
}
