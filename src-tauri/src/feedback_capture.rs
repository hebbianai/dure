//! Screen capture and environment info for the in-app feedback dialog.
//!
//! `feedback_capture_main_window` screenshots the app's own window (not the
//! design-mode browser window `design_mode.rs` opens) so a bug report can carry
//! a picture of what the user was looking at. `feedback_environment` reports the
//! OS and CPU architecture the feedback envelope's wire contract requires.

use tauri::{AppHandle, Runtime};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedPng {
    pub png_b64: String,
    pub width: i64,
    pub height: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvironment {
    pub os: String,
    pub arch: String,
}

/// Screenshots the app window and returns it as a base64 PNG.
///
/// The dialog shows different UI for `screen_recording_permission` (grant
/// missing) versus any other failure, so that string must stay stable.
#[tauri::command]
pub async fn feedback_capture_main_window<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CapturedPng, String> {
    capture_main_window(app)
}

#[cfg(target_os = "macos")]
fn capture_main_window<R: Runtime>(app: AppHandle<R>) -> Result<CapturedPng, String> {
    use tauri::Manager;

    use crate::screen_capture::window_number;

    const MAIN_WINDOW_LABEL: &str = "main"; // tauri.conf.json declares no window label, so this is Tauri's default.

    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "window_missing".to_string())?;
    let window_number = window_number(&window)?;

    // Same app-owned cache dir design_mode.rs uses, for the same reason: a
    // subprocess writing to a shared TMPDIR can fail ("cannot write file to
    // intended destination").
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache_dir_failed: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache_dir_create_failed: {e}"))?;
    let path = dir.join("feedback-capture.png");
    // Deletes `path` on every exit from this point on — success, the
    // permission-denied early return, or any failure inside
    // `read_and_downscale` — including a partial file `screencapture` wrote
    // before failing. A guard tied to the whole function's scope means a
    // future added branch cannot reopen this gap by forgetting a second
    // `remove_file` call the way the single end-of-function one did.
    let _cleanup = RemoveOnDrop(&path);

    // Capture the window itself, never the screen region (`-R`) — a region
    // capture photographs whatever else is at those coordinates.
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-l"])
        .arg(window_number.to_string())
        .arg(&path)
        .status()
        .map_err(|e| format!("screencapture_spawn_failed: {e}"))?;
    if !status.success() || !path.exists() {
        // A missing Screen Recording grant looks exactly like this:
        // screencapture exits non-zero instead of reporting a structured
        // permission error.
        return Err("screen_recording_permission".to_string());
    }

    read_and_downscale(&path)
}

/// Best-effort `remove_file` on drop, ignoring failures. The fixed capture
/// filename is overwritten by the next report regardless, so a rare
/// deletion failure here is a transient leak, not a durable one — and it
/// must never override the `Result` a caller already produced.
#[cfg(target_os = "macos")]
struct RemoveOnDrop<'a>(&'a std::path::Path);

#[cfg(target_os = "macos")]
impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0);
    }
}

/// Long edge bound (physical px) a capture must not exceed. The PNG travels
/// inside a JSON body with a 4 MB attachment cap, so a full-resolution Retina
/// window capture needs shrinking before it fits.
#[cfg(target_os = "macos")]
const MAX_LONG_EDGE_PX: i64 = 1800;

/// `sips -Z <bound>` arguments to shrink a capture whose long edge exceeds
/// `MAX_LONG_EDGE_PX`, applied in place; `None` when the capture already fits.
#[cfg(target_os = "macos")]
fn scale_args(width: i64, height: i64) -> Option<Vec<String>> {
    if width.max(height) > MAX_LONG_EDGE_PX {
        Some(vec!["-Z".to_string(), MAX_LONG_EDGE_PX.to_string()])
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn read_and_downscale(path: &std::path::Path) -> Result<CapturedPng, String> {
    use base64::Engine;

    use crate::screen_capture::png_size;

    let (mut width, mut height) = png_size(path)?;
    if let Some(args) = scale_args(width, height) {
        let sips = std::process::Command::new("/usr/bin/sips")
            .args(args)
            .arg(path)
            .output()
            .map_err(|e| format!("sips_spawn_failed: {e}"))?;
        if !sips.status.success() {
            return Err("downscale_failed".to_string());
        }
        (width, height) = png_size(path)?;
    }
    let bytes = std::fs::read(path).map_err(|e| format!("png_read_failed: {e}"))?;
    Ok(CapturedPng {
        png_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
        width,
        height,
    })
}

#[cfg(not(target_os = "macos"))]
fn capture_main_window<R: Runtime>(_app: AppHandle<R>) -> Result<CapturedPng, String> {
    Err("unsupported_platform".to_string())
}

/// Reports the OS name/version and CPU architecture for the feedback envelope.
#[tauri::command]
pub fn feedback_environment() -> FeedbackEnvironment {
    FeedbackEnvironment {
        os: sysinfo::System::long_os_version().unwrap_or_else(|| "unknown".to_string()),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn downscales_only_when_the_capture_exceeds_the_long_edge_bound() {
        assert_eq!(
            super::scale_args(3024, 1890),
            Some(vec!["-Z".to_string(), "1800".to_string()])
        );
        assert_eq!(super::scale_args(1440, 900), None);
        // Portrait capture: the long edge is the height, not the width.
        assert_eq!(
            super::scale_args(1200, 2400),
            Some(vec!["-Z".to_string(), "1800".to_string()])
        );
        // Exactly at the bound does not count as exceeding it.
        assert_eq!(super::scale_args(1800, 1200), None);
    }

    // Regression for the gap a review caught: an early return from
    // `capture_main_window` (e.g. `screen_recording_permission`) used to skip
    // the single end-of-function `remove_file`, leaving a partial capture on
    // disk. This exercises the actual `RemoveOnDrop` guard — not a fake
    // `screencapture` — by returning early from a scope holding the guard,
    // the same shape as the permission-denied branch.
    #[test]
    fn temporary_capture_is_removed_even_when_the_holding_scope_returns_early() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial-capture.png");
        std::fs::write(&path, b"partial").expect("write partial capture");

        fn returns_early_while_holding_the_guard(path: &std::path::Path) -> Result<(), &'static str> {
            let _cleanup = super::RemoveOnDrop(path);
            Err("simulated screen_recording_permission")
        }

        assert!(path.exists(), "fixture setup: the partial file must exist first");
        assert!(returns_early_while_holding_the_guard(&path).is_err());
        assert!(
            !path.exists(),
            "RemoveOnDrop must delete the file on an early return, not only when the function runs to completion"
        );
    }
}
