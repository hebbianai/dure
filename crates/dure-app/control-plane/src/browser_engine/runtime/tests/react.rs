use super::*;
use std::sync::Arc;
use tokio::sync::oneshot;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_react_registration_ack_fences_the_owner_and_preserves_its_peer() {
    lost_ack(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_react_removal_ack_fences_the_owner_and_preserves_its_peer() {
    lost_ack(false).await;
}

async fn lost_ack(starting: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-react-ack-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("react:ack-owner");
    let peer_id = identity("react:ack-peer");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = format!(
        "ws://{}/devtools/browser/react-ack",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed) = oneshot::channel();
    let method = if starting {
        "Page.addScriptToEvaluateOnNewDocument"
    } else {
        "Page.removeScriptToEvaluateOnNewDocument"
    };
    let proxy = tokio::spawn(pages::lose_reply(
        listener,
        endpoint.clone(),
        method,
        effect,
        stopped,
    ));
    let runtime = Arc::new(
        pages::with_connections(
            chromium,
            engine,
            resource.clone(),
            &endpoint,
            &proxy_address,
        )
        .await
        .unwrap(),
    );
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let evidence: Result<Value,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("owner").unwrap(),None).await?.controller.unwrap();
        let peer_page = first_page(&peer).await?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        // This test isolates native registration receipts. Actual React
        // renderer/props/state behavior is covered by the CLI React fixtures.
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.__REACT_DEVTOOLS_GLOBAL_HOOK__={onCommitFiberRoot(){}}"})).await?;
        apply(&peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.peerWitness='동료 유지'"})).await?;
        let owner_target = runtime.host.lock().await.target_for(&page)?.clone();
        let start = json!({"kind":"react","action":{"kind":"renders_start"}});
        if !starting {apply(&runtime,&lease,&page,start.clone()).await?;}
        let action = if starting {start} else {json!({"kind":"react","action":{"kind":"renders_stop"}})};
        let authority = authority(&runtime,&lease,&page).await;
        let (result,effect) = tokio::join!(
            runtime.action(&lease.controller_id,&authority,serde_json::from_value(action.clone()).unwrap()),
            timeout(Duration::from_secs(10),observed),
        );
        let effect = effect.map_err(|_|"react_fixture_ack_timeout")?.map_err(|_|"react_fixture_ack_lost")?;
        let phase = runtime.control().await.phase;
        let denied = runtime.action(&lease.controller_id,&authority,serde_json::from_value(action).unwrap()).await;
        let value = apply(&peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"({witness:window.peerWitness,active:!!window.__AB_RENDERS_ACTIVE__})"})).await?;
        runtime.close(&resource).await?;
        let targets = peer.test_binding().cdp.clone().request("Target.getTargets",json!({}),None).await?;
        let gone = targets["targetInfos"].as_array().ok_or("react_fixture_targets_invalid")?.iter().all(|target|target["targetId"].as_str()!=Some(owner_target.as_str()));
        let after = apply(&peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"window.peerWitness"})).await?;
        Ok(json!({"starting":starting,"acknowledged":effect.get("result").is_some(),"error":result.as_ref().err().map(|error|format!("{error:?}")),"phase":phase,"nextActionDenied":matches!(denied,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::OutcomeUnknown))),"peerBeforeClose":value["result"],"peerAfterClose":after["result"],"ownerTargetGone":gone,"sameBrowser":peer.test_binding().instance.connection().await.endpoint()==endpoint,"browserAlive":!peer.test_binding().instance.browser_has_exited().await?}))
    }.await;
    let closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&peer_id).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_REACT_ACK root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(proxy_closed.is_ok());
    let evidence = evidence.unwrap();
    println!("BROWSER_REACT_ACK_JSON {evidence}");
    let code = if starting {
        "browser_react_registration_unknown"
    } else {
        "browser_react_cleanup_unknown"
    };
    assert!(evidence["error"].as_str().unwrap().contains(code));
    assert_eq!(evidence["phase"], "outcome_unknown");
    for key in [
        "acknowledged",
        "nextActionDenied",
        "ownerTargetGone",
        "sameBrowser",
        "browserAlive",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(
        evidence["peerBeforeClose"],
        json!({"witness":"동료 유지","active":false})
    );
    assert_eq!(evidence["peerAfterClose"], "동료 유지");
}
