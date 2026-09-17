use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_context_reply_retires_the_unaccounted_instance() {
    lost_creation("Target.createBrowserContext", false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_context_creation_still_retires_the_unaccounted_instance() {
    lost_creation("Target.createBrowserContext", true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_page_reply_retires_its_known_private_context_and_preserves_the_peer() {
    lost_creation("Target.createTarget", false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_private_page_creation_preserves_the_peer_after_context_retirement() {
    lost_creation("Target.createTarget", true).await;
}

async fn lost_creation(method: &'static str, cancel: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-window-creation-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("window:loss");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config(), &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/window-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed) = oneshot::channel();
    let proxy = tokio::spawn(lose_reply(listener, endpoint, method, effect, stopped));
    let runtime = Arc::new(
        with_event_connection(chromium, engine, resource.clone(), &address)
            .await
            .unwrap(),
    );
    let peer = runtime
        .share_instance(identity("window:loss-peer"))
        .await
        .unwrap();
    let independent = BrowserRuntime::launch(identity("window:independent"), &config(), &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let peer_page = first_page(&peer).await?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        read(&peer,&peer_lease,&peer_page,"window.proof='같은 인스턴스의 동료';true").await?;
        let independent_page = first_page(&independent).await?;
        let independent_lease = independent.request_control(BrowserControllerId::new("independent").unwrap(),None).await?.controller.unwrap();
        read(&independent,&independent_lease,&independent_page,"window.proof='독립 작업';true").await?;
        let call_runtime = Arc::clone(&runtime);
        let caller = tokio::spawn(async move { apply(&call_runtime,&lease,&page,json!({"kind":"new_window"})).await });
        let effect = timeout(Duration::from_secs(10), observed).await.map_err(|_|"fixture_creation_not_observed")?.map_err(|_|"fixture_creation_signal_lost")?;
        if cancel { caller.abort(); }
        let result = caller.await;
        let (settled,peer_phase,browser_exited,remaining) = timeout(Duration::from_secs(15), async {
            loop {
                let phase = runtime.control().await.phase;
                let peer_phase = peer.control().await.phase;
                let exited = runtime.test_binding().instance.browser_has_exited().await?;
                if exited && peer_phase == BrowserResourcePhase::Closed {
                    break Ok::<_,BrowserRuntimeError>((phase,peer_phase,true,json!([])));
                }
                if !exited && phase == BrowserResourcePhase::OutcomeUnknown && peer_phase == BrowserResourcePhase::Ready {
                    if let Ok(contexts) = contexts(&peer).await {
                        if contexts == json!([]) { break Ok((phase,peer_phase,false,contexts)); }
                    }
                }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_|"fixture_creation_unsettled")??;
        let value = read(&independent,&independent_lease,&independent_page,"window.proof").await?;
        let peer_value = if peer_phase == BrowserResourcePhase::Ready {
            read(&peer,&peer_lease,&peer_page,"window.proof").await?
        } else { Value::Null };
        Ok(json!({"effect":effect,"callerCanceled":result.as_ref().is_err_and(|e|e.is_cancelled()),"callerFailed":!matches!(result,Ok(Ok(_))),"phase":settled,"peerPhase":peer_phase,"peerValue":peer_value,"browserExited":browser_exited,"contexts":remaining,"independent":value}))
    }.await;
    let closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&identity("window:loss-peer")).await;
    let independent_closed = independent.close(&identity("window:independent")).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_WINDOW_CREATION_LOSS method={method} cancel={cancel} root={} evidence={evidence:?} closed={closed:?} peer={peer_closed:?} independent={independent_closed:?} proxy={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(independent_closed.is_ok());
    assert!(proxy_closed.is_ok());
    let evidence = evidence.unwrap();
    assert_eq!(evidence["independent"], "독립 작업");
    assert_eq!(evidence["callerFailed"], true);
    if cancel {
        assert_eq!(evidence["callerCanceled"], true);
    }
    assert_eq!(evidence["contexts"], json!([]));
    if method == "Target.createBrowserContext" {
        assert_eq!(evidence["browserExited"], true);
        assert_eq!(evidence["peerPhase"], "closed");
    } else {
        assert_eq!(evidence["browserExited"], false);
        assert_eq!(evidence["peerPhase"], "ready");
        assert_eq!(evidence["peerValue"], "같은 인스턴스의 동료");
    }
}
