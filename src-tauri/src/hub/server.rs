//! 리스너의 수명. 켜고, 끄고, 지금 상태를 말한다.
//!
//! # 왜 스레드마다 한 연결인가, 그리고 왜 개수를 묶나
//!
//! 이 리스너는 네트워크에 열려 있다. 연결마다 스레드를 무한히 띄우면 아직
//! 아무것도 증명하지 않은 쪽이 이 프로세스의 스레드를 원하는 만큼 쓰게 만들 수
//! 있다 — `hmux-runtime` 의 accept 루프가 같은 모양이지만, 그것은 도달 가능성이
//! 곧 같은 사용자를 뜻하는 유닉스 소켓이라는 단서가 붙어 있다. 여기에는 그
//! 단서가 없다.
//!
//! 그래서 동시 연결 수를 묶고, 넘으면 **받자마자 닫는다**. 대기열에 쌓지 않는
//! 이유: 쌓아 두면 메모리로 같은 문제가 되고, 폰은 다시 붙으면 그만이다.
//!
//! # 왜 `accept` 를 논블로킹으로 도나
//!
//! 끄려면 `accept` 를 깨워야 한다. 자기 자신에게 붙어 깨우는 방법도 있지만,
//! 그러면 인증 없는 연결이 하나 생기고 "그 연결은 예외" 라는 것을 아는 코드가 두
//! 곳에 필요해진다. 논블로킹 + 짧은 잠은 끄기 지연이 조금 늘 뿐이고, 그 지연은
//! 사람이 스위치를 누르는 시간에 묻힌다.

use super::file_diff;
use super::folder_browser;
use super::git_status;
use super::start_agent;
use super::catalog::{self, HubCatalog, HubCatalogEntry, UnreachableBox, HUB_CATALOG_VERSION};
use super::devices::DeviceRegistry;
use super::identity::HubCertificate;
use super::listener;
use dure_hub_protocol::{HubFileDiffResult, HubGitStatusResult};
use dure_hub_protocol::hello::HubRequest;
use serde::Serialize;
use std::io::Write as _;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 동시에 받는 연결의 상한.
///
/// 폰 몇 대를 상정한 값이지 성능 손잡이가 아니다. 넘는 연결은 받자마자 닫히므로
/// 이 값이 낮아서 생기는 최악은 사람이 다시 누르는 것이다.
const MAX_CONNECTIONS: usize = 8;

/// 논블로킹 `accept` 사이의 잠. 끄기 지연의 상한이기도 하다.
const ACCEPT_IDLE: std::time::Duration = std::time::Duration::from_millis(50);

/// 방금 이 허브가 놓은 포트를 OS 가 완전히 반환할 때까지 기다리는 상한.
///
/// 아무 포트나 재시도하면 실제 충돌을 숨긴다. 아래 재시도는 `HubServer` 가 직전에
/// 소유했던 정확한 endpoint 에만 적용되고, 그 밖의 `AddrInUse` 는 첫 bind 에서
/// 그대로 실패한다.
const OWNED_RESTART_BIND_BUDGET: std::time::Duration = std::time::Duration::from_millis(250);
const OWNED_RESTART_BIND_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

/// TLS 핸드셰이크와 인증을 마치기까지 주는 전체 시간.
///
/// `CONNECTION_TIMEOUT` 과 다른 것을 재는 값이다. 그쪽은 read 하나가 기다리는
/// 시간이고 이쪽은 연결이 인증 없이 살아 있을 수 있는 총 시간이다. 앞의 것만
/// 있으면 read 마다 예산이 새로 나와서 천천히 흘려보내는 상대를 막지 못한다.
const PRE_AUTH_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// 붙어 놓고 아무것도 보내지 않는 상대가 슬롯을 잡아 두지 못하게 하는 시간.
const CONNECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 화면이 보는 허브 상태.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct HubStatus {
    pub running: bool,
    /// 실제로 바인딩된 주소. 요청한 포트가 0 이면 OS 가 고른 값이 여기 들어온다.
    pub address: Option<String>,
    pub port: Option<u16>,
    /// 폰이 고정할 인증서 지문.
    pub fingerprint: Option<String>,
    /// 등록된 기기 수. 이름은 여기 넣지 않는다 — 상태 표시가 기기 목록을 겸하면
    /// 화면 하나가 두 가지를 말하게 되고, 취소 흐름이 어디에 붙는지 모호해진다.
    pub device_count: usize,
}

#[derive(Clone)]
pub(super) struct GatewayProcess {
    pub box_id: String,
    pub binary: PathBuf,
    pub discovery_root: PathBuf,
}

/// 이 연결이 닿을 수 있는 것들.
///
/// 셋을 따로 나르면 함수마다 인자가 늘고, 어느 조합이 유효한지를 각 자리에서
/// 다시 읽어야 한다 — 게이트웨이는 없을 수 있고 답 받을 곳도 없을 수 있는데,
/// 그 둘은 서로 무관하다. 한 묶음으로 두면 그 사실이 타입에 적힌다.
pub(super) struct ServedHub<'a> {
    pub source: &'a dyn CatalogSource,
    pub gateway: Option<&'a GatewayProcess>,
    /// 세션의 변경 목록을 읽어 줄 수 있는 쪽. 답과 무관하게 없을 수 있다.
    pub statuses: Option<&'a dyn git_status::GitStatusSink>,
    /// 에이전트를 띄워 줄 수 있는 쪽.
    pub launches: Option<&'a dyn start_agent::StartAgentSink>,
    /// 화면이 내려보낸 자리 목록. 화면이 없는 빌드에서는 "아직 안 보냄" 이다.
    pub launch: Option<&'a start_agent::LaunchOfferState>,
    /// 파일 하나의 패치를 읽어 줄 수 있는 쪽. 목록과 같은 화면이지만 다른
    /// 왕복이라 따로 붙는다 — 목록만 아는 빌드가 패치를 아는 척하면 안 된다.
    pub diffs: Option<&'a dyn file_diff::FileDiffSink>,
    pub files: Option<&'a dyn super::session_file::SessionFileSink>,
}

#[derive(Clone)]
pub(super) struct HubServices {
    pub source: Arc<dyn CatalogSource>,
    pub gateway: Option<GatewayProcess>,
    /// 세션의 변경 목록을 읽어 줄 수 있는 쪽.
    pub statuses: Option<Arc<dyn git_status::GitStatusSink>>,
    /// 에이전트를 띄워 줄 수 있는 쪽.
    pub launches: Option<Arc<dyn start_agent::StartAgentSink>>,
    /// 화면이 내려보낸 자리 목록.
    pub launch: Option<Arc<start_agent::LaunchOfferState>>,
    /// 파일 하나의 패치를 읽어 줄 수 있는 쪽.
    pub diffs: Option<Arc<dyn file_diff::FileDiffSink>>,
    pub files: Option<Arc<dyn super::session_file::SessionFileSink>>,
}

impl HubServices {
    pub(super) fn receiving_files(
        mut self,
        files: Arc<dyn super::session_file::SessionFileSink>,
    ) -> Self {
        self.files = Some(files);
        self
    }

    pub(super) fn catalog_only(source: Arc<dyn CatalogSource>) -> Self {
        Self {
            source,
            gateway: None,
            statuses: None,
            launches: None,
            launch: None,
            diffs: None,
            files: None,
        }
    }

    pub(super) fn with_gateway(source: Arc<dyn CatalogSource>, gateway: GatewayProcess) -> Self {
        Self {
            source,
            gateway: Some(gateway),
            statuses: None,
            launches: None,
            launch: None,
            diffs: None,
            files: None,
        }
    }

    /// 에이전트를 띄워 줄 쪽과, 화면이 내려보낸 자리 목록을 붙인다.
    ///
    /// 둘을 한 번에 받는 이유: 하나만 있으면 폰이 고를 수는 있는데 누를 수 없거나,
    /// 누를 수는 있는데 무엇을 고를지 모르는 화면이 된다. 둘 다 없는 것은 정상이고
    /// (시험용 리스너), 하나만 있는 것은 배선 실수다.
    #[must_use]
    pub(super) fn launching(
        mut self,
        launches: Arc<dyn start_agent::StartAgentSink>,
        launch: Arc<start_agent::LaunchOfferState>,
    ) -> Self {
        self.launches = Some(launches);
        self.launch = Some(launch);
        self
    }

    /// 변경 목록을 읽어 줄 쪽을 붙인다. 없으면 조회는 이유와 함께 거절된다.
    #[must_use]
    pub(super) fn reporting_status(
        mut self,
        statuses: Arc<dyn git_status::GitStatusSink>,
    ) -> Self {
        self.statuses = Some(statuses);
        self
    }

    /// 패치를 읽어 줄 쪽을 붙인다. 없으면 패치 요청은 이유와 함께 거절된다.
    #[must_use]
    pub(super) fn reporting_diffs(mut self, diffs: Arc<dyn file_diff::FileDiffSink>) -> Self {
        self.diffs = Some(diffs);
        self
    }
}

/// 돌고 있는 허브 하나. Tauri 상태로 관리된다.
#[derive(Default)]
pub struct HubServer {
    state: Mutex<HubServerState>,
}

#[derive(Default)]
struct HubServerState {
    running: Option<Running>,
    /// 명시적인 `stop` 뒤의 `start` 도 같은 소유권 근거를 쓸 수 있어야 한다.
    /// 다음 start 한 번이 가져가므로 오래된 포트에 재시도를 계속 허용하지 않는다.
    last_stopped: Option<StoppedEndpoint>,
}

struct Running {
    requested_address: String,
    requested_port: u16,
    address: String,
    port: u16,
    fingerprint: String,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    connections: Arc<LiveConnections>,
}

struct StoppedEndpoint {
    requested_address: String,
    requested_port: u16,
    bound_address: String,
    bound_port: u16,
}

impl StoppedEndpoint {
    fn from_running(running: &Running) -> Self {
        Self {
            requested_address: running.requested_address.clone(),
            requested_port: running.requested_port,
            bound_address: running.address.clone(),
            bound_port: running.port,
        }
    }

    fn matches(&self, address: &str, port: u16) -> bool {
        port != 0
            && ((self.requested_address == address && self.requested_port == port)
                || (self.bound_address == address && self.bound_port == port))
    }
}

/// 지금 붙어 있는 연결들. 끄기와 인증 마감이 둘 다 이것을 통해 손을 뻗는다.
///
/// # 왜 필요한가
///
/// 연결마다 띄운 스레드는 detached 다. 그 스레드는 `read` 안에 들어가 있고,
/// 밖에서 그것을 깨우는 유일한 방법은 소켓을 닫는 것이다. 이 등록부가 없으면
/// 두 가지가 불가능하다:
///
/// 1. **끄기가 이미 붙은 폰을 끊는 것.** `stop` 은 accept 루프만 세우므로,
///    등록부 없이는 앱을 종료해야 연결이 끊긴다 — 기기 접근을 취소한 사용자가
///    "취소했는데 왜 아직 붙어 있나" 를 겪는다.
/// 2. **인증 전 총 시간을 묶는 것.** `set_read_timeout` 은 `SO_RCVTIMEO` 라 read
///    하나마다 걸린다. 19 초마다 1 바이트씩 흘려보내는 상대는 매번 새 예산을
///    받아 슬롯을 무한히 잡는다. 상한이 8 이므로 그런 연결 여덟 개면 정작 폰이
///    못 붙고, 화면은 "켜져 있습니다" 라고 말한다.
#[derive(Default)]
pub(super) struct LiveConnections {
    entries: Mutex<Vec<LiveConnection>>,
    next_id: AtomicUsize,
    /// `close_all` 이 한 번이라도 돌았다. 그 뒤로는 아무것도 등록하지 않는다.
    ///
    /// 없으면 좁은 경합이 하나 남는다: accept 루프가 `stop` 을 확인한 뒤부터
    /// `register` 까지 사이에 `close_all` 이 지나가면, 그 연결은 이미 훑고 간
    /// 벡터에 뒤늦게 들어간다. 루프는 곧 `stop` 을 보고 끝나고 `Running` 이
    /// 버려지므로 이 등록부에 손을 뻗을 길이 사라진다 — 다음 `start` 는 새
    /// 등록부를 만든다. 그러면 그 연결은 앱을 종료해야 끊긴다.
    closed: AtomicBool,
}

struct LiveConnection {
    id: usize,
    /// `shutdown` 만 부르는 복제본. 읽고 쓰는 것은 연결 스레드가 가진 쪽이다.
    handle: std::net::TcpStream,
    /// 이 시각까지 인증을 마치지 못하면 닫는다.
    deadline: std::time::Instant,
    /// 인증을 마쳤다. 마감은 여기까지만 적용된다 — 붙은 뒤에는 조용한 것이
    /// 정상이고(터미널은 사용자가 타이핑할 때만 말한다), 그때부터 시간으로
    /// 끊으면 보고만 있는 폰이 끊긴다.
    authenticated: Arc<AtomicBool>,
    device_id: Arc<Mutex<Option<String>>>,
}

struct ConnectionRegistration {
    id: usize,
    authenticated: Arc<AtomicBool>,
    device_id: Arc<Mutex<Option<String>>>,
}

impl LiveConnections {
    /// 등록하고, 연결 스레드가 인증을 알릴 깃발과 지울 때 쓸 id 를 돌려준다.
    ///
    /// `try_clone` 이 실패하면 등록하지 않고 `None` 을 돌려준다. 그 연결은
    /// 끄기로도 마감으로도 닫히지 않으므로, 호출자는 서빙하지 않고 버려야 한다 —
    /// 닫을 수 없는 연결을 받아 두는 것은 상한만 먹고 아무도 못 끊는 슬롯을
    /// 만드는 일이다.
    fn register(
        &self,
        stream: &std::net::TcpStream,
        budget: std::time::Duration,
    ) -> Option<ConnectionRegistration> {
        let handle = stream.try_clone().ok()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let authenticated = Arc::new(AtomicBool::new(false));
        let device_id = Arc::new(Mutex::new(None));
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        // 잠금 *안에서* 본다. 밖에서 보면 `close_all` 이 그 사이에 지나갈 수 있고,
        // 그것이 막으려는 경합 그 자체다.
        entries.push(LiveConnection {
            id,
            handle,
            deadline: std::time::Instant::now() + budget,
            authenticated: Arc::clone(&authenticated),
            device_id: Arc::clone(&device_id),
        });
        Some(ConnectionRegistration {
            id,
            authenticated,
            device_id,
        })
    }

    /// 지금 등록된 연결 수. 시험이 "받아졌다" 를 고정 시간 대신 이것으로 기다린다.
    ///
    /// 제품 경로에는 세는 쪽이 없다 — 상한은 `live` 카운터가 지키고, 이 등록부는
    /// 닫기 위한 것이다. 그래서 시험 전용으로 못박는다.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    pub(super) fn forget(&self, id: usize) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        entries.retain(|entry| entry.id != id);
    }

    /// 인증을 마치지 못한 채 마감을 넘긴 연결을 닫는다.
    ///
    /// 등록부에서 지우지는 않는다. 지우는 것은 연결 스레드의 몫이고, 그 스레드는
    /// 닫힌 소켓에서 곧 오류를 받아 빠져나온다 — 여기서 함께 지우면 같은 id 를
    /// 두 번 지우는 경합이 생긴다.
    fn close_expired(&self) {
        let now = std::time::Instant::now();
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for entry in entries.iter() {
            if entry.authenticated.load(Ordering::Acquire) || now < entry.deadline {
                continue;
            }
            let _ = entry.handle.shutdown(std::net::Shutdown::Both);
        }
    }

    /// 전부 닫는다. 인증 여부를 보지 않는다 — 끄기는 "지금 붙어 있는 것을
    /// 끊는다" 는 뜻이어야 한다.
    pub(super) fn close_all(&self) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // 잠금을 쥔 채로 세운다. 그래야 이 뒤에 도착한 `register` 는 잠금을
        // 기다렸다가 깃발을 보고 물러난다.
        self.closed.store(true, Ordering::Release);
        for entry in entries.iter() {
            let _ = entry.handle.shutdown(std::net::Shutdown::Both);
        }
    }

    pub(super) fn close_device(&self, device_id: &str) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for entry in entries.iter() {
            let matches = entry
                .device_id
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_deref()
                == Some(device_id);
            if matches {
                let _ = entry.handle.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

/// 목록을 만들어 주는 것.
///
/// 트레이트로 두는 이유: 진짜 목록은 이 기계의 discovery root 를 읽고, 그건
/// 시험이 만들 수 없다. 리스너가 목록을 *흘리는지* 와 목록이 *무엇인지* 는 다른
/// 질문이고, 여기서 보는 것은 앞의 것이다.
pub trait CatalogSource: Send + Sync + 'static {
    fn catalog(&self) -> HubCatalog;

    fn remote_host(&self, _box_id: &str) -> Option<super::layout::RemoteHost> {
        None
    }
}

/// 이 기계의 로컬 세션.
pub struct LocalSessions {
    pub box_id: String,
    pub box_label: String,
    /// 화면이 내려보낸 사이드바 배치. 세션마다 여기서 자리를 찾아 붙인다.
    ///
    /// 공유된다 — 화면은 store 가 바뀔 때마다 갱신하고, 카탈로그는 폰이 붙을
    /// 때마다 읽는다. 그 둘은 서로 다른 시각에 일어난다.
    pub layout: Arc<super::layout::LayoutState>,
}

impl CatalogSource for LocalSessions {
    fn catalog(&self) -> HubCatalog {
        let layout = self.layout.get();
        std::thread::scope(|scope| {
            let remote = layout
                .remote_hosts
                .iter()
                .map(|host| (host, scope.spawn(move || crate::remote_hmux::hub_remote_catalog(host))))
                .collect::<Vec<_>>();
            let mut catalog = match crate::hmux::product_catalog_census(
                std::time::Duration::from_millis(1_500),
            ) {
                Ok((_catalog, sessions)) => HubCatalog {
                    hub_catalog_version: HUB_CATALOG_VERSION,
                    sessions: sessions
                        .iter()
                        .map(|descriptor| {
                            let mut entry =
                                catalog::entry_from(descriptor, &self.box_id, &self.box_label);
                            layout.present(&mut entry);
                            entry
                        })
                        .collect::<Vec<HubCatalogEntry>>(),
                    unreachable: Vec::new(),
                    layout: self.layout.to_catalog_layout(),
                },
                Err(error) => HubCatalog {
                    hub_catalog_version: HUB_CATALOG_VERSION,
                    layout: self.layout.to_catalog_layout(),
                    sessions: Vec::new(),
                    unreachable: vec![UnreachableBox {
                        box_id: self.box_id.clone(),
                        box_label: self.box_label.clone(),
                        detail: error.to_string(),
                    }],
                },
            };
            for (host, task) in remote {
                match task.join() {
                    Ok(Ok(sessions)) => {
                        catalog.sessions.extend(sessions.iter().map(|descriptor| {
                            let mut entry =
                                catalog::remote_entry_from(descriptor, &host.id, &host.name);
                            layout.present(&mut entry);
                            entry
                        }));
                    }
                    Ok(Err(detail)) => catalog.unreachable.push(UnreachableBox {
                        box_id: host.id.clone(),
                        box_label: host.name.clone(),
                        detail,
                    }),
                    Err(_) => catalog.unreachable.push(UnreachableBox {
                        box_id: host.id.clone(),
                        box_label: host.name.clone(),
                        detail: "remote catalog task stopped".to_string(),
                    }),
                }
            }
            catalog
        })
    }

    fn remote_host(&self, box_id: &str) -> Option<super::layout::RemoteHost> {
        self.layout.remote_host(box_id)
    }
}

impl HubServer {
    /// 켠다. 이미 돌고 있으면 먼저 끈다 — 두 리스너가 같은 인증서로 다른 포트를
    /// 듣고 있으면 페어링 QR 이 어느 쪽을 가리키는지 알 수 없다.
    pub fn start(
        &self,
        address: &str,
        port: u16,
        certificate: &HubCertificate,
        registry: Arc<DeviceRegistry>,
        source: Arc<dyn CatalogSource>,
    ) -> Result<HubStatus, String> {
        self.start_with_budget(
            (address, port),
            certificate,
            registry,
            HubServices::catalog_only(source),
            PRE_AUTH_BUDGET,
        )
    }

    pub(super) fn start_with_gateway(
        &self,
        address: &str,
        port: u16,
        certificate: &HubCertificate,
        registry: Arc<DeviceRegistry>,
        services: HubServices,
    ) -> Result<HubStatus, String> {
        self.start_with_budget(
            (address, port),
            certificate,
            registry,
            services,
            PRE_AUTH_BUDGET,
        )
    }

    /// 인증 마감을 주입하는 형태.
    ///
    /// 시험을 위해서만 갈라져 있다. 30 초를 기다리는 시험은 아무도 돌리지
    /// 않으므로, 마감이 *실제 루프를 지나 집행되는지* 를 보려면 그 값을 바꿔
    /// 끼울 수 있어야 한다 — 등록부를 직접 만들어 보는 시험은 루프가 그것을
    /// 부르는지까지는 말해 주지 못한다.
    fn start_with_budget(
        &self,
        endpoint: (&str, u16),
        certificate: &HubCertificate,
        registry: Arc<DeviceRegistry>,
        services: HubServices,
        pre_auth_budget: std::time::Duration,
    ) -> Result<HubStatus, String> {
        let (address, port) = endpoint;
        self.stop();

        let config = listener::server_config(certificate).map_err(|error| error.to_string())?;
        let owned_restart = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state
                .last_stopped
                .take()
                .is_some_and(|endpoint| endpoint.matches(address, port))
        };
        let socket = bind_listener(address, port, owned_restart)
            .map_err(|error| format!("Could not open a listener at {address}:{port}: {error}"))?;
        let bound = socket.local_addr().map_err(|error| error.to_string())?;
        socket
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;

        let stop = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(LiveConnections::default());
        let fingerprint = certificate.fingerprint();
        let handle = std::thread::spawn({
            let stop = stop.clone();
            let connections = Arc::clone(&connections);
            move || {
                serve_loop(
                    socket,
                    config,
                    registry,
                    services,
                    stop,
                    connections,
                    pre_auth_budget,
                )
            }
        });

        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.running = Some(Running {
            requested_address: address.to_string(),
            requested_port: port,
            address: bound.ip().to_string(),
            port: bound.port(),
            fingerprint: fingerprint.clone(),
            stop,
            handle: Some(handle),
            connections,
        });
        Ok(HubStatus {
            running: true,
            address: Some(bound.ip().to_string()),
            port: Some(bound.port()),
            fingerprint: Some(fingerprint),
            device_count: 0,
        })
    }

    /// 끈다. 돌고 있지 않으면 아무 일도 하지 않는다.
    ///
    /// 스레드가 끝날 때까지 기다린다. 기다리지 않으면 다음 `start` 가 같은 포트에
    /// 바인딩하려다 "주소 사용 중" 으로 실패하고, 사용자에게는 "껐다 켰더니 안
    /// 된다" 로 보인다.
    pub fn stop(&self) {
        let taken = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.running.take()
        };
        if let Some(mut running) = taken {
            let stopped_endpoint = StoppedEndpoint::from_running(&running);
            running.stop.store(true, Ordering::Release);
            // 붙어 있는 연결을 먼저 닫는다. accept 루프만 세우면 그 스레드들은
            // `read` 안에 남아 앱이 끝날 때까지 계속 서빙한다 — 사용자가 끄기를
            // 누른 뒤에도.
            running.connections.close_all();
            if let Some(handle) = running.handle.take() {
                let _ = handle.join();
            }
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            // 동시에 새 start 가 이미 성공했다면 그 리스너의 소유권을 덮지 않는다.
            if state.running.is_none() {
                state.last_stopped = Some(stopped_endpoint);
            }
        }
    }

    /// 지금 상태. 기기 수는 리스너가 아니라 목록이 아는 것이라 밖에서 받는다.
    pub fn status(&self, device_count: usize) -> HubStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        match state.running.as_ref() {
            Some(running) => HubStatus {
                running: true,
                address: Some(running.address.clone()),
                port: Some(running.port),
                fingerprint: Some(running.fingerprint.clone()),
                device_count,
            },
            None => HubStatus {
                running: false,
                address: None,
                port: None,
                fingerprint: None,
                device_count,
            },
        }
    }

    pub fn disconnect_device(&self, device_id: &str) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(running) = state.running.as_ref() {
            running.connections.close_device(device_id);
        }
    }
}

fn bind_listener(address: &str, port: u16, owned_restart: bool) -> std::io::Result<TcpListener> {
    bind_listener_with_retry(
        address,
        port,
        owned_restart,
        OWNED_RESTART_BIND_BUDGET,
        OWNED_RESTART_BIND_INTERVAL,
        listener::bind,
    )
}

fn bind_listener_with_retry(
    address: &str,
    port: u16,
    owned_restart: bool,
    budget: std::time::Duration,
    interval: std::time::Duration,
    mut bind: impl FnMut(&str, u16) -> std::io::Result<TcpListener>,
) -> std::io::Result<TcpListener> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        match bind(address, port) {
            Ok(socket) => return Ok(socket),
            Err(error) if owned_restart && error.kind() == std::io::ErrorKind::AddrInUse => {
                let now = std::time::Instant::now();
                if now >= deadline {
                    return Err(error);
                }
                std::thread::sleep(interval.min(deadline.saturating_duration_since(now)));
            }
            Err(error) => return Err(error),
        }
    }
}

impl Drop for HubServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve_loop(
    socket: TcpListener,
    config: Arc<rustls::ServerConfig>,
    registry: Arc<DeviceRegistry>,
    services: HubServices,
    stop: Arc<AtomicBool>,
    connections: Arc<LiveConnections>,
    pre_auth_budget: std::time::Duration,
) {
    let live = Arc::new(AtomicUsize::new(0));
    while !stop.load(Ordering::Acquire) {
        connections.close_expired();
        // 인증 마감은 여기서 집행한다. 이 루프는 어차피 `ACCEPT_IDLE` 마다
        // 깨어 있으므로 타이머 스레드를 따로 두지 않는다.
        match socket.accept() {
            Ok((stream, _)) => {
                // 상한을 넘으면 받자마자 닫는다. 대기열에 쌓으면 메모리로 같은
                // 문제가 되고, 폰은 다시 붙으면 그만이다.
                if live.load(Ordering::Acquire) >= MAX_CONNECTIONS {
                    drop(stream);
                    continue;
                }
                // 닫을 손잡이를 못 얻으면 서빙하지 않는다. 그런 연결은 끄기로도
                // 마감으로도 닫히지 않아서, 받아 두면 아무도 못 끊는 슬롯이 된다.
                let Some(registration) = connections.register(&stream, pre_auth_budget) else {
                    drop(stream);
                    continue;
                };
                live.fetch_add(1, Ordering::AcqRel);
                let config = config.clone();
                let registry = registry.clone();
                let services = services.clone();
                let live = live.clone();
                let connections = Arc::clone(&connections);
                std::thread::spawn(move || {
                    serve_one(
                        stream,
                        config,
                        registry.as_ref(),
                        ServedHub {
                            source: services.source.as_ref(),
                            gateway: services.gateway.as_ref(),
                            statuses: services.statuses.as_deref(),
                            launches: services.launches.as_deref(),
                            launch: services.launch.as_deref(),
                            diffs: services.diffs.as_deref(),
                            files: services.files.as_deref(),
                        },
                        &registration.authenticated,
                        Some(registration.device_id.as_ref()),
                    );
                    connections.forget(registration.id);
                    live.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_IDLE);
            }
            // 다른 오류로 루프를 멈추지 않는다. 한 연결이 실패하는 것과 리스너가
            // 죽는 것은 다르고, 후자는 사용자가 끌 때만 일어나야 한다.
            Err(_) => std::thread::sleep(ACCEPT_IDLE),
        }
    }
}

pub(super) fn serve_tracked_paired_connection(
    stream: std::net::TcpStream,
    config: Arc<rustls::ServerConfig>,
    registry: &DeviceRegistry,
    hub: ServedHub<'_>,
    connections: &Arc<LiveConnections>,
) {
    let Some(registration) = connections.register(&stream, PRE_AUTH_BUDGET) else {
        return;
    };
    serve_one(
        stream,
        config,
        registry,
        hub,
        &registration.authenticated,
        Some(registration.device_id.as_ref()),
    );
    connections.forget(registration.id);
}

fn serve_one(
    stream: std::net::TcpStream,
    config: Arc<rustls::ServerConfig>,
    registry: &DeviceRegistry,
    hub: ServedHub<'_>,
    authenticated: &AtomicBool,
    device_id: Option<&Mutex<Option<String>>>,
) {
    // BSD 계열(macOS 포함)에서 `accept` 는 리스너의 O_NONBLOCK 를 물려준다.
    // 리눅스는 물려주지 않는다. 되돌리지 않으면 첫 `read` 가 `WouldBlock` 으로
    // 즉시 실패하고, 폰 쪽에서는 "붙자마자 끊긴다" 로만 보인다 — 그리고 그
    // 증상은 리눅스 CI 에서 재현되지 않는다.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));

    // 연결마다 목록을 다시 읽는다. 켤 때 찍은 스냅샷을 들고 있으면 취소가 앱을
    // 다시 켤 때까지 반영되지 않는다 — `devices` 모듈 주석 참조.
    let devices = match registry.load() {
        Ok(devices) => devices,
        Err(error) => {
            // 목록을 읽지 못하면 아무도 통과하지 못한다. 조용히 실패하면
            // "폰이 안 붙는다" 만 남고 이유가 어디에도 없다.
            eprintln!("[hub] Rejecting the connection because the device list could not be read: {error}");
            return;
        }
    };

    let Ok(mut tls) = listener::accept_tls(stream, config) else {
        return;
    };
    let hello = match listener::read_hello(&mut tls, &devices) {
        Ok(hello) => hello,
        // 이유를 돌려주지 않는다 — 붙어 보는 것만으로 어떤 기기가 등록돼 있는지
        // 알 수 있게 되는 것을 막는다(`listener` 모듈 주석).
        Err(_) => return,
    };
    if let Some(slot) = device_id {
        *slot.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(hello.device.device_id.clone());
    }
    // 마감에서 벗어나는 지점. 여기까지 왔다는 것은 등록된 기기가 토큰을
    // 증명했다는 뜻이고, 그 뒤로 조용한 것은 정상이다 — 터미널은 사용자가
    // 타이핑할 때만 말한다.
    authenticated.store(true, Ordering::Release);
    if listener::write_ack(&mut tls, hello.device).is_err() {
        return;
    }

    // 이 빌드가 모르는 질문. 답할 말은 하나뿐이고, 그 하나를 **말하는** 것이
    // 요점이다: 아래로 흘려보내면 폰은 자기가 물은 것과 다른 문서(목록)를
    // 받아서 "형식 오류" 로 읽고, 그건 사람에게 다시 페어링하라는 뜻이 된다.
    // ack 는 위에서 이미 나갔으므로 폰이 보는 것은 조용한 종료이고, 그것이
    // 이 경우의 정직한 모양이다 — 이 노트북을 갱신하면 된다.
    if hello.request == HubRequest::Unsupported {
        return;
    }

    if let HubRequest::UpdatePushSubscriptionV1 { subscription } = &hello.request {
        use dure_hub_protocol::push::PushSubscriptionResult;
        let saved = super::push::update_subscription(
            registry,
            &hello.device.token,
            subscription.clone(),
            |subscription| super::push::check_registration(registry, subscription),
        );
        let result = match saved {
            Ok(()) => PushSubscriptionResult::Saved,
            Err(detail) => PushSubscriptionResult::Refused { detail },
        };
        if let Ok(frame) = dure_hub_protocol::frame::encode(&result, 4096) {
            let _ = tls.write_all(&frame);
            let _ = tls.flush();
        }
        return;
    }

    if let HubRequest::StageSessionFileV1 { session_id } = &hello.request {
        super::session_file::serve(&mut tls, session_id.clone(), hub.files);
        return;
    }

    if let HubRequest::BrowseFolder { path } = &hello.request {
        let result = folder_browser::browse(path.as_deref());
        match dure_hub_protocol::folder_browser::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the folder list in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::CreateFolder { parent, name } = &hello.request {
        let result = folder_browser::create(parent, name);
        match dure_hub_protocol::folder_browser::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the folder creation result in a frame: {error}"),
        }
        return;
    }

    if hello.request == HubRequest::LaunchOffer {
        // 화면이 내려보낸 그대로. 여기서 폴더를 세지 않는 이유는 `launch_offer.rs`
        // 머리말에 있다 — 스페이스·프로젝트·설치된 제공자는 전부 앱의 개념이고,
        // 같은 표를 Rust 에 한 벌 더 만들면 두 벌이 갈리는 날 폰은 없는 폴더를
        // 고를 수 있게 된다.
        let offer = match hub.launch {
            Some(state) => state.get(),
            // 화면이 없는 빌드(시험용 리스너). 빈 목록이 아니라 "아직 안 보냄"
            // 이다 — 그 둘은 사람이 할 일이 다르다.
            None => dure_hub_protocol::launch_offer::HubLaunchOffer::unpublished(),
        };
        match dure_hub_protocol::launch_offer::encode(&offer) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the location list in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::StartAgent {
        target_id,
        kind_id,
        action_id,
        use_worktree,
        branch,
    } = hello.request
    {
        // 띄우는 것은 화면이다 — 저널과 스폰 사가가 거기 있다(`start_agent.rs`).
        let result = match hub.launches {
            Some(sink) => sink.deliver(start_agent::StartAgentRequest {
                target_id,
                kind_id,
                action_id,
                use_worktree,
                branch,
                folder_path: None,
            }),
            None => dure_hub_protocol::start_agent::HubStartAgentResult::refused_with_code(
                "This desktop cannot launch agents",
                "screen_unreachable",
            ),
        };
        match dure_hub_protocol::start_agent::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the launch result in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::StartAgentInFolder {
        target_id,
        folder_path,
        kind_id,
        action_id,
        use_worktree,
        branch,
    } = hello.request
    {
        let result = match folder_browser::resolve(&folder_path) {
            Ok(folder_path) => match hub.launches {
                Some(sink) => sink.deliver(start_agent::StartAgentRequest {
                    target_id,
                    kind_id,
                    action_id,
                    use_worktree,
                    branch,
                    folder_path: Some(folder_path),
                }),
                None => dure_hub_protocol::start_agent::HubStartAgentResult::refused_with_code(
                    "This desktop cannot launch agents",
                    "screen_unreachable",
                ),
            },
            Err(detail) => dure_hub_protocol::start_agent::HubStartAgentResult::refused_with_code(
                detail,
                "folder_unavailable",
            ),
        };
        match dure_hub_protocol::start_agent::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the launch result in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::GitStatus { session_id, want } = hello.request {
        // 어느 저장소인지 아는 것은 화면이다 — 폰이 보낸 것은 hmux 세션 id 이고,
        // 그것을 워크트리로 옮기는 표는 앱의 개념 위에 있다(`git_status.rs`).
        let result = match hub.statuses {
            Some(sink) => sink.deliver(git_status::GitStatusRequest {
                session_id,
                want,
                intent: git_status::GitStatusIntent::Read,
            }),
            // 이 빌드에 화면이 없다(시험용 리스너). 조용히 닫으면 폰은 응답
            // 없음과 구별하지 못한다.
            None => HubGitStatusResult::refused("This desktop cannot read the change list"),
        };
        match dure_hub_protocol::git_status::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            // 아무것도 안 쓰고 끊으면 폰은 그것을 거절로 읽는다 — 그리고 왜
            // 그런지는 양쪽 어디에도 안 남는다.
            Err(error) => eprintln!("[hub] Could not encode the change list in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::FileDiff {
        session_id,
        path,
        commit,
    } = hello.request
    {
        // 같은 화면이 답한다 — 어느 워크트리인지 아는 것은 화면뿐이다. 경로가
        // 그 워크트리의 목록에 실제로 있는지도 거기서 확인한다.
        let result = match hub.diffs {
            Some(sink) => sink.deliver(file_diff::FileDiffRequest {
                session_id,
                path,
                commit,
            }),
            None => HubFileDiffResult::refused(path, "This desktop cannot read patches"),
        };
        match dure_hub_protocol::file_diff::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the patch in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::CreatePullRequest {
        session_id,
        title,
        body,
        draft,
    } = hello.request
    {
        // 같은 화면이 답한다 — 어느 워크트리인지 아는 것은 화면뿐이고, 그것은
        // 읽기든 쓰기든 같다.
        let result = match hub.statuses {
            Some(sink) => sink.deliver(git_status::GitStatusRequest {
                session_id,
                want: dure_hub_protocol::hello::GitStatusWant::PullRequest,
                intent: git_status::GitStatusIntent::CreateReview { title, body, draft },
            }),
            None => HubGitStatusResult::refused("This desktop cannot open reviews"),
        };
        match dure_hub_protocol::git_status::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the review result in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::CommitDetail { session_id, commit } = hello.request {
        // 같은 화면이 답한다 — 어느 워크트리인지 아는 것은 화면뿐이다. 그
        // sha 가 이 저장소의 커밋인지도 거기서 확인한다.
        let result = match hub.statuses {
            Some(sink) => sink.deliver(git_status::GitStatusRequest {
                session_id,
                want: dure_hub_protocol::hello::GitStatusWant::Commits,
                intent: git_status::GitStatusIntent::CommitDetail { commit },
            }),
            None => HubGitStatusResult::refused("This desktop cannot read commits"),
        };
        match dure_hub_protocol::git_status::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode commit details in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::SetReviewers {
        session_id,
        action_id,
        number,
        add,
        remove,
    } = hello.request
    {
        // 같은 화면이 답한다 — 어느 워크트리인지 아는 것은 화면뿐이다. 로그인의
        // 모양은 `forge.rs` 가 확인하고, 답은 바뀐 뒤의 리뷰다.
        let result = match hub.statuses {
            Some(sink) => sink.deliver(git_status::GitStatusRequest {
                session_id,
                want: dure_hub_protocol::hello::GitStatusWant::PullRequest,
                intent: git_status::GitStatusIntent::SetReviewers {
                    action_id,
                    number,
                    add,
                    remove,
                },
            }),
            None => HubGitStatusResult::refused("This desktop cannot change reviewers"),
        };
        match dure_hub_protocol::git_status::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the reviewer result in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::SourceControlWrite {
        session_id,
        action_id,
        action,
    } = hello.request
    {
        // 같은 화면이 답한다 — 어느 워크트리인지 아는 것은 화면뿐이고, 그것은
        // 읽기든 쓰기든 같다. 무엇이 허용되는지는 `scm_write.rs` 가 정한다.
        //
        // 답은 바뀐 뒤의 변경 목록이다. "보냈다" 로 끝내면 폰은 실패를 성공으로
        // 그리고, 목록을 다시 물으면 그 사이에 화면이 닫혀 있을 수 있다.
        let result = match hub.statuses {
            Some(sink) => sink.deliver(git_status::GitStatusRequest {
                session_id,
                want: dure_hub_protocol::hello::GitStatusWant::Changes,
                intent: git_status::GitStatusIntent::Write { action_id, action },
            }),
            None => HubGitStatusResult::refused("This desktop cannot modify the repository"),
        };
        match dure_hub_protocol::git_status::encode(&result) {
            Ok(framed) => {
                let _ = tls.write_all(&framed);
                let _ = tls.flush();
            }
            Err(error) => eprintln!("[hub] Could not encode the change result in a frame: {error}"),
        }
        return;
    }

    if let HubRequest::Attach { writable, box_id } = hello.request {
        if let Some(gateway) = hub.gateway.filter(|gateway| gateway.box_id == box_id) {
            serve_gateway(tls, gateway, writable);
        } else if let Some(host) = hub.source.remote_host(&box_id) {
            match crate::remote_hmux::hub_remote_gateway_config(&host, writable) {
                Ok(config) => serve_remote_gateway(tls, config),
                Err(error) => eprintln!("[hub] Could not open the remote Hmux gateway: {error}"),
            }
        }
        return;
    }

    let framed = match catalog::encode(&hub.source.catalog()) {
        Ok(framed) => framed,
        Err(error) => {
            // 목록이 프레임 상한을 넘으면 여기서 끝난다. 조용히 닫으면 폰에는
            // "프로토콜 오류" 만 뜨고 노트북에는 아무것도 남지 않는다 — 위
            // `registry.load()` 실패가 같은 이유로 이유를 찍는다.
            eprintln!("[hub] Could not send the session list: {error}");
            return;
        }
    };
    let _ = tls.write_all(&framed);
    let _ = tls.flush();
}

fn serve_remote_gateway(
    tls: rustls::StreamOwned<rustls::ServerConnection, std::net::TcpStream>,
    config: hmux_ssh_transport::SshExecConfig,
) {
    use hmux_client::transport::{
        DEFAULT_MAX_FRAME_BYTES, FrameWriter as _, TransportInterrupt as _,
    };

    let Ok((mut reader, mut writer, interrupt)) = dure_hub_protocol::tls::split(tls) else {
        return;
    };
    let Ok(mut ssh) = hmux_ssh_transport::SshExecDialer::open_halves(config) else {
        return;
    };
    std::thread::scope(|scope| {
        let ssh_interrupt = Arc::clone(&ssh.interrupt);
        let upstream = scope.spawn(move || {
            while let Ok(Some(frame)) = read_hmux_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES) {
                if ssh.writer.write_frame(&frame).is_err() {
                    break;
                }
            }
        });
        let _ = std::io::copy(&mut ssh.reader, &mut writer);
        interrupt.interrupt();
        ssh_interrupt.interrupt();
        let _ = upstream.join();
    });
}

fn read_hmux_frame(
    reader: &mut impl std::io::Read,
    maximum: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut prefix = [0_u8; 4];
    if reader.read(&mut prefix[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut prefix[1..])?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Hmux frame exceeds the protocol limit",
        ));
    }
    let mut frame = Vec::with_capacity(4 + length);
    frame.extend_from_slice(&prefix);
    frame.resize(4 + length, 0);
    reader.read_exact(&mut frame[4..])?;
    Ok(Some(frame))
}

fn serve_gateway(
    tls: rustls::StreamOwned<rustls::ServerConnection, std::net::TcpStream>,
    gateway: &GatewayProcess,
    writable: bool,
) {
    let Ok((mut reader, mut writer, interrupt)) = dure_hub_protocol::tls::split(tls) else {
        return;
    };
    let mut child = match std::process::Command::new(&gateway.binary)
        .arg("--discovery-root")
        .arg(&gateway.discovery_root)
        .arg("mobile-gateway")
        .arg("--role")
        .arg(if writable { "controller" } else { "observer" })
        .env("SSH_ORIGINAL_COMMAND", "dure-hub")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("[hub] Could not start hmux mobile-gateway: {error}");
            return;
        }
    };
    let (Some(mut input), Some(mut output)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };

    std::thread::scope(|scope| {
        let upstream = scope.spawn(move || std::io::copy(&mut reader, &mut input));
        let _ = std::io::copy(&mut output, &mut writer);
        interrupt.interrupt();
        let _ = child.kill();
        let _ = upstream.join();
    });
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    static HUB_TEST_NETWORK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct FixedCatalog(HubCatalog);

    impl CatalogSource for FixedCatalog {
        fn catalog(&self) -> HubCatalog {
            self.0.clone()
        }
    }

    fn empty_catalog() -> Arc<dyn CatalogSource> {
        Arc::new(FixedCatalog(HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: Vec::new(),
            unreachable: Vec::new(),
        }))
    }

    #[test]
    fn remote_gateway_frame_boundary_is_preserved_and_bounded() {
        let mut encoded = 3_u32.to_be_bytes().to_vec();
        encoded.extend_from_slice(b"abc");
        assert_eq!(
            read_hmux_frame(&mut encoded.as_slice(), 3).unwrap(),
            Some(encoded)
        );

        let error = read_hmux_frame(&mut 4_u32.to_be_bytes().as_slice(), 3).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(read_hmux_frame(&mut [].as_slice(), 3).unwrap(), None);
    }

    /// 소켓이 *닫혔는지*. 타임아웃은 닫힌 것이 아니라 아직 살아 있는 것이다.
    ///
    /// `is_err()` 로 판정하면 읽기 타임아웃이 "닫혔다" 로 세어져, 연결이 멀쩡히
    /// 살아 있을 때도 통과하는 시험이 된다 — 실제로 한 번 그렇게 썼고, 고친 코드를
    /// 되돌려도 통과하는 것으로 들켰다.
    fn is_closed(outcome: &std::io::Result<usize>) -> bool {
        match outcome {
            Ok(0) => true,
            Ok(_) => false,
            Err(error) => !matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
        }
    }

    fn network_test_guard() -> std::sync::MutexGuard<'static, ()> {
        HUB_TEST_NETWORK.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn a_stopped_hub_says_so_rather_than_guessing() {
        let server = HubServer::default();

        let status = server.status(3);

        assert!(!status.running);
        assert_eq!(status.address, None);
        assert_eq!(status.port, None);
        assert_eq!(status.fingerprint, None);
        // 기기 수는 리스너와 무관하다 — 꺼져 있어도 등록된 기기는 있다.
        assert_eq!(status.device_count, 3);
    }

    #[test]
    fn starting_reports_the_address_the_os_actually_chose() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();

        // 포트 0 을 요청하면 OS 가 고른다. 화면은 요청한 값이 아니라 고른 값을
        // 보여줘야 한다 — 폰이 그 포트로 온다.
        let status = server
            .start("127.0.0.1", 0, &certificate, registry, empty_catalog())
            .expect("리스너가 선다");

        assert!(status.running);
        assert_eq!(status.address.as_deref(), Some("127.0.0.1"));
        assert!(status.port.unwrap() > 0);
        assert_eq!(status.fingerprint, Some(certificate.fingerprint()));

        server.stop();
        assert!(!server.status(0).running);
    }

    /// 껐다 켜는 것이 반복해서 되어야 한다. 스레드를 기다리지 않거나 직전에
    /// 소유했던 포트의 반환을 기다리지 않으면 다음 `start` 가 같은 포트에
    /// 바인딩하지 못하고, 사용자에게는 "껐다 켰더니 안 된다" 로 보인다.
    #[test]
    fn a_hub_can_be_restarted_on_the_same_port() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();

        let port = server
            .start(
                "127.0.0.1",
                0,
                &certificate,
                registry.clone(),
                empty_catalog(),
            )
            .unwrap()
            .port
            .unwrap();

        for attempt in 1..=32 {
            server.stop();

            let restarted = server
                .start(
                    "127.0.0.1",
                    port,
                    &certificate,
                    registry.clone(),
                    empty_catalog(),
                )
                .unwrap_or_else(|error| panic!("hub restart {attempt} failed: {error}"));
            assert_eq!(restarted.port, Some(port));
        }
        server.stop();
    }

    #[test]
    fn an_owned_restart_retries_the_bind_operation_itself() {
        let _network = network_test_guard();
        let mut attempts = 0;

        let socket = bind_listener_with_retry(
            "127.0.0.1",
            0,
            true,
            std::time::Duration::from_secs(1),
            std::time::Duration::from_millis(1),
            |address, port| {
                attempts += 1;
                if attempts < 3 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        "injected transient conflict",
                    ))
                } else {
                    listener::bind(address, port)
                }
            },
        )
        .expect("직전 소유 포트의 일시 충돌은 bind 자체를 다시 시도한다");

        assert_eq!(attempts, 3);
        drop(socket);
    }

    #[test]
    fn bind_retry_is_bounded_and_requires_prior_ownership() {
        for (owned_restart, budget) in [
            (true, std::time::Duration::ZERO),
            (false, std::time::Duration::from_secs(1)),
        ] {
            let mut attempts = 0;
            let error = bind_listener_with_retry(
                "127.0.0.1",
                1,
                owned_restart,
                budget,
                std::time::Duration::ZERO,
                |_, _| {
                    attempts += 1;
                    Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        "injected persistent conflict",
                    ))
                },
            )
            .expect_err("재시도 예산 또는 소유권이 없으면 충돌을 그대로 돌려준다");

            assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
            assert_eq!(attempts, 1);
        }
    }

    /// 끄기가 이미 붙어 있는 연결을 끊는다.
    ///
    /// 이 시험이 잡는 실패: `stop` 이 accept 루프만 세우고 연결 스레드는 그대로
    /// 두는 것. 그러면 기기 접근을 취소하고 허브를 껐다 켜도 이미 붙은 폰이 계속
    /// 서빙되고, 앱을 종료해야 끊긴다 — 사용자에게는 취소가 듣지 않는 것으로
    /// 보인다.
    ///
    /// TLS 를 하지 않고 TCP 로만 붙는다. 여기서 보는 것은 "붙어 있는 소켓이
    /// 끄기에 닫히는가" 이고, 그 답은 핸드셰이크를 마쳤는지와 무관하다.
    #[test]
    fn stopping_closes_a_connection_that_is_already_open() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();
        let port = server
            .start("127.0.0.1", 0, &certificate, registry, empty_catalog())
            .unwrap()
            .port
            .unwrap();

        let mut peer = std::net::TcpStream::connect(("127.0.0.1", port)).expect("붙는다");
        // 등록될 때까지 *관측하며* 기다린다. 고정 시간으로 기다리면, 부하가 걸려
        // 아직 backlog 에 있을 때 이 시험이 조용히 통과한다 — `stop` 이 리스너를
        // 떨어뜨리면 macOS 가 backlog 를 RST 로 털고, 그 RST 는 "닫혔다" 로
        // 읽히기 때문이다. 그러면 시험은 고친 것을 검사하지 않는다.
        assert!(
            wait_until(|| registered_count(&server) == 1),
            "연결이 등록되지 않았다 — 이 뒤의 판정은 아무것도 증명하지 못한다"
        );

        server.stop();

        // 닫힌 소켓에서의 read 는 0(EOF) 이거나 오류다. 둘 다 "끊겼다" 이고,
        // 끊기지 않았다면 여기서 읽기 타임아웃까지 막힌다.
        peer.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buffer = [0_u8; 1];
        let outcome = peer.read(&mut buffer);
        assert!(
            is_closed(&outcome),
            "끄기 뒤에도 연결이 살아 있다: {outcome:?}"
        );
    }

    /// 조건이 참이 될 때까지 짧게 기다린다. 참이면 `true`.
    ///
    /// 고정 `sleep` 대신 쓰는 이유: 기다림이 짧으면 시험이 흔들리고, 길면 매번
    /// 그만큼 느려진다. 관측할 수 있는 신호가 있으면 둘 다 피한다.
    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        condition()
    }

    /// 지금 등록된 연결 수. 돌고 있지 않으면 0.
    fn registered_count(server: &HubServer) -> usize {
        let state = server
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state
            .running
            .as_ref()
            .map_or(0, |running| running.connections.len())
    }

    /// 마감이 *실제 루프를 지나* 집행된다.
    ///
    /// 등록부를 직접 만들어 보는 시험은 `close_expired` 가 옳게 도는지까지만
    /// 말한다. 이 시험은 그 위를 본다 — accept 루프가 그것을 부르는지, 그리고
    /// `register` 가 예산을 받는지. 둘 중 하나만 빠져도 조용한 상대가 슬롯을
    /// 무한히 잡는 상태로 돌아간다.
    #[test]
    fn the_accept_loop_closes_a_silent_peer_at_the_deadline() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();
        let port = server
            .start_with_budget(
                ("127.0.0.1", 0),
                &certificate,
                registry,
                HubServices::catalog_only(empty_catalog()),
                std::time::Duration::from_millis(50),
            )
            .unwrap()
            .port
            .unwrap();

        // 붙기만 하고 한 바이트도 보내지 않는다. TLS 핸드셰이크조차 시작하지
        // 않으므로 인증은 영영 일어나지 않는다.
        let mut peer = std::net::TcpStream::connect(("127.0.0.1", port)).expect("붙는다");
        peer.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();

        let mut buffer = [0_u8; 1];
        let outcome = peer.read(&mut buffer);

        assert!(
            is_closed(&outcome),
            "마감이 지나도 조용한 상대가 슬롯을 쥐고 있다: {outcome:?}"
        );
        server.stop();
    }

    #[test]
    fn completing_tls_without_a_device_token_does_not_escape_the_deadline() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();
        let port = server
            .start_with_budget(
                ("127.0.0.1", 0),
                &certificate,
                registry,
                HubServices::catalog_only(empty_catalog()),
                std::time::Duration::from_millis(50),
            )
            .unwrap()
            .port
            .unwrap();

        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                certificate.der.clone(),
            ))
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let connection = rustls::ClientConnection::new(
            Arc::new(config),
            rustls::pki_types::ServerName::try_from("hebbian-hub.local")
                .unwrap()
                .to_owned(),
        )
        .unwrap();
        let mut tls = rustls::StreamOwned::new(connection, socket);
        while tls.conn.is_handshaking() {
            tls.conn.complete_io(&mut tls.sock).unwrap();
        }

        let mut byte = [0_u8; 1];
        assert!(is_closed(&tls.read(&mut byte)));
        server.stop();
    }

    /// 끄기가 시작된 뒤에 받아진 연결도 닫힌다.
    ///
    /// 이 시험이 잡는 실패: `close_all` 이 벡터를 훑은 *뒤에* 등록되는 연결.
    /// 그것은 이미 지나간 청소를 놓치고, 루프는 곧 멈추며, `Running` 이 버려져
    /// 등록부에 손을 뻗을 길이 사라진다 — 다음 `start` 는 새 등록부를 만든다.
    /// 그러면 앱을 종료해야 끊긴다.
    #[test]
    fn a_connection_registered_after_shutdown_began_is_refused() {
        let connections = LiveConnections::default();
        let listener = TcpListener::bind("127.0.0.1:0").expect("리스너");
        let port = listener.local_addr().unwrap().port();
        let _peer = std::net::TcpStream::connect(("127.0.0.1", port)).expect("붙는다");
        let (accepted, _) = listener.accept().expect("받는다");

        connections.close_all();

        assert!(
            connections
                .register(&accepted, std::time::Duration::from_secs(30))
                .is_none(),
            "끄기가 시작된 뒤에도 등록을 받아들이면, 그 연결은 아무도 못 닫는다"
        );
    }

    /// 인증을 마치지 못한 연결은 마감에 닫힌다.
    ///
    /// 이 시험이 잡는 실패: 시간 제한이 `SO_RCVTIMEO` 뿐인 것. 그것은 read
    /// 하나마다 걸리므로, 천천히 흘려보내거나 아예 조용한 상대가 슬롯을 무한히
    /// 잡는다. 상한이 8 이라 그런 연결 여덟 개면 정작 폰이 못 붙는다.
    ///
    /// 마감을 짧게 바꿔 끼우지 않고 `PRE_AUTH_BUDGET` 를 그대로 쓰면 시험이 30 초
    /// 걸리므로, 등록부를 직접 만들어 그 부분만 본다.
    #[test]
    fn a_connection_that_never_authenticates_is_closed_at_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("리스너");
        let port = listener.local_addr().unwrap().port();
        let connections = LiveConnections::default();

        let mut peer = std::net::TcpStream::connect(("127.0.0.1", port)).expect("붙는다");
        let (accepted, _) = listener.accept().expect("받는다");
        let registered = connections
            .register(&accepted, std::time::Duration::from_millis(1))
            .expect("등록된다");

        // 인증을 알리지 않은 채 마감을 넘긴다.
        std::thread::sleep(std::time::Duration::from_millis(20));
        connections.close_expired();

        peer.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buffer = [0_u8; 1];
        let outcome = peer.read(&mut buffer);
        assert!(
            is_closed(&outcome),
            "마감을 넘긴 연결이 살아 있다: {outcome:?}"
        );
        drop(registered);
    }

    /// 인증을 마친 연결은 마감이 지나도 닫히지 않는다.
    ///
    /// 반대편 성질. 붙은 뒤에 조용한 것은 정상이다 — 터미널은 사용자가 타이핑할
    /// 때만 말한다. 마감을 인증 뒤까지 적용하면 보고만 있는 폰이 끊긴다.
    #[test]
    fn an_authenticated_connection_outlives_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("리스너");
        let port = listener.local_addr().unwrap().port();
        let connections = LiveConnections::default();

        let mut peer = std::net::TcpStream::connect(("127.0.0.1", port)).expect("붙는다");
        let (accepted, _) = listener.accept().expect("받는다");
        let registration = connections
            .register(&accepted, std::time::Duration::from_millis(1))
            .expect("등록된다");
        registration.authenticated.store(true, Ordering::Release);

        std::thread::sleep(std::time::Duration::from_millis(20));
        connections.close_expired();

        // 살아 있어야 하므로 읽기는 타임아웃으로 끝나야 한다 — EOF 가 오면
        // 닫힌 것이다.
        peer.set_read_timeout(Some(std::time::Duration::from_millis(100)))
            .unwrap();
        let mut buffer = [0_u8; 1];
        let outcome = peer.read(&mut buffer);
        assert!(
            !is_closed(&outcome),
            "인증을 마친 연결이 마감에 닫혔다: {outcome:?}"
        );
    }

    #[test]
    fn revoking_one_device_closes_only_that_devices_connections() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap();
        let connections = LiveConnections::default();

        let mut peer_a = std::net::TcpStream::connect(endpoint).unwrap();
        let (accepted_a, _) = listener.accept().unwrap();
        let registration_a = connections
            .register(&accepted_a, std::time::Duration::from_secs(30))
            .unwrap();
        *registration_a.device_id.lock().unwrap() = Some("device-a".to_string());

        let mut peer_b = std::net::TcpStream::connect(endpoint).unwrap();
        let (accepted_b, _) = listener.accept().unwrap();
        let registration_b = connections
            .register(&accepted_b, std::time::Duration::from_secs(30))
            .unwrap();
        *registration_b.device_id.lock().unwrap() = Some("device-b".to_string());

        connections.close_device("device-a");

        peer_a
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        peer_b
            .set_read_timeout(Some(std::time::Duration::from_millis(100)))
            .unwrap();
        let mut byte = [0_u8; 1];
        assert!(is_closed(&peer_a.read(&mut byte)));
        assert!(!is_closed(&peer_b.read(&mut byte)));
    }

    /// 두 리스너가 같은 인증서로 다른 포트를 듣고 있으면 페어링 QR 이 어느 쪽을
    /// 가리키는지 알 수 없다.
    #[test]
    fn starting_twice_replaces_rather_than_stacking() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let server = HubServer::default();

        let first = server
            .start(
                "127.0.0.1",
                0,
                &certificate,
                registry.clone(),
                empty_catalog(),
            )
            .unwrap();
        let second = server
            .start("127.0.0.1", 0, &certificate, registry, empty_catalog())
            .unwrap();

        assert_ne!(first.port, second.port);
        // 상태는 하나만 말한다.
        assert_eq!(server.status(0).port, second.port);
        server.stop();
    }

    #[test]
    fn a_port_already_taken_is_reported_rather_than_swallowed() {
        let _network = network_test_guard();
        let root = tempfile::tempdir().unwrap();
        let certificate = crate::hub::identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(DeviceRegistry::new(root.path()));
        let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let server = HubServer::default();

        let error = server
            .start("127.0.0.1", port, &certificate, registry, empty_catalog())
            .expect_err("이미 쓰는 포트는 실패해야 한다");

        assert!(error.contains(&port.to_string()), "{error}");
    }
}
