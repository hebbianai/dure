use super::*;

async fn switch(client: &Client, root: &Path, profile: &str) -> Result<Value, String> {
    cli(
        root,
        &[
            "tab",
            "profile",
            "set",
            &client.resource,
            "--profile",
            profile,
            "--page",
            &client.page,
            "--controller",
            "profile-agent",
            "--epoch",
            &client.epoch,
        ],
    )
    .await
}

async fn clone_page(client: &Client, root: &Path, profile: &str) -> Result<Client, String> {
    let receipt = cli(
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
        ],
    )
    .await?;
    let page = receipt["result"]["response"]["data"]["page"]["page_id"]
        .as_str()
        .ok_or("clone page missing")?
        .to_owned();
    Ok(Client {
        resource: client.resource.clone(),
        page,
        epoch: client.epoch.clone(),
        created: receipt,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn destination_policy_survives_switch_clone_and_actual_backend_replacement() {
    let (root, endpoint, server) = super::super::super::super::fixture().await;
    let (url, stop_site, site) = identity_site().await;
    let first: Result<_, String> = async {
        peer_workspace(&root).await?;
        let mut profiles = Vec::new();
        for label in ["공유 대상", "새 실행 대상"] {
            let record = cli(
                &root,
                &[
                    "tab",
                    "profile",
                    "create",
                    "--label",
                    label,
                    "--no-ua-spoof",
                ],
            )
            .await?;
            profiles.push(
                record["result"]["profile"]["profile"]["profileId"]
                    .as_str()
                    .ok_or("profile missing")?
                    .to_owned(),
            );
        }
        let origin =
            Client::create(&root, "workspace-browser", None, "ua-lifecycle-origin").await?;
        origin.action(&root, "goto", &url).await?;
        let baseline = observe(&origin, &root).await?;
        origin.action(&root, "device", "iPhone 15").await?;
        let source = observe(&origin, &root).await?;
        let peer = Client::create(
            &root,
            "workspace-profile-peer",
            Some(&profiles[0]),
            "ua-lifecycle-peer",
        )
        .await?;
        peer.action(&root, "goto", &url).await?;
        peer.evaluate(&root, "window.profileMarker='공유 문서 유지';true")
            .await?;
        peer.action(&root, "device", "Pixel 9").await?;
        let peer_before = observe(&peer, &root).await?;
        let shared_switch = switch(&origin, &root, &profiles[0]).await?;
        origin.action(&root, "device", "iPhone 15").await?;
        let shared = observe(&origin, &root).await?;
        let owned_switch = switch(&origin, &root, &profiles[1]).await?;
        origin.action(&root, "device", "iPhone 15").await?;
        let owned = observe(&origin, &root).await?;
        switch(&origin, &root, "default").await?;
        origin.action(&root, "device", "Pixel 9").await?;
        let returned = observe(&origin, &root).await?;
        let clone_shared = clone_page(&origin, &root, &profiles[0]).await?;
        let clone_owned = clone_page(&origin, &root, &profiles[1]).await?;
        let clone_local = clone_page(&clone_owned, &root, &profiles[1]).await?;
        let mut clones = Vec::new();
        for client in [&clone_shared, &clone_owned, &clone_local] {
            client.action(&root, "device", "iPhone 15").await?;
            clones.push(observe(client, &root).await?);
        }
        let peer_after = observe(&peer, &root).await?;
        peer.close(&root).await?;
        let retained = observe(&clone_shared, &root).await?;
        let before_stop = cli(&root, &["tab", "profile", "list"]).await?;
        origin.close(&root).await?;
        Ok(
            json!({"profiles":profiles,"baseline":baseline,"source":source,"peerBefore":peer_before,
            "sharedSwitch":shared_switch,"ownedSwitch":owned_switch,"page":origin.page,
            "shared":shared,"owned":owned,"returned":returned,"clones":clones,
            "peerAfter":peer_after,"retained":retained,"catalog":before_stop}),
        )
    }
    .await;
    let shutdown = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let stopped = timeout(Duration::from_secs(40), server).await;
    let mut replacement_stopped = None;
    let mut replacement_shutdown = None;
    let second: Result<Value, String> = match &first {
        Ok(evidence) if matches!(stopped, Ok(Ok(Ok(())))) => {
            let (replacement, server) =
                serve_fixture(&root, Some(endpoint.generation.clone())).await;
            let result = async {
                let catalog = cli(&root, &["tab", "profile", "list"]).await?;
                let profile = evidence["profiles"][1]
                    .as_str()
                    .ok_or("retained profile missing")?;
                let reopened = Client::create(
                    &root,
                    "workspace-browser",
                    Some(profile),
                    "ua-after-backend-replacement",
                )
                .await?;
                reopened.action(&root, "goto", &url).await?;
                reopened.action(&root, "device", "iPhone 15").await?;
                let observed = observe(&reopened, &root).await?;
                reopened.close(&root).await?;
                Ok(json!({"catalog":catalog,"observed":observed}))
            }
            .await;
            replacement_shutdown = Some(
                backend(
                    &replacement,
                    "backend.shutdown",
                    json!({"schemaVersion":2,"mode":"stop"}),
                )
                .await,
            );
            replacement_stopped = Some(timeout(Duration::from_secs(40), server).await);
            result
        }
        _ => Err("initial fixture did not finish".into()),
    };
    let _ = stop_site.send(());
    let site_stopped = site.await;
    println!(
        "BROWSER_PROFILE_NATIVE_UA_LIFECYCLE root={} first={first:?} second={second:?} stopped={stopped:?} replacement={replacement_stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(
        matches!(stopped, Ok(Ok(Ok(())))),
        "{shutdown:?} {stopped:?}"
    );
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let first = first.unwrap();
    assert!(
        matches!(replacement_stopped, Some(Ok(Ok(Ok(()))))),
        "{replacement_shutdown:?} {replacement_stopped:?}"
    );
    let second = second.unwrap();
    let baseline = &first["baseline"];
    assert!(first["source"]["ua"].as_str().unwrap().contains("iPhone"));
    for key in ["peerBefore", "shared", "owned", "peerAfter", "retained"] {
        assert_native(&first[key], baseline);
    }
    for observed in first["clones"].as_array().unwrap() {
        assert_native(observed, baseline);
        assert_eq!(observed["width"], 393);
        assert_eq!(observed["height"], 852);
    }
    for key in ["sharedSwitch", "ownedSwitch"] {
        assert_eq!(
            first[key]["result"]["response"]["data"]["page"]["page_id"],
            first["page"]
        );
    }
    assert!(
        first["returned"]["ua"]
            .as_str()
            .unwrap()
            .contains("Pixel 9")
    );
    assert_eq!(
        first["returned"]["headers"]["user-agent"],
        first["returned"]["ua"]
    );
    assert_eq!(first["peerAfter"], first["peerBefore"]);
    assert_eq!(first["retained"]["marker"], Value::Null);
    assert_eq!(second["catalog"]["result"], first["catalog"]["result"]);
    assert_native(&second["observed"], baseline);
    assert_eq!(second["observed"]["width"], 393);
    assert_eq!(second["observed"]["height"], 852);
}
