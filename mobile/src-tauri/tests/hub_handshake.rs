//! 진짜 TLS 허브 하나를 세우고 폰이 관통하는지 본다.
//!
//! `hub_client` 의 단위 시험은 **검증자의 판단**을 고정한다 — 어떤 DER 을
//! 받아들이고 어떤 것을 거부하는가. 그것만으로는 두 가지가 시험되지 않는다:
//!
//! 1. rustls 가 그 검증자를 실제로 부르는가. 설정을 잘못 조립하면(예: 기본
//!    검증자가 남아 있으면) 단위 시험은 전부 통과한 채 자체 서명 인증서가
//!    거부되고, 그 사실은 기기에서만 드러난다.
//! 2. 지문 불일치가 **핸드셰이크에서** 끊는가. 검증자가 `Err` 를 돌려주는 것과
//!    연결이 실제로 서지 않는 것은 다른 주장이다.
//!
//! 그래서 여기서는 실제 소켓, 실제 rcgen 인증서, 실제 rustls 서버를 쓴다.
//! 노트북 쪽 허브(`src-tauri/src/hub`)와 같은 crate 버전과 같은 `ring` 백엔드다.

use dure_hub_protocol::catalog::{self, HubCatalog, UnreachableBox, HUB_CATALOG_VERSION};
use dure_hub_protocol::{fingerprint, hello};
use dure_mobile_lib::hub_client::{self, HubClientError};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::io::Write as _;
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

/// 노트북 흉내. 인증서 하나와, 붙은 폰 하나를 서빙하는 스레드.
struct FakeHub {
    endpoint: String,
    fingerprint: String,
    served: thread::JoinHandle<Option<String>>,
}

fn catalog_fixture() -> HubCatalog {
    HubCatalog {
        hub_catalog_version: HUB_CATALOG_VERSION,
        layout: None,
        sessions: Vec::new(),
        unreachable: vec![UnreachableBox {
            box_id: "gate1".to_string(),
            box_label: "Gate1".to_string(),
            detail: "시간이 초과되었습니다".to_string(),
        }],
    }
}

/// 허브를 하나 띄운다. 반환된 지문이 폰이 QR 로 받았을 값이다.
///
/// 서빙 스레드는 폰이 보낸 토큰을 돌려준다 — 그래야 "붙었다" 가 아니라 "우리가
/// 보낸 자격증명이 저쪽에 도착했다" 를 주장할 수 있다.
fn start_hub() -> FakeHub {
    let certified =
        rcgen::generate_simple_self_signed(vec!["hub.invalid".to_string()]).expect("인증서");
    let certificate_der = CertificateDer::from(certified.cert.der().to_vec());
    let fingerprint = fingerprint::of_der(&certificate_der);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certified.key_pair.serialize_der()));

    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("판")
    .with_no_client_auth()
    .with_single_cert(vec![certificate_der], key)
    .expect("서버 설정");

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("바인드");
    let endpoint = listener.local_addr().expect("주소").to_string();

    let served = thread::spawn(move || {
        let (stream, _) = listener.accept().ok()?;
        let connection = rustls::ServerConnection::new(Arc::new(config)).ok()?;
        let mut tls = rustls::StreamOwned::new(connection, stream);

        // 노트북 쪽과 같은 순서: 인사를 읽고, ack, 목록.
        let received = hello::read_hello(&mut tls).ok()?;
        tls.write_all(&hello::encode_ack("device-1", "내 폰").ok()?)
            .ok()?;
        tls.write_all(&catalog::encode(&catalog_fixture()).ok()?)
            .ok()?;
        tls.flush().ok()?;
        Some(received.token)
    });

    FakeHub {
        endpoint,
        fingerprint,
        served,
    }
}

fn fetch_from_fake_hub(
    endpoint: &str,
    fingerprint: &str,
    token: &str,
) -> Result<(hello::HubHelloAck, HubCatalog), HubClientError> {
    let stream = TcpStream::connect(endpoint).expect("시험 허브 연결");
    let mut tls = hub_client::attach_tls(stream, fingerprint, "127.0.0.1")?;
    let ack = hub_client::handshake(&mut tls, token)?;
    let catalog = hub_client::read_catalog(&mut tls)?;
    Ok((ack, catalog))
}

/// 관통. 고정한 지문이 맞으면 붙고, 토큰이 건너가고, 목록이 돌아온다.
#[test]
fn a_phone_that_pinned_this_hub_completes_the_handshake_and_reads_the_catalog() {
    let hub = start_hub();

    let (ack, received) = fetch_from_fake_hub(&hub.endpoint, &hub.fingerprint, "token-1")
        .expect("고정한 그 허브에는 붙는다");

    assert_eq!(ack.device_id, "device-1");
    assert_eq!(received, catalog_fixture());
    assert_eq!(
        hub.served.join().expect("서빙 스레드"),
        Some("token-1".to_string()),
        "폰이 보낸 토큰이 허브에 도착해야 한다"
    );
}

/// 이 시험이 이 파일의 존재 이유다.
///
/// 다른 기계의 지문을 고정한 폰은 **핸드셰이크에서** 끊어야 한다. 검증자가
/// `Err` 를 돌려주는 것을 단위 시험이 이미 고정하지만, 그 `Err` 가 실제로 연결을
/// 막는지는 여기서만 드러난다 — 설정 조립이 어긋나 기본 검증자가 남아 있으면
/// 단위 시험은 통과한 채 이 연결이 성립한다.
#[test]
fn a_phone_that_pinned_another_machine_is_stopped_at_the_handshake() {
    let hub = start_hub();
    let someone_else = fingerprint::of_der(b"a certificate this hub does not have");

    let outcome = fetch_from_fake_hub(&hub.endpoint, &someone_else, "token-1");

    // **`Unreachable` 을 받아들이지 않는다.** 붙지 않는 것만으로는 부족하다 —
    // 사용자가 읽는 문장이 "컴퓨터에 연결하지 못했습니다" 면 와이파이를 보러
    // 가고, 진짜 원인(인증서가 바뀌었다, 재페어링해야 한다)은 영원히 안 보인다.
    // 느슨하게 `NotThisMachine(_) | Unreachable(_)` 로 두었더니 실제로 그
    // 오진이 이 시험을 통과했다.
    match outcome {
        Err(HubClientError::NotThisMachine(_)) => {}
        other => panic!("지문 불일치가 '그 기계가 아니다' 로 보고되지 않았다: {other:?}"),
    }
    assert_ne!(
        hub.served.join().expect("서빙 스레드"),
        Some("token-1".to_string()),
        "핸드셰이크가 끊겼는데 토큰이 건너갔다"
    );
}

/// 지문이 하나라도 다르면 안 된다 — 한 글자만 바꾼 값도 포함해서.
///
/// `of_der` 를 완전히 다른 바이트로 부르는 위 시험은 "전혀 다른 인증서" 를
/// 다루고, 이쪽은 검사가 접두나 길이만 보고 있지 않다는 것을 고정한다.
#[test]
fn a_single_altered_character_in_the_pin_is_enough_to_stop_it() {
    let hub = start_hub();
    let mut tampered = hub.fingerprint.clone();
    let last = tampered.pop().expect("지문은 비어 있지 않다");
    tampered.push(if last == 'A' { 'B' } else { 'A' });

    let outcome = fetch_from_fake_hub(&hub.endpoint, &tampered, "token-1");

    assert!(
        matches!(outcome, Err(HubClientError::NotThisMachine(_))),
        "한 글자 다른 지문이 '그 기계가 아니다' 로 보고되지 않았다: {outcome:?}"
    );
    let _ = hub.served.join();
}
