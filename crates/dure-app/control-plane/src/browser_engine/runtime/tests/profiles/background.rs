use super::*;

async fn native_selection(runtime: &BrowserRuntime) -> Result<Value, BrowserRuntimeError> {
    let binding = runtime.test_binding();
    let state = binding
        .engine
        .lock()
        .await
        .require(json!({"action":"tab_list"}))
        .await?;
    Ok(state["tabs"].clone())
}

async fn focus_events(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
) -> Result<Value, BrowserRuntimeError> {
    let target = runtime.host.lock().await.target_for(page)?.clone();
    let mut cdp = runtime.test_binding().cdp.clone();
    let session = cdp.attach(target.as_str()).await?;
    // This fixed read of our own fixture never activates the target or runs a
    // controller command. It measures the focus effects of passive observers.
    let result = cdp
        .request(
            "Runtime.evaluate",
            json!({"expression":"({focused:document.hasFocus(),events:window.focusEvents})","returnByValue":true}),
            Some(&session),
        )
        .await?;
    let value = &result["result"]["value"];
    if !value["focused"].is_boolean() || !value["events"].is_array() {
        return Err("fixture_focus_observation_invalid".into());
    }
    Ok(value.clone())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn background_resource_reads_keep_the_shared_peer_selected_and_survive_its_close() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-background-observer-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("background:source");
    let runtime = BrowserRuntime::launch(resource.clone(), &config, &root)
        .await
        .unwrap();
    let mut peer = None;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("source-agent").unwrap(), None)
            .await?.controller.ok_or("fixture_controller_missing")?;
        let page = first_page(&runtime).await?;
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.body.innerHTML='<input id=proof aria-label=Proof value=한글원본>';window.focusEvents=[];addEventListener('focus',()=>focusEvents.push('focus'));addEventListener('blur',()=>focusEvents.push('blur'));true"})).await?;
        peer = Some(runtime.share_instance(identity("background:peer")).await?);
        let peer = peer.as_ref().unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer-agent").unwrap(), None)
            .await?.controller.ok_or("fixture_controller_missing")?;
        let peer_page = first_page(peer).await?;
        apply(peer, &peer_lease, &peer_page, json!({"kind":"evaluate","script":"document.body.innerHTML='<input id=proof aria-label=Proof value=동료>';window.focusEvents=[];addEventListener('focus',()=>focusEvents.push('focus'));addEventListener('blur',()=>focusEvents.push('blur'));true"})).await?;
        let before = (runtime.control().await, peer.control().await, native_selection(&runtime).await?, focus_events(&runtime, &page).await?, focus_events(peer, &peer_page).await?);
        let peer_target = peer.host.lock().await.target_for(&peer_page)?.clone();
        if !before.2.as_array().is_some_and(|tabs| {
            tabs.iter().filter(|tab| tab["active"] == true).count() == 1
                && tabs.iter().any(|tab| tab["active"] == true && tab["targetId"].as_str() == Some(peer_target.as_str()))
        }) {
            return Err("fixture_peer_not_selected".into());
        }
        let query = serde_json::from_value(json!({"kind":"value","target":{"kind":"css","selector":"#proof"}})).unwrap();
        let value = runtime.query(&page, &query).await;
        let snapshot = runtime.snapshot(&page, &Default::default()).await;
        let selector = serde_json::from_value(json!({"condition":{"kind":"selector","target":{"kind":"css","selector":"#proof"},"state":"visible"},"timeout_ms":0})).unwrap();
        let duration = serde_json::from_value(json!({"condition":{"kind":"duration"},"timeout_ms":0})).unwrap();
        let waits = (runtime.wait(&page, &selector).await, runtime.wait(&page, &duration).await);
        let reference = snapshot.as_ref().ok().and_then(|snapshot| snapshot.data["refs"].as_object()
            .and_then(|refs| refs.iter().find(|(_, value)| value["role"] == "textbox"))
            .map(|(element, _)| BrowserElementReference { snapshot: snapshot.snapshot.clone(), element: BrowserElementId::new(element).unwrap() }));
        let referenced = if let Some(reference) = &reference {
            let query = serde_json::from_value(json!({"kind":"value","target":{"kind":"reference","reference":reference}})).unwrap();
            Some(runtime.query(&page, &query).await)
        } else { None };
        let replacement = runtime.snapshot(&page, &Default::default()).await;
        let stale_reference = if let Some(reference) = reference {
            let query = serde_json::from_value(json!({"kind":"value","target":{"kind":"reference","reference":reference}})).unwrap();
            Some(runtime.query(&page, &query).await)
        } else { None };
        let wrong_resource = peer.query(&page, &query).await;
        let mut wrong_document = serde_json::to_value(&page).unwrap();
        wrong_document["document_revision"] = json!("999");
        let wrong_document = runtime.query(&serde_json::from_value(wrong_document).unwrap(), &query).await;
        let after = (runtime.control().await, peer.control().await, native_selection(&runtime).await?, focus_events(&runtime, &page).await?, focus_events(peer, &peer_page).await?);
        peer.close(&peer.control().await.resource).await?;
        let closed_selection = native_selection(&runtime).await?;
        let after_close = (runtime.query(&page, &query).await, runtime.snapshot(&page, &Default::default()).await, runtime.wait(&page, &selector).await, runtime.wait(&page, &duration).await);
        let after_closed_reads = native_selection(&runtime).await?;
        let reads = (value, snapshot, waits, referenced, stale_reference, wrong_resource, wrong_document, replacement);
        Ok((page, before, reads, after, closed_selection, after_close, after_closed_reads))
    }.await;
    let peer_closed = if let Some(peer) = peer {
        Some(peer.close(&peer.control().await.resource).await)
    } else {
        None
    };
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_BACKGROUND_OBSERVER root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?}",
        root.display()
    );
    assert!(peer_closed.is_some_and(|result| result.is_ok()));
    assert!(closed.is_ok(), "{closed:?}");
    let (
        page,
        before,
        (value, snapshot, waits, referenced, stale, wrong_resource, wrong_document, replacement),
        after,
        closed_selection,
        after_close,
        after_closed_reads,
    ) = evidence.unwrap();
    assert_eq!(value.unwrap()["data"]["value"], "한글원본");
    assert_eq!(snapshot.unwrap().snapshot.page, page);
    assert_eq!(replacement.unwrap().snapshot.page, page);
    assert!(waits.0.is_ok() && waits.1.is_ok(), "{waits:?}");
    assert_eq!(referenced.unwrap().unwrap()["data"]["value"], "한글원본");
    assert!(matches!(
        stale,
        Some(Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::SnapshotChanged
        )))
    ));
    assert!(wrong_resource.is_err() && wrong_document.is_err());
    assert_eq!(before.0.controller, after.0.controller);
    assert_eq!(before.0.current_page, after.0.current_page);
    assert_eq!(
        before.0.next_command_sequence,
        after.0.next_command_sequence
    );
    assert_eq!(before.1, after.1);
    assert_eq!(
        before.2, after.2,
        "passive reads cannot select a native tab"
    );
    assert_eq!(
        (before.3, before.4),
        (after.3, after.4),
        "passive reads cannot focus or blur either page"
    );
    assert_eq!(after_close.0.unwrap()["data"]["value"], "한글원본");
    assert_eq!(after_close.1.unwrap().snapshot.page, page);
    assert!(after_close.2.is_ok() && after_close.3.is_ok());
    assert_eq!(closed_selection, after_closed_reads);
}
