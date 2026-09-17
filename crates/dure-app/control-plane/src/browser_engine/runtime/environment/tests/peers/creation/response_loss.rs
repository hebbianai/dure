use super::*;

mod boundaries;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn lost_shared_creation_retires_its_instance_and_preserves_an_independent_resource() {
    let (runtime, identity, root) = launch("creation:lost-reply").await;
    let peer = runtime
        .share_instance(BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("creation:existing-peer").unwrap(),
            generation: identity.generation.clone(),
            workspace_id: BrowserWorkspaceId::new("workspace:existing-peer").unwrap(),
        })
        .await
        .unwrap();
    let (independent, independent_identity, independent_root) =
        launch("creation:independent").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/creation-loss",
        listener.local_addr().unwrap()
    );
    let actual = runtime
        .test_binding()
        .instance
        .replace_test_endpoint(address)
        .await;
    let (effect, observed_effect) = oneshot::channel();
    let (retire, retired) = oneshot::channel();
    let commands = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let proxy = tokio::spawn(proxy(
        listener,
        actual.clone(),
        effect,
        retired,
        Arc::clone(&commands),
    ));
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let controller = BrowserControllerId::new("agent").unwrap();
        let lease = runtime
            .request_control(controller.clone(), None)
            .await?
            .controller
            .unwrap();
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.writes=0;true"}),
        )
        .await?;
        let independent_page = independent.observe().await?.pages[0].page.clone();
        let independent_lease = independent
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof='별도 작업';true"}),
        )
        .await?;
        let created = runtime
            .share_instance(BrowserResourceIdentity {
                resource_id: BrowserResourceId::new("creation:unpublished").unwrap(),
                generation: identity.generation.clone(),
                workspace_id: BrowserWorkspaceId::new("workspace:unpublished").unwrap(),
            })
            .await;
        let creation_error = match created {
            Ok(created) => {
                let _ = created.close(&created.control().await.resource).await;
                return Err("fixture_expected_creation_error".into());
            }
            Err(error) => error,
        };
        let acknowledged = tokio::time::timeout(Duration::from_secs(5), observed_effect)
            .await
            .map_err(|_| "fixture_creation_effect_timeout")?
            .map_err(|_| "fixture_creation_effect_missing")?;
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
        let phases = (runtime.control().await.phase, peer.control().await.phase);
        let orphan_live = if browser_exited {
            None
        } else {
            Some(
                live_targets(&mut runtime.test_binding().cdp.clone())
                    .await?
                    .contains(
                        acknowledged["result"]["targetId"]
                            .as_str()
                            .ok_or("fixture_acknowledged_target_missing")?,
                    ),
            )
        };
        let later = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"++window.writes"}),
        )
        .await;
        let independent_value = apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof"}),
        )
        .await?
        .response
        .data["result"]
            .clone();
        let independent_after = independent.observe().await?.pages[0].page.clone();
        let retired_connections = (
            runtime
                .test_binding()
                .cdp
                .clone()
                .request("Browser.getVersion", json!({}), None)
                .await,
            peer.test_binding()
                .cdp
                .clone()
                .request("Browser.getVersion", json!({}), None)
                .await,
        );
        Ok((
            creation_error,
            acknowledged,
            browser_exited,
            worker_exited,
            phases,
            orphan_live,
            later,
            independent_value,
            independent_page,
            independent_after,
            retired_connections,
        ))
    }
    .await;
    runtime
        .test_binding()
        .instance
        .replace_test_endpoint(actual)
        .await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let closed = runtime.close(&identity).await;
    let independent_closed = independent.close(&independent_identity).await;
    let _ = retire.send(());
    let proxy_closed = proxy.await;
    let commands = commands.lock().await.clone();
    println!(
        "BROWSER_CREATION_RESPONSE_LOSS root={} independent_root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?} independent_closed={independent_closed:?} proxy_closed={proxy_closed:?} commands={commands:?}",
        root.display(),
        independent_root.display()
    );
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert!(independent_closed.is_ok(), "{independent_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        error,
        acknowledged,
        browser_exited,
        worker_exited,
        phases,
        orphan_live,
        later,
        value,
        before,
        after,
        connections,
    ) = evidence.unwrap();
    assert!(matches!(error, BrowserRuntimeError::Engine(error) if error.outcome_unknown));
    assert!(acknowledged["result"]["targetId"].as_str().is_some());
    assert_eq!(
        commands
            .iter()
            .filter(|method| *method == "Target.createTarget")
            .count(),
        1
    );
    assert_eq!(value, json!("별도 작업"));
    assert_eq!(after, before);
    assert!(
        browser_exited && worker_exited,
        "An unidentified native page requires exact instance retirement; orphan_live={orphan_live:?}"
    );
    assert_eq!(
        phases,
        (BrowserResourcePhase::Closed, BrowserResourcePhase::Closed)
    );
    assert!(later.is_err(), "{later:?}");
    assert_eq!(
        connections,
        (Err("browser_cdp_retired"), Err("browser_cdp_retired"))
    );
}

async fn proxy(
    listener: TcpListener,
    actual: String,
    effect: oneshot::Sender<Value>,
    mut retired: oneshot::Receiver<()>,
    commands: Arc<tokio::sync::Mutex<Vec<String>>>,
) {
    let effect = Arc::new(tokio::sync::Mutex::new(Some(effect)));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut retired => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted.unwrap();
                let actual = actual.clone();
                let effect = Arc::clone(&effect);
                let commands = Arc::clone(&commands);
                tasks.spawn(async move {
                    let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
                    let uri: tokio_tungstenite::tungstenite::http::Uri = actual.parse().unwrap();
                    let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap())).await.unwrap();
                    let (mut chrome, _) = tokio_tungstenite::client_async(actual, stream).await.unwrap();
                    let mut creation = None;
                    loop {
                        tokio::select! {
                            message = client.next() => {
                                let Some(Ok(message)) = message else { break };
                                if message.is_close() { break; }
                                if let Ok(text) = message.to_text() {
                                    let request: Value = serde_json::from_str(text).unwrap();
                                    if let Some(method) = request["method"].as_str() {
                                        commands.lock().await.push(method.to_owned());
                                        if method == "Target.createTarget" { creation = Some(request["id"].clone()); }
                                    }
                                }
                                if chrome.send(message).await.is_err() { break; }
                            }
                            message = chrome.next() => {
                                let Some(Ok(message)) = message else { break };
                                if let Ok(text) = message.to_text() {
                                    let response: Value = serde_json::from_str(text).unwrap();
                                    if creation.as_ref() == Some(&response["id"]) {
                                        assert!(response["result"]["targetId"].as_str().is_some(), "{response}");
                                        if let Some(effect) = effect.lock().await.take() { let _ = effect.send(response); }
                                        // Drop both actual sessions after Chrome acknowledged creation,
                                        // before the caller receives the target identity.
                                        break;
                                    }
                                }
                                if client.send(message).await.is_err() { break; }
                            }
                        }
                    }
                    let _ = client.close(None).await;
                    let _ = chrome.close(None).await;
                });
            }
        }
    }
    tasks.shutdown().await;
}
