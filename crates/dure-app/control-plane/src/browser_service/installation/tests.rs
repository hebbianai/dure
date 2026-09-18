use super::*;

#[test]
fn rejects_truncated_and_same_size_corrupt_downloads() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("download");
    let pin = Download {
        url: String::new(),
        size: 4,
        sha256: format!("{:x}", Sha256::digest(b"good")),
        executable: String::new(),
    };
    for bytes in [b"bad".as_slice(), b"evil".as_slice()] {
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            verify_download(&pin, &path),
            Err("browser_installation_pin_mismatch")
        );
    }
    std::fs::write(&path, b"good").unwrap();
    assert_eq!(verify_download(&pin, &path), Ok(()));
}

#[tokio::test]
async fn duplicate_install_and_status_observe_the_same_task_and_shutdown_cancels_it() {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("installation.json");
    let installer = Installer::default();
    assert_eq!(installer.status(&path, false).await["state"], "missing");
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    installer.0.lock().await.task = Some(tokio::spawn(async move {
        let _ = receiver.await;
        Ok(())
    }));
    for start in [true, false, true] {
        assert_eq!(installer.status(&path, start).await["state"], "installing");
    }
    installer.stop().await;
    assert!(sender.is_closed());
    assert!(!path.exists());
    assert_eq!(installer.status(&path, false).await["state"], "missing");
}

#[tokio::test]
async fn failed_install_is_observable_without_publishing_an_activation() {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("installation.json");
    let installer = Installer::default();
    installer.0.lock().await.task = Some(tokio::spawn(async {
        Err("browser_installation_pin_mismatch")
    }));
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(
        installer.status(&path, false).await,
        json!({"state":"failed","code":"browser_installation_pin_mismatch"})
    );
    assert!(!path.exists());
}

#[tokio::test]
#[ignore = "downloads the pinned upstream runtime and launches Chromium in a disposable home"]
async fn fresh_home_download_install_and_browser_creation() {
    let home = tempfile::Builder::new()
        .prefix("dure-public-browser-")
        .tempdir_in("/tmp")
        .unwrap();
    let backend = crate::backend_runtime_root::ensure(home.path()).unwrap();
    let alias: PathBuf = backend
        .address_for(backend.durable())
        .unwrap()
        .components()
        .collect();
    let store = SqliteDomainStore::open(home.path().join("domain.sqlite3"))
        .await
        .unwrap();
    let service = BrowserService::new(backend, "generation:public-install", home.path());
    assert_eq!(
        service
            .dispatch(&store, &json!({"kind":"runtime_status"}))
            .await
            .unwrap()["result"]["state"],
        "missing"
    );
    assert_eq!(
        service
            .dispatch(&store, &json!({"kind":"runtime_install"}))
            .await
            .unwrap()["result"]["state"],
        "installing"
    );
    tokio::time::timeout(Duration::from_secs(720), async {
        loop {
            let status = service
                .dispatch(&store, &json!({"kind":"runtime_status"}))
                .await
                .unwrap();
            match status["result"]["state"].as_str() {
                Some("ready") => break,
                Some("installing") => tokio::time::sleep(Duration::from_secs(1)).await,
                _ => panic!("unexpected installation status: {status}"),
            }
        }
    })
    .await
    .unwrap();
    let result = service
        .dispatch(
            &store,
            &json!({"kind":"create","operation_id":"public-install-create"}),
        )
        .await;
    // Retire all fixture-owned processes even if creation failed.
    service.shutdown().await.unwrap();
    store.close().await;
    std::fs::remove_file(alias).unwrap();
    assert_eq!(result.unwrap()["result"]["control"]["phase"], "ready");
}
