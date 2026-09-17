//! 진짜 허브와 진짜 폰을 이 릴레이로 관통시킨다.
//!
//! # "릴레이는 읽을 수 없다" 를 어떻게 시험하나
//!
//! 이 프로세스의 메모리를 들여다보는 시험은 쓸모가 없다 — 오늘 안 읽는다는
//! 것만 말하고, 내일 읽게 되어도 그대로 통과한다.
//!
//! 대신 **구조**를 시험한다. 폰은 허브의 인증서 지문을 고정한 채 붙는다.
//! 릴레이가 내용을 읽으려면 TLS 를 자기가 종단해야 하고, 그러면 폰에게 자기
//! 인증서를 내밀어야 하며, 그 순간 고정이 깨져 핸드셰이크가 실패한다.
//! 그러므로 **고정된 핸드셰이크가 이 릴레이를 통과해 성립했다는 사실 자체가**
//! 릴레이가 평문을 보지 못했다는 증거다.

use dure_hub_protocol::frame::{self, FrameError};
use dure_hub_protocol::relay::{
    MAX_RELAY_FRAME_BYTES, RELAY_PROTOCOL_VERSION, RelayAnswer, RelayChallenge, RelayControlEvent,
    RelayHello, RelayProof, RelayRejection, RelayRole, RelayUnavailable, decode_nonce,
    encode_bytes, registration_transcript,
};
use dure_hub_protocol::{fingerprint, hello};
use dure_relay::{Relay, serve};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const SECRET: &[u8] = b"the terminal bytes the relay must never be able to read";

fn write_frame<T: serde::Serialize>(stream: &mut TcpStream, value: &T) {
    let framed = frame::encode(value, MAX_RELAY_FRAME_BYTES).expect("encodes");
    stream.write_all(&framed).expect("writes");
    stream.flush().expect("flushes");
}

fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut TcpStream) -> Result<T, FrameError> {
    frame::read(stream, MAX_RELAY_FRAME_BYTES)
}

/// 릴레이 하나를 띄운다.
fn start_relay() -> String {
    start_relay_with_handle().0
}

/// 같은 릴레이를, 등록 장부를 들여다볼 수 있는 손잡이와 함께.
fn start_relay_with_handle() -> (String, Arc<Relay>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("바인드");
    let endpoint = listener.local_addr().expect("주소").to_string();
    let relay = Arc::new(Relay::new());
    let served = Arc::clone(&relay);
    thread::spawn(move || serve(&listener, &served));
    (endpoint, relay)
}

/// 등록을 시도하고 릴레이의 답을 그대로 돌려준다. 거절도 답이다.
fn try_register_control(
    relay_endpoint: &str,
    server_id: &str,
    identity: &HubIdentity,
) -> RelayControlEvent {
    let mut control = TcpStream::connect(relay_endpoint).expect("control 연결");
    write_frame(
        &mut control,
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::HubControl,
            server_id: server_id.to_string(),
            connection_id: None,
        },
    );
    let challenge: RelayChallenge = read_frame(&mut control).expect("challenge");
    let nonce = decode_nonce(&challenge.nonce).expect("난수");
    let key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_ASN1_SIGNING,
        &identity.key_pkcs8,
        &SystemRandom::new(),
    )
    .expect("키");
    let signature = key
        .sign(
            &SystemRandom::new(),
            &registration_transcript(server_id, &nonce),
        )
        .expect("서명");
    write_frame(
        &mut control,
        &RelayProof {
            certificate_der: encode_bytes(&identity.certificate),
            signature: encode_bytes(signature.as_ref()),
        },
    );
    read_frame(&mut control).expect("등록 결과")
}

/// control 연결 하나를 등록까지만 밀고, 그 소켓을 돌려준다.
///
/// `spawn_hub` 와 달리 스레드를 남기지 않는다 — 등록의 수명 자체를 시험이
/// 쥐고 있어야, 끊기는 순간을 정확히 고를 수 있다.
fn register_control(relay_endpoint: &str, server_id: &str, identity: &HubIdentity) -> TcpStream {
    let mut control = TcpStream::connect(relay_endpoint).expect("control 연결");
    write_frame(
        &mut control,
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::HubControl,
            server_id: server_id.to_string(),
            connection_id: None,
        },
    );
    let challenge: RelayChallenge = read_frame(&mut control).expect("challenge");
    let nonce = decode_nonce(&challenge.nonce).expect("난수");
    let key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_ASN1_SIGNING,
        &identity.key_pkcs8,
        &SystemRandom::new(),
    )
    .expect("키");
    let signature = key
        .sign(
            &SystemRandom::new(),
            &registration_transcript(server_id, &nonce),
        )
        .expect("서명");
    write_frame(
        &mut control,
        &RelayProof {
            certificate_der: encode_bytes(&identity.certificate),
            signature: encode_bytes(signature.as_ref()),
        },
    );
    let registered: RelayControlEvent = read_frame(&mut control).expect("등록 결과");
    assert_eq!(registered, RelayControlEvent::Registered, "등록되어야 한다");
    control
}

/// 조건이 성립할 때까지 짧게 기다린다. 등록 정리는 릴레이의 다른 스레드가 한다.
fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if ready() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    ready()
}

struct HubIdentity {
    certificate: CertificateDer<'static>,
    key_pkcs8: Vec<u8>,
    fingerprint: String,
}

fn hub_identity() -> HubIdentity {
    let certified =
        rcgen::generate_simple_self_signed(vec!["hub.invalid".to_string()]).expect("인증서");
    let certificate = CertificateDer::from(certified.cert.der().to_vec());
    let fingerprint = fingerprint::of_der(&certificate);
    HubIdentity {
        certificate,
        key_pkcs8: certified.key_pair.serialize_der(),
        fingerprint,
    }
}

/// 노트북 흉내. 릴레이에 등록하고, 폰이 오면 데이터 연결을 열어 TLS 로 서빙한다.
fn spawn_hub(relay_endpoint: &str, server_id: &str, identity: &HubIdentity) {
    let relay_endpoint = relay_endpoint.to_string();
    let server_id = server_id.to_string();
    let certificate = identity.certificate.clone();
    let key_pkcs8 = identity.key_pkcs8.clone();

    thread::spawn(move || {
        let mut control = TcpStream::connect(&relay_endpoint).expect("control 연결");
        write_frame(
            &mut control,
            &RelayHello {
                relay_protocol_version: RELAY_PROTOCOL_VERSION,
                role: RelayRole::HubControl,
                server_id: server_id.clone(),
                connection_id: None,
            },
        );

        let challenge: RelayChallenge = read_frame(&mut control).expect("challenge");
        let nonce = decode_nonce(&challenge.nonce).expect("난수");
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_ASN1_SIGNING,
            &key_pkcs8,
            &SystemRandom::new(),
        )
        .expect("키");
        let signature = key
            .sign(
                &SystemRandom::new(),
                &registration_transcript(&server_id, &nonce),
            )
            .expect("서명");
        write_frame(
            &mut control,
            &RelayProof {
                certificate_der: encode_bytes(&certificate),
                signature: encode_bytes(signature.as_ref()),
            },
        );

        let registered: RelayControlEvent = read_frame(&mut control).expect("등록 결과");
        assert_eq!(registered, RelayControlEvent::Registered, "등록되어야 한다");

        let tls_config = Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("판")
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate.clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8.clone())),
            )
            .expect("서버 설정"),
        );

        // 폰이 올 때마다 데이터 연결을 하나 연다.
        while let Ok(event) = read_frame::<RelayControlEvent>(&mut control) {
            let RelayControlEvent::Incoming { connection_id } = event else {
                continue;
            };
            let relay_endpoint = relay_endpoint.clone();
            let server_id = server_id.clone();
            let tls_config = Arc::clone(&tls_config);
            thread::spawn(move || {
                let mut data = TcpStream::connect(&relay_endpoint).expect("데이터 연결");
                write_frame(
                    &mut data,
                    &RelayHello {
                        relay_protocol_version: RELAY_PROTOCOL_VERSION,
                        role: RelayRole::HubData,
                        server_id,
                        connection_id: Some(connection_id),
                    },
                );
                let paired: RelayAnswer = read_frame(&mut data).expect("paired");
                assert_eq!(paired, RelayAnswer::Paired);

                // 여기서부터 바이트다. 그 위에 진짜 TLS 를 세운다.
                let connection = rustls::ServerConnection::new(tls_config).expect("TLS");
                let mut tls = rustls::StreamOwned::new(connection, data);
                tls.write_all(&hello::encode_ack("device-1", "내 폰").expect("ack"))
                    .expect("ack 를 쓴다");
                tls.write_all(SECRET).expect("비밀을 쓴다");
                tls.flush().expect("flush");
            });
        }
    });
}

/// 폰 흉내. 릴레이에 붙어 답을 하나 받는다.
fn phone_hello(relay_endpoint: &str, server_id: &str) -> (TcpStream, RelayAnswer) {
    let mut stream = TcpStream::connect(relay_endpoint).expect("폰 연결");
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("마감");
    write_frame(
        &mut stream,
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::Client,
            server_id: server_id.to_string(),
            connection_id: None,
        },
    );
    let answer = read_frame(&mut stream).expect("답");
    (stream, answer)
}

/// 지문을 고정한 폰의 TLS 설정. `mobile/src-tauri/src/hub_client.rs` 와 같은
/// 판단을 한다 — 그 모듈을 여기서 링크할 수는 없다(폰 빌드에 릴레이 서버가
/// 딸려 오면 안 된다).
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if fingerprint::matches(end_entity.as_ref(), &self.fingerprint) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("지문이 다르다".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
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
        cert: &CertificateDer<'_>,
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

fn pinned_tls(
    transport: TcpStream,
    pin: &str,
) -> Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            fingerprint: pin.to_string(),
            provider,
        }))
        .with_no_client_auth();
    let connection = rustls::ClientConnection::new(
        Arc::new(config),
        ServerName::try_from("hub.invalid").expect("이름"),
    )?;
    Ok(rustls::StreamOwned::new(connection, transport))
}

/// 관통. 폰이 릴레이를 지나 노트북과 끝단 간 TLS 를 세우고 바이트를 받는다.
#[test]
fn a_phone_reaches_its_hub_through_the_relay_over_end_to_end_tls() {
    let relay = start_relay();
    let identity = hub_identity();
    spawn_hub(&relay, "server-1", &identity);
    // 등록이 끝나기를 기다린다. control 연결이 서기 전에 폰이 오면 Unknown 이다.
    thread::sleep(Duration::from_millis(300));

    let (stream, answer) = phone_hello(&relay, "server-1");
    assert_eq!(answer, RelayAnswer::Paired, "이어졌어야 한다");

    let mut tls = pinned_tls(stream, &identity.fingerprint).expect("TLS 설정");
    let ack = hello::read_ack(&mut tls).expect("ack 가 릴레이를 건너온다");
    assert_eq!(ack.device_id, "device-1");

    let mut received = vec![0u8; SECRET.len()];
    tls.read_exact(&mut received).expect("비밀이 건너온다");
    assert_eq!(received, SECRET);
}

/// 릴레이가 중간에서 자기 인증서를 내밀면 폰이 끊는다.
///
/// 다른 지문을 고정한 폰으로 같은 경로를 타 본다. 이것이 실패해야 위 시험의
/// 성공이 "고정이 실제로 작동하는 채로 관통했다" 를 뜻한다 — 고정이 아무것도
/// 안 하고 있으면 위 시험도 통과하고 이 시험도 통과한다.
#[test]
fn a_phone_that_pinned_another_certificate_cannot_be_fooled_through_the_relay() {
    let relay = start_relay();
    let identity = hub_identity();
    spawn_hub(&relay, "server-2", &identity);
    thread::sleep(Duration::from_millis(300));

    let (stream, answer) = phone_hello(&relay, "server-2");
    assert_eq!(answer, RelayAnswer::Paired);

    let someone_else = fingerprint::of_der(b"a certificate this hub does not have");
    let mut tls = pinned_tls(stream, &someone_else).expect("TLS 설정");
    let mut received = [0u8; 1];

    assert!(
        tls.read(&mut received).is_err(),
        "고정하지 않은 인증서로 릴레이를 지나 붙어 버렸다"
    );
}

/// 등록된 적 없는 기계와 지금 꺼진 기계는 다른 답이어야 한다.
#[test]
fn an_unknown_server_and_an_offline_server_are_told_apart() {
    let relay = start_relay();

    let (_, unknown) = phone_hello(&relay, "never-registered");
    assert_eq!(
        unknown,
        RelayAnswer::Unavailable {
            reason: RelayUnavailable::Unknown
        }
    );
}

/// 인증서만 베낀 쪽은 그 `server_id` 를 차지하지 못한다.
///
/// 차지하면 주인의 폰이 자기 노트북에 못 붙는다 — 사칭은 아니지만(폰이 지문을
/// 고정한다) 사용자에게는 고장과 구별되지 않는다.
#[test]
fn a_squatter_with_only_the_certificate_is_refused_registration() {
    let relay = start_relay();
    let victim = hub_identity();
    let attacker = hub_identity();

    let mut control = TcpStream::connect(&relay).expect("연결");
    write_frame(
        &mut control,
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::HubControl,
            server_id: "server-3".to_string(),
            connection_id: None,
        },
    );
    let challenge: RelayChallenge = read_frame(&mut control).expect("challenge");
    let nonce = decode_nonce(&challenge.nonce).expect("난수");

    // 피해자의 인증서(공개값이다)와 공격자의 키.
    let key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_ASN1_SIGNING,
        &attacker.key_pkcs8,
        &SystemRandom::new(),
    )
    .expect("키");
    let signature = key
        .sign(
            &SystemRandom::new(),
            &registration_transcript("server-3", &nonce),
        )
        .expect("서명");
    write_frame(
        &mut control,
        &RelayProof {
            certificate_der: encode_bytes(&victim.certificate),
            signature: encode_bytes(signature.as_ref()),
        },
    );

    let answer: RelayControlEvent = read_frame(&mut control).expect("답");
    assert_eq!(
        answer,
        RelayControlEvent::Rejected {
            reason: dure_hub_protocol::relay::RelayRejection::BadProof
        }
    );
}

/// 늦게 깨어난 옛 control 스레드가 **멀쩡한 새 등록을 지우지 못한다.**
///
/// 노트북이 네트워크를 바꾸면 릴레이에는 반쯤 열린 control 소켓이 남는다. 허브
/// 쪽 침묵 상한이 먼저 울려 노트북은 재접속하고 새 등록이 그 자리를 대신하는데,
/// 몇 분 뒤 TCP 가 마침내 포기하면 옛 스레드가 깨어난다. 그때 `server_id` 만 보고
/// 지우면 지워지는 것은 새 등록이다.
///
/// 그 뒤가 이 사고의 나쁜 점이다 — 허브는 등록돼 있다고 믿고(자기 소켓은 건강하고
/// ping 도 받는다) 릴레이는 모른다고 답한다. 폰에는 "컴퓨터가 꺼져 있습니다" 만
/// 뜨고 아무도 회복시키지 않는다.
///
/// 여기서는 첫 소켓을 우리가 닫아 EOF 로 그 순간을 즉시 만든다.
#[test]
fn an_old_control_thread_does_not_delete_the_registration_that_replaced_it() {
    let (endpoint, relay) = start_relay_with_handle();
    let identity = hub_identity();

    let stale = register_control(&endpoint, "server-generation", &identity);
    let _fresh = register_control(&endpoint, "server-generation", &identity);
    assert!(
        wait_until(|| relay.live_hub_count() == 1),
        "재등록은 자리를 대신할 뿐 하나로 남아야 한다"
    );

    // 옛 연결이 이제야 끊긴다.
    drop(stale);

    // 그 스레드는 깨어나 자기 등록을 지우려 한다. 지워질 것이 없어야 한다.
    thread::sleep(Duration::from_millis(150));
    assert_eq!(
        relay.live_hub_count(),
        1,
        "옛 스레드가 새 등록을 지웠다 — 허브는 등록됐다고 믿고 폰은 오프라인을 본다"
    );
}

/// 그래도 마지막 연결이 끊기면 등록은 사라져야 한다.
///
/// 위 시험만 있으면 `remove_live` 를 통째로 지워도 통과한다.
#[test]
fn the_registration_goes_when_its_own_connection_ends() {
    let (endpoint, relay) = start_relay_with_handle();
    let identity = hub_identity();

    let control = register_control(&endpoint, "server-lastone", &identity);
    assert!(
        wait_until(|| relay.live_hub_count() == 1),
        "등록되어야 한다"
    );

    drop(control);

    assert!(
        wait_until(|| relay.live_hub_count() == 0),
        "끊긴 등록은 사라져야 한다"
    );
}

/// 고정 표가 가득 차면 **새 `server_id` 를 거절한다.**
///
/// 등록에 필요한 것은 자기가 만든 인증서와 서명뿐이라 — 인증이 아니라 소지
/// 증명이다 — 아무나 임의의 `server_id` 로 항목을 영구히 더할 수 있고, 그 표는
/// 연결이 끊겨도 지워지지 않는다(지워지면 자리 뺏기의 창이 열린다). 배포된
/// 머신은 256MB 다.
#[test]
fn a_full_pin_table_refuses_a_new_server() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("바인드");
    let endpoint = listener.local_addr().expect("주소").to_string();
    let relay = Arc::new(Relay::with_pin_limit(1));
    thread::spawn(move || serve(&listener, &relay));

    let identity = hub_identity();
    let _first = register_control(&endpoint, "server-first", &identity);

    // 두 번째는 다른 기계다. 표에 자리가 없다.
    let refusal = try_register_control(&endpoint, "server-second", &identity);
    assert_eq!(
        refusal,
        RelayControlEvent::Rejected {
            reason: RelayRejection::TooManyConnections
        },
        "가득 찬 표는 새 기계를 거절해야 한다"
    );
}

/// 이미 고정된 `server_id` 는 표가 어떻든 계속 등록된다.
///
/// 상한을 "꽉 차면 전부 거절" 로 만들면 이 성질이 깨지고, 남용 하나가 이미 쓰고
/// 있는 모든 노트북을 끊는다.
#[test]
fn an_already_pinned_server_keeps_registering() {
    let (endpoint, relay) = start_relay_with_handle();
    let identity = hub_identity();

    let first = register_control(&endpoint, "server-repeat", &identity);
    assert!(wait_until(|| relay.live_hub_count() == 1), "첫 등록");
    drop(first);
    assert!(wait_until(|| relay.live_hub_count() == 0), "끊김");

    let _second = register_control(&endpoint, "server-repeat", &identity);
    assert!(
        wait_until(|| relay.live_hub_count() == 1),
        "이미 고정된 기계는 다시 등록되어야 한다"
    );
}
