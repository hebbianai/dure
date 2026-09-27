use super::*;
use hmux_client::{
    ConnectionRecord, LocalConnection, LocalSession, LocalSessionCatalog, StandaloneCreateRequest,
    StandaloneSessionCreator, TerminalSurfaceAccess, TerminalSurfaceAttachment,
};
use hmux_session_protocol::{AttachMode, Hello, VersionRange, WireFrame, PROTOCOL_V1};
use std::time::Duration;
use terminal_state_protocol::{
    encode_record_for_minor, InputIntent, ResizeInputIntent, TerminalStateRecord,
};

struct OwnedSession(LocalSession, LocalSessionCatalog);
impl Drop for OwnedSession {
    fn drop(&mut self) {
        self.0
            .terminate_standalone(&self.1, Duration::from_secs(5))
            .expect("retire this test's exact provider");
    }
}

fn framed(payload: &[u8]) -> Vec<u8> {
    let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(payload);
    bytes
}

fn resize(
    connection: &mut LocalConnection,
    observer: Option<&ConnectionObserver>,
    id: u64,
    generation: u64,
    columns: u32,
) -> bool {
    let minor = connection
        .initial_terminal_state()
        .unwrap()
        .records()
        .filter_map(|record| decode_record(record).ok())
        .map(|record| record.metadata.protocol_minor)
        .min()
        .unwrap();
    let bytes = encode_record_for_minor(
        minor,
        id,
        &TerminalStateRecord {
            schema_minor: minor.into(),
            terminal_epoch: connection.hello_ack().actual_fence.terminal_epoch.clone(),
            through_output_seq: 0,
            state_revision: 1,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns,
                    rows: 24,
                    geometry_generation: generation,
                })),
            })),
        },
    )
    .unwrap();
    if let Some(observer) = observer {
        observer.observe(Direction::Upstream, &framed(&bytes));
    }
    connection
        .terminal_input_writer_capability()
        .unwrap()
        .send_input_envelope(&bytes)
        .unwrap();
    loop {
        if let ConnectionRecord::TerminalState(payload) = connection.read_record().unwrap() {
            if let Some(observer) = observer {
                observer.observe(Direction::Downstream, &framed(&payload));
            }
            match decode_record(&payload).unwrap().record.body {
                Some(terminal_state_record::Body::ResizeReceipt(receipt))
                    if receipt.in_reply_to_record_id == id =>
                {
                    return matches!(
                        receipt.outcome,
                        Some(resize_receipt::Outcome::AppliedToTerminal(_))
                    );
                }
                _ => {}
            }
        }
    }
}

#[test]
#[ignore = "requires disposable HOME/DURE_HOME, the Hmux QA runner, and DURE_TEST_OLD_HMUX_RUNTIME"]
fn old_host_follows_phone_width_on_same_desktop_attachment() {
    let runtime =
        std::env::var_os("DURE_TEST_OLD_HMUX_RUNTIME").expect("explicit old immutable runtime");
    let discovery = std::env::var_os("HMUX_DISCOVERY_ROOT").expect("isolated QA discovery");
    let cwd = tempfile::tempdir().unwrap();
    let created = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(&discovery)
        .create(
            StandaloneCreateRequest::new(
                cwd.path().canonicalize().unwrap(),
                Some("hub-width-compat-smoke".into()),
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf HUB_WIDTH_READY; sleep 60".into(),
                ],
                24,
                38,
            )
            .unwrap(),
        )
        .unwrap();
    let session = OwnedSession(
        created.session().clone(),
        LocalSessionCatalog::new(&discovery),
    );
    let connect = || {
        let mut connection = session
            .0
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::Writer,
                None,
            ))
            .unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        connection
    };
    let mut desktop = connect();
    let mut phone = connect();
    let fence = desktop.hello_ack().actual_fence.clone();
    let provider = desktop.hello_ack().provider_process.clone();
    let host = desktop.hello_ack().host_process.clone();
    assert!(resize(&mut desktop, None, 1, 1, 38));
    let registry = Arc::new(TerminalWidths::default());
    let observer = registry.connect(Route::local());
    let ack = phone.hello_ack().clone();
    let codec = FrameCodec::new(Default::default());
    let hello = Hello {
        supported_versions: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        requested_capabilities: ack.selected_capabilities.clone(),
        expected_fence: ack.actual_fence.clone(),
        requested_mode: AttachMode::Observer,
        reconnect_cursor: None,
        capability_token: "observation-fixture".into(),
        authorization_proof_reference: None,
        initial_snapshot_profile: None,
    };
    observer.observe(
        Direction::Upstream,
        &codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::Hello(hello),
            })
            .unwrap(),
    );
    observer.observe(
        Direction::Downstream,
        &codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    );
    assert!(resize(&mut phone, Some(&observer), 1, 1, 53));
    assert_eq!(session.0.read_screen(None).unwrap().columns, 38);
    assert_eq!(registry.snapshot().observations[0].columns, 53);
    assert!(resize(
        &mut desktop,
        None,
        2,
        2,
        registry.snapshot().observations[0].columns
    ));
    let expanded = session.0.read_screen(None).unwrap();
    assert_eq!(expanded.columns, 53);
    assert_eq!(expanded.fence, fence);
    assert!(!resize(&mut phone, Some(&observer), 2, 1, 80));
    assert_eq!(registry.snapshot().observations[0].columns, 53);
    phone.detach("test_phone_closed").unwrap();
    observer.close();
    assert!(registry.snapshot().observations.is_empty());
    assert!(resize(&mut desktop, None, 3, 3, 38));
    let restored = session.0.read_screen(None).unwrap();
    assert_eq!(restored.columns, 38);
    assert_eq!(restored.fence, fence);
    let verify = connect();
    assert_eq!(verify.hello_ack().provider_process, provider);
    assert_eq!(verify.hello_ack().host_process, host);
    assert_eq!(verify.hello_ack().actual_fence, fence);
    desktop.detach("test_desktop_closed").unwrap();
    println!("old Host: desktop38 + phone53 -> canonical38; same desktop writer53 -> canonical53; stale phone resize refused; phone departure + same desktop writer38 -> canonical38; provider/Host/epoch unchanged");
}
