use prost::Message;
use terminal_state_protocol::{
    BufferId, CellStyle, CursorShape, CursorState, Grapheme, InputModes, MouseEncoding,
    MouseTrackingMode, RowTermination, TerminalCell, TerminalColorOverrides, TerminalRow,
    TerminalTables, UnderlineKind, UnicodeWidthProfile, decode_record, encode_record,
};

const VIEWPORT_FRAME_KIND: u8 = 8;
const VIEWPORT_INTENT_KIND: u8 = 9;

#[derive(Clone, PartialEq, Message)]
struct FutureViewportFrame {
    #[prost(uint64, tag = "1")]
    projection_revision: u64,
    #[prost(uint64, tag = "2")]
    damage_base_projection_revision: u64,
    #[prost(uint32, tag = "3")]
    canonical_columns: u32,
    #[prost(uint32, tag = "4")]
    viewport_rows: u32,
    #[prost(int32, tag = "5")]
    active_buffer: i32,
    #[prost(bytes = "vec", repeated, tag = "6")]
    rows: Vec<Vec<u8>>,
    #[prost(bytes = "vec", optional, tag = "7")]
    tables: Option<Vec<u8>>,
    #[prost(bytes = "vec", optional, tag = "8")]
    cursor: Option<Vec<u8>>,
    #[prost(bytes = "vec", optional, tag = "9")]
    input_modes: Option<Vec<u8>>,
    #[prost(bytes = "vec", optional, tag = "10")]
    color_overrides: Option<Vec<u8>>,
    #[prost(bytes = "vec", optional, tag = "11")]
    unicode_width: Option<Vec<u8>>,
    #[prost(uint64, tag = "12")]
    through_event_id: u64,
    #[prost(string, tag = "13")]
    title: String,
    #[prost(string, tag = "14")]
    working_directory_uri: String,
    #[prost(bool, tag = "15")]
    follow_tail: bool,
    #[prost(bool, tag = "16")]
    has_more_before: bool,
    #[prost(bool, tag = "17")]
    has_more_after: bool,
    #[prost(uint32, repeated, tag = "18")]
    changed_row_indices: Vec<u32>,
    #[prost(uint64, tag = "19")]
    applied_intent_seq: u64,
    #[prost(int32, tag = "20")]
    anchor_status: i32,
    #[prost(uint64, optional, tag = "21")]
    rows_from_tail: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureViewportIntent {
    #[prost(uint64, tag = "1")]
    observed_projection_revision: u64,
    #[prost(uint64, tag = "2")]
    intent_seq: u64,
    #[prost(message, optional, tag = "12")]
    set_viewport_rows: Option<FutureSetViewportRows>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureSetViewportRows {
    #[prost(uint32, tag = "1")]
    rows: u32,
}

#[derive(Clone, PartialEq, Message)]
struct FutureViewportFrameRecord {
    #[prost(uint32, tag = "1")]
    schema_minor: u32,
    #[prost(string, tag = "2")]
    terminal_epoch: String,
    #[prost(uint64, tag = "3")]
    through_output_seq: u64,
    #[prost(uint64, tag = "4")]
    state_revision: u64,
    #[prost(message, optional, tag = "17")]
    viewport_frame: Option<FutureViewportFrame>,
}

#[derive(Clone, PartialEq, Message)]
struct FutureViewportIntentRecord {
    #[prost(uint32, tag = "1")]
    schema_minor: u32,
    #[prost(string, tag = "2")]
    terminal_epoch: String,
    #[prost(uint64, tag = "3")]
    through_output_seq: u64,
    #[prost(uint64, tag = "4")]
    state_revision: u64,
    #[prost(message, optional, tag = "18")]
    viewport_intent: Option<FutureViewportIntent>,
}

fn envelope(kind: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(20 + payload.len());
    bytes.extend_from_slice(b"TSPB");
    bytes.push(1);
    bytes.push(3);
    bytes.push(kind);
    bytes.push(0);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&1_u64.to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes
}

fn complete_frame() -> FutureViewportFrame {
    let row = TerminalRow {
        row_id: 1,
        continues_from_previous: false,
        cells: vec![TerminalCell {
            grapheme_index: 0,
            style_index: 0,
        }],
        termination: RowTermination::HardBreak as i32,
        logical_line_id: 1,
        logical_cell_offset: 0,
        logical_cell_span: 1,
    };
    let tables = TerminalTables {
        graphemes: vec![Grapheme {
            text: "x".into(),
            display_width: 1,
        }],
        styles: vec![CellStyle {
            underline: UnderlineKind::None as i32,
            ..CellStyle::default()
        }],
        hyperlinks: Vec::new(),
    };
    let cursor = CursorState {
        row: 0,
        column: 0,
        style_index: 0,
        visible: true,
        shape: CursorShape::Block as i32,
        blinking: false,
        wrap_pending: false,
    };
    let modes = InputModes {
        mouse_tracking: MouseTrackingMode::None as i32,
        mouse_encoding: MouseEncoding::Default as i32,
        ..InputModes::default()
    };
    let color_overrides = TerminalColorOverrides::default();
    let unicode_width = UnicodeWidthProfile {
        unicode_version: "test".into(),
        ambiguous_width: 1,
        emoji_width: 2,
    };
    FutureViewportFrame {
        projection_revision: 1,
        damage_base_projection_revision: 0,
        canonical_columns: 2,
        viewport_rows: 1,
        active_buffer: BufferId::Normal as i32,
        rows: vec![row.encode_to_vec()],
        tables: Some(tables.encode_to_vec()),
        cursor: Some(cursor.encode_to_vec()),
        input_modes: Some(modes.encode_to_vec()),
        color_overrides: Some(color_overrides.encode_to_vec()),
        unicode_width: Some(unicode_width.encode_to_vec()),
        through_event_id: 0,
        title: String::new(),
        working_directory_uri: String::new(),
        follow_tail: true,
        has_more_before: false,
        has_more_after: false,
        changed_row_indices: Vec::new(),
        applied_intent_seq: 1,
        anchor_status: 1,
        rows_from_tail: Some(0),
    }
}

fn encoded_24_row_frame(rows_from_tail: u64) -> Vec<u8> {
    let mut frame = complete_frame();
    frame.viewport_rows = 24;
    frame.rows = (1..=24)
        .map(|row_id| {
            TerminalRow {
                row_id,
                continues_from_previous: false,
                cells: vec![TerminalCell {
                    grapheme_index: 0,
                    style_index: 0,
                }],
                termination: RowTermination::HardBreak as i32,
                logical_line_id: row_id,
                logical_cell_offset: 0,
                logical_cell_span: 1,
            }
            .encode_to_vec()
        })
        .collect();
    frame.follow_tail = false;
    frame.has_more_before = true;
    frame.has_more_after = true;
    frame.anchor_status = 2;
    frame.rows_from_tail = Some(rows_from_tail);
    let bytes = envelope(
        VIEWPORT_FRAME_KIND,
        FutureViewportFrameRecord {
            schema_minor: 3,
            terminal_epoch: "viewport-bounded".into(),
            through_output_seq: 4,
            state_revision: 7,
            viewport_frame: Some(frame),
        }
        .encode_to_vec(),
    );
    let decoded = decode_record(&bytes).unwrap();
    encode_record(2, &decoded.record).unwrap()
}

#[test]
fn complete_viewport_frame_is_a_first_class_record() {
    let bytes = envelope(
        VIEWPORT_FRAME_KIND,
        FutureViewportFrameRecord {
            schema_minor: 3,
            terminal_epoch: "viewport-red".into(),
            through_output_seq: 4,
            state_revision: 7,
            viewport_frame: Some(complete_frame()),
        }
        .encode_to_vec(),
    );

    decode_record(&bytes).expect("complete viewport frames must decode atomically");
}

#[test]
fn viewport_rows_are_connection_local_input_not_terminal_resize() {
    let bytes = envelope(
        VIEWPORT_INTENT_KIND,
        FutureViewportIntentRecord {
            schema_minor: 3,
            terminal_epoch: "viewport-red".into(),
            through_output_seq: 4,
            state_revision: 7,
            viewport_intent: Some(FutureViewportIntent {
                observed_projection_revision: 0,
                intent_seq: 1,
                set_viewport_rows: Some(FutureSetViewportRows { rows: 42 }),
            }),
        }
        .encode_to_vec(),
    );

    let decoded = decode_record(&bytes).expect("viewport input must not be encoded as PTY resize");
    let reencoded = encode_record(2, &decoded.record).unwrap();
    let future = FutureViewportIntentRecord::decode(&reencoded[20..]).unwrap();
    assert_eq!(future.viewport_intent.unwrap().intent_seq, 1);
}

#[test]
fn intent_ack_and_anchor_outcome_survive_a_typed_round_trip() {
    let encoded = envelope(
        VIEWPORT_FRAME_KIND,
        FutureViewportFrameRecord {
            schema_minor: 3,
            terminal_epoch: "viewport-red".into(),
            through_output_seq: 4,
            state_revision: 7,
            viewport_frame: Some(complete_frame()),
        }
        .encode_to_vec(),
    );
    let decoded = decode_record(&encoded).unwrap();
    let reencoded = encode_record(2, &decoded.record).unwrap();
    let future = FutureViewportFrameRecord::decode(&reencoded[20..]).unwrap();
    let frame = future.viewport_frame.unwrap();

    assert_eq!(frame.applied_intent_seq, 1);
    assert_eq!(frame.anchor_status, 1);
    assert_eq!(frame.rows_from_tail, Some(0));
}

#[test]
fn complete_frame_bytes_are_bounded_by_viewport_not_history_length() {
    let hundred_thousand = encoded_24_row_frame(100_000);
    let million = encoded_24_row_frame(1_000_000);

    assert!(hundred_thousand.len() < 4 * 1024);
    assert!(million.len() < 4 * 1024);
    assert!(
        million.len().abs_diff(hundred_thousand.len()) <= 1,
        "only the bounded tail-distance varint may differ"
    );
}
