use super::*;
use futures_util::{SinkExt, StreamExt};
use hmux_session_protocol::browser_resource::*;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

mod retired_attachment;

#[tokio::test]
async fn event_source_barrier_reports_pending_dispatch_failure_before_acknowledging() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/dispatch-barrier",
        listener.local_addr().unwrap()
    );
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            let response = if request["method"] == "Fetch.continueRequest" {
                json!({"id":request["id"],"error":{"code":-32000,"message":"fixture dispatch rejected"}})
            } else {
                json!({"id":request["id"],"result":{"targetInfos":[{"targetId":"target","type":"page"}]}})
            };
            if peer
                .send(Message::text(response.to_string()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let mut cdp = BrowserCdp::connect(&address).await.unwrap();
    cdp.retain_events().await;
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("owner").unwrap(),
        generation: BrowserResourceGeneration::new("generation").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
    };
    let mut host = BrowserResourceHost::new(identity.clone());
    let target = BrowserTargetId::new("target").unwrap();
    host.register_page(
        BrowserInstanceId::new("instance").unwrap(),
        target.clone(),
        BrowserDocumentId::new("document").unwrap(),
    )
    .unwrap();
    host.network()
        .attach(
            BrowserNetworkId::new("session").unwrap(),
            target.clone(),
            target,
            true,
            Instant::now(),
        )
        .unwrap();
    let (barriers, receiver) = mpsc::channel(32);
    let mut state = monitor(
        Arc::new(Mutex::new(host)),
        cdp.clone(),
        barriers.clone(),
        BrowserInstanceId::new("instance").unwrap(),
        Arc::new(tokio::sync::Notify::new()),
    )
    .await;
    state.interception_event(&json!({"method":"Fetch.requestPaused","sessionId":"session","params":{"requestId":"fetch","request":{"url":"http://fixture/","headers":{}},"resourceType":"Fetch"}})).unwrap();
    let resource = Arc::clone(&state.resource);
    let mut source = Source {
        cdp,
        resources: BTreeMap::from([(identity.resource_id, state)]),
    };
    let task = tokio::spawn(async move {
        let result = source.run(receiver).await;
        source.cdp.retire().await;
        result
    });
    let result = synchronize_events(&barriers, &resource).await;
    let stopped = task.await.unwrap();
    peer.await.unwrap();
    println!("BROWSER_PROFILE_DISPATCH_BARRIER result={result:?} stopped={stopped:?}");
    assert_eq!(result, Err("browser_cdp_request_rejected"));
    assert_eq!(stopped, Err("browser_cdp_request_rejected"));
}

#[tokio::test]
async fn event_source_failed_attachment_retires_unpublished_native_handlers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/partial-attachment",
        listener.local_addr().unwrap()
    );
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut methods = Vec::new();
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            methods.push(request["method"].as_str().unwrap().to_owned());
            if request["method"] == "Target.attachToTarget" {
                peer.send(Message::text(json!({"method":"Target.attachedToTarget","params":{"sessionId":"unpublished","waitingForDebugger":true,"targetInfo":{"targetId":"target","type":"page","url":"about:blank"}}}).to_string())).await.unwrap();
            }
            let response = if request["method"] == "Runtime.enable" {
                json!({"id":request["id"],"error":{"code":-32000,"message":"fixture handler setup rejected"}})
            } else {
                json!({"id":request["id"],"result":{}})
            };
            if peer
                .send(Message::text(response.to_string()))
                .await
                .is_err()
            {
                break;
            }
        }
        methods
    });
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("peer").unwrap(),
        generation: BrowserResourceGeneration::new("generation").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
    };
    let mut original = BrowserEventMonitor::start(
        Arc::new(Mutex::new(BrowserResourceHost::new(identity.clone()))),
        &address,
        BrowserInstanceId::new("instance").unwrap(),
        Arc::new(tokio::sync::Notify::new()),
    )
    .await
    .unwrap();
    let mut identity = identity;
    identity.resource_id = BrowserResourceId::new("partial").unwrap();
    let mut host = BrowserResourceHost::new(identity.clone());
    host.reserve_page_target(
        &identity,
        BrowserInstanceId::new("instance").unwrap(),
        BrowserTargetId::new("target").unwrap(),
    )
    .unwrap();
    let attached = original
        .share(
            Arc::new(Mutex::new(host)),
            Arc::new(tokio::sync::Notify::new()),
        )
        .await;
    let error = attached.as_ref().err().copied();
    let available = original
        .cdp
        .request("Browser.getVersion", json!({}), None)
        .await;
    if let Ok(monitor) = attached {
        monitor.close().await;
    }
    original.close().await;
    let methods = peer.await.unwrap();
    println!(
        "BROWSER_PROFILE_PARTIAL_ATTACHMENT error={error:?} available={available:?} methods={methods:?}"
    );
    assert_eq!(error, Some("browser_cdp_request_rejected"));
    assert!(
        available.is_err(),
        "Failed attachment must retire native handlers that never reached the Host source table"
    );
}

#[tokio::test]
async fn event_source_stale_observers_cannot_address_replacement_resources() {
    let mut observations = Vec::new();
    for replacement_kind in ["generation", "workspace", "registration"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!(
            "ws://{}/devtools/browser/replacement",
            listener.local_addr().unwrap()
        );
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(Message::Text(text))) = peer.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                let result = if request["method"] == "Target.getTargets" {
                    json!({"targetInfos":[]})
                } else {
                    json!({})
                };
                if peer
                    .send(Message::text(
                        json!({"id":request["id"],"result":result}).to_string(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("replacement").unwrap(),
            generation: BrowserResourceGeneration::new("original").unwrap(),
            workspace_id: BrowserWorkspaceId::new("original").unwrap(),
        };
        let host = |identity| Arc::new(Mutex::new(BrowserResourceHost::new(identity)));
        let original_host = host(identity.clone());
        let original = BrowserEventMonitor::start(
            Arc::clone(&original_host),
            &address,
            BrowserInstanceId::new("instance").unwrap(),
            Arc::new(tokio::sync::Notify::new()),
        )
        .await
        .unwrap();
        let mut monitors = vec![original];
        let result: Result<_, &'static str> = async {
            let mut peer_identity = identity.clone();
            peer_identity.resource_id = BrowserResourceId::new("peer").unwrap();
            monitors.push(
                monitors[0]
                    .share(host(peer_identity), Arc::new(tokio::sync::Notify::new()))
                    .await?,
            );
            let creation = {
                let mut host = original_host.lock().await;
                let page = host
                    .register_page(
                        BrowserInstanceId::new("instance").unwrap(),
                        BrowserTargetId::new("stale").unwrap(),
                        BrowserDocumentId::new("document").unwrap(),
                    )
                    .unwrap();
                let caller = BrowserControllerId::new("agent").unwrap();
                let lease = host
                    .request_control(caller.clone(), None)
                    .unwrap()
                    .controller
                    .unwrap();
                let authority = BrowserActionAuthority {
                    lease,
                    page,
                    operation_id: BrowserOperationId::new("stale").unwrap(),
                    command_sequence: host.projection().next_command_sequence,
                };
                let action = host.begin_action(&caller, &authority, None).unwrap();
                host.prepare_page_creation(&action).unwrap()
            };
            monitors[0].close().await;
            let mut replacement = identity;
            if replacement_kind == "generation" {
                replacement.generation = BrowserResourceGeneration::new("replacement").unwrap();
            } else if replacement_kind == "workspace" {
                replacement.workspace_id = BrowserWorkspaceId::new("replacement").unwrap();
            }
            monitors.push(
                monitors[1]
                    .share(host(replacement), Arc::new(tokio::sync::Notify::new()))
                    .await?,
            );
            let stale = monitors[0].synchronize_events().await;
            let stale_create = monitors[0].create_page(creation).await;
            let stale_interception = monitors[0]
                .apply_interception(BrowserTargetId::new("stale").unwrap())
                .await;
            monitors[0].close().await;
            let replacement = monitors[2].synchronize_events().await;
            let peer = monitors[1].synchronize_events().await;
            Ok((stale, stale_create, stale_interception, replacement, peer))
        }
        .await;
        for monitor in &monitors {
            monitor.close().await;
        }
        peer.await.unwrap();
        observations.push((replacement_kind, result));
    }
    println!("BROWSER_PROFILE_REPLACEMENT {observations:?}");
    for (_, observation) in observations {
        let (stale, stale_create, stale_interception, replacement, peer) = observation.unwrap();
        assert_eq!(stale, Err("browser_network_observation_lost"));
        assert_eq!(stale_create, Err("browser_network_observation_lost"));
        assert_eq!(stale_interception, Err("browser_network_observation_lost"));
        assert_eq!(
            replacement,
            Ok(()),
            "Stale close must preserve the replacement observer"
        );
        assert_eq!(peer, Ok(()), "Stale close must preserve peer observation");
    }
}

#[tokio::test]
async fn event_source_withdrawal_failure_retires_uncertain_native_handlers() {
    for fail in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!(
            "ws://{}/devtools/browser/withdrawal",
            listener.local_addr().unwrap()
        );
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut methods = Vec::new();
            while let Some(Ok(Message::Text(text))) = peer.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                methods.push(request["method"].as_str().unwrap().to_owned());
                let response = if fail && request["method"] == "Target.detachFromTarget" {
                    json!({"id":request["id"],"error":{"code":-32000,"message":"fixture detach rejected"}})
                } else {
                    json!({"id":request["id"],"result":{}})
                };
                if peer
                    .send(Message::text(response.to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            methods
        });
        let cdp = BrowserCdp::connect(&address).await.unwrap();
        let mut source = Source {
            cdp: cdp.clone(),
            resources: BTreeMap::new(),
        };
        for name in ["a", "b"] {
            let resource = BrowserResourceIdentity {
                resource_id: BrowserResourceId::new(name).unwrap(),
                generation: BrowserResourceGeneration::new("generation").unwrap(),
                workspace_id: BrowserWorkspaceId::new(name).unwrap(),
            };
            let mut host = BrowserResourceHost::new(resource.clone());
            let target = BrowserTargetId::new(format!("target:{name}")).unwrap();
            host.register_page(
                BrowserInstanceId::new("instance").unwrap(),
                target.clone(),
                BrowserDocumentId::new("document").unwrap(),
            )
            .unwrap();
            host.network()
                .attach(
                    BrowserNetworkId::new(&format!("session:{name}")).unwrap(),
                    target.clone(),
                    target,
                    true,
                    Instant::now(),
                )
                .unwrap();
            source.resources.insert(
                resource.resource_id,
                monitor(
                    Arc::new(Mutex::new(host)),
                    cdp.clone(),
                    mpsc::channel(32).0,
                    BrowserInstanceId::new("instance").unwrap(),
                    Arc::new(tokio::sync::Notify::new()),
                )
                .await,
            );
        }
        let resource = Arc::clone(
            &source
                .resources
                .get(&BrowserResourceId::new("a").unwrap())
                .unwrap()
                .resource,
        );
        let removed = source.remove(&resource).await;
        let available = source
            .cdp
            .request("Browser.getVersion", json!({}), None)
            .await;
        source.cdp.retire().await;
        let methods = peer.await.unwrap();
        println!(
            "BROWSER_PROFILE_WITHDRAW fail={fail} available={available:?} removed={removed:?} methods={methods:?}"
        );
        assert_eq!(
            available.is_err(),
            fail,
            "A rejected withdrawal must not leave native handlers live without their resource observer"
        );
    }
}

#[tokio::test]
async fn event_source_releases_late_console_mirrors_after_page_retirement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/late-resource",
        listener.local_addr().unwrap()
    );
    let (sent, received) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut sent = Some(sent);
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            if peer
                .send(Message::text(
                    json!({"id":request["id"],"result":{}}).to_string(),
                ))
                .await
                .is_err()
            {
                break;
            }
            if let Some(sent) = sent.take() {
                let _ = sent.send(request);
            }
        }
    });
    let cdp = BrowserCdp::connect(&address).await.unwrap();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("owner").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let mut host = BrowserResourceHost::new(identity.clone());
    let target = BrowserTargetId::new("target").unwrap();
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new("document").unwrap(),
        )
        .unwrap();
    host.network()
        .attach(
            BrowserNetworkId::new("session").unwrap(),
            target.clone(),
            target,
            true,
            Instant::now(),
        )
        .unwrap();
    let host = Arc::new(Mutex::new(host));
    let state = monitor(
        Arc::clone(&host),
        cdp.clone(),
        mpsc::channel(32).0,
        BrowserInstanceId::new("instance").unwrap(),
        Arc::new(tokio::sync::Notify::new()),
    )
    .await;
    let mut source = Source {
        cdp: cdp.clone(),
        resources: BTreeMap::from([(identity.resource_id, state)]),
    };
    source.event(json!({"method":"Runtime.executionContextCreated","sessionId":"session","params":{"context":{"id":7}}})).await.unwrap();
    host.lock().await.page_closed(&page.page_id).unwrap();
    source.event(json!({"method":"Runtime.consoleAPICalled","sessionId":"session","params":{"executionContextId":7,"type":"log","timestamp":1700000000000.0,"args":[{"type":"object","objectId":"late-mirror","description":"Object"}]}})).await.unwrap();
    let released = timeout(Duration::from_secs(2), received).await;
    source.cdp.retire().await;
    peer.await.unwrap();
    println!("BROWSER_PROFILE_LATE_MIRROR released={released:?}");
    let released = released.unwrap().unwrap();
    assert_eq!(released["method"], "Runtime.releaseObject");
    assert_eq!(released["sessionId"], "session");
    assert_eq!(released["params"]["objectId"], "late-mirror");
    assert!(host.lock().await.pages().is_empty());
}
