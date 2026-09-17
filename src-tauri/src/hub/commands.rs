//! 화면이 허브를 켜고 끄고 기기를 관리하는 자리.
//!
//! 여기에는 판단이 없다 — 경로를 찾고, 아래 모듈들을 부르고, 오류를 사람이 읽을
//! 문자열로 바꾼다. 판단은 [`super::identity`], [`super::devices`],
//! [`super::server`] 에 있고 그쪽은 Tauri 없이 시험된다.

use super::session_file::{SessionFileRequest, SessionFileSink};
use dure_hub_protocol::session_file::SessionFileResult;
use super::devices::{DeviceRegistry, PairedDevice};
use super::identity::{self, DeviceToken};
use super::file_diff::{FileDiffRequest, FileDiffSink, PendingFileDiff};
use super::git_status::{GitStatusRequest, GitStatusSink, PendingGitStatus};
use dure_hub_protocol::start_agent::HubStartAgentResult;
use super::start_agent::{
    LaunchOfferState, PendingStartAgent, StartAgentRequest, StartAgentSink,
};
use super::roundtrip::{PendingRoundTrips, RoundTrip};
use dure_hub_protocol::git_status::BranchFacts;
use dure_hub_protocol::{
    GitBranch, GitCommit, GitFileChange, GitReview, GitReviewer, HubFileDiffResult,
    HubGitStatusResult,
};
use tauri::Emitter as _;
use super::layout::{LayoutState, SidebarLayout};
use super::listener;
use super::pairing;
use super::relay_dial;
use super::server::{GatewayProcess, HubServer, HubServices, HubStatus, LocalSessions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Manager as _;

/// 이 상자의 안정된 id.
///
/// 호스트 이름이 아니다 — 사람은 컴퓨터 이름을 바꾸고, 그때마다 폰의 목록에서
/// 세션이 통째로 다른 상자로 옮겨 간 것처럼 보이면 안 된다. 보여주는 이름만
/// 호스트 이름을 따른다.
const THIS_BOX_ID: &str = "this-laptop";
const DEFAULT_RELAY_ENDPOINT: &str = "dure-relay.fly.dev:8787";
const RELAY_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub struct HubState {
    server: HubServer,
    registry: OnceLock<Arc<DeviceRegistry>>,
    /// 릴레이와의 연결. QR 이 릴레이 주소를 실을지 여기서 정해진다.
    pub relay: Arc<super::relay_dial::RelayLink>,
    /// 화면이 내려보낸 사이드바 배치. 카탈로그가 세션마다 여기서 자리를 찾는다.
    pub layout: Arc<LayoutState>,
    /// 화면의 변경 목록을 기다리고 있는 왕복들.
    pub pending_status: Arc<PendingGitStatus>,
    /// 화면이 에이전트를 띄우기를 기다리고 있는 왕복들.
    pub pending_launch: Arc<PendingStartAgent>,
    /// 화면이 내려보낸, 지금 띄울 수 있는 자리와 종류.
    pub launch: Arc<LaunchOfferState>,
    /// 화면의 패치를 기다리고 있는 왕복들. 목록과 다른 이름 공간이다 —
    /// 겹치면 한 질문의 답이 다른 질문에 붙는다(`roundtrip.rs`).
    pub pending_diff: Arc<PendingFileDiff>,
    pub pending_file: Arc<PendingRoundTrips<SessionFileResult>>,
}

/// 폰이 물어본 것을 화면에게 넘기고, 화면의 답을 기다리는 쪽.
///
/// 화면 하나만이 답할 수 있으므로 여기서 답할 수는 없다 — 변경 목록은 세션 id
/// 를 워크트리로 옮기는 표를 들고 있는 웹뷰가 낸다. 그래서 하는 일은 배달과
/// 대기뿐이다.
///
/// 종류마다 다른 것은 [`RoundTrip`] 이 들고 있는 사실 셋뿐이다: 이름 공간,
/// 화면이 듣는 이름, 닿지 못했을 때 하는 말. 이 자리를 종류마다 베끼면 "닿지
/// 못하면 자리를 걷어 낸다" 는 규칙이 두 곳에 생기고, 한쪽에서 빠뜨려도 아무
/// 화면에도 나타나지 않는다 — 폰이 20초 동안 기다릴 뿐이다.
struct ScreenRoundTrip<T: RoundTrip> {
    app: tauri::AppHandle,
    pending: Arc<PendingRoundTrips<T>>,
}

/// 화면에게 나가는 것: 물어볼 내용과, 답을 돌려줄 자리의 이름.
///
/// 이름을 붙이는 곳은 기다리는 표를 가진 쪽 하나다. 폰이 이름을 정하면 두 폰이
/// 같은 이름을 보내는 날 한쪽의 답이 다른 쪽 질문에 붙는다.
#[derive(Clone, Serialize)]
struct Dispatch<R: Serialize + Clone> {
    request_id: String,
    #[serde(flatten)]
    request: R,
}

impl<T: RoundTrip> ScreenRoundTrip<T> {
    fn ask<R: Serialize + Clone>(&self, request: R) -> T {
        let (request_id, slot) = self.pending.open();
        let dispatch = Dispatch {
            request_id: request_id.clone(),
            request,
        };
        if self.app.emit(T::EVENT, dispatch).is_err() {
            // 아무도 듣지 않는다. 자리를 도로 걷어 내고 이유를 돌려준다 —
            // 마감까지 기다리게 하면 사용자는 20초 동안 멈춘 화면을 본다.
            self.pending.cancel(&request_id);
            return T::undeliverable();
        }
        self.pending.wait(&request_id, &slot)
    }
}

impl GitStatusSink for ScreenRoundTrip<HubGitStatusResult> {
    fn deliver(&self, request: GitStatusRequest) -> HubGitStatusResult {
        self.ask(request)
    }
}

impl StartAgentSink for ScreenRoundTrip<HubStartAgentResult> {
    fn deliver(&self, request: StartAgentRequest) -> HubStartAgentResult {
        self.ask(request)
    }
}

impl FileDiffSink for ScreenRoundTrip<HubFileDiffResult> {
    fn deliver(&self, request: FileDiffRequest) -> HubFileDiffResult {
        self.ask(request)
    }
}

impl SessionFileSink for ScreenRoundTrip<SessionFileResult> {
    fn deliver(&self, request: SessionFileRequest) -> SessionFileResult {
        self.ask(request)
    }
}

impl HubState {
    pub(super) fn registry(&self, app: &tauri::AppHandle) -> Result<Arc<DeviceRegistry>, String> {
        if let Some(existing) = self.registry.get() {
            return Ok(existing.clone());
        }
        let root = hub_root(app)?;
        // 경쟁에서 진 쪽은 이긴 쪽을 쓴다. 같은 경로를 가리키므로 어느 쪽이든
        // 같은 파일을 읽는다.
        let _ = self.registry.set(Arc::new(DeviceRegistry::new(&root)));
        Ok(self
            .registry
            .get()
            .expect("The value was just initialized here or by another thread")
            .clone())
    }
}

fn hub_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// 폰의 목록에 이 컴퓨터가 어떤 이름으로 보일지.
fn this_box_label() -> String {
    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("hostname").arg("-s").output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    #[cfg(not(unix))]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            if !name.is_empty() {
                return name;
            }
        }
    }
    "This computer".to_string()
}

fn gateway_process(app: &tauri::AppHandle) -> Result<GatewayProcess, String> {
    Ok(GatewayProcess {
        box_id: THIS_BOX_ID.to_string(),
        binary: crate::mobile_pairing::resolve_hmux(app)?,
        discovery_root: crate::hmux::product_discovery_root_path()
            .ok_or_else(|| "Could not find the Hmux session storage location".to_string())?,
    })
}

/// 허브를 켠다. 어느 주소에 붙일지는 화면이 고른다
/// (`mobile_pairing_networks` 가 후보를 준다).
///
/// 포트에 0 을 주면 OS 가 고르고, 고른 값이 반환값에 담긴다 — 폰이 그 포트로
/// 오므로 화면은 요청한 값이 아니라 이 값을 보여줘야 한다.
#[tauri::command]
pub fn hub_start(app: tauri::AppHandle, address: String, port: u16) -> Result<HubStatus, String> {
    let state = app.state::<HubState>();
    let root = hub_root(&app)?;
    let certificate =
        identity::load_or_create_certificate(&root).map_err(|error| error.to_string())?;
    let registry = state.registry(&app)?;
    let device_count = registry.load().map_err(|error| error.to_string())?.len();

    let mut status = state.server.start_with_gateway(
        &address,
        port,
        &certificate,
        registry,
        HubServices::with_gateway(
            Arc::new(LocalSessions {
                layout: Arc::clone(&state.layout),
                box_id: THIS_BOX_ID.to_string(),
                box_label: this_box_label(),
            }),
            gateway_process(&app)?,
        )
        .reporting_status(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_status),
        }))
        .launching(
            Arc::new(ScreenRoundTrip {
                app: app.clone(),
                pending: Arc::clone(&state.pending_launch),
            }),
            Arc::clone(&state.launch),
        )
        .reporting_diffs(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_diff),
        }))
        .receiving_files(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_file),
        })),
    )?;
    status.device_count = device_count;
    // 켠 것을 기억한다. 이 기록이 없으면 앱을 다시 켤 때마다 폰 쪽에서는
    // 컴퓨터가 그냥 꺼진 것으로 보이고, 양쪽 화면 어디에도 이유가 안 나온다.
    // 실패해도 켜는 것 자체는 막지 않는다 — 기억하지 못하는 것과 못 켜는 것은
    // 다른 무게다.
    if let Err(error) = super::autostart::remember_hub(&root, &address) {
        eprintln!("[hub] Could not save the automatic resume record: {error}");
    }
    Ok(status)
}

#[tauri::command]
pub fn hub_stop(app: tauri::AppHandle) {
    // 끈 것도 선택이다. 기록을 지워야 다음 부팅이 그 선택을 지킨다.
    if let Ok(root) = hub_root(&app) {
        if let Err(error) = super::autostart::forget(&root) {
            eprintln!("[hub] Could not clear the automatic resume record: {error}");
        }
    }
    app.state::<HubState>().server.stop();
    // 릴레이도 함께 멈춘다. 허브가 꺼진 채 릴레이에 등록되어 있으면, 폰은
    // 릴레이까지 갔다가 이어진 소켓 뒤에 아무도 없는 것을 보게 된다 — 그 실패는
    // "컴퓨터가 꺼져 있다" 보다 훨씬 늦게, 훨씬 모호하게 온다.
    app.state::<HubState>().relay.stop();
}

/// 릴레이에 등록해 같은 와이파이 밖에서도 닿게 한다.
///
/// **허브가 먼저 켜져 있어야 한다.** 릴레이는 폰을 이 프로세스로 데려올 뿐이고,
/// 데려온 뒤에 서빙하는 것은 허브다. 순서를 강제하지 않으면 등록은 성공하고
/// 접속만 실패하는 상태가 만들어진다.
#[tauri::command]
pub fn hub_relay_start(
    app: tauri::AppHandle,
    endpoint: String,
) -> Result<relay_dial::RelayStatus, String> {
    let state = app.state::<HubState>();
    if !state.server.status(0).running {
        return Err("Enable the hub first. The relay only connects the phone to it".to_string());
    }
    let root = hub_root(&app)?;
    let certificate =
        identity::load_or_create_certificate(&root).map_err(|error| error.to_string())?;
    let server_id = identity::load_or_create_server_id(&root).map_err(|error| error.to_string())?;
    let tls = listener::server_config(&certificate).map_err(|error| error.to_string())?;

    // 기록에 쓸 값이라 옮기기 전에 복사해 둔다.
    let recorded_endpoint = endpoint.clone();
    relay_dial::start_with_gateway(
        &state.relay,
        endpoint,
        server_id,
        Arc::new(certificate),
        tls,
        state.registry(&app)?,
        HubServices::with_gateway(
            Arc::new(LocalSessions {
                layout: Arc::clone(&state.layout),
                box_id: THIS_BOX_ID.to_string(),
                box_label: this_box_label(),
            }),
            gateway_process(&app)?,
        )
        .reporting_status(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_status),
        }))
        .launching(
            Arc::new(ScreenRoundTrip {
                app: app.clone(),
                pending: Arc::clone(&state.pending_launch),
            }),
            Arc::clone(&state.launch),
        )
        .reporting_diffs(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_diff),
        }))
        .receiving_files(Arc::new(ScreenRoundTrip {
            app: app.clone(),
            pending: Arc::clone(&state.pending_file),
        })),
    );
    if let Err(error) = super::autostart::remember_relay(&root, &recorded_endpoint) {
        eprintln!("[hub] Could not save the relay automatic resume record: {error}");
    }
    Ok(state.relay.status())
}

#[tauri::command]
pub fn hub_relay_stop(app: tauri::AppHandle) {
    if let Ok(root) = hub_root(&app) {
        if let Err(error) = super::autostart::forget_relay(&root) {
            eprintln!("[hub] Could not clear the relay automatic resume record: {error}");
        }
    }
    app.state::<HubState>().relay.stop();
}

/// 켜 두었던 허브를 다시 켠다. 앱이 시작할 때 화면이 한 번 부른다.
///
/// 아무것도 새로 열지 않는다 — 사람이 이미 켰고 끄지 않은 것만 돌려놓는다.
/// 기록이 없으면 아무 일도 하지 않고, 그것이 정상 경로다.
///
/// 이미 켜져 있으면 건드리지 않는다. 창이 여럿이면 이 명령도 여러 번 오는데,
/// 그때마다 서버를 갈아 끼우면 방금 붙은 폰의 연결이 끊긴다.
#[tauri::command]
pub fn hub_resume(app: tauri::AppHandle) -> Result<HubStatus, String> {
    let state = app.state::<HubState>();
    let running = state.server.status(0);
    if running.running {
        return Ok(running);
    }
    let root = hub_root(&app)?;
    let Some(record) = super::autostart::load(&root) else {
        return Ok(running);
    };
    // 기억한 주소가 없어졌으면 지금 있는 것 중 가장 나은 것으로 켠다. 거기서
    // 포기하면 "항상 켜짐" 이 "네트워크가 바뀌기 전까지" 가 된다.
    let Some(address) = super::autostart::address_to_resume(
        &record.address,
        &crate::mobile_pairing::network_choices(),
    ) else {
        return Ok(running);
    };
    if address != record.address {
        eprintln!(
            "[hub] The saved address is unavailable on this computer; using another address: {} → {address}",
            record.address
        );
    }
    let status = hub_start(app.clone(), address, 0)?;
    // 허브만 돌아오고 릴레이가 안 돌아오면 "집에서는 되는데 밖에서는 안 되는"
    // 상태가 된다 — 이 기능이 없애려던 실패보다 설명하기 어려운 실패다.
    if let Some(endpoint) = record.relay_endpoint {
        if let Err(error) = hub_relay_start(app.clone(), endpoint) {
            eprintln!("[hub] Could not register with the relay again: {error}");
        }
    }
    Ok(status)
}

/// 지금 릴레이 상태. 화면이 주기적으로 묻는다.
///
/// `hub_status` 에 합치지 않는다. 허브가 켜진 것과 릴레이에 등록된 것은 다른
/// 사실이고, 한 문서로 묶으면 화면이 둘을 한 불로 그리게 된다 —
/// `RelayStatus` 가 `running` 과 `registered` 를 나눠 두는 것과 같은 이유다.
#[tauri::command]
pub fn hub_relay_status(app: tauri::AppHandle) -> relay_dial::RelayStatus {
    app.state::<HubState>().relay.status()
}

#[tauri::command]
pub fn hub_status(app: tauri::AppHandle) -> Result<HubStatus, String> {
    let state = app.state::<HubState>();
    let count = state
        .registry(&app)?
        .load()
        .map_err(|error| error.to_string())?
        .len();
    Ok(state.server.status(count))
}

#[tauri::command]
pub fn hub_devices(app: tauri::AppHandle) -> Result<Vec<PairedDevice>, String> {
    app.state::<HubState>()
        .registry(&app)?
        .list()
        .map_err(|error| error.to_string())
}

/// 기기를 하나 등록하고 그 토큰을 돌려준다.
///
/// 토큰이 프런트엔드로 나가는 유일한 자리다. 호출부는 이것을 페어링 페이로드에
/// 실어 보내고 버려야 한다 — 다시 물어볼 방법은 없다.
#[tauri::command]
pub fn hub_device_register(app: tauri::AppHandle, label: String) -> Result<DeviceToken, String> {
    app.state::<HubState>()
        .registry(&app)?
        .register(label)
        .map_err(|error| error.to_string())
}

/// 기기를 지운 결과. 서버 실패가 있으면 허브 토큰과 재시도 기록은 그대로다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubDeviceRevokeOutcome {
    pub revoked: bool,
    pub failures: Vec<crate::mobile_pairing::PairingRevokeFailure>,
}

/// 기기를 지운다. `revoked`는 실제로 지워졌는지 — 없던 기기를 지우는 것은
/// 실패가 아니다. `forget_unreachable`은 서버에 키가 남을 수 있음을 사용자가
/// 확인한 뒤에만 온다.
///
/// 리스너를 다시 켤 필요가 없다. 연결마다 목록을 다시 읽으므로 다음 연결부터
/// 즉시 막힌다.
#[tauri::command]
pub fn hub_device_revoke(
    app: tauri::AppHandle,
    device_id: String,
    forget_unreachable: Option<bool>,
) -> Result<HubDeviceRevokeOutcome, String> {
    // 서버에 심은 키를 먼저 지운다. 순서가 반대면 실패했을 때 목록에서 이름만
    // 사라지고 서버의 강제 명령 키는 남는다 — 그 키를 부를 이름이 이 컴퓨터에
    // 없으므로 다시 지울 방법도 없다. 실패하면 아무것도 지우지 않고, 서버가
    // 돌아온 뒤 같은 버튼을 다시 누르면 된다.
    let forget_unreachable = forget_unreachable.unwrap_or(false);
    let failures = crate::mobile_pairing::revoke_ssh_pairing(
        &app,
        &device_id,
        forget_unreachable,
    )?;
    if !failures.is_empty() && !forget_unreachable {
        return Ok(HubDeviceRevokeOutcome {
            revoked: false,
            failures,
        });
    }

    let state = app.state::<HubState>();
    let revoked = state
        .registry(&app)?
        .revoke(&device_id)
        .map_err(|error| error.to_string())?;
    if revoked {
        state.server.disconnect_device(&device_id);
        state.relay.disconnect_device(&device_id);
    }
    Ok(HubDeviceRevokeOutcome { revoked, failures })
}

/// 화면에 띄울 페어링 제안.
#[derive(Serialize)]
pub struct PairingOffer {
    /// QR 로 만들 문자열. `mobile_pairing_qr` 에 그대로 넘긴다.
    ///
    /// 안에 기기 토큰이 들어 있다 — 로그에 남기지 않는다.
    pub payload: String,
    /// 방금 등록된 기기. 사용자가 스캔하지 않고 창을 닫으면 이것으로 지운다.
    pub device_id: String,
}

/// Creates one complete phone pairing offer.
///
/// This is the single setup boundary: it starts the local Hub when needed,
/// registers the relay, and embeds the direct SSH/Tailscale inventory invite.
/// A QR is never returned before the relay is actually reachable.
#[tauri::command]
pub async fn hub_pairing_offer(
    app: tauri::AppHandle,
    device_label: String,
    advertised_address: String,
    relay_endpoint: String,
) -> Result<PairingOffer, String> {
    let mut status = app.state::<HubState>().server.status(0);
    if !status.running {
        let advertised_address = advertised_address.trim();
        if advertised_address.is_empty() {
            return Err("Could not find a network address the phone can use to reach this computer".to_string());
        }
        status = hub_start(app.clone(), advertised_address.to_string(), 0)?;
    }
    let (Some(address), Some(port), Some(fingerprint)) =
        (status.address, status.port, status.fingerprint)
    else {
        return Err("The hub state is incomplete. Turn it off and on again".to_string());
    };

    let relay_endpoint = match relay_endpoint.trim() {
        "" => DEFAULT_RELAY_ENDPOINT,
        endpoint => endpoint,
    };
    let relay = app.state::<HubState>().relay.status();
    if !relay.running
        || relay.endpoint.as_deref() != Some(relay_endpoint)
        || relay.detail.is_some()
    {
        hub_relay_start(app.clone(), relay_endpoint.to_string())?;
    }

    let deadline = tokio::time::Instant::now() + RELAY_REGISTRATION_TIMEOUT;
    let relay = loop {
        let relay = app.state::<HubState>().relay.status();
        if relay.registered {
            break relay;
        }
        if let Some(detail) = relay.detail.as_deref() {
            return Err(format!("Could not register with the relay: {detail}"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Relay registration timed out. Check the network and try again"
                .to_string());
        }
        // ponytail: one pairing action waits on one relay; add a notification
        // channel only if concurrent pairing becomes a measured requirement.
        tokio::time::sleep(RELAY_STATUS_POLL_INTERVAL).await;
    };

    // 기기를 먼저 등록한다. 그 id 가 곧 이 짝짓기의 이름이고, ssh 페어링도 같은
    // 이름으로 기록돼야 나중에 삭제 한 번이 양쪽을 다 지운다. 순서가 반대면
    // hmux 가 자기 uuid 를 먼저 만들어 버려 이어 붙일 방법이 없다.
    let device = app
        .state::<HubState>()
        .registry(&app)
        .and_then(|registry| {
            registry
                .register(device_label)
                .map_err(|error| error.to_string())
        })?;

    let direct = match crate::mobile_pairing::mobile_pairing_start(
        app.clone(),
        crate::mobile_pairing::PairingStartRequest {
            address: address.clone(),
            port: 0,
            ttl_seconds: 300,
            inventory: None,
            remote_only: true,
            device_id: Some(device.device_id.clone()),
        },
    )
    .await
    {
        Ok(started) => started,
        Err(error) => {
            // QR 이 없으면 이 기기는 아무도 쓸 수 없다. 목록에 남겨 두면
            // 사용자가 지워야 할 유령이 하나 생긴다.
            if let Ok(registry) = app.state::<HubState>().registry(&app) {
                let _ = registry.revoke(&device.device_id);
            }
            return Err(error);
        }
    };
    let relay = match (relay.registered, relay.endpoint, relay.server_id) {
        (true, Some(endpoint), Some(server_id)) => Some((endpoint, server_id)),
        _ => None,
    };
    let offer = pairing::offer_for(
        &address,
        port,
        &fingerprint,
        &device,
        &this_box_label(),
        relay
            .as_ref()
            .map(|(endpoint, server_id)| (endpoint.as_str(), server_id.as_str())),
        &direct.payload,
    );

    Ok(PairingOffer {
        payload: pairing::encode(&offer),
        device_id: device.device_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 호스트 이름을 읽지 못해도 이름이 비지 않아야 한다 — 폰의 목록에서 이름
    /// 없는 상자는 세션이 어디 있는지 말해 주지 못한다.
    #[test]
    fn this_box_always_has_a_name() {
        assert!(!this_box_label().is_empty());
    }

    #[test]
    fn git_status_reply_deserializes_as_one_named_value() {
        let reply: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [{ "path": "src/main.ts", "status": "M" }],
            "branch": "main",
            "ahead": 2,
            "behind": 0,
            "baseRef": "origin/main",
            "detail": null
        }))
        .expect("typed git status reply");

        assert_eq!(reply.files.len(), 1);
        assert_eq!(reply.branch.as_deref(), Some("main"));
        assert_eq!(reply.ahead, Some(2));
        assert_eq!(reply.behind, Some(0));
        assert_eq!(reply.base_ref.as_deref(), Some("origin/main"));
        assert_eq!(reply.detail, None);
    }

    /// 커밋 탭이 물어 얻은 값이 폰까지 가야 한다.
    ///
    /// 이 구조체에 `commits` 자리가 없던 동안, 브리지는 커밋을 다 읽어
    /// 보내는데 serde 가 모르는 필드로 버렸다 — 화면 쪽 코드는 완성돼 보이고
    /// 폰은 계속 "노트북이 아직 안 보냅니다" 를 그렸다. 여기서 두 값을 함께
    /// 붙잡아 둔다.
    #[test]
    fn the_commits_tab_answer_survives_the_window_boundary() {
        let reply: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [],
            "branch": "fix/payment-retry",
            "commits": [{
                "short_sha": "1fb0321",
                "subject": "fix(disk): size the guard to this volume",
                "author": "kattpish",
                "when": "2 hours ago"
            }],
            "commits_read": true
        }))
        .expect("typed git status reply");

        let result = reply.into_result();

        assert!(result.commits_read);
        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.commits[0].short_sha, "1fb0321");
    }

    /// 브랜치 카드는 물어본 탭의 개수만 말한다.
    ///
    /// 커밋 탭과 PR 탭의 답은 파일을 싣지 않는다. 그 빈 목록이 "깨끗하다" 로
    /// 읽히면 더러운 워크트리 위에 "0 changed" 가 그려진다.
    #[test]
    fn only_the_tab_that_read_the_files_may_claim_a_count() {
        let changes: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [{ "path": "src/main.ts", "status": "M" }], "files_read": true
        }))
        .expect("typed git status reply");
        let commits: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [], "commits": [], "commits_read": true
        }))
        .expect("typed git status reply");

        assert!(changes.into_result().files_read);
        assert!(!commits.into_result().files_read);
    }

    /// 커밋이 **없다**는 답과, 못 물어봤다는 침묵은 다른 사실이다.
    ///
    /// base 에 그대로 앉은 워크트리가 여기서 가장 흔한 상태다. 빈 목록만으로
    /// 가르면 그 정상 상태가 전부 "아직 안 보냅니다" 로 보인다.
    #[test]
    fn no_commits_is_an_answer_and_silence_is_not() {
        let answered: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [], "commits": [], "commits_read": true
        }))
        .expect("typed git status reply");
        let silent: HubGitStatusReply =
            serde_json::from_value(serde_json::json!({ "files": [] }))
                .expect("typed git status reply");

        assert!(answered.into_result().commits_read);
        assert!(!silent.into_result().commits_read);
    }

    /// PR 탭도 같은 경계를 넘어야 한다. `review` 없이 `review_read` 만 참인
    /// 답이 "아직 리뷰가 없다" 이고, 그건 만들기 버튼이 존재하는 이유다.
    #[test]
    fn the_pull_request_tab_answer_survives_the_window_boundary() {
        let open: HubGitStatusReply = serde_json::from_value(serde_json::json!({
            "files": [],
            "review": {
                "number": 42,
                "title": "Size the build-storage guard to this volume",
                "state": "OPEN",
                "url": "https://example.invalid/pull/42",
                "is_draft": false,
                "base_ref": "main"
            },
            "review_read": true
        }))
        .expect("typed git status reply");
        let none: HubGitStatusReply =
            serde_json::from_value(serde_json::json!({ "files": [], "review_read": true }))
                .expect("typed git status reply");

        let open = open.into_result();
        assert!(open.review_read);
        assert_eq!(open.review.expect("a review").number, 42);

        let none = none.into_result();
        assert!(none.review_read);
        assert!(none.review.is_none());
    }
}

/// 화면이 사이드바 배치를 내려보낸다.
///
/// store 가 바뀔 때마다 부른다. 통째로 갈아 끼우는 이유는 [`LayoutState`] 의
/// 시험에 적혀 있다 — 합치면 사이드바에서 지운 세션을 폰에서 지울 방법이 없다.
///
/// 실패할 것이 없다. 판단은 폰이 하고(자리 없는 세션은 그리지 않는다), 여기서
/// 하는 일은 받아 두는 것뿐이다.
#[tauri::command]
pub fn hub_set_sidebar_layout(state: tauri::State<'_, HubState>, layout: SidebarLayout) {
    state.layout.set(layout);
}

/// 화면이 읽어 온 변경 목록을 기다리는 왕복에 돌려준다.
///
/// 모르는 `request_id` 는 거짓을 돌려준다. 마감을 넘긴 왕복이 정상적으로 그렇게
/// 되고, 그것은 화면의 잘못이 아니다.
/// 화면이 읽어 온 답. 탭마다 채워지는 자리가 다르다.
///
/// **탭이 묻는 값들은 여기 이름이 있어야 한다.** 이 구조체는
/// `deny_unknown_fields` 가 아니라서, 화면이 보낸 필드에 여기 짝이 없으면
/// serde 가 조용히 버린다 — 커밋 탭과 PR 탭이 정확히 그렇게, 브리지가 값을
/// 다 계산해 놓고도 폰까지 아무것도 못 보내는 상태로 있었다. 새 탭을 붙일 때
/// 이 구조체를 같이 고치지 않으면 화면 쪽 코드는 완성돼 보이는데 폰은 계속
/// "아직 안 보냅니다" 를 그린다.
///
/// 이름은 `camelCase` 로 읽는다(`baseRef`). 두 read 플래그만 그대로 두는데,
/// 그것이 폰까지 가는 이름이고 여기서 이름을 갈면 한 사실이 세 이름을 갖는다.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubGitStatusReply {
    files: Vec<GitFileChange>,
    branch: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    base_ref: Option<String>,
    detail: Option<String>,
    /// 거절의 종류. 폰이 문장이 아니라 이 값으로 분기한다.
    #[serde(default)]
    code: Option<String>,
    /// 파일 목록을 실제로 물어봤나. 커밋 탭과 PR 탭의 답은 파일을 싣지
    /// 않으므로, 그 빈 목록이 "깨끗하다" 로 읽히면 안 된다.
    #[serde(default, rename = "files_read")]
    files_read: bool,
    /// 기준 브랜치 이후의 커밋들. 커밋 탭이 물었을 때만 온다.
    #[serde(default)]
    commits: Vec<GitCommit>,
    /// 커밋을 실제로 물어봤나. 빈 목록 하나로 "없다" 와 "못 물어봤다" 를 함께
    /// 나르지 않으려고 따로 온다.
    #[serde(default, rename = "commits_read")]
    commits_read: bool,
    /// 이 브랜치에 열린 리뷰. 없으면 `review_read` 가 참인지로 갈라 읽는다.
    #[serde(default)]
    review: Option<GitReview>,
    #[serde(default, rename = "review_read")]
    review_read: bool,
    /// 이 저장소의 브랜치들. 전환 시트가 물었을 때만 온다.
    #[serde(default)]
    branches: Vec<GitBranch>,
    #[serde(default, rename = "branches_read")]
    branches_read: bool,
    /// 커밋 하나의 메시지 본문. 커밋 상세가 물었을 때만 온다.
    #[serde(default, rename = "commit_body")]
    commit_body: Option<String>,
    /// 리뷰를 부탁할 만한 사람들. 리뷰어 시트가 물었을 때만 온다.
    #[serde(default)]
    reviewers: Vec<GitReviewer>,
    #[serde(default, rename = "reviewers_read")]
    reviewers_read: bool,
}

impl HubGitStatusReply {
    fn into_result(self) -> HubGitStatusResult {
        // 이유가 붙어 오면 못 읽은 것이다. 빈 목록과 갈라 두는 이유는
        // `git_status.rs` 에 있다 — 깨끗한 저장소와 못 읽은 저장소는 다른 사실이다.
        match self.detail {
            // 이유가 붙어 와도 브랜치는 버리지 않는다. 화면이 그것을 읽었다면
            // 폰이 그것을 못 볼 이유가 없다.
            Some(reason) => match self.code {
                Some(code) => HubGitStatusResult::refused_with_code(reason, code, self.branch),
                None => HubGitStatusResult::refused_knowing(reason, self.branch),
            },
            None => HubGitStatusResult {
                files_read: self.files_read,
                commits: self.commits,
                commits_read: self.commits_read,
                branches: self.branches,
                branches_read: self.branches_read,
                reviewers: self.reviewers,
                reviewers_read: self.reviewers_read,
                commit_body: self.commit_body,
                review: self.review,
                review_read: self.review_read,
                ..HubGitStatusResult::read(
                    self.files,
                    BranchFacts {
                        branch: self.branch,
                        ahead: self.ahead,
                        behind: self.behind,
                        base_ref: self.base_ref,
                    },
                )
            },
        }
    }
}

/// 화면이 원격 상자에 소스 컨트롤을 물을 때 쓴다.
///
/// # 왜 화면이 직접 SSH 를 열지 않는가
///
/// 열쇠는 여기 있다. 그리고 어느 상자인지도 여기서 정한다 — 화면은 `box_id`
/// 하나를 말하고, 그 id 는 화면이 스스로 내려보낸 배치표에 있는 것이다
/// (`LayoutState::remote_host`). 호스트도, 경로도, 리비전도 화면이 짓지 않는다.
///
/// # 실패는 왜 `Err` 인가
///
/// 부르는 쪽(`gitStatusBridge`)이 이 실패를 **`session_elsewhere` 로 되돌려야**
/// 하기 때문이다. 폰은 그 코드에서만 자기 SSH 로 폴백한다. 이 노트북이 그
/// 상자에 못 닿는 경우(그 상자가 이 노트북의 `known_hosts` 에 없다든가)는
/// 실제로 있고, 그때 폰은 자기 힘으로 읽을 수 있다 — 여기서 다른 코드를 만들면
/// 그 길이 막힌다.
#[tauri::command]
pub async fn hub_remote_git_status(
    state: tauri::State<'_, HubState>,
    box_id: String,
    session_id: String,
    workspace_id: String,
    want: Option<String>,
) -> Result<RemoteGitStatus, String> {
    let host = state
        .layout
        .remote_host(&box_id)
        .ok_or_else(|| format!("no_remote_host:{box_id}"))?;
    let want = match want.as_deref() {
        Some("commits") => hmux_ssh_transport::SourceControlWant::Commits,
        Some("pull_request") => hmux_ssh_transport::SourceControlWant::PullRequest,
        _ => hmux_ssh_transport::SourceControlWant::Changes,
    };
    let request_id = format!("hub-scm-{box_id}");
    let document = tauri::async_runtime::spawn_blocking(move || {
        crate::remote_hmux::hub_remote_source_control(
            &host,
            request_id,
            session_id,
            workspace_id,
            want,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(RemoteGitStatus::from(document))
}

/// 원격 상자의 답을 화면이 쓰는 모양으로. 프로토콜 타입을 그대로 내보내지
/// 않는 이유는 [`HubGitStatusReply`] 와 같다 — 약속과 화면은 따로 움직인다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitStatus {
    /// `read` | `not_versioned` | `unavailable`.
    pub kind: String,
    /// `unavailable` 일 때만. 상자가 민 닫힌 낱말이다.
    pub reason: Option<String>,
    pub branch: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub base_ref: Option<String>,
    pub files: Vec<GitFileChange>,
    pub files_read: bool,
    pub commits: Vec<GitCommit>,
    pub commits_read: bool,
    /// 커밋을 못 읽은 이유. 못 물어본 것과 갈라 둔다.
    pub commits_reason: Option<String>,
    pub review: Option<GitReview>,
    pub review_read: bool,
    pub review_reason: Option<String>,
}

impl From<hmux_ssh_transport::SourceControlDocument> for RemoteGitStatus {
    fn from(document: hmux_ssh_transport::SourceControlDocument) -> Self {
        use hmux_ssh_transport::{SourceControlBody, SourceControlCommits, SourceControlReview};
        let empty = |kind: &str, reason: Option<String>| Self {
            kind: kind.to_string(),
            reason,
            branch: None,
            ahead: None,
            behind: None,
            base_ref: None,
            files: Vec::new(),
            files_read: false,
            commits: Vec::new(),
            commits_read: false,
            commits_reason: None,
            review: None,
            review_read: false,
            review_reason: None,
        };
        match document.body {
            SourceControlBody::NotVersioned => empty("not_versioned", None),
            SourceControlBody::Unavailable { reason } => empty("unavailable", Some(reason)),
            SourceControlBody::Read(snapshot) => {
                let (commits, commits_read, commits_reason) = match snapshot.commits {
                    Some(SourceControlCommits::Read { commits, .. }) => (
                        commits
                            .into_iter()
                            .map(|commit| GitCommit {
                                short_sha: commit.short_sha,
                                subject: commit.subject,
                                author: commit.author,
                                when: commit.when,
                            })
                            .collect(),
                        true,
                        None,
                    ),
                    Some(SourceControlCommits::Unavailable { reason }) => {
                        (Vec::new(), false, Some(reason))
                    }
                    None => (Vec::new(), false, None),
                };
                let (review, review_read, review_reason) = match snapshot.review {
                    Some(SourceControlReview::Open(open)) => (
                        Some(GitReview {
                            number: open.number,
                            title: open.title,
                            state: open.state,
                            url: open.url,
                            is_draft: open.is_draft,
                            base_ref: open.base_ref,
                            // 상자의 게이트웨이는 체크도 리뷰어도 읽지 않는다.
                            // 못 물어본 것이지 "없다" 가 아니므로, 없는 채로 둔다.
                            requested_reviewers: Vec::new(),
                            review_decision: String::new(),
                            checks: None,
                        }),
                        true,
                        None,
                    ),
                    // 물어봤고, 아직 없다. 만들기 버튼이 존재하는 상태다.
                    Some(SourceControlReview::None) => (None, true, None),
                    Some(SourceControlReview::Unavailable { reason }) => {
                        (None, false, Some(reason))
                    }
                    None => (None, false, None),
                };
                Self {
                    kind: "read".to_string(),
                    reason: None,
                    branch: snapshot.branch,
                    ahead: snapshot.ahead,
                    behind: snapshot.behind,
                    base_ref: snapshot.base_ref,
                    files: snapshot
                        .files
                        .into_iter()
                        .map(|file| GitFileChange {
                            path: file.path,
                            status: file.status,
                            old_path: file.old_path,
                            added: file.added,
                            deleted: file.deleted,
                            // 상자는 HEAD 대비 비교를 하지 않는다. 모른다고
                            // 말하는 것이 맞다 — 거짓으로 접으면 그 상자의 모든
                            // 줄이 "커밋할 것 없음" 으로 그려진다. 어차피 쓰기는
                            // 이 경로로 갈 수 없다(SSH 페어링 키는 읽기 전용).
                            uncommitted: None,
                        })
                        .collect(),
                    files_read: snapshot.files_read,
                    commits,
                    commits_read,
                    commits_reason,
                    review,
                    review_read,
                    review_reason,
                }
            }
        }
    }
}

/// 화면이 "지금 띄울 수 있는 자리와 종류" 를 내려보낸다.
///
/// [`hub_set_sidebar_layout`] 과 같은 모양이고 같은 이유다 — 통째로 갈아 끼운다.
/// 합치면 화면에서 지운 폴더를 폰에서 지울 방법이 없다.
///
/// 실패할 것이 없다. 판단은 폰이 하고(누를 수 없는 자리는 그리되 눌리지 않는다),
/// 여기서 하는 일은 받아 두는 것뿐이다.
#[tauri::command]
pub fn hub_publish_launch_offer(
    state: tauri::State<'_, HubState>,
    targets: Vec<dure_hub_protocol::launch_offer::LaunchTarget>,
    kinds: Vec<dure_hub_protocol::launch_offer::AgentKind>,
) {
    state
        .launch
        .set(dure_hub_protocol::launch_offer::HubLaunchOffer::published(
            targets, kinds,
        ));
}

/// 화면이 띄운 결과를 기다리는 왕복에 돌려준다.
///
/// 모르는 `request_id` 는 거짓을 돌려준다. 마감을 넘긴 왕복이 정상적으로 그렇게
/// 되고, 그것은 화면의 잘못이 아니다.
#[tauri::command]
pub fn hub_start_agent_result(
    state: tauri::State<'_, HubState>,
    request_id: String,
    result: HubStartAgentReply,
) -> bool {
    state.pending_launch.settle(&request_id, result.into_result())
}

/// 화면이 돌려주는 시작 결과.
///
/// 프로토콜 타입을 그대로 받지 않는 이유는 [`HubGitStatusReply`] 와 같다 — 약속과
/// 화면은 따로 움직인다. 그리고 이 방향이라야 `hub_start_agent_version` 을 화면이
/// 채우지 않는다: 판을 아는 것은 이쪽이다.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStartAgentReply {
    started: bool,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

impl HubStartAgentReply {
    fn into_result(self) -> HubStartAgentResult {
        if self.started {
            // 세션 id 가 없어도 뜬 것은 뜬 것이다 — 접으면 잘 뜬 에이전트가
            // 실패로 보이고, 사람은 같은 것을 한 번 더 띄운다.
            return HubStartAgentResult::started(
                self.agent_id.unwrap_or_default(),
                self.session_id,
            );
        }
        HubStartAgentResult::refused_with_code(
            self.detail
                .unwrap_or_else(|| "The desktop did not provide a reason".to_string()),
            self.code.unwrap_or_else(|| "failed".to_string()),
        )
    }
}

#[tauri::command]
pub fn hub_git_status_result(
    state: tauri::State<'_, HubState>,
    request_id: String,
    reply: HubGitStatusReply,
) -> bool {
    state
        .pending_status
        .settle(&request_id, reply.into_result())
}

/// 화면이 읽어 낸 패치 하나.
///
/// [`HubGitStatusReply`] 와 같은 이유로 약속 타입을 그대로 받지 않는다 — 화면과
/// 약속은 따로 움직이고, 한쪽 필드 이름을 바꾸는 것이 다른 쪽 파싱을 조용히
/// 깨뜨려서는 안 된다.
///
/// `binary` 와 `truncated` 는 `false` 가 기본이다. 둘 다 **주장**이라, 화면이
/// 말하지 않았으면 하지 않은 것이다.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubFileDiffReply {
    /// 물어본 경로 그대로. 폰이 답과 줄을 맞춘다.
    path: String,
    /// 통합 diff 본문. 이진 파일이면 없다 — 빈 문자열이 아니다.
    #[serde(default)]
    patch: Option<String>,
    #[serde(default)]
    binary: bool,
    /// 답한 쪽이 이미 잘랐나.
    ///
    /// [`HubFileDiffResult::read`] 도 자기 상한에서 자르지만, 상자는 더 작은
    /// 상한(256 KiB)에서 자른다. 그 사실을 여기서 안 실으면 이 노트북의 상한
    /// 아래인 본문은 `truncated: false` 로 다시 태어나고, 폰은 잘린 파일을
    /// 끝까지 본 것으로 그린다.
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    added: Option<u32>,
    #[serde(default)]
    deleted: Option<u32>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

impl HubFileDiffReply {
    fn into_result(self) -> HubFileDiffResult {
        // 이유가 붙어 오면 못 읽은 것이다. 본문이 비어 있는 것과 갈라 둔다 —
        // 빈 본문은 "이 파일에서 바뀐 게 없다" 라는 답이다.
        if let Some(reason) = self.detail {
            return match self.code {
                Some(code) => HubFileDiffResult::refused_with_code(self.path, reason, code),
                None => HubFileDiffResult::refused(self.path, reason),
            };
        }
        if self.binary {
            return HubFileDiffResult::binary(self.path);
        }
        // 본문도 이유도 없다. 화면이 답을 만들지 못했다는 뜻이고, 조용한 빈
        // 화면보다 그 사실을 말하는 편이 낫다.
        let Some(patch) = self.patch else {
            return HubFileDiffResult::refused(self.path, "The desktop could not generate the patch");
        };
        let mut result = HubFileDiffResult::read(self.path, patch).with_counts(self.added, self.deleted);
        // 둘 중 하나라도 잘랐으면 잘린 것이다. 덮어쓰면 상자가 자른 사실을
        // 이 노트북의 상한이 지운다.
        result.truncated = result.truncated || self.truncated;
        result
    }
}

#[tauri::command]
pub fn hub_file_diff_result(
    state: tauri::State<'_, HubState>,
    request_id: String,
    reply: HubFileDiffReply,
) -> bool {
    state.pending_diff.settle(&request_id, reply.into_result())
}

/// 화면이 원격 상자에 파일 하나의 패치를 물을 때 쓴다.
///
/// 왜 화면이 직접 SSH 를 열지 않는지는 [`hub_remote_git_status`] 와 같다.
/// 다른 것은 이 요청이 **폰이 고른 경로**를 싣는다는 점 하나이고, 그것을 거르는
/// 자리는 여기가 아니라 상자다: 게이트웨이가 자기 목록을 먼저 읽고, 그 목록에
/// 없는 경로는 거절한다. 여기서 한 벌 더 거르면 두 규칙이 갈리는 날 상자가
/// 허용한 것을 노트북이 막거나 그 반대가 된다.
#[tauri::command]
pub async fn hub_remote_file_diff(
    state: tauri::State<'_, HubState>,
    box_id: String,
    session_id: String,
    workspace_id: String,
    path: String,
    commit: Option<String>,
) -> Result<RemoteFileDiff, String> {
    let host = state
        .layout
        .remote_host(&box_id)
        .ok_or_else(|| format!("no_remote_host:{box_id}"))?;
    let request_id = format!("hub-diff-{box_id}");
    let document = tauri::async_runtime::spawn_blocking(move || {
        crate::remote_hmux::hub_remote_file_diff(
            &host,
            request_id,
            session_id,
            workspace_id,
            path,
            commit,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(RemoteFileDiff::from(document))
}

/// 원격 상자의 패치를, 화면이 쓰는 모양으로.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileDiff {
    /// `read` | `binary` | `unavailable`.
    pub kind: String,
    /// `unavailable` 일 때만. 상자가 민 닫힌 낱말이다.
    pub reason: Option<String>,
    pub path: String,
    pub patch: Option<String>,
    pub truncated: bool,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

impl From<hmux_ssh_transport::FileDiffDocument> for RemoteFileDiff {
    fn from(document: hmux_ssh_transport::FileDiffDocument) -> Self {
        let path = document.path;
        match document.body {
            hmux_ssh_transport::FileDiffBody::Read { patch, truncated } => Self {
                kind: "read".to_string(),
                reason: None,
                path,
                patch: Some(patch),
                truncated,
                added: document.added,
                deleted: document.deleted,
            },
            hmux_ssh_transport::FileDiffBody::Binary => Self {
                kind: "binary".to_string(),
                reason: None,
                path,
                patch: None,
                truncated: false,
                added: None,
                deleted: None,
            },
            hmux_ssh_transport::FileDiffBody::Unavailable { reason } => Self {
                kind: "unavailable".to_string(),
                reason: Some(reason),
                path,
                patch: None,
                truncated: false,
                added: None,
                deleted: None,
            },
        }
    }
}

/// 지금 들고 있는 배치. 화면이 자기가 보낸 것과 맞는지 확인할 때 쓴다.
#[tauri::command]
#[must_use]
pub fn hub_sidebar_layout(state: tauri::State<'_, HubState>) -> SidebarLayout {
    state.layout.get()
}
