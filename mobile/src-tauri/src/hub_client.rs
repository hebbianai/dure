//! 폰이 노트북의 Dure 허브에 붙는 쪽.
//!
//! SSH 가 아니다. 저쪽에 sshd 는 없고, 앱 프로세스가 띄운 TLS 리스너가 있다 —
//! 제품이 사용자에게 시스템 스위치(원격 로그인)를 켜라고 요구하지 않기 위해서다
//! (`src-tauri/src/hub/mod.rs`).
//!
//! # 붙는 순서
//!
//! 1. TLS 핸드셰이크. **폰이 인증서 지문을 고정한다** — 인증서 기관이 없으므로
//!    신뢰의 출발점은 책상에서 QR 을 스캔한 그 순간 하나뿐이다.
//! 2. TLS **안에서** 기기 토큰을 보낸다. 핸드셰이크 전에 보내면 평문이고, 지문
//!    고정이 끝나기 전에 자격증명을 넘기는 것이 된다.
//! 3. 허브가 받아들이면 ack, 이어서 목록 한 덩이.
//!
//! # 왜 핸드셰이크가 스트림 제네릭인가
//!
//! 릴레이 전송(`crates/dure-relay/src/lib.rs`)이 바꾸는 것은 **소켓이
//! 어떻게 성립하는가** 하나다. 그 위의 TLS·인사·목록은 글자 하나 바뀌지 않는다.
//! [`attach_tls`] 와 [`read_catalog`] 가 `TcpStream` 을 모르게 두면, 릴레이는
//! 소켓을 여는 한 곳에만 남는다. 두 벌을 쓰게 되면
//! 그때부터 "직결에서는 되는데 릴레이에서만 안 되는" 부류가 생긴다.

use dure_hub_protocol::catalog::{self, CatalogError, HubCatalog};
use dure_hub_protocol::fingerprint;
use dure_hub_protocol::frame;
use dure_hub_protocol::frame::FrameError;
use dure_hub_protocol::hello::{self, HelloError, HubHelloAck, HubRequest};
use dure_hub_protocol::offer;
use dure_hub_protocol::relay::{
    RelayAnswer, RelayHello, RelayRole, RelayUnavailable, MAX_RELAY_FRAME_BYTES,
    RELAY_PROTOCOL_VERSION,
};
use hmux_client::transport::{AttachedTransport, FrameWriter, TransportInterrupt};
use hmux_ssh_transport::session_resolution::{self, SessionResolution};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 소켓 하나가 조용히 있을 수 있는 시간.
///
/// 목록 한 번은 짧다. 이 값은 "노트북이 답하지 않는다" 를 사용자에게 말해 주기
/// 까지의 상한이고, attach 가 붙는 슬라이스에서는 그쪽이 자기 값을 갖는다 —
/// 붙어서 보고만 있는 화면은 조용한 것이 정상이다.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// 릴레이에 붙고 이어지기까지.
///
/// 직결보다 넉넉하다. 여기에는 노트북이 데이터 연결을 여는 왕복이 들어 있고,
/// 그 노트북은 지금 다른 대륙에 있을 수 있다.
pub const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum HubClientError {
    /// 고정해 둔 지문이 지문의 모양이 아니다. **소켓을 열기 전에** 걸러진다.
    UnusablePin,
    /// 주소를 풀지 못했거나 붙지 못했다.
    Unreachable(String),
    /// TLS 가 서지 않았다. 지문 불일치가 여기 포함된다 — 아래 주석 참조.
    NotThisMachine(String),
    /// 붙긴 했는데 상대가 이 판을 말하지 않거나 프레임이 깨졌다.
    Protocol(String),
    /// 허브가 이 기기를 받아들이지 않고 끊었다.
    Refused,
    /// 릴레이는 이 컴퓨터를 알지만 지금 붙어 있지 않다.
    ///
    /// 다른 실패와 뭉치지 않는다. 사용자가 **고칠 수 있는** 유일한 실패이고,
    /// 밖에서 폰을 꺼낸 사람이 가장 먼저 알아야 하는 것이다.
    ComputerOffline,
    /// 인터넷 릴레이가 없는 옛 페어링은 사설 주소를 건드리지 않는다.
    RelayRequired,
    Gateway(hmux_ssh_transport::CatalogError),
}

impl std::fmt::Display for HubClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gateway(error) => write!(formatter, "{error}"),
            Self::UnusablePin => write!(
                formatter,
                "이 컴퓨터의 인증서 지문이 저장되어 있지 않습니다. 다시 페어링하세요"
            ),
            Self::Unreachable(detail) => {
                write!(formatter, "컴퓨터에 연결하지 못했습니다: {detail}")
            }
            Self::NotThisMachine(detail) => write!(
                formatter,
                "페어링한 그 컴퓨터가 아닙니다. 연결을 끊었습니다: {detail}"
            ),
            Self::Protocol(detail) => write!(formatter, "{detail}"),
            Self::Refused => write!(
                formatter,
                "이 기기가 컴퓨터에서 취소되었거나 등록되어 있지 않습니다. 다시 \
                 페어링하세요"
            ),
            Self::ComputerOffline => write!(
                formatter,
                "컴퓨터가 꺼져 있거나 인터넷에 연결되어 있지 않습니다"
            ),
            Self::RelayRequired => {
                formatter.write_str("인터넷 릴레이가 없는 연결입니다. 다시 페어링하세요")
            }
        }
    }
}

impl std::error::Error for HubClientError {}

impl HubClientError {
    /// 화면이 분기에 쓰는 값. 문구는 번역되지만 이것은 아니다.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Gateway(error) => error.code(),
            Self::UnusablePin => "hub_unusable_pin",
            Self::Unreachable(_) => "hub_unreachable",
            Self::NotThisMachine(_) => "hub_not_this_machine",
            Self::Protocol(_) => "hub_protocol",
            Self::Refused => "hub_refused",
            Self::ComputerOffline => "hub_computer_offline",
            Self::RelayRequired => "hub_relay_required",
        }
    }
}

impl From<HelloError> for HubClientError {
    fn from(error: HelloError) -> Self {
        match error {
            // 허브는 받아들이지 않은 기기에 **아무 말도 하지 않고** 끊는다
            // (그쪽 `listener` 모듈 주석: 이유를 나누면 붙어 보는 것만으로 어떤
            // 기기가 등록돼 있는지 알 수 있다). 한 바이트도 오지 않은 채 닫힌
            // 것은 그러므로 **거절**이다.
            HelloError::Frame(FrameError::Closed) => Self::Refused,
            // 시간 초과와 중간 끊김은 거절이 아니다. 여기를 `Refused` 로 뭉치면,
            // 핸드셰이크 직후 와이파이를 벗어난 사용자에게 "이 기기가
            // 취소되었습니다. 다시 페어링하세요" 라고 말하게 된다 — 재페어링은
            // 책상까지 걸어가는 일이고, 잠깐 끊긴 사람에게 시킬 일이 아니다.
            HelloError::Frame(FrameError::TimedOut) => {
                Self::Unreachable("컴퓨터가 제때 답하지 않았습니다".to_string())
            }
            HelloError::Frame(FrameError::Truncated(detail)) => {
                Self::Unreachable(detail.to_string())
            }
            other => Self::Protocol(other.to_string()),
        }
    }
}

impl From<CatalogError> for HubClientError {
    fn from(error: CatalogError) -> Self {
        Self::Protocol(error.to_string())
    }
}

/// 폰이 고정해 둔 인증서 하나만 받아들이는 검증자.
///
/// # 무엇을 검사하지 *않는가*, 그리고 왜인가
///
/// 이름(SAN/CN)도 유효기간도 보지 않는다. 인증서 기관이 없고 이름도 없다 —
/// 노트북의 주소는 인터페이스마다 다르고 릴레이를 타면 또 달라진다. 여기서
/// 기계를 정하는 것은 **지문 하나**이고, 그것이 페어링이 하는 일 전부다.
///
/// 유효기간을 보지 않는 것은 결정이다. 자체 서명 인증서가 만료되었다는 사실은
/// 이 신뢰 모델에서 아무 뜻도 없다 — 만료를 판정해 줄 제3자가 없으므로, 그것을
/// 이유로 끊으면 어느 날 갑자기 자기 노트북에 못 붙는 것으로만 보인다.
#[derive(Debug)]
struct PinnedCertificate {
    /// 페어링 때 QR 에서 받아 적은 값.
    fingerprint: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCertificate {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // 허브는 자체 서명 인증서 하나만 내민다. 사슬이 왔다는 것은 저쪽이
        // 허브가 아니라는 뜻이고, 그 경우 leaf 만 골라 비교하면 중간자가
        // 고른 leaf 를 우리가 검사하는 모양이 된다.
        if !intermediates.is_empty() {
            return Err(rustls::Error::General(
                "허브는 인증서 하나만 내민다 — 사슬이 왔다".into(),
            ));
        }
        if !fingerprint::matches(end_entity.as_ref(), &self.fingerprint) {
            return Err(rustls::Error::General(
                "인증서 지문이 페어링 때 고정한 값과 다르다".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    // 서명 검증은 직접 쓰지 않는다. 지문을 고정한다고 해서 핸드셰이크 서명까지
    // 손으로 검사해도 되는 것은 아니다 — 그 자리를 비워 두면 인증서만 베낀
    // 상대가 개인키 없이 붙는다.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
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
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 이 지문 하나만 믿는 클라이언트 설정.
fn client_config(pinned_fingerprint: &str) -> Result<Arc<ClientConfig>, HubClientError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = PinnedCertificate {
        fingerprint: pinned_fingerprint.to_string(),
        provider: Arc::clone(&provider),
    };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| HubClientError::Protocol(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// TLS 가 요구하는 이름. 이 연결에서는 아무것도 정하지 않는다.
///
/// 검증자가 이름을 보지 않으므로(위 주석) 여기서 하는 일은 rustls 의 요구를
/// 채우는 것뿐이다. 그래도 실제 호스트를 넘긴다 — SNI 로 나가는 값이라, 언젠가
/// 저쪽이 이름으로 갈라야 할 때 이미 맞는 값이 가 있다.
fn server_name_for(host: &str) -> ServerName<'static> {
    ServerName::try_from(offer::bare_host(host).to_string())
        .unwrap_or_else(|_| ServerName::try_from("hub.invalid").expect("고정 문자열은 이름이다"))
}

/// `호스트:포트` 를 호스트와 포트로.
///
/// 규칙은 [`offer::split_endpoint`] 가 소유한다 — QR 을 받아들일지 정하는 것과
/// **같은 함수**여야 한다. 두 벌로 두면 스캔은 통과했는데 다이얼러가 거부하는
/// (또는 그 반대) 상태가 생기고, 그 갈림은 책상에서 폰을 들고서야 보인다.
fn split_endpoint(endpoint: &str) -> Result<(&str, u16), HubClientError> {
    offer::split_endpoint(endpoint)
        .ok_or_else(|| HubClientError::Unreachable(format!("주소가 아닙니다: {endpoint}")))
}

fn connect_before<T>(
    deadline: Instant,
    mut connect: impl FnMut(Duration) -> io::Result<T>,
) -> io::Result<T> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection deadline elapsed",
            ));
        }
        match connect(remaining) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            outcome => return outcome,
        }
    }
}

/// 인터넷 릴레이까지의 TCP 소켓 하나.
fn dial_endpoint(endpoint: &str, budget: Duration) -> Result<TcpStream, HubClientError> {
    let (host, port) = split_endpoint(endpoint)?;
    let bare = offer::bare_host(host);

    // 이름 풀이는 이 예산 **밖이다**. `to_socket_addrs` 는 블로킹이고 상한을
    // 받지 않는다. QR 이 나르는 주소는 오늘 언제나 IP 라(허브가 고른 인터페이스
    // 주소를 광고한다) 실제로는 즉시 끝나지만, 이름이 오는 경로가 생기면
    // 셀룰러에서 이 한 줄이 예산을 통째로 넘길 수 있다.
    let addresses = (bare, port)
        .to_socket_addrs()
        .map_err(|error| HubClientError::Unreachable(error.to_string()))?;

    // 예산은 **주소마다가 아니라 전체**다. 주소마다 주면 AAAA + A 를 가진
    // 이름이 예산의 두 배를 쓰고, 그 시간이 곧 밖에서 앱을 켰을 때 아무것도
    // 안 뜨는 시간이 된다.
    let deadline = Instant::now() + budget;

    // 이름 하나가 여러 주소로 풀릴 수 있다(IPv6 먼저 오는 경우가 흔하다).
    // 첫 실패로 포기하면 IPv4 로만 닿는 노트북에 못 붙는다.
    let mut last = None;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match connect_before(deadline, |remaining| {
            TcpStream::connect_timeout(&address, remaining)
        }) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(REQUEST_TIMEOUT))
                    .and_then(|()| stream.set_write_timeout(Some(REQUEST_TIMEOUT)))
                    .map_err(|error| HubClientError::Unreachable(error.to_string()))?;
                return Ok(stream);
            }
            Err(error) => last = Some(error),
        }
    }
    Err(HubClientError::Unreachable(last.map_or_else(
        || "주소가 하나도 없습니다".to_string(),
        |e| e.to_string(),
    )))
}

/// 이미 열린 바이트 스트림 위에 TLS 를 세운다.
///
/// **지문 검사는 소켓을 열기 전에 한 번 더 있다** ([`fetch_catalog`]). 여기서만
/// 하면, 모양이 깨진 지문을 들고 있는 폰이 일단 붙고 나서 실패한다 — 그 사이에
/// 이미 TCP 연결이 상대에게 관측된다.
pub fn attach_tls<S: Read + Write>(
    transport: S,
    pinned_fingerprint: &str,
    host: &str,
) -> Result<StreamOwned<ClientConnection, S>, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let config = client_config(pinned_fingerprint)?;
    let connection = ClientConnection::new(config, server_name_for(host))
        .map_err(|error| HubClientError::NotThisMachine(error.to_string()))?;
    let mut stream = StreamOwned::new(connection, transport);

    // **핸드셰이크를 여기서 끝까지 몬다.** rustls 는 기본적으로 첫 I/O 까지
    // 미루는데, 그러면 지문 불일치가 인사를 쓰는 자리에서 `io::Error` 로
    // 나타나고 그 자리는 그것을 "네트워크가 사라졌다" 로 읽는다. 사용자에게는
    // "컴퓨터에 연결하지 못했습니다" 로 뜨고 — 와이파이를 보러 간다. 정작
    // 필요한 문장은 "페어링한 그 컴퓨터가 아닙니다" 다.
    //
    // 노트북 앱을 재설치해 인증서가 새로 만들어지면 페어링된 폰 전부가 그
    // 상태가 된다.
    while stream.conn.is_handshaking() {
        stream
            .conn
            .complete_io(&mut stream.sock)
            .map_err(|error| classify_handshake(&error))?;
    }
    Ok(stream)
}

/// 핸드셰이크가 죽은 이유가 **상대가 아니어서**인가, 소켓이 죽어서인가.
///
/// rustls 는 자기 오류를 `io::Error` 안에 넣어 돌려준다. 그것이 있으면 TLS 가
/// 거부한 것이고 — 우리 검증자가 지문을 보고 끊은 경우가 여기다 — 없으면
/// 바이트가 오가지 못한 것이다.
fn classify_handshake(error: &std::io::Error) -> HubClientError {
    if let Some(tls) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        return HubClientError::NotThisMachine(tls.to_string());
    }
    // rustls 가 감싸는 방식이 바뀌어 downcast 가 실패해도, `InvalidData` 는
    // 소켓 오류가 아니라 프로토콜 거부다. 여기서 `Unreachable` 로 떨어지면
    // 위 주석의 오진이 조용히 돌아온다.
    if error.kind() == std::io::ErrorKind::InvalidData {
        return HubClientError::NotThisMachine(error.to_string());
    }
    HubClientError::Unreachable(error.to_string())
}

/// 인사를 보내고 답을 받는다. TLS 가 이미 서 있는 스트림 위에서.
pub fn handshake<S: Read + Write>(
    stream: &mut S,
    token: &str,
) -> Result<HubHelloAck, HubClientError> {
    handshake_for(stream, token, HubRequest::Catalog)
}

pub fn handshake_for<S: Read + Write>(
    stream: &mut S,
    token: &str,
    request: HubRequest,
) -> Result<HubHelloAck, HubClientError> {
    let framed = hello::encode_hello_for(token, request)
        .map_err(|error| HubClientError::Protocol(error.to_string()))?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        // 여기서의 쓰기 실패는 대개 상대가 이미 끊은 것이다. TLS 는 섰는데
        // 인사에서 끊긴다면 등록되지 않은 기기라는 뜻이 아니라 — 허브는 인사를
        // *읽고* 나서 끊는다 — 네트워크가 사라진 것이다.
        .map_err(|error| HubClientError::Unreachable(error.to_string()))?;
    Ok(hello::read_ack(stream)?)
}

/// 목록 한 덩이.
pub fn read_catalog<S: Read + Write>(stream: &mut S) -> Result<HubCatalog, HubClientError> {
    Ok(catalog::read(stream)?)
}

/// 릴레이를 지나는 소켓 하나.
///
/// 릴레이는 두 소켓을 잇기만 한다. 이 함수가 돌려주는 스트림 위에서 폰과 허브가
/// **끝단 간** TLS 를 세우므로, 릴레이는 그 위를 볼 수 없다 — 보려면 TLS 를
/// 자기가 종단해야 하고 그러면 지문 고정이 깨진다.
pub fn dial_relay(
    relay_endpoint: &str,
    server_id: &str,
    budget: Duration,
) -> Result<TcpStream, HubClientError> {
    let mut stream = dial_endpoint(relay_endpoint, budget)?;
    let framed = frame::encode(
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::Client,
            server_id: server_id.to_string(),
            connection_id: None,
        },
        MAX_RELAY_FRAME_BYTES,
    )
    .map_err(|error| HubClientError::Protocol(error.to_string()))?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        .map_err(|error| HubClientError::Unreachable(error.to_string()))?;

    match frame::read::<RelayAnswer, _>(&mut stream, MAX_RELAY_FRAME_BYTES) {
        Ok(RelayAnswer::Paired) => Ok(stream),
        // 이 셋을 한 문장으로 뭉치지 않는다. "컴퓨터가 꺼져 있다" 는 사용자가
        // 고칠 수 있는 것이고, 나머지는 아니다.
        Ok(RelayAnswer::Unavailable {
            reason: RelayUnavailable::Offline,
        }) => Err(HubClientError::ComputerOffline),
        Ok(RelayAnswer::Unavailable { reason }) => {
            Err(HubClientError::Protocol(format!("릴레이: {reason:?}")))
        }
        Err(error) => Err(HubClientError::Unreachable(error.to_string())),
    }
}

/// 붙어서 목록을 받아 오는 것 전부.
///
/// 인터넷 릴레이가 없는 옛 페어링은 연결하지 않는다. 사설 주소를 먼저 만지는
/// 것만으로 iOS Local Network 권한이 필요해지고, 제품의 연결 모델도 네트워크
/// 변경에 다시 묶이기 때문이다.
pub fn fetch_catalog(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
) -> Result<(HubHelloAck, HubCatalog), HubClientError> {
    // 소켓을 열기 전에 거른다. 고정된 값이 지문이 아니면 이 연결은 아무것도
    // 검증하지 못하고, 그 상태로 붙는 것은 아무 기계나 믿는 것과 같다.
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;

    let ack = handshake(&mut tls, token)?;
    let catalog = read_catalog(&mut tls)?;
    Ok((ack, catalog))
}

/// 세션 하나의 변경 목록을 묻는다.
///
/// 다른 hub request와 같은 모양이고 같은 이유다 — 한 번의 TLS 왕복, 한 번의
/// 악수, 그리고 노트북이 돌려주는 문서 하나. 다른 것은 읽는 문서의 종류뿐이다.
///
/// # Errors
/// 지문이 쓸 수 없거나, 붙지 못하거나, 노트북이 모르는 판을 돌려주면.
pub fn send_git_status(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    request: HubRequest,
) -> Result<dure_hub_protocol::HubGitStatusResult, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    let _ack = handshake_for(&mut tls, token, request)?;
    dure_hub_protocol::git_status::read(&mut tls)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

/// 파일 하나의 패치를 묻는다. [`send_git_status`] 와 같은 왕복, 다른 답 문서다.
///
/// 한 함수로 묶지 않는 이유는 답이 다른 봉투이기 때문이다 — 하나로 묶으면
/// 어느 문서를 읽을지 요청의 종류로 다시 갈라야 하고, 그 분기가 틀리면
/// 프레임이 어긋나 다음 읽기까지 조용히 깨진다.
pub fn send_file_diff(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    request: HubRequest,
) -> Result<dure_hub_protocol::HubFileDiffResult, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    let _ack = handshake_for(&mut tls, token, request)?;
    dure_hub_protocol::file_diff::read(&mut tls)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

/// "새 에이전트" 폼이 열렸다. 무엇을 고를 수 있는지 묻는다.
///
/// [`send_git_status`] 와 같은 모양이고 같은 이유다 — 한 번의 TLS 왕복, 한 번의
/// 악수, 그리고 노트북이 돌려주는 문서 하나.
///
/// # Errors
/// 지문이 쓸 수 없거나, 붙지 못하거나, 노트북이 모르는 판을 돌려주면.
pub fn send_launch_offer(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
) -> Result<dure_hub_protocol::launch_offer::HubLaunchOffer, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    let _ack = handshake_for(&mut tls, token, HubRequest::LaunchOffer)?;
    dure_hub_protocol::launch_offer::read(&mut tls)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

/// Read or create a local folder on the hub computer.
pub fn send_folder_browser(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    request: HubRequest,
) -> Result<dure_hub_protocol::folder_browser::HubFolderBrowserResult, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    let _ack = handshake_for(&mut tls, token, request)?;
    dure_hub_protocol::folder_browser::read(&mut tls)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

/// 에이전트를 하나 띄워 달라고 한다.
///
/// 읽기들과 같은 길을 쓰지만 이것은 **쓰기**다. 요청이 들고 가는 `action_id` 가
/// 그 차이를 감당한다 — 답이 오는 길이 끊겨 폰이 다시 물어도, 노트북은 같은
/// 누름인 줄 알아보고 에이전트를 하나만 띄운다.
///
/// # Errors
/// 지문이 쓸 수 없거나, 붙지 못하거나, 노트북이 모르는 판을 돌려주면.
pub fn send_start_agent(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    request: HubRequest,
) -> Result<dure_hub_protocol::start_agent::HubStartAgentResult, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    let _ack = handshake_for(&mut tls, token, request)?;
    dure_hub_protocol::start_agent::read(&mut tls)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

pub(crate) fn dial_tls(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
) -> Result<StreamOwned<ClientConnection, TcpStream>, HubClientError> {
    if !fingerprint::is_fingerprint(pinned_fingerprint) {
        return Err(HubClientError::UnusablePin);
    }
    let (host, _) = split_endpoint(endpoint)?;
    let (relay_endpoint, server_id) = relay.ok_or(HubClientError::RelayRequired)?;
    let transport = dial_relay(relay_endpoint, server_id, RELAY_DIAL_TIMEOUT)?;
    attach_tls(transport, pinned_fingerprint, host)
}

fn gateway_tls(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    writable: bool,
    box_id: &str,
) -> Result<StreamOwned<ClientConnection, TcpStream>, HubClientError> {
    let mut tls = dial_tls(endpoint, relay, pinned_fingerprint)?;
    handshake_for(
        &mut tls,
        token,
        HubRequest::Attach {
            writable,
            box_id: box_id.to_string(),
        },
    )?;
    Ok(tls)
}

pub fn resolve_session_successor(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    box_id: &str,
    source: &hmux_client::SessionFence,
) -> Result<SessionResolution<crate::catalog::RemoteSession>, HubClientError> {
    let started = Instant::now();
    let tls = gateway_tls(endpoint, relay, pinned_fingerprint, token, false, box_id)?;
    resolve_gateway_session(
        tls,
        source,
        REQUEST_TIMEOUT.saturating_sub(started.elapsed()),
    )
}

fn resolve_gateway_session(
    tls: StreamOwned<ClientConnection, TcpStream>,
    source: &hmux_client::SessionFence,
    budget: Duration,
) -> Result<SessionResolution<crate::catalog::RemoteSession>, HubClientError> {
    let (reader, writer, interrupt) = dure_hub_protocol::tls::split(tls)
        .map_err(|error| HubClientError::Unreachable(error.to_string()))?;
    let (mut reader, mut writer, interrupt) =
        crate::hub_transport::frame_halves(reader, writer, interrupt);
    let watchdog = crate::relay::Watchdog::arm(interrupt, budget);
    let answer = session_resolution::request(source)
        .map_err(HubClientError::Gateway)
        .and_then(|request| {
            writer
                .write_frame(&request)
                .map_err(|error| HubClientError::Unreachable(error.to_string()))?;
            session_resolution::read(&mut reader, source).map_err(HubClientError::Gateway)
        });
    if watchdog.fired() {
        return Err(HubClientError::Unreachable(
            "Session resolution timed out; reconnect to check again".into(),
        ));
    }
    answer
}

pub fn open_transport(
    endpoint: &str,
    relay: Option<(&str, &str)>,
    pinned_fingerprint: &str,
    token: &str,
    writable: bool,
    box_id: &str,
) -> Result<(AttachedTransport, Arc<dyn TransportInterrupt>), HubClientError> {
    let tls = gateway_tls(endpoint, relay, pinned_fingerprint, token, writable, box_id)?;
    let (reader, writer, interrupt) = dure_hub_protocol::tls::split(tls)
        .map_err(|error| HubClientError::Unreachable(error.to_string()))?;
    let (reader, writer, interrupt) = crate::hub_transport::frame_halves(reader, writer, interrupt);
    let handle = Arc::clone(&interrupt) as Arc<dyn TransportInterrupt>;
    Ok((
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), interrupt),
        handle,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::catalog::HUB_CATALOG_VERSION;
    use dure_hub_protocol::hello::HUB_HELLO_VERSION;
    use std::io::Cursor;

    /// 읽을 것을 미리 넣어 두고, 쓴 것을 모아 두는 스트림.
    struct Duplex {
        incoming: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl Duplex {
        fn new(incoming: Vec<u8>) -> Self {
            Self {
                incoming: Cursor::new(incoming),
                written: Vec::new(),
            }
        }
    }

    impl Read for Duplex {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.incoming.read(buffer)
        }
    }

    impl Write for Duplex {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(buffer);
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn verifier(pinned: &str) -> PinnedCertificate {
        PinnedCertificate {
            fingerprint: pinned.to_string(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }

    fn verify(
        pinned: &str,
        presented: &[u8],
        intermediates: &[CertificateDer<'static>],
    ) -> Result<ServerCertVerified, rustls::Error> {
        verifier(pinned).verify_server_cert(
            &CertificateDer::from(presented.to_vec()),
            intermediates,
            &ServerName::try_from("hub.invalid").expect("이름"),
            &[],
            UnixTime::since_unix_epoch(Duration::from_secs(1_800_000_000)),
        )
    }

    #[test]
    fn the_pinned_certificate_is_accepted() {
        let der = b"the laptop's certificate";
        assert!(verify(&fingerprint::of_der(der), der, &[]).is_ok());
    }

    /// 이 시험이 이 모듈의 존재 이유다. 통과하면 폰은 아무 기계나 자기
    /// 노트북으로 받아들인다.
    #[test]
    fn another_machines_certificate_is_refused() {
        let pinned = fingerprint::of_der(b"the laptop");
        assert!(verify(&pinned, b"someone else entirely", &[]).is_err());
    }

    /// 모양이 깨진 지문을 들고 있으면 **아무것도** 받아들이지 않는다.
    ///
    /// 빈 문자열이 통과하는 상태가 이 파일에서 만들어질 수 있는 유일한
    /// 재앙이다 — 아무것도 고정하지 않은 폰이 아무 기계나 믿게 된다.
    #[test]
    fn a_pin_that_is_not_a_fingerprint_accepts_nothing() {
        for broken in ["", "SHA256:", "SHA256:abc", "not a fingerprint"] {
            assert!(verify(broken, b"anything at all", &[]).is_err(), "{broken}");
        }
    }

    /// 허브는 인증서 하나만 내민다. 사슬이 왔다면 저쪽은 허브가 아니다.
    #[test]
    fn a_certificate_chain_is_refused_even_when_the_leaf_matches() {
        let leaf = b"the laptop's certificate";
        let pinned = fingerprint::of_der(leaf);
        let intermediates = vec![CertificateDer::from(b"an intermediate".to_vec())];

        assert!(verify(&pinned, leaf, &intermediates).is_err());
    }

    #[test]
    fn attaching_tls_refuses_an_unusable_pin_without_touching_the_stream() {
        let outcome = attach_tls(Duplex::new(Vec::new()), "SHA256:abc", "192.168.0.12");

        assert!(matches!(outcome, Err(HubClientError::UnusablePin)));
    }

    #[test]
    fn fetching_refuses_an_unusable_pin_before_opening_a_socket() {
        // 주소는 아무도 듣고 있지 않은 곳이다. 지문 검사가 먼저라면 이 시험은
        // 즉시 끝나고, 순서가 뒤집히면 접속 시도의 마감만큼 걸린다.
        let outcome = fetch_catalog("127.0.0.1:9", None, "not a fingerprint", "token-1");

        assert!(matches!(outcome, Err(HubClientError::UnusablePin)));
    }

    #[test]
    fn a_hub_without_an_internet_relay_is_refused_before_local_network_dial() {
        let outcome = fetch_catalog(
            "192.168.0.12:47823",
            None,
            &fingerprint::of_der(b"the laptop"),
            "token-1",
        );

        assert_eq!(
            outcome.expect_err("relay is required").code(),
            "hub_relay_required"
        );
    }

    #[test]
    fn the_handshake_sends_the_token_the_hub_will_read() {
        let ack = hello::encode_ack("device-1", "내 폰").expect("ack");
        let mut stream = Duplex::new(ack);

        let received = handshake(&mut stream, "token-1").expect("ack 를 읽는다");

        assert_eq!(received.device_id, "device-1");
        assert_eq!(received.hub_hello_version, HUB_HELLO_VERSION);
        // 보낸 바이트가 허브의 읽는 쪽에 그대로 먹혀야 한다.
        let sent = hello::read_hello(&mut stream.written.as_slice()).expect("허브가 읽는다");
        assert_eq!(sent.token, "token-1");
    }

    /// 허브는 등록되지 않은 기기에 이유를 말하지 않고 끊는다. 그 침묵이
    /// "형식 오류" 로 번역되면 사용자는 네트워크를 보러 간다.
    #[test]
    fn a_hub_that_closes_without_answering_reads_as_a_refusal() {
        let mut stream = Duplex::new(Vec::new());

        let outcome = handshake(&mut stream, "token-1");

        assert!(
            matches!(outcome, Err(HubClientError::Refused)),
            "{outcome:?}"
        );
        assert_eq!(
            HubClientError::Refused.code(),
            "hub_refused",
            "화면이 분기하는 값"
        );
    }

    #[test]
    fn the_catalog_the_hub_wrote_is_the_catalog_the_phone_reads() {
        let sent = HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: Vec::new(),
            unreachable: vec![dure_hub_protocol::catalog::UnreachableBox {
                box_id: "gate1".to_string(),
                box_label: "Gate1".to_string(),
                detail: "시간이 초과되었습니다".to_string(),
            }],
        };
        let mut stream = Duplex::new(catalog::encode(&sent).expect("encodes"));

        let received = read_catalog(&mut stream).expect("목록을 읽는다");

        assert_eq!(received, sent);
    }

    #[test]
    fn an_ipv6_endpoint_is_split_at_the_port_not_the_first_colon() {
        assert_eq!(
            split_endpoint("[fe80::1]:47823").expect("갈린다"),
            ("[fe80::1]", 47823)
        );
        assert_eq!(
            split_endpoint("192.168.0.12:47823").expect("갈린다"),
            ("192.168.0.12", 47823)
        );
    }

    #[test]
    fn an_endpoint_without_a_port_is_named_rather_than_dialled() {
        assert!(matches!(
            split_endpoint("192.168.0.12"),
            Err(HubClientError::Unreachable(_))
        ));
    }

    #[test]
    fn an_interrupted_connect_is_retried_under_the_same_deadline() {
        let mut attempts = 0;
        let connected = connect_before(Instant::now() + Duration::from_secs(1), |_| {
            attempts += 1;
            if attempts == 1 {
                Err(io::Error::from(io::ErrorKind::Interrupted))
            } else {
                Ok("connected")
            }
        })
        .expect("the transient interruption is retried");

        assert_eq!(connected, "connected");
        assert_eq!(attempts, 2);
    }

    /// 대괄호는 주소 표기이지 이름의 일부가 아니다. 그대로 넘기면 rustls 가
    /// 이름으로 받지 않고, 폴백이 조용히 삼킨다.
    #[test]
    fn a_bracketed_address_becomes_a_usable_server_name() {
        assert_eq!(
            server_name_for("[fe80::1]"),
            ServerName::try_from("fe80::1").expect("주소는 이름이다")
        );
        assert_eq!(
            server_name_for("192.168.0.12"),
            ServerName::try_from("192.168.0.12").expect("주소는 이름이다")
        );
    }
}
