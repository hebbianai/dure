use super::*;

#[test]
fn downstream_failure_reaches_the_remote_client_with_its_original_code() {
    let mut invalid = viewport_record(2, 2);
    invalid.terminal_epoch = "another-terminal-epoch".into();
    let payload = encode_record(2, &invalid).expect("mismatched epoch encodes");
    let (connection, _host) = structured_connection(false, &[payload], true, false, None, None);
    let mut downstream = GatewayDownstream::from_connection(connection).unwrap();
    let sink = Mutex::new(FrameSink::new(Vec::new()));

    let result = pump_downstream(&mut downstream, &sink);
    assert!(
        result.is_err(),
        "a broken stream must fail the gateway command"
    );
    let written = sink.into_inner().unwrap().output;

    let (remote, mut relay) = structured_connection(false, &[], false, false, None, None);
    let mut remote = TerminalSurfaceAttachment::from_connection(remote).unwrap();
    relay
        .write_frame(&written)
        .expect("gateway refusal reaches the remote peer");
    relay.close_write().unwrap();
    let error = remote.read_delivery_record().unwrap_err();
    assert_eq!(error.code(), "hmux_inconsistent_stream");
    assert_eq!(error.retry_directive(), RetryDirective::Never);
    assert!(
        error
            .to_string()
            .contains("epoch does not match attach fence")
    );
}

#[test]
fn downstream_clean_eof_is_not_reported_as_a_failure() {
    let (connection, _host) = structured_connection(false, &[], true, false, None, None);
    let mut downstream = GatewayDownstream::from_connection(connection).unwrap();
    let sink = Mutex::new(FrameSink::new(Vec::new()));

    pump_downstream(&mut downstream, &sink).expect("clean EOF succeeds");
    assert!(sink.into_inner().unwrap().output.is_empty());
}

#[test]
fn downstream_host_refusal_preserves_its_code_message_and_retry() {
    let (connection, mut host) = structured_connection(false, &[], false, false, None, None);
    let mut downstream = GatewayDownstream::from_connection(connection).unwrap();
    let expected = FrameBody::Error(ErrorFrame {
        origin_code: None,
        code: ErrorCode::ResourceLimit,
        message: "the subscriber cannot keep up".into(),
        retry: RetryPosture::Reconnect,
        required_capability: None,
        supported_versions: None,
        in_reply_to_request_id: None,
    });
    let codec = FrameCodec::new(FrameLimits::default());
    host.write_frame(
        &codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: expected.clone(),
            })
            .unwrap(),
    )
    .unwrap();
    host.close_write().unwrap();
    let sink = Mutex::new(FrameSink::new(Vec::new()));

    pump_downstream(&mut downstream, &sink).expect("the Host refusal completes the relay");
    let written = sink.into_inner().unwrap().output;
    assert_eq!(
        codec.read_from(&mut Cursor::new(written)).unwrap().body,
        expected
    );
}
