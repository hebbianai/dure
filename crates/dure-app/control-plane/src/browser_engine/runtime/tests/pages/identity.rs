use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn new_page_returns_its_host_identity_for_immediate_input() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body =
                "<!doctype html><meta charset=utf-8><title>Created page</title><input id=name>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-new-page-identity-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = super::super::identity("new-page:identity");
    let runtime = match BrowserRuntime::launch(resource.clone(), &config, &root).await {
        Ok(runtime) => runtime,
        Err(error) => {
            server.abort();
            let _ = server.await;
            panic!("{error:?}");
        }
    };
    let evidence: Result<Value, BrowserRuntimeError> = async {
        let original = first_page(&runtime).await?;
        let controller = BrowserControllerId::new("view:new-page").unwrap();
        let lease = runtime.request_control(controller.clone(), None).await?.controller.ok_or("fixture_controller_missing")?;
        let result = runtime.action(&controller, &authority(&runtime, &lease, &original).await, serde_json::from_value(json!({"kind":"new_page","url":url})).unwrap()).await?;
        if !result.response.success { return Err("fixture_creation_failed".into()); }
        println!("BROWSER_CREATED_PAGE_RESPONSE root={} result={}",root.display(),serde_json::to_value(&result).unwrap());
        let page: BrowserPageIdentity = serde_json::from_value(result.response.data["page"].clone()).map_err(|_|"browser_created_page_identity_missing")?;
        let target = BrowserTargetId::new(result.response.data["targetId"].as_str().ok_or("fixture_target_missing")?).unwrap();
        let owned = runtime.host.lock().await.page_for_target(&target);
        if owned.as_ref() != Some(&page) || page.resource != resource || page.page_id == original.page_id { return Err("browser_created_page_identity_mismatch".into()); }
        // The caller can use the returned revision directly; no array-diff
        // inference, native tab label or fresh discovery chooses the target.
        apply(&runtime,&lease,&page,json!({"kind":"fill","target":{"kind":"css","selector":"#name"},"text":"새 페이지 입력"})).await?;
        let value=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.querySelector('#name').value"})).await?;
        if value["result"] != "새 페이지 입력" { return Err("browser_created_page_input_missed".into()); }
        let observed=runtime.observe().await?;
        if observed.pages.len()!=2 || !observed.pages.iter().any(|row|row.page==original) { return Err("browser_original_page_changed".into()); }
        Ok(json!({"created":page,"original":original,"value":value,"observation":observed}))
    }.await;
    let closed = runtime.close(&resource).await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_CREATED_PAGE_RETIRED root={} evidence={evidence:?} closed={closed:?} server={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(
        server_closed.is_ok()
            || server_closed
                .as_ref()
                .is_err_and(|error| error.is_cancelled())
    );
    evidence.unwrap();
}
