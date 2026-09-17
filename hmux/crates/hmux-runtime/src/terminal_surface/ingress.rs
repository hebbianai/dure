#[cfg(test)]
use hmux_host::local_protocol::AgentPromptCapabilitySelection;
use hmux_host::local_protocol::OperationReceiptReason;
use hmux_host::terminal_replay::WheelIntentRoute;
use terminal_state_protocol::{
    InputIngressAuthority, InputRefusalReason, ResizeAppliedToTerminal, ResizeFailed,
    ResizeFailureReason, ResizeReceipt, ResizeRefusalReason, ResizeRefused, TerminalStateRecord,
    WheelAppliedToViewport, WheelFailed, WheelFailureReason, WheelReceipt, WheelRefusalReason,
    WheelRefused, WheelWrittenToPty, input_intent, resize_receipt, terminal_state_record,
    validate_input_ingress, viewport_intent, wheel_receipt,
};

use crate::controller_input_effect::ControllerInputEffect;
use crate::input_receipt;
use crate::input_transaction::InputTransactionOutcome;
use crate::pty_input::{InputAdmission, InputTimingCorrelation, PtyInput, apply_pty_input};
pub(crate) use crate::structured_upstream::{
    IngressPermissions, StructuredUpstream, decode_upstream,
};

use super::super::{Result, ServerState, lock};
use super::TerminalSurfaceProposalError;

pub(crate) fn apply_input(
    state: &ServerState,
    client_id: u64,
    record_id: u64,
    record: &TerminalStateRecord,
    admission: InputAdmission,
) -> Result<TerminalStateRecord> {
    // The connection-local record sequence fences resize order. Terminal output
    // revisions are independent and must never invalidate a surface proposal.
    let current_geometry_generation = record_id;
    let authority = InputIngressAuthority {
        terminal_epoch: &state.fence.terminal_epoch,
        geometry_generation: current_geometry_generation,
    };
    if record.terminal_epoch != authority.terminal_epoch {
        return receipt_record(
            state,
            terminal_state_record::Body::InputReceipt(input_receipt::refused(
                record_id,
                InputRefusalReason::StaleTerminalEpoch,
                None,
            )),
        );
    }
    let Some(terminal_state_record::Body::InputIntent(intent)) = record.body.as_ref() else {
        return Err("structured input record lost its typed intent".into());
    };
    if let Some(input_intent::Intent::Resize(resize)) = intent.intent.as_ref() {
        if resize.geometry_generation != current_geometry_generation {
            return receipt_record(
                state,
                terminal_state_record::Body::ResizeReceipt(resize_refused(
                    record_id,
                    ResizeRefusalReason::StaleGeometryGeneration,
                )),
            );
        }
    }
    validate_input_ingress(record, &authority)?;

    if let Some(input_intent::Intent::Resize(resize)) = intent.intent.as_ref() {
        let rows = u16::try_from(resize.rows)
            .map_err(|_| "structured resize rows do not fit the terminal actor")?;
        let columns = u16::try_from(resize.columns)
            .map_err(|_| "structured resize columns do not fit the terminal actor")?;
        let outcome = state.propose_terminal_surface(
            client_id,
            rows,
            columns,
            Some(current_geometry_generation),
            Some(record_id.to_string()),
        );
        let receipt = match outcome {
            Ok(applied) => ResizeReceipt {
                in_reply_to_record_id: record_id,
                outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
                    ResizeAppliedToTerminal {
                        columns: u32::from(applied.columns),
                        rows: u32::from(applied.rows),
                    },
                )),
            },
            Err(TerminalSurfaceProposalError::StaleGeometryGeneration) => {
                resize_refused(record_id, ResizeRefusalReason::StaleGeometryGeneration)
            }
            Err(TerminalSurfaceProposalError::Operation(reason)) => {
                resize_receipt_for_error(record_id, reason)
            }
        };
        return receipt_record(state, terminal_state_record::Body::ResizeReceipt(receipt));
    }

    let input_effect = intent
        .intent
        .as_ref()
        .and_then(ControllerInputEffect::from_non_resize_structured)
        .ok_or("structured PTY input lost its non-resize semantic effect")?;
    let application = apply_pty_input(
        state,
        PtyInput::Structured(intent),
        input_effect,
        admission,
        None,
        Some(InputTimingCorrelation {
            client_id,
            record_id,
        }),
    )?;
    let receipt = match application.outcome {
        InputTransactionOutcome::Written => input_receipt::written(
            record_id,
            application
                .input_baseline_output_sequence
                .expect("successful structured input must carry its Host output high-water"),
            application.admitted_agent_runtime_revision,
        ),
        InputTransactionOutcome::NotWritten(reason) => {
            input_receipt::not_written(record_id, reason, application.detail)
        }
        InputTransactionOutcome::Failed(reason) => {
            input_receipt::failed(record_id, reason, application.detail)
        }
    };
    receipt_record(state, terminal_state_record::Body::InputReceipt(receipt))
}

pub(crate) fn apply_viewport(
    state: &ServerState,
    client_id: u64,
    ingress: &terminal_state_protocol::DecodedRecord,
) -> Result<Option<TerminalStateRecord>> {
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = ingress.record.body.as_ref()
    else {
        return Err("structured viewport record lost its typed intent".into());
    };
    let wheel = matches!(intent.intent, Some(viewport_intent::Intent::Wheel(_)));
    let application = state.apply_terminal_viewport_intent(
        client_id,
        ingress,
        wheel.then(|| ingress.metadata.record_id.to_string()),
    )?;
    if !wheel {
        return Ok(None);
    }

    let outcome = match application.wheel_route {
        Some(WheelIntentRoute::Viewport) => {
            wheel_receipt::Outcome::AppliedToViewport(WheelAppliedToViewport {
                applied_intent_seq: intent.intent_seq,
            })
        }
        Some(WheelIntentRoute::Pty) => {
            let applied = apply_pty_input(
                state,
                PtyInput::Bytes(&application.pty_bytes),
                ControllerInputEffect::ControlOnly,
                InputAdmission::Ordinary,
                None,
                None,
            )?;
            match applied.outcome {
                InputTransactionOutcome::Written => {
                    wheel_receipt::Outcome::WrittenToPty(WheelWrittenToPty {
                        applied_intent_seq: intent.intent_seq,
                    })
                }
                InputTransactionOutcome::NotWritten(OperationReceiptReason::HostExiting) => {
                    wheel_receipt::Outcome::Refused(WheelRefused {
                        reason: WheelRefusalReason::HostExiting as i32,
                    })
                }
                InputTransactionOutcome::NotWritten(
                    OperationReceiptReason::AuthorizationDenied
                    | OperationReceiptReason::ControllerConflict
                    | OperationReceiptReason::StaleControllerGeneration,
                ) => wheel_receipt::Outcome::Refused(WheelRefused {
                    reason: WheelRefusalReason::AuthorizationDenied as i32,
                }),
                InputTransactionOutcome::NotWritten(_) | InputTransactionOutcome::Failed(_) => {
                    wheel_receipt::Outcome::Failed(WheelFailed {
                        reason: WheelFailureReason::PtyWriteFailed as i32,
                    })
                }
            }
        }
        None => return Err("wheel route did not select a terminal sink".into()),
    };
    receipt_record(
        state,
        terminal_state_record::Body::WheelReceipt(WheelReceipt {
            in_reply_to_record_id: ingress.metadata.record_id,
            outcome: Some(outcome),
        }),
    )
    .map(Some)
}

fn receipt_record(
    state: &ServerState,
    body: terminal_state_record::Body,
) -> Result<TerminalStateRecord> {
    let host = lock(&state.host)?;
    Ok(TerminalStateRecord {
        schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
        terminal_epoch: state.fence.terminal_epoch.clone(),
        through_output_seq: host.current_output_seq(),
        state_revision: host.current_terminal_state_revision(),
        body: Some(body),
    })
}

fn resize_refused(record_id: u64, reason: ResizeRefusalReason) -> ResizeReceipt {
    ResizeReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(resize_receipt::Outcome::Refused(ResizeRefused {
            reason: reason as i32,
        })),
    }
}

fn resize_receipt_for_error(record_id: u64, reason: OperationReceiptReason) -> ResizeReceipt {
    match reason {
        OperationReceiptReason::HostExiting => {
            resize_refused(record_id, ResizeRefusalReason::HostExiting)
        }
        OperationReceiptReason::AuthorizationDenied
        | OperationReceiptReason::ControllerConflict
        | OperationReceiptReason::StaleControllerGeneration => {
            resize_refused(record_id, ResizeRefusalReason::AuthorizationDenied)
        }
        OperationReceiptReason::InvalidTerminalDimensions => {
            resize_refused(record_id, ResizeRefusalReason::InvalidTerminalDimensions)
        }
        OperationReceiptReason::ResourceLimit => {
            resize_refused(record_id, ResizeRefusalReason::ResourceLimit)
        }
        _ => ResizeReceipt {
            in_reply_to_record_id: record_id,
            outcome: Some(resize_receipt::Outcome::Failed(ResizeFailed {
                reason: match reason {
                    OperationReceiptReason::HostExiting => ResizeFailureReason::HostExiting,
                    OperationReceiptReason::ResourceLimit => ResizeFailureReason::ResourceLimit,
                    _ => ResizeFailureReason::PlatformResizeFailed,
                } as i32,
            })),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_state_protocol::{
        AgentPromptInputIntent, ExistingConversationPromptTarget, InputIntent, PointerInputIntent,
        PointerKind, ViewportIntent, agent_prompt_input_intent, encode_record_for_minor,
    };

    fn wheel_envelope() -> Vec<u8> {
        let minor = hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor;
        encode_record_for_minor(
            minor,
            7,
            &TerminalStateRecord {
                schema_minor: u32::from(minor),
                terminal_epoch: "terminal-a".into(),
                through_output_seq: 3,
                state_revision: 4,
                body: Some(terminal_state_record::Body::ViewportIntent(
                    ViewportIntent {
                        observed_projection_revision: 2,
                        intent_seq: 1,
                        intent: Some(viewport_intent::Intent::Wheel(PointerInputIntent {
                            kind: PointerKind::Wheel as i32,
                            column: 1,
                            row: 1,
                            wheel_delta_y: -3,
                            pixel_x: 15,
                            pixel_y: 25,
                            surface_width: 100,
                            surface_height: 100,
                            cell_width: 10,
                            cell_height: 20,
                            ..PointerInputIntent::default()
                        })),
                    },
                )),
            },
        )
        .unwrap()
    }

    fn default_colors_envelope() -> Vec<u8> {
        let minor = hmux_runtime_contract::TERMINAL_DEFAULT_COLORS_PROTOCOL_VERSION.envelope_minor;
        encode_record_for_minor(
            minor,
            8,
            &TerminalStateRecord {
                schema_minor: u32::from(minor),
                terminal_epoch: "terminal-a".into(),
                through_output_seq: 3,
                state_revision: 4,
                body: Some(terminal_state_record::Body::ViewportIntent(
                    ViewportIntent {
                        observed_projection_revision: 2,
                        intent_seq: 1,
                        intent: Some(viewport_intent::Intent::TerminalDefaultColors(
                            terminal_state_protocol::TerminalDefaultColors {
                                foreground_rgb: 0x12_34_56,
                                background_rgb: 0x65_43_21,
                            },
                        )),
                    },
                )),
            },
        )
        .unwrap()
    }

    fn agent_prompt_envelope(target: Option<agent_prompt_input_intent::Target>) -> Vec<u8> {
        let minor = hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR;
        encode_record_for_minor(
            minor,
            9,
            &TerminalStateRecord {
                schema_minor: u32::from(minor),
                terminal_epoch: "terminal-a".into(),
                through_output_seq: 3,
                state_revision: 4,
                body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                    intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
                        utf8: b"continue".to_vec(),
                        admission_wait_ms: 0,
                        target,
                    })),
                })),
            },
        )
        .unwrap()
    }

    fn permissions(wheel: bool) -> IngressPermissions<'static> {
        IngressPermissions {
            viewport: true,
            input: true,
            agent_prompt: Some(AgentPromptCapabilitySelection::Targeted),
            process_observed_agent_prompt: true,
            wheel,
            default_colors: false,
            base_protocol_minor: hmux_runtime_contract::TERMINAL_STATE_BASE_PROTOCOL_MINOR,
            host_provider_id: "codex",
        }
    }

    #[test]
    fn targetless_prompt_requires_only_the_legacy_fresh_lane() {
        let refused = decode_upstream(&agent_prompt_envelope(None), permissions(false)).unwrap();
        assert!(matches!(
            refused,
            StructuredUpstream::Unauthorized(
                hmux_host::local_protocol::LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY
            )
        ));

        let mut legacy = permissions(false);
        legacy.agent_prompt = Some(AgentPromptCapabilitySelection::LegacyFresh);
        let StructuredUpstream::Input { admission, .. } =
            decode_upstream(&agent_prompt_envelope(None), legacy).unwrap()
        else {
            panic!("legacy lane must admit targetless fresh input")
        };
        assert!(matches!(
            admission.agent_prompt(),
            Some((hmux_host::terminal_replay::AgentPromptTarget::FreshAgent, _))
        ));
    }

    #[test]
    fn existing_conversation_never_downgrades_to_the_legacy_lane() {
        let target = Some(agent_prompt_input_intent::Target::ExistingConversation(
            ExistingConversationPromptTarget {
                expected_provider_id: "codex".into(),
                expected_conversation_id: "conversation-1".into(),
            },
        ));
        let mut legacy = permissions(false);
        legacy.agent_prompt = Some(AgentPromptCapabilitySelection::LegacyFresh);

        let StructuredUpstream::Input { admission, .. } =
            decode_upstream(&agent_prompt_envelope(target.clone()), permissions(false)).unwrap()
        else {
            panic!("targeted lane must admit an exact existing conversation")
        };
        assert!(matches!(
            admission.agent_prompt(),
            Some((
                hmux_host::terminal_replay::AgentPromptTarget::ExistingConversation {
                    expected_provider_id,
                    expected_conversation_id,
                },
                _,
            )) if expected_provider_id == "codex"
                && expected_conversation_id == "conversation-1"
        ));

        assert!(matches!(
            decode_upstream(&agent_prompt_envelope(target), legacy).unwrap(),
            StructuredUpstream::Unauthorized(hmux_host::local_protocol::AGENT_PROMPT_CAPABILITY)
        ));
    }

    #[test]
    fn wheel_capability_refusal_precedes_minor_rejection() {
        let decoded = decode_upstream(&wheel_envelope(), permissions(false)).unwrap();

        let StructuredUpstream::Unauthorized(capability) = decoded else {
            panic!("unselected wheel capability must return a typed refusal");
        };
        assert_eq!(
            capability,
            hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        );
    }

    #[test]
    fn selected_wheel_capability_accepts_the_exact_additive_minor() {
        let decoded = decode_upstream(&wheel_envelope(), permissions(true)).unwrap();

        let StructuredUpstream::ViewportIntent { record } = decoded else {
            panic!("selected wheel capability must preserve the viewport ingress");
        };
        assert_eq!(record.metadata.protocol_minor, 5);
        assert_eq!(record.record.schema_minor, 5);
        assert_eq!(record.metadata.record_id, 7);
    }

    #[test]
    fn default_colors_require_their_capability_and_exact_additive_minor() {
        let refused = decode_upstream(&default_colors_envelope(), permissions(false)).unwrap();
        assert!(matches!(
            refused,
            StructuredUpstream::Unauthorized(
                hmux_runtime_contract::TERMINAL_DEFAULT_COLORS_CAPABILITY
            )
        ));

        let mut selected = permissions(false);
        selected.default_colors = true;
        let decoded = decode_upstream(&default_colors_envelope(), selected).unwrap();
        let StructuredUpstream::ViewportIntent { record } = decoded else {
            panic!("selected default color capability must preserve viewport ingress");
        };
        assert_eq!(record.metadata.protocol_minor, 6);
        assert_eq!(record.record.schema_minor, 6);
        assert_eq!(record.metadata.record_id, 8);
    }

    #[test]
    fn resize_preparation_reasons_keep_retryable_and_terminal_outcomes_distinct() {
        let retryable = resize_receipt_for_error(7, OperationReceiptReason::ResourceLimit);
        assert!(matches!(
            retryable.outcome,
            Some(resize_receipt::Outcome::Refused(ResizeRefused { reason }))
                if reason == ResizeRefusalReason::ResourceLimit as i32
        ));

        let terminal = resize_receipt_for_error(8, OperationReceiptReason::PlatformResizeFailed);
        assert!(matches!(
            terminal.outcome,
            Some(resize_receipt::Outcome::Failed(ResizeFailed { reason }))
                if reason == ResizeFailureReason::PlatformResizeFailed as i32
        ));
    }
}
