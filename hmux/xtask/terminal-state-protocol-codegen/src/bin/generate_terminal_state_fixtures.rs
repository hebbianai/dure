use std::env;
use std::fs;
use std::path::PathBuf;

use terminal_state_protocol::{
    BufferId, BufferState, CellStyle, ColorKind, CursorShape, CursorState, Grapheme, HistoryAnchor,
    Hyperlink, InputModes, MAX_PAYLOAD_BYTES, MouseEncoding, MouseTrackingMode, RowTermination,
    StateSnapshot, TerminalCell, TerminalColor, TerminalColorOverrides, TerminalMediaSupport,
    TerminalPalette, TerminalRow, TerminalStateRecord, TerminalTables, UnderlineKind,
    UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame, ViewportFrameBatch, decode_record,
    encode_record, encode_viewport_frame_parts, terminal_state_record,
};

const CURRENT_SCHEMA_MINOR: u8 = 4;
const CURRENT_THROUGH_OUTPUT_SEQ: u64 = 9_007_199_254_740_993;
const CURRENT_STATE_REVISION: u64 = u64::MAX - 1;
const CURRENT_RECORD_ID: u64 = u64::MAX;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let hmux_dir = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .ok_or("fixture xtask must remain directly below hmux/xtask")?;
    let protocol_dir = hmux_dir.join("crates/terminal-state-protocol");
    let out_dir = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| protocol_dir.join("fixtures"));
    fs::create_dir_all(&out_dir)?;

    fs::write(
        out_dir.join("terminal-state-current-v1.bin"),
        encode_record(CURRENT_RECORD_ID, &current_record())?,
    )?;

    let frame = viewport_frame();
    let probe = encode_viewport_frame_parts(ViewportFrameBatch {
        record_id_start: 41,
        schema_minor: 5,
        terminal_epoch: "epoch-viewport-parts",
        through_output_seq: 43,
        state_revision: 47,
        batch_id: b"viewport-fixture-batch",
        frame: &frame,
        max_chunk_bytes: MAX_PAYLOAD_BYTES - 1024,
    })?;
    let decoded = decode_record(&probe[0])?;
    let terminal_state_record::Body::ViewportFramePart(part) = decoded.record.body.unwrap() else {
        return Err("viewport fixture probe did not encode a part".into());
    };
    let parts = encode_viewport_frame_parts(ViewportFrameBatch {
        record_id_start: 41,
        schema_minor: 5,
        terminal_epoch: "epoch-viewport-parts",
        through_output_seq: 43,
        state_revision: 47,
        batch_id: b"viewport-fixture-batch",
        frame: &frame,
        max_chunk_bytes: (part.total_frame_bytes as usize).div_ceil(2),
    })?;
    if parts.len() != 2 {
        return Err("viewport fixture must remain exactly two parts".into());
    }
    for (index, encoded) in parts.iter().enumerate() {
        fs::write(
            out_dir.join(format!("terminal-viewport-frame-part-{index}-v1.bin")),
            encoded,
        )?;
    }

    Ok(())
}

fn current_record() -> TerminalStateRecord {
    TerminalStateRecord {
        schema_minor: u32::from(CURRENT_SCHEMA_MINOR),
        terminal_epoch: "epoch-current".into(),
        through_output_seq: CURRENT_THROUGH_OUTPUT_SEQ,
        state_revision: CURRENT_STATE_REVISION,
        body: Some(terminal_state_record::Body::Snapshot(Box::new(snapshot(
            BufferId::Alternate,
            true,
        )))),
    }
}

fn viewport_frame() -> ViewportFrame {
    let state = snapshot(BufferId::Normal, true);
    let normal = state.normal_buffer.as_ref().unwrap();
    ViewportFrame {
        projection_revision: 53,
        damage_base_projection_revision: 0,
        canonical_columns: state.columns,
        viewport_rows: state.rows,
        active_buffer: BufferId::Normal as i32,
        rows: normal.rows.clone(),
        tables: state.tables.clone(),
        cursor: normal.cursor,
        input_modes: state.input_modes,
        color_overrides: Some(TerminalColorOverrides::default()),
        unicode_width: state.unicode_width.clone(),
        through_event_id: state.through_event_id,
        title: state.title.clone(),
        working_directory_uri: state.working_directory_uri.clone(),
        follow_tail: true,
        has_more_before: true,
        has_more_after: false,
        changed_row_indices: Vec::new(),
        applied_intent_seq: 59,
        anchor_status: ViewportAnchorStatus::FollowTail as i32,
        rows_from_tail: Some(0),
        input_output_timing: None,
    }
}

fn snapshot(active_buffer: BufferId, current_fields: bool) -> StateSnapshot {
    let tables = TerminalTables {
        graphemes: vec![
            Grapheme {
                text: " ".into(),
                display_width: 1,
            },
            Grapheme {
                text: "A".into(),
                display_width: 1,
            },
            Grapheme {
                text: "계".into(),
                display_width: 2,
            },
        ],
        styles: vec![
            CellStyle {
                underline: UnderlineKind::None as i32,
                ..CellStyle::default()
            },
            CellStyle {
                foreground: Some(TerminalColor {
                    kind: ColorKind::Rgb as i32,
                    value: 0x12_34_56,
                }),
                flags: 1,
                underline: UnderlineKind::Single as i32,
                hyperlink_index: u32::from(current_fields),
                ..CellStyle::default()
            },
        ],
        hyperlinks: current_fields
            .then(|| Hyperlink {
                uri: "https://example.invalid/terminal".into(),
                params: "id=fixture".into(),
            })
            .into_iter()
            .collect(),
    };
    StateSnapshot {
        columns: 4,
        rows: 2,
        active_buffer: active_buffer as i32,
        normal_buffer: Some(buffer(
            vec![
                row(101, 1, 1, current_fields),
                row(102, 2, 1, current_fields),
            ],
            current_fields,
        )),
        alternate_buffer: Some(buffer(
            vec![
                row(201, 2, 1, current_fields),
                row(202, 0, 0, current_fields),
            ],
            current_fields,
        )),
        history: Some(HistoryAnchor {
            before_cursor: vec![0x10, 0x20],
            after_cursor: vec![0x30, 0x40],
            has_more_before: true,
            has_more_after: false,
        }),
        tables: Some(tables),
        history_truncated: current_fields,
        palette: current_fields.then(|| TerminalPalette {
            indexed_rgb: (0..256).map(|index| index * 0x01_01_01).collect(),
            default_foreground_rgb: 0xdd_dd_dd,
            default_background_rgb: 0x11_11_11,
            cursor_rgb: 0xee_ee_ee,
            selection_background_rgb: 0x33_44_55,
        }),
        title: current_fields
            .then_some("fixture title")
            .unwrap_or_default()
            .into(),
        input_modes: current_fields.then(|| InputModes {
            application_cursor_keys: true,
            bracketed_paste: true,
            mouse_tracking: MouseTrackingMode::Any as i32,
            mouse_encoding: MouseEncoding::Sgr as i32,
            auto_wrap: true,
            ..InputModes::default()
        }),
        unicode_width: current_fields.then(|| UnicodeWidthProfile {
            unicode_version: "15.1.0".into(),
            ambiguous_width: 1,
            emoji_width: 2,
        }),
        through_event_id: if current_fields { 7 } else { 0 },
        working_directory_uri: current_fields
            .then_some("file:///tmp/fixture")
            .unwrap_or_default()
            .into(),
        media_support: if current_fields {
            TerminalMediaSupport::Unsupported as i32
        } else {
            TerminalMediaSupport::Unspecified as i32
        },
    }
}

fn buffer(rows: Vec<TerminalRow>, current_fields: bool) -> BufferState {
    BufferState {
        rows,
        cursor: Some(CursorState {
            row: 0,
            column: 0,
            style_index: 0,
            visible: true,
            shape: CursorShape::Block as i32,
            blinking: false,
            wrap_pending: current_fields,
        }),
        scroll_top: 0,
        scroll_bottom: 1,
    }
}

fn row(row_id: u64, grapheme_index: u32, style_index: u32, current_fields: bool) -> TerminalRow {
    TerminalRow {
        row_id,
        continues_from_previous: false,
        cells: vec![TerminalCell {
            grapheme_index,
            style_index,
        }],
        termination: if current_fields {
            RowTermination::HardBreak as i32
        } else {
            RowTermination::None as i32
        },
        logical_line_id: row_id,
        logical_cell_offset: 0,
        logical_cell_span: if grapheme_index == 2 { 2 } else { 1 },
    }
}
