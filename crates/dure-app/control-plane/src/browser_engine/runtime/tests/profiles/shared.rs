use super::*;
use dure_app::BrowserProfileIdV1;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn another_resource_shares_only_the_selected_live_profile_and_preserves_source_tabs() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-shared-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:selected-source");
    let profiles = [
        BrowserProfileIdV1::new("shared:a").unwrap(),
        BrowserProfileIdV1::new("shared:b").unwrap(),
    ];
    let runtime = BrowserRuntime::launch_profile(
        resource.clone(),
        &config,
        &root,
        &profile_spec(&profiles[0]),
    )
    .await
    .unwrap();
    let (url, stop_http, server) = super::super::service_worker::fixture().await;
    let mut peers = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let instance_b = runtime.launch_binding(&config, Some(&profile_spec(&profiles[1]))).await?;
        let observed = runtime.observe().await?;
        let mut pages = profiles.iter().map(|profile| observed.pages.iter().find(|page| page.profile_id.as_ref()==Some(profile)).map(|page| page.page.clone()).ok_or("profile page missing")).collect::<Result<Vec<_>, _>>()?;
        let lease = runtime.request_control(BrowserControllerId::new("profile-agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        for (index, page) in pages.iter_mut().enumerate() {
            apply(&runtime, &lease, page, json!({"kind":"navigate","url":url})).await?;
            *page = runtime.host.lock().await.page_identity(&page.page_id)?;
            let script = format!("localStorage.setItem('shared','프로필 {index}');window.sourceProof='원본 {index}';true");
            apply(&runtime, &lease, page, json!({"kind":"evaluate","script":script})).await?;
        }
        let ambiguous = match runtime.share_instance(identity("profile:ambiguous")).await {
            Ok(peer) => { peers.push(peer); None },
            Err(error) => Some(error),
        };
        peers.push(runtime.share_selected_instance(identity("profile:selected-peer"), &instance_b).await?);
        let peer = &peers[0];
        let peer_lease = peer.request_control(BrowserControllerId::new("peer-agent").unwrap(), None).await?.controller.ok_or("peer controller missing")?;
        let peer_page = first_page(peer).await?;
        apply(peer, &peer_lease, &peer_page, json!({"kind":"navigate","url":url})).await?;
        let peer_page = peer.host.lock().await.page_identity(&peer_page.page_id)?;
        let shared = apply(peer, &peer_lease, &peer_page, json!({"kind":"evaluate","script":"({stored:localStorage.getItem('shared'),source:window.sourceProof??null})"})).await?;
        let peer_observed = peer.observe().await?;
        let peer_instance = peer.host.lock().await.instance_for_page(&peer_page.page_id)?.clone();
        let same_worker = Arc::ptr_eq(&runtime.execution(&pages[1]).await?.binding.engine, &peer.execution(&peer_page).await?.binding.engine);
        peer.close(&peer.control().await.resource).await?;
        let mut source_values = Vec::new();
        let mut source_pages = Vec::new();
        let mut source_exited = Vec::new();
        for page in &pages {
            source_values.push(apply(&runtime, &lease, page, json!({"kind":"evaluate","script":"({stored:localStorage.getItem('shared'),source:window.sourceProof})"})).await?["result"].clone());
            source_pages.push(runtime.host.lock().await.page_identity(&page.page_id)?);
            source_exited.push(runtime.execution(page).await?.binding.instance.browser_has_exited().await?);
        }
        Ok((ambiguous, shared, peer_observed, peer_instance, instance_b, same_worker, pages, source_pages, source_values, source_exited))
    }.await;
    let mut peer_cleanup = Vec::new();
    for peer in &peers {
        peer_cleanup.push(peer.close(&peer.control().await.resource).await);
    }
    let closed = runtime.close(&resource).await;
    let _ = stop_http.send(());
    let server = server.await;
    println!(
        "BROWSER_SELECTED_SHARED_PROFILE root={} evidence={evidence:?} peers={peer_cleanup:?} closed={closed:?} server={server:?}",
        root.display()
    );
    assert!(peer_cleanup.iter().all(Result::is_ok), "{peer_cleanup:?}");
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        ambiguous,
        shared,
        peer_observed,
        peer_instance,
        instance_b,
        same_worker,
        pages,
        source_pages,
        source_values,
        source_exited,
    ) = evidence.unwrap();
    assert!(
        matches!(
            ambiguous,
            Some(BrowserRuntimeError::Observation(
                "browser_profile_selection_required"
            ))
        ),
        "{ambiguous:?}"
    );
    assert_eq!(shared["result"], json!({"stored":"프로필 1","source":null}));
    assert_eq!(peer_observed.pages.len(), 1);
    assert_eq!(peer_observed.pages[0].profile_id, Some(profiles[1].clone()));
    assert_eq!(peer_instance, instance_b);
    assert!(same_worker);
    assert_eq!(source_pages, pages);
    assert_eq!(
        source_values,
        vec![
            json!({"stored":"프로필 0","source":"원본 0"}),
            json!({"stored":"프로필 1","source":"원본 1"})
        ]
    );
    assert_eq!(source_exited, vec![false, false]);
}
