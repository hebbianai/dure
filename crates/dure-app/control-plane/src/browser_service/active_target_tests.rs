//! Exercise selection through the same journaled JSON boundary as both clients.
use super::*;

#[tokio::test]
async fn workspace_selection_is_explicit_fenced_recoverable_and_cleared_on_close() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite3"))
        .await
        .unwrap();
    let backend = crate::backend_runtime_root::ensure(root.path()).unwrap();
    let service = BrowserService::new(backend, "generation:selection", root.path());
    let mut identities = Vec::new();
    for id in ["browser:first", "browser:second"] {
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new(id).unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace:selection").unwrap(),
            generation: service.generation.clone(),
        };
        let runtime = Arc::new(BrowserRuntime::new(identity.clone(), root.path()));
        service.resources.lock().await.insert(
            identity.resource_id.clone(),
            ManagedBrowser {
                runtime,
                _slot: Arc::clone(&service.slots).try_acquire_owned().unwrap(),
            },
        );
        identities.push(identity);
    }
    let list = json!({"kind":"list","workspace_id":"workspace:selection"});
    let initial = service.dispatch(&store, &list).await.unwrap();
    let first_request = json!({"kind":"select_resource","resource":identities[0],
        "expected":initial["result"]["target"],"operation_id":"selection:first"});
    let first = service.dispatch(&store, &first_request).await;
    let observed = service
        .dispatch(
            &store,
            &json!({"kind":"observe",
        "resource_id":identities[1].resource_id}),
        )
        .await;
    let after_observe = service.dispatch(&store, &list).await.unwrap();
    let stale = service
        .dispatch(
            &store,
            &json!({"kind":"select_resource",
        "resource":identities[1],"expected":initial["result"]["target"],
        "operation_id":"selection:stale"}),
        )
        .await;
    let second = service
        .dispatch(
            &store,
            &json!({"kind":"select_resource",
        "resource":identities[1],"expected":after_observe["result"]["target"],
        "operation_id":"selection:second"}),
        )
        .await;
    let replay = service.dispatch(&store, &first_request).await;
    let after_replay = service.dispatch(&store, &list).await.unwrap();
    let closed = service
        .dispatch(
            &store,
            &json!({"kind":"close",
        "resource":identities[1],"operation_id":"selection:close"}),
        )
        .await;
    let after_close = service.dispatch(&store, &list).await.unwrap();
    service.shutdown().await.unwrap();
    store.close().await;

    assert_eq!(
        initial["result"]["target"],
        json!({
        "workspace_id":"workspace:selection","generation":"generation:selection",
        "revision":"1","current_resource":null})
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert!(observed.is_ok());
    assert_eq!(first["result"]["target"], after_observe["result"]["target"]);
    assert_eq!(
        first["result"]["target"]["current_resource"],
        json!(identities[0])
    );
    assert_eq!(
        stale.unwrap_err().code,
        "browser_workspace_selection_changed"
    );
    let replay = replay.unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["result"], first["result"]);
    assert_eq!(second["result"]["target"], after_replay["result"]["target"]);
    assert_eq!(
        second["result"]["target"]["current_resource"],
        json!(identities[1])
    );
    assert_eq!(closed.unwrap()["result"]["closed"], true);
    assert_eq!(
        after_close["result"]["target"]["current_resource"],
        Value::Null
    );
    assert_eq!(after_close["result"]["target"]["revision"], "4");
    assert_eq!(
        after_close["result"]["resources"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        after_close["result"]["resources"][0]["resource"],
        json!(identities[0])
    );
}
