//! macOS 공유 시트 — 파일을 AirDrop·메시지·Telegram·KakaoTalk 등
//! 설치된 공유 확장으로 보낸다 (NSSharingServicePicker).

/// 웹뷰 좌표 (x, y)(CSS px, 좌상단 원점)에 공유 시트를 띄운다.
#[tauri::command]
pub fn share_file(
    window: tauri::WebviewWindow,
    path: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || macos::show_share_picker(&win, &path, x, y))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path, x, y);
        Err("The share sheet is only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

    thread_local! {
        // 피커가 표시되는 동안 해제되지 않도록 메인 스레드에 붙잡아 둔다.
        static ACTIVE_PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> =
            const { RefCell::new(None) };
    }

    pub(super) fn show_share_picker(window: &tauri::WebviewWindow, path: &str, x: f64, y: f64) {
        // run_on_main_thread 안이므로 마커는 항상 얻어진다.
        let Some(_mtm) = MainThreadMarker::new() else { return };
        let Ok(view_ptr) = window.ns_view() else { return };
        if view_ptr.is_null() {
            return;
        }
        unsafe {
            let view = &*(view_ptr as *const NSView);
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let items: Retained<NSArray<AnyObject>> =
                NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(url))]);
            let picker = NSSharingServicePicker::initWithItems(
                NSSharingServicePicker::alloc(),
                &items,
            );
            // 웹뷰는 좌상단 원점, NSView 기본 좌표는 좌하단 원점 — y를 뒤집는다.
            let frame = view.frame();
            let anchor = NSRect {
                origin: NSPoint { x, y: frame.size.height - y },
                size: NSSize { width: 1.0, height: 1.0 },
            };
            picker.showRelativeToRect_ofView_preferredEdge(anchor, view, NSRectEdge::MinY);
            ACTIVE_PICKER.with(|slot| slot.replace(Some(picker)));
        }
    }
}
