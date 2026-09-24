//! 로컬 CLI 서버 — `hebbian` CLI가 앱에 요청(spawn 등 상태가 필요한 동작)을
//! 보내는 진입점. 127.0.0.1에만 바인딩하고 토큰으로 가드한다. 요청은 프론트
//! 엔드로 이벤트(`cli:request`)를 던져 처리하게 하고(앱의 실제 에이전트 생성
//! 로직 재사용), 결과는 프론트가 다시 기록하는 레지스트리 파일로 피드백된다.
//! Managed Hmux input crosses this authenticated boundary and reaches the Host
//! through the app's typed terminal-surface command path.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Response};

mod frontend_receipt;
mod listener;
mod managed_claude;
mod replayable_request;
mod request_broker;
use frontend_receipt::{dispatch_remote_shell_receipt, wait_for_frontend_receipt};
use listener::LocalApiListener;
use replayable_request::replayable_frontend_request;
pub use request_broker::CliRequestBroker;
use request_broker::{CliRequestRegistration, CliRequestRegistrationError};
#[cfg(debug_assertions)]
mod window_focus_qa;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const PANE_OPERATION_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const HMUX_CREATE_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const HMUX_UPGRADE_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const HMUX_ADOPTION_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const HMUX_REHOST_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const HMUX_CONVERSION_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const HMUX_STOP_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const HMUX_CLEANUP_EXITED_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HMUX_INPUT_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HMUX_REMOTE_SHELL_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const SPAWN_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const WORKSPACE_IMPORT_CLAIMED_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_REQUEST_BODY_BYTES: u64 = 64 * 1024;
const CLI_API_VERSION: u32 = 1;
const SERVER_CAPABILITIES: &[&str] = &[
    managed_claude::HOST_REPORT_CAPABILITY,
    managed_claude::CAUSAL_HOST_REPORT_CAPABILITY,
    "performance_report.terminal_input_v1",
    "provider_transcript.read_v1",
    "quick_commands_v1",
    "pane_actions.arguments_results_v1",
    "terminal_pane.create_v1",
    "mobile_pane.open_v1",
    "project_registration.add_v1",
    "ssh_hosts.add_v1",
    "worktree.presentation_export_v1",
    "browser.presentation_v1",
    "unopened_agents.visibility_v1",
    "agent.launch_preference_v1",
    "agent.launch_account_v1",
    "agent.run_background_v1",
];
fn claimed_request_timeout(action: &str) -> Duration {
    match action {
        "agent.present" | "browser.present" | "hmux.attach" | "pane.act" | "pane.open" => {
            PANE_OPERATION_CLAIMED_REQUEST_TIMEOUT
        }
        "hmux.create" => HMUX_CREATE_CLAIMED_REQUEST_TIMEOUT,
        "hmux.upgrade" => HMUX_UPGRADE_CLAIMED_REQUEST_TIMEOUT,
        "hmux.adopt" => HMUX_ADOPTION_CLAIMED_REQUEST_TIMEOUT,
        "hmux.rehost" | "agent.reuse" => HMUX_REHOST_CLAIMED_REQUEST_TIMEOUT,
        "hmux.convert" => HMUX_CONVERSION_CLAIMED_REQUEST_TIMEOUT,
        "hmux.stop" => HMUX_STOP_CLAIMED_REQUEST_TIMEOUT,
        "hmux.cleanup-exited" => HMUX_CLEANUP_EXITED_CLAIMED_REQUEST_TIMEOUT,
        "agent.input" | "hmux.input" => HMUX_INPUT_CLAIMED_REQUEST_TIMEOUT,
        "hmux.remote-shell" => HMUX_REMOTE_SHELL_CLAIMED_REQUEST_TIMEOUT,
        "spawn" => SPAWN_CLAIMED_REQUEST_TIMEOUT,
        "sessions.recent"
        | "workspace.import.preview"
        | "workspace.import.status"
        | "workspace.import.apply" => WORKSPACE_IMPORT_CLAIMED_REQUEST_TIMEOUT,
        _ => CLAIMED_REQUEST_TIMEOUT,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerDescriptor<'a> {
    schema_version: u32,
    api_version: u32,
    package_version: &'a str,
    build_id: &'a str,
    port: u16,
    token: &'a str,
    /// Report 스코프 전용 토큰 — 훅처럼 에이전트 세션 내부에서 도는 코드는
    /// 이 토큰만 쓰게 해 세션 조작 라우트 접근을 차단한다(additive 필드,
    /// 구 CLI는 무시하고 `token`을 계속 쓴다).
    report_token: &'a str,
    channel: &'a str,
    generation: &'a str,
    process_id: u32,
    started_at_unix_ms: u128,
    capabilities: &'a [&'a str],
}

/// A3: 라우트가 요구하는 토큰 스코프. Report는 fire-and-forget 보고(훅 등
/// 에이전트 세션 내부에서 도는 코드에 노출되는 경로)만 허용하고, Control은
/// 세션 생성·조작 전권이다. 같은 사용자 프로세스는 server.json을 읽을 수
/// 있으므로 이는 완전한 방어가 아니라 토큰이 훅 설정·transcript·원격으로
/// 이동할 때의 blast radius를 줄이는 계층이다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RouteScope {
    Report,
    Control,
}

struct FrontendRoute {
    method: Method,
    path: &'static str,
    action: &'static str,
    waits_for_receipt: bool,
    scope: RouteScope,
    /// 파괴적 라우트는 body에 `confirm: true`가 없으면 428로 거절한다.
    /// 스크립트 사고(mass-stop) 방지용 풋건 가드다 — adversarial 방어가
    /// 아니며, 그건 스코프 토큰과 OS 격리의 몫이다.
    destructive: bool,
}

/// 프론트엔드로 위임되는 라우트의 단일 진실 테이블. 새 라우트는 반드시
/// 여기(또는 아래 required_scope의 직접 처리 allowlist)에 분류를 선언해야
/// 한다 — allowlist 소스 스캔 테스트가 미분류 라우트 추가를 막는다.
const FRONTEND_ROUTES: &[FrontendRoute] = &[
    FrontendRoute {
        method: Method::Post,
        path: "/agent/run-background",
        action: "agent.run-background",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/agent/launch-account",
        action: "agent.launch-account",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/agent/launch-preference",
        action: "agent.launch-preference",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/agents/unopened/visibility",
        action: "agents.unopened.visibility",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/browser/present",
        action: "browser.present",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/quick-commands",
        action: "quick-commands",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/spawn",
        action: "spawn",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/agent/reuse",
        action: "agent.reuse",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/agent/present",
        action: "agent.present",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    // Compatibility action for the first managed-input CLI release. Keep
    // the legacy action name so the frontend adapter can prefer sessionId
    // over a potentially ambiguous human name.
    FrontendRoute {
        method: Method::Post,
        path: "/agent/input",
        action: "agent.input",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/comment",
        action: "comment",
        waits_for_receipt: false,
        scope: RouteScope::Report,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/activity",
        action: "activity",
        waits_for_receipt: false,
        scope: RouteScope::Report,
        destructive: false,
    },
    // B2: provider 훅의 4상태 보고 — fire-and-forget, 검증은 프론트 핸들러.
    FrontendRoute {
        method: Method::Post,
        path: "/hooks",
        action: "hooks",
        waits_for_receipt: false,
        scope: RouteScope::Report,
        destructive: false,
    },
    // 실행 중인 앱에서 리로드 없이 워크스페이스 성능 리포트를 덤프한다
    // (qa.autorun+웹뷰 리로드 의존 제거 — bd 9c9). 읽기 전용이지만 데스크탑·
    // 세션 구성이 드러나므로 Control 스코프다.
    FrontendRoute {
        method: Method::Post,
        path: "/perf/report",
        action: "perf.report",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/diagnostics",
        action: "app.diagnostics",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/sessions/recent",
        action: "sessions.recent",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/worktree/presentation/export",
        action: "worktree.presentation.export",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/workspace/import/preview",
        action: "workspace.import.preview",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/workspace/import/status",
        action: "workspace.import.status",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/workspace/import/apply",
        action: "workspace.import.apply",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: true,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/workspace/open-external",
        action: "workspace.open-external",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/space/create",
        action: "space.create",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    // Deprecated compatibility alias for pre-Space clients.
    FrontendRoute {
        method: Method::Post,
        path: "/desktop/create",
        action: "desktop.create",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/pane/open",
        action: "pane.open",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/pane/create",
        action: "pane.create",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/space/activate",
        action: "space.activate",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    // Deprecated compatibility alias for pre-Space clients.
    FrontendRoute {
        method: Method::Post,
        path: "/desktop/activate",
        action: "desktop.activate",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/pane/close",
        action: "pane.close",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: true,
    },
    // Agent-operability surface: pane status and named pane actions resolve
    // through the exact UI handlers registered by the mounted pane.
    FrontendRoute {
        method: Method::Post,
        path: "/pane/state",
        action: "pane.state",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/pane/act",
        action: "pane.act",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/observe",
        action: "hmux.observe",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/attach",
        action: "hmux.attach",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/ssh/hosts/add",
        action: "ssh.host.add",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/project/add",
        action: "project.add",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/create",
        action: "hmux.create",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/upgrade",
        action: "hmux.upgrade",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/adopt",
        action: "hmux.adopt",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/rehost",
        action: "hmux.rehost",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/convert",
        action: "hmux.convert",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/stop",
        action: "hmux.stop",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: true,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/cleanup-exited",
        action: "hmux.cleanup-exited",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: true,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/input",
        action: "hmux.input",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
    FrontendRoute {
        method: Method::Post,
        path: "/hmux/remote-shell",
        action: "hmux.remote-shell",
        waits_for_receipt: true,
        scope: RouteScope::Control,
        destructive: false,
    },
];

fn frontend_route(method: &Method, url: &str) -> Option<&'static FrontendRoute> {
    FRONTEND_ROUTES
        .iter()
        .find(|route| route.method == *method && route.path == url)
}

fn frontend_window_label(params: &Value) -> Result<&str, ()> {
    match params.get("windowLabel") {
        None => Ok("main"),
        Some(Value::String(label))
            if !label.is_empty()
                && label.len() <= 128
                && label.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "-_".contains(character)
                }) =>
        {
            Ok(label)
        }
        Some(_) => Err(()),
    }
}

/// 테스트 편의 조회 — 라우트의 (action, waits_for_receipt) 쌍.
#[cfg(test)]
fn frontend_action(method: &Method, url: &str) -> Option<(&'static str, bool)> {
    frontend_route(method, url).map(|route| (route.action, route.waits_for_receipt))
}

/// 서버 루프가 직접 처리하는(프론트로 위임하지 않는) 라우트의 스코프 분류.
/// 새 직접 라우트는 여기 분류를 추가해야 소스 스캔 테스트를 통과한다.
fn required_scope(method: &Method, url: &str) -> Option<RouteScope> {
    if let Some(route) = frontend_route(method, url) {
        return Some(route.scope);
    }
    match (method, url) {
        (&Method::Get, "/ping") => Some(RouteScope::Report),
        (&Method::Post, "/transcript") => Some(RouteScope::Control),
        // Managed Claude command bridge — 서버가 fenced report를 Host에 직접
        // 적용한다. frontend/HMR 상태는 durable ingress의 전제조건이 아니다.
        (&Method::Post, "/hooks/claude") => Some(RouteScope::Report),
        // 배포 체인의 웹뷰 리로드 — 프론트 상태와 무관하게 backend가 직접
        // location.reload를 주입한다(스테일 번들/half-boot도 복구된다).
        (&Method::Post, "/webview/reload") => Some(RouteScope::Control),
        (&Method::Post, "/spawn/v2") => Some(RouteScope::Control),
        (&Method::Get, _) if url.starts_with("/spawn/") => Some(RouteScope::Control),
        // QA 라우트는 debug 빌드에만 존재하지만 분류는 항상 Control이다.
        (_, _) if url.starts_with("/qa/") => Some(RouteScope::Control),
        _ => None,
    }
}

#[tauri::command]
pub fn cli_request_claim(
    broker: State<'_, Arc<CliRequestBroker>>,
    req_id: String,
) -> Result<bool, String> {
    broker.claim(&req_id)
}

#[tauri::command]
pub fn cli_request_begin_decision(
    broker: State<'_, Arc<CliRequestBroker>>,
    req_id: String,
) -> Result<Option<u32>, String> {
    broker.begin_decision(&req_id)
}

#[tauri::command]
pub fn cli_request_complete(
    broker: State<'_, Arc<CliRequestBroker>>,
    req_id: String,
    result: Value,
) -> Result<(), String> {
    broker.complete(&req_id, result)
}

pub(crate) use crate::random_token::gen_token;

fn write_server_descriptor(
    dir: &Path,
    descriptor: &ServerDescriptor<'_>,
) -> std::io::Result<()> {
    let path = dir.join("server.json");
    let temporary_path = dir.join(format!(".server.json.{}.tmp", gen_token()?));
    let mut contents = serde_json::to_vec(descriptor).map_err(std::io::Error::other)?;
    contents.push(b'\n');
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(&contents)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            if path
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(std::io::Error::other(
                    "refusing to replace symlinked server descriptor",
                ));
            }
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary_path);
    }
    result
}

/// 앱 시작 시 호출. 서버 스레드를 띄우고 현재 앱 채널의 server.json에
/// 인증 descriptor를 기록해 같은 채널의 CLI가 찾을 수 있게 한다.
pub fn start(app: AppHandle, broker: Arc<CliRequestBroker>) {
    let app_channel = match crate::app_channel::current() {
        Ok(channel) => channel,
        Err(error) => {
            eprintln!("could not resolve Dure app channel: {error}");
            return;
        }
    };
    let token = match gen_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("could not generate Dure CLI server token: {error}");
            return;
        }
    };
    let report_token = match gen_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("could not generate Dure CLI report token: {error}");
            return;
        }
    };
    let generation = match gen_token() {
        Ok(generation) => generation,
        Err(error) => {
            eprintln!("could not generate Dure app generation: {error}");
            return;
        }
    };
    let started_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());

    // 6767부터 빈 포트를 찾는다
    let mut server = None;
    let mut port = 0u16;
    for p in 6767..6787 {
        if let Ok(s) = LocalApiListener::bind(p) {
            server = Some(s);
            port = p;
            break;
        }
    }
    let server = match server {
        Some(s) => s,
        None => return,
    };

    let descriptor = ServerDescriptor {
        schema_version: 1,
        api_version: CLI_API_VERSION,
        package_version: env!("CARGO_PKG_VERSION"),
        build_id: env!("DURE_BUILD_ID"),
        port,
        token: &token,
        report_token: &report_token,
        channel: &app_channel.name,
        generation: &generation,
        process_id: std::process::id(),
        started_at_unix_ms,
        capabilities: SERVER_CAPABILITIES,
    };
    if let Err(error) = write_server_descriptor(&app_channel.control_dir, &descriptor) {
        eprintln!("could not publish Dure CLI server descriptor: {error}");
        return;
    }
    let claude_publication = app
        .path()
        .resource_dir()
        .map_err(std::io::Error::other)
        .and_then(|resources| {
            crate::managed_hooks::publish_claude_settings(&app_channel.control_dir, &resources)
        });
    if let Err(error) = claude_publication {
        // Other providers and all control routes remain usable. Managed
        // Claude launch checks the private file and fails before spawning.
        eprintln!("could not publish managed Claude hook settings: {error}");
    }
    let native = crate::managed_hooks::publish_native_runtimes(&app, &app_channel.control_dir);
    if let Err(error) = crate::managed_hooks::publish_provider_runtime_integrations(
        &app_channel.name,
        &app_channel.control_dir,
        native,
    ) {
        // Provider launch adapters fail closed when this token-free contract is
        // absent. Control and report routes remain available.
        eprintln!("could not publish managed provider runtime integrations: {error}");
    }

    let channel = app_channel.name;
    let remote_shell_waiters = Arc::new(tokio::sync::Semaphore::new(8));
    std::thread::spawn(move || {
        // Report 라우트 rate limit — 폭주한 훅이 서버 스레드와 웹뷰 이벤트를
        // 도배하지 못하게 Rust 계층에서 자른다. 한도는 소켓·이벤트 채널
        // 보호용으로만 넉넉히 잡는다: N개 에이전트에 동시 프롬프트를 뿌리면
        // 훅당 /hooks+/activity 2건씩 버스트가 정상 동작이고, 훅은 실패를
        // 조용히 삼키므로 여기서 Stop 보고를 떨어뜨리면 stale working이
        // 남는다. 스토어 도배 방지는 프론트 핸들러의 더 좁은 한도(20/s)가
        // 맡는다. 서버 루프는 단일 스레드라 로컬 상태로 충분하다.
        const REPORT_RATE_WINDOW: Duration = Duration::from_secs(1);
        const REPORT_RATE_MAX: u32 = 60;
        let mut report_window_start = std::time::Instant::now();
        let mut report_window_count = 0u32;
        for mut req in server {
            let control_header = format!("Bearer {token}");
            let report_header = format!("Bearer {report_token}");
            let presented = req.headers().iter().find_map(|h| {
                if !h.field.equiv("Authorization") {
                    return None;
                }
                if h.value.as_str() == control_header {
                    Some(RouteScope::Control)
                } else if h.value.as_str() == report_header {
                    Some(RouteScope::Report)
                } else {
                    None
                }
            });
            let Some(presented) = presented else {
                let _ = req.respond(json_response(
                    401,
                    serde_json::json!({
                        "ok": false,
                        "error": { "code": "unauthorized", "message": "invalid bearer token" }
                    }),
                ));
                continue;
            };
            let url = req.url().to_string();
            let method = req.method().clone();

            match required_scope(&method, url.split('?').next().unwrap_or(&url)) {
                // fail-closed: 미분류 라우트는 어떤 핸들러에도 닿기 전에
                // 404다 — 분류 없이 추가된 직접 핸들러가 report 토큰으로
                // 열리는 사고를 소스 스캔 테스트에만 의존하지 않고 막는다.
                None => {
                    let _ = req.respond(json_response(
                        404,
                        serde_json::json!({
                            "ok": false,
                            "error": { "code": "not_found", "message": "route not found" }
                        }),
                    ));
                    continue;
                }
                Some(RouteScope::Control) if presented == RouteScope::Report => {
                    let _ = req.respond(json_response(
                        403,
                        serde_json::json!({
                            "ok": false,
                            "error": {
                                "code": "insufficient_scope",
                                "message": "this route requires the control token; the report token only covers reporting routes"
                            }
                        }),
                    ));
                    continue;
                }
                // 한도는 report "토큰"의 트래픽에만 적용한다 — 라우트 기준으로
                // 세면 report 폭주가 control 토큰의 /ping 생존 확인·/comment
                // 체크포인트까지 429로 굶긴다(QA 하네스는 ping 실패를 서버
                // 미기동으로 오판한다).
                Some(RouteScope::Report) if presented == RouteScope::Report => {
                    if report_window_start.elapsed() > REPORT_RATE_WINDOW {
                        report_window_start = std::time::Instant::now();
                        report_window_count = 0;
                    }
                    report_window_count += 1;
                    if report_window_count > REPORT_RATE_MAX {
                        let response = json_response(
                            429,
                            serde_json::json!({
                                "ok": false,
                                "error": {
                                    "code": "rate_limited",
                                    "message": "too many reporting requests; retry later"
                                }
                            }),
                        )
                        .with_header(
                            Header::from_bytes(&b"Retry-After"[..], &b"1"[..])
                                .expect("static response header is valid"),
                        );
                        let _ = req.respond(response);
                        continue;
                    }
                }
                // control 토큰은 한도 없이 통과(브로커 receipt 대기가 자연
                // backpressure) — report 라우트 포함.
                Some(_) => {}
            }

            if method == Method::Get && url == "/ping" {
                let _ = req.respond(json_response(
                    200,
                    serde_json::json!({
                        "ok": true,
                        "apiVersion": CLI_API_VERSION,
                        "packageVersion": env!("CARGO_PKG_VERSION"),
                        "buildId": env!("DURE_BUILD_ID"),
                        "channel": channel.as_str(),
                        "generation": generation.as_str(),
                        "processId": std::process::id(),
                        "startedAtUnixMs": started_at_unix_ms,
                        "capabilities": SERVER_CAPABILITIES,
                    }),
                ));
                continue;
            }

            if method == Method::Post && url == "/transcript" {
                let body = match read_json_body(&mut req) {
                    Ok(body) => body,
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "invalid_request", "message": error }
                            }),
                        ));
                        continue;
                    }
                };
                let provider = body.get("provider").and_then(Value::as_str);
                let conversation_id = body.get("conversationId").and_then(Value::as_str);
                let response = match (provider, conversation_id) {
                    (Some(provider), Some(conversation_id)) => {
                        match crate::conv::transcript_global(provider, conversation_id) {
                            Ok(transcript) => json_response(
                                200,
                                serde_json::json!({ "ok": true, "transcript": transcript }),
                            ),
                            Err(error) => json_response(
                                409,
                                serde_json::json!({
                                    "ok": false,
                                    "error": {
                                        "code": "provider_transcript_unavailable",
                                        "message": error
                                    }
                                }),
                            ),
                        }
                    }
                    _ => json_response(
                        400,
                        serde_json::json!({
                            "ok": false,
                            "error": {
                                "code": "invalid_request",
                                "message": "provider and conversationId are required"
                            }
                        }),
                    ),
                };
                let _ = req.respond(response);
                continue;
            }

            // Managed Claude command hook — exact channel/generation을 ping으로
            // 확인한 bridge만 들어오며, backend가 WebView 없이 Host에 직접
            // 적용한다. 성공 후 prompt text projection만 frontend에 best-effort.
            if method == Method::Post && url == "/hooks/claude" {
                let body = match read_json_body(&mut req) {
                    Ok(body) => body,
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "invalid_request", "message": error }
                            }),
                        ));
                        continue;
                    }
                };
                let report = match normalize_claude_hook_report(&req, body) {
                    Ok(Some(report)) => report,
                    Ok(None) => {
                        let _ = req.respond(json_response(200, serde_json::json!({})));
                        continue;
                    }
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "invalid_hook_report", "message": error }
                            }),
                        ));
                        continue;
                    }
                };
                let presentation = report.presentation;
                let (status, value) =
                    dispatch_claude_hook_request(&app, report.host_request, report.transcript_path);
                if (200..300).contains(&status) {
                    emit_claude_activity_projection(&app, &presentation);
                    let _ = req.respond(json_response(status, serde_json::json!({})));
                } else {
                    let _ = req.respond(json_response(status, value));
                }
                continue;
            }

            // 배포 체인의 웹뷰 리로드 — 재기동 직후 웹뷰가 옛 번들(캐시·
            // 재시작 경합)로 붙는 version-skew를 backend에서 직접 푼다.
            // eval 주입이라 프론트가 half-boot 상태여도 동작한다.
            if method == Method::Post && url == "/webview/reload" {
                let mut reloaded: Vec<String> = Vec::new();
                for (label, window) in app.webview_windows() {
                    if window.eval("window.location.reload()").is_ok() {
                        reloaded.push(label);
                    }
                }
                let _ = req.respond(json_response(
                    200,
                    serde_json::json!({ "ok": true, "reloaded": reloaded }),
                ));
                continue;
            }

            // Spawn saga 조회 — 디스크 직독이라 webview 생존과 무관하게 동작한다.
            if method == Method::Get && url.starts_with("/spawn/") {
                let rest = &url["/spawn/".len()..];
                let response = if let Some(id) = rest.strip_suffix("/journal") {
                    match crate::spawn::journal_for_server(id) {
                        Ok(raw) => Response::from_data(raw.into_bytes())
                            .with_status_code(200)
                            .with_header(
                                Header::from_bytes(&b"Content-Type"[..], &b"application/jsonl"[..])
                                    .expect("static response header is valid"),
                            ),
                        Err(error) => json_response(
                            404,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "not_found", "message": error }
                            }),
                        ),
                    }
                } else {
                    match crate::spawn::receipt_for_server(rest) {
                        Ok(receipt) => json_response(
                            200,
                            serde_json::json!({ "ok": true, "receipt": receipt }),
                        ),
                        Err(error) => json_response(
                            404,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "not_found", "message": error }
                            }),
                        ),
                    }
                };
                let _ = req.respond(response);
                continue;
            }

            // POST /spawn/v2 — saga를 journal에 먼저 만들고(또는 재개 대상을 확인하고)
            // 실행은 프론트 오케스트레이터에 위임한다. 응답은 202 {receiptId} 즉시.
            if method == Method::Post && url == "/spawn/v2" {
                let params = match read_json_body(&mut req) {
                    Ok(params) => params,
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "invalid_request", "message": error }
                            }),
                        ));
                        continue;
                    }
                };
                let resume_id = params
                    .get("receiptId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let receipt_id = if let Some(id) = resume_id {
                    // 명시적 재개: 기존 receipt가 있어야 하고, terminal이면 재개 불가
                    match crate::spawn::receipt_for_server(&id) {
                        Ok(receipt) => {
                            let state = receipt
                                .get("state")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if state == "succeeded" || state == "compensated" {
                                let _ = req.respond(json_response(
                                    409,
                                    serde_json::json!({
                                        "ok": false,
                                        "error": {
                                            "code": "saga_terminal",
                                            "message": format!("saga is already {state}")
                                        },
                                        "receipt": receipt
                                    }),
                                ));
                                continue;
                            }
                            id
                        }
                        Err(error) => {
                            let _ = req.respond(json_response(
                                404,
                                serde_json::json!({
                                    "ok": false,
                                    "error": { "code": "not_found", "message": error }
                                }),
                            ));
                            continue;
                        }
                    }
                } else {
                    let idempotency_key = params
                        .get("idempotencyKey")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    match crate::spawn::spawn_saga_create(params.clone(), idempotency_key) {
                        Ok(created) => {
                            if created["existing"] == Value::Bool(true) {
                                // 같은 idempotencyKey — 기존 saga를 중복 실행하지 않는다
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({
                                        "ok": true,
                                        "existing": true,
                                        "receiptId": created["receiptId"],
                                        "receipt": created["receipt"]
                                    }),
                                ));
                                continue;
                            }
                            created
                                .get("receiptId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string()
                        }
                        Err(error) => {
                            let _ = req.respond(json_response(
                                500,
                                serde_json::json!({
                                    "ok": false,
                                    "error": { "code": "journal_unavailable", "message": error }
                                }),
                            ));
                            continue;
                        }
                    }
                };
                let Some(window) = app.get_webview_window("main") else {
                    // journal은 남아 있으므로 나중에 receiptId로 재개 가능하다
                    let _ = req.respond(json_response(
                        503,
                        serde_json::json!({
                            "ok": false,
                            "receiptId": receipt_id,
                            "error": {
                                "code": "frontend_unavailable",
                                "message": "Dure window is unavailable; resume later with receiptId"
                            }
                        }),
                    ));
                    continue;
                };
                let mut forwarded = params.clone();
                if let Some(object) = forwarded.as_object_mut() {
                    object.insert("receiptId".into(), serde_json::json!(receipt_id));
                }
                let req_id = receipt_id.clone();
                if let Err(error) = window.emit(
                    "cli:request",
                    serde_json::json!({
                        "reqId": req_id,
                        "action": "spawn.v2",
                        "params": forwarded
                    }),
                ) {
                    let _ = req.respond(json_response(
                        503,
                        serde_json::json!({
                            "ok": false,
                            "receiptId": receipt_id,
                            "error": {
                                "code": "frontend_unavailable",
                                "message": format!(
                                    "could not deliver spawn to frontend: {error}; resume later with receiptId"
                                )
                            }
                        }),
                    ));
                    continue;
                }
                let _ = req.respond(json_response(
                    202,
                    serde_json::json!({ "ok": true, "receiptId": receipt_id }),
                ));
                continue;
            }

            #[cfg(debug_assertions)]
            if let Some(response) = handle_qa_request(&app, &method, &url, &mut req) {
                let (status, value) = match response {
                    Ok(value) => (200, value),
                    Err(error) => (
                        409,
                        serde_json::json!({
                            "ok": false,
                            "error": { "code": "qa_request_failed", "message": error }
                        }),
                    ),
                };
                let _ = req.respond(json_response(status, value));
                continue;
            }

            // POST actions are handled by the frontend, where DockView and the
            // application store live.
            // (/spawn = 에이전트 생성, /comment = 체크포인트 갱신,
            //  /activity = herdr식 훅이 보고하는 "지금 하는 작업")
            if let Some(route) = frontend_route(&method, &url) {
                let (action, waits_for_receipt) = (route.action, route.waits_for_receipt);
                let remote_shell_permit = if action == "hmux.remote-shell" {
                    match remote_shell_waiters.clone().try_acquire_owned() {
                        Ok(permit) => Some(permit),
                        Err(_) => {
                            let _ = req.respond(json_response(503, serde_json::json!({
                                "ok": false, "fallback": true
                            })));
                            continue;
                        }
                    }
                } else {
                    None
                };
                let params = match read_json_body(&mut req) {
                    Ok(params) => params,
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": { "code": "invalid_request", "message": error }
                            }),
                        ));
                        continue;
                    }
                };
                if route.destructive
                    && params.get("confirm").and_then(Value::as_bool) != Some(true)
                {
                    let _ = req.respond(json_response(
                        428,
                        serde_json::json!({
                            "ok": false,
                            "error": {
                                "code": "confirmation_required",
                                "message": format!(
                                    "{url} is destructive; pass \"confirm\": true to proceed"
                                )
                            }
                        }),
                    ));
                    continue;
                }
                let replayable_request = match replayable_frontend_request(action, &params) {
                    Ok(request) => request,
                    Err(error) => {
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": {
                                    "code": "invalid_request",
                                    "message": error
                                }
                            }),
                        ));
                        continue;
                    }
                };
                let replayable = replayable_request.is_some();
                let req_id = match replayable_request.as_ref() {
                    Some((request_id, _)) => request_id.clone(),
                    None => match gen_token() {
                        Ok(request_id) => request_id,
                        Err(error) => {
                            let _ = req.respond(json_response(
                                500,
                                serde_json::json!({
                                    "ok": false,
                                    "error": {
                                        "code": "request_id_unavailable",
                                        "message": format!("could not generate request id: {error}")
                                    }
                                }),
                            ));
                            continue;
                        }
                    },
                };
                let (receiver, dispatch) = if waits_for_receipt {
                    let registration = match replayable_request {
                        Some((_, identity)) => {
                            broker.register_with_identity(req_id.clone(), Some(identity))
                        }
                        None if action == "hmux.remote-shell" => {
                            broker.register_remote_shell(req_id.clone())
                        }
                        None => broker.register(req_id.clone()).map(|receiver| {
                            CliRequestRegistration {
                                receiver,
                                dispatch: true,
                            }
                        }),
                    };
                    match registration {
                        Ok(registration) => (Some(registration.receiver), registration.dispatch),
                        Err(error) => {
                            let conflict =
                                error == CliRequestRegistrationError::IdentityConflict;
                            let _ = req.respond(json_response(
                                if conflict { 409 } else { 500 },
                                serde_json::json!({
                                    "ok": false,
                                    "error": {
                                        "code": if conflict {
                                            "idempotency_conflict"
                                        } else {
                                            "broker_unavailable"
                                        },
                                        "message": error.to_string()
                                    }
                                }),
                            ));
                            continue;
                        }
                    }
                } else {
                    (None, true)
                };
                // Every frontend route uses the same explicit WebView target.
                // Keeping a second action allowlist here made valid targets
                // silently fall back to `main` when a route was omitted.
                let window_label = match frontend_window_label(&params) {
                    Ok(label) => label,
                    Err(()) => {
                        broker.cancel(&req_id);
                        let _ = req.respond(json_response(
                            400,
                            serde_json::json!({
                                "ok": false,
                                "error": {
                                    "code": "invalid_request",
                                    "message": "windowLabel is invalid"
                                }
                            }),
                        ));
                        continue;
                    }
                };
                if dispatch {
                    let Some(layout_coordinator) = app.get_webview_window(window_label) else {
                        broker.cancel(&req_id);
                        let _ = req.respond(json_response(
                            503,
                            serde_json::json!({
                                "ok": false,
                                "error": {
                                    "code": "frontend_unavailable",
                                    "message": format!(
                                        "Dure window {window_label} is unavailable"
                                    )
                                }
                            }),
                        ));
                        continue;
                    };
                    if let Err(error) = layout_coordinator.emit(
                        "cli:request",
                        serde_json::json!({
                            "reqId": req_id,
                            "action": action,
                            "params": params
                        }),
                    ) {
                        broker.cancel(&req_id);
                        let _ = req.respond(json_response(
                            500,
                            serde_json::json!({
                                "ok": false,
                                "error": {
                                    "code": "frontend_unavailable",
                                    "message": format!(
                                        "could not deliver request to Dure frontend: {error}"
                                    )
                                }
                            }),
                        ));
                        continue;
                    }
                }
                if let Some(receiver) = receiver {
                    if let Some(permit) = remote_shell_permit {
                        if let Err(error) = dispatch_remote_shell_receipt(
                            req,
                            broker.clone(),
                            req_id.clone(),
                            receiver,
                            permit,
                        ) {
                            broker.cancel(&req_id);
                            eprintln!("could not start remote shell receipt worker: {error}");
                        }
                    } else {
                        let response = wait_for_frontend_receipt(
                            &broker,
                            &req_id,
                            action,
                            replayable,
                            receiver,
                        );
                        let _ = req.respond(response);
                    }
                } else {
                    let _ = req.respond(json_response(
                        202,
                        serde_json::json!({ "accepted": true, "reqId": req_id }),
                    ));
                }
                continue;
            }

            let _ = req.respond(json_response(
                404,
                serde_json::json!({
                    "ok": false,
                    "error": { "code": "not_found", "message": "route not found" }
                }),
            ));
        }
    });
}

#[cfg(debug_assertions)]
fn handle_qa_request(
    app: &AppHandle,
    method: &Method,
    url: &str,
    req: &mut tiny_http::Request,
) -> Option<Result<Value, String>> {
    use crate::qa::{
        TerminalResizeScreenModel, WindowFocusProfile, WindowFocusQa, WindowPresentation,
        WindowRole, WindowSize,
    };

    let state = app.state::<WindowFocusQa>();
    match (method, url.split('?').next().unwrap_or(url)) {
        (&Method::Post, "/qa/hmux/runtime/prepare") => {
            Some(state.prepare_runtime(app))
        }
        (&Method::Get, "/qa/hmux/window-focus/controller-ready") => {
            Some(state.controller_page_status(app))
        }
        (&Method::Post, "/qa/hmux/window-focus/start") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let profile = body
                    .get("profile")
                    .cloned()
                    .map(serde_json::from_value::<WindowFocusProfile>)
                    .transpose()
                    .map_err(|_| {
                        "start profile must be smoke, background, soak, scrollback, large_view, or external_input"
                            .to_string()
                    })?
                    .unwrap_or_default();
                let provider = body
                    .get("provider")
                    .map(|provider| {
                        provider
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| "start provider must be a string".to_string())
                    })
                    .transpose()?;
                let screen_model = body
                    .get("screenModel")
                    .cloned()
                    .map(serde_json::from_value::<TerminalResizeScreenModel>)
                    .transpose()
                    .map_err(|_| {
                        "start screenModel must be alternate or normal".to_string()
                    })?;
                let proof = body
                    .get("proof")
                    .map(|proof| {
                        proof
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| "start proof must be a string".to_string())
                    })
                    .transpose()?;
                state.start(app, profile, proof, provider, screen_model)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/abort") => Some(state.abort_active(app)),
        (&Method::Get, "/qa/hmux/window-focus/status") => {
            let proof = query_parameter(url, "proof")
                .ok_or_else(|| "status requires a proof query parameter".to_string());
            Some(proof.and_then(|proof| state.status(app, proof)))
        }
        (&Method::Get, "/qa/hmux/window-focus/snapshot") => {
            let proof = query_parameter(url, "proof")
                .ok_or_else(|| "snapshot requires a proof query parameter".to_string());
            Some(proof.and_then(|proof| state.snapshot_evidence(app, proof)))
        }
        (&Method::Post, "/qa/hmux/window-focus/step") => {
            Some(window_focus_qa::step(app, req))
        }
        (&Method::Post, "/qa/hmux/window-focus/scroll-rows") => {
            Some(window_focus_qa::scroll_rows(app, req))
        }
        (&Method::Post, "/qa/hmux/window-focus/focus") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "focus requires proof".to_string())?;
                let role = serde_json::from_value::<WindowRole>(
                    body.get("window")
                        .cloned()
                        .ok_or_else(|| "focus requires window".to_string())?,
                )
                .map_err(|_| "focus window must be a or b".to_string())?;
                state.focus(app, proof, role)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/release-control") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "controller release requires proof".to_string())?;
                let role = serde_json::from_value::<WindowRole>(
                    body.get("window")
                        .cloned()
                        .ok_or_else(|| "controller release requires window".to_string())?,
                )
                .map_err(|_| "controller release window must be a or b".to_string())?;
                state.release_control(app, proof, role)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/inject") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "inject requires proof".to_string())?;
                state.inject(app, proof)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/presentation") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "presentation requires proof".to_string())?;
                let presentation = serde_json::from_value::<WindowPresentation>(
                    body.get("presentation")
                        .cloned()
                        .ok_or_else(|| "presentation requires a state".to_string())?,
                )
                .map_err(|_| {
                    "presentation state must be visible, minimized, or hidden".to_string()
                })?;
                state.set_presentation(app, proof, presentation)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/resize") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "resize requires proof".to_string())?;
                let role = serde_json::from_value::<WindowRole>(
                    body.get("window")
                        .cloned()
                        .ok_or_else(|| "resize requires window".to_string())?,
                )
                .map_err(|_| "resize window must be a or b".to_string())?;
                let size = serde_json::from_value::<WindowSize>(
                    body.get("size")
                        .cloned()
                        .ok_or_else(|| "resize requires size".to_string())?,
                )
                .map_err(|_| "resize size must be compact or wide".to_string())?;
                state.resize_window(app, proof, role, size)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/close") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "close requires proof".to_string())?;
                let role = serde_json::from_value::<WindowRole>(
                    body.get("window")
                        .cloned()
                        .ok_or_else(|| "close requires window".to_string())?,
                )
                .map_err(|_| "close window must be a or b".to_string())?;
                state.close_window(app, proof, role)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/open-large-view") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "large-view open requires proof".to_string())?;
                state.open_large_view_window(app, proof)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/resize-render/activate") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "resize render activation requires proof".to_string())?;
                state.activate_resize_render(app, proof)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/restart") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "restart requires proof".to_string())?;
                let role = serde_json::from_value::<WindowRole>(
                    body.get("window")
                        .cloned()
                        .ok_or_else(|| "restart requires window".to_string())?,
                )
                .map_err(|_| "restart window must be a or b".to_string())?;
                state.restart_webview(app, proof, role)
            }))
        }
        (&Method::Post, "/qa/hmux/window-focus/finish") => {
            let body = read_json_body(req);
            Some(body.and_then(|body| {
                let proof = body
                    .get("proof")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "finish requires proof".to_string())?;
                state.finish(app, proof)
            }))
        }
        _ => None,
    }
}

#[cfg(debug_assertions)]
fn query_parameter<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    url.split_once('?')?.1.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name && !value.is_empty()).then_some(value)
    })
}

fn read_json_body(req: &mut tiny_http::Request) -> Result<Value, String> {
    let mut body = Vec::new();
    req.as_reader()
        .take(MAX_REQUEST_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("could not read request body: {error}"))?;
    if body.len() as u64 > MAX_REQUEST_BODY_BYTES {
        return Err("request body exceeds 64 KiB".into());
    }
    serde_json::from_slice(&body)
        .map_err(|error| format!("request body is not valid JSON: {error}"))
}

fn request_header(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 256)
}

fn normalize_claude_hook_report(
    req: &tiny_http::Request,
    input: Value,
) -> Result<Option<managed_claude::ClaudeHookReport>, String> {
    normalize_claude_hook_report_with(input, |name| request_header(req, name))
}

fn normalize_claude_hook_report_with(
    input: Value,
    header: impl FnMut(&str) -> Option<String>,
) -> Result<Option<managed_claude::ClaudeHookReport>, String> {
    managed_claude::normalize_hook_report(input, header)
}

fn emit_claude_activity_projection(app: &AppHandle, presentation: &Value) {
    if presentation.get("event").and_then(Value::as_str) != Some("UserPromptSubmit")
        || presentation.get("text").and_then(Value::as_str).is_none()
    {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(req_id) = gen_token() else {
        return;
    };
    let _ = window.emit(
        "cli:request",
        serde_json::json!({
            "reqId": req_id,
            "action": "activity",
            "params": presentation,
        }),
    );
}

fn dispatch_claude_hook_request(
    app: &AppHandle,
    request: crate::hmux::AgentStateReportRequest,
    transcript_path: Option<std::path::PathBuf>,
) -> (u16, Value) {
    let hmux = {
        let state = app.state::<crate::AppState>();
        Arc::clone(&state.hmux)
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let dispatch_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = sender.send(hmux.report_claude_agent_state(
            &dispatch_app,
            request,
            transcript_path.as_deref(),
        ));
    });
    match receiver.recv_timeout(Duration::from_millis(1500)) {
        Ok(Ok(receipt)) => {
            // dev 관측성 — 훅 ingress가 Host까지 닿았는지 콘솔로 확인 가능.
            #[cfg(debug_assertions)]
            eprintln!("managed Claude hook applied: outcome={}", receipt.outcome);
            (200, serde_json::json!({ "ok": true, "outcome": receipt.outcome }))
        }
        Ok(Err(failure)) => (
            502,
            serde_json::json!({
                "ok": false,
                "error": { "code": failure.code, "message": failure.message }
            }),
        ),
        Err(_) => (
            202,
            serde_json::json!({ "ok": true, "accepted": true }),
        ),
    }
}

fn json_response(status: u16, value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()))
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static response header is valid"),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_delivers_one_correlated_result() {
        let broker = CliRequestBroker::default();
        let receiver = broker.register("request-1".into()).unwrap();

        assert!(broker.claim("request-1").unwrap());
        broker
            .complete("request-1", serde_json::json!({ "ok": true }))
            .unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(50)).unwrap()["ok"],
            true
        );
        assert!(broker.complete("request-1", Value::Null).is_err());
    }

    #[test]
    fn replayable_input_claims_once_and_replays_one_late_completion() {
        let broker = CliRequestBroker::default();
        let identity = serde_json::json!({
            "action": "hmux.input",
            "params": {
                "name": "session-1",
                "text": "status",
                "enter": true,
                "idempotencyKey": "send-1"
            }
        });
        let first = broker
            .register_with_identity("input_send-1".into(), Some(identity.clone()))
            .unwrap();
        assert!(first.dispatch);
        assert!(broker.claim("input_send-1").unwrap());
        drop(first.receiver);

        let retry = broker
            .register_with_identity("input_send-1".into(), Some(identity.clone()))
            .unwrap();
        assert!(!retry.dispatch);
        assert!(!broker.claim("input_send-1").unwrap());
        let result = serde_json::json!({
            "ok": true,
            "input": { "receipt": { "requestId": "controller-input-1" } }
        });
        broker.complete("input_send-1", result.clone()).unwrap();
        assert_eq!(retry.receiver.recv().unwrap(), result);

        let completed_retry = broker
            .register_with_identity("input_send-1".into(), Some(identity))
            .unwrap();
        assert!(!completed_retry.dispatch);
        assert_eq!(completed_retry.receiver.recv().unwrap(), result);
        assert!(!broker.claim("input_send-1").unwrap());
    }

    #[test]
    fn replayable_input_keeps_late_completion_after_all_callers_disconnect() {
        let broker = CliRequestBroker::default();
        let identity = serde_json::json!({
            "action": "hmux.input",
            "params": {
                "name": "session-1",
                "text": "status",
                "enter": true,
                "idempotencyKey": "send-after-disconnect"
            }
        });
        let first = broker
            .register_with_identity(
                "input_send-after-disconnect".into(),
                Some(identity.clone()),
            )
            .unwrap();
        assert!(broker.claim("input_send-after-disconnect").unwrap());
        drop(first.receiver);

        let result = serde_json::json!({
            "ok": true,
            "input": { "receipt": { "requestId": "controller-input-late" } }
        });
        broker
            .complete("input_send-after-disconnect", result.clone())
            .unwrap();

        let retry = broker
            .register_with_identity("input_send-after-disconnect".into(), Some(identity))
            .unwrap();
        assert!(!retry.dispatch);
        assert_eq!(retry.receiver.recv().unwrap(), result);
    }

    #[test]
    fn replayable_input_rejects_idempotency_identity_conflicts() {
        let broker = CliRequestBroker::default();
        let first = serde_json::json!({ "text": "first" });
        let second = serde_json::json!({ "text": "second" });

        broker
            .register_with_identity("input_send-1".into(), Some(first))
            .unwrap();
        assert!(broker
            .register_with_identity("input_send-1".into(), Some(second))
            .is_err());
    }

    #[test]
    fn input_idempotency_key_is_validated_and_correlated() {
        let params = serde_json::json!({
            "name": "session-1",
            "text": "status",
            "idempotencyKey": "8d42e80a-7b15-4ef6-a624-5d58f6d5d463"
        });
        let (request_id, identity) = replayable_frontend_request("hmux.input", &params)
            .unwrap()
            .unwrap();

        assert_eq!(
            request_id,
            "input_8d42e80a-7b15-4ef6-a624-5d58f6d5d463"
        );
        assert_eq!(identity["action"], "hmux.input");
        assert_eq!(identity["params"], params);
        let reuse = serde_json::json!({
            "project": "Dure",
            "name": "cleaner",
            "idempotencyKey": "reuse-cleaner-1"
        });
        let (request_id, identity) = replayable_frontend_request("agent.reuse", &reuse)
            .unwrap()
            .unwrap();
        assert_eq!(request_id, "agent_reuse_reuse-cleaner-1");
        assert_eq!(identity["action"], "agent.reuse");
        assert_eq!(identity["params"], reuse);
        assert!(replayable_frontend_request(
            "hmux.input",
            &serde_json::json!({ "idempotencyKey": "bad key" })
        )
        .is_err());
        assert!(replayable_frontend_request("hmux.input", &Value::Null)
            .unwrap()
            .is_none());
    }

    #[test]
    fn standalone_attach_is_a_correlated_frontend_action() {
        assert_eq!(
            frontend_action(&Method::Post, "/space/activate"),
            Some(("space.activate", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/desktop/activate"),
            Some(("desktop.activate", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/desktop/activate"), None);
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/attach"),
            Some(("hmux.attach", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/hmux/attach"), None);
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/upgrade"),
            Some(("hmux.upgrade", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/adopt"),
            Some(("hmux.adopt", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/rehost"),
            Some(("hmux.rehost", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/convert"),
            Some(("hmux.convert", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/stop"),
            Some(("hmux.stop", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/cleanup-exited"),
            Some(("hmux.cleanup-exited", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/input"),
            Some(("hmux.input", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/hmux/remote-shell"),
            Some(("hmux.remote-shell", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/hmux/input"), None);
        assert_eq!(frontend_action(&Method::Get, "/hmux/remote-shell"), None);
    }

    #[test]
    fn managed_rehost_keeps_its_claim_through_inspection_and_replacement() {
        assert_eq!(
            claimed_request_timeout("hmux.rehost"),
            HMUX_REHOST_CLAIMED_REQUEST_TIMEOUT
        );
        assert!(claimed_request_timeout("hmux.rehost") > REQUEST_TIMEOUT);
    }

    #[test]
    fn agent_presentations_keep_their_claim_through_pane_acknowledgement() {
        assert_eq!(
            claimed_request_timeout("hmux.attach"),
            PANE_OPERATION_CLAIMED_REQUEST_TIMEOUT
        );
        assert_eq!(
            claimed_request_timeout("agent.present"),
            PANE_OPERATION_CLAIMED_REQUEST_TIMEOUT
        );
        assert!(claimed_request_timeout("hmux.attach") > Duration::from_secs(10));
    }

    #[test]
    fn pane_actions_keep_their_claim_through_runtime_transitions() {
        assert_eq!(
            claimed_request_timeout("pane.act"),
            PANE_OPERATION_CLAIMED_REQUEST_TIMEOUT
        );
    }

    #[test]
    fn pane_close_is_a_correlated_frontend_action() {
        assert_eq!(
            frontend_action(&Method::Post, "/pane/close"),
            Some(("pane.close", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/pane/close"), None);
    }

    #[test]
    fn ssh_host_add_uses_authenticated_correlated_app_control() {
        assert_eq!(
            frontend_action(&Method::Post, "/ssh/hosts/add"),
            Some(("ssh.host.add", true))
        );
        assert_eq!(
            required_scope(&Method::Post, "/ssh/hosts/add"),
            Some(RouteScope::Control)
        );
        assert_eq!(frontend_action(&Method::Get, "/ssh/hosts/add"), None);
    }

    #[test]
    fn project_add_uses_authenticated_correlated_app_control() {
        assert_eq!(
            frontend_action(&Method::Post, "/project/add"),
            Some(("project.add", true))
        );
        assert_eq!(
            required_scope(&Method::Post, "/project/add"),
            Some(RouteScope::Control)
        );
        assert_eq!(frontend_action(&Method::Get, "/project/add"), None);
    }

    #[test]
    fn unopened_visibility_is_correlated_non_destructive_app_control() {
        let route = frontend_route(&Method::Post, "/agents/unopened/visibility").unwrap();
        assert_eq!(route.action, "agents.unopened.visibility");
        assert!(route.waits_for_receipt);
        assert_eq!(route.scope, RouteScope::Control);
        assert!(!route.destructive);
        assert_eq!(frontend_action(&Method::Get, "/agents/unopened/visibility"), None);
        assert!(SERVER_CAPABILITIES.contains(&"unopened_agents.visibility_v1"));
    }

    #[test]
    fn frontend_routes_share_one_explicit_window_target_contract() {
        assert_eq!(frontend_window_label(&serde_json::json!({})), Ok("main"));
        assert_eq!(
            frontend_window_label(&serde_json::json!({ "windowLabel": "win-100-2" })),
            Ok("win-100-2")
        );
        assert_eq!(
            frontend_window_label(&serde_json::json!({ "windowLabel": 2 })),
            Err(())
        );
    }

    #[test]
    fn external_workspace_open_is_a_correlated_frontend_action() {
        assert_eq!(
            frontend_action(&Method::Post, "/workspace/open-external"),
            Some(("workspace.open-external", true))
        );
        assert_eq!(
            frontend_action(&Method::Get, "/workspace/open-external"),
            None
        );
    }

    #[test]
    fn space_create_and_legacy_desktop_alias_are_correlated_frontend_actions() {
        assert_eq!(
            frontend_action(&Method::Post, "/space/create"),
            Some(("space.create", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/desktop/create"),
            Some(("desktop.create", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/desktop/create"), None);
    }

    #[test]
    fn workspace_import_routes_are_correlated_and_apply_is_confirmed() {
        assert_eq!(
            frontend_action(&Method::Post, "/sessions/recent"),
            Some(("sessions.recent", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/workspace/import/preview"),
            Some(("workspace.import.preview", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/workspace/import/status"),
            Some(("workspace.import.status", true))
        );
        assert_eq!(
            frontend_action(&Method::Post, "/workspace/import/apply"),
            Some(("workspace.import.apply", true))
        );
    }

    #[test]
    fn agent_input_is_a_correlated_frontend_action() {
        // Input delivery waits for the frontend receipt because the app owns
        // the managed session's typed terminal-surface command path.
        assert_eq!(
            frontend_action(&Method::Post, "/agent/input"),
            Some(("agent.input", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/agent/input"), None);
        assert_eq!(
            frontend_action(&Method::Post, "/agent/reuse"),
            Some(("agent.reuse", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/agent/reuse"), None);
        assert_eq!(
            frontend_action(&Method::Post, "/agent/present"),
            Some(("agent.present", true))
        );
        assert_eq!(frontend_action(&Method::Get, "/agent/present"), None);
    }

    #[test]
    fn spawn_waits_for_a_preflight_receipt() {
        assert_eq!(
            frontend_action(&Method::Post, "/spawn"),
            Some(("spawn", true))
        );
    }

    #[test]
    fn duplicate_registration_does_not_replace_original_request() {
        let broker = CliRequestBroker::default();
        let original = broker.register("request-1".into()).unwrap();

        assert!(broker.register("request-1".into()).is_err());
        assert!(broker.claim("request-1").unwrap());
        broker
            .complete("request-1", serde_json::json!({ "ok": true }))
            .unwrap();
        assert_eq!(
            original.recv_timeout(Duration::from_millis(50)).unwrap()["ok"],
            true
        );
    }

    #[test]
    fn canceled_request_cannot_be_claimed_or_completed() {
        let broker = CliRequestBroker::default();
        let _receiver = broker.register("request-1".into()).unwrap();

        assert!(matches!(
            broker.after_timeout("request-1").unwrap(),
            request_broker::RequestWait::Unclaimed
        ));
        assert!(!broker.claim("request-1").unwrap());
        assert!(broker.complete("request-1", Value::Null).is_err());
    }

    #[test]
    fn claimed_request_cannot_be_canceled_as_pending() {
        let broker = CliRequestBroker::default();
        let receiver = broker.register("request-1".into()).unwrap();

        assert!(broker.claim("request-1").unwrap());
        assert!(matches!(
            broker.after_timeout("request-1").unwrap(),
            request_broker::RequestWait::Claimed(_)
        ));
        broker
            .complete("request-1", serde_json::json!({ "ok": true }))
            .unwrap();
        assert_eq!(receiver.recv().unwrap()["ok"], true);
    }

    #[test]
    fn unclaimed_completion_preserves_request_for_a_later_claim() {
        let broker = CliRequestBroker::default();
        let receiver = broker.register("request-1".into()).unwrap();

        assert!(broker.complete("request-1", Value::Null).is_err());
        assert!(broker.claim("request-1").unwrap());
        broker
            .complete("request-1", serde_json::json!({ "ok": true }))
            .unwrap();
        assert_eq!(receiver.recv().unwrap()["ok"], true);
    }

    #[test]
    fn route_table_classifications_hold() {
        // (method, path)와 action은 유일해야 한다 — 중복은 조용한 섀도잉이다.
        let mut seen_paths = std::collections::HashSet::new();
        let mut seen_actions = std::collections::HashSet::new();
        for route in FRONTEND_ROUTES {
            assert!(
                seen_paths.insert((format!("{:?}", route.method), route.path)),
                "duplicate route path: {}",
                route.path
            );
            assert!(
                seen_actions.insert(route.action),
                "duplicate route action: {}",
                route.action
            );
            // Report 라우트는 fire-and-forget이어야 한다 — receipt 대기 경로가
            // report 토큰으로 열리면 스코프 경계가 무의미해진다.
            if route.scope == RouteScope::Report {
                assert!(
                    !route.waits_for_receipt,
                    "report-scope route must be fire-and-forget: {}",
                    route.path
                );
                assert!(
                    !route.destructive,
                    "report-scope route cannot be destructive: {}",
                    route.path
                );
            }
        }
        // 파괴적 라우트 목록은 의도적으로 명시한다 — 여기 추가하려면 confirm
        // 게이트와 CLI 프롬프트를 함께 갖춰야 한다.
        let destructive: Vec<&str> = FRONTEND_ROUTES
            .iter()
            .filter(|route| route.destructive)
            .map(|route| route.path)
            .collect();
        assert_eq!(
            destructive,
            [
                "/workspace/import/apply",
                "/pane/close",
                "/hmux/stop",
                "/hmux/cleanup-exited"
            ]
        );
    }

    fn native_claude_hook_headers() -> std::collections::HashMap<&'static str, &'static str> {
        std::collections::HashMap::from([
            ("X-Hebbian-Hmux-Session-Id", "managed-1"),
            ("X-Hebbian-Hmux-Workspace-Id", "workspace-1"),
            ("X-Hebbian-Hmux-Runner-Principal", "local-user"),
            ("X-Hebbian-Hmux-Runner-Instance", "runner-1"),
            ("X-Hebbian-Hmux-Channel-Epoch", "1"),
            ("X-Hebbian-Hmux-Host-Instance-Id", "host-1"),
            ("X-Hebbian-Hmux-Terminal-Epoch", "terminal-1"),
        ])
    }

    #[test]
    fn native_claude_session_start_without_a_transcript_withholds_the_identity() {
        // Claude assigns the session id before any transcript exists, so the
        // id is not resumable until the first prompt lands. Reporting it here
        // sent every resume consumer into `claude --resume` "No conversation
        // found" on an untouched pane (#729).
        let headers = native_claude_hook_headers();
        let missing = tempfile::tempdir().unwrap();
        let missing_transcript = missing.path().join("claude-conversation-1.jsonl");
        let mut bodies = vec![
            serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": "SessionStart",
                "cwd": "/repo",
                "source": "startup",
                "transcript_path": missing_transcript.to_string_lossy(),
            }),
            serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": "SessionStart",
                "cwd": "/repo",
                "source": "startup",
            }),
        ];
        for transcript_path in ["", "relative/path.jsonl"] {
            bodies.push(serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": "Stop",
                "prompt_id": "0199aaaa-bbbb-7ac2-97b7-617afd8e0d27",
                "transcript_path": transcript_path,
            }));
        }
        for body in bodies {
            let label = body.to_string();
            let report = normalize_claude_hook_report_with(body, |name| {
                headers.get(name).map(|value| (*value).to_string())
            })
            .unwrap()
            .expect("activity report");
            assert_eq!(report.presentation["sessionId"], "managed-1", "{label}");
            assert!(
                report.presentation.get("conversationId").is_none(),
                "{label} must not project a conversation id"
            );
            assert_eq!(
                report.presentation["sessionFence"]["terminalEpoch"],
                "terminal-1",
                "{label}"
            );
            assert!(
                report.host_request.conversation_identity.is_none(),
                "{label} must not choose the pane conversation"
            );
        }
    }

    #[test]
    fn native_claude_session_start_with_a_transcript_becomes_a_fenced_identity_report() {
        let headers = native_claude_hook_headers();
        let transcripts = tempfile::tempdir().unwrap();
        let transcript = transcripts.path().join("claude-conversation-1.jsonl");
        std::fs::write(&transcript, "{\"type\":\"user\"}\n").unwrap();
        let report = normalize_claude_hook_report_with(
            serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": "SessionStart",
                "cwd": "/repo",
                "source": "startup",
                "transcript_path": transcript.to_string_lossy(),
            }),
            |name| headers.get(name).map(|value| (*value).to_string()),
        )
        .unwrap()
        .expect("activity report");

        assert_eq!(report.presentation["sessionId"], "managed-1");
        assert_eq!(report.presentation["state"], "waiting");
        assert_eq!(
            report.presentation["conversationId"],
            "claude-conversation-1"
        );
        assert_eq!(
            report.presentation["sessionFence"]["workspaceId"],
            "workspace-1"
        );
        assert_eq!(report.presentation["terminalEvents"], true);
        assert_eq!(
            report.host_request.activity,
            crate::hmux::ReportedAgentActivity::Waiting
        );
        assert_eq!(
            report.host_request.attention,
            crate::hmux::ReportedAgentAttention::None
        );
        assert!(!report.host_request.turn_completed);
        assert_eq!(report.host_request.turn_completion_id, None);
        assert_eq!(report.host_request.working_ttl_ms, None);
        let identity = report.host_request.conversation_identity.unwrap();
        assert_eq!(identity.provider_id, "claude");
        assert_eq!(identity.conversation_id, "claude-conversation-1");
        assert_eq!(
            identity.expected_fence.unwrap().terminal_epoch,
            "terminal-1"
        );
    }

    #[test]
    fn native_claude_hook_requires_the_complete_hmux_generation() {
        let error = normalize_claude_hook_report_with(
            serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": "SessionStart",
            }),
            |_| None,
        )
        .unwrap_err();

        assert!(error.contains("X-Hebbian-Hmux-Session-Id"));
    }

    #[test]
    fn native_claude_events_map_directly_to_host_state_contract() {
        let headers = native_claude_hook_headers();
        let header = |name: &str| headers.get(name).map(|value| (*value).to_string());
        let cases = [
            (
                "UserPromptSubmit",
                None,
                crate::hmux::ReportedAgentActivity::Working,
                crate::hmux::ReportedAgentAttention::None,
                false,
                Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
            ),
            // PreToolUse refreshes the working lease mid-turn, and the lease
            // is the protocol maximum like Codex's: a Claude turn ends at
            // a complete Stop snapshot, never because a long tool call outran
            // a timer.
            (
                "PreToolUse",
                None,
                crate::hmux::ReportedAgentActivity::Working,
                crate::hmux::ReportedAgentAttention::None,
                false,
                Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
            ),
            (
                "Notification",
                Some("permission_prompt"),
                crate::hmux::ReportedAgentActivity::Waiting,
                crate::hmux::ReportedAgentAttention::ApprovalRequired,
                false,
                None,
            ),
            (
                "Stop",
                None,
                crate::hmux::ReportedAgentActivity::Waiting,
                crate::hmux::ReportedAgentAttention::None,
                true,
                None,
            ),
        ];
        for (event, notification_type, activity, attention, completed, ttl) in cases {
            let mut body = serde_json::json!({
                "session_id": "claude-conversation-1",
                "hook_event_name": event,
            });
            if let Some(notification_type) = notification_type {
                body["notification_type"] = Value::String(notification_type.to_string());
            }
            if event == "Stop" {
                body["prompt_id"] =
                    Value::String("0199aaaa-bbbb-7ac2-97b7-617afd8e0d27".to_string());
                body["background_tasks"] = serde_json::json!([]);
                body["session_crons"] = serde_json::json!([]);
            }
            let report = normalize_claude_hook_report_with(body, header)
                .unwrap()
                .expect("activity report");
            assert_eq!(report.host_request.activity, activity, "{event}");
            assert_eq!(report.host_request.attention, attention, "{event}");
            assert_eq!(report.host_request.turn_completed, completed, "{event}");
            assert_eq!(
                report.host_request.turn_completion_id.as_deref(),
                (event == "Stop").then_some("0199aaaa-bbbb-7ac2-97b7-617afd8e0d27"),
                "{event}"
            );
            assert_eq!(report.host_request.working_ttl_ms, ttl, "{event}");
        }
    }

    #[test]
    fn scope_is_resolved_for_every_known_route() {
        assert_eq!(
            required_scope(&Method::Post, "/agent/launch-preference"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/hooks"),
            Some(RouteScope::Report)
        );
        assert_eq!(
            required_scope(&Method::Post, "/hooks/claude"),
            Some(RouteScope::Report)
        );
        assert_eq!(
            required_scope(&Method::Post, "/activity"),
            Some(RouteScope::Report)
        );
        assert_eq!(
            required_scope(&Method::Post, "/comment"),
            Some(RouteScope::Report)
        );
        assert_eq!(
            required_scope(&Method::Get, "/ping"),
            Some(RouteScope::Report)
        );
        assert_eq!(
            required_scope(&Method::Post, "/transcript"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/spawn"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/spawn/v2"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Get, "/spawn/abc123/journal"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/qa/hmux/runtime/prepare"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Get, "/qa/hmux/window-focus/controller-ready"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/qa/hmux/window-focus/start"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/hmux/stop"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/hmux/remote-shell"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/perf/report"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/diagnostics"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/sessions/recent"),
            Some(RouteScope::Control)
        );
        assert_eq!(
            required_scope(&Method::Post, "/workspace/import/apply"),
            Some(RouteScope::Control)
        );
        assert_eq!(required_scope(&Method::Post, "/unknown"), None);
        assert_eq!(
            required_scope(&Method::Post, "/worktree/presentation/export"),
            Some(RouteScope::Control)
        );
        assert_eq!(required_scope(&Method::Get, "/worktree/presentation/export"), None);
        // GET으로 frontend 라우트를 치면 미지 라우트다(404 경로).
        assert_eq!(required_scope(&Method::Get, "/hmux/stop"), None);
        // 웹뷰 리로드는 Control 스코프의 직접 처리 라우트다 — report 토큰으로
        // 사용자 화면을 리로드시킬 수 없어야 한다.
        assert_eq!(
            required_scope(&Method::Post, "/webview/reload"),
            Some(RouteScope::Control)
        );
        assert_eq!(required_scope(&Method::Get, "/webview/reload"), None);
    }

    /// orca식 allowlist 소스 스캔 — server.rs(테스트 모듈 제외)의 경로형
    /// 문자열 리터럴 전수를 선언된 분류 집합과 비교한다. 새 라우트를
    /// 테이블/required_scope에 분류 없이 추가하면 이 테스트가 실패한다.
    #[test]
    fn every_route_literal_is_classified() {
        // 테스트 모듈은 스캔에서 제외 — 픽스처 경로가 allowlist를 오염시키지
        // 않게 한다. 마커가 사라지면 스캔 범위가 조용히 넓어지므로 존재를
        // 단언한다.
        let source = include_str!("server.rs");
        let (source, _) = source
            .split_once("#[cfg(test)]\nmod tests {")
            .expect("server.rs must contain the test module marker");
        let path_like = |segment: &str| {
            segment.len() > 1
                && segment.starts_with('/')
                && segment.chars().all(|character| {
                    character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || "/_-.".contains(character)
                })
        };
        let mut found: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for segment in source.split('"') {
            if path_like(segment) {
                found.insert(segment);
            }
        }
        let declared: std::collections::BTreeSet<&str> = FRONTEND_ROUTES
            .iter()
            .map(|route| route.path)
            .chain([
                // 서버 루프가 직접 처리하는 라우트(required_scope에 분류됨).
                "/ping",
                "/transcript",
                "/hooks/claude",
                "/webview/reload",
                "/spawn/v2",
                "/spawn/",
                "/qa/",
                // /spawn/<id>/journal 접미사 매칭 조각.
                "/journal",
                // QA 라우트(debug 전용, Control 분류).
                "/qa/hmux/runtime/prepare",
                "/qa/hmux/window-focus/controller-ready",
                "/qa/hmux/window-focus/start",
                "/qa/hmux/window-focus/abort",
                "/qa/hmux/window-focus/status",
                "/qa/hmux/window-focus/snapshot",
                "/qa/hmux/window-focus/step",
                "/qa/hmux/window-focus/scroll-rows",
                "/qa/hmux/window-focus/focus",
                "/qa/hmux/window-focus/release-control",
                "/qa/hmux/window-focus/inject",
                "/qa/hmux/window-focus/close",
                "/qa/hmux/window-focus/open-large-view",
                "/qa/hmux/window-focus/presentation",
                "/qa/hmux/window-focus/resize",
                "/qa/hmux/window-focus/resize-render/activate",
                "/qa/hmux/window-focus/restart",
                "/qa/hmux/window-focus/finish",
            ])
            .collect();
        assert_eq!(
            found, declared,
            "route-like string literals in server.rs must match the declared allowlist — classify new routes in FRONTEND_ROUTES or required_scope, then add them here"
        );
    }

    #[cfg(unix)]
    #[test]
    fn server_descriptor_is_published_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory =
            std::env::temp_dir().join(format!("hebbian-ide-server-test-{}", gen_token().unwrap()));
        std::fs::create_dir(&directory).unwrap();

        let descriptor = ServerDescriptor {
            schema_version: 1,
            api_version: CLI_API_VERSION,
            package_version: "0.1.4",
            build_id: "0.1.4+fixture",
            port: 6767,
            token: "test-token",
            report_token: "report-token",
            channel: "dev-test-a1b2c3d4",
            generation: "generation-1",
            process_id: 42,
            started_at_unix_ms: 1_722_121_600_000,
            capabilities: SERVER_CAPABILITIES,
        };
        write_server_descriptor(&directory, &descriptor).unwrap();

        let path = directory.join("server.json");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let contents: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(contents["schemaVersion"], 1);
        assert_eq!(contents["apiVersion"], CLI_API_VERSION);
        assert_eq!(contents["packageVersion"], "0.1.4");
        assert_eq!(contents["buildId"], "0.1.4+fixture");
        assert_eq!(contents["port"], 6767);
        assert_eq!(contents["token"], "test-token");
        assert_eq!(contents["reportToken"], "report-token");
        assert_eq!(contents["channel"], "dev-test-a1b2c3d4");
        assert_eq!(contents["generation"], "generation-1");
        assert_eq!(contents["processId"], 42);
        assert_eq!(contents["startedAtUnixMs"], 1_722_121_600_000u64);
        assert_eq!(
            contents["capabilities"],
            serde_json::json!([
                "managed_claude_host_report_v1",
                "managed_claude_host_report_causality_v1",
                "performance_report.terminal_input_v1",
                "provider_transcript.read_v1",
                "quick_commands_v1",
                "pane_actions.arguments_results_v1",
                "terminal_pane.create_v1",
                "mobile_pane.open_v1",
                "project_registration.add_v1",
                "ssh_hosts.add_v1",
                "worktree.presentation_export_v1",
                "browser.presentation_v1",
                "unopened_agents.visibility_v1",
                "agent.launch_preference_v1",
                "agent.launch_account_v1",
                "agent.run_background_v1"
            ])
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
