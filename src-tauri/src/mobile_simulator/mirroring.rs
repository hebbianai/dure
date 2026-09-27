//! Apple iPhone Mirroring is a user-authenticated Continuity session, not a USB
//! UDID. Pin its process generation and window, and never fall back to simctl.
use super::*;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: String,
    window_id: u32,
    bounds: Bounds,
    ready: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct Bounds {
    #[serde(rename = "X")]
    x: f64,
    #[serde(rename = "Y")]
    y: f64,
    #[serde(rename = "Width")]
    width: f64,
    #[serde(rename = "Height")]
    height: f64,
}

fn invoke(request: serde_json::Value) -> Result<Observation, String> {
    if !cfg!(target_os = "macos") {
        return Err("iPhone Mirroring requires macOS 15 or later".into());
    }
    let data = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let output = execute_with_input(
        "/usr/bin/osascript",
        &["-l", "JavaScript", "-e", include_str!("mirroring.js")],
        15,
        64 * 1024,
        Some(&data),
    )?;
    serde_json::from_slice(&output)
        .map_err(|e| format!("Invalid iPhone Mirroring observation: {e}"))
}

pub(super) fn valid_id(id: &str) -> bool {
    let parts: Vec<_> = id.split(':').collect();
    parts.len() == 4
        && parts[0] == "mirroring"
        && parts[1].parse::<u32>().is_ok_and(|pid| pid > 1)
        && parts[2].len() == 11
        && parts[2]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && parts[3].parse::<u32>().is_ok_and(|window| window > 0)
}

pub(super) fn devices() -> Result<Vec<Device>, String> {
    let observed = invoke(serde_json::json!({}))?;
    if !valid_id(&observed.id) {
        return Err("Invalid iPhone Mirroring session identity".into());
    }
    Ok(vec![Device {
        target: Target {
            platform: Platform::Ios,
            id: observed.id,
            transport: Some(Transport::IphoneMirroring),
        },
        kind: Some(DeviceKind::Physical),
        name: "iPhone (iPhone Mirroring)".into(),
        runtime: "iPhone Mirroring".into(),
        state: if observed.ready {
            "ready"
        } else {
            "unavailable"
        }
        .into(),
        capabilities: vec![
            Capability::Capture,
            Capability::Home,
            Capability::Recents,
            Capability::ForegroundTap,
        ],
        detail: if !observed.ready {
            Some("Connect your locked, nearby iPhone in iPhone Mirroring and finish authentication, then refresh devices.".into())
        } else {
            None
        },
    }])
}

pub(super) fn capture(target: &Target) -> Result<Vec<u8>, String> {
    let before = invoke(serde_json::json!({"id": target.id}))?;
    if !before.ready {
        return Err(
            "iPhone Mirroring is not connected; finish authentication and keep the iPhone locked"
                .into(),
        );
    }
    let root = tempfile::Builder::new()
        .prefix("dure-iphone-frame-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = root.path().join("frame.png");
    execute(
        "/usr/sbin/screencapture",
        &[
            "-x",
            "-o",
            "-l",
            &before.window_id.to_string(),
            &path.to_string_lossy(),
        ],
        10,
        8192,
    )?;
    let after = invoke(serde_json::json!({"id": target.id}))?;
    if before != after {
        return Err("iPhone Mirroring changed during capture; refresh the preview".into());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 24 * 1024 * 1024 {
        return Err("iPhone Mirroring capture exceeded the image limit".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    png_dimensions(&bytes)?;
    Ok(bytes)
}

pub(super) fn act(target: &Target, action: &Action) -> Result<(), String> {
    let mut request = serde_json::json!({"id": target.id, "action": action});
    match action {
        Action::Button { button } if button == "home" || button == "recents" => {}
        Action::Gesture { start, end, width, height, foreground } => {
            if !foreground {
                return Err("Physical iPhone taps require explicit foreground=true; iPhone Mirroring briefly comes forward.".into());
            }
            for (value, size) in [(start.x, *width), (start.y, *height), (end.x, *width), (end.y, *height)] {
                pixel(value, size)?;
            }
            if (start.x - end.x).abs() + (start.y - end.y).abs() >= 0.01 {
                return Err("Physical iPhone swipes are not supported; use a tap or Apple's window.".into());
            }
            let observed = invoke(serde_json::json!({"id": target.id}))?;
            if png_dimensions(&capture(target)?)? != (*width, *height) {
                return Err("iPhone view changed; capture a fresh screenshot before tapping".into());
            }
            request["frameBounds"] = serde_json::to_value(observed.bounds).map_err(|e| e.to_string())?;
        }
        _ => return Err("iPhone Mirroring supports preview, Home, App Switcher and explicitly enabled foreground taps. Typing, keys, app installation and launch are unavailable.".into()),
    }
    invoke(request)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_a_pinned_mirroring_session_not_a_simulator_or_usb_device() {
        assert!(valid_id("mirroring:42:EKWlAAAAAAA:99"));
        for id in [
            "booted",
            "mirroring:1:EKWlAAAAAAA:99",
            "mirroring:42::99",
            "mirroring:42:EKWlAAAAAAA:0",
            "mirroring:42:EKWlAAAAAAA:99:extra",
            "00008150-001A28543E00401C",
        ] {
            assert!(!valid_id(id));
        }
    }
}
