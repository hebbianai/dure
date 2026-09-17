use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn same_process_frames_scope_observers_input_and_document_lifetime() {
    scenario(false, false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn out_of_process_frames_scope_observers_input_and_document_lifetime() {
    scenario(true, false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn nested_transformed_local_frames_preserve_input_and_ancestor_occlusion() {
    scenario(false, true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn nested_transformed_remote_frames_preserve_input_and_ancestor_occlusion() {
    scenario(true, true).await;
}

async fn read(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
    query: Value,
) -> Result<Value, BrowserRuntimeError> {
    runtime
        .query(page, &serde_json::from_value(query).unwrap())
        .await
}

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> Result<Value, BrowserRuntimeError> {
    let authority = authority(runtime, lease, page).await;
    let result = runtime
        .action(
            &lease.controller_id,
            &authority,
            serde_json::from_value(action.clone()).unwrap(),
        )
        .await?;
    if !result.response.success {
        println!(
            "BROWSER_FRAME_ACTION_REJECTED action={action} response={:?}",
            result.response
        );
        return Err("fixture_action_rejected".into());
    }
    Ok(result.response.data)
}

async fn scenario(cross_site: bool, nested: bool) {
    let (url, stop, server) = fixture(cross_site, nested).await;
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-frames-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("resource:frames");
    let launched = BrowserRuntime::launch(resource.clone(), &config, &root).await;
    let mut receipts = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let runtime = launched.as_ref().map_err(|_| "fixture_launch_failed")?;
        let lease = runtime.request_control(BrowserControllerId::new("frame-agent").unwrap(), None).await?.controller.ok_or("fixture_controller_missing")?;
        apply(runtime, &lease, &first_page(runtime).await?, json!({"kind":"navigate","url":url})).await?;
        let page = first_page(runtime).await?;
        let root_snapshot = runtime.snapshot(&page, &Default::default()).await?;
        receipts.push(json!({"phase":"root","snapshot":root_snapshot.data}));
        let selected = apply(runtime, &lease, &page, json!({"kind":"frame","target":{"kind":"css","selector":"#child"}})).await?;
        receipts.push(json!({"phase":"selected","result":selected}));
        if nested {
            let selected = apply(runtime, &lease, &page, json!({"kind":"frame","target":{"kind":"css","selector":"#nested"}})).await?;
            receipts.push(json!({"phase":"nested-selected","result":selected}));
        }
        let frame = runtime.host.lock().await.selected_frame(&page)?.ok_or("fixture_frame_missing")?;
        let observed = runtime.observe().await?;
        if observed.pages[0].frame.as_ref() != Some(&frame) || observed.pages[0].frame_error.is_some() { return Err("fixture_frame_selection_not_projected".into()); }
        let source_count = {
            let mut host = runtime.host.lock().await;
            let target = host.target_for(&page)?.clone();
            host.network().sources().iter().filter(|source| host.network().source_target(source) == Some(&target) && host.network().source_engine_target(source).is_some_and(|engine| engine != &target)).count()
        };
        receipts.push(json!({"phase":"sources","child_sources":source_count}));
        if cross_site && source_count == 0 { return Err("fixture_oopif_not_observed".into()); }
        let title = read(runtime, &page, json!({"kind":"title"})).await?;
        let child_url = read(runtime, &page, json!({"kind":"url"})).await?;
        receipts.push(json!({"phase":"query","title":title,"url":child_url}));
        if title["data"]["title"] != "Child document" { return Err("fixture_wrong_frame_title".into()); }
        let snapshot = runtime.snapshot(&page, &Default::default()).await?;
        let reference = click_reference(&snapshot)?;
        receipts.push(json!({"phase":"child-snapshot","snapshot":snapshot.data}));
        if snapshot.data["snapshot"].as_str().is_some_and(|text| text.contains("Top document")) { return Err("fixture_top_leaked_into_snapshot".into()); }
        apply(runtime, &lease, &page, json!({"kind":"fill","target":{"kind":"css","selector":"#field"},"text":"프레임 한글"})).await?;
        let value = read(runtime, &page, json!({"kind":"value","target":{"kind":"css","selector":"#field"}})).await?;
        let evaluated = apply(runtime, &lease, &page, json!({"kind":"evaluate","script":"({marker:window.marker,value:document.querySelector('#field').value,writes:window.writes})"})).await?;
        receipts.push(json!({"phase":"fill-eval","value":value,"evaluation":evaluated}));
        if value["data"]["value"] != "프레임 한글" || evaluated["result"]["marker"] != "child" { return Err("fixture_wrong_frame_input".into()); }
        if nested {
            root_eval(runtime, &page, "const cover=document.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;z-index:999999;background:gray';document.body.append(cover);true").await?;
            let blocked = runtime.action(&lease.controller_id, &authority(runtime, &lease, &page).await, serde_json::from_value(json!({"kind":"click","target":{"kind":"reference","reference":reference}})).unwrap()).await?;
            receipts.push(json!({"phase":"covered","response":blocked.response}));
            if blocked.response.success || blocked.response.error.as_deref() != Some("browser_frame_covered") { return Err("fixture_covered_frame_clicked".into()); }
            root_eval(runtime, &page, "document.querySelector('#cover').remove();true").await?;
        }
        apply(runtime, &lease, &page, json!({"kind":"click","target":{"kind":"reference","reference":reference}})).await?;
        let clicked = apply(runtime, &lease, &page, json!({"kind":"evaluate","script":"window.writes"})).await?;
        receipts.push(json!({"phase":"click","result":clicked}));
        if clicked["result"] != 1 { return Err("fixture_frame_click_missed".into()); }
        let scoped = runtime.snapshot(&page, &serde_json::from_value(json!({"selector":"#form"})).unwrap()).await?;
        receipts.push(json!({"phase":"scoped-snapshot","snapshot":scoped.data}));
        if !scoped.data["snapshot"].as_str().is_some_and(|text| text.contains("Increment")) { return Err("fixture_frame_snapshot_scope_missing".into()); }
        let capture = runtime.capture_image(&page, &serde_json::from_value(json!({"target":{"kind":"css","selector":"button"},"annotate":true})).unwrap()).await?;
        if !capture.annotations.iter().any(|annotation| annotation["name"] == "Increment") { return Err("fixture_frame_annotation_missing".into()); }
        std::fs::write(root.join("frame-annotated.png"), &capture.file.bytes).unwrap();
        receipts.push(json!({"phase":"capture","viewport":capture.viewport,"annotations":capture.annotations,"snapshot":capture.snapshot}));
        let human = BrowserControllerId::new("human:frame").unwrap();
        let human_lease = runtime.request_control(human.clone(), Some(&lease)).await?.controller.ok_or("fixture_handoff_missing")?;
        let stale = runtime.action(&lease.controller_id, &authority(runtime, &lease, &page).await, serde_json::from_value(json!({"kind":"main_frame"})).unwrap()).await;
        if !matches!(stale, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ControllerChanged))) { return Err("fixture_stale_controller_admitted".into()); }
        let retained = read(runtime, &page, json!({"kind":"value","target":{"kind":"css","selector":"#field"}})).await?;
        if retained["data"]["value"] != "프레임 한글" { return Err("fixture_handoff_changed_frame".into()); }
        apply(runtime, &human_lease, &page, json!({"kind":"evaluate","script":"location.reload();true"})).await?;
        timeout(Duration::from_secs(5), async {
            loop {
                runtime.observe().await?;
                let current = runtime.host.lock().await.selected_frame(&page)?;
                if current.as_ref().is_some_and(|current| *current != frame) { return Ok::<_, BrowserRuntimeError>(()); }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_| "fixture_frame_reload_not_observed")??;
        let old = runtime.action(&human, &authority(runtime, &human_lease, &page).await, serde_json::from_value(json!({"kind":"click","target":{"kind":"reference","reference":reference}})).unwrap()).await;
        if !matches!(old, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::SnapshotChanged))) { return Err("fixture_old_frame_reference_admitted".into()); }
        // Simulate the embedding document removing its iframe while a client
        // still has it selected. This fixture actor does not change Host selection.
        root_eval(runtime, &page, "document.querySelector('#child').remove();true").await?;
        let removed = read(runtime, &page, json!({"kind":"title"})).await;
        receipts.push(json!({"phase":"removed","result":format!("{removed:?}")}));
        if !matches!(removed, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::FrameGone))) { return Err("fixture_removed_frame_fell_back".into()); }
        let observed = runtime.observe().await?;
        if observed.pages[0].frame.is_some() || observed.pages[0].frame_error != Some("browser_frame_gone") { return Err("fixture_missing_frame_not_projected".into()); }
        apply(runtime, &human_lease, &page, json!({"kind":"main_frame"})).await?;
        let main = apply(runtime, &human_lease, &page, json!({"kind":"evaluate","script":"({marker:window.marker,value:document.querySelector('#field').value,writes:window.writes})"})).await?;
        receipts.push(json!({"phase":"main","result":main}));
        if main["result"] != json!({"marker":"top","value":"top unchanged","writes":0}) { return Err("fixture_top_document_mutated".into()); }
        Ok(())
    }.await;
    let cleanup = match &launched {
        Ok(runtime) => Some(runtime.close(&resource).await),
        Err(_) => None,
    };
    let _ = stop.send(());
    let server = server.await;
    println!(
        "BROWSER_FRAMES root={} cross_site={cross_site} nested={nested} launch={:?} evidence={evidence:?} receipts={} cleanup={cleanup:?} server={server:?}",
        root.display(),
        launched.as_ref().err(),
        json!(receipts)
    );
    assert!(cleanup.as_ref().is_some_and(Result::is_ok), "{cleanup:?}");
    assert!(server.is_ok(), "{server:?}");
    assert!(evidence.is_ok(), "{evidence:?}");
}

async fn root_eval(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
    script: &str,
) -> Result<(), BrowserRuntimeError> {
    let execution = runtime.execution(page).await?;
    let target = runtime.host.lock().await.target_for(page)?.clone();
    let mut cdp = execution.binding.cdp.clone();
    let session = cdp.attach(target.as_str()).await?;
    cdp.request(
        "Runtime.evaluate",
        json!({"expression":script,"returnByValue":true}),
        Some(&session),
    )
    .await?;
    Ok(())
}

async fn fixture(
    cross_site: bool,
    nested: bool,
) -> (
    String,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{port}");
    let child_host = if cross_site { "localhost" } else { "127.0.0.1" };
    let destination = if nested { "outer" } else { "child" };
    let transform = if nested {
        "transform:perspective(700px) rotateY(12deg) rotateZ(4deg) scale(.9);"
    } else {
        ""
    };
    let top = format!(
        "<!doctype html><meta charset=utf-8><title>Top document</title><input id=field value='top unchanged'><button onclick='window.writes++'>Top document</button><div style='margin:100px 0 0 170px'><iframe id=child name=child width=480 height=280 style='border:10px solid black;{transform}' src='http://{child_host}:{port}/{destination}'></iframe></div><script>window.marker='top';window.writes=0;</script>"
    );
    let outer = format!(
        "<!doctype html><meta charset=utf-8><title>Outer document</title><iframe id=nested style='margin:30px 0 0 25px;transform:rotate(-3deg)' width=390 height=170 src='http://127.0.0.1:{port}/child'></iframe>"
    );
    let child = "<!doctype html><meta charset=utf-8><title>Child document</title><form id=form onsubmit='return false'><label>Child input<input id=field></label><button type=button onclick='window.writes++'>Increment</button></form><script>window.marker='child';window.writes=0;</script>";
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let socket = tokio::select! { result=listener.accept()=>result.ok().map(|(socket,_)| socket), _=&mut stopped=>None };
            let Some(mut socket) = socket else {
                break;
            };
            let top = top.clone();
            let outer = outer.clone();
            connections.spawn(async move {
                let mut request = [0; 8192];
                let size = socket.read(&mut request).await.unwrap_or(0);
                if size == 0 { return; }
                let body = if request[..size].starts_with(b"GET /child ") { child } else if request[..size].starts_with(b"GET /outer ") { &outer } else { &top };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
        connections.shutdown().await;
    });
    (url, stop, server)
}
