//! Local SDK adapter. Device lifetime belongs to the SDK, never to a pane.
use base64::{engine::general_purpose::STANDARD, Engine};
use hebbian_bounded_process::{CommandSpec, OutputLimitAction};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Ios,
    Android,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Target {
    pub platform: Platform,
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct Device {
    #[serde(flatten)]
    target: Target,
    name: String,
    runtime: String,
    state: String,
}

#[derive(Serialize)]
pub struct Unavailable {
    platform: Platform,
    detail: String,
}

#[derive(Serialize)]
pub struct Catalog {
    devices: Vec<Device>,
    unavailable: Vec<Unavailable>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Point {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Boot,
    OpenNative,
    OpenUrl {
        url: String,
    },
    Install {
        path: String,
    },
    Launch {
        #[serde(rename = "appId")]
        app_id: String,
    },
    Button {
        button: String,
    },
    Type {
        text: String,
    },
    Rotate {
        landscape: bool,
    },
    Gesture {
        start: Point,
        end: Point,
        width: u32,
        height: u32,
    },
}

async fn background<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}

fn login_command(program: &str, cwd: &std::path::Path) -> Result<CommandSpec, String> {
    #[cfg(unix)]
    {
        let resolved = crate::provider_preflight::resolve_login_command_environment(
            program,
            cwd,
            hmux_client::TerminalEnvironment::default(),
        )
        .map_err(String::from)?;
        let mut command = CommandSpec::new(resolved.executable);
        command.clear_env();
        for (key, value) in resolved.environment {
            command.env(key, value);
        }
        Ok(command)
    }
    #[cfg(not(unix))]
    {
        let mut command = CommandSpec::new(program);
        command.current_dir(cwd);
        Ok(command)
    }
}

fn execute(program: &str, args: &[&str], seconds: u64, limit: usize) -> Result<Vec<u8>, String> {
    let operation = format!(
        "{program} {}",
        args.iter().take(2).copied().collect::<Vec<_>>().join(" ")
    );
    let mut command = CommandSpec::new(program);
    command
        .args(args)
        .capture_stderr(true)
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    let output = hebbian_bounded_process::run(&command, Duration::from_secs(seconds), limit)
        .map_err(|error| match error {
            hebbian_bounded_process::CommandFailure::Timeout(stage) => format!(
                "{operation}: timed out after {seconds}s ({stage}). Inspect the device state before retrying.",
                stage = stage.token()
            ),
            _ => format!("{operation}: {}", error.stage()),
        })?;
    if output.exceeded_limit {
        return Err(format!("{operation}: output limit exceeded"));
    }
    if !output.status.success() {
        let detail = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        return Err(format!(
            "{operation} ({}): {}",
            output.status,
            detail.trim().chars().take(8192).collect::<String>()
        ));
    }
    Ok(output.stdout)
}

fn adb() -> String {
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    if let Some(home) = dirs::home_dir() {
        roots.extend([home.join("Library/Android/sdk"), home.join("Android/Sdk")]);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Android/Sdk"));
    }
    let binary = if cfg!(windows) { "adb.exe" } else { "adb" };
    roots
        .into_iter()
        .map(|root| root.join("platform-tools").join(binary))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary.into())
}

fn validate_target(target: &Target) -> Result<(), String> {
    let valid = match target.platform {
        Platform::Ios => {
            target.id.len() == 36
                && target.id.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        }
        Platform::Android => {
            !target.id.is_empty()
                && target.id.len() <= 256
                && !target.id.starts_with('-')
                && target
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.:[]".contains(&c))
        }
    };
    if valid {
        Ok(())
    } else {
        Err("Invalid exact device identifier; refresh the device list".into())
    }
}

fn ios_devices(bytes: &[u8]) -> Result<Vec<Device>, String> {
    #[derive(Deserialize)]
    struct List {
        devices: std::collections::BTreeMap<String, Vec<Entry>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        udid: String,
        name: String,
        state: String,
        is_available: bool,
    }
    let list: List = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut devices = Vec::new();
    for (runtime, entries) in list.devices {
        if !runtime.contains(".iOS-") {
            continue;
        }
        for entry in entries.into_iter().filter(|entry| entry.is_available) {
            let target = Target {
                platform: Platform::Ios,
                id: entry.udid,
            };
            validate_target(&target)?;
            devices.push(Device {
                target,
                name: entry.name,
                runtime: runtime
                    .trim_start_matches("com.apple.CoreSimulator.SimRuntime.")
                    .replace('-', " "),
                state: match entry.state.as_str() {
                    "Booted" => "ready",
                    "Shutdown" => "shutdown",
                    _ => "unavailable",
                }
                .into(),
            });
        }
    }
    Ok(devices)
}

fn android_devices(bytes: &[u8]) -> Result<Vec<Device>, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    if !text
        .lines()
        .any(|line| line.starts_with("List of devices attached"))
    {
        return Err("Unrecognized adb device list".into());
    }
    text.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with("List of devices attached"))
        .map(|line| {
            let mut parts = line.split_whitespace();
            let id = parts.next().ok_or("Missing Android serial")?.to_string();
            let state = parts.next().ok_or("Missing Android state")?;
            let name = parts
                .find_map(|part| part.strip_prefix("model:"))
                .unwrap_or(&id)
                .replace('_', " ");
            let target = Target {
                platform: Platform::Android,
                id,
            };
            validate_target(&target)?;
            Ok(Device {
                target,
                name,
                runtime: "Android".into(),
                state: match state {
                    "device" => "ready",
                    "unauthorized" => "unauthorized",
                    _ => "offline",
                }
                .into(),
            })
        })
        .collect()
}

fn devices(platform: &Platform) -> Result<Vec<Device>, String> {
    match platform {
        Platform::Ios if cfg!(target_os = "macos") => ios_devices(&execute(
            "/usr/bin/xcrun",
            &["simctl", "list", "devices", "available", "--json"],
            10,
            2 * 1024 * 1024,
        )?),
        Platform::Ios => Err("iOS simulators require macOS and Xcode".into()),
        Platform::Android => android_devices(&execute(&adb(), &["devices", "-l"], 10, 512 * 1024)?),
    }
}

#[tauri::command]
pub async fn mobile_simulator_list() -> Result<Catalog, String> {
    background(|| Ok(list())).await
}

fn list() -> Catalog {
    let mut catalog = Catalog {
        devices: Vec::new(),
        unavailable: Vec::new(),
    };
    for platform in [Platform::Ios, Platform::Android] {
        match devices(&platform) {
            Ok(devices) => catalog.devices.extend(devices),
            Err(detail) => catalog.unavailable.push(Unavailable { platform, detail }),
        }
    }
    catalog
}

fn observe_target(target: &Target) -> Result<Device, String> {
    validate_target(target)?;
    devices(&target.platform)?
        .into_iter()
        .find(|device| device.target.id == target.id)
        .ok_or_else(|| "The selected device is no longer available; refresh the device list".into())
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("The device did not return a PNG screenshot".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "Invalid PNG width")?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "Invalid PNG height")?);
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err("Invalid screenshot dimensions".into());
    }
    Ok((width, height))
}

fn capture(target: &Target) -> Result<Vec<u8>, String> {
    validate_target(target)?;
    let limit = 24 * 1024 * 1024;
    match target.platform {
        Platform::Ios if cfg!(target_os = "macos") => execute(
            "/usr/bin/xcrun",
            &["simctl", "io", &target.id, "screenshot", "--type=png", "-"],
            10,
            limit,
        ),
        Platform::Ios => Err("iOS simulators require macOS".into()),
        Platform::Android => execute(
            &adb(),
            &["-s", &target.id, "exec-out", "screencap", "-p"],
            10,
            limit,
        ),
    }
}

#[tauri::command]
pub async fn mobile_simulator_capture(target: Target) -> Result<Frame, String> {
    background(move || screenshot(&target)).await
}

fn screenshot(target: &Target) -> Result<Frame, String> {
    let bytes = capture(target)?;
    let (width, height) = png_dimensions(&bytes)?;
    Ok(Frame {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        width,
        height,
    })
}

fn app_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("Enter an application bundle or package identifier".into());
    }
    Ok(())
}

fn pixel(value: f64, size: u32) -> Result<String, String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) || size == 0 {
        return Err("Touch coordinates must be between 0 and 1".into());
    }
    Ok(((value * f64::from(size)).floor() as u32)
        .min(size - 1)
        .to_string())
}

fn action_args(target: &Target, action: Action) -> Result<Vec<String>, String> {
    let ios = target.platform == Platform::Ios;
    let args: Vec<String> = match action {
        Action::OpenUrl { url } => {
            let parsed =
                tauri::Url::parse(&url).map_err(|_| "Enter a complete URL or app deep link")?;
            if !matches!(parsed.scheme(), "http" | "https") && !url.contains("://") {
                return Err("Enter an http(s) URL or an app scheme followed by ://".into());
            }
            if matches!(parsed.scheme(), "file" | "javascript" | "data" | "intent")
                || url.len() > 8192
            {
                return Err("This URL scheme is not supported".into());
            }
            if ios {
                vec!["openurl".into(), target.id.clone(), url]
            } else {
                vec![
                    "shell".into(),
                    "am".into(),
                    "start".into(),
                    "-W".into(),
                    "-a".into(),
                    "android.intent.action.VIEW".into(),
                    "-d".into(),
                    shell_argument(&url),
                ]
            }
        }
        Action::Install { path } => {
            let path = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
            let valid = if ios {
                path.is_dir() && path.extension().is_some_and(|ext| ext == "app")
            } else {
                path.is_file() && path.extension().is_some_and(|ext| ext == "apk")
            };
            if !valid {
                return Err(
                    "Select a simulator .app folder for iOS or an .apk file for Android".into(),
                );
            }
            let path = path.to_string_lossy().into_owned();
            if ios {
                vec!["install".into(), target.id.clone(), path]
            } else {
                vec!["install".into(), "-r".into(), path]
            }
        }
        Action::Launch { app_id } => {
            app_identifier(&app_id)?;
            if ios {
                vec!["launch".into(), target.id.clone(), app_id]
            } else {
                let resolved = execute(
                    &adb(),
                    &[
                        "-s",
                        &target.id,
                        "shell",
                        "cmd",
                        "package",
                        "resolve-activity",
                        "--components",
                        "--user",
                        "current",
                        "-a",
                        "android.intent.action.MAIN",
                        "-c",
                        "android.intent.category.LAUNCHER",
                        "-p",
                        &app_id,
                    ],
                    15,
                    8192,
                )?;
                let component = android_launcher_component(&app_id, &resolved)?;
                vec![
                    "shell".into(),
                    "am".into(),
                    "start".into(),
                    "-W".into(),
                    "-a".into(),
                    "android.intent.action.MAIN".into(),
                    "-n".into(),
                    shell_argument(&component),
                    "-c".into(),
                    "android.intent.category.LAUNCHER".into(),
                ]
            }
        }
        Action::Type { text } if !ios => {
            if text.is_empty()
                || text.len() > 2048
                || !text.bytes().all(|c| c.is_ascii_graphic() || c == b' ')
                || text.contains('%')
            {
                return Err("Android text input accepts printable ASCII without %; use the device keyboard for other text".into());
            }
            vec![
                "shell".into(),
                "input".into(),
                "text".into(),
                shell_argument(&text.replace(' ', "%s")),
            ]
        }
        Action::Rotate { landscape } if !ios => {
            execute(
                &adb(),
                &[
                    "-s",
                    &target.id,
                    "shell",
                    "settings",
                    "put",
                    "system",
                    "accelerometer_rotation",
                    "0",
                ],
                10,
                8192,
            )?;
            vec![
                "shell".into(),
                "settings".into(),
                "put".into(),
                "system".into(),
                "user_rotation".into(),
                if landscape { "1" } else { "0" }.into(),
            ]
        }
        Action::Button { button } if !ios => {
            let key = match button.as_str() {
                "home" => "3",
                "back" => "4",
                "recents" => "187",
                _ => return Err("Unsupported hardware button".into()),
            };
            vec![
                "shell".into(),
                "input".into(),
                "keyevent".into(),
                key.into(),
            ]
        }
        Action::Gesture {
            start,
            end,
            width,
            height,
        } if !ios => {
            if png_dimensions(&capture(target)?)? != (width, height) {
                return Err(
                    "Device orientation changed; refresh the screenshot before interacting".into(),
                );
            }
            let coords = [
                pixel(start.x, width)?,
                pixel(start.y, height)?,
                pixel(end.x, width)?,
                pixel(end.y, height)?,
            ];
            if (start.x - end.x).abs() < 0.005 && (start.y - end.y).abs() < 0.005 {
                vec![
                    "shell".into(),
                    "input".into(),
                    "tap".into(),
                    coords[0].clone(),
                    coords[1].clone(),
                ]
            } else {
                let mut args = vec!["shell".into(), "input".into(), "swipe".into()];
                args.extend(coords);
                args.push("300".into());
                args
            }
        }
        _ => return Err("This action is not supported on the selected device".into()),
    };
    Ok(args)
}

// adb joins its shell arguments remotely, so process argv alone is not quoting.
fn shell_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn android_launcher_component(app_id: &str, output: &[u8]) -> Result<String, String> {
    let value = String::from_utf8_lossy(output);
    let component = value.trim();
    if let Some((package, activity)) = component.split_once('/') {
        if package == app_id
            && !activity.is_empty()
            && activity
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._$".contains(&c))
        {
            return Ok(component.into());
        }
    }
    Err(format!(
        "No launchable activity resolved for {app_id}: {component}"
    ))
}

#[tauri::command]
pub async fn mobile_simulator_act(target: Target, action: Action) -> Result<(), String> {
    background(move || act(&target, action)).await
}

fn act(target: &Target, action: Action) -> Result<(), String> {
    let _guard = workflows::DeviceOperation::acquire(target)?;
    let kind = serde_json::to_value(&action).map_err(|e| e.to_string())?["kind"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let result = perform(target, action);
    workflows::record(target, &kind, &result);
    result
}

fn perform(target: &Target, action: Action) -> Result<(), String> {
    let device = observe_target(target)?;
    if target.platform == Platform::Ios
        && matches!(
            action,
            Action::Gesture { .. }
                | Action::Type { .. }
                | Action::Rotate { .. }
                | Action::Button { .. }
        )
    {
        if device.state != "ready" {
            return Err("Selected simulator is not ready".into());
        }
        return live::act(target, &action);
    }
    match action {
        Action::Boot if target.platform == Platform::Ios => {
            if device.state == "ready" {
                return Ok(());
            }
            if device.state != "shutdown" {
                return Err("The simulator is not ready to boot; refresh its state".into());
            }
            execute(
                "/usr/bin/xcrun",
                &["simctl", "boot", &target.id],
                30,
                1024 * 1024,
            )?;
            execute(
                "/usr/bin/xcrun",
                &["simctl", "bootstatus", &target.id],
                120,
                1024 * 1024,
            )?;
        }
        Action::OpenNative if target.platform == Platform::Ios => {
            let developer = execute("/usr/bin/xcode-select", &["-p"], 5, 8192)?;
            let app = PathBuf::from(String::from_utf8_lossy(&developer).trim())
                .join("Applications/Simulator.app");
            if !app.is_dir() {
                return Err(
                    "Simulator.app is unavailable in the selected Xcode installation".into(),
                );
            }
            execute(
                "/usr/bin/open",
                &[
                    "-a",
                    &app.to_string_lossy(),
                    "--args",
                    "-CurrentDeviceUDID",
                    &target.id,
                ],
                10,
                8192,
            )?;
        }
        action => {
            if device.state != "ready" {
                return Err(
                    "The selected device is not running or has not authorized this computer".into(),
                );
            }
            let args = action_args(target, action)?;
            let mut prefix = if target.platform == Platform::Ios {
                vec!["simctl"]
            } else {
                vec!["-s", target.id.as_str()]
            };
            prefix.extend(args.iter().map(String::as_str));
            let program = if target.platform == Platform::Ios {
                "/usr/bin/xcrun".into()
            } else {
                adb()
            };
            let output = execute(&program, &prefix, 120, 2 * 1024 * 1024)?;
            if target.platform == Platform::Android && args.get(1).is_some_and(|arg| arg == "am") {
                verify_android_activity(&output)?;
            }
        }
    }
    Ok(())
}

fn verify_android_activity(output: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(output);
    if text.lines().any(|line| line.trim() == "Status: ok") {
        return Ok(());
    }
    Err(format!("Android activity launch failed: {}", text.trim()))
}

pub mod live;
pub mod workflows;

#[cfg(test)]
mod tests;
