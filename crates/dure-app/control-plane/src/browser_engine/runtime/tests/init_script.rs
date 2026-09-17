use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn init_script_lifetime_follows_the_page_session_and_controller() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<!doctype html><meta charset=utf-8><link rel=icon href=data:,><script>window.order=window.order||[];window.order.push('page');</script><p>Initialization fixture</p>";
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
        .prefix("dure-init-script-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("init-script:owner");
    let runtime = match BrowserRuntime::launch(resource.clone(), &config, &root).await {
        Ok(runtime) => runtime,
        Err(error) => {
            server.abort();
            let _ = server.await;
            panic!("{error:?}");
        }
    };
    let mut peer = None;
    let evidence: Result<_,BrowserRuntimeError> = async {
        peer = Some(runtime.share_instance(identity("init-script:peer")).await?);
        let peer = peer.as_ref().ok_or("fixture_peer_missing")?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.ok_or("fixture_lease_missing")?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.ok_or("fixture_lease_missing")?;
        apply(&runtime,&lease,&first_page(&runtime).await?,json!({"kind":"navigate","url":origin})).await?;
        apply(peer,&peer_lease,&first_page(peer).await?,json!({"kind":"navigate","url":origin})).await?;
        let page = first_page(&runtime).await?;
        let peer_page = first_page(peer).await?;
        let added = apply(&runtime,&lease,&page,json!({"kind":"init_script","action":{"kind":"add","script":"window.order=['init'];window.preloaded='한글';"}})).await?;
        let peer_added = apply(peer,&peer_lease,&peer_page,json!({"kind":"init_script","action":{"kind":"add","script":"window.order=['peer'];window.preloaded='동료';"}})).await?;
        let remove = json!({"kind":"init_script","action":{"kind":"remove","identifier":added["identifier"]}});
        let before = read(&runtime,&lease,&page).await?;
        let second = apply(&runtime,&lease,&page,json!({"kind":"init_script","action":{"kind":"add","script":"window.independent='second';"}})).await?;
        let child = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=()=>resolve({order:frame.contentWindow.order,value:frame.contentWindow.preloaded,independent:frame.contentWindow.independent});frame.src='/frame';document.body.append(frame)})"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"reload"})).await?;
        let reloaded_page = first_page(&runtime).await?;
        let after = read(&runtime,&lease,&reloaded_page).await?;
        let foreign = runtime_error(peer,&peer_lease,&peer_page,remove.clone()).await;
        apply(peer,&peer_lease,&peer_page,json!({"kind":"reload"})).await?;
        let peer_page = first_page(peer).await?;
        let peer_after = read(peer,&peer_lease,&peer_page).await?;
        let new = apply(&runtime,&lease,&reloaded_page,json!({"kind":"new_page","url":origin})).await?;
        let new_page: BrowserPageIdentity = serde_json::from_value(new["page"].clone()).map_err(|_|"fixture_new_page_missing")?;
        let new_before = read(&runtime,&lease,&new_page).await?;
        let wrong_tab = runtime_error(&runtime,&lease,&new_page,remove.clone()).await;
        apply(&runtime,&lease,&reloaded_page,json!({"kind":"select_page"})).await?;
        let removed = apply(&runtime,&lease,&reloaded_page,remove.clone()).await?;
        let repeated_remove = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&reloaded_page).await,serde_json::from_value(remove).unwrap()).await?;
        let existing_after_remove = read(&runtime,&lease,&reloaded_page).await?;
        apply(&runtime,&lease,&reloaded_page,json!({"kind":"reload"})).await?;
        let removed_page = first_page(&runtime).await?;
        let after_remove = read(&runtime,&lease,&removed_page).await?;
        let independent = apply(&runtime,&lease,&removed_page,json!({"kind":"evaluate","script":"window.independent"})).await?;
        apply(&runtime,&lease,&removed_page,json!({"kind":"init_script","action":{"kind":"remove","identifier":second["identifier"]}})).await?;
        let again = apply(&runtime,&lease,&removed_page,json!({"kind":"init_script","action":{"kind":"add","script":"window.order=['again'];"}})).await?;
        let human = runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?.controller.ok_or("fixture_human_missing")?;
        let remove_again = json!({"kind":"init_script","action":{"kind":"remove","identifier":again["identifier"]}});
        let stale = runtime_error(&runtime,&lease,&removed_page,remove_again.clone()).await;
        let human_removed = apply(&runtime,&human,&removed_page,remove_again).await?;
        let peer_still = read(peer,&peer_lease,&peer_page).await?;
        let peer_removed = apply(peer,&peer_lease,&peer_page,json!({"kind":"init_script","action":{"kind":"remove","identifier":peer_added["identifier"]}})).await?;
        Ok(json!({"child":child,"independent":independent,"repeated_remove":repeated_remove,"added":added,"before":before,"page":page,"reloaded_page":reloaded_page,"after":after,"foreign":foreign,"peer_after":peer_after,"new_before":new_before,"wrong_tab":wrong_tab,"removed":removed,"existing_after_remove":existing_after_remove,"after_remove":after_remove,"stale":stale,"human_removed":human_removed,"peer_still":peer_still,"peer_removed":peer_removed}))
    }.await;
    let peer_closed = if let Some(peer) = peer {
        Some(peer.close(&identity("init-script:peer")).await)
    } else {
        None
    };
    let closed = runtime.close(&resource).await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_INIT_SCRIPT root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?} server={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_some_and(|result| result.is_ok()));
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    let result = evidence.unwrap();
    assert_eq!(result["added"]["added"], true);
    assert_eq!(
        result["child"]["result"],
        json!({"order":["init","page"],"value":"한글","independent":"second"})
    );
    assert_eq!(result["independent"]["result"], "second");
    assert_eq!(result["repeated_remove"]["response"]["success"], false);
    assert_eq!(
        result["repeated_remove"]["response"]["error"],
        "browser_init_script_rejected"
    );
    assert_eq!(result["before"], json!({"order":["page"],"value":null}));
    assert_eq!(
        result["page"]["page_id"],
        result["reloaded_page"]["page_id"]
    );
    assert_ne!(
        result["page"]["document_revision"],
        result["reloaded_page"]["document_revision"]
    );
    assert_eq!(
        result["after"],
        json!({"order":["init","page"],"value":"한글"})
    );
    assert_eq!(result["foreign"], "browser_init_script_scope_mismatch");
    assert_eq!(
        result["peer_after"],
        json!({"order":["peer","page"],"value":"동료"})
    );
    assert_eq!(result["new_before"], json!({"order":["page"],"value":null}));
    assert_eq!(result["wrong_tab"], "browser_init_script_scope_mismatch");
    assert_eq!(
        result["removed"]["identifier"],
        result["added"]["identifier"]
    );
    assert_eq!(result["removed"]["removed"], true);
    assert_eq!(result["existing_after_remove"], result["after"]);
    assert_eq!(
        result["after_remove"],
        json!({"order":["page"],"value":null})
    );
    assert_eq!(result["stale"], "browser_controller_changed");
    assert_eq!(result["human_removed"]["removed"], true);
    assert_eq!(result["peer_still"], result["peer_after"]);
    assert_eq!(result["peer_removed"]["removed"], true);
}

async fn read(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> Result<Value, BrowserRuntimeError> {
    Ok(apply(
        runtime,
        lease,
        page,
        json!({"kind":"evaluate","script":"({order:window.order,value:window.preloaded??null})"}),
    )
    .await?["result"]
        .clone())
}

async fn runtime_error(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> String {
    let result = runtime
        .action(
            &lease.controller_id,
            &authority(runtime, lease, page).await,
            serde_json::from_value(action).unwrap(),
        )
        .await;
    match result {
        Err(BrowserRuntimeError::Observation(code)) => code.to_owned(),
        Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ControllerChanged)) => {
            "browser_controller_changed".to_owned()
        }
        Err(error) => format!("unexpected_error:{error:?}"),
        Ok(_) => "unexpected_success".to_owned(),
    }
}
