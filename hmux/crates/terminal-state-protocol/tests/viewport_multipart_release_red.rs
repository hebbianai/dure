use prost::Message;
use terminal_state_protocol::{
    BufferId, CellStyle, ColorKind, Grapheme, Hyperlink, InputModes, MAX_PAYLOAD_BYTES,
    MouseEncoding, MouseTrackingMode, PROTOCOL_MAJOR, RowTermination, TerminalCell, TerminalColor,
    TerminalColorOverrides, TerminalRow, TerminalStateRecord, TerminalTables, UnderlineKind,
    UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame, ViewportFrameAssembler,
    ViewportFrameAssembly, decode_record, terminal_state_record, validate_record,
};

const FUTURE_PROTOCOL_MINOR: u8 = 5;
const FUTURE_VIEWPORT_FRAME_PART_KIND: u8 = 12;
const MAX_COMPLETE_VIEWPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, PartialEq, Message)]
struct FutureTerminalStateRecord {
    #[prost(uint32, tag = "1")]
    schema_minor: u32,
    #[prost(string, tag = "2")]
    terminal_epoch: String,
    #[prost(uint64, tag = "3")]
    through_output_seq: u64,
    #[prost(uint64, tag = "4")]
    state_revision: u64,
    #[prost(oneof = "future_terminal_state_record::Body", tags = "21")]
    body: Option<future_terminal_state_record::Body>,
}

mod future_terminal_state_record {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Body {
        #[prost(message, tag = "21")]
        ViewportFramePart(super::FutureViewportFramePart),
    }
}

#[derive(Clone, PartialEq, Message)]
struct FutureViewportFramePart {
    #[prost(bytes = "vec", tag = "1")]
    batch_id: Vec<u8>,
    #[prost(uint32, tag = "2")]
    part_index: u32,
    #[prost(uint32, tag = "3")]
    part_count: u32,
    #[prost(uint32, tag = "4")]
    total_frame_bytes: u32,
    #[prost(bytes = "vec", tag = "5")]
    frame_chunk: Vec<u8>,
    #[prost(uint64, tag = "6")]
    projection_revision: u64,
    #[prost(uint64, tag = "7")]
    applied_intent_seq: u64,
}

fn styled_unicode_hyperlink_frame() -> ViewportFrame {
    let mut graphemes = vec![
        Grapheme {
            text: "한".into(),
            display_width: 2,
        },
        Grapheme {
            text: "👩‍💻".into(),
            display_width: 2,
        },
    ];
    graphemes.extend((0..2_048).map(|_| Grapheme {
        text: "한👩‍💻e\u{301}".repeat(32),
        display_width: 2,
    }));
    let hyperlinks = (0..64)
        .map(|index| Hyperlink {
            uri: format!("https://example.invalid/{index}/{}", "x".repeat(1_024)),
            params: format!("id=link-{index}"),
        })
        .collect::<Vec<_>>();
    let styles = (0..64)
        .map(|index| CellStyle {
            foreground: Some(TerminalColor {
                kind: ColorKind::Rgb as i32,
                value: 0x12_34_56,
            }),
            background: Some(TerminalColor {
                kind: ColorKind::Palette as i32,
                value: index,
            }),
            underline_color: Some(TerminalColor {
                kind: ColorKind::Rgb as i32,
                value: 0xab_cd_ef,
            }),
            flags: 0x45,
            underline: UnderlineKind::Curly as i32,
            hyperlink_index: index + 1,
        })
        .collect::<Vec<_>>();
    ViewportFrame {
        projection_revision: 9,
        damage_base_projection_revision: 0,
        canonical_columns: 4,
        viewport_rows: 1,
        active_buffer: BufferId::Normal as i32,
        rows: vec![TerminalRow {
            row_id: 1,
            continues_from_previous: false,
            cells: vec![
                TerminalCell {
                    grapheme_index: 0,
                    style_index: 0,
                },
                TerminalCell {
                    grapheme_index: 1,
                    style_index: 1,
                },
            ],
            termination: RowTermination::HardBreak as i32,
            logical_line_id: 1,
            logical_cell_offset: 0,
            logical_cell_span: 4,
        }],
        tables: Some(TerminalTables {
            graphemes,
            styles,
            hyperlinks,
        }),
        cursor: None,
        input_modes: Some(InputModes {
            mouse_tracking: MouseTrackingMode::None as i32,
            mouse_encoding: MouseEncoding::Default as i32,
            ..InputModes::default()
        }),
        color_overrides: Some(TerminalColorOverrides::default()),
        unicode_width: Some(UnicodeWidthProfile {
            unicode_version: "15.1".into(),
            ambiguous_width: 1,
            emoji_width: 2,
        }),
        through_event_id: 7,
        title: "styled Unicode OSC8 viewport".into(),
        working_directory_uri: "file:///tmp".into(),
        follow_tail: true,
        has_more_before: true,
        has_more_after: false,
        changed_row_indices: Vec::new(),
        applied_intent_seq: 8,
        anchor_status: ViewportAnchorStatus::FollowTail as i32,
        rows_from_tail: Some(0),
        input_output_timing: None,
    }
}

fn encode_future_part(
    record_id: u64,
    frame: &ViewportFrame,
    frame_bytes: &[u8],
    part_index: usize,
    part_count: usize,
    chunk: &[u8],
) -> Vec<u8> {
    let record = FutureTerminalStateRecord {
        schema_minor: u32::from(FUTURE_PROTOCOL_MINOR),
        terminal_epoch: "viewport-release-red".into(),
        through_output_seq: 11,
        state_revision: 12,
        body: Some(future_terminal_state_record::Body::ViewportFramePart(
            FutureViewportFramePart {
                batch_id: b"styled-unicode-hyperlink".to_vec(),
                part_index: part_index as u32,
                part_count: part_count as u32,
                total_frame_bytes: frame_bytes.len() as u32,
                frame_chunk: chunk.to_vec(),
                projection_revision: frame.projection_revision,
                applied_intent_seq: frame.applied_intent_seq,
            },
        )),
    };
    let payload = record.encode_to_vec();
    let mut envelope = Vec::with_capacity(20 + payload.len());
    envelope.extend_from_slice(b"TSPB");
    envelope.push(PROTOCOL_MAJOR);
    envelope.push(FUTURE_PROTOCOL_MINOR);
    envelope.push(FUTURE_VIEWPORT_FRAME_PART_KIND);
    envelope.push(0);
    envelope.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    envelope.extend_from_slice(&record_id.to_le_bytes());
    envelope.extend_from_slice(&payload);
    envelope
}

#[test]
fn release_codec_accepts_one_complete_oversized_styled_unicode_hyperlink_frame() {
    let frame = styled_unicode_hyperlink_frame();
    let record = TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: "viewport-release-red".into(),
        through_output_seq: 11,
        state_revision: 12,
        body: Some(terminal_state_record::Body::ViewportFrame(frame.clone())),
    };
    validate_record(&record).expect("the complete logical frame must be valid before transport");
    let frame_bytes = frame.encode_to_vec();
    assert!(frame_bytes.len() > MAX_PAYLOAD_BYTES);
    assert!(frame_bytes.len() <= MAX_COMPLETE_VIEWPORT_BYTES);

    let chunk_bytes = MAX_PAYLOAD_BYTES - 4_096;
    let chunks = frame_bytes.chunks(chunk_bytes).collect::<Vec<_>>();
    assert!(chunks.len() > 1);
    let mut assembler = ViewportFrameAssembler::default();
    let mut installed = None;
    for (index, chunk) in chunks.iter().enumerate() {
        let encoded = encode_future_part(
            100 + index as u64,
            &frame,
            &frame_bytes,
            index,
            chunks.len(),
            chunk,
        );
        let decoded =
            decode_record(&encoded).expect("every bounded part must be admitted in release mode");
        match assembler.push_downstream(decoded) {
            ViewportFrameAssembly::Pending => assert!(index + 1 < chunks.len()),
            ViewportFrameAssembly::Complete(decoded) => {
                assert_eq!(index + 1, chunks.len());
                let Some(terminal_state_record::Body::ViewportFrame(complete)) =
                    decoded.record.body
                else {
                    panic!("the complete batch produced a non-viewport record");
                };
                installed = Some(complete);
            }
            other => panic!("bounded multipart viewport was not assembled: {other:?}"),
        }
    }
    assert!(installed.as_ref() == Some(&frame));
    assert!(!assembler.has_incomplete());
}
