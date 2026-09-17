use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PROOF_ENV: &str = "DURE_QA_WEBVIEW_STORAGE_PROOF";

fn admit(proof: &str) -> Result<(), String> {
    if !cfg!(debug_assertions)
        || proof.is_empty()
        || proof.len() > 64
        || !proof.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || std::env::var(PROOF_ENV).ok().as_deref() != Some(proof)
    {
        return Err("WebView storage probe is not enabled for this run".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn storage_snapshot(
    window: WebviewWindow,
    proof: String,
) -> Result<Option<[u8; 16]>, String> {
    admit(&proof)?;
    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, rc::Retained, runtime::AnyObject, sel};
        use objc2_foundation::NSUUID;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window.with_webview(move |webview| {
            // Tauri schedules this closure on the main thread. Read public WK APIs
            // only; do not enumerate, read or modify any website data here.
            let observed = unsafe {
                let view = webview.inner().cast::<AnyObject>();
                let configuration: *mut AnyObject = msg_send![view, configuration];
                let store: *mut AnyObject = msg_send![configuration, websiteDataStore];
                let available: bool = msg_send![store, respondsToSelector: sel!(identifier)];
                if available {
                    let identifier: Option<Retained<NSUUID>> = msg_send![store, identifier];
                    Ok(identifier.map(|identifier| identifier.as_bytes()))
                } else {
                    Err("WKWebsiteDataStore identifier requires macOS 14 or later".to_string())
                }
            };
            let _ = sender.send(observed);
        }).map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("WKWebsiteDataStore probe requires macOS".into())
    }
}

#[tauri::command]
pub(super) async fn storage_native_peer(app: AppHandle, proof: String) -> Result<(), String> {
    admit(&proof)?;
    let config = crate::webview_storage::window_config(
        app.config(),
        "win-storage-native",
        WebviewUrl::App(format!("src/qa/webviewStorage.html?proof={proof}&role=native").into()),
    )?;
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|error| error.to_string())?
        .visible(false)
        .focused(false)
        .focusable(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}
