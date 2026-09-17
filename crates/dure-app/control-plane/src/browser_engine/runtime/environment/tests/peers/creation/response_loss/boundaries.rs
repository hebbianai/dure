use super::*;

fn identity(name: &str) -> BrowserResourceIdentity {
    BrowserResourceIdentity {
        resource_id: BrowserResourceId::new(name).unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new(name).unwrap(),
    }
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn failed_creation_connection_preserves_the_existing_instance() {
    let (runtime, resource, root) = launch("creation:connection-failure").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/absent",
        listener.local_addr().unwrap()
    );
    drop(listener);
    let actual = runtime
        .test_binding()
        .instance
        .replace_test_endpoint(address)
        .await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let controller = BrowserControllerId::new("agent").unwrap();
        let lease = runtime
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        let created = runtime
            .share_instance(identity("creation:connection-failed-peer"))
            .await;
        let error = match created {
            Ok(created) => {
                let _ = created.close(&created.control().await.resource).await;
                return Err("fixture_expected_connection_failure".into());
            }
            Err(error) => error,
        };
        let after = runtime.observe().await?.pages[0].page.clone();
        let result = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"'연결 실패 후에도 계속'"}),
        )
        .await?;
        Ok((
            error,
            page,
            after,
            result.response.data["result"].clone(),
            runtime.control().await.phase,
        ))
    }
    .await;
    runtime
        .test_binding()
        .instance
        .replace_test_endpoint(actual)
        .await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_CREATION_CONNECTION_FAILURE root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (error, before, after, result, phase) = evidence.unwrap();
    assert!(matches!(error, BrowserRuntimeError::Engine(error) if !error.outcome_unknown));
    assert_eq!(after, before);
    assert_eq!(result, json!("연결 실패 후에도 계속"));
    assert_eq!(phase, BrowserResourcePhase::Ready);
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn instance_failure_fences_input_and_a_concurrent_resource_before_worker_exit() {
    let (runtime, resource, root) = launch("creation:concurrent-loss").await;
    let runtime = Arc::new(runtime);
    let peer = Arc::new(
        runtime
            .share_instance(identity("creation:concurrent-origin"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/concurrent-loss",
        listener.local_addr().unwrap()
    );
    let actual = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .chromium
        .endpoint()
        .to_owned();
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
        let mut cdp = runtime.test_binding().cdp.clone();
        let before = live_targets(&mut cdp).await?;
        let mut worker = runtime.test_binding().engine.clone().lock_owned().await;
        let origin = Arc::clone(&peer);
        let mut constructing = tokio::spawn(async move {
            origin
                .share_instance(identity("creation:concurrent-unpublished"))
                .await
        });
        let native_created = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let live = live_targets(&mut cdp).await?;
                if live.difference(&before).count() == 1 {
                    return Ok::<_, BrowserRuntimeError>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        runtime
            .test_binding()
            .instance
            .replace_test_endpoint(address)
            .await;
        let origin = Arc::clone(&runtime);
        let failing = tokio::spawn(async move {
            origin
                .share_instance(identity("creation:concurrent-unknown"))
                .await
        });
        let acknowledged = tokio::time::timeout(Duration::from_secs(5), observed_effect).await;
        let fenced = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let a = runtime.control().await.phase;
                let b = peer.control().await.phase;
                if a == BrowserResourcePhase::Retiring && b == BrowserResourcePhase::Retiring {
                    return (a, b);
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let premature = tokio::time::timeout(Duration::from_millis(100), &mut constructing).await;
        let published_early = premature.is_ok();
        let worker_live_while_fenced = worker
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_none();
        drop(worker);
        let constructing = match premature {
            Ok(result) => result,
            Err(_) => constructing.await,
        };
        let failed = failing.await;
        let mut published = Vec::new();
        for result in [constructing, failed] {
            match result {
                Ok(Ok(created)) => {
                    published.push(true);
                    let _ = created.close(&created.control().await.resource).await;
                }
                Ok(Err(_)) => published.push(false),
                Err(_) => return Err("fixture_construction_task_failed".into()),
            }
        }
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
        Ok((
            native_created,
            acknowledged,
            fenced,
            published_early,
            worker_live_while_fenced,
            published,
            browser_exited,
            worker_exited,
            phases,
        ))
    }
    .await;
    runtime
        .test_binding()
        .instance
        .replace_test_endpoint(actual)
        .await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let closed = runtime.close(&resource).await;
    let _ = retire.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_CONCURRENT_CREATION_FAILURE root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        native_created,
        acknowledged,
        fenced,
        published_early,
        worker_live_while_fenced,
        published,
        browser_exited,
        worker_exited,
        phases,
    ) = evidence.unwrap();
    assert!(matches!(native_created, Ok(Ok(()))), "{native_created:?}");
    assert!(matches!(acknowledged, Ok(Ok(_))), "{acknowledged:?}");
    assert!(fenced.is_ok(), "{fenced:?}");
    assert!(worker_live_while_fenced);
    assert!(!published_early);
    assert_eq!(published, [false, false]);
    assert!(browser_exited && worker_exited);
    assert_eq!(
        phases,
        (BrowserResourcePhase::Closed, BrowserResourcePhase::Closed)
    );
}
