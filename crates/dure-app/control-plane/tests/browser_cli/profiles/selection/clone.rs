use super::*;

async fn clone_page(
    client: &Client,
    root: &Path,
    profile: &str,
    operation: &str,
) -> Result<(Client, Value), String> {
    let result = cli(
        root,
        &[
            "tab",
            "profile",
            "clone",
            &client.resource,
            "--profile",
            profile,
            "--page",
            &client.page,
            "--controller",
            "profile-agent",
            "--epoch",
            &client.epoch,
            "--idempotency-key",
            operation,
        ],
    )
    .await?;
    let page = result["result"]["response"]["data"]["page"]["page_id"]
        .as_str()
        .ok_or("cloned page missing")?
        .to_owned();
    Ok((
        Client {
            resource: client.resource.clone(),
            page,
            epoch: client.epoch.clone(),
            created: Value::Null,
        },
        result,
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn clone_cli_opens_the_source_url_in_selected_storage_without_replacing_source_or_peers() {
    let (root, endpoint, server) = super::super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        let catalog = cli(&root, &["tab", "profile", "create", "--label", "공유 복제 대상"]).await?;
        let profile = catalog["result"]["profile"]["profile"]["profileId"].as_str().ok_or("shared profile missing")?;
        let clean_catalog = cli(&root, &["tab", "profile", "create", "--label", "빈 복제 대상"]).await?;
        let clean_profile = clean_catalog["result"]["profile"]["profile"]["profileId"].as_str().ok_or("clean profile missing")?;
        let origin = Client::create(&root, None, "clone-origin").await?;
        origin.action(&root, "goto", &url).await?;
        origin.evaluate(&root, "localStorage.setItem('clone','원본 저장');document.cookie='clone=default;Path=/;Max-Age=3600';window.originalOnly='원본 문서';true").await?;
        let peer = Client::create(&root, Some(profile), "clone-peer").await?;
        peer.action(&root, "goto", &url).await?;
        peer.evaluate(&root, "localStorage.setItem('clone','대상 저장');document.cookie='clone=selected;Path=/;Max-Age=3600';window.peerOnly='다른 문서';true").await?;
        let before = cli(&root, &["show", &origin.resource]).await?;
        // The worker's tab-list title is event-cached. Read the live document
        // for title preservation and compare Host identity/storage separately.
        let peer_title_before = peer.evaluate(&root, "document.title").await?;
        let peer_before = cli(&root, &["show", &peer.resource]).await?;
        let (shared, cloned) = clone_page(&origin, &root, profile, "clone-shared").await?;
        let read = "({local:localStorage.getItem('clone'),cookie:document.cookie,original:window.originalOnly??null,peer:window.peerOnly??null})";
        let shared_value = shared.evaluate(&root, read).await?;
        let original_value = origin.evaluate(&root, read).await?;
        let peer_value = peer.evaluate(&root, "window.peerOnly").await?;
        let after_shared = cli(&root, &["show", &origin.resource]).await?;
        let peer_after = cli(&root, &["show", &peer.resource]).await?;
        let peer_title_after = peer.evaluate(&root, "document.title").await?;
        let replay_request = json!({"kind":"profile_clone","caller":"profile-agent","profile_id":profile,"authority":{
            "lease":before["result"]["control"]["controller"],"page":before["result"]["pages"][0]["page"],
            "operation_id":"clone-shared","command_sequence":before["result"]["control"]["next_command_sequence"]
        }});
        let replay = backend(&endpoint, "browser.resource", replay_request).await;
        let (clean, clean_result) = clone_page(&origin, &root, clean_profile, "clone-clean").await?;
        let clean_value = clean.evaluate(&root, read).await?;
        let (same, same_result) = clone_page(&origin, &root, "default", "clone-same").await?;
        let same_value = same.evaluate(&root, read).await?;
        let final_view = cli(&root, &["show", &origin.resource]).await?;
        peer.close(&root).await?;
        let surviving = shared.evaluate(&root, read).await?;
        origin.close(&root).await?;
        Ok(json!({"before":before,"afterShared":after_shared,"peerBefore":peer_before,"peerAfter":peer_after,
            "peerTitleBefore":peer_title_before,"peerTitleAfter":peer_title_after,
            "cloned":cloned,"cleanResult":clean_result,"sameResult":same_result,"shared":shared_value,"original":original_value,
            "peer":peer_value,"replay":replay,"clean":clean_value,"same":same_value,"final":final_view,"surviving":surviving,
            "ids":[origin.page,shared.page,clean.page,same.page],"profiles":["default",profile,clean_profile,"default"]}))
    }.await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    let _ = stop_site.send(());
    let site_stopped = site.await;
    println!(
        "BROWSER_PROFILE_CLONE_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let evidence = evidence.unwrap();
    assert_eq!(
        evidence["shared"],
        json!({"local":"대상 저장","cookie":"clone=selected","original":null,"peer":null})
    );
    assert_eq!(
        evidence["original"],
        json!({"local":"원본 저장","cookie":"clone=default","original":"원본 문서","peer":null})
    );
    assert_eq!(evidence["peer"], "다른 문서");
    assert_eq!(
        evidence["clean"],
        json!({"local":null,"cookie":"","original":null,"peer":null})
    );
    assert_eq!(
        evidence["same"],
        json!({"local":"원본 저장","cookie":"clone=default","original":null,"peer":null})
    );
    assert_eq!(evidence["surviving"], evidence["shared"]);
    assert_eq!(
        evidence["afterShared"]["result"]["pages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let peer_before = evidence["peerBefore"]["result"]["pages"]
        .as_array()
        .unwrap();
    let peer_after = evidence["peerAfter"]["result"]["pages"].as_array().unwrap();
    assert_eq!(peer_before.len(), 1);
    assert_eq!(peer_after.len(), 1);
    for field in ["page", "profile_id", "url"] {
        assert_eq!(peer_before[0][field], peer_after[0][field]);
    }
    assert_eq!(evidence["peerTitleBefore"], "Profile selection");
    assert_eq!(evidence["peerTitleAfter"], evidence["peerTitleBefore"]);
    let original = &evidence["before"]["result"]["pages"][0];
    let pages = evidence["final"]["result"]["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 4);
    let mut ids = std::collections::BTreeSet::new();
    for (index, id) in evidence["ids"].as_array().unwrap().iter().enumerate() {
        assert!(ids.insert(id.as_str().unwrap()));
        let page = pages
            .iter()
            .find(|page| &page["page"]["page_id"] == id)
            .unwrap();
        assert_eq!(page["profile_id"], evidence["profiles"][index]);
        assert_eq!(page["url"], format!("{url}/"));
        if index == 0 {
            assert_eq!(page["page"], original["page"]);
        }
    }
    assert_eq!(
        evidence["cloned"]["result"]["response"]["data"]["source_page"],
        original["page"]
    );
    assert_eq!(evidence["replay"]["result"]["replayed"], true);
    assert_eq!(
        evidence["replay"]["result"]["result"],
        evidence["cloned"]["result"]
    );
}
