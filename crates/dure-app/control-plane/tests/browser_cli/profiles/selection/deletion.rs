use super::*;
use sha2::{Digest, Sha256};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn delete_cli_retires_only_selected_profile_consumers_and_storage() {
    let (root, endpoint, server) = super::super::super::fixture().await;
    let (url, stop_site, site) = site().await;
    let evidence: Result<_, String> = async {
        peer_workspace(&root).await?;
        let a = cli(&root, &["tab", "profile", "create", "--label", "삭제할 프로필"]).await?;
        let a = a["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile A missing")?;
        let b = cli(&root, &["tab", "profile", "create", "--label", "유지할 프로필"]).await?;
        let b = b["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile B missing")?;
        let origin = Client::create(&root, "workspace-browser", Some(a), "delete-origin").await?;
        origin.action(&root, "goto", &url).await?;
        origin.evaluate(&root, "localStorage.setItem('value','삭제할 한글');document.cookie='value=deleted;Path=/;Max-Age=3600';window.original='삭제';true").await?;
        let peer = Client::create(&root, "workspace-profile-peer", Some(a), "delete-peer").await?;
        peer.action(&root, "goto", &url).await?;
        let shared = peer.evaluate(&root, "localStorage.getItem('value')").await?;
        let cloned = cli(&root, &["tab","profile","clone",&origin.resource,"--profile",b,"--page",&origin.page,"--controller","profile-agent","--epoch",&origin.epoch]).await?;
        let retained = Client { resource:origin.resource.clone(), page:cloned["result"]["response"]["data"]["page"]["page_id"].as_str().ok_or("profile B page missing")?.to_owned(), epoch:origin.epoch.clone(), created:Value::Null };
        retained.evaluate(&root, "localStorage.setItem('value','유지할 한글');window.retained='문서 유지';true").await?;
        let default = Client::create(&root, "workspace-browser", None, "delete-default").await?;
        default.action(&root, "goto", &url).await?;
        default.evaluate(&root, "localStorage.setItem('value','기본 유지');true").await?;
        let profile_path = root.join("backend/browser-profiles").join(format!("{:x}",Sha256::digest(a.as_bytes())));
        let storage_existed = profile_path.join("profile/Default").is_dir();
        let deleted = cli(&root, &["tab","profile","delete","--profile",a,"--idempotency-key","delete-a"]).await?;
        let replay = cli(&root, &["tab","profile","delete","--profile",a,"--idempotency-key","delete-a"]).await?;
        let again = cli(&root, &["tab","profile","delete","--profile",a,"--idempotency-key","delete-again"]).await?;
        let protected = cli(&root, &["tab","profile","delete","--profile","default"]).await?;
        let missing = cli(&root, &["tab","profile","delete","--profile","missing"]).await?;
        let selected = cli(&root, &["show",&retained.resource]).await?;
        let peer_gone = cli(&root, &["show",&peer.resource]).await;
        let retained_value = retained.evaluate(&root, "({stored:localStorage.getItem('value'),document:window.retained})").await?;
        let default_value = default.evaluate(&root, "localStorage.getItem('value')").await?;
        let rejected = cli(&root, &["create","--workspace","workspace-browser","--profile",a]).await;
        let entries = std::fs::read_dir(&profile_path).map_err(|e|e.to_string())?.map(|e|e.map(|e|e.file_name().to_string_lossy().into_owned())).collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let catalog = cli(&root, &["tab","profile","list"]).await?;
        let list = cli(&root, &["list","--workspace","workspace-browser"]).await?;
        Ok(json!({"a":a,"b":b,"shared":shared,"storageExisted":storage_existed,"deleted":deleted,"replay":replay,"again":again,"protected":protected,"missing":missing,
            "selected":selected,"peerGone":peer_gone.err(),"retained":retained_value,"default":default_value,"rejected":rejected.err(),"entries":entries,"catalog":catalog,"list":list,"retainedPage":retained.page}))
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
        "BROWSER_PROFILE_DELETE_CLI root={} evidence={evidence:?} shutdown={shutdown:?} stopped={stopped:?} site={site_stopped:?}",
        root.display()
    );
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "{stopped:?}");
    assert!(site_stopped.is_ok(), "{site_stopped:?}");
    let evidence = evidence.unwrap();
    assert_eq!(evidence["shared"], "삭제할 한글");
    assert_eq!(evidence["storageExisted"], true);
    assert_eq!(
        evidence["deleted"]["result"],
        json!({"deleted":true,"profile_id":evidence["a"]})
    );
    assert_eq!(evidence["replay"]["replayed"], true);
    assert_eq!(evidence["replay"]["result"], evidence["deleted"]["result"]);
    assert_eq!(evidence["again"]["result"]["deleted"], false);
    assert_eq!(evidence["protected"]["result"]["deleted"], false);
    assert_eq!(evidence["missing"]["result"]["deleted"], false);
    let pages = evidence["selected"]["result"]["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0]["page"]["page_id"], evidence["retainedPage"]);
    assert_eq!(pages[0]["profile_id"], evidence["b"]);
    assert!(
        evidence["peerGone"]
            .as_str()
            .unwrap()
            .contains("browser_resource_unavailable")
    );
    assert_eq!(
        evidence["retained"],
        json!({"stored":"유지할 한글","document":"문서 유지"})
    );
    assert_eq!(evidence["default"], "기본 유지");
    assert!(
        evidence["rejected"]
            .as_str()
            .unwrap()
            .contains("browser_profile_deleted")
    );
    assert_eq!(evidence["entries"], json!(["native-claim.json"]));
    let profiles = evidence["catalog"]["result"]["profiles"]
        .as_array()
        .unwrap();
    assert_eq!(profiles.len(), 2);
    assert!(
        !profiles
            .iter()
            .any(|p| p["profile"]["profileId"] == evidence["a"])
    );
    assert_eq!(
        evidence["list"]["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
