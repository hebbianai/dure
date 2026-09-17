use super::*;
use crate::hub::{
    catalog::{HubCatalog, HUB_CATALOG_VERSION},
    devices::DeviceRegistry,
    identity,
    server::{CatalogSource, HubServer, HubServices},
};
use base64::Engine as _;
use dure_hub_protocol::hello;
use std::net::TcpStream;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

struct EmptyCatalog;
impl CatalogSource for EmptyCatalog {
    fn catalog(&self) -> HubCatalog {
        HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: vec![],
            unreachable: vec![],
        }
    }
}
struct Writer(Arc<AtomicUsize>);
impl SessionFileSink for Writer {
    fn deliver(&self, request: SessionFileRequest) -> SessionFileResult {
        assert_eq!(request.session_id, "paste-session");
        self.0.fetch_add(1, Ordering::SeqCst);
        let payload = serde_json::from_value(serde_json::to_value(request.file).unwrap()).unwrap();
        match crate::dropped_files::save_temp_files(vec![payload]) {
            Ok(paths) => SessionFileResult::Saved {
                path: paths[0].clone(),
            },
            Err(detail) => SessionFileResult::refused(detail),
        }
    }
}
struct TestHub {
    server: HubServer,
    _root: tempfile::TempDir,
    tls: rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    token: String,
    writes: Arc<AtomicUsize>,
}
impl Drop for TestHub {
    fn drop(&mut self) {
        self.server.stop();
    }
}

fn connect() -> TestHub {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let root = tempfile::tempdir().unwrap();
    let certificate = identity::load_or_create_certificate(root.path()).unwrap();
    let registry = Arc::new(DeviceRegistry::new(root.path()));
    let token = registry.register("test phone".into()).unwrap().token;
    let writes = Arc::new(AtomicUsize::new(0));
    let server = HubServer::default();
    let port = server
        .start_with_gateway(
            "127.0.0.1",
            0,
            &certificate,
            registry,
            HubServices::catalog_only(Arc::new(EmptyCatalog))
                .receiving_files(Arc::new(Writer(writes.clone()))),
        )
        .unwrap()
        .port
        .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(certificate.der))
        .unwrap();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let tls = rustls::StreamOwned::new(
        rustls::ClientConnection::new(Arc::new(config), "hebbian-hub.local".try_into().unwrap())
            .unwrap(),
        socket,
    );
    TestHub {
        server,
        _root: root,
        tls,
        token,
        writes,
    }
}

fn hello(hub: &mut TestHub, token: &str) {
    let bytes = hello::encode_hello_for(
        token,
        hello::HubRequest::StageSessionFileV1 {
            session_id: "paste-session".into(),
        },
    )
    .unwrap();
    hub.tls.write_all(&bytes).unwrap();
    hub.tls.flush().unwrap();
}

#[test]
fn paired_tls_paste_preserves_bytes_in_the_existing_private_file_writer() {
    let mut hub = connect();
    let token = hub.token.clone();
    hello(&mut hub, &token);
    hello::read_ack(&mut hub.tls).unwrap();
    // Larger than a terminal frame: the file lane never expands terminal limits.
    let bytes = vec![0x89; 2 * 1024 * 1024];
    session_file::write_file(
        &mut hub.tls,
        &SessionFile {
            file_name: "pasted-image.png".into(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        },
    )
    .unwrap();
    let answer: SessionFileResult =
        frame::read(&mut hub.tls, session_file::MAX_RESULT_BYTES).unwrap();
    let SessionFileResult::Saved { path } = answer else {
        panic!("file was not staged")
    };
    assert!(std::fs::read(&path).unwrap() == bytes);
    assert_eq!(hub.writes.load(Ordering::SeqCst), 1);
    let parent = std::path::Path::new(&path).parent().unwrap();
    assert!(parent
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("agent-ide-drop-"));
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(parent).unwrap();
}

#[test]
fn unpaired_tls_peer_cannot_dispatch_a_file_write() {
    let mut hub = connect();
    hello(&mut hub, "unregistered-token");
    assert!(hello::read_ack(&mut hub.tls).is_err());
    assert_eq!(hub.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn oversized_file_frame_is_refused_before_dispatch_or_body_allocation() {
    let mut hub = connect();
    let token = hub.token.clone();
    hello(&mut hub, &token);
    hello::read_ack(&mut hub.tls).unwrap();
    hub.tls
        .write_all(&((session_file::MAX_FILE_FRAME_BYTES + 1) as u32).to_be_bytes())
        .unwrap();
    hub.tls.flush().unwrap();
    let reply: SessionFileResult =
        frame::read(&mut hub.tls, session_file::MAX_RESULT_BYTES).unwrap();
    assert!(matches!(reply, SessionFileResult::Refused { .. }));
    assert_eq!(hub.writes.load(Ordering::SeqCst), 0);
}
