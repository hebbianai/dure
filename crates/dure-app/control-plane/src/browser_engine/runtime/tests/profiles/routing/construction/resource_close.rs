use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn resource_close_joins_pending_profile_creation_before_reporting_closed() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-close-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:close-construction");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("pending-at-close").unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let directories = || std::fs::read_dir(&root).unwrap().map(|entry|entry.unwrap().path()).filter(|path|path.file_name().unwrap().to_string_lossy().starts_with("browser-")).collect::<std::collections::BTreeSet<_>>();
        let original_workers = directories();
        let mut stalled_worker = config.clone();
        stalled_worker.executable = Path::new("/usr/bin/false").to_owned();
        let selected_profile = profile_spec(&profile);
        let mut creating = Box::pin(runtime.launch_binding(&stalled_worker, Some(&selected_profile)));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err::<(), BrowserRuntimeError>("construction ended before resource close".into());
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
        let started = std::time::Instant::now();
        let (creation, (closed, at_return, close_elapsed)) = tokio::join!(creating.as_mut(), async {
            let closed = runtime.close(&resource).await;
            (closed, runtime.control().await, started.elapsed())
        });
        let mut reopened = OwnedChromium::launch_profile(&config.chromium, &root, &profile).await?;
        let reopened_closed = reopened.close().await;
        Ok((prepared, creation, closed, at_return, close_elapsed, reopened_closed))
    }.await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_RESOURCE_CLOSE_CONSTRUCTION root={} evidence={evidence:?} cleanup={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (prepared, creation, closed, at_return, elapsed, reopened_closed) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert!(creation.is_err(), "{creation:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(at_return.phase, BrowserResourcePhase::Closed);
    assert!(elapsed < std::time::Duration::from_secs(5), "{elapsed:?}");
    assert!(reopened_closed.is_ok(), "{reopened_closed:?}");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn resource_close_retries_failed_construction_scratch_cleanup() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-cleanup-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:cleanup-retry");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("cleanup-retry").unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let directories = || std::fs::read_dir(&root).unwrap().map(|entry|entry.unwrap().path()).filter(|path|path.file_name().unwrap().to_string_lossy().starts_with("browser-")).collect::<std::collections::BTreeSet<_>>();
        let original = directories();
        let mut stalled_worker = config.clone();
        stalled_worker.executable = Path::new("/usr/bin/false").to_owned();
        let selected_profile = profile_spec(&profile);
        let mut creating = Box::pin(runtime.launch_binding(&stalled_worker, Some(&selected_profile)));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err::<(), BrowserRuntimeError>("construction ended before cleanup fault".into());
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                        if runtime.host.lock().await.pages().len() == 2
                            && directories().difference(&original).any(|path|path.join("config.json").is_file()) { return Ok(()); }
                    }
                }
            }
        }).await;
        let downloads = directories().difference(&original).map(|path|path.join("downloads")).find(|path|path.is_dir()).ok_or("fixture downloads missing")?;
        let retained = downloads.with_file_name("downloads-retained-by-fixture");
        std::fs::rename(&downloads, &retained).map_err(|_| "fixture download retention failed")?;
        std::fs::write(&downloads, b"owned-construction-cleanup-fault").map_err(|_| "fixture download fault failed")?;
        let (creation, failed_close) = tokio::join!(creating.as_mut(), runtime.close(&resource));
        let native_closed = runtime.control().await;
        // Restore the exact fixture path before every assertion and retry the
        // same resource; no second browser or cleanup registry can satisfy it.
        let marker = std::fs::read(&downloads).map_err(|_| "fixture marker missing")?;
        if marker != b"owned-construction-cleanup-fault" { return Err("fixture marker changed".into()); }
        std::fs::remove_file(&downloads).map_err(|_| "fixture marker cleanup failed")?;
        std::fs::rename(&retained, &downloads).map_err(|_| "fixture download restore failed")?;
        let retried = runtime.close(&resource).await;
        let removed = !downloads.exists();
        let after = runtime.control().await;
        let mut reopened = OwnedChromium::launch_profile(&config.chromium, &root, &profile).await?;
        let reopened_closed = reopened.close().await;
        Ok((prepared, creation, failed_close, native_closed, retried, removed, after, reopened_closed))
    }.await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_CONSTRUCTION_CLEANUP_RETRY root={} evidence={evidence:?} cleanup={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (prepared, creation, failed_close, native_closed, retried, removed, after, reopened_closed) =
        evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert!(creation.is_err(), "{creation:?}");
    assert!(failed_close.is_err(), "{failed_close:?}");
    assert_eq!(native_closed.phase, BrowserResourcePhase::Closed);
    assert!(retried.is_ok(), "{retried:?}");
    assert!(removed);
    assert_eq!(after.phase, BrowserResourcePhase::Closed);
    assert!(reopened_closed.is_ok(), "{reopened_closed:?}");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn unconfirmed_pending_browser_close_retains_the_same_child_for_retry() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-exit-retry-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:exit-retry");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("exit-retry").unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let before = runtime.host.lock().await.instance_binding_ids();
        let directories = || std::fs::read_dir(&root).unwrap().map(|entry|entry.unwrap().path()).filter(|path|path.file_name().unwrap().to_string_lossy().starts_with("browser-")).collect::<std::collections::BTreeSet<_>>();
        let original = directories();
        let mut stalled_worker = config.clone();
        stalled_worker.executable = Path::new("/usr/bin/false").to_owned();
        let selected_profile = profile_spec(&profile);
        let mut creating = Box::pin(runtime.launch_binding(&stalled_worker, Some(&selected_profile)));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err::<(), BrowserRuntimeError>("construction ended before exit fault".into());
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                        if runtime.host.lock().await.pages().len() == 2
                            && directories().difference(&original).any(|path|path.join("config.json").is_file()) { return Ok(()); }
                    }
                }
            }
        }).await;
        let instance = runtime.host.lock().await.instance_binding_ids().into_iter().find(|id|!before.contains(id)).ok_or("pending instance missing")?;
        let slot = Arc::clone(runtime.bindings.lock().unwrap().get(&instance).ok_or("pending owner missing")?);
        let invalid_endpoint = "ws://127.0.0.1:0/devtools/browser/owned-exit-fault";
        let endpoint = slot.replace_test_endpoint(invalid_endpoint.into()).await?;
        let (creation, failed_close) = tokio::join!(creating.as_mut(), runtime.close(&resource));
        let phase = runtime.control().await.phase;
        let child_alive = !slot.browser_has_exited().await?;
        let retained = runtime.bindings.lock().unwrap().get(&instance).is_some_and(|entry|Arc::ptr_eq(entry,&slot));
        let restored = slot.replace_test_endpoint(endpoint).await?;
        let retried = runtime.close(&resource).await;
        let removed = !runtime.bindings.lock().unwrap().contains_key(&instance);
        let after = runtime.control().await;
        let mut reopened = OwnedChromium::launch_profile(&config.chromium, &root, &profile).await?;
        let reopened_closed = reopened.close().await;
        Ok((prepared, creation, failed_close, phase, child_alive, retained, restored, retried, removed, after, reopened_closed))
    }.await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_PENDING_NATIVE_EXIT_RETRY root={} evidence={evidence:?} cleanup={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (
        prepared,
        creation,
        failed_close,
        phase,
        child_alive,
        retained,
        restored,
        retried,
        removed,
        after,
        reopened_closed,
    ) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert!(creation.is_err(), "{creation:?}");
    assert!(failed_close.is_err(), "{failed_close:?}");
    assert_eq!(phase, BrowserResourcePhase::Retiring);
    assert!(child_alive && retained);
    assert_eq!(
        restored,
        "ws://127.0.0.1:0/devtools/browser/owned-exit-fault"
    );
    assert!(retried.is_ok(), "{retried:?}");
    assert!(removed);
    assert_eq!(after.phase, BrowserResourcePhase::Closed);
    assert!(reopened_closed.is_ok(), "{reopened_closed:?}");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn resource_close_waits_for_chromium_before_its_endpoint_is_announced() {
    use std::os::unix::fs::PermissionsExt;
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-start-close-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:close-startup");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let profile = BrowserProfileIdV1::new("close-before-endpoint").unwrap();
    let marker = root.join("chromium-starting");
    let executable = root.join("delayed-chromium");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    // exec preserves the original child: the resource must wait for its actual
    // Chromium endpoint and retire that same process, including this startup gap.
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf started > {}\nsleep 1\nexec {} \"$@\"\n",
            quote(&marker),
            quote(&config.chromium)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let mut delayed = config.clone();
        delayed.chromium = executable;
        let selected_profile = profile_spec(&profile);
        let mut creating = Box::pin(runtime.launch_binding(&delayed, Some(&selected_profile)));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err::<(), BrowserRuntimeError>("construction ended before startup close".into());
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {
                        if marker.is_file() { return Ok(()); }
                    }
                }
            }
        }).await;
        let before_pages = runtime.host.lock().await.pages().len();
        let (creation, (closed, reopened_closed)) = tokio::join!(creating.as_mut(), async {
            let closed = runtime.close(&resource).await;
            // Reopening happens immediately after close returns, while the
            // original construction future is still independently driven.
            let reopened_closed = match OwnedChromium::launch_profile(&config.chromium, &root, &profile).await {
                Ok(mut reopened) => reopened.close().await,
                Err(error) => Err(error),
            };
            (closed, reopened_closed)
        });
        Ok((prepared, before_pages, creation, closed, reopened_closed))
    }.await;
    let closed = runtime.close(&resource).await;
    let after = runtime.control().await;
    println!(
        "BROWSER_CLOSE_BEFORE_CHROMIUM_ENDPOINT root={} evidence={evidence:?} cleanup={closed:?} final={after:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (prepared, before_pages, creation, closed, reopened_closed) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert_eq!(before_pages, 1);
    assert!(creation.is_err(), "{creation:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert!(reopened_closed.is_ok(), "{reopened_closed:?}");
    assert_eq!(after.phase, BrowserResourcePhase::Closed);
}
