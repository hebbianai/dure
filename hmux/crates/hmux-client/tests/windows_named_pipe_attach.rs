#![cfg(windows)]

use hmux_client::{LocalAttachRole, LocalSession};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryManifest, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind,
    ManifestCommon, ReadyManifest, SessionClass,
};
use hmux_local_platform::local_peer_identity::verify_named_pipe_same_user;
use hmux_session_protocol::{
    AuthorizationPosture, FrameBody, FrameCodec, FrameLimits, Hello, HelloAck, LifecycleState,
    PROTOCOL_V1, ProcessProof, RuntimeContext, SHARED_TERMINAL_INPUT_CAPABILITY, ScreenSnapshot,
    ScreenSnapshotEncoding, SessionFence, VersionRange, WireFrame,
};
use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{
    ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, FlushFileBuffers,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};

static NEXT_PIPE: AtomicU64 = AtomicU64::new(1);
const CAPABILITY_TOKEN: &str = "windows-native-attach-secret";

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace-1".into(),
        session_id: "session-1".into(),
        runner_principal: "runner".into(),
        runner_instance: "runner-1".into(),
        channel_epoch: 1,
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
    }
}

fn process() -> ProcessProof {
    ProcessProof {
        process_id: std::process::id(),
        start_marker: "windows-native-fixture".into(),
    }
}

fn manifest(address: String) -> DiscoveryManifest {
    DiscoveryManifest::Ready(ReadyManifest {
        common: ManifestCommon {
            schema_version: 1,
            host_build_version: "test".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: vec![
                "screen_snapshot".into(),
                "live_output".into(),
                "terminal_input".into(),
                "terminal_resize".into(),
                SHARED_TERMINAL_INPUT_CAPABILITY.into(),
            ],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: process(),
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: None,
            retirement_policy: None,
            launch_program: None,
        },
        provider_process: process(),
        terminal_epoch: "terminal-1".into(),
        ready_output_seq: 1,
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::WindowsNamedPipe,
            address,
        },
        capability_token: CAPABILITY_TOKEN.into(),
        ready_unix_ms: 1,
    })
}

fn ack() -> HelloAck {
    HelloAck {
        selected_version: PROTOCOL_V1,
        selected_capabilities: vec![
            "screen_snapshot".into(),
            "live_output".into(),
            "terminal_input".into(),
            "terminal_resize".into(),
            SHARED_TERMINAL_INPUT_CAPABILITY.into(),
        ],
        actual_fence: fence(),
        host_build_version: "test".into(),
        lifecycle: LifecycleState::Observing,
        host_process: process(),
        provider_process: Some(process()),
        earliest_retained_output_seq: 1,
        current_output_seq: 1,
        controller_generation: 1,
        authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
    }
}

fn snapshot() -> ScreenSnapshot {
    ScreenSnapshot {
        fence: fence(),
        sequence_through: 1,
        rows: 24,
        columns: 80,
        encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
        controller_input_pending: None,
        semantic_idle_ms: None,
        repaint_bytes: b"windows-native".to_vec(),
        alternate_screen: false,
        cursor_visible: true,
        truncated: false,
        working_directory: None,
        execution_location: None,
        agent_identity: None,
        agent_runtime_state: None,
        provider_conversation_identity: None,
        recovered_presentation: None,
        actual_profile: None,
        in_reply_to_request_id: None,
    }
}

fn connect_server(handle: &File) {
    // SAFETY: handle is a live server-side named-pipe handle.
    if unsafe { ConnectNamedPipe(handle.as_raw_handle().cast(), null_mut()) } == 0 {
        let error = io::Error::last_os_error();
        assert_eq!(
            error.raw_os_error(),
            Some(i32::try_from(ERROR_PIPE_CONNECTED).unwrap())
        );
    }
}

fn open_cleanup_client(encoded_address: &[u16]) {
    // SAFETY: encoded_address is NUL-terminated and remains live for the call.
    let raw = unsafe {
        CreateFileW(
            encoded_address.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if raw != INVALID_HANDLE_VALUE {
        // SAFETY: CreateFileW returned one owned live handle.
        drop(unsafe { OwnedHandle::from_raw_handle(raw.cast()) });
    }
}

#[test]
fn native_windows_attach_uses_named_pipe_and_session_bound_attestation() {
    let sequence = NEXT_PIPE.fetch_add(1, Ordering::Relaxed);
    let address = format!(
        r"\\.\pipe\hmux-client-attach-{}-{sequence}",
        std::process::id()
    );
    let mut encoded_address = address.encode_utf16().collect::<Vec<_>>();
    encoded_address.push(0);
    // SAFETY: encoded_address is a live NUL-terminated pipe name. Ownership of
    // a successful handle moves immediately into File.
    let raw = unsafe {
        CreateNamedPipeW(
            encoded_address.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            64 * 1024,
            64 * 1024,
            0,
            null(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    // SAFETY: CreateNamedPipeW returned one owned live handle.
    let server = unsafe { File::from_raw_handle(raw.cast()) };

    let host = std::thread::spawn(move || {
        connect_server(&server);
        let codec = FrameCodec::new(FrameLimits::default());
        let Ok(frame) = codec.read_from(&mut &server) else {
            return None;
        };
        let credential = verify_named_pipe_same_user(server.as_raw_handle()).unwrap();
        let FrameBody::Hello(Hello {
            expected_fence,
            capability_token,
            ..
        }) = frame.body
        else {
            panic!("first Windows named-pipe frame must be Hello");
        };
        assert_eq!(expected_fence, fence());
        assert_eq!(capability_token, CAPABILITY_TOKEN);
        assert_eq!(
            credential.identity(),
            &hmux_local_platform::local_peer_identity::current_user_identity().unwrap()
        );

        codec
            .write_to(
                &mut &server,
                &WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::HelloAck(ack()),
                },
            )
            .unwrap();
        codec
            .write_to(
                &mut &server,
                &WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 2,
                    body: FrameBody::ScreenSnapshot(snapshot()),
                },
            )
            .unwrap();
        // SAFETY: server is still the connected pipe end. Waiting until the
        // client drains both frames prevents close from discarding fixture
        // bytes before LocalSession has observed its initial snapshot.
        assert_ne!(
            unsafe { FlushFileBuffers(server.as_raw_handle().cast()) },
            0
        );
        Some(expected_fence)
    });

    let session = LocalSession::from_manifest(manifest(address)).unwrap();
    let connection = session.connect(LocalAttachRole::SharedWriter, None);
    if connection.is_err() {
        open_cleanup_client(&encoded_address);
    }
    let observed_fence = host.join().unwrap();
    let connection = connection.expect("native Windows must attach through the manifest pipe");

    assert_eq!(observed_fence, Some(fence()));
    assert_eq!(
        connection.require_initial_snapshot().unwrap().repaint_bytes,
        b"windows-native"
    );
}
