//! Shared macOS window-capture primitives.
//!
//! `design_mode.rs` (element screenshots of the design-mode browser window) and
//! `feedback_capture.rs` (whole-window screenshots of the app's own window) both
//! need to resolve a `WebviewWindow` to the `CGWindowID` `screencapture -l`
//! expects (`window_number`) and read the physical size back out of a captured
//! PNG (`png_size`); `crop_args` turns a crop rectangle into `sips` arguments
//! and is `design_mode.rs`'s own step, kept alongside the other two as the same
//! class of capture primitive rather than split into its own file.

use tauri::Runtime;

/// 창 이미지 안에서 잘라낼 영역(physical px).
///
/// 크롬(타이틀바) 높이를 `inner_position - outer_position`으로 구하지 않는다. 실측
/// (2026-07-30)에서 그 값으로 자르면 요소가 ~20 CSS px 아래로 밀려 잘렸다. 대신
/// **찍힌 이미지 크기와 콘텐츠 크기의 차이**로 계산한다 — 이미지가 진실이므로
/// 데코레이션 semantics를 추측하지 않아도 된다.
pub(crate) fn crop_args(
    image: (i64, i64),
    inner_logical: (f64, f64),
    scale: f64,
    rect: (f64, f64, f64, f64),
) -> (i64, i64, i64, i64) {
    let (img_w, img_h) = image;
    let content_w = inner_logical.0 * scale;
    let content_h = inner_logical.1 * scale;
    // 좌우 크롬은 대개 0이고 있으면 양쪽으로 나뉜다. 위 크롬(타이틀바)은 전부 위에 있다.
    let chrome_left = ((img_w as f64 - content_w) / 2.0).max(0.0);
    let chrome_top = (img_h as f64 - content_h).max(0.0);
    let (x, y, w, h) = rect;
    (
        (chrome_left + x * scale).round() as i64,
        (chrome_top + y * scale).round() as i64,
        (w * scale).round() as i64,
        (h * scale).round() as i64,
    )
}

/// PNG 헤더에서 크기를 읽는다(IHDR). 이미지 처리 의존성을 넣지 않기 위한 것이다.
pub(crate) fn png_size(path: &std::path::Path) -> Result<(i64, i64), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("png_read_failed: {e}"))?;
    if bytes.len() < 24 || &bytes[1..4] != b"PNG" {
        return Err("png_not_recognized".to_string());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok((width as i64, height as i64))
}

/// NSWindow의 windowNumber = CGWindowID. order-in 전이면 0 이하가 나온다.
#[cfg(target_os = "macos")]
pub(crate) fn window_number<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<isize, String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let ptr = window
        .ns_window()
        .map_err(|e| format!("ns_window_failed: {e}"))?;
    if ptr.is_null() {
        return Err("ns_window_null".to_string());
    }
    let number: isize = unsafe { msg_send![ptr.cast::<AnyObject>(), windowNumber] };
    if number <= 0 {
        // 아직 화면에 올라오지 않았다 — 이 상태로 찍으면 빈 이미지가 된다.
        return Err("window_not_ordered_in".to_string());
    }
    Ok(number)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn window_number<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<isize, String> {
    Err("screenshot_unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    // 이 계산이 틀리면 엉뚱한 부분이 잘리고, 잘린 그림이 그럴듯해 보이면 알아채기
    // 어렵다(그래서 크기만 맞는 것으로 만족하면 안 된다).
    // 크롬 높이를 이미지 크기에서 역산한다 — 데코레이션 semantics를 추측하지 않는다.
    #[test]
    fn crops_using_the_captured_image_size() {
        // Retina, 콘텐츠 1200x880 CSS = 2400x1760 physical, 이미지 2400x1816
        // → 타이틀바 56 physical.
        assert_eq!(
            super::crop_args((2400, 1816), (1200.0, 880.0), 2.0, (10.0, 20.0, 55.0, 29.0)),
            (20, 96, 110, 58)
        );
        // 1x, 이미지가 콘텐츠보다 28 높음(타이틀바), 좌우 크롬 없음.
        assert_eq!(
            super::crop_args((800, 628), (800.0, 600.0), 1.0, (5.0, 5.0, 10.0, 10.0)),
            (5, 33, 10, 10)
        );
        // 좌우 크롬이 있으면 양쪽으로 나눈다.
        assert_eq!(
            super::crop_args((810, 628), (800.0, 600.0), 1.0, (0.0, 0.0, 10.0, 10.0)),
            (5, 28, 10, 10)
        );
    }
}
