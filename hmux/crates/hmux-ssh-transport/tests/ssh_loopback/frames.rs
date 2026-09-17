use super::*;

#[test]
fn unavailable_managed_commands_do_not_become_unknown_outcomes() {
    let create = start(Behaviour::NotInstalled);
    let create_error = create_managed_over_ssh(
        config_for(&create, &create.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert_eq!(create_error.code(), "hmux_remote_runtime_update_required");
    assert!(create_error.to_string().contains("command not found"));

    let reconcile = start(Behaviour::NotInstalled);
    let reconcile_error = reconcile_managed_create_over_ssh(
        config_for(&reconcile, &reconcile.host_fingerprint),
        managed_create_chain_root(),
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert_eq!(
        reconcile_error.code(),
        "hmux_remote_runtime_update_required"
    );

    let stop = start(Behaviour::NotInstalled);
    let stop_error = stop_managed_over_ssh(
        config_for(&stop, &stop.host_fingerprint),
        managed_stop_request(),
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert_eq!(stop_error.code(), "hmux_remote_runtime_update_required");
}

/// Frames and diagnostics survive a real SSH exec channel without a PTY's line discipline.
#[test]
fn frames_round_trip_over_a_real_ssh_exec_channel() {
    let fixture = start(Behaviour::Echo);
    let codec = codec();

    // The raw halves rather than `open`, because there is no Host on the far
    // end here -- the fixture echoes stream 0. A handshake would be answered by
    // its own `Hello` coming back, which proves nothing about the channel. What
    // is under test is the russh binding, so this reads and writes frames
    // directly.
    let mut transport = SshExecDialer::open_halves(config_for(&fixture, &fixture.host_fingerprint))
        .expect("the transport opens");

    let failure = hmux_client::ClientError::EndpointUnavailable {
        source: std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "fixture endpoint gone",
        ),
    };
    for frame in [
        detach("over-the-wire"),
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 2,
            body: FrameBody::Error(failure.to_error_frame()),
        },
    ] {
        let encoded = codec.encode(&frame).expect("frame encodes");
        transport
            .writer
            .write_frame(&encoded)
            .expect("frame is sent");
        let decoded = transport
            .reader
            .read_frame(&codec)
            .expect("a frame comes back")
            .expect("not a clean close");
        assert_eq!(decoded.frame(), &frame);
    }

    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        // The constant rather than a copy of its current text. A literal here
        // asserts only that someone typed the same thing twice, and the bug this
        // pins is precisely that the client's spelling and the forced command's
        // had drifted apart — invisibly, because a forced command discards the
        // client's string on every host anyone would think to test.
        Some(DEFAULT_GATEWAY_COMMAND)
    );
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "a PTY was requested; the stream is no longer 8-bit clean"
    );
}
