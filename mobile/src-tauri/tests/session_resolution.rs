//! Native mobile TLS -> authenticated Hub route -> real gateway -> durable rehost.
//! The loopback relay/Hub supplies routing only; no runtime answer is synthesized.
#![cfg(unix)]

use dure_hub_protocol::{fingerprint, frame, hello, relay};
use dure_mobile_lib::hub_client;
use hmux_client::{
    ManagedCreateBrokerResponse, ManagedCreateReceipt, ManagedCreateRequest,
    ManagedRehostBrokerResponse, ManagedRehostRecipe, ManagedRehostRequest,
    ManagedStopBrokerResponse, ManagedStopRequest, PermissionMode,
    ProviderConversationIdentitySeed, SessionFence, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_REHOST_BROKER_SUBCOMMAND, MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
};
use hmux_ssh_transport::session_resolution::SessionResolution;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{de::DeserializeOwned, Serialize};
use std::io::Write;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const LIMIT: usize = 1024 * 1024;

fn gateway() -> PathBuf {
    PathBuf::from(
        std::env::var_os("DURE_QA_HMUX_BIN").expect("set the prepared DURE_QA_HMUX_BIN path"),
    )
}

fn runtime() -> PathBuf {
    PathBuf::from(
        std::env::var_os("DURE_QA_HMUX_RUNTIME")
            .expect("set the prepared DURE_QA_HMUX_RUNTIME path"),
    )
}

fn broker<T: DeserializeOwned>(root: &Path, command: &str, request: &impl Serialize) -> T {
    let mut child = Command::new(runtime())
        .args(["--no-autostart", command])
        .env("HMUX_DISCOVERY_ROOT", root)
        .env_remove("HMUX_MANAGED_REHOST_SOURCE_DISCOVERY_ROOT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&frame::encode(request, LIMIT).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    frame::read(&mut output.stdout.as_slice(), LIMIT).unwrap()
}

fn fence(receipt: &ManagedCreateReceipt) -> SessionFence {
    let generation = receipt.generation_fence().unwrap();
    SessionFence {
        session_id: receipt.session_id().into(),
        workspace_id: receipt.workspace_id().into(),
        runner_principal: generation.runner_principal().into(),
        runner_instance: generation.runner_instance().into(),
        channel_epoch: generation.channel_epoch(),
        host_instance_id: generation.host_instance_id().into(),
        terminal_epoch: generation.terminal_epoch().into(),
    }
}

struct Fixture {
    state: tempfile::TempDir,
    root: PathBuf,
    current: SessionFence,
}

impl Fixture {
    fn start() -> Self {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        let request = ManagedCreateRequest::new(
            "hub-create",
            "hub-source",
            "hub-workspace",
            "codex",
            PermissionMode::BypassApprovals,
            state.path().canonicalize().unwrap(),
            vec!["/bin/sleep".into(), "60".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("codex", "hub-conversation").unwrap(),
        )
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "sleep 60".into(),
                    "--".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let ManagedCreateBrokerResponse::Completed(receipt) =
            broker(&root, MANAGED_CREATE_BROKER_SUBCOMMAND, &request)
        else {
            panic!("fixture source must start")
        };
        Self {
            state,
            root,
            current: fence(&receipt),
        }
    }

    fn rehost(&mut self) {
        let source = &self.current;
        let request = ManagedRehostRequest::new(
            "hub-rehost",
            &source.session_id,
            &source.workspace_id,
            &source.runner_principal,
            &source.runner_instance,
            source.channel_epoch,
            &source.host_instance_id,
            &source.terminal_epoch,
            true,
        )
        .unwrap();
        let ManagedRehostBrokerResponse::Completed(receipt) =
            broker(&self.root, MANAGED_REHOST_BROKER_SUBCOMMAND, &request)
        else {
            panic!("fixture rehost must complete")
        };
        self.current = fence(receipt.replacement_receipt());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let target = &self.current;
        let request =
            ManagedStopRequest::new("hub-cleanup", &target.session_id, &target.workspace_id)
                .unwrap()
                .with_expected_fence(
                    &target.runner_principal,
                    &target.runner_instance,
                    target.channel_epoch,
                    &target.host_instance_id,
                    &target.terminal_epoch,
                )
                .unwrap();
        let _: ManagedStopBrokerResponse =
            broker(&self.root, MANAGED_STOP_BROKER_SUBCOMMAND, &request);
    }
}

/// A local paired relay and Hub, forwarding the framed request to the real CLI.
fn query(
    root: PathBuf,
    box_id: &str,
    source: &SessionFence,
) -> SessionResolution<dure_mobile_lib::catalog::RemoteSession> {
    let certified = rcgen::generate_simple_self_signed(vec!["hub.invalid".into()]).unwrap();
    let certificate = CertificateDer::from(certified.cert.der().to_vec());
    let pin = fingerprint::of_der(&certificate);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certified.key_pair.serialize_der()));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![certificate], key)
    .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let selected_box = box_id.to_string();
    let served = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let request: relay::RelayHello =
            frame::read(&mut socket, relay::MAX_RELAY_FRAME_BYTES).unwrap();
        assert_eq!(request.server_id, "paired-hub");
        socket
            .write_all(
                &frame::encode(&relay::RelayAnswer::Paired, relay::MAX_RELAY_FRAME_BYTES).unwrap(),
            )
            .unwrap();
        let mut tls = rustls::StreamOwned::new(
            rustls::ServerConnection::new(Arc::new(config)).unwrap(),
            socket,
        );
        let hello = hello::read_hello(&mut tls).unwrap();
        assert_eq!(hello.token, "paired-device-token");
        assert_eq!(
            hello.request,
            hello::HubRequest::Attach {
                writable: false,
                box_id: selected_box
            }
        );
        tls.write_all(&hello::encode_ack("device", "test phone").unwrap())
            .unwrap();
        tls.flush().unwrap();
        let request: serde_json::Value = frame::read(&mut tls, LIMIT).unwrap();
        let mut child = Command::new(gateway())
            .arg("--discovery-root")
            .arg(root)
            .args(["mobile-gateway", "--role", "observer"])
            .env_remove("HMUX_MANAGED_REHOST_SOURCE_DISCOVERY_ROOT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&frame::encode(&request, LIMIT).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        tls.write_all(&output.stdout).unwrap();
        tls.flush().unwrap();
    });
    let result = hub_client::resolve_session_successor(
        "hub.invalid:6767",
        Some((&endpoint, "paired-hub")),
        &pin,
        "paired-device-token",
        box_id,
        source,
    );
    served.join().unwrap();
    result.unwrap()
}

#[test]
#[ignore = "requires prepared hmux and hmux-runtime; run under scripts/run-hmux-tests.mjs"]
fn a_native_mobile_reconnect_reads_the_exact_successor_on_local_and_remote_hub_routes() {
    let mut fixture = Fixture::start();
    let source = fixture.current.clone();
    fixture.rehost();
    assert_ne!(source.session_id, fixture.current.session_id);
    for box_id in ["local", "paired-remote-box"] {
        for _ in 0..2 {
            let SessionResolution::Resolved { session } =
                query(fixture.root.clone(), box_id, &source)
            else {
                panic!("completed rehost must resolve")
            };
            assert_eq!(session.fence().unwrap(), fixture.current);
        }
        let empty_box = fixture.state.path().join("other-box");
        std::fs::create_dir_all(&empty_box).unwrap();
        std::fs::set_permissions(&empty_box, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            query(empty_box, box_id, &source),
            SessionResolution::Unknown
        ));
    }
}
