use super::*;
use dure_app::{BrowserProfileIdV1, BrowserProfileStateV1, BrowserProfileStore};
use std::time::Duration;
use tokio::time::{sleep, timeout};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_profile_delete_retains_pending_native_owner_and_resumes_after_exit() {
    let scripts = tempfile::Builder::new()
        .prefix("dure-browser-profile-delete-pending-")
        .tempdir_in("/tmp")
        .unwrap();
    let marker = scripts.path().join("started");
    let release = scripts.path().join("release");
    let executable = scripts.path().join("chromium");
    let chromium = PathBuf::from(std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap());
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(&executable,format!(
        "#!/bin/sh\nprintf 'started\\n' >> {}\nwhile [ ! -f {} ]; do sleep 0.02; done\nexec {} \"$@\"\n",
        quote(&marker),quote(&release),quote(&chromium)
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Arc::new(Fixture::new(&executable).await);
    let created = fixture.service.dispatch(&fixture.store,&json!({"kind":"profile_create","operation_id":"pending:catalog","label":"시작 중 삭제"})).await.unwrap();
    let id = BrowserProfileIdV1::new(
        created["result"]["profile"]["profile"]["profileId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let creating = {
        let fixture = Arc::clone(&fixture);
        let id = id.clone();
        tokio::spawn(async move {
            fixture.service.dispatch(&fixture.store,&json!({"kind":"create","workspace_id":"workspace:construction","operation_id":"pending:launch","profile_id":id})).await
        })
    };
    let starting = timeout(Duration::from_secs(5), async {
        while !marker.is_file() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let body =
        json!({"kind":"profile_delete","operation_id":"pending:delete-canceled","profile_id":id});
    let mut deleting = Box::pin(fixture.service.dispatch(&fixture.store, &body));
    let early = timeout(Duration::from_millis(300), deleting.as_mut()).await;
    let during = fixture.list().await;
    let record = fixture.store.browser_profile(&id).await;
    let storage = fixture
        .root
        .join("backend/browser-profiles")
        .join(format!("{:x}", Sha256::digest(id.as_str().as_bytes())));
    let retained =
        storage.join("profile/Default").is_dir() && storage.join("native-claim.json").is_file();
    let rejected=fixture.service.dispatch(&fixture.store,&json!({"kind":"create","workspace_id":"workspace:construction","operation_id":"pending:late-launch","profile_id":id})).await;
    drop(deleting);
    // Release this exact launcher even when any recorded observation failed.
    std::fs::write(&release, b"release").unwrap();
    let created = timeout(Duration::from_secs(40), creating).await;
    let retried=timeout(Duration::from_secs(40),fixture.service.dispatch(&fixture.store,&json!({"kind":"profile_delete","operation_id":"pending:delete-resume","profile_id":id}))).await;
    let after = fixture.list().await;
    let final_record = fixture.store.browser_profile(&id).await;
    let launches = std::fs::read_to_string(&marker);
    let removed = !storage.join("profile").exists();
    let entries = std::fs::read_dir(&storage).map(|entries| entries.count());
    let cleaned = fixture.finish().await;
    println!(
        "BROWSER_PROFILE_DELETE_PENDING root={} starting={starting:?} early={early:?} during={during:?} record={record:?} retained={retained} rejected={rejected:?} created={created:?} retried={retried:?} after={after:?} finalRecord={final_record:?} launches={launches:?} removed={removed} entries={entries:?} cleanup={cleaned:?}",
        fixture.root.display()
    );
    assert!(cleaned.is_ok(), "{cleaned:?}");
    assert!(starting.is_ok(), "{starting:?}");
    assert!(early.is_err(), "{early:?}");
    assert_eq!(
        record.unwrap().unwrap().state,
        BrowserProfileStateV1::Retiring
    );
    assert_eq!(
        during.unwrap()["result"]["resources"][0]["phase"],
        "retiring"
    );
    assert!(retained);
    assert_eq!(rejected.unwrap_err().code, "browser_profile_retiring");
    assert!(created.unwrap().unwrap().is_err());
    assert_eq!(retried.unwrap().unwrap()["result"]["deleted"], true);
    assert_eq!(after.unwrap()["result"]["resources"], json!([]));
    assert_eq!(
        final_record.unwrap().unwrap().state,
        BrowserProfileStateV1::Deleted
    );
    assert_eq!(launches.unwrap().lines().count(), 1);
    assert!(removed);
    assert_eq!(entries.unwrap(), 1);
}
