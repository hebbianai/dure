use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn frame_extent_includes_scrollbars_for_exact_pointer_mapping() {
    let root = tempfile::Builder::new()
        .prefix("dure-browser-scrollbar-frame-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({"resource_id":"browser:scrollbars","generation":"generation:frame","workspace_id":"workspace:frame"})).unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<Value, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let controller = BrowserControllerId::new("frame:human").unwrap();
        let lease = runtime.request_control(controller, None).await?.controller.ok_or("frame_lease_missing")?;
        let mut evidence = Vec::new();
        for scale in [1, 2] {
            apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":400,"height":600,"scale":scale,"mobile":false}})).await?;
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.documentElement.style.overflow='scroll';document.body.style.cssText='margin:0;width:1000px;height:2000px';document.body.innerHTML='<button style=\"position:absolute;left:300px;top:300px;width:4px;height:4px;padding:0;border:0\" onclick=\"window.frameClicks++\"></button>';window.frameClicks=0;true"})).await?;
            for jpeg in [false, true] {
                let before = runtime.control().await;
                let frame = if jpeg { runtime.frame(&page).await? } else { runtime.screenshot(&page).await? };
                if before != runtime.control().await { return Err("frame_changed_controller".into()); }
                let pixels=STANDARD.decode(frame["base64"].as_str().ok_or("frame_missing")?).map_err(|_|"frame_invalid")?;
                let size=dimensions(&pixels,jpeg);
                let width=frame["viewport"]["width"].as_f64().ok_or("frame_viewport_missing")?;
                let height=frame["viewport"]["height"].as_f64().ok_or("frame_viewport_missing")?;
                let density=frame["viewport"]["pixel_ratio"].as_f64().ok_or("frame_viewport_missing")?;
                println!("SCROLLBAR_FRAME scale={scale} jpeg={jpeg} pixels={size:?} viewport={}",frame["viewport"]);
                if (width*density).round() as u32 != size.0 || (height*density).round() as u32 != size.1 { return Err("frame_scrollbar_extent_mismatch".into()); }
                let x=302.0*density/f64::from(size.0)*width;
                let y=302.0*density/f64::from(size.1)*height;
                for kind in ["down","up"] { apply(&runtime,&lease,&page,json!({"kind":"mouse","action":{"kind":kind,"button":"left","x":x,"y":y}})).await?; }
                let clicks=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.frameClicks"})).await?;
                if clicks != json!(if jpeg {2} else {1}) { return Err("frame_scrollbar_pointer_missed".into()); }
                evidence.push(json!({"scale":scale,"jpeg":jpeg,"pixels":size,"viewport":frame["viewport"],"clicks":clicks}));
            }
        }
        Ok(json!(evidence))
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "SCROLLBAR_FRAME_RETIRED root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    result.unwrap();
}
