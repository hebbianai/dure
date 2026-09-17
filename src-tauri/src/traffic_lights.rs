//! macOS 신호등(닫기·최소화·확대) 버튼의 수직 위치.
//!
//! 창은 `titleBarStyle: "Overlay"`(tauri.macos.conf.json)라 이 버튼들은 우리가
//! 그리는 게 아니라 macOS가 타이틀바에 얹는 네이티브 버튼이다. 기본 위치는
//! 창 위에서 중심 14px(28px 타이틀바 기준)이고, 우리 chrome 줄은 44px이라
//! 그대로 두면 워드마크·사이드바 토글보다 위로 치우친다.
//!
//! **버튼 위치를 계산으로 맞추려 하지 않는다.** 두 번 틀렸다(2026-08-07 실측):
//!
//! 1. `NSTitlebarAccessoryViewController`로 타이틀바를 키우기 — 이 창은
//!    `fullSizeContentView`라 macOS가 버튼 영역을 기본 높이로 유지한다. 버튼이
//!    1px도 움직이지 않았다.
//! 2. `NSTitlebarContainerView`를 키우고 버튼이 그 안에서 세로 중앙에 놓인다고
//!    가정하기 — 버튼은 컨테이너 **아래쪽**에 고정돼 있어서, 높이를 16 키우자
//!    중심이 14에서 약 29로 거의 16만큼 통째로 내려갔다.
//!
//! 그래서 지금은 **재서 옮긴다**: 버튼의 현재 중심을 창 좌표로 읽고, 목표와의
//! 차이만큼만 프레임을 민다. 컨테이너의 자연 높이도, 버튼이 무엇에 고정돼
//! 있는지도 알 필요가 없다. 적용 후에는 차이가 0이라 반복 호출이 무해하다.
//!
//! 가로도 같은 방법으로 맞춘다. 셋을 같은 delta로 함께 밀어 버튼 사이 간격은
//! 건드리지 않는다 — 간격은 macOS가 정한 값 그대로 둔다.
//!
//! macOS는 리사이즈·전체화면 전환에서 이 프레임을 되돌리므로 호출부가 그때마다
//! 다시 부른다 — 한 번만 걸고 끝나는 성질이 아니다.

/// 신호등 중심을 창 위에서 `center`px, 왼쪽에서 `left`px 지점에 놓고,
/// 옮긴 뒤 셋 중 가장 오른쪽 끝을 창 왼쪽 기준 px로 돌려준다.
///
/// 끝 위치를 돌려주는 이유: 워드마크를 그 뒤 일정 간격에 붙이려면 신호등이
/// 실제로 어디서 끝나는지 알아야 하는데, 버튼 지름과 간격은 macOS가 정하고
/// 버전마다 흔들린다. 프런트가 상수로 추측하는 대신 실측값을 쓴다.
/// macOS가 아니거나 버튼을 못 찾으면 `None`.
#[tauri::command]
pub async fn set_traffic_light_drop(
    window: tauri::WebviewWindow,
    center: f64,
    left: f64,
) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(macos::apply(&target, center, left));
            })
            .map_err(|error| error.to_string())?;
        rx.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, center, left);
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    pub(super) fn apply(
        window: &tauri::WebviewWindow,
        center: f64,
        left: f64,
    ) -> Result<Option<f64>, String> {
        if center <= 0.0 && left <= 0.0 {
            return Ok(None);
        }
        let window_ptr = window.ns_window().map_err(|error| error.to_string())?;
        if window_ptr.is_null() {
            return Err("Could not obtain the window's NSWindow".into());
        }
        unsafe {
            let ns_window = &*(window_ptr as *const NSWindow);
            let buttons: Vec<_> = [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .filter_map(|kind| ns_window.standardWindowButton(kind))
            .collect();
            // 전체화면에서는 macOS가 버튼을 떼어 간다 — 복귀하면 다시 부른다.
            let Some(first) = buttons.first() else {
                return Ok(None);
            };

            // 창 좌표(원점은 왼쪽 아래)에서 잰 현재 중심을 위에서의 거리로 바꾼다.
            let in_window = first.convertRect_toView(first.bounds(), None);
            let window_height = ns_window.frame().size.height;
            // 세로: 창 좌표는 아래가 원점이라 위에서의 거리로 바꿔 잰다.
            let current_center = window_height - (in_window.origin.y + in_window.size.height / 2.0);
            let dy = if center > 0.0 { current_center - center } else { 0.0 };
            // 가로: 기준은 맨 왼쪽 버튼(닫기)의 중심이다.
            let current_left = in_window.origin.x + in_window.size.width / 2.0;
            let dx = if left > 0.0 { left - current_left } else { 0.0 };
            // 이미 맞으면 옮기지 않는다 — 리사이즈마다 같은 값을 다시 쓰지 않는다.
            // 끝 위치는 그래도 재서 돌려준다(호출부가 매번 필요로 한다).
            if dy.abs() >= 0.5 || dx.abs() >= 0.5 {
                for button in &buttons {
                    let mut frame = button.frame();
                    // 위로 올리는 것이 y 증가다(아래가 원점). dy가 양수면 너무 낮다.
                    frame.origin.y += dy;
                    // 셋을 같은 값으로 민다 — 버튼 사이 간격은 macOS 값을 유지한다.
                    frame.origin.x += dx;
                    button.setFrame(frame);
                }
            }

            // 옮긴 뒤의 오른쪽 끝. 버튼 순서를 믿지 않고 최댓값을 쓴다.
            let right = buttons
                .iter()
                .map(|button| {
                    let rect = button.convertRect_toView(button.bounds(), None);
                    rect.origin.x + rect.size.width
                })
                .fold(f64::MIN, f64::max);
            Ok(Some(right))
        }
    }
}
