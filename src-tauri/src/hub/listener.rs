//! 폰이 붙는 TLS 리스너.
//!
//! HTTP 가 아니다. 붙은 뒤에는 길이 접두 프레임이 흐르고, 그건 이 저장소가
//! 이미 어디서나 쓰는 형식이다 — 터미널은 스트림이고, 요청/응답으로 감싸면
//! 출력 delta 마다 왕복이 생긴다.
//!
//! # 붙는 순서
//!
//! 1. TLS 핸드셰이크. 폰은 인증서 지문을 고정해 두었고, 다르면 여기서 끊는다.
//!    (그 판단은 폰 쪽에서 일어난다 — 서버는 자기 인증서를 내밀 뿐이다.)
//! 2. 폰이 인증 프레임 하나를 보낸다: 기기 토큰.
//! 3. 허브가 받아들이거나 끊는다.
//!
//! 토큰을 TLS **안에서** 보내는 것이 요점이다. 핸드셰이크 전에 보내면 평문이고,
//! 지문 고정이 끝나기 전에 자격증명을 넘기는 것이 된다.
//!
//! # 왜 인증 실패에 이유를 말하지 않나
//!
//! 틀린 토큰에 "그런 기기 없음" 과 "토큰 불일치" 를 구별해 주면, 붙어 보는
//! 것만으로 어떤 기기 id 가 등록돼 있는지 알 수 있다. 실패는 한 가지 문장이고
//! 연결은 그냥 닫힌다.

use super::identity::{self, DeviceToken, HubCertificate};
use dure_hub_protocol::frame::FrameError;
use dure_hub_protocol::hello::{self, HelloError, HubRequest};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

// 오가는 문서의 모양과 그 상한은 `dure-hub-protocol` 이 소유한다. 폰이 같은
// 것을 읽고 쓰기 때문이다. 여기 남는 것은 **자격 판단** 하나 — 그 토큰이
// 등록된 기기의 것인가. 프로토콜 크레이트는 등록된 기기 목록을 모른다.
pub use dure_hub_protocol::frame::MAX_HELLO_BYTES;
pub use dure_hub_protocol::hello::{HUB_HELLO_VERSION, HubHello, HubHelloAck, encode_hello};

#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// 프레임을 읽지 못했다 — 끊겼거나, 길이가 상한을 넘었거나, JSON 이 아니다.
    Malformed(&'static str),
    /// 이 빌드가 모르는 판.
    UnsupportedVersion { found: u16 },
    /// 토큰이 등록된 기기 중 어느 것도 아니다.
    ///
    /// 이유를 나누지 않는다 — 위 모듈 주석 참조.
    Rejected,
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(detail) => write!(formatter, "Malformed hub handshake: {detail}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "Unsupported hub protocol version: {found} (this build uses {HUB_HELLO_VERSION})"
            ),
            Self::Rejected => write!(formatter, "This device is not registered with this hub"),
        }
    }
}

/// 봉투와 판을 읽는 일은 프로토콜 크레이트의 것, **자격 판단**은 여기의 것.
///
/// 두 쪽의 실패를 한 타입으로 접는다. 폰에게는 어차피 아무 이유도 돌아가지
/// 않지만(아래 [`HandshakeError::Rejected`] 주석), 노트북 쪽 로그에서는
/// "형식이 틀렸다" 와 "등록되지 않았다" 가 구별되어야 한다 — 전자는 판 어긋남
/// 이고 후자는 사용자가 기기를 취소한 것이다.
impl From<HelloError> for HandshakeError {
    fn from(error: HelloError) -> Self {
        match error {
            // `Truncated` 의 문구를 그대로 옮긴다. 여기서 한 문장으로 뭉치면
            // "끊겼다" 와 "본문이 모자라다" 가 같은 줄로 보이고, 둘은 다른
            // 네트워크 상태다.
            // 한 바이트도 안 온 것과 시간이 초과된 것을 뭉치지 않는다. 폰 쪽은
            // 이 구별로 "거절" 과 "네트워크" 를 가르고(그쪽 `hub_client`), 이쪽
            // 로그도 같은 구별을 갖고 있어야 두 로그를 맞춰 볼 수 있다.
            HelloError::Frame(FrameError::Closed) => Self::Malformed("No handshake was received"),
            HelloError::Frame(FrameError::TimedOut) => Self::Malformed("The handshake did not arrive in time"),
            HelloError::Frame(FrameError::Truncated(detail)) => Self::Malformed(detail),
            HelloError::Frame(FrameError::OutOfRange { .. }) => {
                Self::Malformed("The length is out of range")
            }
            HelloError::Frame(FrameError::Malformed(_)) => Self::Malformed("Invalid JSON"),
            HelloError::UnsupportedVersion { found } => Self::UnsupportedVersion { found },
        }
    }
}

/// 인증 프레임을 읽고 기기를 알아낸다.
///
/// 스트림을 제네릭으로 받는 이유: TLS 소켓 위에서 도는 것이 본래 쓰임이지만,
/// 그 판단 — 길이 상한, 판 확인, 상수 시간 비교 — 은 TLS 없이 시험할 수 있어야
/// 한다. 핸드셰이크를 세우지 않으면 시험할 수 없는 코드는 시험되지 않는다.
#[derive(Debug)]
pub struct AuthenticatedHello<'a> {
    pub device: &'a DeviceToken,
    pub request: HubRequest,
}

pub fn read_hello<'a, S: Read + Write>(
    stream: &mut S,
    devices: &'a [DeviceToken],
) -> Result<AuthenticatedHello<'a>, HandshakeError> {
    let hello = hello::read_hello(stream)?;
    let device = identity::authenticate(&hello.token, devices).ok_or(HandshakeError::Rejected)?;
    Ok(AuthenticatedHello {
        device,
        request: hello.request,
    })
}

/// 받아들였다고 답한다.
pub fn write_ack<S: Write>(stream: &mut S, device: &DeviceToken) -> std::io::Result<()> {
    let framed = hello::encode_ack(&device.device_id, &device.label)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    stream.write_all(&framed)?;
    stream.flush()
}

/// rustls 서버 설정. 이 기계의 인증서를 내민다.
///
/// 클라이언트 인증서를 요구하지 않는다. 기기 증명은 TLS 안에서 토큰으로 하고,
/// 그편이 폰에 인증서를 발급하고 갱신하는 것보다 단순하다 — TLS 는 여기서
/// **기계의 신원과 도청 방지**를 맡고, 누가 붙었는지는 토큰이 맡는다.
pub fn server_config(
    certificate: &HubCertificate,
) -> Result<Arc<rustls::ServerConfig>, rustls::Error> {
    let chain = vec![rustls::pki_types::CertificateDer::from(
        certificate.der.clone(),
    )];
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
        rustls::pki_types::PrivatePkcs8KeyDer::from(certificate.private_key_der.clone()),
    );
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(chain, key)?;
    Ok(Arc::new(config))
}

/// 리스너를 연다. 어느 주소에 붙일지는 호출부가 정한다.
///
/// `127.0.0.1` 이 아니라 고른 인터페이스에 붙는 것이 이 리스너의 존재 이유다 —
/// 폰이 다른 기계에서 온다. 어떤 주소를 광고할지는 이미 화면이 고르고 있다
/// (`mobile_pairing::network_choices`).
pub fn bind(address: &str, port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((address, port))
}

/// 붙은 소켓 하나를 TLS 로 감싼다.
pub fn accept_tls(
    stream: TcpStream,
    config: Arc<rustls::ServerConfig>,
) -> Result<rustls::StreamOwned<rustls::ServerConnection, TcpStream>, rustls::Error> {
    let connection = rustls::ServerConnection::new(config)?;
    Ok(rustls::StreamOwned::new(connection, stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::identity::mint_token;
    use std::io::Cursor;

    /// 읽기/쓰기가 되는 가짜 스트림. TLS 없이 판단만 시험한다.
    struct Pipe {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Pipe {
        fn new(input: Vec<u8>) -> Self {
            Self {
                input: Cursor::new(input),
                output: Vec::new(),
            }
        }
    }

    impl Read for Pipe {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl Write for Pipe {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.output.extend_from_slice(buffer);
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_registered_device_is_recognised_by_its_token() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let devices = vec![phone.clone()];
        let mut pipe = Pipe::new(encode_hello(&phone.token).unwrap());

        let device = read_hello(&mut pipe, &devices).expect("등록된 기기는 받아들여진다");

        assert_eq!(device.device.device_id, "phone");
        assert_eq!(device.request, HubRequest::Catalog);
    }

    /// 이유를 나누면, 붙어 보는 것만으로 어떤 기기가 등록돼 있는지 알 수 있다.
    #[test]
    fn a_wrong_token_is_refused_without_saying_why() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let devices = vec![phone];
        let mut pipe = Pipe::new(encode_hello(&"A".repeat(43)).unwrap());

        let error = read_hello(&mut pipe, &devices).unwrap_err();

        assert_eq!(error, HandshakeError::Rejected);
        let rendered = error.to_string();
        // 등록된 기기의 이름이나 개수를 흘리지 않는다.
        assert!(!rendered.contains("phone"), "{rendered}");
        assert!(!rendered.contains('1'), "{rendered}");
    }

    /// 인증 전에 읽는 유일한 바이트다. 상한이 없으면 아직 아무것도 증명하지
    /// 않은 쪽이 이 프로세스의 메모리를 원하는 만큼 쓰게 만들 수 있다.
    #[test]
    fn an_oversized_hello_is_refused_before_it_is_allocated() {
        let devices = vec![mint_token("phone".into(), "폰".into()).unwrap()];
        let mut framed = ((MAX_HELLO_BYTES + 1) as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(b"{}");
        let mut pipe = Pipe::new(framed);

        assert_eq!(
            read_hello(&mut pipe, &devices).unwrap_err(),
            HandshakeError::Malformed("길이가 범위를 벗어났습니다")
        );
    }

    #[test]
    fn a_zero_length_hello_is_refused() {
        let devices = vec![mint_token("phone".into(), "폰".into()).unwrap()];
        let mut pipe = Pipe::new(0u32.to_be_bytes().to_vec());

        assert_eq!(
            read_hello(&mut pipe, &devices).unwrap_err(),
            HandshakeError::Malformed("길이가 범위를 벗어났습니다")
        );
    }

    #[test]
    fn a_truncated_hello_is_refused_rather_than_hanging() {
        let devices = vec![mint_token("phone".into(), "폰".into()).unwrap()];
        // 길이는 100 이라고 말하고 10 바이트만 준다.
        let mut framed = 100u32.to_be_bytes().to_vec();
        framed.extend_from_slice(b"0123456789");
        let mut pipe = Pipe::new(framed);

        assert_eq!(
            read_hello(&mut pipe, &devices).unwrap_err(),
            HandshakeError::Malformed("본문을 다 읽지 못했습니다")
        );
    }

    #[test]
    fn a_version_this_build_does_not_speak_is_named() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let devices = vec![phone.clone()];
        let body = serde_json::to_vec(&serde_json::json!({
            "hub_hello_version": 999,
            "token": phone.token,
        }))
        .unwrap();
        let mut framed = (body.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&body);
        let mut pipe = Pipe::new(framed);

        assert_eq!(
            read_hello(&mut pipe, &devices).unwrap_err(),
            HandshakeError::UnsupportedVersion { found: 999 }
        );
    }

    #[test]
    fn the_ack_names_the_device_that_was_recognised() {
        let phone = mint_token("phone".into(), "내 폰".into()).unwrap();
        let mut pipe = Pipe::new(Vec::new());

        write_ack(&mut pipe, &phone).unwrap();

        let length = u32::from_be_bytes(pipe.output[..4].try_into().unwrap()) as usize;
        let ack: HubHelloAck = serde_json::from_slice(&pipe.output[4..4 + length]).unwrap();
        assert_eq!(ack.device_id, "phone");
        assert_eq!(ack.device_label, "내 폰");
        assert_eq!(ack.hub_hello_version, HUB_HELLO_VERSION);
    }

    /// 토큰은 ack 에 다시 실리지 않는다. 실리면 화면 캡처나 로그 한 줄에
    /// 자격증명이 남는다.
    #[test]
    fn the_ack_does_not_echo_the_token() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let mut pipe = Pipe::new(Vec::new());

        write_ack(&mut pipe, &phone).unwrap();

        let rendered = String::from_utf8_lossy(&pipe.output);
        assert!(!rendered.contains(&phone.token), "{rendered}");
    }

    /// 인증서로 rustls 설정이 실제로 만들어져야 한다 — 여기서 실패하면 리스너가
    /// 뜨지 않고, 그 사실은 앱을 켜 봐야만 드러난다.
    #[test]
    fn the_stored_certificate_builds_a_working_server_config() {
        let root = tempfile::tempdir().unwrap();
        let certificate = identity::load_or_create_certificate(root.path()).unwrap();

        let config = server_config(&certificate).expect("자체 서명 인증서로 서버 설정이 선다");

        assert!(!config.crypto_provider().cipher_suites.is_empty());
    }
}
