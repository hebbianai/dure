//! 셸 창의 네이티브 모서리 반경.
//!
//! 창 유리는 `windowEffects`가 만드는 `NSVisualEffectView`가 그리고, 그 뷰의
//! `cornerRadius`가 창 모서리를 깎는다. 전체화면에서는 그 반경이 0이어야 하는데
//! 프런트엔드에서 `setEffects`를 다시 부르는 방법으로는 고칠 수 없다:
//!
//! - `window-vibrancy::apply_vibrancy`는 호출할 때마다 **새** effect 뷰를 만들어
//!   `addSubview:positioned:relativeTo:`로 붙이기만 하고 기존 뷰를 지우지 않는다.
//!   게다가 새 뷰를 `Below`로 넣어서, 반경이 남아 있는 옛 뷰가 위에 그대로 남는다.
//! - Tauri의 `clearEffects`는 macOS 분기가 없다 — `set_window_effects`의 `else`
//!   가지가 `#[cfg(windows)]` 하나뿐이라 macOS에서는 아무 일도 하지 않는다.
//!
//! 그래서 뷰를 갈아 끼우는 대신 이미 붙어 있는 그 뷰를 태그로 찾아 반경만
//! 바꾼다. 뷰가 하나로 유지되므로 겹침도, material 재설정도 없다.
//!
//! 태그 값은 window-vibrancy가 자기 뷰에 박는 상수다(`NS_VIEW_TAG_BLUR_VIEW`).
//! 크레이트가 공개하지 않아 여기 복제해 두는데, 어긋나면 뷰를 못 찾아 반경이
//! 그대로 남을 뿐 창이 사라지거나 입력이 막히지는 않는다 — 실패는 조용하다.

/// window-vibrancy가 자기 effect 뷰에 박는 태그.
#[cfg(target_os = "macos")]
const NS_VIEW_TAG_BLUR_VIEW: isize = 91_376_254;

/// NSVisualEffectMaterial 원시값. objc2-app-kit이 이 enum을 내보내지 않아
/// AppKit 헤더 값을 그대로 쓴다 — 창 생성 옵션(tauri.macos.conf.json)의
/// `"menu"`와 같은 값이어야 첫 프레임과 이어진다.
#[cfg(target_os = "macos")]
const MATERIAL_MENU: isize = 5;
#[cfg(target_os = "macos")]
const MATERIAL_HUD_WINDOW: isize = 13;

/// 셸 유리(NSVisualEffectView)의 네이티브 속성을 앱 상태에 맞춘다.
///
/// - `radius`: 창 모서리. 전체화면은 0, 창 모드는 셸의 CSS 반경.
/// - `dark`: 유리 material의 외형. 창 NSAppearance를 앱 테마에 맞춰도
///   (windowAppearance.ts) 이 뷰까지 전파되지 않는 경우가 있어 직접 박는다.
///   2026-08-02 실측: 앱이 다크인데 셸 유리가 rgb(148)로 렌더됐고, 틴트
///   #4a4a4a를 55%로 칠한 결과를 역산하면 뷰가 약 238(거의 흰색)을 내고
///   있었다 — 라이트 material이 다크 UI 뒤에 깔린 것이다.
#[tauri::command]
pub async fn set_shell_glass(
    window: tauri::WebviewWindow,
    radius: f64,
    dark: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(macos::apply(&target, radius, dark));
            })
            .map_err(|error| error.to_string())?;
        rx.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, radius, dark);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSView,
    };

    pub(super) fn apply(
        window: &tauri::WebviewWindow,
        radius: f64,
        dark: bool,
    ) -> Result<(), String> {
        let view_ptr = window.ns_view().map_err(|error| error.to_string())?;
        if view_ptr.is_null() {
            return Err("Could not obtain the window's NSView".into());
        }
        unsafe {
            let view = &*(view_ptr as *const NSView);
            let Some(blur) = view.viewWithTag(super::NS_VIEW_TAG_BLUR_VIEW) else {
                // 유리가 아직 안 붙었거나 크레이트가 태그를 바꾼 경우다. 모서리와
                // 외형이 예전 값으로 남을 뿐이라 실패로 올리지 않는다.
                return Ok(());
            };
            // NSVisualEffectView의 비공개 접근자 — window-vibrancy가 반경을 거는
            // 바로 그 경로다. 우리는 같은 뷰의 같은 속성만 갱신한다.
            let () = msg_send![&*blur, setCornerRadius: radius];
            // material의 밝기는 이 뷰의 NSAppearance가 정한다. 창에만 걸면
            // 어긋나는 경우가 있어 뷰에 직접 박는다 — 어긋나면 다크 UI 뒤에
            // 라이트 material이 깔려 사이드바가 통째로 밝게 씻긴다.
            let name = if dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            };
            blur.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
            // material도 외형마다 다르다. 하나로는 두 모드를 못 맞춘다 —
            // 2026-08-02 실측(창 뒤 배경 rgb 41 기준, 다크):
            //   sidebar  → 출력 16  어둡지만 뒤를 통과시키지 않는다
            //   menu     → 출력 88  통과는 하지만 배경보다 밝게 올린다
            // 목표(네이티브 앱 실측)는 45 — 배경보다 겨우 4 높다. menu로는
            // 알파를 0으로 해도 88이라 닿을 수 없다.
            //
            // underWindowBackground를 먼저 넣었다가 popover로 바꿨다. 밝기는
            // 맞았지만 "형체가 안 보인다"가 남았는데, 재 보니 투과되는 것은
            // 휘도가 아니라 **색**이었다 — 네이티브 앱은 뒤 코드의 구문 강조가
            // B-R 4~18로 번지는데 우리는 0~5였다. underWindowBackground는 바로
            // 그 9종 비교에서 "유리가 회색톤"으로 탈락한 값이라 채도를 죽인다.
            // popover도 아니었다. 그 9종 비교는 **라이트 외형**에서 한 것이고,
            // 같은 material이 다크에서 어떻게 도는지는 예측하지 못한다 — 이
            // 자리에서 세 번 틀린 진짜 이유가 그거다. 다크는 다크에서 재야 한다.
            //
            // hudWindow는 AppKit이 '어두운 반투명 패널'을 위해 두는 material이다.
            // 밝기(어두움)와 채도(색 통과)를 동시에 요구하는 이 자리의 조건에
            // 이름이 아니라 용도가 맞는 유일한 후보다.
            //
            // 라이트는 menu 그대로다: 같은 비교에서 색이 비치면서 색 치우침이
            // 없던 값이다. material을 이름으로 고르지 말 것 — 밝기와 채도를
            // 따로 재야 한다. 이 자리에서 두 번 틀렸다.
            let () = msg_send![
                &*blur,
                setMaterial: if dark { super::MATERIAL_HUD_WINDOW } else { super::MATERIAL_MENU }
            ];
            // 창 그림자를 다시 계산시킨다. macOS는 투명 창의 그림자를 콘텐츠의
            // 알파에서 뽑는데, 그 계산은 창이 만들어질 때 한 번 굳는다. 그 뒤
            // effect 뷰의 모서리를 깎으면 그림자는 여전히 창 *사각형*을 따라가서,
            // 둥근 모서리 바깥에 그림자만 남는다 — 부드러운 그라데이션이 아니라
            // 딱딱한 띠로 읽힌다(2026-08-02 실측: 네이티브 앱은 30px에 걸쳐
            // 229→190으로 번지는데 우리는 25px 평탄한 182 띠였다).
            // invalidateShadow가 지금 콘텐츠 모양으로 다시 뽑게 한다.
            if let Ok(window_ptr) = window.ns_window() {
                if !window_ptr.is_null() {
                    let ns_window = window_ptr as *mut objc2::runtime::AnyObject;
                    let () = msg_send![&*ns_window, invalidateShadow];
                }
            }
        }
        Ok(())
    }
}
