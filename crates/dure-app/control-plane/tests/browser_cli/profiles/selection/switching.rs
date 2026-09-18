use super::*;

impl Client {
    async fn set_profile(
        &self,
        root: &Path,
        profile: &str,
        operation: &str,
    ) -> Result<Value, String> {
        cli(
            root,
            &[
                "tab",
                "profile",
                "set",
                &self.resource,
                profile,
                "--page",
                &self.page,
                "--controller",
                "profile-agent",
                "--epoch",
                &self.epoch,
                "--idempotency-key",
                operation,
            ],
        )
        .await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn profile_switch_cli_reuses_peer_browser_storage_and_preserves_logical_page() {
    let (root, endpoint, server) = super::super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        let catalog = cli(&root, &["tab", "profile", "create", "--label", "전환 대상"]).await?;
        let profile = catalog["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        let origin = Client::create(&root, None, "switch-origin").await?;
        origin.action(&root, "goto", &url).await?;
        origin.evaluate(&root, "localStorage.setItem('switch','기본 저장');document.cookie='switch=default;Path=/;Max-Age=3600';window.originalOnly=1;true").await?;
        let peer = Client::create(&root, Some(profile), "switch-peer").await?;
        peer.action(&root, "goto", &url).await?;
        peer.evaluate(&root, "localStorage.setItem('switch','대상 저장');document.cookie='switch=selected;Path=/;Max-Age=3600';window.peerOnly='유지';true").await?;
        let before = cli(&root, &["show", &origin.resource]).await?;
        let peer_before = cli(&root, &["show", &peer.resource]).await?;
        let switched = origin.set_profile(&root, profile, "switch-once").await?;
        let after = cli(&root, &["show", &origin.resource]).await?;
        let read = "({local:localStorage.getItem('switch'),cookie:document.cookie,original:window.originalOnly??null,peer:window.peerOnly??null})";
        let shared = origin.evaluate(&root, read).await?;
        let peer_value = peer.evaluate(&root, "window.peerOnly").await?;
        let peer_after = cli(&root, &["show", &peer.resource]).await?;
        let exact_request = json!({"kind":"profile_set","caller":"profile-agent","profile_id":profile,"authority":{
            "lease":before["result"]["control"]["controller"],"page":before["result"]["pages"][0]["page"],
            "operation_id":"switch-once","command_sequence":before["result"]["control"]["next_command_sequence"]
        }});
        let replay = backend(&endpoint, "browser.resource", exact_request.clone()).await;
        let mut conflict_request = exact_request;
        conflict_request["profile_id"] = "default".into();
        let conflict = backend(&endpoint, "browser.resource", conflict_request).await;
        origin.evaluate(&root, "window.sameProfileMarker='새로고침 없음';true").await?;
        let noop_before = cli(&root, &["show", &origin.resource]).await?;
        origin.set_profile(&root, profile, "switch-noop").await?;
        let noop_after = cli(&root, &["show", &origin.resource]).await?;
        let noop_value = origin.evaluate(&root, "window.sameProfileMarker").await?;
        let missing = origin.set_profile(&root, "missing", "switch-missing").await;
        let after_missing = cli(&root, &["show", &origin.resource]).await?;
        peer.close(&root).await?;
        let survives_peer = origin.evaluate(&root, read).await?;
        origin.set_profile(&root, "default", "switch-return").await?;
        let returned = cli(&root, &["show", &origin.resource]).await?;
        let restored = origin.evaluate(&root, read).await?;
        origin.close(&root).await?;
        Ok((json!({"before":before,"after":after,"peerBefore":peer_before,"peerAfter":peer_after,
            "switched":switched,"shared":shared,"peerValue":peer_value,"replay":replay,"conflict":conflict,
            "noopBefore":noop_before,"noopAfter":noop_after,"noopValue":noop_value,"afterMissing":after_missing,
            "survivesPeer":survives_peer,"returned":returned,"restored":restored,"profile":profile}),missing))
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
        "BROWSER_PROFILE_SWITCH_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let (evidence, missing) = evidence.unwrap();
    let page = |key: &str| evidence[key]["result"]["pages"][0]["page"].clone();
    assert_eq!(
        evidence["after"]["result"]["pages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(page("before")["page_id"], page("after")["page_id"]);
    assert_ne!(
        page("before")["document_revision"],
        page("after")["document_revision"]
    );
    assert_eq!(
        evidence["after"]["result"]["pages"][0]["profile_id"],
        evidence["profile"]
    );
    assert_eq!(
        evidence["shared"],
        json!({"local":"대상 저장","cookie":"switch=selected","original":null,"peer":null})
    );
    assert_eq!(evidence["peerValue"], "유지");
    assert_eq!(page("peerBefore"), page("peerAfter"));
    assert_eq!(evidence["replay"]["result"]["replayed"], true);
    assert_eq!(
        evidence["replay"]["result"]["result"],
        evidence["switched"]["result"]
    );
    assert_eq!(
        evidence["conflict"]["error"]["code"],
        "browser_operation_conflict"
    );
    assert_eq!(page("noopBefore"), page("noopAfter"));
    assert_eq!(evidence["noopValue"], "새로고침 없음");
    assert!(
        matches!(missing,Err(ref e) if e.contains("browser_profile_missing")),
        "{missing:?}"
    );
    assert_eq!(page("noopAfter"), page("afterMissing"));
    assert_eq!(evidence["survivesPeer"], evidence["shared"]);
    assert_eq!(page("returned")["page_id"], page("before")["page_id"]);
    assert_eq!(
        evidence["returned"]["result"]["pages"][0]["profile_id"],
        "default"
    );
    assert_eq!(
        evidence["restored"],
        json!({"local":"기본 저장","cookie":"switch=default","original":null,"peer":null})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn orca_profile_flag_show_and_use_default_share_the_existing_page_transition() {
    let (root, endpoint, server) = super::super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["tab", "profile", "create", "--label", "Orca 표기"]).await?;
        let profile = created["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        let client = Client::create(&root, None, "orca-switch").await?;
        client.action(&root, "goto", &url).await?;
        let shown = cli(&root, &["tab", "profile", "show", &client.resource, "--page", &client.page]).await?;
        let switched = cli(&root, &["tab", "profile", "set", &client.resource, "--profile", profile,
            "--page", &client.page, "--controller", "profile-agent", "--epoch", &client.epoch]).await?;
        let selected = cli(&root, &["tab", "profile", "show", &client.resource, "--page", &client.page]).await?;
        let returned = cli(&root, &["tab", "profile", "use-default", &client.resource,
            "--page", &client.page, "--controller", "profile-agent", "--epoch", &client.epoch]).await?;
        let default = cli(&root, &["tab", "profile", "show", &client.resource, "--page", &client.page]).await?;
        client.close(&root).await?;
        Ok(json!({"shown":shown,"switched":switched,"selected":selected,"returned":returned,"default":default,"profile":profile}))
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
        "BROWSER_ORCA_PROFILE_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let evidence = evidence.unwrap();
    assert_eq!(evidence["shown"]["result"]["profile_id"], "default");
    assert_eq!(
        evidence["selected"]["result"]["profile_id"],
        evidence["profile"]
    );
    assert_eq!(evidence["default"]["result"]["profile_id"], "default");
    for field in ["selected", "default"] {
        assert_eq!(
            evidence[field]["result"]["page"]["page_id"],
            evidence["shown"]["result"]["page"]["page_id"]
        );
        assert_eq!(evidence[field]["result"]["url"], format!("{url}/"));
    }
    assert_eq!(evidence["switched"]["result"]["response"]["success"], true);
    assert_eq!(evidence["returned"]["result"]["response"]["success"], true);
}
