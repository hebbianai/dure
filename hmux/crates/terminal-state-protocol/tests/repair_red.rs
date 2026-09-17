use terminal_state_protocol::{
    BufferId, HistoryDirection, HistoryPage, InputIngressAuthority, InputIntent, ProtocolError,
    RecordKind, ResizeInputIntent, RowTermination, SetTitleOperation, StateMutation,
    StateOperation, TerminalStateRecord, TextInputIntent, decode_record, encode_input_at_writer,
    encode_record, encode_record_for_minor, input_intent, state_operation, terminal_state_record,
    validate_history_page_transaction, validate_input_ingress, validate_record,
};

const CURRENT: &[u8] = include_bytes!("../fixtures/terminal-state-current-v1.bin");
const PREVIOUS: &[u8] = include_bytes!("../compat/previous/terminal-state-v1.bin");

#[test]
fn ordinary_controller_input_is_not_coupled_to_state_revision() {
    let record = TerminalStateRecord {
        schema_minor: 2,
        terminal_epoch: "input-epoch".into(),
        through_output_seq: 9,
        state_revision: 7,
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"x".to_vec(),
            })),
        })),
    };

    validate_input_ingress(
        &record,
        &InputIngressAuthority {
            terminal_epoch: "input-epoch",
            geometry_generation: 1,
        },
    )
    .expect("ordinary input must use the controller fence, not state revision");
}

#[test]
fn logical_line_segments_are_contiguous_not_merely_increasing() {
    let mut record = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = record.body.as_mut().unwrap() else {
        panic!("fixture body is not a snapshot");
    };
    let rows = &mut snapshot.normal_buffer.as_mut().unwrap().rows;
    rows[0].logical_line_id = 77;
    rows[0].logical_cell_offset = 0;
    rows[0].termination = RowTermination::SoftWrap as i32;
    rows[1].logical_line_id = 77;
    rows[1].logical_cell_offset = 2;
    rows[1].continues_from_previous = true;
    rows[1].termination = RowTermination::HardBreak as i32;

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "logical line segments are not contiguous"
        ))
    ));
}

#[test]
fn exhausted_revision_requires_a_new_epoch() {
    let mut record = decode_record(CURRENT).unwrap().record;
    record.state_revision = u64::MAX;
    record.body = Some(terminal_state_record::Body::Mutation(StateMutation {
        base_state_revision: u64::MAX - 1,
        operations: vec![StateOperation {
            operation: Some(state_operation::Operation::SetTitle(SetTitleOperation {
                title: "exhausted".into(),
            })),
        }],
        ..StateMutation::default()
    }));

    assert!(matches!(
        validate_record(&record),
        Err(ProtocolError::InvalidRecord(
            "state revision is exhausted; roll terminal epoch"
        ))
    ));
}

#[test]
fn debug_output_redacts_terminal_text_and_uris() {
    let mut record = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = record.body.as_mut().unwrap() else {
        panic!("fixture body is not a snapshot");
    };
    snapshot.title = "debug-secret-title".into();
    snapshot.working_directory_uri = "file:///debug-secret-uri".into();

    let debug = format!("{record:?}");
    assert!(!debug.contains("debug-secret-title"));
    assert!(!debug.contains("debug-secret-uri"));
}

#[test]
fn previous_minor_encoder_uses_the_negotiated_minor() {
    let decoded = decode_record(PREVIOUS).unwrap();
    assert_eq!(decoded.metadata.kind, RecordKind::Snapshot);
    let encoded = encode_record(decoded.metadata.record_id, &decoded.record).unwrap();

    assert_eq!(encoded[5], 1);
    assert_eq!(encoded, PREVIOUS);
    assert_eq!(
        encode_record_for_minor(1, decoded.metadata.record_id, &decoded.record).unwrap(),
        PREVIOUS,
    );
}

#[test]
fn input_is_rechecked_at_writer_with_resize_geometry_fenced_separately() {
    let ordinary = TerminalStateRecord {
        schema_minor: 2,
        terminal_epoch: "writer-epoch".into(),
        through_output_seq: 3,
        state_revision: 99,
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Text(TextInputIntent {
                utf8: b"x".to_vec(),
            })),
        })),
    };
    let authority = InputIngressAuthority {
        terminal_epoch: "writer-epoch",
        geometry_generation: 8,
    };
    encode_input_at_writer(2, 1, &ordinary, &authority).unwrap();

    let resize = TerminalStateRecord {
        body: Some(terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                columns: 80,
                rows: 24,
                geometry_generation: 7,
            })),
        })),
        ..ordinary
    };
    assert!(matches!(
        encode_input_at_writer(2, 2, &resize, &authority),
        Err(ProtocolError::InvalidRecord(
            "resize geometry generation is not current"
        ))
    ));
}

#[test]
fn history_transaction_rejects_grid_logical_anchor_reuse() {
    let record = decode_record(CURRENT).unwrap().record;
    let terminal_state_record::Body::Snapshot(snapshot) = record.body.as_ref().unwrap() else {
        panic!("fixture body is not a snapshot");
    };
    let normal = &snapshot.normal_buffer.as_ref().unwrap().rows;
    let alternate = &snapshot.alternate_buffer.as_ref().unwrap().rows;
    let page = HistoryPage {
        direction: HistoryDirection::After as i32,
        request_cursor: vec![1],
        rows: vec![normal[0].clone()],
        tables: snapshot.tables.clone(),
        ..HistoryPage::default()
    };

    assert!(matches!(
        validate_history_page_transaction(record.schema_minor, &page, normal, alternate, &[],),
        Err(ProtocolError::InvalidRecord(
            "logical row anchor is duplicated across terminal projections"
        ))
    ));
    assert_eq!(snapshot.active_buffer, BufferId::Alternate as i32);
}
