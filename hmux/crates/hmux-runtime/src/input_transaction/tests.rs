mod controller_input;

use super::*;
use hmux_host::local_protocol::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource, ProcessProof,
    ProviderConversationIdentitySource,
};
use hmux_host::terminal_replay::{
    AgentRuntimeObservation, AgentStateReportObservation, ProviderConversationIdentityObservation,
    TerminalReplayLimits,
};
#[cfg(unix)]
use std::io;
use terminal_state_protocol::{
    AgentPromptInputIntent, ExistingConversationPromptTarget, FreshAgentPromptTarget, InputIntent,
    ProcessObservedFreshAgentPromptTarget, agent_prompt_input_intent, input_intent,
};

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        runner_principal: "local-user".into(),
        runner_instance: "runner-1".into(),
        channel_epoch: 1,
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
    }
}

fn host(bracketed_paste: bool) -> SessionHost {
    let fence = fence();
    let mut host = SessionHost::new(
        fence.clone(),
        ProcessProof {
            process_id: 11,
            start_marker: "provider-start".into(),
        },
        24,
        80,
        TerminalReplayLimits::default(),
        2,
    )
    .unwrap();
    if bracketed_paste {
        host.ingest_output(&fence, b"\x1b[?2004h").unwrap();
    }
    host
}

fn ready_host(bracketed_paste: bool) -> SessionHost {
    let fence = fence();
    let mut host = host(bracketed_paste);
    host.observe_provider_conversation_identity(
        &fence,
        ProviderConversationIdentityObservation::new(
            "codex",
            "conversation-1",
            ProviderConversationIdentitySource::ProviderEvent,
        ),
    )
    .unwrap();
    host.observe_agent_runtime_state(
        &fence,
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();
    host
}

fn fresh_prompt(prompt: &[u8]) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: prompt.to_vec(),
            admission_wait_ms: 0,
            target: Some(agent_prompt_input_intent::Target::FreshAgent(
                FreshAgentPromptTarget {},
            )),
        })),
    }
}

fn existing_prompt(prompt: &[u8], conversation_id: &str) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: prompt.to_vec(),
            admission_wait_ms: 0,
            target: Some(agent_prompt_input_intent::Target::ExistingConversation(
                ExistingConversationPromptTarget {
                    expected_provider_id: "codex".into(),
                    expected_conversation_id: conversation_id.into(),
                },
            )),
        })),
    }
}

fn process_observed_fresh_prompt(prompt: &[u8]) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: prompt.to_vec(),
            admission_wait_ms: 25,
            target: Some(
                agent_prompt_input_intent::Target::ProcessObservedFreshAgent(
                    ProcessObservedFreshAgentPromptTarget {},
                ),
            ),
        })),
    }
}

fn legacy_fresh_prompt(prompt: &[u8]) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
            utf8: prompt.to_vec(),
            admission_wait_ms: 25,
            target: None,
        })),
    }
}

fn admission(input: &InputIntent) -> InputAdmission {
    InputAdmission::from_validated_structured(
        input.intent.as_ref().unwrap(),
        Some(AgentPromptCapabilitySelection::Targeted),
        true,
        "codex",
    )
    .unwrap()
}

#[test]
fn process_observed_target_binds_the_host_launch_provider() {
    let input = process_observed_fresh_prompt(b"ship it");
    let parsed = InputAdmission::from_validated_structured(
        input.intent.as_ref().unwrap(),
        Some(AgentPromptCapabilitySelection::Targeted),
        true,
        "claude",
    )
    .unwrap();

    assert!(matches!(
        parsed.agent_prompt(),
        Some((
            hmux_host::terminal_replay::AgentPromptTarget::ProcessObservedFreshAgent {
                expected_provider_id,
            },
            wait,
        )) if expected_provider_id == "claude" && wait == Duration::from_millis(25)
    ));
    assert_eq!(
        InputAdmission::from_validated_structured(
            input.intent.as_ref().unwrap(),
            Some(AgentPromptCapabilitySelection::LegacyFresh),
            true,
            "claude",
        ),
        Err(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY),
        "the new target never collapses into the legacy targetless lane"
    );
    assert_eq!(
        InputAdmission::from_validated_structured(
            input.intent.as_ref().unwrap(),
            Some(AgentPromptCapabilitySelection::Targeted),
            false,
            "claude",
        ),
        Err(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY),
        "the additive target requires its own negotiated wire capability"
    );
}

#[test]
fn targetless_prompt_normalizes_only_at_the_legacy_capability_boundary() {
    let input = legacy_fresh_prompt(b"ship it");
    let intent = input.intent.as_ref().unwrap();
    assert_eq!(
        InputAdmission::from_validated_structured(
            intent,
            Some(AgentPromptCapabilitySelection::Targeted),
            true,
            "codex",
        ),
        Err(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY)
    );
    let admission = InputAdmission::from_validated_structured(
        intent,
        Some(AgentPromptCapabilitySelection::LegacyFresh),
        false,
        "codex",
    )
    .unwrap();
    assert!(matches!(
        admission.agent_prompt(),
        Some((hmux_host::terminal_replay::AgentPromptTarget::FreshAgent, wait))
            if wait == Duration::from_millis(25)
    ));
}

#[test]
fn legacy_targetless_prompt_uses_the_same_host_atomic_fresh_transaction() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = legacy_fresh_prompt(b"ship it");
    let admission = InputAdmission::from_validated_structured(
        input.intent.as_ref().unwrap(),
        Some(AgentPromptCapabilitySelection::LegacyFresh),
        false,
        "codex",
    )
    .unwrap();
    let mut writes = Vec::new();

    let outcome = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission,
        |bytes| {
            writes.push(bytes.to_vec());
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();

    assert_eq!(outcome.outcome, InputTransactionOutcome::Written);
    assert_eq!(writes.len(), 1);
    assert!(writes[0].starts_with(b"ship it"));

    let repeated = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        InputAdmission::from_validated_structured(
            input.intent.as_ref().unwrap(),
            Some(AgentPromptCapabilitySelection::LegacyFresh),
            false,
            "codex",
        )
        .unwrap(),
        |bytes| {
            writes.push(bytes.to_vec());
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(
        repeated.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert_eq!(writes.len(), 1);
}

#[test]
fn repeated_initial_admission_invokes_one_compound_writer() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = fresh_prompt(b"ship it");
    let mut writes = Vec::new();

    let first = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            writes.push(bytes.to_vec());
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(first.outcome, InputTransactionOutcome::Written);
    assert!(first.admitted_agent_runtime_revision.is_some());
    assert_eq!(writes, [b"ship it\r".to_vec()]);

    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();
    let second = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            writes.push(bytes.to_vec());
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(
        second.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert_eq!(writes.len(), 1);
}

#[test]
fn existing_conversation_mismatch_refuses_before_the_writer() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = existing_prompt(b"wrong conversation", "conversation-2");
    let transaction = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |_| panic!("identity mismatch must be refused before the writer"),
    )
    .unwrap();
    assert_eq!(
        transaction.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
}

#[test]
fn zero_byte_fresh_prompt_failure_is_definite_and_retryable() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = fresh_prompt(b"ship it");
    let first = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            PtyWriteOutcome::from_progress(
                bytes.len(),
                0,
                Err(OperationReceiptReason::PtyWriteFailed),
            )
        },
    )
    .unwrap();
    assert_eq!(
        first.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::PtyWriteFailed)
    );
    assert_eq!(first.admitted_agent_runtime_revision, None);

    let mut retried = false;
    let second = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            retried = true;
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(second.outcome, InputTransactionOutcome::Written);
    assert!(retried);
}

#[test]
fn partial_fresh_prompt_failure_consumes_the_one_shot() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = fresh_prompt(b"ship it");
    let first = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            PtyWriteOutcome::from_progress(
                bytes.len(),
                2,
                Err(OperationReceiptReason::PtyWriteFailed),
            )
        },
    )
    .unwrap();
    assert_eq!(
        first.outcome,
        InputTransactionOutcome::Failed(OperationReceiptReason::PtyWriteFailed)
    );
    assert!(first.admitted_agent_runtime_revision.is_some());

    let second = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |_| panic!("a partial prompt must consume fresh authority"),
    )
    .unwrap();
    assert_eq!(
        second.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
}

#[test]
fn zero_byte_existing_prompt_failure_preserves_idle_state_for_retry() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = existing_prompt(b"continue", "conversation-1");
    let first = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            PtyWriteOutcome::from_progress(
                bytes.len(),
                0,
                Err(OperationReceiptReason::PtyWriteFailed),
            )
        },
    )
    .unwrap();
    assert_eq!(
        first.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::PtyWriteFailed)
    );
    assert_eq!(first.runtime_state, None);
    assert_eq!(first.admitted_agent_runtime_revision, None);

    let mut retried = false;
    let second = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&input),
        ControllerInputEffect::DraftCapable,
        admission(&input),
        |bytes| {
            retried = true;
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(second.outcome, InputTransactionOutcome::Written);
    assert!(retried);
}

#[test]
fn escape_then_provider_idle_preserves_only_a_real_draft() {
    for structured in [false, true] {
        for had_draft in [false, true] {
            let mut host = ready_host(false);
            let mut scanner = SubmitScanner::default();
            if had_draft {
                host.record_controller_input(&fence()).unwrap();
            }
            host.observe_agent_runtime_state(
                &fence(),
                AgentRuntimeObservation::working(AgentRuntimeStateSource::ProviderEvent),
            )
            .unwrap();
            let escape = InputIntent {
                intent: Some(input_intent::Intent::Key(
                    terminal_state_protocol::KeyInputIntent {
                        key: "Escape".into(),
                        code: "Escape".into(),
                        ..Default::default()
                    },
                )),
            };
            let effect = if structured {
                ControllerInputEffect::from_non_resize_structured(escape.intent.as_ref().unwrap())
                    .unwrap()
            } else {
                ControllerInputEffect::DraftCapable
            };
            let written = apply_input_transaction(
                &mut host,
                &fence(),
                &mut scanner,
                if structured {
                    PtyInput::Structured(&escape)
                } else {
                    PtyInput::Bytes(b"\x1b")
                },
                effect,
                InputAdmission::Ordinary,
                |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
            )
            .unwrap();
            assert_eq!(written.outcome, InputTransactionOutcome::Written);
            let idle = host
                .observe_agent_runtime_state(
                    &fence(),
                    AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
                )
                .unwrap()
                .unwrap();
            let stop_fence = hmux_host::local_protocol::ManagedProviderStopQuiescenceFence {
                terminal_epoch: idle.terminal_epoch,
                runtime_revision: idle.revision,
                observed_through_output_seq: idle.observed_through_output_seq,
            };
            assert_eq!(
                host.matches_agent_runtime_quiescence(&fence(), &stop_fence)
                    .unwrap(),
                !had_draft,
                "Escape must not create or erase a draft: structured={structured}, had_draft={had_draft}",
            );
        }
    }
}

#[test]
fn control_only_write_consumes_fresh_prompt_authority_without_a_draft() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let ordinary = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Bytes(b"\x1b[I"),
        ControllerInputEffect::ControlOnly,
        InputAdmission::Ordinary,
        |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
    )
    .unwrap();
    assert_eq!(ordinary.outcome, InputTransactionOutcome::Written);
    assert!(ordinary.runtime_state.is_none());

    let initial = fresh_prompt(b"must not write");
    let mut prompt_write_called = false;
    let delivered = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&initial),
        ControllerInputEffect::DraftCapable,
        admission(&initial),
        |bytes| {
            prompt_write_called = true;
            PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
        },
    )
    .unwrap();
    assert_eq!(
        delivered.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert!(!prompt_write_called);
}

#[test]
fn only_a_nonempty_failed_control_write_consumes_fresh_prompt_authority() {
    for bytes_written in [0, 1] {
        let mut host = ready_host(false);
        let mut scanner = SubmitScanner::default();
        let control = apply_input_transaction(
            &mut host,
            &fence(),
            &mut scanner,
            PtyInput::Bytes(b"\x1b[I"),
            ControllerInputEffect::ControlOnly,
            InputAdmission::Ordinary,
            |bytes| {
                PtyWriteOutcome::from_progress(
                    bytes.len(),
                    bytes_written,
                    Err(OperationReceiptReason::PtyWriteFailed),
                )
            },
        )
        .unwrap();
        assert_eq!(
            control.outcome,
            if bytes_written == 0 {
                InputTransactionOutcome::NotWritten(OperationReceiptReason::PtyWriteFailed)
            } else {
                InputTransactionOutcome::Failed(OperationReceiptReason::PtyWriteFailed)
            }
        );

        let initial = fresh_prompt(b"must not cross a damaged control sequence");
        let mut retried = false;
        let delivered = apply_input_transaction(
            &mut host,
            &fence(),
            &mut scanner,
            PtyInput::Structured(&initial),
            ControllerInputEffect::DraftCapable,
            admission(&initial),
            |bytes| {
                retried = true;
                PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
            },
        )
        .unwrap();
        if bytes_written == 0 {
            assert_eq!(delivered.outcome, InputTransactionOutcome::Written);
            assert!(retried);
        } else {
            assert_eq!(
                delivered.outcome,
                InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged,)
            );
            assert!(!retried);
        }
    }
}

#[test]
fn every_non_ready_initial_prompt_refuses_before_the_writer() {
    let input = fresh_prompt(b"must not write");
    let assert_refused = |mut host: SessionHost, expected_fence: SessionFence| {
        let mut scanner = SubmitScanner::default();
        let transaction = apply_input_transaction(
            &mut host,
            &expected_fence,
            &mut scanner,
            PtyInput::Structured(&input),
            ControllerInputEffect::DraftCapable,
            admission(&input),
            |_| panic!("Host refusal must precede the PTY writer"),
        );
        match transaction {
            Ok(transaction) => assert_eq!(
                transaction.outcome,
                InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged,)
            ),
            Err(failure) => assert!(!failure.may_have_written()),
        }
    };

    assert_refused(host(false), fence());

    let mut working = ready_host(false);
    working
        .observe_agent_runtime_state(
            &fence(),
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ProviderEvent),
        )
        .unwrap();
    assert_refused(working, fence());

    for attention in [
        AgentRuntimeAttention::InputRequired,
        AgentRuntimeAttention::ApprovalRequired,
        AgentRuntimeAttention::Error,
    ] {
        let mut host = ready_host(false);
        host.apply_agent_state_report(
            &fence(),
            AgentStateReportObservation {
                activity: AgentRuntimeActivity::Waiting,
                attention,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                expected_observation: None,
            },
        )
        .unwrap();
        assert_refused(host, fence());
    }

    let stale = SessionFence {
        terminal_epoch: "terminal-stale".into(),
        ..fence()
    };
    assert_refused(ready_host(false), stale);
}

#[test]
fn initial_prompt_encoding_is_one_terminal_mode_aware_payload() {
    for (bracketed_paste, expected) in [
        (false, &b"ship it\r"[..]),
        (true, &b"\x1b[200~ship it\x1b[201~\r"[..]),
    ] {
        let mut host = ready_host(bracketed_paste);
        let mut scanner = SubmitScanner::default();
        let input = fresh_prompt(b"ship it");
        let mut encoded = Vec::new();
        apply_input_transaction(
            &mut host,
            &fence(),
            &mut scanner,
            PtyInput::Structured(&input),
            ControllerInputEffect::DraftCapable,
            admission(&input),
            |bytes| {
                encoded.extend_from_slice(bytes);
                PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
            },
        )
        .unwrap();
        assert_eq!(encoded, expected);
    }
}

#[test]
fn inexact_success_is_not_representable_as_a_complete_write() {
    for reported in [2, 5] {
        let outcome = PtyWriteOutcome::from_progress(4, reported, Ok(()));

        assert_eq!(outcome.bytes_written, reported.min(4));
        assert_eq!(outcome.outcome, Err(OperationReceiptReason::PtyWriteFailed));
    }
}

#[cfg(unix)]
#[test]
fn partial_nonblocking_delivery_retains_exact_prefix_and_failure_certainty() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let mut input = PreparedInput::new(
        &mut host,
        &fence(),
        PtyInput::Bytes(b"status\r"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
    )
    .unwrap();
    let step = input
        .advance(&mut host, &fence(), &mut scanner, |bytes| {
            assert_eq!(bytes, b"status\r");
            PtyWriteOutcome::nonblocking(bytes.len(), Ok(1))
        })
        .unwrap();
    assert!(matches!(step, InputStep::Pending(_)));
    assert_eq!(input.bytes_written(), 1);
    assert_eq!(
        input.failure(OperationReceiptReason::HostExiting),
        InputTransactionOutcome::Failed(OperationReceiptReason::PtyWriteFailed)
    );
    let step = input
        .advance(&mut host, &fence(), &mut scanner, |bytes| {
            assert_eq!(bytes, b"tatus\r");
            PtyWriteOutcome::nonblocking(bytes.len(), Err(io::ErrorKind::WouldBlock.into()))
        })
        .unwrap();
    assert!(matches!(step, InputStep::Pending(_)));
    assert_eq!(input.bytes_written(), 1);
}

#[cfg(unix)]
#[test]
fn a_fresh_prompt_completes_once_across_write_chunks_and_output_mode_changes() {
    let mut host = ready_host(true);
    let mut scanner = SubmitScanner::default();
    let intent = fresh_prompt(b"ship it");
    let mut input = PreparedInput::new(
        &mut host,
        &fence(),
        PtyInput::Structured(&intent),
        ControllerInputEffect::DraftCapable,
        admission(&intent),
    )
    .unwrap();
    let mut written = Vec::new();
    let step = input
        .advance(&mut host, &fence(), &mut scanner, |bytes| {
            written.extend_from_slice(&bytes[..1]);
            PtyWriteOutcome::nonblocking(bytes.len(), Ok(1))
        })
        .unwrap();
    assert!(matches!(step, InputStep::Pending(_)));
    let admitted = input.admitted_revision();
    assert!(admitted.is_some());
    host.ingest_output(&fence(), b"\x1b[?2004l").unwrap();
    let step = input
        .advance(&mut host, &fence(), &mut scanner, |bytes| {
            written.extend_from_slice(bytes);
            PtyWriteOutcome::nonblocking(bytes.len(), Ok(bytes.len()))
        })
        .unwrap();
    let InputStep::Complete(transaction) = step else {
        panic!("input remained pending")
    };
    assert_eq!(transaction.outcome, InputTransactionOutcome::Written);
    assert_eq!(transaction.admitted_agent_runtime_revision, admitted);
    assert_eq!(written, b"\x1b[200~ship it\x1b[201~\r");
    let repeated = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&intent),
        ControllerInputEffect::DraftCapable,
        admission(&intent),
        |_| panic!("a consumed fresh prompt must not write twice"),
    )
    .unwrap();
    assert_eq!(
        repeated.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
}

#[cfg(unix)]
#[test]
fn zero_byte_wait_rechecks_prompt_authority_before_delivery() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let intent = fresh_prompt(b"ship it");
    let mut input = PreparedInput::new(
        &mut host,
        &fence(),
        PtyInput::Structured(&intent),
        ControllerInputEffect::DraftCapable,
        admission(&intent),
    )
    .unwrap();
    assert!(matches!(
        input
            .advance(&mut host, &fence(), &mut scanner, |bytes| {
                PtyWriteOutcome::nonblocking(bytes.len(), Err(io::ErrorKind::WouldBlock.into()))
            })
            .unwrap(),
        InputStep::Pending(_)
    ));
    host.record_controller_input(&fence()).unwrap();
    let InputStep::Complete(transaction) = input
        .advance(&mut host, &fence(), &mut scanner, |_| {
            panic!("changed prompt authority must reject before delivery")
        })
        .unwrap()
    else {
        panic!("refusal remained pending")
    };
    assert_eq!(
        transaction.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert_eq!(input.bytes_written(), 0);
}
