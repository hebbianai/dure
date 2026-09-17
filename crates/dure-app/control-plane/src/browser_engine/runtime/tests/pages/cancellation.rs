use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_new_page_caller_still_retires_unaccounted_native_creation() {
    canceled_creation(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_new_page_caller_during_retirement_still_confirms_native_exit() {
    canceled_creation(true).await;
}

async fn canceled_creation(during_retirement: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-new-page-canceled-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("canceled-page:owner");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/canceled-page",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = tokio::spawn(lose_reply(
        listener,
        endpoint,
        "Target.createTarget",
        effect,
        stopped,
    ));
    let runtime = Arc::new(
        with_event_connection(chromium, engine, resource.clone(), &address)
            .await
            .unwrap(),
    );
    let peer = runtime
        .share_instance(identity("canceled-page:peer"))
        .await
        .unwrap();
    let independent = BrowserRuntime::launch(identity("canceled-page:independent"), &config, &root)
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
        let independent_page = first_page(&independent).await?;
        let independent_lease = independent
            .request_control(controller, None)
            .await?
            .controller
            .unwrap();
        apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof='취소와 분리된 작업';true"}),
        )
        .await?;
        let caller_runtime = Arc::clone(&runtime);
        let caller = tokio::spawn(async move {
            apply(
                &caller_runtime,
                &lease,
                &page,
                json!({"kind":"new_page","url":"about:blank"}),
            )
            .await
        });
        let acknowledged = timeout(Duration::from_secs(5), observed_effect).await;
        let worker = if during_retirement {
            // Queue behind the actual action worker. When creation times out,
            // retain this exact lock while its process retirement begins.
            Some(runtime.test_binding().engine.clone().lock_owned().await)
        } else {
            None
        };
        let retiring = if during_retirement {
            timeout(Duration::from_secs(3), async {
                while runtime.control().await.phase != BrowserResourcePhase::Retiring {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok()
        } else {
            true
        };
        caller.abort();
        let canceled = caller.await.is_err_and(|error| error.is_cancelled());
        drop(worker);
        let acknowledged = acknowledged
            .map_err(|_| "fixture_page_creation_timeout")?
            .map_err(|_| "fixture_page_creation_unobserved")?;
        let target = BrowserTargetId::new(
            acknowledged["result"]["targetId"]
                .as_str()
                .ok_or("fixture_created_target_missing")?,
        )
        .unwrap();
        let settled = timeout(Duration::from_secs(15), async {
            loop {
                if runtime.control().await.phase == BrowserResourcePhase::Closed
                    && peer.control().await.phase == BrowserResourcePhase::Closed
                {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let phases = (runtime.control().await, peer.control().await);
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
        let orphan_live = if browser_exited {
            None
        } else {
            Some(boundaries::targets(&runtime).await?.contains(&target))
        };
        let owned = runtime.host.lock().await.owns_page_target(&target);
        let value = apply(
            &independent,
            &independent_lease,
            &independent_page,
            json!({"kind":"evaluate","script":"window.proof"}),
        )
        .await?;
        let after = first_page(&independent).await?;
        Ok((
            canceled,
            retiring,
            settled,
            phases,
            browser_exited,
            worker_exited,
            orphan_live,
            owned,
            value,
            independent_page,
            after,
        ))
    }
    .await;
    let closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let independent_closed = independent
        .close(&independent.control().await.resource)
        .await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_NEW_PAGE_CALLER_CANCELED during_retirement={during_retirement} root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} independent_closed={independent_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(independent_closed.is_ok(), "{independent_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        canceled,
        retiring,
        settled,
        phases,
        browser_exited,
        worker_exited,
        orphan_live,
        owned,
        value,
        before,
        after,
    ) = evidence.unwrap();
    assert!(canceled);
    assert!(
        retiring,
        "fixture did not reach retirement before cancellation"
    );
    assert_eq!(value["result"], json!("취소와 분리된 작업"));
    assert_eq!(after, before);
    assert!(
        settled && browser_exited && worker_exited,
        "Canceled caller abandoned creation: phases={phases:?}, orphan_live={orphan_live:?}, owned={owned}"
    );
    assert_eq!(phases.0.phase, BrowserResourcePhase::Closed);
    assert_eq!(phases.1.phase, BrowserResourcePhase::Closed);
}
