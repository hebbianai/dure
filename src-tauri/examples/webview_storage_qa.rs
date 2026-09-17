//! Process-restart storage proof using Dure's real config and native probe.
//! Only the owned webview-storage runner may launch this hidden fixture.

#[cfg(target_os = "macos")]
#[path = "../src/webview_storage.rs"]
mod webview_storage;
#[cfg(target_os = "macos")]
#[path = "../src/qa/storage_probe.rs"]
mod storage_probe;

#[cfg(target_os = "macos")]
struct ReceiptTarget(std::path::PathBuf);

#[cfg(target_os = "macos")]
#[tauri::command]
fn report_window(
    app: tauri::AppHandle,
    target: tauri::State<'_, ReceiptTarget>,
    report: serde_json::Value,
) -> Result<(), String> {
    use std::io::Write;
    let receipt = serde_json::json!({ "pid": std::process::id(), "report": report });
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&target.0).map_err(|error| error.to_string())?;
    file.write_all(receipt.to_string().as_bytes()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    app.exit(if receipt["report"]["result"] == "passed" { 0 } else { 1 });
    Ok(())
}

#[cfg(target_os = "macos")]
fn main() {
    use tauri::utils::config::{BackgroundThrottlingPolicy, WindowConfig};
    if !cfg!(debug_assertions) {
        panic!("debug fixture required");
    }
    assert_eq!(std::env::var("DURE_QA_LAYER").as_deref(), Ok("background"));
    let root = std::fs::canonicalize(std::env::var("DURE_QA_STATE_ROOT").unwrap()).unwrap();
    assert_eq!(root.parent().unwrap(), std::fs::canonicalize(std::env::temp_dir()).unwrap());
    assert!(root.file_name().unwrap().to_string_lossy().starts_with("dure-webview-storage."));
    let mut arguments = std::env::args().skip(1);
    let origin: tauri::Url = arguments.next().expect("QA origin required").parse().unwrap();
    assert_eq!(origin.scheme(), "http");
    assert_eq!(origin.host_str(), Some("127.0.0.1"));
    assert!(origin.port().is_some());
    let phase = arguments.next().expect("QA phase required");
    assert!(matches!(phase.as_str(), "seed" | "restored" | "isolated"));
    assert!(arguments.next().is_none());
    let proof = std::env::var("DURE_QA_WEBVIEW_STORAGE_PROOF").unwrap();
    assert!(!proof.is_empty() && proof.len() <= 64);
    assert!(proof.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    assert!(std::env::var("DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER").is_ok());

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "dev.dure.webview-storage-qa".into();
    context.config_mut().build.dev_url = Some(origin);
    context.config_mut().app.windows = vec![WindowConfig {
        label: "main".into(),
        title: "Dure storage QA".into(),
        url: tauri::WebviewUrl::App(format!(
            "src/qa/webviewStorage.html?proof={proof}&processPhase={phase}"
        ).into()),
        visible: false,
        focus: false,
        focusable: false,
        background_throttling: Some(BackgroundThrottlingPolicy::Disabled),
        ..Default::default()
    }];
    webview_storage::apply_dev(&mut context).unwrap();
    tauri::Builder::default()
        .manage(ReceiptTarget(root.join("evidence").join(format!("storage-{phase}.json"))))
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        })
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("window-focus-qa")
            .invoke_handler(tauri::generate_handler![
                report_window,
                storage_probe::storage_snapshot,
                storage_probe::storage_native_peer,
            ])
            .build())
        .invoke_handler(tauri::generate_handler![webview_storage::webview_storage_options])
        .run(context)
        .unwrap();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native WebView storage smoke requires macOS");
    std::process::exit(1);
}
