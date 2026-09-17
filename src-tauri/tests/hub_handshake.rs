//! 진짜 TLS 소켓 위에서 붙는 것까지.
//!
//! 단위 시험은 가짜 스트림 위에서 판단만 본다 — 길이 상한, 판 확인, 상수 시간
//! 비교. 그것들이 다 맞아도 조립이 틀리면 앱을 켜 봐야만 드러난다: 인증서가
//! rustls 가 받는 모양이 아니거나, 지문이 폰이 보는 것과 다르거나, 프레임이
//! TLS 레코드 경계에서 갈라질 때.
//!
//! 그래서 여기서는 실제로 소켓을 열고, 실제 TLS 핸드셰이크를 하고, 폰이 하는
//! 것과 같은 고정 검사를 한 뒤 인증을 통과시킨다.

use agent_ide_lib::hub::identity::{self, fingerprint_of_der, mint_token};
use agent_ide_lib::hub::listener;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

/// 폰이 하는 일: 고정해 둔 지문과 같은 인증서만 받아들인다.
///
/// 이름을 검사하지 않는다. 자체 서명이고 인증 기관이 없으므로 이름은 아무것도
/// 증명하지 않는다 — 신뢰의 출발점은 책상에서 QR 을 스캔한 그 순간 하나뿐이고,
/// 거기서 받은 것이 이 지문이다. SSH 호스트 키를 고정하는 것과 같은 모양이다.
#[derive(Debug)]
struct PinnedFingerprint {
    expected: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedFingerprint {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if fingerprint_of_der(end_entity) == self.expected {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "인증서 지문이 고정해 둔 값과 다릅니다".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn client_config(expected: String) -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("기본 프로토콜 판")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedFingerprint { expected, provider }))
        .with_no_client_auth();
    Arc::new(config)
}

struct Hub {
    port: u16,
    fingerprint: String,
    _directory: tempfile::TempDir,
    handle: Option<std::thread::JoinHandle<Result<String, String>>>,
}

/// 리스너를 하나 띄우고 연결 하나를 받는다.
///
/// 한 번만 받는 이유: 이 시험이 보는 것은 붙는 과정이고, 스레드가 남으면 시험이
/// 끝나도 프로세스가 정리되지 않는다.
fn start_hub(devices: Vec<identity::DeviceToken>) -> Hub {
    let directory = tempfile::tempdir().expect("임시 디렉터리");
    let certificate =
        identity::load_or_create_certificate(directory.path()).expect("인증서를 만든다");
    let fingerprint = certificate.fingerprint();
    let config = listener::server_config(&certificate).expect("서버 설정");

    // 포트 0: OS 가 빈 포트를 고른다. 고정 포트를 쓰면 시험 두 개가 동시에 돌 때
    // 하나가 "주소 사용 중" 으로 죽고, 그건 이 시험이 보려는 것과 무관하다.
    let socket = listener::bind("127.0.0.1", 0).expect("리스너를 연다");
    let port = socket.local_addr().expect("주소").port();

    let handle = std::thread::spawn(move || {
        let (stream, _) = socket.accept().map_err(|error| error.to_string())?;
        let mut tls = listener::accept_tls(stream, config).map_err(|error| error.to_string())?;
        match listener::read_hello(&mut tls, &devices) {
            Ok(hello) => {
                let device = hello.device.clone();
                listener::write_ack(&mut tls, &device).map_err(|error| error.to_string())?;
                Ok(device.device_id)
            }
            Err(error) => Err(error.to_string()),
        }
    });

    Hub {
        port,
        fingerprint,
        _directory: directory,
        handle: Some(handle),
    }
}

/// 폰이 하는 것: 지문을 고정해 붙고, 토큰을 보내고, 답을 읽는다.
fn dial(hub: &Hub, pinned: &str, token: &str) -> Result<listener::HubHelloAck, String> {
    let mut tls = connect(hub.port, pinned, token)?;
    serde_json::from_slice(&read_frame(&mut tls)?).map_err(|error| error.to_string())
}

type PhoneStream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// 붙어서 인사까지 보낸 스트림. 그 뒤에 무엇이 오는지는 부르는 쪽이 정한다.
fn connect(port: u16, pinned: &str, token: &str) -> Result<PhoneStream, String> {
    let config = client_config(pinned.to_string());
    let server_name = rustls::pki_types::ServerName::try_from("hebbian-hub.local")
        .map_err(|error| error.to_string())?;
    let connection =
        rustls::ClientConnection::new(config, server_name).map_err(|error| error.to_string())?;
    let socket = TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    let mut tls = rustls::StreamOwned::new(connection, socket);

    let hello = listener::encode_hello(token).map_err(|error| error.to_string())?;
    tls.write_all(&hello).map_err(|error| error.to_string())?;
    tls.flush().map_err(|error| error.to_string())?;
    Ok(tls)
}

/// 길이 접두 프레임 하나.
fn read_frame<S: Read>(stream: &mut S) -> Result<Vec<u8>, String> {
    let mut length = [0u8; 4];
    stream
        .read_exact(&mut length)
        .map_err(|error| error.to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    Ok(body)
}

/// 조립 전체. 인증서가 rustls 가 받는 모양이고, 지문이 폰이 보는 것과 같고,
/// 프레임이 TLS 위에서 온전히 건너간다.
#[test]
fn a_paired_phone_connects_over_tls_and_is_recognised() {
    let phone = mint_token("phone".into(), "내 폰".into()).expect("토큰");
    let mut hub = start_hub(vec![phone.clone()]);

    let ack = dial(&hub, &hub.fingerprint.clone(), &phone.token).expect("붙는다");

    assert_eq!(ack.device_id, "phone");
    assert_eq!(ack.device_label, "내 폰");
    assert_eq!(
        hub.handle.take().unwrap().join().unwrap(),
        Ok("phone".to_string())
    );
}

/// 지문 고정이 실제로 무언가를 막는다.
///
/// 이 시험이 없으면 고정 코드가 항상 참을 돌려줘도 위 시험은 통과한다 — 그리고
/// 그 상태에서는 아무 기계나 이 허브인 척할 수 있다.
#[test]
fn a_different_fingerprint_is_refused_before_any_token_is_sent() {
    let phone = mint_token("phone".into(), "내 폰".into()).expect("토큰");
    let mut hub = start_hub(vec![phone.clone()]);

    // 다른 기계의 지문. 형식은 맞고 값만 다르다.
    let other = tempfile::tempdir().unwrap();
    let elsewhere = identity::load_or_create_certificate(other.path())
        .unwrap()
        .fingerprint();
    assert_ne!(elsewhere, hub.fingerprint);

    let error = dial(&hub, &elsewhere, &phone.token).expect_err("고정이 막아야 한다");

    assert!(
        error.contains("지문") || error.to_lowercase().contains("certificate"),
        "{error}"
    );
    // 서버 쪽도 토큰을 본 적이 없어야 한다 — 핸드셰이크에서 끊겼으므로.
    let served = hub.handle.take().unwrap().join().unwrap();
    assert!(served.is_err(), "{served:?}");
}

/// 등록되지 않은 기기는 TLS 를 통과해도 거부된다. 기계의 신원과 기기의 인증은
/// 다른 질문이고, 둘 다 답해야 한다.
#[test]
fn a_valid_fingerprint_with_a_wrong_token_still_gets_nothing() {
    let phone = mint_token("phone".into(), "내 폰".into()).expect("토큰");
    let stranger = mint_token("stranger".into(), "남".into()).expect("토큰");
    let mut hub = start_hub(vec![phone]);

    let result = dial(&hub, &hub.fingerprint.clone(), &stranger.token);

    assert!(result.is_err(), "{result:?}");
    let served = hub.handle.take().unwrap().join().unwrap();
    assert_eq!(
        served,
        Err("이 기기는 이 허브에 등록되어 있지 않습니다".to_string())
    );
}

// ---------------------------------------------------------------------------
// 리스너 수명 — 위 시험들은 연결 하나를 손으로 받는다. 아래는 진짜 `HubServer`
// 를 켜고, 그것이 목록을 흘리는지와 취소가 재시작 없이 먹히는지를 본다.
// ---------------------------------------------------------------------------

use agent_ide_lib::hub::catalog::{HubCatalog, HubCatalogEntry, HUB_CATALOG_VERSION};
use agent_ide_lib::hub::devices::DeviceRegistry;
use agent_ide_lib::hub::server::{CatalogSource, HubServer};

struct OneSession;

impl CatalogSource for OneSession {
    fn catalog(&self) -> HubCatalog {
        HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: vec![HubCatalogEntry {
                launch_program: None,
                session_id: "standalone_abc".into(),
                session_name: Some("feat/mobile".into()),
                display_title: Some("mobile".into()),
                presentation: None,
                workspace_id: "workspace_1".into(),
                session_class: "standalone".into(),
                lifecycle: "ready".into(),
                provider_id: "claude-code".into(),
                runner_principal: "local-user".into(),
                runner_instance: "runner_1".into(),
                channel_epoch: "1".into(),
                host_instance_id: "host_1".into(),
                terminal_epoch: "terminal_1".into(),
                capabilities: vec!["live_output".into()],
                box_id: "this-laptop".into(),
                box_label: "내 노트북".into(),
            }],
            unreachable: Vec::new(),
        }
    }
}

struct RunningHub {
    server: HubServer,
    port: u16,
    fingerprint: String,
    registry: std::sync::Arc<DeviceRegistry>,
    _directory: tempfile::TempDir,
}

fn run_hub() -> RunningHub {
    let directory = tempfile::tempdir().expect("임시 디렉터리");
    let certificate =
        identity::load_or_create_certificate(directory.path()).expect("인증서를 만든다");
    let registry = std::sync::Arc::new(DeviceRegistry::new(directory.path()));
    let server = HubServer::default();
    let status = server
        .start(
            "127.0.0.1",
            0,
            &certificate,
            registry.clone(),
            std::sync::Arc::new(OneSession),
        )
        .expect("허브가 선다");

    RunningHub {
        server,
        port: status.port.expect("포트"),
        fingerprint: status.fingerprint.expect("지문"),
        registry,
        _directory: directory,
    }
}

/// 붙은 폰이 실제로 세션 목록을 받는다. 여기까지 와야 폰 화면에 무언가 뜬다.
#[test]
fn an_authenticated_phone_receives_the_session_catalog() {
    let hub = run_hub();
    let phone = hub.registry.register("내 폰".into()).expect("등록");

    let mut tls = connect(hub.port, &hub.fingerprint, &phone.token).expect("붙는다");
    let ack: listener::HubHelloAck =
        serde_json::from_slice(&read_frame(&mut tls).unwrap()).unwrap();
    let catalog: HubCatalog = serde_json::from_slice(&read_frame(&mut tls).unwrap()).unwrap();

    assert_eq!(ack.device_label, "내 폰");
    assert_eq!(catalog.hub_catalog_version, HUB_CATALOG_VERSION);
    assert_eq!(catalog.sessions.len(), 1);
    assert_eq!(catalog.sessions[0].session_id, "standalone_abc");
    // 폰이 attach 할 때 쓸 좌표가 실제로 건너왔는지.
    assert_eq!(catalog.sessions[0].host_instance_id, "host_1");
    hub.server.stop();
}

/// 인증을 통과하지 못한 쪽은 목록을 보지 못한다. ack 가 오지 않는 것만 보면
/// "느린 것" 과 구별되지 않으므로, 목록 프레임까지 오지 않는 것을 본다.
#[test]
fn an_unregistered_phone_gets_no_catalog() {
    let hub = run_hub();
    hub.registry.register("내 폰".into()).expect("등록");
    let stranger = mint_token("stranger".into(), "남".into()).unwrap();

    let mut tls = connect(hub.port, &hub.fingerprint, &stranger.token).expect("TLS 는 선다");

    assert!(read_frame(&mut tls).is_err());
    hub.server.stop();
}

/// 취소가 앱을 다시 켤 때까지 미뤄지면, 잃어버린 폰을 지운 사람은 지워졌다고
/// 믿는 동안 그 폰이 계속 붙어 있다.
#[test]
fn revoking_a_device_takes_effect_without_restarting_the_hub() {
    let hub = run_hub();
    let phone = hub.registry.register("내 폰".into()).expect("등록");

    // 먼저 붙는 것을 확인한다 — 아래 거부가 다른 이유로 일어난 것이 아님을
    // 같은 실행 안에서 보이기 위해서다.
    let mut before = connect(hub.port, &hub.fingerprint, &phone.token).expect("붙는다");
    assert!(read_frame(&mut before).is_ok());

    assert!(hub.registry.revoke(&phone.device_id).expect("취소"));

    let mut after = connect(hub.port, &hub.fingerprint, &phone.token).expect("TLS 는 선다");
    assert!(read_frame(&mut after).is_err(), "취소된 토큰이 아직 통한다");
    hub.server.stop();
}

/// 등록도 마찬가지다 — 페어링은 허브가 이미 돌고 있을 때 일어난다. 켤 때 찍은
/// 스냅샷을 들고 있으면 방금 페어링한 폰이 앱을 다시 켤 때까지 붙지 못한다.
#[test]
fn a_device_paired_while_the_hub_runs_can_connect_immediately() {
    let hub = run_hub();

    let phone = hub
        .registry
        .register("갓 페어링한 폰".into())
        .expect("등록");

    let mut tls = connect(hub.port, &hub.fingerprint, &phone.token).expect("붙는다");
    let ack: listener::HubHelloAck =
        serde_json::from_slice(&read_frame(&mut tls).unwrap()).unwrap();
    assert_eq!(ack.device_label, "갓 페어링한 폰");
    hub.server.stop();
}

/// 끈 뒤에는 아무도 붙지 못한다. 스위치가 실제로 무언가를 끄지 않으면, 끈 줄 아는
/// 사람의 노트북이 계속 열려 있다.
#[test]
fn a_stopped_hub_refuses_the_connection_entirely() {
    let hub = run_hub();
    let phone = hub.registry.register("내 폰".into()).expect("등록");

    hub.server.stop();

    let result =
        connect(hub.port, &hub.fingerprint, &phone.token).and_then(|mut tls| read_frame(&mut tls));
    assert!(result.is_err(), "{result:?}");
}

/// 이 기계의 진짜 세션 목록을 흘려 본다.
///
/// 결과가 기계 상태에 달려 있어 평소에는 돌지 않는다(`--ignored`). 위 시험들은
/// 고정 픽스처를 쓰므로 "리스너가 목록을 흘린다"까지만 보이고, 그 목록을 만드는
/// `LocalSessions` 가 실제 discovery root 를 읽는지는 보지 못한다.
///
/// ```sh
/// cargo test --test hub_handshake -- --ignored --nocapture local_catalog
/// ```
#[test]
#[ignore = "이 기계에 실제로 도는 세션에 달려 있다"]
fn the_real_local_catalog_reaches_a_phone() {
    use agent_ide_lib::hub::server::LocalSessions;

    let directory = tempfile::tempdir().expect("임시 디렉터리");
    let certificate =
        identity::load_or_create_certificate(directory.path()).expect("인증서를 만든다");
    let registry = std::sync::Arc::new(DeviceRegistry::new(directory.path()));
    let phone = registry.register("진단용 폰".into()).expect("등록");
    let server = HubServer::default();
    let status = server
        .start(
            "127.0.0.1",
            0,
            &certificate,
            registry,
            std::sync::Arc::new(LocalSessions {
                // 이 시험은 배치를 보지 않는다. 화면이 아직 아무것도 내려보내지
                // 않은 상태가 곧 기본값이고, 그때도 카탈로그는 나가야 한다.
                layout: std::sync::Arc::new(agent_ide_lib::hub::layout::LayoutState::default()),
                box_id: "this-laptop".into(),
                box_label: "이 노트북".into(),
            }),
        )
        .expect("허브가 선다");

    let mut tls = connect(
        status.port.unwrap(),
        status.fingerprint.as_deref().unwrap(),
        &phone.token,
    )
    .expect("붙는다");
    let _ack = read_frame(&mut tls).expect("ack");
    let catalog: HubCatalog = serde_json::from_slice(&read_frame(&mut tls).expect("목록")).unwrap();

    println!("지문: {}", status.fingerprint.unwrap());
    println!("세션 {}개", catalog.sessions.len());
    for session in &catalog.sessions {
        println!(
            "  {} [{}/{}] {} @{}",
            session.session_id,
            session.session_class,
            session.lifecycle,
            session.session_name.as_deref().unwrap_or("(이름 없음)"),
            session.box_label,
        );
    }
    for box_ in &catalog.unreachable {
        println!("  닿지 못함: {} — {}", box_.box_label, box_.detail);
    }
    server.stop();
}

/// 페이로드 하나만으로 붙는다.
///
/// 위 시험들은 지문과 토큰을 이미 손에 들고 시작한다 — 그건 페어링이 아직
/// 아무것도 옮기지 않았을 때도 통과한다. 여기서는 노트북이 만든 문자열 하나만
/// 넘겨받고, 폰이 아는 것은 그 문자열뿐이다. 실제 흐름과 같은 모양이다.
#[test]
fn a_phone_holding_only_the_qr_payload_can_reach_the_hub() {
    use agent_ide_lib::hub::pairing;
    use agent_ide_lib::hub::server::LocalSessions;

    // --- 노트북 쪽 ---
    let directory = tempfile::tempdir().expect("임시 디렉터리");
    let certificate =
        identity::load_or_create_certificate(directory.path()).expect("인증서를 만든다");
    let registry = std::sync::Arc::new(DeviceRegistry::new(directory.path()));
    let server = HubServer::default();
    let status = server
        .start(
            "127.0.0.1",
            0,
            &certificate,
            registry.clone(),
            std::sync::Arc::new(LocalSessions {
                // 이 시험은 배치를 보지 않는다. 화면이 아직 아무것도 내려보내지
                // 않은 상태가 곧 기본값이고, 그때도 카탈로그는 나가야 한다.
                layout: std::sync::Arc::new(agent_ide_lib::hub::layout::LayoutState::default()),
                box_id: "this-laptop".into(),
                box_label: "내 노트북".into(),
            }),
        )
        .expect("허브가 선다");
    let device = registry.register("내 폰".into()).expect("등록");
    let payload = pairing::encode(&pairing::offer_for(
        status.address.as_deref().unwrap(),
        status.port.unwrap(),
        status.fingerprint.as_deref().unwrap(),
        &device,
        "내 노트북",
        // 이 시험은 직결 경로만 본다. 릴레이는 자기 관통 시험을 따로 가진다
        // (`hub::relay_dial`).
        None,
        "hmux-pair:1?a=127.0.0.1&p=47821&t=token&k=ssh-ed25519&f=fingerprint&e=1",
    ));

    // --- 폰 쪽: 이 아래는 payload 말고 아무것도 쓰지 않는다 ---
    let offer = pairing::decode(&payload).expect("스캔한 것을 읽는다");
    let (host, port) = offer.endpoint.rsplit_once(':').expect("호스트:포트");
    assert_eq!(host, "127.0.0.1");
    let mut tls = connect(
        port.parse().expect("포트"),
        &offer.fingerprint,
        &offer.token,
    )
    .expect("페이로드에 담긴 것만으로 붙는다");
    let ack: listener::HubHelloAck =
        serde_json::from_slice(&read_frame(&mut tls).unwrap()).unwrap();

    assert_eq!(ack.device_label, "내 폰");
    assert_eq!(offer.box_label, "내 노트북");
    // 목록까지 온다 — 폰 화면에 무언가 뜬다는 뜻이다.
    assert!(read_frame(&mut tls).is_ok());
    server.stop();
}

/// 페이로드의 지문이 이 허브의 것이 아니면 붙지 못한다. 지문을 실어 보내는
/// 이유가 이것이므로, 그것이 실제로 비교되는지 같은 경로에서 확인한다.
#[test]
fn a_payload_carrying_another_machines_fingerprint_does_not_connect() {
    use agent_ide_lib::hub::pairing;

    let hub = run_hub();
    let device = hub.registry.register("내 폰".into()).expect("등록");
    let elsewhere = tempfile::tempdir().unwrap();
    let other_fingerprint = identity::load_or_create_certificate(elsewhere.path())
        .unwrap()
        .fingerprint();

    let payload = pairing::encode(&pairing::offer_for(
        "127.0.0.1",
        hub.port,
        &other_fingerprint,
        &device,
        "사칭",
        None,
        "hmux-pair:1?a=127.0.0.1&p=47821&t=token&k=ssh-ed25519&f=fingerprint&e=1",
    ));
    let offer = pairing::decode(&payload).expect("형식은 맞다");

    let result = connect(hub.port, &offer.fingerprint, &offer.token);
    assert!(result.is_err(), "고정이 막지 못했다");
    hub.server.stop();
}
