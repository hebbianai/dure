use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn live_frames_survive_resize_without_page_redraw() {
    let root = tempfile::Builder::new()
        .prefix("dure-browser-idle-frame-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({
        "resource_id":"browser:idle-frame", "generation":"generation:idle",
        "workspace_id":"workspace:idle"
    }))
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<(), BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let controller = BrowserControllerId::new("idle:human").unwrap();
        let lease = runtime
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        for sample in 0..30 {
            let (width, height) = [
                (672, 344),
                (671, 343),
                (671, 344),
                (672, 343),
                (480, 810),
                (1280, 633),
            ][sample % 6];
            apply(
                &runtime,
                &lease,
                &page,
                json!({"kind":"environment","action":{
                    "kind":"viewport", "width":width, "height":height, "scale":1, "mobile":false
                }}),
            )
            .await?;
            let before = runtime.control().await;
            let started = std::time::Instant::now();
            let frame = runtime.frame(&page).await;
            println!(
                "IDLE_FRAME sample={sample} elapsed={:?} error={:?}",
                started.elapsed(),
                frame.as_ref().err()
            );
            let frame = frame?;
            let pixels = STANDARD
                .decode(frame["base64"].as_str().ok_or("frame_missing")?)
                .map_err(|_| "frame_invalid")?;
            let size = dimensions(&pixels, true);
            if size != (width, height)
                || frame["viewport"]["width"].as_f64() != Some(f64::from(width))
                || frame["viewport"]["height"].as_f64() != Some(f64::from(height))
                || frame["viewport"]["pixel_ratio"].as_f64() != Some(1.0)
            {
                return Err("resized_frame_geometry_incorrect".into());
            }
            if runtime.control().await != before {
                return Err("resized_frame_changed_control".into());
            }
        }
        Ok(())
    }
    .await;
    let closed = runtime.close(&identity).await;
    println!(
        "IDLE_FRAME_RETIRED root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    result.unwrap();
}
