//! 허브가 릴레이로 **나가** 붙는 쪽.
//!
//! 폰이 같은 와이파이 밖에 있을 때의 유일한 길이다. 리스너는 `0.0.0.0` 에
//! 바인딩해도 캐리어 NAT 뒤의 폰에서 갈 길이 없고, 집 공유기에 포트를 여는 것은
//! 이 제품이 없애려는 바로 그 요구다(`hub/mod.rs` 머리말).
//!
//! # 이 파일이 새 프로토콜을 만들지 않는다
//!
//! 릴레이가 이어 준 소켓은 [`super::server::serve_tracked_paired_connection`] 으로
//! 그대로 들어간다 — 리스너가 `accept` 한 소켓과 **같은 함수**다. TLS, 기기 토큰,
//! 카탈로그 허용 목록, 앞으로 붙을 attach 규칙까지 한 벌만 존재한다.
//!
//! 두 벌이 되는 순간 "직결에서는 되는데 릴레이에서만 안 되는" 부류가 생기고,
//! 그 부류는 집에서는 재현되지 않는다.
//!
//! # 무엇을 릴레이에게 주는가
//!
//! `server_id` 와 인증서(공개값), 그리고 릴레이가 낸 난수에 대한 서명. 기기
//! 토큰도, 세션 목록도, 개인키도 가지 않는다 — 그것들은 폰과 이 프로세스 사이의
//! TLS 안에서만 흐르고, 그 TLS 는 릴레이를 **통과**할 뿐이다.

use super::devices::DeviceRegistry;
use super::identity::HubCertificate;
use super::server::{
    serve_tracked_paired_connection, CatalogSource, HubServices, LiveConnections, ServedHub,
};
use dure_hub_protocol::frame::{self, FrameError};
use dure_hub_protocol::relay::{
    decode_nonce, encode_bytes, registration_transcript, RelayAnswer, RelayChallenge,
    RelayControlEvent, RelayHello, RelayProof, RelayRole, MAX_RELAY_FRAME_BYTES,
    RELAY_PROTOCOL_VERSION,
};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use serde::Serialize;
use std::io::Write as _;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 등록을 마치기까지 기다리는 시간.
const REGISTER_TIMEOUT: Duration = Duration::from_secs(15);

/// 등록 뒤 릴레이가 조용해도 되는 시간.
///
/// 릴레이의 ping 주기(60초)의 세 배다. 한 번 놓친 것으로 끊으면 잠깐 밀린
/// 네트워크에서 멀쩡한 연결이 계속 재설정되고, 재설정마다 폰이 못 붙는 창이
/// 생긴다. 두 번까지 봐주고 세 번째에 다시 붙는다.
const CONTROL_SILENCE_LIMIT: Duration = Duration::from_secs(180);

/// 재연결 사이의 첫 대기. 실패할 때마다 두 배가 되어 [`MAX_BACKOFF`] 에서 멈춘다.
///
/// 지수 후퇴를 쓰는 이유: 릴레이가 내려가 있으면 이 노트북만 붙는 것이 아니다.
/// 고정 간격으로 모두가 재시도하면 릴레이가 올라오는 순간 전부가 동시에 온다.
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// 릴레이를 통해 동시에 서빙하는 폰 수의 상한.
///
/// 리스너의 `MAX_CONNECTIONS` 와 같은 값이고 같은 이유다 — 이쪽은 소켓을 받는
/// 대신 걸어 나가지만, 아직 아무것도 증명하지 않은 상대 때문에 스레드가 생긴다는
/// 점은 같다. 폰 몇 대를 상정한 값이지 성능 손잡이가 아니다.
const MAX_RELAY_CONNECTIONS: usize = 8;

/// 다음 대기 시간. 두 배로 늘리되 상한을 넘지 않는다.
#[must_use]
pub fn next_backoff(current: Duration) -> Duration {
    current.saturating_mul(2).min(MAX_BACKOFF)
}

/// 이번 바퀴가 끝난 뒤의 대기 시간.
///
/// **등록까지 갔으면 처음으로 돌아간다.** 그 경로가 살아 있다는 것이 증명됐으므로
/// 그 뒤의 끊김은 새로 시작하는 것과 같다.
///
/// 이 판단을 `run_once` 의 반환값에 걸면 절대 되돌지 않는다 — 그 함수가 `Ok` 를
/// 돌려주는 것은 멈추라는 깃발을 봤을 때뿐이고, 평범한 끊김은 전부 `Err` 로
/// 나온다. 그러면 하루에 몇 번 끊기는 네트워크에서 대기가 상한(60초)까지 올라가고,
/// 그 뒤로는 폰이 1분씩 노트북을 못 본다.
#[must_use]
fn backoff_after(current: Duration, registered: bool) -> Duration {
    if registered {
        FIRST_BACKOFF
    } else {
        next_backoff(current)
    }
}

/// 화면이 보는 릴레이 상태.
///
/// `running` 과 `registered` 를 나누는 것이 요점이다. 스위치가 켜져 있다는 것과
/// 릴레이가 이 기계를 안다는 것은 다른 사실이고, 하나로 묶으면 사용자는 폰에서
/// 왜 안 보이는지 알 수 없다.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct RelayStatus {
    pub running: bool,
    pub registered: bool,
    pub endpoint: Option<String>,
    pub server_id: Option<String>,
    /// 마지막으로 알려진 실패 이유. 등록되면 지워진다.
    pub detail: Option<String>,
}

#[derive(Debug)]
pub enum RelayLinkError {
    /// 인증서 개인키로 서명할 수 없다. rcgen 기본값이 아닌 키다.
    UnusableKey(String),
    Io(String),
    Protocol(String),
    /// 릴레이가 등록을 거절했다.
    Rejected(String),
}

impl std::fmt::Display for RelayLinkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnusableKey(detail) => {
                write!(formatter, "Could not sign with the certificate key: {detail}")
            }
            Self::Io(detail) => write!(formatter, "Could not connect to the relay: {detail}"),
            Self::Protocol(detail) => write!(formatter, "Unexpected relay protocol response: {detail}"),
            Self::Rejected(detail) => write!(formatter, "The relay rejected registration: {detail}"),
        }
    }
}

impl std::error::Error for RelayLinkError {}

impl From<FrameError> for RelayLinkError {
    fn from(error: FrameError) -> Self {
        Self::Protocol(error.to_string())
    }
}

/// 릴레이와의 연결 하나. Tauri 상태로 관리된다.
#[derive(Default)]
pub struct RelayLink {
    status: Mutex<RelayStatus>,
    /// 살아 있는 다이얼 루프에게 그만두라고 말하는 깃발.
    stop: Mutex<Option<Arc<AtomicBool>>>,
    /// `start` 한 번마다 하나씩 나가는 번호. 아래 [`RelayLink::set`] 참조.
    generations: AtomicUsize,
    /// 지금 상태를 쓸 자격이 있는 세대.
    current: AtomicUsize,
    connections: Mutex<Option<Arc<LiveConnections>>>,
}

#[derive(Clone)]
struct PhoneService {
    tls: Arc<rustls::ServerConfig>,
    registry: Arc<DeviceRegistry>,
    hub: HubServices,
    connections: Arc<LiveConnections>,
    in_flight: Arc<AtomicUsize>,
}

struct RelayRegistration {
    endpoint: String,
    server_id: String,
    certificate: Arc<HubCertificate>,
}

impl RelayLink {
    #[must_use]
    pub fn status(&self) -> RelayStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    /// 이 세대의 상태를 기록한다. **지난 세대의 쓰기는 버린다.**
    ///
    /// 멈춤은 깃발만 세우고 루프는 다음 바퀴에서 본다. 그 "다음 바퀴" 가 최대
    /// 60초 뒤(후퇴 상한의 `sleep` 안)이거나 180초 뒤(control 침묵 상한의 `read`
    /// 안)다. 그동안 사용자가 스위치를 다시 켜면 새 루프가 돌고 있는데, 옛 루프가
    /// 그제서야 깨어나 `RelayStatus::default()` 를 쓴다.
    ///
    /// 화면이 "꺼짐" 으로 돌아가는 것만이 아니다. `hub_pairing_offer` 가
    /// `registered` 를 보고 QR 에 릴레이 주소를 실을지 정하므로, 그 순간 만든 QR
    /// 은 **릴레이 없이 나간다** — 스캔한 폰은 집 밖에서 조용히 못 붙고, 그
    /// 이유는 QR 안에 있어서 어디에도 드러나지 않는다.
    fn set_for(&self, generation: usize, status: RelayStatus) {
        if self.current.load(Ordering::Acquire) != generation {
            return;
        }
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// 세대를 따지지 않는 쓰기. 새 세대를 여는 `start` 와 `stop` 만 쓴다.
    fn set(&self, status: RelayStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// 이 링크의 다음 세대를 연다. 이전 세대의 쓰기는 이 시점부터 무시된다.
    fn open_generation(&self) -> usize {
        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        self.current.store(generation, Ordering::Release);
        generation
    }

    /// 돌고 있으면 멈춘다.
    ///
    /// 깃발만 세운다. 루프는 다음 바퀴에서 본다 — control 소켓의 `read` 안에
    /// 들어가 있을 수 있고, 그것을 밖에서 깨우려면 소켓을 닫아야 하는데 그
    /// 손잡이를 여기 두면 이 구조체가 소켓 수명을 알게 된다. 멈춤이 한 바퀴
    /// 늦는 대가로 소유가 한 곳에 남는다.
    ///
    /// 세대도 함께 올린다. 늦게 깨어난 옛 루프가 그때부터 아무것도 못 쓴다.
    pub fn stop(&self) {
        if let Ok(mut stop) = self.stop.lock() {
            if let Some(flag) = stop.take() {
                flag.store(true, Ordering::Release);
            }
        }
        if let Ok(mut connections) = self.connections.lock() {
            if let Some(connections) = connections.take() {
                connections.close_all();
            }
        }
        self.open_generation();
        self.set(RelayStatus::default());
    }

    pub fn disconnect_device(&self, device_id: &str) {
        if let Ok(connections) = self.connections.lock() {
            if let Some(connections) = connections.as_ref() {
                connections.close_device(device_id);
            }
        }
    }
}

/// 릴레이와 계속 붙어 있는 루프를 띄운다.
///
/// 스레드는 끊길 때마다 후퇴하며 다시 붙는다. 노트북 잠자기·네트워크 전환·릴레이
/// 재시작이 전부 같은 경로다.
pub fn start(
    link: &Arc<RelayLink>,
    endpoint: String,
    server_id: String,
    certificate: Arc<HubCertificate>,
    tls: Arc<rustls::ServerConfig>,
    registry: Arc<DeviceRegistry>,
    source: Arc<dyn CatalogSource>,
) {
    start_inner(
        link,
        endpoint,
        server_id,
        certificate,
        tls,
        registry,
        HubServices::catalog_only(source),
    );
}

pub(super) fn start_with_gateway(
    link: &Arc<RelayLink>,
    endpoint: String,
    server_id: String,
    certificate: Arc<HubCertificate>,
    tls: Arc<rustls::ServerConfig>,
    registry: Arc<DeviceRegistry>,
    services: HubServices,
) {
    start_inner(
        link,
        endpoint,
        server_id,
        certificate,
        tls,
        registry,
        services,
    );
}

fn start_inner(
    link: &Arc<RelayLink>,
    endpoint: String,
    server_id: String,
    certificate: Arc<HubCertificate>,
    tls: Arc<rustls::ServerConfig>,
    registry: Arc<DeviceRegistry>,
    services: HubServices,
) {
    link.stop();
    let generation = link.open_generation();
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = link.stop.lock() {
        *slot = Some(Arc::clone(&stop));
    }
    let connections = Arc::new(LiveConnections::default());
    if let Ok(mut slot) = link.connections.lock() {
        *slot = Some(Arc::clone(&connections));
    }
    link.set(RelayStatus {
        running: true,
        registered: false,
        endpoint: Some(endpoint.clone()),
        server_id: Some(server_id.clone()),
        detail: None,
    });

    let link = Arc::clone(link);
    // 릴레이를 통해 동시에 서빙하는 폰 수. 리스너 쪽 상한과 같은 이유로 같은
    // 값이다 — 이쪽은 소켓을 받는 대신 걸어 나가지만, 아직 아무것도 증명하지
    // 않은 상대가 이 프로세스의 스레드를 원하는 만큼 쓰게 만들 수 있다는 점은
    // 똑같다.
    let in_flight = Arc::new(AtomicUsize::new(0));
    let phone_service = PhoneService {
        tls,
        registry,
        hub: services,
        connections,
        in_flight,
    };
    let registration = RelayRegistration {
        endpoint,
        server_id,
        certificate,
    };
    // 이번 바퀴에서 등록까지 갔는가.
    //
    // 후퇴를 되돌리는 조건이 `run_once` 의 반환값이면 안 된다. 그 함수가 `Ok` 를
    // 돌려주는 것은 **멈추라는 깃발을 봤을 때뿐**이고, 평범한 끊김은 전부 `Err`
    // 로 나온다 — 즉 등록에 성공한 뒤 끊겨도 후퇴는 줄지 않고 두 배씩 올라간다.
    // 하루에 몇 번 끊기는 네트워크에서 대기는 곧 상한(60초)에 붙고, 그 뒤로는
    // 폰이 1분씩 노트북을 못 본다 — 이 파일이 막겠다고 적어 둔 바로 그 상태다.
    let registered_once = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let mut backoff = FIRST_BACKOFF;
        while !stop.load(Ordering::Acquire) {
            registered_once.store(false, Ordering::Release);
            let outcome = run_once(
                &stop,
                &link,
                generation,
                &registration,
                &phone_service,
                &registered_once,
            );
            if let Err(error) = outcome {
                let mut status = link.status();
                status.registered = false;
                status.detail = Some(error.to_string());
                link.set_for(generation, status);
            }
            if stop.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(backoff);
            backoff = backoff_after(backoff, registered_once.load(Ordering::Acquire));
        }
        link.set_for(generation, RelayStatus::default());
    });
}

/// 붙어서 등록하고, 끊길 때까지 폰을 받는다.
fn run_once(
    stop: &Arc<AtomicBool>,
    link: &Arc<RelayLink>,
    generation: usize,
    registration: &RelayRegistration,
    phones: &PhoneService,
    registered_once: &Arc<AtomicBool>,
) -> Result<(), RelayLinkError> {
    let mut control = TcpStream::connect(&registration.endpoint)
        .map_err(|error| RelayLinkError::Io(error.to_string()))?;
    control
        .set_read_timeout(Some(REGISTER_TIMEOUT))
        .and_then(|()| control.set_write_timeout(Some(REGISTER_TIMEOUT)))
        .map_err(|error| RelayLinkError::Io(error.to_string()))?;

    write_frame(
        &mut control,
        &RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::HubControl,
            server_id: registration.server_id.clone(),
            connection_id: None,
        },
    )?;

    let challenge: RelayChallenge = frame::read(&mut control, MAX_RELAY_FRAME_BYTES)?;
    let nonce = decode_nonce(&challenge.nonce)?;
    let signature = sign_registration(&registration.certificate, &registration.server_id, &nonce)?;
    write_frame(
        &mut control,
        &RelayProof {
            certificate_der: encode_bytes(&registration.certificate.der),
            signature,
        },
    )?;

    match frame::read::<RelayControlEvent, _>(&mut control, MAX_RELAY_FRAME_BYTES)? {
        RelayControlEvent::Registered => {}
        RelayControlEvent::Rejected { reason } => {
            return Err(RelayLinkError::Rejected(format!("{reason:?}")));
        }
        other => return Err(RelayLinkError::Protocol(format!("{other:?}"))),
    }

    registered_once.store(true, Ordering::Release);
    {
        let mut status = link.status();
        status.registered = true;
        status.detail = None;
        link.set_for(generation, status);
    }

    // 등록 뒤에도 마감을 **남긴다**. 릴레이가 조용한 연결에 주기적으로 ping 을
    // 보내므로(`RelayControlEvent::Ping`), 그보다 오래 아무것도 오지 않는 것은
    // 정상이 아니다 — 릴레이가 죽었거나 경로가 끊겼다는 뜻이다.
    //
    // 마감을 벗기면 그 상태를 영원히 못 알아챈다. FIN 없이 끊긴 소켓 위에서
    // 노트북은 자기가 등록돼 있다고 믿은 채 앉아 있고, 폰은 밖에서 "컴퓨터가
    // 꺼져 있습니다" 를 본다.
    control
        .set_read_timeout(Some(CONTROL_SILENCE_LIMIT))
        .map_err(|error| RelayLinkError::Io(error.to_string()))?;

    while !stop.load(Ordering::Acquire) {
        let event: RelayControlEvent = frame::read(&mut control, MAX_RELAY_FRAME_BYTES)?;
        let RelayControlEvent::Incoming { connection_id } = event else {
            continue;
        };
        accept_phone(
            &registration.endpoint,
            &registration.server_id,
            &connection_id,
            phones,
        );
    }
    Ok(())
}

/// 폰 하나를 받으려고 데이터 연결을 연다.
///
/// **스레드를 띄운다.** 여기서 동기로 하면 이 폰이 붙어 있는 동안 control 연결의
/// `read` 가 돌지 않는다. `serve_one` 이 읽기마다 20초를 주므로, 핸드셰이크
/// 도중에 멈춘 폰 하나가 control 루프를 20~40초 막고 — 그 사이 릴레이의 페어링
/// 대기는 10초에 끝나므로 — 그동안 도착한 **다른 폰은 전부 `Timeout` 을 받는다.**
/// 세션을 오래 보고 있는 폰이 있으면 그동안 아무도 붙지 못한다.
///
/// 연결을 여는 것까지 스레드 안이다. 느린 `connect` 도 같은 자리를 막는다.
fn accept_phone(endpoint: &str, server_id: &str, connection_id: &str, service: &PhoneService) {
    // 상한을 넘으면 걸지 않는다. 동기 호출이던 시절에는 "한 번에 하나" 가 사실상의
    // 상한이었고, 스레드로 옮기면서 그것이 사라진다 — 상한 없이 옮기면 릴레이가
    // 보내는 `Incoming` 하나당 스레드 하나가 무한히 생긴다.
    //
    // 걸지 않은 자리는 릴레이의 페어링 대기가 10초 뒤에 정리하고, 폰은 다시
    // 시도하면 된다.
    if service.in_flight.load(Ordering::Acquire) >= MAX_RELAY_CONNECTIONS {
        return;
    }
    service.in_flight.fetch_add(1, Ordering::AcqRel);

    let endpoint = endpoint.to_string();
    let server_id = server_id.to_string();
    let connection_id = connection_id.to_string();
    let service = service.clone();
    let owned_in_flight = Arc::clone(&service.in_flight);
    let failed_in_flight = Arc::clone(&service.in_flight);

    let spawned = std::thread::Builder::new()
        .name("hub-relay-phone".to_string())
        .spawn(move || {
            serve_relayed_phone(&endpoint, &server_id, &connection_id, &service);
            owned_in_flight.fetch_sub(1, Ordering::AcqRel);
        });
    if spawned.is_err() {
        // 스레드를 못 만들었으면 자리도 잡고 있으면 안 된다. 안 돌려주면 상한이
        // 한 칸씩 영구히 줄어든다.
        failed_in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 데이터 연결 하나를 열어 폰을 서빙한다. 스레드 위에서 돈다.
fn serve_relayed_phone(
    endpoint: &str,
    server_id: &str,
    connection_id: &str,
    service: &PhoneService,
) {
    let Ok(mut data) = TcpStream::connect(endpoint) else {
        return;
    };
    let hello = RelayHello {
        relay_protocol_version: RELAY_PROTOCOL_VERSION,
        role: RelayRole::HubData,
        server_id: server_id.to_string(),
        connection_id: Some(connection_id.to_string()),
    };
    if write_frame(&mut data, &hello).is_err() {
        return;
    }
    match frame::read::<RelayAnswer, _>(&mut data, MAX_RELAY_FRAME_BYTES) {
        Ok(RelayAnswer::Paired) => {}
        _ => return,
    }

    // 여기서부터는 리스너가 받은 소켓과 구별되지 않는다.
    serve_tracked_paired_connection(
        data,
        Arc::clone(&service.tls),
        &service.registry,
        ServedHub {
            source: service.hub.source.as_ref(),
            gateway: service.hub.gateway.as_ref(),
            statuses: service.hub.statuses.as_deref(),
            launches: service.hub.launches.as_deref(),
            launch: service.hub.launch.as_deref(),
            diffs: service.hub.diffs.as_deref(),
            files: service.hub.files.as_deref(),
        },
        &service.connections,
    );
}

/// 등록 증명. 인증서 개인키로 릴레이가 낸 난수에 서명한다.
fn sign_registration(
    certificate: &HubCertificate,
    server_id: &str,
    nonce: &[u8],
) -> Result<String, RelayLinkError> {
    let random = SystemRandom::new();
    let key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_ASN1_SIGNING,
        &certificate.private_key_der,
        &random,
    )
    .map_err(|error| RelayLinkError::UnusableKey(error.to_string()))?;
    let signature = key
        .sign(&random, &registration_transcript(server_id, nonce))
        .map_err(|error| RelayLinkError::UnusableKey(error.to_string()))?;
    Ok(encode_bytes(signature.as_ref()))
}

fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), RelayLinkError> {
    let framed = frame::encode(value, MAX_RELAY_FRAME_BYTES)?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        .map_err(|error| RelayLinkError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::catalog::{HubCatalog, HUB_CATALOG_VERSION};
    use crate::hub::identity::{load_or_create_certificate, load_or_create_server_id};
    use crate::hub::listener::server_config;
    use dure_hub_protocol::hello;
    use std::net::TcpListener;

    struct EmptyCatalog;

    impl CatalogSource for EmptyCatalog {
        fn catalog(&self) -> HubCatalog {
            HubCatalog {
                hub_catalog_version: HUB_CATALOG_VERSION,
                layout: None,
                sessions: Vec::new(),
                unreachable: Vec::new(),
            }
        }
    }

    #[test]
    fn backoff_doubles_and_stops_at_the_ceiling() {
        let mut backoff = FIRST_BACKOFF;
        for _ in 0..20 {
            backoff = next_backoff(backoff);
        }
        assert_eq!(backoff, MAX_BACKOFF, "상한을 넘지 않는다");
        assert_eq!(next_backoff(FIRST_BACKOFF), FIRST_BACKOFF * 2);
    }

    #[test]
    fn a_stored_server_id_survives_a_restart() {
        let root = tempfile::tempdir().unwrap();
        let first = load_or_create_server_id(root.path()).unwrap();
        let second = load_or_create_server_id(root.path()).unwrap();
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    /// 빈 파일을 조용히 새 값으로 덮으면 릴레이에 등록된 이름이 바뀌고, 폰들은
    /// 이유 없이 못 붙는다.
    #[test]
    fn an_empty_server_id_file_is_named_rather_than_replaced() {
        let root = tempfile::tempdir().unwrap();
        let existing = load_or_create_server_id(root.path()).unwrap();
        std::fs::write(root.path().join("hub-server-id"), "").unwrap();

        assert!(load_or_create_server_id(root.path()).is_err());
        // 원본이 덮이지 않았어야 다음 복구가 가능하다.
        assert!(!existing.is_empty());
    }

    #[test]
    fn the_certificate_key_can_sign_a_registration() {
        let root = tempfile::tempdir().unwrap();
        let certificate = load_or_create_certificate(root.path()).unwrap();

        let signature = sign_registration(&certificate, "server-1", b"nonce").expect("서명");

        // 릴레이의 검증자가 같은 증명을 받아들여야 한다 — 이 저장소 안에서
        // 서명하는 쪽과 검사하는 쪽이 갈리지 않는다는 것.
        let verified = dure_relay::proof::verify(
            "server-1",
            b"nonce",
            &RelayProof {
                certificate_der: encode_bytes(&certificate.der),
                signature,
            },
        )
        .expect("릴레이가 받아들인다");
        assert_eq!(verified.fingerprint, certificate.fingerprint());
    }

    /// 관통. 진짜 릴레이를 띄우고, 이 허브가 등록하고, 폰 흉내가 릴레이를 지나
    /// 붙어 목록을 받는다.
    #[test]
    fn a_phone_reaches_this_hub_through_a_real_relay() {
        let root = tempfile::tempdir().unwrap();
        let certificate = Arc::new(load_or_create_certificate(root.path()).unwrap());
        let server_id = load_or_create_server_id(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let device = registry.register("내 폰".to_string()).expect("기기 등록");

        // 진짜 릴레이.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let relay_endpoint = listener.local_addr().unwrap().to_string();
        let relay = Arc::new(dure_relay::Relay::new());
        std::thread::spawn(move || dure_relay::serve(&listener, &relay));

        let link = Arc::new(RelayLink::default());
        start(
            &link,
            relay_endpoint.clone(),
            server_id.clone(),
            Arc::clone(&certificate),
            server_config(&certificate).unwrap(),
            registry,
            Arc::new(EmptyCatalog),
        );

        // 등록될 때까지 기다린다.
        let mut registered = false;
        for _ in 0..100 {
            if link.status().registered {
                registered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(registered, "릴레이에 등록되어야 한다: {:?}", link.status());

        // 폰 흉내: 릴레이에 붙어 Paired 를 받고, 그 위에서 허브와 TLS.
        let mut phone = TcpStream::connect(&relay_endpoint).unwrap();
        phone
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        write_frame(
            &mut phone,
            &RelayHello {
                relay_protocol_version: RELAY_PROTOCOL_VERSION,
                role: RelayRole::Client,
                server_id,
                connection_id: None,
            },
        )
        .unwrap();
        let answer: RelayAnswer = frame::read(&mut phone, MAX_RELAY_FRAME_BYTES).unwrap();
        assert_eq!(answer, RelayAnswer::Paired);

        let mut tls = pinned_client(phone, &certificate.fingerprint());
        tls.write_all(&hello::encode_hello(&device.token).unwrap())
            .unwrap();
        tls.flush().unwrap();

        let ack = hello::read_ack(&mut tls).expect("허브가 이 기기를 받아들인다");
        assert_eq!(ack.device_label, "내 폰");

        let catalog = dure_hub_protocol::catalog::read(&mut tls).expect("목록이 건너온다");
        assert_eq!(catalog.hub_catalog_version, HUB_CATALOG_VERSION);

        link.stop();
    }

    /// 등록까지 간 바퀴 뒤에는 대기가 처음으로 돌아간다.
    ///
    /// 되돌지 않으면 하루에 몇 번 끊기는 네트워크에서 대기가 상한에 붙고, 그
    /// 뒤로는 폰이 1분씩 노트북을 못 본다 — 이 파일이 막겠다고 적어 둔 상태다.
    #[test]
    fn a_registration_that_worked_puts_the_backoff_back_to_the_start() {
        assert_eq!(backoff_after(Duration::from_secs(32), true), FIRST_BACKOFF);
        assert_eq!(backoff_after(MAX_BACKOFF, true), FIRST_BACKOFF);
    }

    /// 등록도 못 한 바퀴는 계속 물러난다. 위 시험만 있으면 후퇴가 통째로 사라져도 통과한다.
    #[test]
    fn a_round_that_never_registered_keeps_backing_off() {
        assert_eq!(
            backoff_after(Duration::from_secs(4), false),
            Duration::from_secs(8)
        );
        assert_eq!(backoff_after(MAX_BACKOFF, false), MAX_BACKOFF);
    }

    /// **늦게 깨어난 옛 루프가 새 링크의 상태를 덮지 못한다.**
    ///
    /// 멈춤은 깃발만 세우고 루프는 다음 바퀴에서 본다. 그 바퀴가 최대 60초
    /// (후퇴 상한의 `sleep`) 또는 180초(control 침묵 상한의 `read`) 뒤다. 그
    /// 사이에 사용자가 스위치를 다시 켜면 — 설정 화면에서 두 번 누르면 되는
    /// 일이다 — 새 루프가 도는데 옛 루프가 그제서야 깨어나 기본값을 쓴다.
    ///
    /// 화면이 "꺼짐" 으로 돌아가는 것만이 아니다. `hub_pairing_offer` 가
    /// `registered` 를 보고 QR 에 릴레이 주소를 실을지 정하므로, 그 순간 만든
    /// QR 은 릴레이 없이 나가고 스캔한 폰은 집 밖에서 조용히 못 붙는다.
    #[test]
    fn a_stale_loop_cannot_overwrite_a_newer_links_status() {
        let link = Arc::new(RelayLink::default());

        // 1세대가 살아 있는 상태를 쓴다.
        let stale = link.open_generation();
        link.set_for(
            stale,
            RelayStatus {
                running: true,
                registered: true,
                endpoint: Some("relay:8787".to_string()),
                server_id: Some("server-1".to_string()),
                detail: None,
            },
        );
        assert!(link.status().registered);

        // 껐다 켠다. 새 세대가 열린다.
        let fresh = link.open_generation();
        link.set_for(
            fresh,
            RelayStatus {
                running: true,
                registered: true,
                endpoint: Some("relay:8787".to_string()),
                server_id: Some("server-1".to_string()),
                detail: None,
            },
        );

        // 이제야 옛 루프가 깨어나 정리한다.
        link.set_for(stale, RelayStatus::default());

        assert!(
            link.status().registered,
            "옛 루프가 새 링크를 껐다 — 이 상태로 만든 QR 은 릴레이 주소 없이 나간다"
        );
    }

    /// 그래도 지금 세대의 쓰기는 통해야 한다.
    ///
    /// 위 시험만 있으면 `set_for` 를 아무것도 안 하는 함수로 만들어도 통과한다.
    #[test]
    fn the_current_generation_still_writes() {
        let link = Arc::new(RelayLink::default());
        let generation = link.open_generation();
        link.set_for(
            generation,
            RelayStatus {
                running: true,
                registered: true,
                endpoint: None,
                server_id: None,
                detail: None,
            },
        );
        assert!(link.status().registered);
    }

    /// **멈춘 폰 하나가 다음 폰을 막지 않는다.**
    ///
    /// `accept_phone` 이 동기였을 때의 실패다. `serve_one` 은 읽기마다 20초를
    /// 주므로, 핸드셰이크 도중에 멈춘 폰 하나가 control 루프를 그만큼 막는다.
    /// 그 사이 릴레이의 페어링 대기는 10초에 끝나므로, 그동안 도착한 다른 폰은
    /// 붙는 것이 아니라 `Timeout` 을 받는다. 세션을 오래 보고 있는 폰이 하나
    /// 있으면 그동안 아무도 못 붙는다는 뜻이기도 하다.
    ///
    /// 여기서 첫 폰은 `Paired` 만 받고 **아무것도 보내지 않는다** — TLS 도
    /// 시작하지 않는다. 허브 쪽은 그 연결에서 20초를 기다리게 되고, 그동안 두
    /// 번째 폰이 끝까지 갈 수 있어야 한다.
    #[test]
    fn a_stalled_phone_does_not_block_the_next_one() {
        let root = tempfile::tempdir().unwrap();
        let certificate = Arc::new(load_or_create_certificate(root.path()).unwrap());
        let server_id = load_or_create_server_id(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let device = registry.register("내 폰".to_string()).expect("기기 등록");

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let relay_endpoint = listener.local_addr().unwrap().to_string();
        let relay = Arc::new(dure_relay::Relay::new());
        std::thread::spawn(move || dure_relay::serve(&listener, &relay));

        let link = Arc::new(RelayLink::default());
        start(
            &link,
            relay_endpoint.clone(),
            server_id.clone(),
            Arc::clone(&certificate),
            server_config(&certificate).unwrap(),
            registry,
            Arc::new(EmptyCatalog),
        );

        let mut registered = false;
        for _ in 0..100 {
            if link.status().registered {
                registered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(registered, "릴레이에 등록되어야 한다: {:?}", link.status());

        // 첫 폰: 자리를 잡고 조용히 있는다. 끝까지 살려 둔다 — drop 하면 허브
        // 쪽 읽기가 깨어나 버려서 막는 상황 자체가 사라진다.
        let mut stalled = TcpStream::connect(&relay_endpoint).unwrap();
        write_frame(
            &mut stalled,
            &RelayHello {
                relay_protocol_version: RELAY_PROTOCOL_VERSION,
                role: RelayRole::Client,
                server_id: server_id.clone(),
                connection_id: None,
            },
        )
        .unwrap();
        let answer: RelayAnswer = frame::read(&mut stalled, MAX_RELAY_FRAME_BYTES).unwrap();
        assert_eq!(answer, RelayAnswer::Paired, "첫 폰은 이어져야 한다");

        // 두 번째 폰: 끝까지 간다. 동기였다면 여기서 `Timeout` 을 받는다.
        let mut phone = TcpStream::connect(&relay_endpoint).unwrap();
        phone
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        write_frame(
            &mut phone,
            &RelayHello {
                relay_protocol_version: RELAY_PROTOCOL_VERSION,
                role: RelayRole::Client,
                server_id,
                connection_id: None,
            },
        )
        .unwrap();
        let answer: RelayAnswer = frame::read(&mut phone, MAX_RELAY_FRAME_BYTES).unwrap();
        assert_eq!(
            answer,
            RelayAnswer::Paired,
            "멈춘 폰이 릴레이의 페어링 대기를 태워 버렸다"
        );

        let mut tls = pinned_client(phone, &certificate.fingerprint());
        tls.write_all(&hello::encode_hello(&device.token).unwrap())
            .unwrap();
        tls.flush().unwrap();
        let ack = hello::read_ack(&mut tls).expect("허브가 두 번째 폰도 받아들인다");
        assert_eq!(ack.device_label, "내 폰");

        drop(stalled);
        link.stop();
    }

    /// **배포된 진짜 릴레이**를 상대로 등록해 본다.
    ///
    /// 로컬 관통 시험은 이 프로세스가 띄운 릴레이를 상대한다. 그것으로는
    /// 배포가 살아 있는지, 방화벽·프록시·IP 할당이 맞는지 알 수 없다 — 그건
    /// 코드가 아니라 인프라의 성질이고, 인프라는 코드와 따로 깨진다.
    ///
    /// `#[ignore]`: 네트워크와 살아 있는 배포에 의존하므로 기본 스위트에서
    /// 뺀다. CI 가 이것에 기대게 되면 릴레이가 잠깐 내려갔을 때 무관한 변경이
    /// 빨개진다.
    ///
    /// ```sh
    /// DURE_RELAY_LIVE_ENDPOINT=149.248.220.81:8787 cargo test \
    ///   --manifest-path src-tauri/Cargo.toml --lib \
    ///   registers_against_the_live_relay -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn registers_against_the_live_relay() {
        let endpoint = std::env::var("DURE_RELAY_LIVE_ENDPOINT")
            .expect("DURE_RELAY_LIVE_ENDPOINT 에 배포된 릴레이 주소를 지정하세요");

        let root = tempfile::tempdir().unwrap();
        let certificate = Arc::new(load_or_create_certificate(root.path()).unwrap());
        // 실제 배포에 이 시험의 흔적을 영구히 남기지 않도록, 매번 새 임시
        // 디렉터리에서 새 server_id 를 만든다. 릴레이의 고정은 메모리에만
        // 있으므로 재시작하면 사라진다.
        let server_id = load_or_create_server_id(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));

        let link = Arc::new(RelayLink::default());
        start(
            &link,
            endpoint.clone(),
            server_id.clone(),
            Arc::clone(&certificate),
            server_config(&certificate).unwrap(),
            registry,
            Arc::new(EmptyCatalog),
        );

        let mut registered = false;
        for _ in 0..100 {
            if link.status().registered {
                registered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let status = link.status();
        link.stop();

        assert!(
            registered,
            "배포된 릴레이({endpoint})에 등록하지 못했습니다: {status:?}"
        );
        println!("등록됨: server_id={server_id} endpoint={endpoint}");
    }

    /// 폰 쪽 검증자와 같은 판단을 하는 최소 클라이언트.
    ///
    /// `mobile/src-tauri` 를 여기서 링크할 수는 없다(데스크탑이 폰 앱에
    /// 의존하게 된다). 지문 비교는 두 쪽 모두 `dure_hub_protocol::fingerprint`
    /// 를 부르므로 규칙 자체는 한 벌이다.
    fn pinned_client(
        transport: TcpStream,
        pin: &str,
    ) -> rustls::StreamOwned<rustls::ClientConnection, TcpStream> {
        #[derive(Debug)]
        struct Pinned {
            fingerprint: String,
            provider: Arc<rustls::crypto::CryptoProvider>,
        }

        impl rustls::client::danger::ServerCertVerifier for Pinned {
            fn verify_server_cert(
                &self,
                end_entity: &rustls::pki_types::CertificateDer<'_>,
                _intermediates: &[rustls::pki_types::CertificateDer<'_>],
                _server_name: &rustls::pki_types::ServerName<'_>,
                _ocsp: &[u8],
                _now: rustls::pki_types::UnixTime,
            ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
                if dure_hub_protocol::fingerprint::matches(end_entity.as_ref(), &self.fingerprint) {
                    Ok(rustls::client::danger::ServerCertVerified::assertion())
                } else {
                    Err(rustls::Error::General("지문이 다르다".into()))
                }
            }

            fn verify_tls12_signature(
                &self,
                message: &[u8],
                cert: &rustls::pki_types::CertificateDer<'_>,
                dss: &rustls::DigitallySignedStruct,
            ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error>
            {
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
            ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error>
            {
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

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned {
                fingerprint: pin.to_string(),
                provider,
            }))
            .with_no_client_auth();
        let connection = rustls::ClientConnection::new(
            Arc::new(config),
            rustls::pki_types::ServerName::try_from("hub.invalid").unwrap(),
        )
        .unwrap();
        rustls::StreamOwned::new(connection, transport)
    }
}
