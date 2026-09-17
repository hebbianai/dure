use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn known_new_page_navigation_loss_preserves_same_instance_peer() {
    preserves_peer(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn native_new_page_rejection_preserves_same_instance_peer() {
    preserves_peer(true).await;
}

async fn preserves_peer(reject_creation: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-new-page-boundary-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("page-boundary:owner");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/page-boundary",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = if reject_creation {
        tokio::spawn(reject_native_creation(
            listener,
            endpoint.clone(),
            effect,
            stopped,
        ))
    } else {
        tokio::spawn(lose_reply(
            listener,
            endpoint.clone(),
            "Page.navigate",
            effect,
            stopped,
        ))
    };
    let (command, events) = if reject_creation {
        (&endpoint, &address)
    } else {
        (&address, &endpoint)
    };
    let runtime = with_connections(chromium, engine, resource.clone(), command, events)
        .await
        .unwrap();
    let peer = runtime
        .share_instance(identity("page-boundary:peer"))
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let controller = BrowserControllerId::new("agent").unwrap();
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(controller.clone(), None)
            .await?
            .controller
            .unwrap();
        let peer_page = first_page(&peer).await?;
        let peer_lease = peer
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        apply(
            &peer,
            &peer_lease,
            &peer_page,
            json!({"kind":"evaluate","script":"window.proof='동일 인스턴스';true"}),
        )
        .await?;
        let census_before = targets(&runtime).await?;
        let action = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"new_page","url":"about:blank"}),
        )
        .await;
        let acknowledged = timeout(Duration::from_secs(5), observed_effect)
            .await
            .map_err(|_| "fixture_native_reply_timeout")?
            .map_err(|_| "fixture_native_reply_missing")?;
        let phases = (runtime.control().await.phase, peer.control().await.phase);
        let census_after = targets(&runtime).await?;
        let owned = runtime.host.lock().await.owned_page_targets();
        let browser_exited = runtime.test_binding().instance.browser_has_exited().await?;
        let worker_exited = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_some();
        let value = apply(
            &peer,
            &peer_lease,
            &peer_page,
            json!({"kind":"evaluate","script":"window.proof"}),
        )
        .await?;
        let peer_after = first_page(&peer).await?;
        let next = if reject_creation {
            Some(
                apply(
                    &runtime,
                    &lease,
                    &page,
                    json!({"kind":"evaluate","script":"'rejection recovered'"}),
                )
                .await?,
            )
        } else {
            None
        };
        Ok((
            action,
            acknowledged,
            phases,
            census_before,
            census_after,
            owned,
            browser_exited,
            worker_exited,
            value,
            peer_page,
            peer_after,
            next,
        ))
    }
    .await;
    let owner_closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_NEW_PAGE_BOUNDARY reject={reject_creation} root={} evidence={evidence:?} owner_closed={owner_closed:?} peer_closed={peer_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(owner_closed.is_ok(), "{owner_closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        action,
        acknowledged,
        phases,
        before,
        after,
        owned,
        browser_exited,
        worker_exited,
        value,
        peer_page,
        peer_after,
        next,
    ) = evidence.unwrap();
    assert!(!browser_exited && !worker_exited);
    assert_eq!(phases.1, BrowserResourcePhase::Ready);
    assert_eq!(value["result"], json!("동일 인스턴스"));
    assert_eq!(peer_after, peer_page);
    if reject_creation {
        assert!(acknowledged.get("error").is_some(), "{acknowledged}");
        assert!(
            matches!(action, Err(BrowserRuntimeError::Engine(error)) if !error.outcome_unknown)
        );
        assert_eq!(phases.0, BrowserResourcePhase::Ready);
        assert_eq!(
            after, before,
            "Actual rejection must not create a native target"
        );
        assert_eq!(next.unwrap()["result"], json!("rejection recovered"));
    } else {
        assert!(
            acknowledged["result"]["loaderId"].as_str().is_some(),
            "{acknowledged}"
        );
        assert!(matches!(action, Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown));
        assert_eq!(phases.0, BrowserResourcePhase::OutcomeUnknown);
        let created = after.difference(&before).collect::<Vec<_>>();
        assert_eq!(created.len(), 1);
        assert!(
            owned.contains(created[0]),
            "Known target must remain with its resource"
        );
    }
}

pub(super) async fn targets(
    runtime: &BrowserRuntime,
) -> Result<std::collections::BTreeSet<BrowserTargetId>, BrowserRuntimeError> {
    let census = runtime
        .test_binding()
        .cdp
        .clone()
        .request("Target.getTargets", json!({}), None)
        .await?;
    census["targetInfos"]
        .as_array()
        .ok_or("fixture_census_missing")?
        .iter()
        .map(|info| {
            BrowserTargetId::new(info["targetId"].as_str().ok_or("fixture_target_missing")?)
                .map_err(|_| "fixture_target_invalid".into())
        })
        .collect()
}

async fn reject_native_creation(
    listener: TcpListener,
    endpoint: String,
    effect: oneshot::Sender<Value>,
    mut stopped: oneshot::Receiver<()>,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut client = accept_async(stream).await.unwrap();
    let uri: Uri = endpoint.parse().unwrap();
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
        .await
        .unwrap();
    let (mut chrome, _) = client_async(endpoint, stream).await.unwrap();
    let mut effect = Some(effect);
    let mut intercepted = None;
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            message = client.next() => {
                let Some(Ok(mut message)) = message else { break; };
                if let Ok(text) = message.to_text() {
                    let mut request: Value = serde_json::from_str(text).unwrap();
                    if request["method"] == "Target.createTarget" && intercepted.is_none() {
                        intercepted = Some(request["id"].clone());
                        // Ask real Chromium for an invalid parameter combination;
                        // forward its actual rejection, never fabricate a reply.
                        request["params"]["hidden"] = json!(true);
                        request["params"]["forTab"] = json!(true);
                        message = Message::text(request.to_string());
                    }
                }
                if chrome.send(message).await.is_err() { break; }
            }
            message = chrome.next() => {
                let Some(Ok(message)) = message else { break; };
                if effect.is_some() {
                    if let Ok(text) = message.to_text() {
                        let response: Value = serde_json::from_str(text).unwrap();
                        if intercepted.as_ref().is_some_and(|id| response["id"] == *id) {
                            let _ = effect.take().unwrap().send(response);
                        }
                    }
                }
                if client.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = client.close(None).await;
    let _ = chrome.close(None).await;
}
