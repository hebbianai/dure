#[tauri::command]
pub async fn toggle_window_maximize_atomic(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let completion = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
        let target = window.clone();
        let main_completion = completion.clone();
        window
            .run_on_main_thread(move || {
                if let Err(error) = macos::toggle(&target, main_completion.clone()) {
                    complete(&main_completion, Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "native maximize completion was dropped".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())
        } else {
            window.maximize().map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
pub async fn observe_current_window_live_resize(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(macos::observe_live_resize(&target));
            })
            .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "native live-resize observation was dropped".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
type MaximizeCompletion =
    std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>;

#[cfg(target_os = "macos")]
fn complete(completion: &MaximizeCompletion, result: Result<(), String>) {
    if let Some(sender) = completion
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        let _ = sender.send(result);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::{RcBlock, StackBlock};
    use objc2::ffi::{objc_getAssociatedObject, objc_setAssociatedObject, OBJC_ASSOCIATION_ASSIGN};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
    use objc2_app_kit::{
        NSAnimationContext, NSWindow, NSWindowDidEndLiveResizeNotification,
        NSWindowWillCloseNotification, NSWindowWillStartLiveResizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use serde::Serialize;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use tauri::{Emitter, EventTarget};

    use super::{complete, MaximizeCompletion};

    const WINDOW_LIVE_RESIZE_EVENT: &str = "dure://window-live-resize";
    static LIVE_RESIZE_OBSERVER_KEY: u8 = 0;

    #[derive(Clone, Copy, Serialize)]
    #[serde(rename_all = "snake_case")]
    enum LiveResizePhase {
        Begin,
        End,
    }

    pub(super) fn toggle(
        window: &tauri::WebviewWindow,
        completion: MaximizeCompletion,
    ) -> Result<(), String> {
        let window_ptr = window.ns_window().map_err(|error| error.to_string())?;
        if window_ptr.is_null() {
            return Err("native window is unavailable".to_string());
        }
        let native_window = unsafe { &*(window_ptr as *const NSWindow) };
        let changes = StackBlock::new(|_: NonNull<NSAnimationContext>| {
            native_window.zoom(None);
        });
        let completed = RcBlock::new(move || complete(&completion, Ok(())));
        NSAnimationContext::runAnimationGroup_completionHandler(&changes, Some(&completed));
        Ok(())
    }

    pub(super) fn observe_live_resize(window: &tauri::WebviewWindow) -> Result<bool, String> {
        let window_ptr = window.ns_window().map_err(|error| error.to_string())?;
        if window_ptr.is_null() {
            return Err("native window is unavailable".to_string());
        }
        let native_window = unsafe { &*(window_ptr as *const NSWindow) };
        let key = std::ptr::addr_of!(LIVE_RESIZE_OBSERVER_KEY).cast::<c_void>();
        let object = window_ptr.cast::<AnyObject>();
        let installed = unsafe { !objc_getAssociatedObject(object, key).is_null() };
        if !installed {
            install_live_resize_observers(window, native_window);
            unsafe {
                objc_setAssociatedObject(object, key, object, OBJC_ASSOCIATION_ASSIGN);
            }
        }
        Ok(native_window.inLiveResize())
    }

    fn install_live_resize_observers(window: &tauri::WebviewWindow, native_window: &NSWindow) {
        let center = NSNotificationCenter::defaultCenter();
        let native_object = unsafe { &*(native_window as *const NSWindow as *const AnyObject) };
        let retained_tokens = Arc::new(Mutex::new(Vec::<usize>::new()));

        let begin_window = window.clone();
        let begin = RcBlock::new(move |_: NonNull<NSNotification>| {
            emit_live_resize(&begin_window, LiveResizePhase::Begin);
        });
        let begin_token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowWillStartLiveResizeNotification),
                Some(native_object),
                None,
                &begin,
            )
        };
        retain_token(begin_token, &retained_tokens);

        let end_window = window.clone();
        let end = RcBlock::new(move |_: NonNull<NSNotification>| {
            emit_live_resize(&end_window, LiveResizePhase::End);
        });
        let end_token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidEndLiveResizeNotification),
                Some(native_object),
                None,
                &end,
            )
        };
        retain_token(end_token, &retained_tokens);

        let close_tokens = Arc::clone(&retained_tokens);
        let close = RcBlock::new(move |_: NonNull<NSNotification>| {
            remove_tokens(&close_tokens);
        });
        let close_token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowWillCloseNotification),
                Some(native_object),
                None,
                &close,
            )
        };
        retain_token(close_token, &retained_tokens);
    }

    fn retain_token(
        token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
        retained_tokens: &Arc<Mutex<Vec<usize>>>,
    ) {
        let token = unsafe { Retained::cast_unchecked::<AnyObject>(token) };
        let pointer = Retained::into_raw(token);
        retained_tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(pointer as usize);
    }

    fn remove_tokens(retained_tokens: &Arc<Mutex<Vec<usize>>>) {
        let addresses = std::mem::take(
            &mut *retained_tokens
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let center = NSNotificationCenter::defaultCenter();
        for address in addresses {
            let Some(token) =
                (unsafe { Retained::<AnyObject>::from_raw(address as *mut AnyObject) })
            else {
                continue;
            };
            unsafe { center.removeObserver(&token) };
        }
    }

    fn emit_live_resize(window: &tauri::WebviewWindow, phase: LiveResizePhase) {
        let _ = window.emit_to(
            EventTarget::webview_window(window.label()),
            WINDOW_LIVE_RESIZE_EVENT,
            phase,
        );
    }
}
