//! Optional local framebuffer/HID bridge. Each lease owns one foreground worker.
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;
use tokio::sync::oneshot;

struct Lease {
    binding: crate::hmux::ObserverWebviewBinding,
    window: String,
    target: Target,
    endpoint: Option<Endpoint>,
    stopped: Arc<Mutex<Option<String>>>,
    cancel: Option<oneshot::Sender<()>>,
    done: Option<oneshot::Receiver<()>>,
}
#[derive(Clone)]
struct Endpoint {
    port: u16,
    token: String,
}
impl Endpoint {
    fn url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}/{route}", self.port)
    }
}
fn leases() -> &'static Mutex<HashMap<String, Lease>> {
    static VALUE: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
    VALUE.get_or_init(Mutex::default)
}
fn fresh_token() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn bridge_addon(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/serve-sim/dist/native/serve-sim-native.node")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Application resource directory has no bundle parent")?
            .join("Frameworks/serve-sim-native.dylib")
    };
    path.canonicalize()
        .map_err(|_| "The live iOS module is not installed in this build".into())
}

#[tauri::command]
pub async fn mobile_simulator_live_start(
    window: tauri::WebviewWindow,
    target: Target,
    webview_instance_id: String,
) -> Result<String, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) || target.platform != Platform::Ios
    {
        return Err("Live iOS requires an Apple Silicon Mac".into());
    }
    let binding = window
        .state::<crate::AppState>()
        .hmux
        .claim_observer_webview(&window, &webview_instance_id)
        .await?;
    let checked = target.clone();
    let device = tauri::async_runtime::spawn_blocking(move || observe_target(&checked))
        .await
        .map_err(|e| e.to_string())??;
    if device.state != "ready" {
        return Err("Boot the selected simulator before connecting live input".into());
    }
    let addon = bridge_addon(window.app_handle())?;
    let root = tempfile::Builder::new()
        .prefix("dure-mobile-live-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let script = root.path().join("worker.cjs");
    let ready = root.path().join("ready.json");
    std::fs::write(&script, include_str!("live.cjs")).map_err(|e| e.to_string())?;
    let id = fresh_token()?;
    let token = fresh_token()?;
    let launch_root = root.path().to_path_buf();
    let mut command = background(move || login_command("node", &launch_root)).await?;
    command.arg(&script).current_dir(root.path()).capture_stderr(true)
        .env("SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD", "1")
        .on_output_limit(OutputLimitAction::TerminateProcessTree)
        .input(serde_json::to_vec(&serde_json::json!({"addon": addon, "device": target.id, "token": token, "ready": ready})).map_err(|e| e.to_string())?);
    let (cancel, mut canceled) = oneshot::channel();
    let (finished, done) = oneshot::channel();
    let stopped = Arc::new(Mutex::new(None));
    {
        let mut active = leases()
            .lock()
            .map_err(|_| "Live connection lock unavailable")?;
        binding.require_live("Live iOS start belongs to a retired document")?;
        if active.values().any(|lease| lease.target.id == target.id) {
            return Err(
                "This simulator already has a live connection; close it before reconnecting".into(),
            );
        }
        active.insert(
            id.clone(),
            Lease {
                binding,
                window: window.label().into(),
                target,
                endpoint: None,
                stopped: stopped.clone(),
                cancel: Some(cancel),
                done: Some(done),
            },
        );
    }
    let worker_ready = ready.clone();
    let worker_token = token.clone();
    tauri::async_runtime::spawn(async move {
        let message = {
            let execution = hebbian_bounded_process::run_async(
                &command,
                Duration::from_secs(86400),
                1024 * 1024,
                tokio::time::sleep,
            );
            tokio::pin!(execution);
            tokio::select! {
                output = &mut execution => match output {
                    Ok(output) => format!("Live iOS worker stopped: {}", String::from_utf8_lossy(&output.stderr)),
                    Err(error) => format!("Live iOS worker failed: {}", error.stage()),
                },
                _ = &mut canceled => {
                    // Let an accepted gesture release its finger before dropping the owned process.
                    if let Some(port) = read_port(&worker_ready) {
                        if let Ok(client) = local_tls().and_then(|tls| reqwest::Client::builder().tls_backend_preconfigured(tls).no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(4)).build().map_err(|e| e.to_string())) {
                            let endpoint = Endpoint { port, token: worker_token };
                            let _ = client.post(endpoint.url("close")).bearer_auth(&endpoint.token).send().await;
                        }
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(2), &mut execution).await;
                    "Live iOS connection closed".into()
                }
            }
        };
        if let Ok(mut state) = stopped.lock() {
            *state = Some(message);
        }
        // execution's native owner is dropped before the completion receipt.
        drop(root);
        let _ = finished.send(());
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let result = loop {
        let state = {
            let mut active = leases()
                .lock()
                .map_err(|_| "Live connection lock unavailable")?;
            let lease = active.get_mut(&id).ok_or("Live connection canceled")?;
            let failure = lease
                .stopped
                .lock()
                .map_err(|_| "Live worker state unavailable")?
                .clone();
            if let Some(error) = failure {
                Some(Err(error))
            } else if lease.cancel.is_none() {
                Some(Err("Live connection canceled".into()))
            } else if let Some(port) = read_port(&ready) {
                lease.endpoint = Some(Endpoint {
                    port,
                    token: token.clone(),
                });
                Some(Ok(id.clone()))
            } else {
                None
            }
        };
        if let Some(result) = state {
            break result;
        }
        if std::time::Instant::now() >= deadline {
            break Err("Live iOS did not start within 15 seconds".into());
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    };
    if result.is_err() {
        stop(&id).await;
    }
    result
}
fn read_port(path: &std::path::Path) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let port = u16::try_from(value["port"].as_u64()?).ok()?;
    (port != 0).then_some(port)
}
fn endpoint(id: &str, owner: &str) -> Result<Endpoint, String> {
    let active = leases()
        .lock()
        .map_err(|_| "Live connection lock unavailable")?;
    let lease = active
        .get(id)
        .filter(|lease| lease.window == owner)
        .ok_or("Live connection does not belong to this window")?;
    lease
        .binding
        .require_live("Live iOS connection belongs to a retired document")?;
    if let Some(error) = lease
        .stopped
        .lock()
        .map_err(|_| "Live worker state unavailable")?
        .clone()
    {
        return Err(error);
    }
    if lease.cancel.is_none() {
        return Err("Live connection is closing".into());
    }
    lease
        .endpoint
        .clone()
        .ok_or("Live connection is not ready".into())
}
fn local_tls() -> Result<rustls::ClientConfig, String> {
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())
        .map(|builder| {
            builder
                .with_root_certificates(rustls::RootCertStore::empty())
                .with_no_client_auth()
        })
}
fn client() -> Result<&'static reqwest::blocking::Client, String> {
    static VALUE: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .tls_backend_preconfigured(local_tls()?)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}
#[tauri::command]
pub async fn mobile_simulator_live_frame(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Option<Frame>, String> {
    let endpoint = endpoint(&id, window.label())?;
    background(move || frame(endpoint)).await
}
fn frame(endpoint: Endpoint) -> Result<Option<Frame>, String> {
    let response = client()?
        .get(endpoint.url("frame"))
        .timeout(Duration::from_secs(3))
        .bearer_auth(endpoint.token)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    response.json().map(Some).map_err(|e| e.to_string())
}
pub(super) fn act(target: &Target, action: &Action) -> Result<(), String> {
    if let Action::Paste { text } = action {
        validate_paste(text)?;
    }
    let endpoint = {
        let active = leases()
            .lock()
            .map_err(|_| "Live connection lock unavailable")?;
        let lease = active
            .values()
            .find(|lease| lease.target.id == target.id && lease.cancel.is_some())
            .ok_or("Enable Live iOS in the simulator pane before sending input")?;
        lease
            .binding
            .require_live("Live iOS input belongs to a retired document")?;
        if let Some(error) = lease
            .stopped
            .lock()
            .map_err(|_| "Live worker state unavailable")?
            .clone()
        {
            return Err(error);
        }
        lease
            .endpoint
            .clone()
            .ok_or("Live connection is not ready")?
    };
    if let Action::Paste { text } = action {
        // Admission above must succeed before changing this exact guest's clipboard.
        // DeviceOperation serializes the clipboard write and chord for this device.
        execute_with_input(
            "/usr/bin/xcrun",
            &["simctl", "pbcopy", &target.id],
            5,
            8192,
            Some(text.as_bytes()),
        )?;
    }
    let response = client()?
        .post(endpoint.url("action"))
        .bearer_auth(endpoint.token)
        .json(action)
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .unwrap_or_else(|_| "Live iOS input failed".into()));
    }
    Ok(())
}
async fn stop(id: &str) {
    let pending = leases().lock().ok().and_then(|mut active| {
        active.get_mut(id).and_then(|lease| {
            lease
                .cancel
                .take()
                .map(|cancel| (cancel, lease.done.take()))
        })
    });
    if let Some((cancel, done)) = pending {
        let _ = cancel.send(());
        if let Some(done) = done {
            let _ = done.await;
        }
        if let Ok(mut active) = leases().lock() {
            active.remove(id);
        }
    }
}
#[tauri::command]
pub async fn mobile_simulator_live_stop(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    {
        let active = leases()
            .lock()
            .map_err(|_| "Live connection lock unavailable")?;
        if active
            .get(&id)
            .is_some_and(|lease| lease.window != window.label())
        {
            return Err("Live connection belongs to another window".into());
        }
    }
    stop(&id).await;
    Ok(())
}
pub(crate) fn configure_window_lifecycle(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("mobile-simulator")
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        close_window(window.label());
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                close_window(window.label());
            }
        })
}
pub(crate) fn close_window(owner: &str) {
    let ids: Vec<String> = leases()
        .lock()
        .map(|active| {
            active
                .iter()
                .filter(|(_, lease)| lease.window == owner)
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in ids {
        tauri::async_runtime::spawn(async move {
            stop(&id).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[tokio::test]
    async fn live_frames_cross_the_async_command_boundary_without_a_global_tls_provider() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).contains("Bearer fixture-token"));
            let body = r#"{"dataUrl":"data:image/jpeg;base64,YQ==","width":390,"height":844}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let frame = background(move || {
            frame(Endpoint {
                port,
                token: "fixture-token".into(),
            })
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!((frame.width, frame.height), (390, 844));
        server.join().unwrap();
    }
}
