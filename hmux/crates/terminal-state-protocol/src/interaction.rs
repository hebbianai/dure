use super::{
    ClipboardFormat, InputFailureReason, InputIntent, InputReceipt, InputRefusalReason,
    MAX_COLUMNS, MAX_EVENT_TEXT_BYTES, MAX_GRID_ROWS, MAX_INPUT_BYTES, MarkerKind, PointerKind,
    ProtocolError, ResizeFailureReason, ResizeReceipt, ResizeRefusalReason, TerminalEvent,
    TerminalStateRecord, encode_record_for_minor, input_intent, input_receipt, resize_receipt,
    terminal_event, terminal_state_record, validate_bytes, validate_geometry, validate_record,
    validate_text,
};

pub const MAX_AGENT_PROMPT_ADMISSION_WAIT_MS: u32 = 10_000;

pub(crate) fn validate_event(event: &TerminalEvent) -> Result<(), ProtocolError> {
    if event.event_id == 0 {
        return Err(ProtocolError::InvalidRecord("event id must be nonzero"));
    }
    match event.event.as_ref() {
        Some(terminal_event::Event::Bell(_)) => Ok(()),
        Some(terminal_event::Event::ClipboardWriteRequest(value)) => {
            if ClipboardFormat::try_from(value.format).is_err()
                || value.format == ClipboardFormat::Unspecified as i32
            {
                return Err(ProtocolError::InvalidRecord("clipboard format is invalid"));
            }
            validate_bytes(
                &value.content,
                0,
                MAX_INPUT_BYTES,
                "clipboard content is oversized",
            )
        }
        Some(terminal_event::Event::Notification(value)) => {
            validate_text(
                &value.title,
                0,
                MAX_EVENT_TEXT_BYTES,
                "notification title is oversized",
            )?;
            validate_text(
                &value.body,
                0,
                MAX_EVENT_TEXT_BYTES,
                "notification body is oversized",
            )
        }
        Some(terminal_event::Event::ExecutionMarker(value)) => {
            validate_text(&value.marker_id, 1, 128, "marker id is empty or oversized")?;
            if MarkerKind::try_from(value.kind).is_err()
                || value.kind == MarkerKind::Unspecified as i32
            {
                return Err(ProtocolError::InvalidRecord("marker kind is invalid"));
            }
            validate_text(
                &value.label,
                0,
                MAX_EVENT_TEXT_BYTES,
                "marker label is oversized",
            )
        }
        None => Err(ProtocolError::InvalidRecord(
            "typed terminal event is required",
        )),
    }
}

pub fn validate_input_intent(intent: &InputIntent) -> Result<(), ProtocolError> {
    match intent.intent.as_ref() {
        Some(input_intent::Intent::Text(value)) => {
            validate_bytes(
                &value.utf8,
                1,
                MAX_INPUT_BYTES,
                "text input is empty or oversized",
            )?;
            validate_utf8(&value.utf8, "text input is not UTF-8")
        }
        Some(input_intent::Intent::AgentPrompt(value)) => {
            validate_bytes(
                &value.utf8,
                1,
                MAX_INPUT_BYTES - 1,
                "agent prompt is empty or oversized",
            )?;
            validate_utf8(&value.utf8, "agent prompt is not UTF-8")?;
            if value.admission_wait_ms > MAX_AGENT_PROMPT_ADMISSION_WAIT_MS {
                return Err(ProtocolError::InvalidRecord(
                    "agent prompt admission wait is oversized",
                ));
            }
            match value.target.as_ref() {
                Some(
                    super::agent_prompt_input_intent::Target::FreshAgent(_)
                    | super::agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_),
                ) => Ok(()),
                Some(super::agent_prompt_input_intent::Target::ExistingConversation(target)) => {
                    if value.admission_wait_ms != 0 {
                        return Err(ProtocolError::InvalidRecord(
                            "existing conversation prompt cannot wait before admission",
                        ));
                    }
                    validate_text(
                        &target.expected_provider_id,
                        1,
                        256,
                        "agent prompt provider id is empty or oversized",
                    )?;
                    validate_text(
                        &target.expected_conversation_id,
                        1,
                        256,
                        "agent prompt conversation id is empty or oversized",
                    )
                }
                // Tag 16 originally carried a fresh-only prompt without a
                // target. Keep that wire record structurally decodable; the
                // capability-scoped Host ingress either normalizes it to the
                // legacy fresh target or rejects it before PTY admission.
                None => Ok(()),
            }
        }
        Some(input_intent::Intent::Key(value)) => {
            validate_text(&value.key, 1, 128, "key is empty or oversized")?;
            validate_text(&value.code, 0, 128, "key code is oversized")?;
            if value.modifiers & !0x3f != 0 {
                return Err(ProtocolError::InvalidRecord(
                    "key modifiers contain unsupported bits",
                ));
            }
            Ok(())
        }
        Some(input_intent::Intent::Paste(value)) => {
            validate_bytes(&value.utf8, 0, MAX_INPUT_BYTES, "paste input is oversized")?;
            validate_utf8(&value.utf8, "paste input is not UTF-8")
        }
        Some(input_intent::Intent::Pointer(value)) => validate_pointer_input(value),
        Some(input_intent::Intent::Focus(_)) => Ok(()),
        Some(input_intent::Intent::Resize(value)) => {
            validate_geometry(value.columns, value.rows)?;
            if value.geometry_generation == 0 {
                return Err(ProtocolError::InvalidRecord(
                    "resize geometry generation must be nonzero",
                ));
            }
            Ok(())
        }
        None => Err(ProtocolError::InvalidRecord(
            "typed input intent is required",
        )),
    }
}

pub(crate) fn validate_pointer_input(
    value: &super::PointerInputIntent,
) -> Result<(), ProtocolError> {
    if PointerKind::try_from(value.kind).is_err() || value.kind == PointerKind::Unspecified as i32 {
        return Err(ProtocolError::InvalidRecord("pointer kind is invalid"));
    }
    if value.column as usize >= MAX_COLUMNS || value.row as usize >= MAX_GRID_ROWS {
        return Err(ProtocolError::InvalidRecord(
            "pointer position exceeds grid cap",
        ));
    }
    if value.button > 4 || value.modifiers & !0x0f != 0 || value.pressed_buttons & !0x1f != 0 {
        return Err(ProtocolError::InvalidRecord(
            "pointer button or modifiers are invalid",
        ));
    }
    let kind = PointerKind::try_from(value.kind)
        .map_err(|_| ProtocolError::InvalidRecord("pointer kind is invalid"))?;
    if kind == PointerKind::Wheel {
        if (value.wheel_delta_x == 0 && value.wheel_delta_y == 0)
            || value.wheel_delta_x.unsigned_abs() > 64
            || value.wheel_delta_y.unsigned_abs() > 64
        {
            return Err(ProtocolError::InvalidRecord(
                "pointer wheel delta is empty or oversized",
            ));
        }
    } else if value.wheel_delta_x != 0 || value.wheel_delta_y != 0 {
        return Err(ProtocolError::InvalidRecord(
            "non-wheel pointer intent carries wheel delta",
        ));
    }
    validate_pointer_geometry(value)
}

fn validate_utf8(value: &[u8], message: &'static str) -> Result<(), ProtocolError> {
    std::str::from_utf8(value)
        .map(|_| ())
        .map_err(|_| ProtocolError::InvalidRecord(message))
}

pub fn validate_input_receipt(receipt: &InputReceipt) -> Result<(), ProtocolError> {
    if receipt.in_reply_to_record_id == 0 {
        return Err(ProtocolError::InvalidRecord(
            "input receipt correlation id must be nonzero",
        ));
    }
    match receipt.outcome.as_ref() {
        Some(input_receipt::Outcome::WrittenToPty(written)) => {
            if written.agent_runtime_revision == Some(0) {
                return Err(ProtocolError::InvalidRecord(
                    "agent runtime revision must be nonzero",
                ));
            }
            if written.agent_runtime_revision.is_some()
                && written.input_baseline_output_sequence.is_none()
            {
                return Err(ProtocolError::InvalidRecord(
                    "agent runtime revision requires an input baseline",
                ));
            }
            Ok(())
        }
        Some(input_receipt::Outcome::Refused(refused)) => validate_required_enum(
            InputRefusalReason::try_from(refused.reason).ok(),
            InputRefusalReason::Unspecified,
            "input refusal reason is invalid",
        ),
        Some(input_receipt::Outcome::Failed(failed)) => validate_required_enum(
            InputFailureReason::try_from(failed.reason).ok(),
            InputFailureReason::Unspecified,
            "input failure reason is invalid",
        ),
        None => Err(ProtocolError::InvalidRecord(
            "input receipt final outcome is required",
        )),
    }
}

pub fn validate_resize_receipt(receipt: &ResizeReceipt) -> Result<(), ProtocolError> {
    if receipt.in_reply_to_record_id == 0 {
        return Err(ProtocolError::InvalidRecord(
            "resize receipt correlation id must be nonzero",
        ));
    }
    match receipt.outcome.as_ref() {
        Some(resize_receipt::Outcome::AppliedToTerminal(applied)) => {
            validate_geometry(applied.columns, applied.rows)
        }
        Some(resize_receipt::Outcome::Refused(refused)) => validate_required_enum(
            ResizeRefusalReason::try_from(refused.reason).ok(),
            ResizeRefusalReason::Unspecified,
            "resize refusal reason is invalid",
        ),
        Some(resize_receipt::Outcome::Failed(failed)) => validate_required_enum(
            ResizeFailureReason::try_from(failed.reason).ok(),
            ResizeFailureReason::Unspecified,
            "resize failure reason is invalid",
        ),
        None => Err(ProtocolError::InvalidRecord(
            "resize receipt final outcome is required",
        )),
    }
}

fn validate_required_enum<T: Eq>(
    value: Option<T>,
    unspecified: T,
    message: &'static str,
) -> Result<(), ProtocolError> {
    if value.is_none_or(|value| value == unspecified) {
        return Err(ProtocolError::InvalidRecord(message));
    }
    Ok(())
}

fn validate_pointer_geometry(value: &super::PointerInputIntent) -> Result<(), ProtocolError> {
    const MAX_SURFACE_PIXELS: u32 = 1_048_576;
    if value.surface_width == 0
        || value.surface_height == 0
        || value.surface_width > MAX_SURFACE_PIXELS
        || value.surface_height > MAX_SURFACE_PIXELS
        || value.cell_width == 0
        || value.cell_height == 0
        || value.cell_width > 65_535
        || value.cell_height > 65_535
    {
        return Err(ProtocolError::InvalidRecord(
            "pointer surface geometry is invalid",
        ));
    }
    let horizontal_padding = value
        .padding_left
        .checked_add(value.padding_right)
        .ok_or(ProtocolError::InvalidRecord("pointer padding overflows"))?;
    let vertical_padding = value
        .padding_top
        .checked_add(value.padding_bottom)
        .ok_or(ProtocolError::InvalidRecord("pointer padding overflows"))?;
    if horizontal_padding >= value.surface_width
        || vertical_padding >= value.surface_height
        || value.pixel_x < value.padding_left
        || value.pixel_y < value.padding_top
        || value.pixel_x >= value.surface_width - value.padding_right
        || value.pixel_y >= value.surface_height - value.padding_bottom
        || (value.pixel_x - value.padding_left) / value.cell_width != value.column
        || (value.pixel_y - value.padding_top) / value.cell_height != value.row
    {
        return Err(ProtocolError::InvalidRecord(
            "pointer pixel and cell positions disagree",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub struct InputIngressAuthority<'a> {
    pub terminal_epoch: &'a str,
    pub geometry_generation: u64,
}

/// Pure final-writer fence. Connection admission owns write permission;
/// terminal epoch prevents a stale pre-rehost connection from mutating its
/// successor. Resize additionally matches its connection-local record
/// generation; terminal output and state revision are intentionally unrelated.
pub fn validate_input_ingress(
    record: &TerminalStateRecord,
    authority: &InputIngressAuthority<'_>,
) -> Result<(), ProtocolError> {
    validate_record(record)?;
    if record.terminal_epoch != authority.terminal_epoch {
        return Err(ProtocolError::InvalidRecord(
            "input terminal epoch is not current",
        ));
    }
    let Some(terminal_state_record::Body::InputIntent(intent)) = record.body.as_ref() else {
        return Err(ProtocolError::InvalidRecord(
            "input ingress requires an input intent record",
        ));
    };
    if let Some(input_intent::Intent::Resize(resize)) = intent.intent.as_ref() {
        if resize.geometry_generation != authority.geometry_generation {
            return Err(ProtocolError::InvalidRecord(
                "resize geometry generation is not current",
            ));
        }
    }
    Ok(())
}

/// Performs the same authority check immediately at serialization. Future Host
/// integration must call this from its single serialized PTY writer boundary,
/// after terminal-epoch and geometry state has been read for that writer.
pub fn encode_input_at_writer(
    negotiated_minor: u8,
    record_id: u64,
    record: &TerminalStateRecord,
    authority: &InputIngressAuthority<'_>,
) -> Result<Vec<u8>, ProtocolError> {
    validate_input_ingress(record, authority)?;
    encode_record_for_minor(negotiated_minor, record_id, record)
}
