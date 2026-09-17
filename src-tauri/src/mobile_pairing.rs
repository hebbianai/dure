//! 설정 → 모바일: QR 페어링을 이 앱 안에서.
//!
//! # 왜 `hmux pair`를 그대로 부르는가
//!
//! 페어링 규칙 — `authorized_keys` 한 줄의 정확한 모양, 토큰 증명, 설치 전에
//! 취소 기록을 먼저 쓰는 순서 — 은 전부 `hmux-cli` 안에 있고 진짜 sshd로
//! 검증돼 있다. 그걸 여기 다시 구현하면 같은 규칙이 두 벌이 된다.
//!
//! 2026-07-29에 이 저장소가 그 대가를 이미 치렀다: 강제 명령 문자열이 CLI와
//! 클라이언트에 각각 리터럴로 있었고, 강제 명령이 걸리는 서버에서는 클라이언트
//! 값이 버려지기 때문에 차이가 보이지 않았다. Tailscale SSH 호스트에서만
//! 터졌고, 원인을 찾는 데 한 세션이 걸렸다. 그래서 이 모듈은 프로세스를 띄우고
//! 그 출력을 옮기기만 한다.
//!
//! # 왜 스트리밍인가
//!
//! `hmux pair start`는 리스너를 열고 폰이 올 때까지 블록한다. 화면은 그 전에
//! QR을 그려야 하므로, 프로세스가 끝나기를 기다려 출력을 한 번에 받는 방식으로는
//! 만들 수 없다. `--print-payload`가 stdout에 찍는 한 줄을 읽어 이벤트로
//! 올리고, 프로세스는 그대로 살려 둔다.
//!
//! # 페이로드를 stdout으로 받는 것에 대해
//!
//! 이 페이로드에는 일회용 페어링 토큰이 들어 있다. `--print-payload`의 문서가
//! "스크롤백에 남는다"는 이유로 기본값을 끔으로 둔 것도 그래서다. 여기서 켜는
//! 것이 정당한 이유는 셋이다: 파이프가 이 프로세스와 앱 사이에서만 존재하고,
//! 어디에도 기록하지 않으며, 토큰 자체가 한 번만 쓰이고 TTL이 지나면 죽는다.
//! 그래도 로그에 남기지 않는다는 것은 코드로 지킨다 — 아래 어디에도 페이로드를
//! `eprintln!`이나 `log`로 흘리는 곳이 없다.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter as _, Manager as _};

/// 화면이 QR을 그리는 데 필요한 것.
#[derive(Clone, Debug, Serialize)]
pub struct PairingStarted {
    /// `hmux-pair:1?…` — QR에 그대로 넣는다.
    pub payload: String,
    /// 광고한 주소와 포트. 화면이 "폰이 여기로 옵니다"를 말할 수 있게.
    pub address: String,
    pub port: u16,
    pub ttl_seconds: u64,
}

/// 페어링이 끝났을 때. 성공이든 실패든 화면은 결과를 받아야 한다.
#[derive(Clone, Debug, Serialize)]
pub struct PairingFinished {
    pub ok: bool,
    /// CLI가 마지막으로 남긴 사람이 읽을 문장. 우리가 다시 쓰지 않는다 —
    /// 어느 서버가 왜 실패했는지는 CLI만 알고 있다.
    pub detail: String,
}

/// One server whose device key could not be removed.
///
/// The UI owns the surrounding recovery copy, while hmux owns the concrete
/// server and transport failure that make the recovery actionable.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PairingRevokeFailure {
    pub name: String,
    pub failure: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRevokeReport {
    hosts: Vec<PairingRevokeHost>,
}

#[derive(Debug, Deserialize)]
struct PairingRevokeHost {
    name: String,
    failure: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStartRequest {
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) ttl_seconds: u64,
    pub(crate) inventory: Option<String>,
    pub(crate) remote_only: bool,
    /// 이 페어링을 기록할 신원. 허브가 방금 발급한 기기 id 를 그대로 넘긴다.
    ///
    /// 한 번의 짝짓기가 두 권한을 준다 — 허브 토큰과 서버들의
    /// `authorized_keys` 줄. 신원이 둘이면 화면의 삭제 버튼은 앞의 하나만
    /// 지우고, 뒤의 하나는 그것을 부를 이름이 이 컴퓨터에 없어 영영 남는다.
    #[serde(default)]
    pub(crate) device_id: Option<String>,
}

/// 돌고 있는 페어링 하나.
///
/// 한 번에 하나만 허용한다. 두 개가 동시에 돌면 각자 다른 토큰으로 다른 포트를
/// 듣게 되고, 사용자는 화면에 보이는 QR이 어느 쪽인지 알 수 없다. 새로 시작하면
/// 이전 것을 먼저 죽인다.
#[derive(Default)]
pub struct PairingProcess {
    child: Arc<Mutex<Option<Child>>>,
}

impl PairingProcess {
    /// 돌고 있는 페어링을 멈춘다. 없으면 아무 일도 하지 않는다.
    ///
    /// `kill` 실패를 무시하는 이유: 이미 끝난 프로세스에 대한 실패이고, 그건
    /// 우리가 원하던 상태다. 살아 있는데 죽지 않는 경우는 다음 `wait`에서
    /// 드러난다.
    pub fn stop(&self) {
        let mut guard = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_for_child(child: &Arc<Mutex<Option<Child>>>) -> Option<std::process::ExitStatus> {
    loop {
        let mut guard = child.lock().unwrap_or_else(|error| error.into_inner());
        let running = guard.as_mut()?;
        match running.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                return Some(status);
            }
            Ok(None) => {}
            Err(_) => {
                guard.take();
                return None;
            }
        }
        drop(guard);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 독립 설치본을 우선하고, 전환 기간에만 번들된 `hmux`로 폴백한다.
///
/// 독립 설치본은 immutable version의 manifest, CLI build identity, protocol과
/// `pairing_v1` capability를 모두 검증한 경로다. 손상된 독립 설치를 번들로 조용히
/// 덮으면 사용자가 어느 build를 실행했는지 알 수 없으므로 그 경우는 fail-closed.
/// 아직 독립 설치를 하지 않은 사용자만 기존 resource fallback으로 bootstrap한다.
pub(crate) fn resolve_hmux(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // `src-tauri`는 let-chain을 쓸 수 없는 에디션이라 중첩으로 쓴다.
    let explicit = std::env::var("HMUX_CLI")
        .ok()
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from);
    let triple = format!("hmux-{}", std::env::consts::ARCH);
    let candidates = [
        app.path().resource_dir().ok().map(|dir| dir.join("hmux")),
        app.path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join(triple.clone())),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("hmux"))),
    ];
    select_hmux_binary(
        explicit,
        crate::hmux::resolve_independent_hmux_cli(),
        candidates.into_iter().flatten(),
    )
}

fn select_hmux_binary(
    explicit: Option<std::path::PathBuf>,
    installed: Result<Option<std::path::PathBuf>, String>,
    bundled_candidates: impl IntoIterator<Item = std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    if let Some(explicit) = explicit {
        return Ok(explicit);
    }
    if let Some(installed) = installed? {
        return Ok(installed);
    }
    for candidate in bundled_candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(
        "No compatible standalone Hmux installation or bundled Hmux executable was found. Install Hmux and try again."
            .to_string(),
    )
}

/// stdout 한 줄에서 페이로드를 뽑는다.
///
/// 접두사 매칭이 아니라 `strip_prefix`인 이유: CLI가 `payload: <값>`으로 찍고,
/// `contains`로 찾으면 값 안에 같은 문자열이 있을 때 잘못 자른다. 페이로드는
/// base64url과 점만으로 이루어지지만, 그 사실에 기대는 파서는 형식이 바뀌는 날
/// 조용히 틀린 값을 넘긴다.
pub fn payload_from_line(line: &str) -> Option<&str> {
    let value = line.trim().strip_prefix("payload: ")?;
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

/// 광고할 주소 후보. 화면의 네트워크 드롭다운이 이걸 그린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NetworkChoice {
    pub address: String,
    /// `en0`, `utun1` 같은 인터페이스 이름. 사용자가 무엇을 고르는지 알게.
    pub interface: String,
    /// 테일넷 주소로 보이는지. 화면이 "다른 망에서도 닿습니다"를 말할 수 있게.
    pub tailnet: bool,
}

/// 100.64.0.0/10 — CGNAT 대역이고 Tailscale이 쓰는 곳이다.
///
/// 이름으로 판별하지 않는 이유: 인터페이스 이름은 플랫폼마다 다르고(`utun1`,
/// `tailscale0`) 사용자가 바꿀 수도 있다. 대역은 Tailscale이 문서에 못박은
/// 값이라 더 안정적이다. 다만 이건 힌트일 뿐이라 틀려도 주소는 그대로 쓸 수
/// 있다 — 화면의 문구 하나가 달라질 뿐이다.
pub fn looks_tailnet(address: &str) -> bool {
    let mut parts = address.split('.');
    let (Some(first), Some(second)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(first), Ok(second)) = (first.parse::<u8>(), second.parse::<u8>()) else {
        return false;
    };
    first == 100 && (64..=127).contains(&second)
}

/// 이 기계가 광고할 수 있는 IPv4 주소들.
///
/// 루프백은 뺀다 — 폰이 `127.0.0.1`로 올 수는 없고, 목록에 있으면 고를 수 있는
/// 것처럼 보인다. IPv6도 지금은 뺀다: QR 페이로드가 점 표기 주소를 이스케이프
/// 없이 싣도록 되어 있어(`qr.rs`의 주석), 콜론이 든 주소는 형식을 바꿔야 한다.
pub fn network_choices() -> Vec<NetworkChoice> {
    let mut found = Vec::new();
    let Ok(output) = Command::new("/sbin/ifconfig").output() else {
        return found;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut interface = String::new();
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) {
            if let Some((name, _)) = line.split_once(':') {
                interface = name.trim().to_string();
            }
        }
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("inet ") else {
            continue;
        };
        let Some(address) = rest.split_whitespace().next() else {
            continue;
        };
        if address == "127.0.0.1" || interface.is_empty() {
            continue;
        }
        found.push(NetworkChoice {
            address: address.to_string(),
            interface: interface.clone(),
            tailnet: looks_tailnet(address),
        });
    }
    // 테일넷 주소를 위로. 이 목록을 여는 사람은 보통 "다른 망에서도 닿는 주소"를
    // 찾고 있고, 그게 이 화면이 존재하는 이유다.
    found.sort_by_key(|choice| !choice.tailnet);
    found
}

/// `hmux pair start` 에 넘길 인자.
///
/// # `--writable` 이 여기 있는 이유
///
/// 이 화면이 이 저장소의 유일한 페어링 경로이고, 여기서 `--writable` 을 빼면
/// 그 폰은 그 상자의 **모든 세션에서 영구히 관찰자**가 된다. sshd 가
/// `authorized_keys` 의 forced command 로 argv 를 갈아치우고, `mobile-gateway`
/// 의 `--role` 기본값이 `Observer` 이기 때문이다 — 폰이 무엇을 요청하든
/// 게이트웨이의 천장이 이긴다. 그 상태에서 앱의 "입력 켜기" 버튼은 눌러도
/// 아무 일이 일어나지 않고, 왜 안 되는지는 다시 짝짓기 전까지 고칠 수 없다.
///
/// 그래서 이 앱이 짝지어 주는 폰은 입력할 수 있다. 그 대가는 실재한다:
/// 컨트롤러 권한은 리스이고 Host 는 하나만 내주며 되찾을 방법이 없어서,
/// 폰이 쥐고 있는 동안 책상 앞의 사람은 그 터미널에 타이핑할 수 없다.
/// `mobile-gateway` 가 조용해진 상대의 리스를 놓아 주는 것이 그 시간을
/// "폰이 놓아 줄 때까지" 에서 "몇 분" 으로 바꾼다(`pairing/mod.rs` 의 플래그
/// 주석). 소유자가 2026-09-01 에 그 거래를 보고 선택한 결정이다.
///
/// 이미 짝지은 상자는 바뀌지 않는다 — forced command 는 그때 쓰인 줄이라,
/// 다시 짝지어야 반영된다.
fn pairing_arguments(request: &PairingStartRequest) -> Vec<String> {
    let mut arguments = vec![
        "--address".to_string(),
        request.address.clone(),
        "--port".to_string(),
        request.port.to_string(),
        "--ttl-seconds".to_string(),
        request.ttl_seconds.to_string(),
        "--print-payload".to_string(),
        "--writable".to_string(),
    ];
    if let Some(path) = request.inventory.as_deref().filter(|path| !path.is_empty()) {
        arguments.push("--inventory".to_string());
        arguments.push(path.to_string());
    }
    if request.remote_only {
        arguments.push("--remote-only".to_string());
    }
    if let Some(id) = request.device_id.as_deref().filter(|id| !id.is_empty()) {
        arguments.push("--device-id".to_string());
        arguments.push(id.to_string());
    }
    arguments
}

/// 페어링을 시작하고, 페이로드를 받으면 그것을 돌려준다.
///
/// 프로세스는 계속 살아 있다 — 폰이 오기를 기다리는 중이다. 결과는
/// `mobile-pairing-finished` 이벤트로 나중에 온다.
#[tauri::command]
pub async fn mobile_pairing_start(
    app: tauri::AppHandle,
    request: PairingStartRequest,
) -> Result<PairingStarted, String> {
    let state = app.state::<PairingProcess>();
    // 새로 시작하기 전에 이전 것을 반드시 죽인다. 두 리스너가 동시에 돌면
    // 화면의 QR이 어느 쪽 토큰인지 알 수 없다.
    state.stop();

    let binary = resolve_hmux(&app)?;
    let mut command = Command::new(&binary);
    command
        .arg("pair")
        .arg("start")
        .args(pairing_arguments(&request))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start hmux pair: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the output of hmux pair".to_string())?;

    let handle = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(payload) = payload_from_line(&line) {
                    // 이 줄만 채널로 보내고 나머지는 흘린다. QR을 그리는 데
                    // 필요한 것은 이 한 줄뿐이고, 나머지 출력은 사람이 읽으라고
                    // 만든 문장이라 화면이 다시 쓸 이유가 없다.
                    let _ = sender.send(payload.to_string());
                    sent = true;
                    continue;
                }
            }
            // 페이로드 줄은 여기 도달하지 않는다 — 위에서 `continue`한다.
            // 나머지 줄은 버린다: 로그로 흘리면 다음 사람이 `--print-payload`를
            // 켠 채 이 경로를 재사용했을 때 토큰이 로그에 남는다.
            let _ = line;
        }
    });

    // 페이로드 줄은 QR을 그리기 직전에 찍히므로 바로 온다. 시간 제한을 두는
    // 이유는 바이너리가 다른 이유로 죽었을 때 화면이 영원히 도는 것을 막기
    // 위해서다.
    let payload = receiver
        .recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read as _;
                let _ = pipe.read_to_string(&mut stderr);
            }
            let _ = child.kill();
            let detail = stderr.trim();
            if detail.is_empty() {
                "hmux pair did not produce a QR code".to_string()
            } else {
                format!("hmux pair did not produce a QR code: {detail}")
            }
        })?;

    let stderr = child.stderr.take();
    *app.state::<PairingProcess>()
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(child);

    // 끝날 때를 지켜보다 화면에 알린다. 이 스레드가 없으면 페어링이 성공해도
    // 화면은 QR을 계속 띄운 채 남는다.
    //
    // 자식을 상태에서 꺼내 와서 기다린다: 락을 쥔 채 `wait`하면 그동안
    // `stop()`이 막히고, 화면을 닫아도 프로세스가 안 죽는다.
    let watcher = handle;
    std::thread::spawn(move || {
        let Some(status) = wait_for_child(&watcher.state::<PairingProcess>().child) else {
            return;
        };
        let mut detail = String::new();
        if let Some(mut pipe) = stderr {
            use std::io::Read as _;
            let _ = pipe.read_to_string(&mut detail);
        }
        let _ = watcher.emit(
            "mobile-pairing-finished",
            PairingFinished {
                ok: status.success(),
                detail: detail.trim().to_string(),
            },
        );
    });

    Ok(PairingStarted {
        payload,
        address: request.address,
        port: request.port,
        ttl_seconds: request.ttl_seconds,
    })
}

/// QR 한 장을 그릴 수 있는 최소 정보.
///
/// SVG나 PNG가 아니라 매트릭스를 넘기는 이유: 그리는 쪽이 웹뷰라 테마·크기·여백을
/// 화면이 정하는 게 맞고, 서버가 이미 색을 칠한 이미지를 보내면 다크/라이트 전환에
/// 이미지가 따라오지 못한다. 인코딩(어려운 부분)은 여기서, 그리기(쉬운 부분)는
/// 저기서.
#[derive(Clone, Debug, Serialize)]
pub struct QrMatrix {
    /// 한 변의 모듈 수. 행 길이이자 열 길이다.
    pub size: usize,
    /// 왼쪽 위부터 행 우선. `true`가 어두운 모듈이다.
    pub modules: Vec<bool>,
}

/// 페이로드를 QR 매트릭스로.
///
/// 여백(quiet zone)은 넣지 않는다 — 사양이 요구하는 4모듈이지만, 그건 그리는
/// 쪽이 패딩으로 주는 게 낫다. 매트릭스에 흰 테두리를 넣어 보내면 화면이 그
/// 두께를 조절할 수 없고, 여백 없는 QR은 스캐너가 못 읽는다는 사실을 화면 쪽이
/// 모르게 된다.
#[tauri::command]
pub fn mobile_pairing_qr(payload: String) -> Result<QrMatrix, String> {
    // `EcLevel::M`: hmux-cli의 터미널 렌더와 같은 값이다. 두 곳이 다른 정정
    // 수준을 쓰면 같은 페이로드가 다른 크기의 심볼이 되고, "노트북 화면에서는
    // 읽히는데 설정 화면에서는 안 읽힌다"는 재현 안 되는 신고가 된다.
    let code = qrcode::QrCode::with_error_correction_level(&payload, qrcode::EcLevel::M)
        .map_err(|error| format!("Could not encode the payload as a QR code: {error}"))?;
    let size = code.width();
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| color == qrcode::Color::Dark)
        .collect();
    Ok(QrMatrix { size, modules })
}

/// 돌고 있는 페어링을 멈춘다. 화면을 닫거나 코드를 다시 만들 때.
#[tauri::command]
pub fn mobile_pairing_stop(app: tauri::AppHandle) {
    app.state::<PairingProcess>().stop();
}

/// 광고할 수 있는 주소 목록.
#[tauri::command]
pub fn mobile_pairing_networks() -> Vec<NetworkChoice> {
    network_choices()
}

/// 이 기기가 서버들에 남긴 `authorized_keys` 줄을 지운다.
///
/// 허브 토큰만 지워서는 폰의 권한이 사라지지 않는다. 같은 짝짓기가 서버마다
/// 강제 명령 키를 한 줄씩 심어 두었고, 그 줄은 이 노트북이 꺼져 있어도 산다 —
/// 애초에 그것이 짝짓기의 목적이다. 그래서 "기기 삭제"는 여기를 먼저 거친다.
///
/// 짝짓기 기록에 없는 id 는 성공이다: 이 화면이 생기기 전에 짝지은 기기와,
/// 허브에만 등록된 기기가 그렇다. 지울 것이 없다는 뜻이지 실패가 아니다.
pub(crate) fn revoke_ssh_pairing(
    app: &tauri::AppHandle,
    device_id: &str,
    forget_unreachable: bool,
) -> Result<Vec<PairingRevokeFailure>, String> {
    let binary = resolve_hmux(app)?;
    let listing = Command::new(&binary)
        .arg("pair")
        .arg("list")
        .arg("--json")
        .output()
        .map_err(|error| format!("Could not read the paired device list: {error}"))?;
    if !listing.status.success() {
        // 물어보지도 못한 채 허브 토큰만 지우면, 서버의 키는 남고 그것을 부를
        // 이름은 사라진다. 여기서 멈추는 편이 낫다.
        return Err(format!(
            "Could not read the paired device list; nothing was deleted: {}",
            String::from_utf8_lossy(&listing.stderr).trim()
        ));
    }
    let pairings = ssh_pairings_of_device(&String::from_utf8_lossy(&listing.stdout), device_id)?;
    if pairings.is_empty() {
        return Ok(Vec::new());
    }
    let inventory = crate::app_channel::current()
        .map_err(|error| format!("Could not locate the current server list: {error}"))?
        .control_dir
        .join("agents.json");
    let inventory = inventory.is_file().then_some(inventory);
    let mut all_failures = Vec::new();
    for id in pairings {
        let mut command = Command::new(&binary);
        command.arg("pair").arg("revoke").arg(&id).arg("--json");
        if let Some(inventory) = &inventory {
            command.arg("--inventory").arg(inventory);
        }
        if forget_unreachable {
            command.arg("--forget-unreachable");
        }
        let revoked = command
            .output()
            .map_err(|error| format!("Could not delete the server key: {error}"))?;
        let failures = pairing_revoke_failures(&String::from_utf8_lossy(&revoked.stdout))?;
        if !failures.is_empty() {
            all_failures.extend(failures);
            // Without explicit consent hmux kept this record. Preserve the
            // existing stop-on-first-failed-pairing behavior so a later retry
            // still starts from the same device identity.
            if !forget_unreachable {
                return Ok(all_failures);
            }
        }
        if !revoked.status.success() {
            return Err(format!(
                "Hmux exited without a per-server key deletion result ({})",
                revoked.status
            ));
        }
    }
    Ok(all_failures)
}

fn pairing_revoke_failures(report: &str) -> Result<Vec<PairingRevokeFailure>, String> {
    let report: PairingRevokeReport = serde_json::from_str(report)
        .map_err(|error| format!("Could not read the Hmux per-server key deletion result: {error}"))?;
    Ok(report
        .hosts
        .into_iter()
        .filter_map(|host| {
            host.failure.map(|failure| PairingRevokeFailure {
                name: host.name,
                failure,
            })
        })
        .collect())
}

/// 이 기기를 지울 때 함께 거둬야 할 짝짓기 기록 전부.
///
/// **한 줄이 아니라 한 폰이 단위다.** 짝짓기는 서버마다 `authorized_keys` 한
/// 줄을 심고, 같은 폰이 다시 짝지으면 줄이 하나 더 늘어난다. 그래서 id 하나만
/// 지우면 폰은 앞선 짝짓기의 키로 그대로 들어간다 — 사용자가 본 "삭제"는
/// 절반만 일어난 셈이고, 실제로 그렇게 쌓여 있었다(Gate1 7줄, artrooms-dev
/// 5줄, 2026-09-05).
///
/// 같은 폰인지는 공개키 지문으로 안다. 폰이 짝짓기마다 새 키를 만들던 동안의
/// 기록은 지문이 서로 달라 여기서 묶이지 않는다 — 그 시절 것은 사람이
/// `hmux pair revoke` 로 거둬야 한다.
///
/// 목록에 없는 id 는 빈 결과다: 허브에만 등록된 기기와, 이 화면이 생기기 전에
/// 짝지은 기기가 그렇다. 지울 것이 없다는 뜻이지 실패가 아니다.
fn ssh_pairings_of_device(listing: &str, device_id: &str) -> Result<Vec<String>, String> {
    let listing = serde_json::from_str::<serde_json::Value>(listing)
        .map_err(|error| format!("Could not parse the paired device list: {error}"))?;
    let devices = listing
        .get("devices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "The paired device list is missing its devices array".to_string())?;
    let field = |device: &serde_json::Value, name: &str| {
        device
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let Some(target) = devices
        .iter()
        .find(|device| field(device, "device_id").as_deref() == Some(device_id))
    else {
        return Ok(Vec::new());
    };
    // 지문이 비어 있는 기록은 자기 자신하고만 묶는다. 빈 값끼리 같다고 보면
    // 서로 무관한 폰들을 한꺼번에 지우게 된다.
    let fingerprint = field(target, "fingerprint").filter(|value| !value.is_empty());
    Ok(devices
        .iter()
        .filter(|device| match (&fingerprint, field(device, "fingerprint")) {
            (Some(wanted), Some(found)) => &found == wanted,
            _ => field(device, "device_id").as_deref() == Some(device_id),
        })
        .filter_map(|device| field(device, "device_id"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이 플래그가 빠지면 그 폰은 그 상자의 모든 세션에서 영구히 관찰자가 되고,
    /// 화면의 "입력 켜기" 버튼은 눌러도 아무 일이 없다 — 다시 짝짓기 전까지.
    /// 조용히 사라지는 종류의 값이라, 사라졌다는 것을 여기서만 알 수 있다.
    fn request(inventory: Option<&str>, remote_only: bool) -> PairingStartRequest {
        PairingStartRequest {
            address: "100.64.0.1".to_string(),
            port: 4830,
            ttl_seconds: 120,
            inventory: inventory.map(str::to_string),
            remote_only,
            device_id: None,
        }
    }

    #[test]
    fn a_paired_phone_is_given_input_authority() {
        let arguments = pairing_arguments(&request(None, false));

        assert!(
            arguments.iter().any(|argument| argument == "--writable"),
            "짝지은 폰이 입력할 수 없게 된다: {arguments:?}"
        );
    }

    /// 인자를 덧붙이는 자리가 늘어도 순서와 짝이 흔들리지 않아야 한다.
    #[test]
    fn optional_arguments_travel_as_pairs() {
        let arguments = pairing_arguments(&request(Some("/tmp/inventory"), true));

        let inventory = arguments
            .iter()
            .position(|argument| argument == "--inventory")
            .expect("인벤토리 인자");
        assert_eq!(arguments.get(inventory + 1).map(String::as_str), Some("/tmp/inventory"));
        assert!(arguments.iter().any(|argument| argument == "--remote-only"));

        // 빈 문자열은 경로가 아니다 — 그대로 넘기면 hmux 가 빈 파일을 찾는다.
        let empty = pairing_arguments(&request(Some(""), false));
        assert!(!empty.iter().any(|argument| argument == "--inventory"));
    }

    /// 화면의 삭제가 서버의 키까지 지우려면, 그 키가 화면이 아는 이름으로
    /// 기록돼야 한다. 이 인자가 빠지면 hmux 는 자기 uuid 를 만들고 그 기록은
    /// 허브의 기기 목록과 이어지지 않는다 — 삭제는 절반만 일어난다.
    #[test]
    fn the_hub_identity_travels_into_the_ssh_pairing() {
        let mut asked = request(None, true);
        asked.device_id = Some("device_2f9c81aa".to_string());

        let arguments = pairing_arguments(&asked);

        let flag = arguments
            .iter()
            .position(|argument| argument == "--device-id")
            .expect("신원 인자");
        assert_eq!(
            arguments.get(flag + 1).map(String::as_str),
            Some("device_2f9c81aa")
        );
    }

    /// 삭제의 단위는 줄 하나가 아니라 폰 하나다. 같은 폰이 다시 짝지으면
    /// 서버에 줄이 하나 더 늘고, 앞의 것을 남겨 두면 그 폰은 지운 뒤에도
    /// 그대로 들어간다 — 사용자가 "여전히 되는 애가 있다"고 말한 그 상태다.
    #[test]
    fn every_pairing_of_the_same_phone_is_collected() {
        let listing = r#"{
            "schemaVersion": 1,
            "registry": "/Users/x/.hmux/paired-devices.json",
            "devices": [
                { "device_id": "device_2f9c81aa", "fingerprint": "SHA256:phone" },
                { "device_id": "4ef42451-154d-43ba", "fingerprint": "SHA256:phone" },
                { "device_id": "device_00000000", "fingerprint": "SHA256:other" }
            ]
        }"#;

        assert_eq!(
            ssh_pairings_of_device(listing, "device_2f9c81aa").unwrap(),
            vec!["device_2f9c81aa", "4ef42451-154d-43ba"]
        );
        // 다른 폰은 건드리지 않는다. 기기 하나를 지우는 일이 온 집안의 폰을
        // 끊는 일이 되면 아무도 그 버튼을 못 누른다.
        assert_eq!(
            ssh_pairings_of_device(listing, "device_00000000").unwrap(),
            vec!["device_00000000"]
        );
    }

    /// 목록에 없는 id 는 지울 것이 없다는 뜻이다: 허브에만 등록된 기기와, 이
    /// 경로가 생기기 전에 짝지은 기기가 그렇다. 실패가 아니다.
    #[test]
    fn an_unlisted_device_collects_nothing() {
        let listing = r#"{"devices": [{ "device_id": "device_2f9c81aa" }]}"#;

        assert!(
            ssh_pairings_of_device(listing, "device_00000000")
                .unwrap()
                .is_empty()
        );
        assert!(
            ssh_pairings_of_device(r#"{"devices": []}"#, "device_2f9c81aa")
                .unwrap()
                .is_empty()
        );
        assert!(ssh_pairings_of_device("사람이 읽는 문장", "device_2f9c81aa").is_err());
    }

    /// 지문을 아직 적지 않던 판의 기록은 자기 자신하고만 묶인다. 빈 값끼리
    /// 같다고 보면 서로 무관한 폰들이 한 번에 끊긴다.
    #[test]
    fn records_without_a_fingerprint_group_only_with_themselves() {
        let listing = r#"{
            "devices": [
                { "device_id": "device_a", "fingerprint": "" },
                { "device_id": "device_b", "fingerprint": "" }
            ]
        }"#;

        assert_eq!(
            ssh_pairings_of_device(listing, "device_a").unwrap(),
            vec!["device_a"]
        );
    }

    #[test]
    fn revoke_report_keeps_the_failed_server_and_cause() {
        let report = r#"{
            "schemaVersion": 1,
            "deviceId": "device_a",
            "hosts": [
                { "name": "Gate1", "failure": null },
                {
                    "name": "build box",
                    "failure": "Load key /old-key.pem: Operation not permitted"
                }
            ]
        }"#;

        assert_eq!(
            pairing_revoke_failures(report).unwrap(),
            vec![PairingRevokeFailure {
                name: "build box".into(),
                failure: "Load key /old-key.pem: Operation not permitted".into(),
            }]
        );
    }

    #[test]
    fn the_watcher_keeps_the_running_pairing_stoppable() {
        let process = PairingProcess::default();
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        *process
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(child);
        let watched = process.child.clone();
        let watcher = std::thread::spawn(move || wait_for_child(&watched));

        process.stop();

        assert!(watcher.join().unwrap().is_none());
        assert!(process.child.lock().unwrap().is_none());
    }

    #[test]
    fn a_verified_independent_cli_wins_over_the_transitional_bundle() {
        let temp = tempfile::TempDir::new().unwrap();
        let installed = temp.path().join("installed-hmux");
        let bundled = temp.path().join("bundled-hmux");
        std::fs::write(&installed, b"installed").unwrap();
        std::fs::write(&bundled, b"bundled").unwrap();

        assert_eq!(
            select_hmux_binary(None, Ok(Some(installed.clone())), [bundled]).unwrap(),
            installed
        );
    }

    #[test]
    fn an_absent_or_legacy_install_uses_the_transitional_bundle() {
        let temp = tempfile::TempDir::new().unwrap();
        let bundled = temp.path().join("bundled-hmux");
        std::fs::write(&bundled, b"bundled").unwrap();

        assert_eq!(
            select_hmux_binary(None, Ok(None), [bundled.clone()]).unwrap(),
            bundled
        );
    }

    #[test]
    fn a_corrupt_independent_install_never_falls_back_to_another_build() {
        let temp = tempfile::TempDir::new().unwrap();
        let bundled = temp.path().join("bundled-hmux");
        std::fs::write(&bundled, b"bundled").unwrap();

        assert_eq!(
            select_hmux_binary(
                None,
                Err("hmux_independent_install_invalid: build mismatch".to_string()),
                [bundled],
            )
            .unwrap_err(),
            "hmux_independent_install_invalid: build mismatch"
        );
    }

    #[test]
    fn a_payload_line_is_read_by_its_prefix() {
        assert_eq!(
            payload_from_line("payload: hmux-pair:1?a=1.2.3.4&p=47823"),
            Some("hmux-pair:1?a=1.2.3.4&p=47823")
        );
    }

    /// CLI의 다른 출력이 페이로드로 오해되면 화면이 QR 자리에 안내 문장을
    /// 그린다. 접두사로만 인정한다.
    #[test]
    fn other_output_is_not_mistaken_for_a_payload() {
        for line in [
            "휴대폰으로 이 QR을 스캔하세요 — 300초 동안 한 번만 유효합니다.",
            "주소 / address: 100.90.1.2:47823",
            "이 줄에는 payload: 라는 말이 중간에 있다",
            "payload:",
            "payload: ",
            "",
        ] {
            assert_eq!(payload_from_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn a_payload_line_survives_surrounding_whitespace() {
        assert_eq!(
            payload_from_line("  payload: hmux-pair:1?a=1  \n"),
            Some("hmux-pair:1?a=1")
        );
    }

    /// 100.64.0.0/10. 대역 경계를 양쪽에서 확인한다 — 한쪽만 보면 인접한 사설
    /// 주소를 테일넷이라고 부르게 되고, 화면이 "다른 망에서도 닿습니다"라는
    /// 틀린 말을 한다.
    #[test]
    fn the_tailnet_range_is_recognised_at_both_edges() {
        assert!(looks_tailnet("100.64.0.1"));
        assert!(looks_tailnet("100.127.255.254"));
        // 대역 안의 임의 값. 이 기계의 실제 테일넷 주소를 쓰면 사적 값이
        // 저장소에 남고, 검사하려는 성질(100.64/10 판별)과는 무관하다.
        assert!(looks_tailnet("100.90.1.2"));

        assert!(!looks_tailnet("100.63.255.255"));
        assert!(!looks_tailnet("100.128.0.1"));
        assert!(!looks_tailnet("192.168.1.10"));
        assert!(!looks_tailnet("10.0.0.1"));
    }

    #[test]
    fn nonsense_is_not_a_tailnet_address() {
        for address in ["", "not-an-address", "100", "100.", "999.999.0.1", "::1"] {
            assert!(!looks_tailnet(address), "{address:?}");
        }
    }

    /// 루프백은 폰이 올 수 없는 주소다. 목록에 있으면 고를 수 있는 것처럼
    /// 보이고, 고르면 QR이 닿지 않는 주소를 광고한다.
    #[test]
    fn the_loopback_address_is_never_offered() {
        for choice in network_choices() {
            assert_ne!(choice.address, "127.0.0.1");
        }
    }

    #[test]
    fn a_payload_becomes_a_square_matrix() {
        let matrix = mobile_pairing_qr("hmux-pair:1?a=100.90.1.2&p=47823&t=abc".into())
            .expect("a short payload encodes");

        assert_eq!(matrix.modules.len(), matrix.size * matrix.size);
        assert!(matrix.size >= 21, "the smallest QR is 21 modules");
        assert!(matrix.modules.iter().any(|dark| *dark));
    }

    /// 위치 표식(finder pattern)을 모듈 단위로 확인한다.
    ///
    /// 모서리 한 칸만 보는 것으로는 부족했다 — 처음에 오른쪽 아래가 밝다고
    /// 단언했는데 그건 데이터 영역이라 어두울 수 있고, 테스트가 내 착각을
    /// 검사하고 있었다. 사양이 정한 7×7 무늬는 그렇지 않다:
    ///
    /// ```text
    /// 1111111
    /// 1000001
    /// 1011101
    /// ```
    ///
    /// 이걸로 잡히는 것: 흑백 반전, 행/열 인덱싱 실수, 한 칸 밀림.
    /// 이걸로 안 잡히는 것: 전치(transpose) — 위치 표식은 대칭이라 뒤집혀도
    /// 같아 보인다. 그건 폰으로 실제 스캔해야 드러난다.
    #[test]
    fn the_finder_patterns_have_the_shape_the_spec_defines() {
        let matrix = mobile_pairing_qr("hmux-pair:1?a=1".into()).expect("encodes");
        let at = |row: usize, column: usize| matrix.modules[row * matrix.size + column];
        let last = matrix.size - 7;

        for (top, left) in [(0, 0), (0, last), (last, 0)] {
            for column in 0..7 {
                assert!(at(top, left + column), "{top},{left} 위쪽 테두리");
                assert!(at(top + 6, left + column), "{top},{left} 아래쪽 테두리");
            }
            for row in 1..6 {
                assert!(at(top + row, left), "{top},{left} 왼쪽 테두리");
                assert!(at(top + row, left + 6), "{top},{left} 오른쪽 테두리");
            }
            // 테두리 안쪽 한 겹은 비어 있고, 그 안의 3×3이 다시 차 있다.
            for column in 1..6 {
                assert!(!at(top + 1, left + column), "{top},{left} 안쪽 여백");
            }
            for row in 2..5 {
                for column in 2..5 {
                    assert!(at(top + row, left + column), "{top},{left} 가운데");
                }
            }
        }
    }

    /// 이 목록을 여는 사람은 보통 "다른 망에서도 닿는 주소"를 찾고 있다.
    #[test]
    fn tailnet_addresses_are_offered_first() {
        let choices = network_choices();
        let first_plain = choices.iter().position(|choice| !choice.tailnet);
        let last_tailnet = choices.iter().rposition(|choice| choice.tailnet);
        if let (Some(plain), Some(tailnet)) = (first_plain, last_tailnet) {
            assert!(tailnet < plain, "{choices:?}");
        }
    }
}
