//! Native title-bar colours for the decorated Windows window.
//!
//! Dure deliberately keeps the Windows system frame, so minimize, maximize,
//! close, snapping, and accessibility remain native. DWM owns that caption and
//! does not inherit CSS variables from the webview. The frontend sends the
//! resolved app-floor colours whenever its theme changes; Windows applies them
//! to the caption and glyphs while other platforms do nothing.

#[tauri::command]
pub async fn set_native_title_bar_colors(
    window: tauri::WebviewWindow,
    background: String,
    foreground: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let background = colorref(&background)?;
        let foreground = colorref(&foreground)?;
        let (tx, rx) = std::sync::mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(windows::apply(&target, background, foreground));
            })
            .map_err(|error| error.to_string())?;
        rx.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, background, foreground);
        Ok(())
    }
}

#[cfg(windows)]
fn colorref(hex: &str) -> Result<u32, String> {
    let raw = hex
        .strip_prefix('#')
        .filter(|value| value.len() == 6)
        .ok_or_else(|| format!("expected #rrggbb title-bar colour, got {hex:?}"))?;
    let rgb = u32::from_str_radix(raw, 16)
        .map_err(|_| format!("expected #rrggbb title-bar colour, got {hex:?}"))?;
    let red = (rgb >> 16) & 0xff;
    let green = (rgb >> 8) & 0xff;
    let blue = rgb & 0xff;
    Ok(red | (green << 8) | (blue << 16))
}

#[cfg(windows)]
fn native_window_title(title: &str) -> &str {
    if title == "Dure" {
        return "";
    }
    let Some(suffix) = title.strip_prefix("Dure") else {
        return title;
    };
    let suffix = suffix.trim_start();
    suffix
        .strip_prefix('—')
        .or_else(|| suffix.strip_prefix('-'))
        .map(str::trim)
        .unwrap_or(title)
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use windows::Win32::Foundation::WPARAM;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageW, ICON_SMALL, ICON_SMALL2, WM_SETICON,
    };

    pub(super) fn apply(
        window: &tauri::WebviewWindow,
        background: u32,
        foreground: u32,
    ) -> Result<(), String> {
        // The configured product name is only a bootstrap fallback. Strip it
        // without erasing a secondary window's useful task context when a
        // theme change reapplies these colours later.
        let current_title = window.title().map_err(|error| error.to_string())?;
        let title = super::native_window_title(&current_title);
        if title != current_title {
            window.set_title(title).map_err(|error| error.to_string())?;
        }
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            // WM_SETICON distinguishes the small caption icon from the large
            // Alt+Tab/taskbar identity. Remove only the two small variants.
            SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), None);
            SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL2 as usize)), None);
        }
        for (attribute, color) in [
            (DWMWA_CAPTION_COLOR, background),
            (DWMWA_TEXT_COLOR, foreground),
        ] {
            unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    attribute,
                    std::ptr::from_ref(&color).cast::<c_void>(),
                    std::mem::size_of_val(&color) as u32,
                )
            }
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{colorref, native_window_title};

    #[test]
    fn converts_web_hex_to_windows_colorref_bgr_order() {
        assert_eq!(colorref("#123456").unwrap(), 0x0056_3412);
    }

    #[test]
    fn rejects_non_six_digit_colours() {
        assert!(colorref("oklch(1 0 0)").is_err());
        assert!(colorref("#fff").is_err());
    }

    #[test]
    fn removes_only_the_product_prefix_from_native_titles() {
        assert_eq!(native_window_title("Dure"), "");
        assert_eq!(native_window_title("Dure — UI polish"), "UI polish");
        assert_eq!(native_window_title("Dure - Agent"), "Agent");
        assert_eq!(native_window_title("Durely"), "Durely");
    }
}
