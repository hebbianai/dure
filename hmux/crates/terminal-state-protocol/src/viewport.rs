use super::{
    CursorShape, MAX_EVENT_TEXT_BYTES, MAX_PAGE_ROWS, MAX_STATE_REVISION, MAX_URI_BYTES,
    ProtocolError, TerminalColorOverrides, TerminalStateRecord, ViewportAnchorStatus,
    ViewportFrame, ViewportIntent, WheelFailureReason, WheelReceipt, WheelRefusalReason,
    terminal_state_record, validate_buffer_id, validate_geometry, validate_input_modes,
    validate_rows, validate_tables, validate_text, validate_unicode_width, viewport_intent,
    wheel_receipt,
};

pub fn validate_viewport_frame(
    schema_minor: u32,
    frame: &ViewportFrame,
) -> Result<(), ProtocolError> {
    if frame.projection_revision == 0 || frame.projection_revision > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "viewport projection revision is invalid",
        ));
    }
    if frame.damage_base_projection_revision >= frame.projection_revision
        && frame.damage_base_projection_revision != 0
    {
        return Err(ProtocolError::InvalidRecord(
            "viewport damage base must precede its projection revision",
        ));
    }
    if frame.applied_intent_seq > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "viewport applied intent sequence is invalid",
        ));
    }
    let anchor_status = ViewportAnchorStatus::try_from(frame.anchor_status)
        .map_err(|_| ProtocolError::InvalidRecord("viewport anchor status is invalid"))?;
    if anchor_status == ViewportAnchorStatus::Unspecified {
        return Err(ProtocolError::InvalidRecord(
            "viewport anchor status is required",
        ));
    }
    validate_geometry(frame.canonical_columns, frame.viewport_rows)?;
    validate_buffer_id(frame.active_buffer)?;
    if frame.rows.is_empty() || frame.rows.len() > frame.viewport_rows as usize {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame row count is outside its requested height",
        ));
    }
    let tables = frame.tables.as_ref().ok_or(ProtocolError::InvalidRecord(
        "viewport frame-local tables are required",
    ))?;
    validate_tables(tables)?;
    validate_rows(
        &frame.rows,
        frame.canonical_columns as usize,
        Some(tables),
        schema_minor,
    )?;
    if let Some(cursor) = frame.cursor.as_ref() {
        if cursor.row as usize >= frame.rows.len()
            || cursor.column >= frame.canonical_columns
            || cursor.style_index as usize >= tables.styles.len()
            || CursorShape::try_from(cursor.shape).is_err()
            || cursor.shape == CursorShape::Unspecified as i32
        {
            return Err(ProtocolError::InvalidRecord(
                "viewport-relative cursor is invalid",
            ));
        }
    }
    validate_input_modes(
        frame
            .input_modes
            .as_ref()
            .ok_or(ProtocolError::InvalidRecord(
                "viewport input modes are required",
            ))?,
    )?;
    validate_color_overrides(frame.color_overrides.as_ref().ok_or(
        ProtocolError::InvalidRecord("viewport terminal color overrides are required"),
    )?)?;
    validate_unicode_width(
        frame
            .unicode_width
            .as_ref()
            .ok_or(ProtocolError::InvalidRecord(
                "viewport Unicode width profile is required",
            ))?,
    )?;
    validate_text(
        &frame.title,
        0,
        MAX_EVENT_TEXT_BYTES,
        "viewport title is oversized",
    )?;
    validate_text(
        &frame.working_directory_uri,
        0,
        MAX_URI_BYTES,
        "viewport working directory URI is oversized",
    )?;
    if frame.follow_tail && frame.has_more_after {
        return Err(ProtocolError::InvalidRecord(
            "follow-tail viewport cannot have rows after it",
        ));
    }
    if frame
        .input_output_timing
        .as_ref()
        .is_some_and(|timing| timing.input_record_id == 0)
    {
        return Err(ProtocolError::InvalidRecord(
            "viewport input/output timing record ID is missing",
        ));
    }
    if frame
        .input_output_timing
        .as_ref()
        .is_some_and(|timing| timing.first_output_sequence <= timing.input_baseline_output_sequence)
    {
        return Err(ProtocolError::InvalidRecord(
            "viewport input/output timing sequences are invalid",
        ));
    }
    let valid_status = if frame.follow_tail {
        matches!(
            anchor_status,
            ViewportAnchorStatus::FollowTail
                | ViewportAnchorStatus::ClampedStart
                | ViewportAnchorStatus::ClampedTail
                | ViewportAnchorStatus::PrunedToTail
        )
    } else {
        matches!(
            anchor_status,
            ViewportAnchorStatus::Anchored | ViewportAnchorStatus::ClampedStart
        )
    };
    if !valid_status
        || (frame.follow_tail && frame.rows_from_tail != Some(0))
        || (!frame.follow_tail && frame.rows_from_tail == Some(0))
    {
        return Err(ProtocolError::InvalidRecord(
            "viewport anchor outcome and tail position disagree",
        ));
    }
    let mut previous = None;
    for index in &frame.changed_row_indices {
        if *index as usize >= frame.rows.len() || previous.is_some_and(|value| value >= *index) {
            return Err(ProtocolError::InvalidRecord(
                "viewport changed rows are invalid or unordered",
            ));
        }
        previous = Some(*index);
    }
    Ok(())
}

fn validate_color_overrides(overrides: &TerminalColorOverrides) -> Result<(), ProtocolError> {
    for rgb in [
        overrides.default_foreground_rgb,
        overrides.default_background_rgb,
        overrides.cursor_rgb,
    ]
    .into_iter()
    .flatten()
    {
        if rgb > 0x00ff_ffff {
            return Err(ProtocolError::InvalidRecord(
                "viewport terminal color override is invalid",
            ));
        }
    }
    let mut previous = None;
    for entry in &overrides.indexed {
        if entry.index > u32::from(u8::MAX)
            || entry.rgb > 0x00ff_ffff
            || previous.is_some_and(|index| index >= entry.index)
        {
            return Err(ProtocolError::InvalidRecord(
                "viewport indexed color overrides are invalid or unordered",
            ));
        }
        previous = Some(entry.index);
    }
    Ok(())
}

pub fn validate_viewport_intent(intent: &ViewportIntent) -> Result<(), ProtocolError> {
    validate_viewport_intent_for_minor(super::PROTOCOL_MINOR.into(), intent)
}

pub(crate) fn validate_viewport_intent_for_minor(
    schema_minor: u32,
    intent: &ViewportIntent,
) -> Result<(), ProtocolError> {
    if intent.intent_seq == 0 || intent.intent_seq > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "viewport intent sequence is invalid",
        ));
    }
    match intent.intent.as_ref() {
        Some(viewport_intent::Intent::ScrollRows(scroll)) => {
            if intent.observed_projection_revision == 0
                || scroll.rows == 0
                || scroll.rows.unsigned_abs() as usize > MAX_PAGE_ROWS
            {
                return Err(ProtocolError::InvalidRecord(
                    "viewport scroll distance or revision is invalid",
                ));
            }
            Ok(())
        }
        Some(viewport_intent::Intent::FollowTail(_)) => {
            if intent.observed_projection_revision == 0 {
                return Err(ProtocolError::InvalidRecord(
                    "follow-tail requires an observed projection revision",
                ));
            }
            Ok(())
        }
        Some(viewport_intent::Intent::SetViewportRows(rows)) => {
            validate_geometry(1, rows.rows)?;
            Ok(())
        }
        Some(viewport_intent::Intent::Wheel(wheel)) => {
            if schema_minor < 5 {
                return Err(ProtocolError::InvalidRecord(
                    "wheel intent requires schema minor 5",
                ));
            }
            if intent.observed_projection_revision == 0 {
                return Err(ProtocolError::InvalidRecord(
                    "wheel requires an observed projection revision",
                ));
            }
            super::interaction::validate_pointer_input(wheel)?;
            if wheel.kind != super::PointerKind::Wheel as i32 {
                return Err(ProtocolError::InvalidRecord(
                    "wheel viewport intent requires a wheel pointer",
                ));
            }
            Ok(())
        }
        Some(viewport_intent::Intent::TerminalDefaultColors(colors)) => {
            if schema_minor < 6 {
                return Err(ProtocolError::InvalidRecord(
                    "terminal default colors require schema minor 6",
                ));
            }
            if intent.observed_projection_revision == 0
                || colors.foreground_rgb > 0x00ff_ffff
                || colors.background_rgb > 0x00ff_ffff
            {
                return Err(ProtocolError::InvalidRecord(
                    "terminal default colors or observed revision are invalid",
                ));
            }
            Ok(())
        }
        None => Err(ProtocolError::InvalidRecord(
            "typed viewport intent is required",
        )),
    }
}

pub fn validate_wheel_receipt(receipt: &WheelReceipt) -> Result<(), ProtocolError> {
    if receipt.in_reply_to_record_id == 0 {
        return Err(ProtocolError::InvalidRecord(
            "wheel receipt correlation id must be nonzero",
        ));
    }
    let applied_seq = match receipt.outcome.as_ref() {
        Some(wheel_receipt::Outcome::WrittenToPty(outcome)) => outcome.applied_intent_seq,
        Some(wheel_receipt::Outcome::AppliedToViewport(outcome)) => outcome.applied_intent_seq,
        Some(wheel_receipt::Outcome::Refused(refused)) => {
            let reason = WheelRefusalReason::try_from(refused.reason)
                .map_err(|_| ProtocolError::InvalidRecord("wheel refusal reason is invalid"))?;
            if reason == WheelRefusalReason::Unspecified {
                return Err(ProtocolError::InvalidRecord(
                    "wheel refusal reason is invalid",
                ));
            }
            return Ok(());
        }
        Some(wheel_receipt::Outcome::Failed(failed)) => {
            let reason = WheelFailureReason::try_from(failed.reason)
                .map_err(|_| ProtocolError::InvalidRecord("wheel failure reason is invalid"))?;
            if reason == WheelFailureReason::Unspecified {
                return Err(ProtocolError::InvalidRecord(
                    "wheel failure reason is invalid",
                ));
            }
            return Ok(());
        }
        None => {
            return Err(ProtocolError::InvalidRecord(
                "wheel receipt final outcome is required",
            ));
        }
    };
    if applied_seq == 0 || applied_seq > super::MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "wheel receipt intent sequence is invalid",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub struct ViewportIngressAuthority<'a> {
    pub terminal_epoch: &'a str,
    pub projection_revision: u64,
    pub applied_intent_seq: u64,
}

pub fn validate_viewport_ingress(
    record: &TerminalStateRecord,
    authority: &ViewportIngressAuthority<'_>,
) -> Result<(), ProtocolError> {
    super::validate_record(record)?;
    if record.terminal_epoch != authority.terminal_epoch {
        return Err(ProtocolError::InvalidRecord(
            "viewport terminal epoch is not current",
        ));
    }
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = record.body.as_ref() else {
        return Err(ProtocolError::InvalidRecord(
            "viewport ingress requires a viewport intent record",
        ));
    };
    if intent.observed_projection_revision > authority.projection_revision {
        return Err(ProtocolError::InvalidRecord(
            "viewport projection revision is ahead of Host authority",
        ));
    }
    if intent.intent_seq != authority.applied_intent_seq.saturating_add(1) {
        return Err(ProtocolError::InvalidRecord(
            "viewport intent sequence is stale or has a gap",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        FollowTail, PointerInputIntent, PointerKind, SetViewportRows, TerminalDefaultColors,
        viewport_intent,
    };

    #[test]
    fn initial_row_configuration_is_the_only_zero_revision_intent() {
        validate_viewport_intent(&ViewportIntent {
            observed_projection_revision: 0,
            intent_seq: 1,
            intent: Some(viewport_intent::Intent::SetViewportRows(SetViewportRows {
                rows: 24,
            })),
        })
        .unwrap();

        assert!(
            validate_viewport_intent(&ViewportIntent {
                observed_projection_revision: 0,
                intent_seq: 1,
                intent: Some(viewport_intent::Intent::FollowTail(FollowTail {})),
            })
            .is_err()
        );
    }

    #[test]
    fn ordered_relative_intents_survive_an_intervening_complete_frame() {
        let record = TerminalStateRecord {
            schema_minor: u32::from(crate::PROTOCOL_MINOR),
            terminal_epoch: "terminal-a".to_string(),
            through_output_seq: 3,
            state_revision: 2,
            body: Some(terminal_state_record::Body::ViewportIntent(
                ViewportIntent {
                    observed_projection_revision: 1,
                    intent_seq: 2,
                    intent: Some(viewport_intent::Intent::ScrollRows(crate::ScrollRows {
                        rows: 3,
                    })),
                },
            )),
        };

        validate_viewport_ingress(
            &record,
            &ViewportIngressAuthority {
                terminal_epoch: "terminal-a",
                projection_revision: 2,
                applied_intent_seq: 1,
            },
        )
        .unwrap();
    }

    #[test]
    fn wheel_requires_the_additive_minor_and_a_presented_projection() {
        let intent = ViewportIntent {
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
        };

        assert!(validate_viewport_intent_for_minor(4, &intent).is_err());
        validate_viewport_intent_for_minor(5, &intent).unwrap();
        assert!(
            validate_viewport_intent_for_minor(
                5,
                &ViewportIntent {
                    observed_projection_revision: 0,
                    ..intent
                },
            )
            .is_err()
        );
    }

    #[test]
    fn terminal_default_colors_require_minor_six_presented_projection_and_srgb() {
        let intent = ViewportIntent {
            observed_projection_revision: 2,
            intent_seq: 1,
            intent: Some(viewport_intent::Intent::TerminalDefaultColors(
                TerminalDefaultColors {
                    foreground_rgb: 0x12_34_56,
                    background_rgb: 0x65_43_21,
                },
            )),
        };

        assert!(validate_viewport_intent_for_minor(5, &intent).is_err());
        validate_viewport_intent_for_minor(6, &intent).unwrap();
        assert!(
            validate_viewport_intent_for_minor(
                6,
                &ViewportIntent {
                    observed_projection_revision: 0,
                    ..intent
                },
            )
            .is_err()
        );
        let Some(viewport_intent::Intent::TerminalDefaultColors(mut colors)) = intent.intent else {
            unreachable!()
        };
        colors.background_rgb = 0x0100_0000;
        assert!(
            validate_viewport_intent_for_minor(
                6,
                &ViewportIntent {
                    observed_projection_revision: 2,
                    intent_seq: 1,
                    intent: Some(viewport_intent::Intent::TerminalDefaultColors(colors)),
                },
            )
            .is_err()
        );
    }
}
