use super::*;
use dure_app::BrowserProfileIdV1;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_profile_creation_reply_retires_the_destination_and_preserves_the_origin() {
    destination_retirement(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_profile_creation_retires_the_destination_and_preserves_the_origin() {
    destination_retirement(true).await;
}

async fn destination_retirement(cancel: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-destination-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let selected = BrowserProfileIdV1::new("profile:destination").unwrap();
    let mut chromium = OwnedChromium::launch_profile(&config.chromium, &root, &selected)
        .await
        .unwrap();
    let attached = async {
        let target = chromium.launch_page().await?;
        NativeBrowserEngine::attach(&config, &root, chromium.connection(), &target).await
    }
    .await;
    if attached.is_err() {
        chromium.close().await.unwrap();
    }
    let engine = attached.unwrap();
    let resource = identity("profile:destination-loss");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/destination-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = tokio::spawn(lose_reply(
        listener,
        engine.chromium.endpoint().to_owned(),
        "Target.createTarget",
        effect,
        stopped,
    ));
    let runtime = Arc::new(
        with_event_connection(chromium, engine, resource.clone(), &address)
            .await
            .unwrap(),
    );
    let destination = Arc::clone(&runtime.test_binding().instance);
    let peer = runtime
        .share_instance(identity("profile:destination-peer"))
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let origin_id = runtime
            .launch_binding(
                &config,
                Some(&profile_spec(
                    &BrowserProfileIdV1::new("profile:origin").unwrap(),
                )),
            )
            .await?;
        let (origin, origin_page, target, endpoint) = {
            let execution = runtime.execution_for_instance(&origin_id)?;
            let page = execution
                .observe()
                .await?
                .pages
                .first()
                .ok_or("origin page missing")?
                .page
                .clone();
            let target = runtime.host.lock().await.target_for(&page)?.clone();
            let endpoint = execution
                .binding
                .instance
                .connection()
                .await
                .endpoint()
                .to_owned();
            (
                Arc::clone(&execution.binding.instance),
                page,
                target,
                endpoint,
            )
        };
        let lease = runtime
            .request_control(BrowserControllerId::new("profile-agent").unwrap(), None)
            .await?
            .controller
            .ok_or("controller missing")?;
        apply(
            &runtime,
            &lease,
            &origin_page,
            json!({"kind":"evaluate","script":"window.originProof='원본 탭 유지';true"}),
        )
        .await?;
        let caller_runtime = Arc::clone(&runtime);
        let caller_page = origin_page.clone();
        let caller = tokio::spawn(async move {
            caller_runtime
                .set_profile(
                    &lease.controller_id,
                    &authority(&caller_runtime, &lease, &caller_page).await,
                    &config,
                    &profile_spec(&selected),
                )
                .await
        });
        let acknowledged = timeout(Duration::from_secs(10), observed_effect).await;
        if cancel {
            caller.abort();
        }
        let result = caller.await;
        let acknowledged = acknowledged
            .map_err(|_| "fixture_creation_not_observed")?
            .map_err(|_| "fixture_creation_signal_lost")?;
        let settled = timeout(Duration::from_secs(10), async {
            while runtime.host.lock().await.instance_binding_ids().len() != 1 {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let exited = (
            destination.browser_has_exited().await?,
            origin.browser_has_exited().await?,
        );
        let peer_phase = peer.control().await.phase;
        let control = runtime.control().await;
        let (remaining, pages) = {
            let host = runtime.host.lock().await;
            (host.instance_binding_ids(), host.pages())
        };
        let original_value: Result<_, &'static str> = async {
            let mut cdp = BrowserCdp::connect(&endpoint).await?;
            let result = async {
                let session = cdp.attach(target.as_str()).await?;
                cdp.request(
                    "Runtime.evaluate",
                    json!({"expression":"window.originProof","returnByValue":true}),
                    Some(&session),
                )
                .await
            }
            .await;
            cdp.retire().await;
            result
        }
        .await;
        Ok((
            (result, acknowledged, settled, exited, peer_phase),
            (
                control,
                remaining,
                pages,
                origin_id,
                origin_page,
                original_value,
            ),
        ))
    }
    .await;
    let closed = runtime.close(&resource).await;
    let peer_closed = peer.close(&peer.control().await.resource).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_PROFILE_DESTINATION_LOSS cancel={cancel} root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} proxy={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        (result, acknowledged, settled, exited, peer_phase),
        (control, remaining, pages, origin_id, origin_page, original_value),
    ) = evidence.unwrap();
    if cancel {
        assert!(result.is_err_and(|error| error.is_cancelled()));
    } else {
        assert!(matches!(
            result,
            Ok(Err(BrowserRuntimeError::Engine(BrowserEngineError {
                outcome_unknown: true,
                ..
            })))
        ));
    }
    assert!(acknowledged["result"]["targetId"].as_str().is_some());
    assert!(settled);
    assert_eq!(exited, (true, false));
    assert_eq!(peer_phase, BrowserResourcePhase::Closed);
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert_eq!(remaining, vec![origin_id]);
    assert_eq!(pages, vec![origin_page]);
    assert_eq!(original_value.unwrap()["result"]["value"], "원본 탭 유지");
}
