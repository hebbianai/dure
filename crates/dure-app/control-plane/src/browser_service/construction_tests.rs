use super::*;
mod deletion;
mod init_scripts;
mod personal;
mod profiles;
use dure_app::{ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1};
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    root: PathBuf,
    service: BrowserService,
    store: SqliteDomainStore,
}

impl Fixture {
    async fn new(chromium: &Path) -> Self {
        let root = tempfile::Builder::new()
            .prefix("dure-browser-service-create-")
            .tempdir_in("/tmp")
            .unwrap()
            .keep();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let store = SqliteDomainStore::open(root.join("domain.sqlite3"))
            .await
            .unwrap();
        let project_id = ProjectIdV1::new("project:construction").unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project_id.clone(),
                root_path: root.to_string_lossy().into_owned(),
                display_name: "Browser construction fixture".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: WorkspaceIdV1::new("workspace:construction").unwrap(),
                project_id,
                root_path: root.to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        let backend = crate::backend_runtime_root::ensure(&root).unwrap();
        let service = BrowserService::new(backend, "generation:construction", &root);
        std::fs::create_dir(root.join("browser")).unwrap();
        std::fs::write(
            &service.installation,
            serde_json::to_vec(&json!({
                "engineExecutable":std::env::var("DURE_BROWSER_TEST_BINARY").unwrap(),
                "chromiumExecutable":chromium,
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&service.installation, std::fs::Permissions::from_mode(0o600))
            .unwrap();
        Self {
            root,
            service,
            store,
        }
    }

    async fn list(&self) -> Result<Value, BackendDispatchError> {
        self.service
            .dispatch(&self.store, &json!({"kind":"list"}))
            .await
    }

    async fn finish(&self) -> Result<(), crate::ControlPlaneError> {
        let closed = self.service.shutdown().await;
        self.store.close().await;
        closed?;
        let alias: PathBuf = self
            .service
            .root
            .address_for(self.service.root.durable())?
            .components()
            .collect();
        assert_eq!(
            std::fs::read_link(&alias).unwrap(),
            self.root.join("backend")
        );
        std::fs::remove_file(alias).unwrap();
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn initial_browser_construction_is_listed_and_closeable_before_startup_finishes() {
    let scripts = tempfile::Builder::new()
        .prefix("dure-browser-service-startup-")
        .tempdir_in("/tmp")
        .unwrap();
    let marker = scripts.path().join("started");
    let executable = scripts.path().join("chromium");
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf started > {}\nsleep 1\nexec {} \"$@\"\n",
            quote(&marker),
            quote(&chromium)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Fixture::new(&executable).await;
    let body = json!({"kind":"create","operation_id":"create:during-startup","init_scripts":["window.startup='owned';"]});
    let evidence: Result<_, BackendDispatchError> = async {
        let mut creating = Box::pin(fixture.service.dispatch(&fixture.store, &body));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err(BackendDispatchError::terminal("fixture_creation_finished_early"));
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {
                        if marker.is_file() { return Ok(()); }
                    }
                }
            }
        }).await;
        let listed = fixture.list().await?;
        // Only the actual service projection supplies Close authority. The RED
        // path still drives creation and awaits shutdown before assertions.
        let resource = listed.pointer("/result/resources/0/resource").cloned();
        let (created, closed) = tokio::join!(creating.as_mut(), async {
            match resource {
                Some(resource) => Some(fixture.service.dispatch(&fixture.store, &json!({
                    "kind":"close","operation_id":"close:during-startup","resource":resource
                })).await),
                None => None,
            }
        });
        let after = fixture.list().await?;
        let replay = fixture.service.dispatch(&fixture.store, &body).await?;
        Ok((prepared, listed, created, closed, after, replay))
    }.await;
    let cleaned = fixture.finish().await;
    println!(
        "BROWSER_SERVICE_INITIAL_STARTUP root={} evidence={evidence:?} cleanup={cleaned:?}",
        fixture.root.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    let (prepared, listed, created, closed, after, replay) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert_eq!(listed["result"]["resources"].as_array().unwrap().len(), 1);
    assert!(created.is_err(), "{created:?}");
    assert_eq!(closed.unwrap().unwrap()["result"]["closed"], true);
    assert!(after["result"]["resources"].as_array().unwrap().is_empty());
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["receipt"]["state"], "failed");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn failed_initial_browser_cleanup_remains_reachable_for_service_close_retry() {
    let scripts = tempfile::Builder::new()
        .prefix("dure-browser-service-failure-")
        .tempdir_in("/tmp")
        .unwrap();
    let marker = scripts.path().join("started");
    let executable = scripts.path().join("chromium");
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf started > {}\nsleep 1\nexec {} \"$@\"\n",
            quote(&marker),
            quote(&chromium)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Fixture::new(&executable).await;
    let worker = scripts.path().join("worker");
    std::fs::copy(std::env::var("DURE_BROWSER_TEST_BINARY").unwrap(), &worker).unwrap();
    std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        &fixture.service.installation,
        serde_json::to_vec(&json!({
            "engineExecutable":worker,"chromiumExecutable":executable,
        }))
        .unwrap(),
    )
    .unwrap();
    let body = json!({"kind":"create","operation_id":"create:cleanup-failure"});
    let evidence: Result<_, BackendDispatchError> = async {
        let mut creating = Box::pin(fixture.service.dispatch(&fixture.store, &body));
        let prepared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut replaced = false;
            loop {
                tokio::select! {
                    result = creating.as_mut() => {
                        result?;
                        return Err(BackendDispatchError::terminal("fixture_creation_finished_early"));
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {
                        if marker.is_file() && !replaced {
                            // The pinned fixture copy was validated before the
                            // original Chromium started. Fail only this worker.
                            std::fs::copy("/usr/bin/false", &worker).unwrap();
                            replaced = true;
                        }
                        if replaced && std::fs::read_dir(fixture.service.root.durable()).unwrap()
                            .any(|entry|entry.unwrap().path().join("config.json").is_file()) {
                            return Ok(());
                        }
                    }
                }
            }
        }).await;
        let downloads = std::fs::read_dir(fixture.service.root.durable()).unwrap()
            .map(|entry|entry.unwrap().path().join("downloads"))
            .find(|path|path.is_dir())
            .ok_or_else(||BackendDispatchError::terminal("fixture_downloads_missing"))?;
        let retained = downloads.with_file_name("downloads-retained-by-fixture");
        std::fs::rename(&downloads, &retained).unwrap();
        std::fs::write(&downloads,b"initial-service-cleanup-fault").unwrap();
        let created = creating.as_mut().await;
        let listed = fixture.list().await?;
        let resource = listed.pointer("/result/resources/0/resource").cloned();
        let failed_close = match resource.as_ref() {
            Some(resource) => Some(fixture.service.dispatch(&fixture.store,&json!({
                "kind":"close","resource":resource,"operation_id":"close:cleanup-failed"
            })).await),
            None => None,
        };
        let before_retry_slots = fixture.service.slots.available_permits();
        // Repair the exact fixture path before assertions or a fresh Close.
        assert_eq!(std::fs::read(&downloads).unwrap(),b"initial-service-cleanup-fault");
        std::fs::remove_file(&downloads).unwrap();
        std::fs::rename(&retained,&downloads).unwrap();
        let retried = match resource {
            Some(resource) => Some(fixture.service.dispatch(&fixture.store,&json!({
                "kind":"close","resource":resource,"operation_id":"close:cleanup-retry"
            })).await),
            None => None,
        };
        let removed = !downloads.exists();
        let after = fixture.list().await?;
        let replay = fixture.service.dispatch(&fixture.store,&body).await?;
        let after_retry_slots = fixture.service.slots.available_permits();
        Ok((prepared,created,listed,failed_close,before_retry_slots,retried,removed,after,replay,after_retry_slots))
    }.await;
    let cleaned = fixture.finish().await;
    println!(
        "BROWSER_SERVICE_INITIAL_CLEANUP_RETRY root={} evidence={evidence:?} cleanup={cleaned:?}",
        fixture.root.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    let (
        prepared,
        created,
        listed,
        failed_close,
        before_slots,
        retried,
        removed,
        after,
        replay,
        after_slots,
    ) = evidence.unwrap();
    assert!(prepared.unwrap().is_ok());
    assert!(created.is_err(), "{created:?}");
    assert_eq!(listed["result"]["resources"].as_array().unwrap().len(), 1);
    assert_eq!(listed["result"]["resources"][0]["phase"], "closed");
    assert_eq!(
        failed_close.unwrap().unwrap_err().code,
        "browser_download_storage_unavailable"
    );
    assert_eq!(before_slots, 7);
    assert_eq!(retried.unwrap().unwrap()["result"]["closed"], true);
    assert!(removed);
    assert!(after["result"]["resources"].as_array().unwrap().is_empty());
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["receipt"]["state"], "failed");
    assert_eq!(after_slots, 8);
}
