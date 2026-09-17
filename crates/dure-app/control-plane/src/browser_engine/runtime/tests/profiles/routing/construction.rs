use super::*;
use crate::browser_engine::chromium::OwnedChromium;

mod resource_close;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn failed_additional_profile_worker_preserves_the_existing_resource() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-construction-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:failed-construction");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("failed-worker-profile").unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let before = runtime.observe().await?;
        let page = before.pages[0].page.clone();
        let lease = runtime
            .request_control(BrowserControllerId::new("existing-agent").unwrap(), None)
            .await?
            .controller
            .ok_or("controller missing")?;
        let mut unavailable_worker = config.clone();
        // Model a worker disappearing after installation validation. Chromium
        // and its real Host observation start before the worker spawn fails.
        unavailable_worker.executable = root.join("worker-removed-after-validation");
        let failure = runtime
            .launch_binding(&unavailable_worker, Some(&profile_spec(&profile)))
            .await
            .err()
            .ok_or("missing worker was accepted")?;
        let control = runtime.control().await;
        let pages = runtime.host.lock().await.pages();
        let observed = runtime.observe().await;
        let peer = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"'기존 프로필 유지'"}),
        )
        .await;
        let mut reopened = OwnedChromium::launch_profile(&config.chromium, &root, &profile).await?;
        let reopened_closed = reopened.close().await;
        Ok((
            page,
            lease,
            failure,
            control,
            pages,
            observed,
            peer,
            reopened_closed,
        ))
    }
    .await;
    let closed = runtime.close(&resource).await;
    let final_control = runtime.control().await;
    println!(
        "BROWSER_PROFILE_CONSTRUCTION_FAILURE root={} evidence={evidence:?} closed={closed:?} final={final_control:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (page, lease, failure, control, pages, observed, peer, reopened_closed) = evidence.unwrap();
    assert!(matches!(
        failure,
        BrowserRuntimeError::Engine(BrowserEngineError {
            code: "browser_engine_spawn_failed",
            outcome_unknown: false
        })
    ));
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert_eq!(control.controller, Some(lease));
    assert_eq!(pages, vec![page.clone()]);
    assert_eq!(observed.unwrap().pages[0].page, page);
    assert_eq!(peer.unwrap()["result"], "기존 프로필 유지");
    assert!(reopened_closed.is_ok(), "{reopened_closed:?}");
    assert_eq!(final_control.phase, BrowserResourcePhase::Closed);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_additional_profile_construction_retires_its_original_binding() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-cancel-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:canceled-construction");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("canceled-profile").unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let before = runtime.host.lock().await.instance_binding_ids();
        let lease = runtime.request_control(BrowserControllerId::new("original-agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        let directories = || std::fs::read_dir(&root).unwrap().map(|entry|entry.unwrap().path()).filter(|path|path.file_name().unwrap().to_string_lossy().starts_with("browser-")).collect::<std::collections::BTreeSet<_>>();
        let original_workers = directories();
        let mut stalled_worker = config.clone();
        // A real Chromium and observer are ready, but this fixture worker exits
        // before creating its socket. Cancel inside the normal startup wait.
        stalled_worker.executable = Path::new("/usr/bin/false").to_owned();
        let selected_profile = profile_spec(&profile);
        let mut creating = Box::pin(runtime.launch_binding(&stalled_worker, Some(&selected_profile)));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        if let Ok(instance) = result { runtime.retire_binding(&instance).await?; }
                        return Err::<(), BrowserRuntimeError>("construction ended before cancellation".into());
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                        if runtime.host.lock().await.pages().len() == 2
                            && directories().difference(&original_workers).any(|path|path.join("config.json").is_file()) {
                            return Ok(());
                        }
                    }
                }
            }
        }).await;
        drop(creating);
        let retired = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if runtime.host.lock().await.instance_binding_ids() == before { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await;
        let control = runtime.control().await;
        let pages = runtime.host.lock().await.pages();
        let peer = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"'생성 취소 후 기존 탭'"})).await;
        let reopened = match OwnedChromium::launch_profile(&config.chromium, &root, &profile).await {
            Ok(mut browser) => browser.close().await,
            Err(error) => Err(error),
        };
        Ok((page, lease, prepared, retired, control, pages, peer, reopened))
    }.await;
    let closed = runtime.close(&resource).await;
    let final_control = runtime.control().await;
    println!(
        "BROWSER_PROFILE_CONSTRUCTION_CANCELED root={} evidence={evidence:?} closed={closed:?} final={final_control:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (page, lease, prepared, retired, control, pages, peer, reopened) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert!(retired.is_ok(), "{retired:?}");
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert_eq!(control.controller, Some(lease));
    assert_eq!(pages, vec![page]);
    assert_eq!(peer.unwrap()["result"], "생성 취소 후 기존 탭");
    assert!(reopened.is_ok(), "{reopened:?}");
    assert_eq!(final_control.phase, BrowserResourcePhase::Closed);
}
