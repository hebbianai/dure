#[tauri::command]
pub async fn read_terminal_clipboard(
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(read());
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())??
}

#[cfg(target_os = "ios")]
fn read() -> Result<Option<serde_json::Value>, String> {
    crate::clipboard_ios::read()?
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "ios"))]
fn read() -> Result<Option<serde_json::Value>, String> {
    Err("Native clipboard reading is available on iOS".into())
}
