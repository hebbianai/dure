use terminal_state_protocol::{
    AppendHistoryOperation, BufferId, CellStyle, HistoryAnchor, HistoryDirection, HistoryPage,
    InputIngressAuthority, InputIntent, InvalidateHistoryProjectionOperation, MAX_PAYLOAD_BYTES,
    ProtocolError, RecordKind, ScrollOperation, SetTitleOperation, StateMutation, StateOperation,
    TableAppend, TerminalStateRecord, TextInputIntent, TrimHistoryOperation,
    ViewportFrameAssembler, ViewportFrameAssembly, decode_record, encode_record, input_intent,
    state_operation, terminal_state_record, validate_input_ingress, validate_record,
};

const CURRENT: &[u8] = include_bytes!("../fixtures/terminal-state-current-v1.bin");
const PREVIOUS: &[u8] = include_bytes!("../compat/previous/terminal-state-v1.bin");
const CURRENT_FIXTURE_PROTOCOL_MINOR: u8 = 4;
const VIEWPORT_FIXTURE_PROTOCOL_MINOR: u8 = 5;
const VIEWPORT_PART_0: &[u8] = include_bytes!("../fixtures/terminal-viewport-frame-part-0-v1.bin");
const VIEWPORT_PART_1: &[u8] = include_bytes!("../fixtures/terminal-viewport-frame-part-1-v1.bin");

#[test]
fn current_fixture_preserves_uint64_identity_and_reencodes_exactly() {
    let decoded = decode_record(CURRENT).expect("current fixture decodes");
    assert_eq!(
        decoded.metadata.protocol_minor,
        CURRENT_FIXTURE_PROTOCOL_MINOR
    );
    assert_eq!(decoded.metadata.record_id, u64::MAX);
    assert_eq!(decoded.metadata.kind, RecordKind::Snapshot);
    assert_eq!(decoded.record.terminal_epoch, "epoch-current");
    assert_eq!(decoded.record.through_output_seq, 9_007_199_254_740_993);
    assert_eq!(decoded.record.state_revision, u64::MAX - 1);
    let terminal_state_record::Body::Snapshot(snapshot) = decoded.record.body.as_ref().unwrap()
    else {
        panic!("current fixture body is not a snapshot");
    };
    assert_eq!(snapshot.active_buffer, BufferId::Alternate as i32);
    assert!(snapshot.history_truncated);
    assert_eq!(snapshot.through_event_id, 7);
    assert_eq!(snapshot.working_directory_uri, "file:///tmp/fixture");
    assert_eq!(snapshot.tables.as_ref().unwrap().hyperlinks.len(), 1);
    assert_eq!(snapshot.normal_buffer.as_ref().unwrap().rows.len(), 2);
    assert_eq!(snapshot.alternate_buffer.as_ref().unwrap().rows.len(), 2);
    assert_eq!(
        encode_record(decoded.metadata.record_id, &decoded.record).unwrap(),
        CURRENT,
    );
}

#[test]
fn multipart_viewport_fixture_reencodes_and_assembles_exactly() {
    let first = decode_record(VIEWPORT_PART_0).unwrap();
    let second = decode_record(VIEWPORT_PART_1).unwrap();
    assert_eq!(
        first.metadata.protocol_minor,
        VIEWPORT_FIXTURE_PROTOCOL_MINOR
    );
    assert_eq!(
        second.metadata.protocol_minor,
        VIEWPORT_FIXTURE_PROTOCOL_MINOR
    );
    assert_eq!(first.metadata.record_id, 41);
    assert_eq!(second.metadata.record_id, 42);
    assert_eq!(first.metadata.kind, RecordKind::ViewportFramePart);
    assert_eq!(first.record.terminal_epoch, "epoch-viewport-parts");
    assert_eq!(first.record.through_output_seq, 43);
    assert_eq!(first.record.state_revision, 47);
    let terminal_state_record::Body::ViewportFramePart(part) = first.record.body.as_ref().unwrap()
    else {
        panic!("viewport fixture body is not a part");
    };
    assert_eq!(part.batch_id, b"viewport-fixture-batch");
    assert_eq!(part.part_index, 0);
    assert_eq!(part.part_count, 2);
    assert_eq!(part.projection_revision, 53);
    assert_eq!(part.applied_intent_seq, 59);
    assert_eq!(encode_record(41, &first.record).unwrap(), VIEWPORT_PART_0);
    assert_eq!(encode_record(42, &second.record).unwrap(), VIEWPORT_PART_1);

    let mut assembler = ViewportFrameAssembler::default();
    assert_eq!(
        assembler.push_downstream(first),
        ViewportFrameAssembly::Pending
    );
    let ViewportFrameAssembly::Complete(complete) = assembler.push_downstream(second) else {
        panic!("viewport fixture did not assemble atomically");
    };
    let terminal_state_record::Body::ViewportFrame(frame) = complete.record.body.unwrap() else {
        panic!("viewport fixture did not produce a frame");
    };
    assert_eq!(frame.projection_revision, 53);
    assert_eq!(frame.applied_intent_seq, 59);
    assert_eq!(frame.title, "fixture title");
}

#[test]
fn sparse_snapshot_is_rejected_instead_of_inventing_rows() {
    let mut record = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = record.body.as_mut().unwrap() else {
        panic!("current fixture body is not a snapshot");
    };
    snapshot.alternate_buffer.as_mut().unwrap().rows.pop();

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "grid buffer must contain every row"
        ))
    ));
}

#[test]
fn table_append_reuses_full_style_validation() {
    let mut record = decode_record(CURRENT).unwrap().record;
    record.body = Some(terminal_state_record::Body::Mutation(StateMutation {
        base_state_revision: record.state_revision - 1,
        tables: Some(TableAppend {
            style_base: 2,
            styles: vec![CellStyle {
                flags: 0x200,
                ..CellStyle::default()
            }],
            ..TableAppend::default()
        }),
        operations: Vec::new(),
    }));

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "style decoration flags contain unknown bits"
        ))
    ));
}

#[test]
fn history_page_rejects_duplicate_rows_within_the_page() {
    let mut record = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = record.body.as_ref().unwrap() else {
        panic!("current fixture body is not a snapshot");
    };
    let duplicate = snapshot.normal_buffer.as_ref().unwrap().rows[0].clone();
    record.body = Some(terminal_state_record::Body::HistoryPage(HistoryPage {
        direction: HistoryDirection::After as i32,
        request_cursor: vec![1],
        rows: vec![duplicate.clone(), duplicate],
        tables: snapshot.tables.clone(),
        ..HistoryPage::default()
    }));

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord("duplicate physical row id"))
    ));
}

#[test]
fn scroll_exposed_rows_reject_duplicate_and_out_of_order_identity() {
    let decoded = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = decoded.body.as_ref().unwrap() else {
        panic!("current fixture body is not a snapshot");
    };
    let rows = &snapshot.normal_buffer.as_ref().unwrap().rows;
    let mutation = |exposed_rows| TerminalStateRecord {
        body: Some(terminal_state_record::Body::Mutation(StateMutation {
            base_state_revision: decoded.state_revision - 1,
            operations: vec![StateOperation {
                operation: Some(state_operation::Operation::Scroll(ScrollOperation {
                    buffer: BufferId::Normal as i32,
                    top: 0,
                    bottom: 1,
                    lines: 2,
                    exposed_rows,
                })),
            }],
            ..StateMutation::default()
        })),
        ..decoded.clone()
    };

    assert!(matches!(
        validate_record(&mutation(vec![rows[0].clone(), rows[0].clone()])),
        Err(ProtocolError::InvalidRecord("duplicate physical row id"))
    ));
    assert!(matches!(
        validate_record(&mutation(vec![rows[1].clone(), rows[0].clone()])),
        Err(ProtocolError::InvalidRecord(
            "logical line ids are out of order"
        ))
    ));
}

#[test]
fn history_availability_requires_the_corresponding_cursor_everywhere() {
    let decoded = decode_record(CURRENT).unwrap().record;
    let invalid_anchor = HistoryAnchor {
        before_cursor: Vec::new(),
        has_more_before: true,
        ..HistoryAnchor::default()
    };

    let mut snapshot_record = decoded.clone();
    let terminal_state_record::Body::Snapshot(snapshot) = snapshot_record.body.as_mut().unwrap()
    else {
        panic!("current fixture body is not a snapshot");
    };
    snapshot.history = Some(invalid_anchor.clone());

    let mutation = |operation| TerminalStateRecord {
        body: Some(terminal_state_record::Body::Mutation(StateMutation {
            base_state_revision: decoded.state_revision - 1,
            operations: vec![StateOperation {
                operation: Some(operation),
            }],
            ..StateMutation::default()
        })),
        ..decoded.clone()
    };
    let page_record = TerminalStateRecord {
        body: Some(terminal_state_record::Body::HistoryPage(HistoryPage {
            direction: HistoryDirection::After as i32,
            request_cursor: vec![1],
            has_more_after: true,
            ..HistoryPage::default()
        })),
        ..decoded.clone()
    };

    for invalid in [
        snapshot_record,
        page_record,
        mutation(state_operation::Operation::AppendHistory(
            AppendHistoryOperation {
                has_more_after: true,
                ..AppendHistoryOperation::default()
            },
        )),
        mutation(state_operation::Operation::TrimHistory(
            TrimHistoryOperation {
                has_more_before: true,
                ..TrimHistoryOperation::default()
            },
        )),
        mutation(state_operation::Operation::InvalidateHistoryProjection(
            InvalidateHistoryProjectionOperation {
                history: Some(invalid_anchor),
            },
        )),
    ] {
        assert!(matches!(
            validate_record(&invalid),
            Err(ProtocolError::InvalidRecord(
                "history availability requires its cursor"
            ))
        ));
    }
}

#[test]
fn mutation_base_revision_must_be_exactly_adjacent() {
    let mut record = decode_record(CURRENT).unwrap().record;
    record.body = Some(terminal_state_record::Body::Mutation(StateMutation {
        base_state_revision: record.state_revision - 2,
        operations: vec![StateOperation {
            operation: Some(state_operation::Operation::SetTitle(SetTitleOperation {
                title: "gap".into(),
            })),
        }],
        ..StateMutation::default()
    }));

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "mutation revisions must be adjacent"
        ))
    ));
}

#[test]
fn input_ingress_fences_epoch_without_a_controller_lease_receipt() {
    let record = TerminalStateRecord {
        schema_minor: 2,
        terminal_epoch: "epoch-current".into(),
        through_output_seq: 9,
        state_revision: 7,
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"x".to_vec(),
            })),
        })),
    };

    let current = InputIngressAuthority {
        terminal_epoch: "epoch-current",
        geometry_generation: 1,
    };
    validate_input_ingress(&record, &current).unwrap();
    assert!(matches!(
        validate_input_ingress(
            &record,
            &InputIngressAuthority {
                terminal_epoch: "stale-epoch",
                ..current
            },
        ),
        Err(ProtocolError::InvalidRecord(
            "input terminal epoch is not current"
        ))
    ));
}

#[test]
fn previous_fixture_decodes_with_current_types_and_reencodes_exactly() {
    let decoded = decode_record(PREVIOUS).expect("previous fixture decodes");
    assert_eq!(decoded.metadata.protocol_minor, 1);
    assert_eq!(decoded.metadata.record_id, u64::MAX);
    assert_eq!(decoded.record.schema_minor, 1);
    assert_eq!(decoded.record.terminal_epoch, "epoch-current");
    let terminal_state_record::Body::Snapshot(snapshot) = decoded.record.body.as_ref().unwrap()
    else {
        panic!("previous fixture body is not a snapshot");
    };
    assert_eq!(snapshot.active_buffer, BufferId::Alternate as i32);
    assert!(snapshot.history_truncated);
    assert_eq!(snapshot.tables.as_ref().unwrap().hyperlinks.len(), 1);

    let reencoded = encode_record(decoded.metadata.record_id, &decoded.record).unwrap();
    assert_eq!(reencoded, PREVIOUS);
}

#[test]
fn decoder_ignores_unknown_additive_protobuf_fields() {
    let mut extended = CURRENT.to_vec();
    extended.extend_from_slice(&[0x98, 0x06, 0x07]); // field 99, varint 7
    let payload_length = u32::from_le_bytes(extended[8..12].try_into().unwrap()) + 3;
    extended[8..12].copy_from_slice(&payload_length.to_le_bytes());

    let decoded = decode_record(&extended).expect("unknown field remains compatible");
    assert_eq!(decoded.record.state_revision, u64::MAX - 1);
}

#[test]
fn semantic_caps_reject_oversized_epoch_after_bounded_decode() {
    let mut record = decode_record(CURRENT).unwrap().record;
    record.terminal_epoch = "x".repeat(129);

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "terminal epoch is empty or oversized"
        ))
    ));
}

#[test]
fn peer_declared_payload_cap_is_checked_before_protobuf_decode() {
    let mut header = CURRENT[..20].to_vec();
    header[8..12].copy_from_slice(&((MAX_PAYLOAD_BYTES + 1) as u32).to_le_bytes());

    assert!(matches!(
        decode_record(&header),
        Err(ProtocolError::FrameTooLarge {
            actual,
            maximum: MAX_PAYLOAD_BYTES,
        }) if actual == MAX_PAYLOAD_BYTES + 1
    ));
}
