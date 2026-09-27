use super::*;
use hmux_session_protocol::{
    AttachMode, AuthorizationPosture, Hello, HelloAck, LifecycleState, ProcessProof, VersionRange,
    WireFrame, PROTOCOL_V1,
};
use terminal_state_protocol::{
    encode_record, InputIntent, ResizeAppliedToTerminal, ResizeInputIntent, ResizeReceipt,
    ResizeRefused, TerminalStateRecord, PROTOCOL_MINOR,
};

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        runner_principal: "runner".into(),
        runner_instance: "instance".into(),
        channel_epoch: 1,
        host_instance_id: "host".into(),
        terminal_epoch: "epoch".into(),
    }
}

fn control(body: FrameBody) -> Vec<u8> {
    FrameCodec::new(Default::default())
        .encode(&WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body,
        })
        .unwrap()
}

fn hello() -> Vec<u8> {
    control(FrameBody::Hello(Hello {
        supported_versions: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        requested_capabilities: vec![
            TERMINAL_INPUT_INTENT_CAPABILITY.into(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.into(),
            "terminal_state_binary_v1".into(),
        ],
        expected_fence: fence(),
        requested_mode: AttachMode::Observer,
        reconnect_cursor: None,
        capability_token: "fixture".into(),
        authorization_proof_reference: None,
        initial_snapshot_profile: None,
    }))
}

fn ack(fence: SessionFence, writable: bool) -> Vec<u8> {
    control(FrameBody::HelloAck(HelloAck {
        selected_version: PROTOCOL_V1,
        selected_capabilities: if writable {
            vec![
                TERMINAL_INPUT_INTENT_CAPABILITY.into(),
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.into(),
                "terminal_state_binary_v1".into(),
            ]
        } else {
            vec!["terminal_state_binary_v1".into()]
        },
        actual_fence: fence,
        host_build_version: "old-host".into(),
        lifecycle: LifecycleState::Observing,
        host_process: ProcessProof {
            process_id: 1,
            start_marker: "start".into(),
        },
        provider_process: None,
        earliest_retained_output_seq: 1,
        current_output_seq: 1,
        controller_generation: 1,
        authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
    }))
}

fn framed(payload: Vec<u8>) -> Vec<u8> {
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend(payload);
    frame
}

fn binary(id: u64, body: terminal_state_record::Body, epoch: &str) -> Vec<u8> {
    framed(
        encode_record(
            id,
            &TerminalStateRecord {
                schema_minor: u32::from(PROTOCOL_MINOR),
                terminal_epoch: epoch.into(),
                through_output_seq: 1,
                state_revision: 1,
                body: Some(body),
            },
        )
        .unwrap(),
    )
}

fn resize(id: u64, generation: u64, columns: u32) -> Vec<u8> {
    binary(
        id,
        terminal_state_record::Body::InputIntent(InputIntent {
            intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                columns,
                rows: 24,
                geometry_generation: generation,
            })),
        }),
        "epoch",
    )
}

fn receipt(id: u64, applied: bool) -> Vec<u8> {
    binary(
        id + 100,
        terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
            in_reply_to_record_id: id,
            outcome: Some(if applied {
                resize_receipt::Outcome::AppliedToTerminal(ResizeAppliedToTerminal {
                    columns: 38,
                    rows: 24,
                })
            } else {
                resize_receipt::Outcome::Refused(ResizeRefused { reason: 1 })
            }),
        }),
        "epoch",
    )
}

fn connected(registry: &Arc<TerminalWidths>, route: Route) -> Arc<ConnectionObserver> {
    let observer = registry.connect(route);
    observer.observe(Direction::Upstream, &hello());
    observer.observe(Direction::Downstream, &ack(fence(), true));
    observer
}

fn propose(observer: &ConnectionObserver, id: u64, columns: u32) {
    observer.observe(Direction::Upstream, &resize(id, id, columns));
    observer.observe(Direction::Downstream, &receipt(id, true));
}

#[test]
fn publishes_requested_width_only_after_verified_success() {
    let registry = Arc::new(TerminalWidths::default());
    let observer = connected(&registry, Route::local());
    observer.observe(Direction::Upstream, &resize(1, 1, 53));
    assert!(registry.snapshot().observations.is_empty());
    observer.observe(Direction::Downstream, &receipt(99, true));
    assert!(registry.snapshot().observations.is_empty());
    observer.observe(Direction::Downstream, &receipt(1, true));
    assert_eq!(registry.snapshot().observations[0].columns, 53); // canonical receipt was38
    assert_eq!(registry.snapshot().observations[0].fence, fence());
}

#[test]
fn refusal_stale_generation_and_reordered_receipts_cannot_override_newer_width() {
    let registry = Arc::new(TerminalWidths::default());
    let observer = connected(&registry, Route::local());
    propose(&observer, 1, 53);
    observer.observe(Direction::Upstream, &resize(2, 2, 70));
    observer.observe(Direction::Downstream, &receipt(2, false));
    assert_eq!(registry.snapshot().observations[0].columns, 53);
    observer.observe(Direction::Upstream, &resize(3, 1, 90));
    observer.observe(Direction::Downstream, &receipt(3, true));
    assert_eq!(registry.snapshot().observations[0].columns, 53);
    observer.observe(Direction::Upstream, &resize(4, 4, 80));
    propose(&observer, 5, 60);
    observer.observe(Direction::Downstream, &receipt(4, true));
    assert_eq!(registry.snapshot().observations[0].columns, 60);
}

#[test]
fn wrong_fence_and_readonly_handshakes_never_publish() {
    for field in 0..9 {
        let registry = Arc::new(TerminalWidths::default());
        let observer = registry.connect(Route::local());
        let mut actual = fence();
        match field {
            0 => actual.workspace_id.push('x'),
            1 => actual.session_id.push('x'),
            2 => actual.runner_principal.push('x'),
            3 => actual.runner_instance.push('x'),
            4 => actual.channel_epoch += 1,
            5 => actual.host_instance_id.push('x'),
            6 => actual.terminal_epoch.push('x'),
            _ => {}
        }
        if field != 8 {
            observer.observe(Direction::Upstream, &hello());
        }
        observer.observe(Direction::Downstream, &ack(actual, field != 7));
        propose(&observer, 1, 53);
        assert!(registry.snapshot().observations.is_empty(), "case {field}");
    }
}

#[test]
fn connection_retirement_is_isolated_and_terminal_epoch_mismatch_fails_closed() {
    let registry = Arc::new(TerminalWidths::default());
    let local = connected(&registry, Route::local());
    let remote = connected(&registry, Route::remote("remote".into()));
    propose(&local, 1, 53);
    propose(&remote, 1, 80);
    assert_eq!(registry.snapshot().observations.len(), 2);
    local.close();
    propose(&local, 2, 100);
    assert_eq!(registry.snapshot().observations.len(), 1);
    assert_eq!(
        registry.snapshot().observations[0].route,
        Route::remote("remote".into())
    );
    remote.observe(
        Direction::Upstream,
        &binary(
            2,
            terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns: 90,
                    rows: 24,
                    geometry_generation: 2,
                })),
            }),
            "obsolete",
        ),
    );
    assert!(registry.snapshot().observations.is_empty());
    assert_eq!(registry.snapshot().revision, "4");
}

#[test]
fn pending_proposals_are_bounded_and_drop_retires_width() {
    let registry = Arc::new(TerminalWidths::default());
    let observer = connected(&registry, Route::local());
    propose(&observer, 1, 53);
    for id in 2..=MAX_PENDING_RESIZES as u64 + 2 {
        observer.observe(Direction::Upstream, &resize(id, id, 80));
    }
    assert!(registry.snapshot().observations.is_empty());
    observer.observe(Direction::Downstream, &receipt(2, true));
    assert!(registry.snapshot().observations.is_empty());
    let second = connected(&registry, Route::local());
    propose(&second, 1, 53);
    drop(second);
    assert!(registry.snapshot().observations.is_empty());
}

#[test]
fn unknown_and_oversized_frames_forward_unchanged_and_retire_only_observation() {
    for payload in [
        b"future-control-frame".to_vec(),
        vec![b'x'; MAX_OBSERVED_FRAME_BYTES + 1],
    ] {
        let registry = Arc::new(TerminalWidths::default());
        let observer = connected(&registry, Route::local());
        propose(&observer, 1, 53);
        let input = framed(payload);
        let mut output = Vec::new();
        copy_observed(
            &mut input.as_slice(),
            &mut output,
            Some(&observer),
            Direction::Upstream,
        )
        .unwrap();
        assert_eq!(input, output);
        assert!(registry.snapshot().observations.is_empty());
    }
}

#[test]
fn future_protobuf_fields_pass_through_byte_for_byte_and_eof_retires() {
    let registry = Arc::new(TerminalWidths::default());
    let observer = connected(&registry, Route::local());
    propose(&observer, 1, 53);
    let mut input = resize(2, 2, 80);
    input.extend([0xf8, 0x07, 0x01]);
    let length = input.len() as u32 - 4;
    input[..4].copy_from_slice(&length.to_be_bytes());
    let length = u32::from_le_bytes(input[12..16].try_into().unwrap()) + 3;
    input[12..16].copy_from_slice(&length.to_le_bytes());
    let mut output = Vec::new();
    copy_observed(
        &mut input.as_slice(),
        &mut output,
        Some(&observer),
        Direction::Upstream,
    )
    .unwrap();
    assert_eq!(input, output);
    assert!(registry.snapshot().observations.is_empty());
}
