//! Exercise the service's public dispatch responses, including early returns.
use super::*;

#[tokio::test]
async fn profile_deletion_preserves_an_unrelated_closed_resource_and_its_close_authority() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite3"))
        .await
        .unwrap();
    let backend = crate::backend_runtime_root::ensure(root.path()).unwrap();
    let service = BrowserService::new(backend, "generation:profile-delete", root.path());
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("browser:retained-cleanup").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:dure-browser").unwrap(),
        generation: service.generation.clone(),
    };
    let runtime = Arc::new(BrowserRuntime::new(identity.clone(), root.path()));
    {
        let mut resources = service.resources.lock().await;
        service.target_created(&resources, &identity).unwrap();
        resources.insert(
            identity.resource_id.clone(),
            ManagedBrowser {
                runtime: Arc::clone(&runtime),
                _slot: Arc::clone(&service.slots).try_acquire_owned().unwrap(),
            },
        );
    }
    // Native closure alone does not remove a service owner: a resource can
    // remain listed while its independently retained scratch cleanup is pending.
    runtime.close(&identity).await.unwrap();
    let list = json!({"kind":"list"});
    let before = service.dispatch(&store, &list).await.unwrap();
    let created = service
        .dispatch(
            &store,
            &json!({"kind":"profile_create","operation_id":"unrelated:create","label":"Unrelated profile"}),
        )
        .await
        .unwrap();
    let deleted = service
        .dispatch(
            &store,
            &json!({"kind":"profile_delete","operation_id":"unrelated:delete","profile_id":created["result"]["profile"]["profile"]["profileId"]}),
        )
        .await;
    let after = service.dispatch(&store, &list).await.unwrap();
    let retained_slots = service.slots.available_permits();
    let closed = service
        .dispatch(
            &store,
            &json!({"kind":"close","operation_id":"retained:close","resource":identity}),
        )
        .await;
    let final_slots = service.slots.available_permits();
    service.shutdown().await.unwrap();
    store.close().await;

    assert_eq!(deleted.unwrap()["result"]["deleted"], true);
    assert_eq!(before["result"]["resources"][0]["phase"], "closed");
    assert_eq!(after["result"], before["result"]);
    assert_eq!(retained_slots, 7);
    assert_eq!(closed.unwrap()["result"]["closed"], true);
    assert_eq!(final_slots, 8);
}

#[tokio::test]
async fn desktop_envelopes_preserve_created_replayed_and_recovered_payloads() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite3"))
        .await
        .unwrap();
    let backend = crate::backend_runtime_root::ensure(root.path()).unwrap();
    let service = BrowserService::new(backend, "generation:desktop", root.path());
    let create =
        json!({"kind":"profile_create","operation_id":"desktop:profile","label":"Desktop fixture"});
    let created = service.dispatch(&store, &create).await.unwrap();
    let replayed = service.dispatch(&store, &create).await.unwrap();
    let recovered = service
        .dispatch(
            &store,
            &json!({"kind":"receipt","operation_id":"desktop:profile"}),
        )
        .await
        .unwrap();
    let missing = service
        .dispatch(
            &store,
            &json!({"kind":"receipt","operation_id":"desktop:missing"}),
        )
        .await
        .unwrap();
    let listed = service
        .dispatch(&store, &json!({"kind":"list"}))
        .await
        .unwrap();
    let profiles = service
        .dispatch(&store, &json!({"kind":"profile_list"}))
        .await
        .unwrap();
    let conflict = service
        .dispatch(
            &store,
            &json!({"kind":"profile_create","operation_id":"desktop:profile","label":"Changed"}),
        )
        .await
        .unwrap_err();
    service.shutdown().await.unwrap();
    store.close().await;

    assert_eq!(created["result"], replayed["result"]);
    assert_eq!(created["result"], recovered["result"]);
    assert_eq!(replayed["replayed"], true);
    assert_eq!(recovered["result_available"], true);
    assert_eq!(missing["result_available"], false);
    assert_eq!(listed["result"]["resources"], json!([]));
    assert_eq!(conflict.code, "browser_operation_conflict");
    let responses = json!({"created":created,"replayed":replayed,"recovered":recovered,"missing":missing,"listed":listed,"profiles":profiles});
    // The focused cross-language check consumes actual service bytes without
    // making ordinary Rust tests depend on a JavaScript toolchain.
    if let Some(path) = std::env::var_os("DURE_BROWSER_DESKTOP_WIRE_RECEIPT") {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&responses).unwrap())
            .unwrap();
    }
    for (name, response) in responses.as_object().unwrap() {
        assert_eq!(response["schemaVersion"], 1, "{name}: {response}");
    }
}
