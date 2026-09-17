use super::*;

mod scrollbars;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn frame_viewport_maps_human_input_to_the_same_page_across_device_scales() {
    let root = tempfile::Builder::new()
        .prefix("dure-browser-pane-frame-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({"resource_id":"browser:pane-frame","generation":"generation:frame","workspace_id":"workspace:frame"})).unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<Value, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let agent = BrowserControllerId::new("frame:agent").unwrap();
        let human = BrowserControllerId::new("frame:human").unwrap();
        let mut lease = runtime.request_control(agent.clone(), None).await?.controller.ok_or("frame_lease_missing")?;
        let mut evidence = Vec::new();
        for scale in [1, 2] {
            apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":400,"height":600,"scale":scale,"mobile":false}})).await?;
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.style.cssText='margin:0;overflow:hidden';document.body.innerHTML='<button style=\"position:absolute;left:160px;top:140px;width:80px;height:40px\" onclick=\"window.clicks++\">계속</button><input style=\"position:absolute;left:100px;top:240px;width:200px;height:40px\">';window.clicks=0;true"})).await?;
            let before = runtime.control().await;
            let frame = runtime.screenshot(&page).await?;
            let after = runtime.control().await;
            if before != after { return Err("frame_capture_changed_control".into()); }
            let width = frame["viewport"]["width"].as_f64().ok_or("browser_frame_viewport_missing")?;
            let height = frame["viewport"]["height"].as_f64().ok_or("browser_frame_viewport_missing")?;
            if width != 400.0 || height != 600.0 { return Err("browser_frame_viewport_incorrect".into()); }
            let pixels = STANDARD.decode(frame["base64"].as_str().ok_or("frame_pixels_missing")?).map_err(|_|"frame_pixels_invalid")?;
            let size = dimensions(&pixels,false);
            let live = runtime.frame(&page).await?;
            let live_pixels=STANDARD.decode(live["base64"].as_str().ok_or("frame_pixels_missing")?).map_err(|_|"frame_pixels_invalid")?;
            let live_size = dimensions(&live_pixels,true);
            let live_ratio = live["viewport"]["pixel_ratio"].as_f64().ok_or("frame_viewport_missing")?;
            if live_size != (400,600) || live["viewport"]["width"] != frame["viewport"]["width"]
                || live["viewport"]["height"] != frame["viewport"]["height"] || live_ratio != 1.0 {
                return Err("live_compositor_geometry_incorrect".into());
            }
            if size != (400 * scale,600 * scale) { return Err("frame_density_incorrect".into()); }
            std::fs::write(root.join(format!("frame-{scale}.png")), &pixels).map_err(|_|"frame_fixture_write_failed")?;
            let human_lease = runtime.request_control(human.clone(),Some(&lease)).await?.controller.ok_or("frame_handoff_missing")?;
            if human_lease.controller_id != human { return Err("frame_handoff_pending".into()); }
            // A 200x300 pane shows this same 400x600 CSS viewport at both
            // physical densities. Image pixel dimensions must not scale input.
            for (display_x,display_y) in [(100.0,80.0),(100.0,130.0)] {
                let x=display_x * width / 200.0;
                let y=display_y * height / 300.0;
                for kind in ["down","up"] {
                    apply(&runtime,&human_lease,&page,json!({"kind":"mouse","action":{"kind":kind,"button":"left","x":x,"y":y}})).await?;
                }
            }
            apply(&runtime,&human_lease,&page,json!({"kind":"insert_text","text":"한글 인계"})).await?;
            lease=runtime.request_control(agent.clone(),Some(&human_lease)).await?.controller.ok_or("frame_return_missing")?;
            if lease.controller_id != agent { return Err("frame_return_pending".into()); }
            let observed=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({clicks:window.clicks,text:document.querySelector('input').value})"})).await?;
            if observed != json!({"clicks":1,"text":"한글 인계"}) { return Err("frame_input_missed_page".into()); }
            evidence.push(json!({"scale":scale,"page":page,"viewport":frame["viewport"],"pixels":size,"state":observed,"controller":lease}));
        }
        Ok(json!(evidence))
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_PANE_FRAME root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    result.unwrap();
}
