use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

mod faults;

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

async fn server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        while let Ok((mut socket, _)) = listener.accept().await {
            requests.spawn(async move {
                let mut bytes = [0; 4096];
                let _ = socket.read(&mut bytes).await;
                let body = "<!doctype html><meta charset=utf-8><input id=name><title>Private window</title>";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
            while requests.try_join_next().is_some() {}
        }
        requests.shutdown().await;
    });
    (url, task)
}

async fn navigate(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    url: &str,
) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
    apply(runtime, lease, page, json!({"kind":"navigate","url":url})).await?;
    runtime
        .observe()
        .await?
        .pages
        .into_iter()
        .find(|row| row.page.page_id == page.page_id)
        .map(|row| row.page)
        .ok_or_else(|| "fixture_page_missing".into())
}

async fn window(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
    let created = apply(runtime, lease, page, json!({"kind":"new_window"})).await?;
    let page: BrowserPageIdentity = serde_json::from_value(created["page"].clone())
        .map_err(|_| "fixture_window_page_missing")?;
    if runtime.control().await.current_page.as_ref() != Some(&page) {
        return Err("fixture_window_not_selected".into());
    }
    Ok(page)
}

async fn read(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    script: &str,
) -> Result<Value, BrowserRuntimeError> {
    Ok(apply(
        runtime,
        lease,
        page,
        json!({"kind":"evaluate","script":script}),
    )
    .await?["result"]
        .clone())
}

async fn contexts(runtime: &BrowserRuntime) -> Result<Value, BrowserRuntimeError> {
    Ok(runtime
        .test_binding()
        .cdp
        .clone()
        .request("Target.getBrowserContexts", json!({}), None)
        .await?["browserContextIds"]
        .clone())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn isolated_windows_keep_permissions_storage_and_cleanup_with_their_owner() {
    let root = tempfile::Builder::new()
        .prefix("dure-private-windows-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("window:owner");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let peer = runtime
        .share_instance(identity("window:peer"))
        .await
        .unwrap();
    let (url, server) = server().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let original = first_page(&runtime).await?;
        let peer_page = first_page(&peer).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        let original = navigate(&runtime,&lease,&original,&url).await?;
        let peer_page = navigate(&peer,&peer_lease,&peer_page,&url).await?;
        read(&runtime,&lease,&original,"localStorage.setItem('secret','기본');document.cookie='partition=default';true").await?;
        apply(&runtime,&lease,&original,json!({"kind":"environment","action":{"kind":"permission","permission":"geolocation","setting":"denied","origin":url}})).await?;
        let private = window(&runtime,&lease,&original).await?;
        let private = navigate(&runtime,&lease,&private,&url).await?;
        let empty = read(&runtime,&lease,&private,"({cookie:document.cookie,secret:localStorage.getItem('secret')})").await?;
        read(&runtime,&lease,&private,"localStorage.setItem('secret','개인');document.cookie='partition=private';true").await?;
        apply(&runtime,&lease,&private,json!({"kind":"fill","target":{"kind":"css","selector":"#name"},"text":"개인 창 한글"})).await?;
        apply(&runtime,&lease,&private,json!({"kind":"environment","action":{"kind":"permission","permission":"geolocation","setting":"granted","origin":url}})).await?;
        let permission = "navigator.permissions.query({name:'geolocation'}).then(value=>value.state)";
        let private_permission = read(&runtime,&lease,&private,permission).await?;
        let default_permission = read(&peer,&peer_lease,&peer_page,permission).await?;
        let second = window(&runtime,&lease,&private).await?;
        let second = navigate(&runtime,&lease,&second,&url).await?;
        let second_empty = read(&runtime,&lease,&second,"({cookie:document.cookie,secret:localStorage.getItem('secret')})").await?;
        let before_close = contexts(&runtime).await?;
        apply(&runtime,&lease,&second,json!({"kind":"close_page"})).await?;
        runtime.observe().await?;
        let after_close = contexts(&runtime).await?;
        let value = read(&runtime,&lease,&private,"({value:document.querySelector('#name').value,secret:localStorage.getItem('secret'),cookie:document.cookie})").await?;
        let peer_value = read(&peer,&peer_lease,&peer_page,"({secret:localStorage.getItem('secret'),cookie:document.cookie})").await?;
        Ok(json!({"empty":empty,"secondEmpty":second_empty,"privatePermission":private_permission,"defaultPermission":default_permission,"beforeClose":before_close,"afterClose":after_close,"value":value,"peer":peer_value}))
    }.await;
    let closed = runtime.close(&resource).await;
    let remaining = contexts(&peer).await;
    let peer_alive = peer.test_binding().instance.browser_has_exited().await;
    let peer_closed = peer.close(&identity("window:peer")).await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_PRIVATE_WINDOWS root={} evidence={evidence:?} closed={closed:?} remaining={remaining:?} peer_alive={peer_alive:?} peer_closed={peer_closed:?} server={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(matches!(peer_alive, Ok(false)));
    assert_eq!(remaining.unwrap(), json!([]));
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    let evidence = evidence.unwrap();
    assert_eq!(evidence["empty"], json!({"cookie":"","secret":null}));
    assert_eq!(evidence["secondEmpty"], evidence["empty"]);
    assert_eq!(evidence["privatePermission"], "granted");
    assert_eq!(evidence["defaultPermission"], "denied");
    assert_eq!(evidence["beforeClose"].as_array().unwrap().len(), 2);
    assert_eq!(evidence["afterClose"].as_array().unwrap().len(), 1);
    assert_eq!(
        evidence["value"],
        json!({"value":"개인 창 한글","secret":"개인","cookie":"partition=private"})
    );
    assert_eq!(
        evidence["peer"],
        json!({"secret":"기본","cookie":"partition=default"})
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn state_export_reads_visited_origins_from_the_admitted_private_context() {
    let root = tempfile::Builder::new()
        .prefix("dure-private-window-state-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("window:state");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let (url, server_a) = server().await;
    let (second_url, server_b) = server().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let original = navigate(&runtime,&lease,&first_page(&runtime).await?,&url).await?;
        read(&runtime,&lease,&original,"localStorage.setItem('secret','default-not-exported');document.cookie='partition=default';true").await?;
        let private = window(&runtime,&lease,&original).await?;
        let private = navigate(&runtime,&lease,&private,&url).await?;
        read(&runtime,&lease,&private,"localStorage.setItem('secret','개인 첫 출처');document.cookie='partition=private';true").await?;
        let private = navigate(&runtime,&lease,&private,&second_url).await?;
        read(&runtime,&lease,&private,"localStorage.setItem('secret','개인 둘째 출처');true").await?;
        let saved = apply(&runtime,&lease,&private,json!({"kind":"state_save"})).await?;
        let bytes = STANDARD.decode(saved["artifact_payload"]["base64"].as_str().ok_or("fixture_state_missing")?).map_err(|_| "fixture_state_invalid")?;
        let state: Value = serde_json::from_slice(&bytes).map_err(|_| "fixture_state_invalid")?;
        let before_disconnect = runtime.control().await.current_page;
        apply(&runtime,&lease,&private,json!({"kind":"disconnect"})).await?;
        let retained = read(&runtime,&lease,&private,"localStorage.getItem('secret')").await?;
        let after_disconnect = runtime.control().await.current_page;
        Ok(json!({"state":state,"first":url,"second":second_url,"before":before_disconnect,"after":after_disconnect,"retained":retained,"pages":runtime.observe().await?.pages.len()}))
    }.await;
    let closed = runtime.close(&resource).await;
    server_a.abort();
    server_b.abort();
    let server_a = server_a.await;
    let server_b = server_b.await;
    println!(
        "BROWSER_PRIVATE_WINDOW_STATE root={} evidence={evidence:?} closed={closed:?} servers={server_a:?}/{server_b:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(server_a.is_ok() || server_a.is_err_and(|e| e.is_cancelled()));
    assert!(server_b.is_ok() || server_b.is_err_and(|e| e.is_cancelled()));
    let evidence = evidence.unwrap();
    let origins = evidence["state"]["origins"].as_array().unwrap();
    for (key, expected) in [("first", "개인 첫 출처"), ("second", "개인 둘째 출처")] {
        let row = origins
            .iter()
            .find(|row| row["origin"] == evidence[key])
            .unwrap();
        assert_eq!(
            row["localStorage"],
            json!([{"name":"secret","value":expected}])
        );
    }
    assert_eq!(origins.len(), 2);
    assert_eq!(evidence["pages"], 2);
    assert_eq!(evidence["state"]["cookies"][0]["value"], "private");
    assert_eq!(evidence["retained"], "개인 둘째 출처");
    assert_eq!(evidence["before"], evidence["after"]);
}
