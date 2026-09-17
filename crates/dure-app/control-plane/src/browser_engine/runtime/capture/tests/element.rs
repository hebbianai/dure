use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn element_and_annotated_captures_preserve_page_and_bind_references() {
    let root = tempfile::Builder::new()
        .prefix("dure-element-capture-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(
        json!({"resource_id":"capture:element","generation":"g","workspace_id":"w"}),
    )
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime.request_control(BrowserControllerId::new("capture-agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":400,"height":600,"scale":2,"mobile":true}})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.head.innerHTML='<meta name=viewport content=\"width=device-width,initial-scale=1\">';document.body.innerHTML='<button id=entry style=\"position:absolute;left:40px;top:280px;width:160px;height:60px;border:0;background:rgb(0,220,90)\">한글 선택</button><button style=\"position:absolute;top:1100px\">Below viewport</button>';document.body.style.cssText='margin:0;height:1200px;background:white';window.mutations=0;new MutationObserver(records=>window.mutations+=records.length).observe(document.documentElement,{subtree:true,childList:true,attributes:true});window.OffscreenCanvas=function(){throw Error('page canvas constructor');};scrollTo(0,200);true"})).await?;
        let before = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({x:scrollX,y:scrollY,mutations:window.mutations,html:document.documentElement.outerHTML})"})).await?;
        let original = runtime.snapshot(&page,&Default::default()).await?;
        let element = original.data["refs"].as_object().unwrap().iter().find(|(_, value)| value["name"] == "한글 선택").ok_or("capture_fixture_reference_missing")?.0.clone();
        let reference = json!({"snapshot":original.snapshot,"element":element});
        let mut receipts = Vec::new();
        for (name, options, expected) in [
            ("element.png",json!({"target":{"kind":"css","selector":"#entry"}}),(320,120)),
            ("reference.png",json!({"target":{"kind":"reference","reference":reference}}),(320,120)),
            ("annotated.png",json!({"annotate":true,"target":{"kind":"reference","reference":reference}}),(320,120)),
            ("annotated-viewport.png",json!({"annotate":true}),(800,1200)),
            ("annotated-full.png",json!({"annotate":true,"full_page":true}),(800,2400)),
            ("annotated-full-selection.png",json!({"annotate":true,"full_page":true,"target":{"kind":"css","selector":"#entry"}}),(800,2400)),
            ("annotated.jpeg",json!({"annotate":true,"format":"jpeg","quality":30,"target":{"kind":"css","selector":"#entry"}}),(320,120)),
        ] {
            let control = runtime.control().await;
            let capture = runtime.capture_image(&page,&serde_json::from_value(options.clone()).unwrap()).await?;
            let size = dimensions(&capture.file.bytes,name.ends_with("jpeg"));
            if size != expected { println!("CAPTURE_SIZE name={name} size={size:?} expected={expected:?}"); return Err("capture_fixture_wrong_size".into()); }
            std::fs::write(root.join(name),&capture.file.bytes).unwrap();
            if runtime.control().await.controller != control.controller { return Err("capture_fixture_control_changed".into()); }
            if options["annotate"] == true {
                let snapshot = capture.snapshot.as_ref().ok_or("capture_fixture_snapshot_missing")?;
                let annotation = capture.annotations.iter().find(|value| value["name"] == "한글 선택").ok_or("capture_fixture_annotation_missing")?;
                let target = json!({"kind":"reference","reference":{"snapshot":snapshot,"element":annotation["element"]}});
                let value = runtime.query(&page,&serde_json::from_value(json!({"kind":"text","target":target})).unwrap()).await?;
                if value["data"]["text"] != "한글 선택" { return Err("capture_fixture_reference_not_bound".into()); }
            }
            if name == "annotated-full-selection.png" && capture.annotations.len() != 1 { return Err("capture_fixture_annotation_scope_ignored".into()); }
            receipts.push(json!({"file":name,"viewport":capture.viewport,"snapshot":capture.snapshot,"annotations":capture.annotations}));
        }
        let stale = runtime.capture_image(&page,&serde_json::from_value(json!({"target":{"kind":"reference","reference":reference}})).unwrap()).await;
        if !matches!(stale,Err(BrowserRuntimeError::Admission(hmux_host::browser_resource::BrowserAdmissionError::SnapshotChanged))) { return Err("capture_fixture_stale_reference_accepted".into()); }
        let missing = runtime.capture_image(&page,&serde_json::from_value(json!({"target":{"kind":"css","selector":"#missing"}})).unwrap()).await;
        if missing.is_ok() { return Err("capture_fixture_missing_element_accepted".into()); }
        let after = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({x:scrollX,y:scrollY,mutations:window.mutations,html:document.documentElement.outerHTML})"})).await?;
        if before != after { println!("CAPTURE_STATE before={before} after={after}"); return Err("capture_fixture_page_mutated".into()); }
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"const c=document.createElement('canvas');c.width=800;c.height=1200;c.style.cssText='position:absolute;left:0;top:200px;width:400px;height:600px';document.body.append(c);const ctx=c.getContext('2d');const pixels=ctx.createImageData(800,1200);let v=12345;for(let i=0;i<pixels.data.length;i++){v^=v<<13;v^=v>>>17;v^=v<<5;pixels.data[i]=i%4===3?255:v&255;}ctx.putImageData(pixels,0,0);true"})).await?;
        let large = runtime.capture_image(&page,&serde_json::from_value(json!({"annotate":true})).unwrap()).await?;
        if large.file.bytes.len() <= 2 * 1024 * 1024 || dimensions(&large.file.bytes,false) != (800,1200) { return Err("capture_fixture_bulk_image_missing".into()); }
        std::fs::write(root.join("annotated-large.png"),&large.file.bytes).unwrap();
        receipts.push(json!({"file":"annotated-large.png","bytes":large.file.bytes.len(),"annotations":large.annotations}));
        println!("BROWSER_ELEMENT_CAPTURES {}",json!({"root":root,"captures":receipts,"state":after}));
        Ok(())
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_ELEMENT_CAPTURES_RETIRED root={} result={result:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    result.unwrap();
}
