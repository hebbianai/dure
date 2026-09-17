use prost::Message;
use terminal_state_protocol::{
    BufferId, CellStyle, Grapheme, InputModes, InputOutputTiming, MAX_VIEWPORT_FRAME_BYTES,
    MouseEncoding, MouseTrackingMode, PROTOCOL_MAJOR, ProtocolError, RecordKind, RowTermination,
    TerminalCell, TerminalColorOverrides, TerminalRow, TerminalStateRecord, TerminalTables,
    UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame,
    ViewportFrameAssembler, ViewportFrameAssembly, ViewportFrameBatch, ViewportFrameProgress,
    decode_record, encode_record, encode_viewport_frame_parts, terminal_state_record,
    validate_record,
};

const FUTURE_PROTOCOL_MINOR: u8 = 5;
const FUTURE_VIEWPORT_FRAME_PART_KIND: u8 = 12;

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

fn encode_future_part() -> Vec<u8> {
    let record = FutureTerminalStateRecord {
        schema_minor: u32::from(FUTURE_PROTOCOL_MINOR),
        terminal_epoch: "viewport-multipart-red".into(),
        through_output_seq: 7,
        state_revision: 9,
        body: Some(future_terminal_state_record::Body::ViewportFramePart(
            FutureViewportFramePart {
                batch_id: b"batch-red".to_vec(),
                part_index: 0,
                part_count: 2,
                total_frame_bytes: 4,
                frame_chunk: vec![0x08, 0x02],
                projection_revision: 2,
                applied_intent_seq: 3,
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
    envelope.extend_from_slice(&41_u64.to_le_bytes());
    envelope.extend_from_slice(&payload);
    envelope
}

#[test]
fn viewport_frame_part_is_a_first_class_bounded_record() {
    decode_record(&encode_future_part()).expect("multipart viewport records must decode");
}

fn complete_frame() -> ViewportFrame {
    ViewportFrame {
        projection_revision: 2,
        damage_base_projection_revision: 0,
        canonical_columns: 2,
        viewport_rows: 1,
        active_buffer: BufferId::Normal as i32,
        rows: vec![TerminalRow {
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
        }],
        tables: Some(TerminalTables {
            graphemes: vec![Grapheme {
                text: "x".into(),
                display_width: 1,
            }],
            styles: vec![CellStyle {
                underline: UnderlineKind::None as i32,
                ..CellStyle::default()
            }],
            hyperlinks: Vec::new(),
        }),
        cursor: None,
        input_modes: Some(InputModes {
            mouse_tracking: MouseTrackingMode::None as i32,
            mouse_encoding: MouseEncoding::Default as i32,
            ..InputModes::default()
        }),
        color_overrides: Some(TerminalColorOverrides::default()),
        unicode_width: Some(UnicodeWidthProfile {
            unicode_version: "test".into(),
            ambiguous_width: 1,
            emoji_width: 2,
        }),
        through_event_id: 3,
        title: "multipart".into(),
        working_directory_uri: "file:///tmp".into(),
        follow_tail: true,
        has_more_before: true,
        has_more_after: false,
        changed_row_indices: Vec::new(),
        applied_intent_seq: 4,
        anchor_status: ViewportAnchorStatus::FollowTail as i32,
        rows_from_tail: Some(0),
        input_output_timing: None,
    }
}

fn encoded_parts(frame: &ViewportFrame) -> Vec<Vec<u8>> {
    encode_viewport_frame_parts(ViewportFrameBatch {
        record_id_start: 40,
        schema_minor: 5,
        terminal_epoch: "viewport-parts",
        through_output_seq: 7,
        state_revision: 9,
        batch_id: b"viewport-batch",
        frame,
        max_chunk_bytes: 64,
    })
    .unwrap()
}

#[test]
fn input_output_timing_is_bounded_and_carries_a_correlation_record() {
    let mut frame = complete_frame();
    frame.input_output_timing = Some(InputOutputTiming {
        input_baseline_output_sequence: 6,
        first_output_sequence: 7,
        input_to_output_micros: 4_200,
        output_to_projection_start_micros: 1_500,
        input_record_id: 11,
    });
    let mut record = TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: "viewport-parts".into(),
        through_output_seq: 7,
        state_revision: 9,
        body: Some(terminal_state_record::Body::ViewportFrame(frame)),
    };
    validate_record(&record).unwrap();

    record.through_output_seq = 6;
    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "viewport input/output timing exceeds its output high-water"
        ))
    ));

    record.through_output_seq = 7;
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_mut() else {
        panic!("timing test lost its viewport frame")
    };
    frame
        .input_output_timing
        .as_mut()
        .expect("timing test lost its correlation")
        .input_record_id = 0;
    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "viewport input/output timing record ID is missing"
        ))
    ));
}

#[test]
fn encoder_and_assembler_preserve_every_fence_and_install_once() {
    let frame = complete_frame();
    let parts = encoded_parts(&frame);
    assert!(parts.len() > 1);
    assert!(parts.len() <= 32);

    let mut assembler = ViewportFrameAssembler::default();
    for (index, encoded) in parts.iter().enumerate() {
        let decoded = decode_record(encoded).unwrap();
        assert_eq!(decoded.metadata.record_id, 40 + index as u64);
        assert_eq!(decoded.metadata.kind, RecordKind::ViewportFramePart);
        assert_eq!(decoded.metadata.protocol_minor, 5);
        assert_eq!(decoded.record.schema_minor, 5);
        assert_eq!(decoded.record.terminal_epoch, "viewport-parts");
        assert_eq!(decoded.record.through_output_seq, 7);
        assert_eq!(decoded.record.state_revision, 9);
        let terminal_state_record::Body::ViewportFramePart(part) =
            decoded.record.body.as_ref().unwrap()
        else {
            panic!("encoder emitted the wrong body");
        };
        assert_eq!(part.projection_revision, frame.projection_revision);
        assert_eq!(part.applied_intent_seq, frame.applied_intent_seq);

        let result = assembler.push_downstream(decoded);
        if index + 1 < parts.len() {
            assert_eq!(result, ViewportFrameAssembly::Pending);
        } else {
            let ViewportFrameAssembly::Complete(complete) = result else {
                panic!("final part did not produce one complete frame");
            };
            assert_eq!(complete.metadata.record_id, 40 + index as u64);
            assert_eq!(complete.metadata.kind, RecordKind::ViewportFrame);
            assert_eq!(complete.metadata.protocol_minor, 4);
            assert_eq!(complete.record.schema_minor, 4);
            assert!(
                complete.record.body
                    == Some(terminal_state_record::Body::ViewportFrame(frame.clone()))
            );
        }
    }
    assert!(!assembler.has_incomplete());
}

#[test]
fn multipart_initial_projection_preserves_zero_applied_intent() {
    let mut frame = complete_frame();
    frame.applied_intent_seq = 0;
    let parts = encoded_parts(&frame);
    let mut assembler = ViewportFrameAssembler::default();
    for encoded in parts {
        match assembler.push_downstream(decode_record(&encoded).unwrap()) {
            ViewportFrameAssembly::Pending => {}
            ViewportFrameAssembly::Complete(complete) => {
                let Some(terminal_state_record::Body::ViewportFrame(installed)) =
                    complete.record.body
                else {
                    panic!("multipart initial projection produced the wrong record");
                };
                assert_eq!(installed.applied_intent_seq, 0);
                return;
            }
            other => panic!("multipart initial projection failed: {other:?}"),
        }
    }
    panic!("multipart initial projection never completed");
}

#[test]
fn assembler_rejects_duplicate_reorder_record_gap_and_interruption() {
    let frame = complete_frame();
    let parts = encoded_parts(&frame);
    let first = decode_record(&parts[0]).unwrap();
    let second = decode_record(&parts[1]).unwrap();

    let mut reordered = ViewportFrameAssembler::default();
    assert!(matches!(
        reordered.push_downstream(second.clone()),
        ViewportFrameAssembly::ResyncRequired("viewport frame first part is missing")
    ));

    let mut duplicate = ViewportFrameAssembler::default();
    assert_eq!(
        duplicate.push_downstream(first.clone()),
        ViewportFrameAssembly::Pending
    );
    assert!(matches!(
        duplicate.push_downstream(first.clone()),
        ViewportFrameAssembly::ResyncRequired(
            "viewport frame part is duplicate, reordered, or replaced"
        )
    ));

    let mut record_gap = ViewportFrameAssembler::default();
    assert_eq!(
        record_gap.push_downstream(first.clone()),
        ViewportFrameAssembly::Pending
    );
    let mut skipped = second.clone();
    skipped.metadata.record_id += 1;
    assert!(matches!(
        record_gap.push_downstream(skipped),
        ViewportFrameAssembly::ResyncRequired(
            "viewport frame part is duplicate, reordered, or replaced"
        )
    ));

    let direct = decode_record(
        &encode_record(
            50,
            &terminal_state_protocol::TerminalStateRecord {
                schema_minor: 5,
                terminal_epoch: "viewport-parts".into(),
                through_output_seq: 7,
                state_revision: 9,
                body: Some(terminal_state_record::Body::ViewportFrame(frame)),
            },
        )
        .unwrap(),
    )
    .unwrap();
    let mut interrupted = ViewportFrameAssembler::default();
    assert_eq!(
        interrupted.push_downstream(first.clone()),
        ViewportFrameAssembly::Pending
    );
    assert!(matches!(
        interrupted.push_downstream(direct),
        ViewportFrameAssembly::ResyncRequired("viewport frame batch interrupted by another record")
    ));

    let mut closed = ViewportFrameAssembler::default();
    assert_eq!(
        closed.push_downstream(first),
        ViewportFrameAssembly::Pending
    );
    assert!(closed.discard_incomplete());
    assert!(!closed.discard_incomplete());
}

#[test]
fn assembler_rejects_stale_and_inner_frame_fence_mismatch() {
    let frame = complete_frame();
    let parts = encoded_parts(&frame);
    let first = decode_record(&parts[0]).unwrap();
    let mut stale = ViewportFrameAssembler::with_installed(ViewportFrameProgress {
        terminal_epoch: "viewport-parts".into(),
        through_output_seq: 7,
        state_revision: 9,
        projection_revision: frame.projection_revision,
        applied_intent_seq: frame.applied_intent_seq,
    });
    assert!(matches!(
        stale.push_downstream(first),
        ViewportFrameAssembly::ResyncRequired("viewport frame part is duplicate or stale")
    ));
    assert!(!stale.has_incomplete());

    let mut mismatch = ViewportFrameAssembler::default();
    for (index, encoded) in parts.iter().enumerate() {
        let mut decoded = decode_record(encoded).unwrap();
        let Some(terminal_state_record::Body::ViewportFramePart(part)) =
            decoded.record.body.as_mut()
        else {
            unreachable!()
        };
        part.projection_revision += 1;
        let result = mismatch.push_downstream(decoded);
        if index + 1 == parts.len() {
            assert!(matches!(
                result,
                ViewportFrameAssembly::ResyncRequired(
                    "reassembled viewport frame disagrees with part fences"
                )
            ));
        } else {
            assert_eq!(result, ViewportFrameAssembly::Pending);
        }
    }
}

#[test]
fn viewport_batches_enforce_atomic_size_part_and_record_id_bounds() {
    let frame = complete_frame();
    assert!(matches!(
        encode_viewport_frame_parts(ViewportFrameBatch {
            record_id_start: 0,
            schema_minor: 5,
            terminal_epoch: "viewport-parts",
            through_output_seq: 7,
            state_revision: 9,
            batch_id: b"zero-record-id",
            frame: &frame,
            max_chunk_bytes: 64,
        }),
        Err(ProtocolError::InvalidEnvelope("record id must be nonzero"))
    ));
    assert!(matches!(
        encode_viewport_frame_parts(ViewportFrameBatch {
            record_id_start: 1,
            schema_minor: 5,
            terminal_epoch: "viewport-parts",
            through_output_seq: 7,
            state_revision: 9,
            batch_id: b"too-many-parts",
            frame: &frame,
            max_chunk_bytes: 1,
        }),
        Err(ProtocolError::InvalidRecord(
            "viewport frame requires too many parts"
        ))
    ));
    assert!(matches!(
        encode_viewport_frame_parts(ViewportFrameBatch {
            record_id_start: u64::MAX,
            schema_minor: 5,
            terminal_epoch: "viewport-parts",
            through_output_seq: 7,
            state_revision: 9,
            batch_id: b"record-overflow",
            frame: &frame,
            max_chunk_bytes: 64,
        }),
        Err(ProtocolError::InvalidEnvelope("record id overflow"))
    ));

    let mut oversized = frame;
    oversized
        .tables
        .as_mut()
        .unwrap()
        .graphemes
        .extend((0..4200).map(|_| Grapheme {
            text: "x".repeat(1024),
            display_width: 1,
        }));
    assert!(matches!(
        encode_viewport_frame_parts(ViewportFrameBatch {
            record_id_start: 1,
            schema_minor: 5,
            terminal_epoch: "viewport-parts",
            through_output_seq: 7,
            state_revision: 9,
            batch_id: b"oversized-frame",
            frame: &oversized,
            max_chunk_bytes: 1024 * 1024 - 1024,
        }),
        Err(ProtocolError::FrameTooLarge { maximum, .. })
            if maximum == MAX_VIEWPORT_FRAME_BYTES
    ));
}

#[test]
fn invalid_declared_batch_total_is_rejected_before_allocation() {
    let payload = FutureTerminalStateRecord {
        schema_minor: 5,
        terminal_epoch: "viewport-parts".into(),
        through_output_seq: 7,
        state_revision: 9,
        body: Some(future_terminal_state_record::Body::ViewportFramePart(
            FutureViewportFramePart {
                batch_id: b"oversized-total".to_vec(),
                part_index: 0,
                part_count: 1,
                total_frame_bytes: (MAX_VIEWPORT_FRAME_BYTES + 1) as u32,
                frame_chunk: vec![1],
                projection_revision: 2,
                applied_intent_seq: 4,
            },
        )),
    }
    .encode_to_vec();
    let mut envelope = Vec::new();
    envelope.extend_from_slice(b"TSPB");
    envelope.extend_from_slice(&[1, 5, 12, 0]);
    envelope.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    envelope.extend_from_slice(&1_u64.to_le_bytes());
    envelope.extend_from_slice(&payload);
    assert!(matches!(
        decode_record(&envelope),
        Err(ProtocolError::InvalidRecord(
            "viewport frame batch total is outside caps"
        ))
    ));
}
