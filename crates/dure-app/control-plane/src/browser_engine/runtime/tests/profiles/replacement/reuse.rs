use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn returning_to_a_live_profile_reuses_its_owner_without_reloading_peer_tabs() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-reuse-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:reuse");
    let profiles = [
        BrowserProfileIdV1::new("profile:a").unwrap(),
        BrowserProfileIdV1::new("profile:b").unwrap(),
    ];
    let runtime = BrowserRuntime::launch_profile(
        resource.clone(),
        &config,
        &root,
        &profile_spec(&profiles[0]),
    )
    .await
    .unwrap();
    let (url, stop_http, server) = super::super::super::service_worker::fixture().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("profile-agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        let page = first_page(&runtime).await?;
        apply(&runtime, &lease, &page, json!({"kind":"navigate","url":url})).await?;
        let original = runtime.host.lock().await.page_identity(&page.page_id)?;
        apply(&runtime, &lease, &original, json!({"kind":"new_page","url":url})).await?;
        let peer = runtime.observe().await?.pages.into_iter().find(|p| p.page.page_id != page.page_id).ok_or("peer missing")?.page;
        apply(&runtime, &lease, &peer, json!({"kind":"evaluate","script":"window.peerWrites=0;document.body.innerHTML='<button onclick=peerWrites++>Increment</button>';localStorage.setItem('profile','공유 프로필 A');true"})).await?;
        let peer_reference = click_reference(&runtime.snapshot(&peer, &Default::default()).await?)?;
        let original_instance = runtime.host.lock().await.instance_for_page(&peer.page_id)?.clone();
        let original_owner = Arc::clone(&runtime.execution(&peer).await?.binding.instance);
        runtime.set_profile(&lease.controller_id, &authority(&runtime, &lease, &original).await, &config, &profile_spec(&profiles[1])).await?;
        let in_b = runtime.host.lock().await.page_identity(&original.page_id)?;
        let b_instance = runtime.host.lock().await.instance_for_page(&in_b.page_id)?.clone();
        let b_owner = Arc::clone(&runtime.execution(&in_b).await?.binding.instance);
        let in_b_value = apply(&runtime, &lease, &in_b, json!({"kind":"evaluate","script":"localStorage.getItem('profile')"})).await?;
        let returned = runtime.set_profile(&lease.controller_id, &authority(&runtime, &lease, &in_b).await, &config, &profile_spec(&profiles[0])).await?;
        let observation = runtime.observe().await?;
        let in_a = runtime.host.lock().await.page_identity(&original.page_id)?;
        let destination = runtime.host.lock().await.instance_for_page(&in_a.page_id)?.clone();
        // Prove the peer's reference before selecting the returned tab. An
        // explicit later tab selection intentionally expires resource refs.
        apply(&runtime, &lease, &peer, json!({"kind":"click","target":{"kind":"reference","reference":peer_reference}})).await?;
        let peer_value = apply(&runtime, &lease, &peer, json!({"kind":"evaluate","script":"peerWrites"})).await?;
        let returned_value = apply(&runtime, &lease, &in_a, json!({"kind":"evaluate","script":"localStorage.getItem('profile')"})).await?;
        let peer_after = runtime.host.lock().await.page_identity(&peer.page_id)?;
        let instances = runtime.host.lock().await.instance_binding_ids();
        let native = (original_owner.browser_has_exited().await?, b_owner.browser_has_exited().await?);
        Ok(((original, peer, original_instance, in_b, b_instance, in_b_value), (returned, observation, in_a, destination, returned_value, peer_value, peer_after, instances, native)))
    }.await;
    let closed = runtime.close(&resource).await;
    let _ = stop_http.send(());
    let server = server.await;
    println!(
        "BROWSER_PROFILE_REUSE root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        (original, peer, original_instance, in_b, b_instance, in_b_value),
        (
            returned,
            observation,
            in_a,
            destination,
            returned_value,
            peer_value,
            peer_after,
            instances,
            native,
        ),
    ) = evidence.unwrap();
    assert_eq!(in_b.page_id, original.page_id);
    assert_ne!(original_instance, b_instance);
    assert_eq!(in_b_value["result"], Value::Null);
    assert!(returned.response.success);
    assert_eq!(observation.pages.len(), 2);
    assert!(
        observation
            .pages
            .iter()
            .all(|p| p.profile_id.as_ref() == Some(&profiles[0]))
    );
    assert_eq!(in_a.page_id, original.page_id);
    assert!(in_a.document_revision > in_b.document_revision);
    assert_eq!(destination, original_instance);
    assert_eq!(returned_value["result"], "공유 프로필 A");
    assert_eq!(peer_value["result"], 1);
    assert_eq!(peer_after, peer);
    assert_eq!(instances, vec![original_instance]);
    assert_eq!(native, (false, true));
}
