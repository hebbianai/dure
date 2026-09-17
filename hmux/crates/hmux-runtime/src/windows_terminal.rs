use hmux_host::local_protocol::{
    PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY, AgentPromptCapabilitySelection,
    OperationReceiptReason, SessionFence, TerminalDefaultColors,
};
use hmux_host::session_host::SessionHost;
use hmux_host::terminal_replay::{ViewProjection, WheelIntentRoute, WheelPtySink};
use hmux_runtime_contract::{
    TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BASE_PROTOCOL_MINOR,
    TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, selected_terminal_base_protocol_minor,
    terminal_default_colors_permitted, terminal_viewport_multipart_permitted,
    terminal_viewport_wheel_permitted,
};
use terminal_state_protocol::{
    InputRefusalReason, ResizeAppliedToTerminal, ResizeFailed, ResizeFailureReason, ResizeReceipt,
    ResizeRefusalReason, ResizeRefused, TerminalStateRecord, WheelAppliedToViewport, WheelFailed,
    WheelFailureReason, WheelReceipt, WheelRefusalReason, WheelRefused, WheelWrittenToPty,
    resize_receipt, terminal_state_record, viewport_intent, wheel_receipt,
};

use crate::structured_upstream::{IngressPermissions, StructuredUpstream, decode_upstream};
use crate::windows_terminal_encoding::{
    StructuredRecordEncodingError, prepare_structured_record,
};
use crate::Result;

pub(crate) struct WindowsTerminalSurface {
    projection: ViewProjection,
    base_protocol_minor: u8,
    viewport_multipart: bool,
    input: bool,
    wheel: bool,
    default_colors: bool,
    agent_prompt: Option<AgentPromptCapabilitySelection>,
    process_observed_agent_prompt: bool,
}

impl WindowsTerminalSurface {
    pub(crate) fn attach(
        host: &mut SessionHost,
        fence: &SessionFence,
        selected_capabilities: &[String],
        agent_prompt: Option<AgentPromptCapabilitySelection>,
    ) -> Result<(Self, Vec<Vec<u8>>)> {
        let base_protocol_minor =
            selected_terminal_base_protocol_minor(selected_capabilities)
                .unwrap_or(TERMINAL_STATE_BASE_PROTOCOL_MINOR);
        let viewport_multipart =
            terminal_viewport_multipart_permitted(selected_capabilities);
        let input = selected_capabilities
            .iter()
            .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY);
        let wheel = terminal_viewport_wheel_permitted(selected_capabilities);
        let default_colors = terminal_default_colors_permitted(selected_capabilities);
        let process_observed_agent_prompt = selected_capabilities
            .iter()
            .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
        let projection = host.attach_view_projection(fence)?;
        let mut surface = Self {
            projection,
            base_protocol_minor,
            viewport_multipart,
            input,
            wheel,
            default_colors,
            agent_prompt,
            process_observed_agent_prompt,
        };
        let records = surface
            .capture(host, fence)?
            .ok_or("terminal viewport attach did not produce an initial frame")?;
        Ok((surface, records))
    }

    pub(crate) fn capture(
        &mut self,
        host: &mut SessionHost,
        fence: &SessionFence,
    ) -> Result<Option<Vec<Vec<u8>>>> {
        let Some(frame) = host.capture_latest_viewport_frame(fence, &mut self.projection)? else {
            return Ok(None);
        };
        let record = frame.finish()?;
        Ok(Some(prepare_records(
            record,
            self.base_protocol_minor,
            self.viewport_multipart,
        )?))
    }

    pub(crate) fn detach(
        &mut self,
        host: &mut SessionHost,
        fence: &SessionFence,
    ) -> Result<()> {
        host.detach_view_projection(fence, &mut self.projection)?;
        Ok(())
    }

    pub(crate) fn set_viewport_rows(
        &mut self,
        host: &mut SessionHost,
        fence: &SessionFence,
        rows: u16,
    ) -> Result<bool> {
        Ok(host.set_view_projection_rows(fence, &mut self.projection, rows)?)
    }

    pub(crate) fn apply_viewport(
        &mut self,
        host: &mut SessionHost,
        fence: &SessionFence,
        record: &terminal_state_protocol::DecodedRecord,
    ) -> Result<hmux_host::terminal_replay::ViewportIntentApplication> {
        Ok(host.route_viewport_intent(
            fence,
            &mut self.projection,
            record,
            if self.input {
                WheelPtySink::Connected
            } else {
                WheelPtySink::Absent
            },
        )?)
    }

    pub(crate) fn decode_upstream(
        &self,
        payload: &[u8],
        host_provider_id: &str,
    ) -> Result<StructuredUpstream> {
        decode_upstream(
            payload,
            IngressPermissions {
                viewport: true,
                input: self.input,
                agent_prompt: self.agent_prompt,
                process_observed_agent_prompt: self.process_observed_agent_prompt,
                wheel: self.wheel,
                default_colors: self.default_colors,
                base_protocol_minor: self.base_protocol_minor,
                host_provider_id,
            },
        )
    }

    pub(crate) fn prepare_record(
        &self,
        record: TerminalStateRecord,
    ) -> Result<Vec<Vec<u8>>> {
        prepare_records(
            record,
            self.base_protocol_minor,
            self.viewport_multipart,
        )
    }
}

fn prepare_records(
    record: TerminalStateRecord,
    base_protocol_minor: u8,
    viewport_multipart: bool,
) -> Result<Vec<Vec<u8>>> {
    prepare_structured_record(record, base_protocol_minor, viewport_multipart).map_err(|error| {
        let detail = encoding_failure_detail(&error);
        format!("structured terminal record encoding failed: {detail}").into()
    })
}

fn encoding_failure_detail(error: &StructuredRecordEncodingError) -> String {
    if let Some((actual, maximum)) = error.viewport_multipart_bounds() {
        return format!(
            "complete viewport requires {TERMINAL_VIEWPORT_MULTIPART_CAPABILITY} capability ({actual} encoded bytes, single-record maximum {maximum})"
        );
    }
    if let Some((actual, maximum)) = error.resource_limit_bounds() {
        return format!("complete viewport requires {actual} encoded bytes, maximum is {maximum}");
    }
    error.to_string()
}

pub(crate) fn terminal_record(
    host: &SessionHost,
    fence: &SessionFence,
    body: terminal_state_record::Body,
) -> TerminalStateRecord {
    TerminalStateRecord {
        schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
        terminal_epoch: fence.terminal_epoch.clone(),
        through_output_seq: host.current_output_seq(),
        state_revision: host.current_terminal_state_revision(),
        body: Some(body),
    }
}

pub(crate) fn input_written(
    record_id: u64,
    input_baseline_output_sequence: u64,
    agent_runtime_revision: Option<u64>,
) -> terminal_state_record::Body {
    terminal_state_record::Body::InputReceipt(crate::input_receipt::written(
        record_id,
        input_baseline_output_sequence,
        agent_runtime_revision,
    ))
}

pub(crate) fn input_refused(
    record_id: u64,
    reason: InputRefusalReason,
) -> terminal_state_record::Body {
    terminal_state_record::Body::InputReceipt(crate::input_receipt::refused(
        record_id, reason, None,
    ))
}

pub(crate) fn input_not_written(
    record_id: u64,
    reason: OperationReceiptReason,
    detail: Option<String>,
) -> terminal_state_record::Body {
    terminal_state_record::Body::InputReceipt(crate::input_receipt::not_written(
        record_id, reason, detail,
    ))
}

pub(crate) fn input_failed(
    record_id: u64,
    reason: OperationReceiptReason,
    detail: Option<String>,
) -> terminal_state_record::Body {
    terminal_state_record::Body::InputReceipt(crate::input_receipt::failed(
        record_id, reason, detail,
    ))
}

pub(crate) fn resize_applied(
    record_id: u64,
    rows: u16,
    columns: u16,
) -> terminal_state_record::Body {
    terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
            ResizeAppliedToTerminal {
                columns: u32::from(columns),
                rows: u32::from(rows),
            },
        )),
    })
}

pub(crate) fn resize_refused(
    record_id: u64,
    reason: ResizeRefusalReason,
) -> terminal_state_record::Body {
    terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(resize_receipt::Outcome::Refused(ResizeRefused {
            reason: reason as i32,
        })),
    })
}

pub(crate) fn resize_failed(
    record_id: u64,
    reason: ResizeFailureReason,
) -> terminal_state_record::Body {
    terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(resize_receipt::Outcome::Failed(ResizeFailed {
            reason: reason as i32,
        })),
    })
}

pub(crate) fn wheel_receipt(
    record_id: u64,
    intent_seq: u64,
    route: WheelIntentRoute,
    pty_written: bool,
) -> terminal_state_record::Body {
    let outcome = match route {
        WheelIntentRoute::Viewport => {
            wheel_receipt::Outcome::AppliedToViewport(WheelAppliedToViewport {
                applied_intent_seq: intent_seq,
            })
        }
        WheelIntentRoute::Pty if pty_written => {
            wheel_receipt::Outcome::WrittenToPty(WheelWrittenToPty {
                applied_intent_seq: intent_seq,
            })
        }
        WheelIntentRoute::Pty => wheel_receipt::Outcome::Failed(WheelFailed {
            reason: WheelFailureReason::PtyWriteFailed as i32,
        }),
    };
    terminal_state_record::Body::WheelReceipt(WheelReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(outcome),
    })
}

pub(crate) fn wheel_refused(record_id: u64) -> terminal_state_record::Body {
    terminal_state_record::Body::WheelReceipt(WheelReceipt {
        in_reply_to_record_id: record_id,
        outcome: Some(wheel_receipt::Outcome::Refused(WheelRefused {
            reason: WheelRefusalReason::HostExiting as i32,
        })),
    })
}

pub(crate) fn terminal_default_colors(
    record: &terminal_state_protocol::DecodedRecord,
) -> Result<Option<TerminalDefaultColors>> {
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = record.record.body.as_ref()
    else {
        return Ok(None);
    };
    let Some(viewport_intent::Intent::TerminalDefaultColors(colors)) = intent.intent.as_ref()
    else {
        return Ok(None);
    };
    Ok(Some(TerminalDefaultColors::new(
        colors.foreground_rgb,
        colors.background_rgb,
    )?))
}

pub(crate) fn wheel_intent_seq(
    record: &terminal_state_protocol::DecodedRecord,
) -> Option<u64> {
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = record.record.body.as_ref()
    else {
        return None;
    };
    matches!(intent.intent, Some(viewport_intent::Intent::Wheel(_))).then_some(intent.intent_seq)
}
