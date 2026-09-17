use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn trace_stop_exports_after_its_last_owned_page_closes() {
    closes_last_page("trace").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn profiler_stop_exports_after_its_last_owned_page_closes() {
    closes_last_page("profiler").await;
}

async fn closes_last_page(mode: &str) {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let owner = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", "last-page-owner"]).await?;
        let owner = owner["result"]["control"]["resource"]["resource_id"].as_str().ok_or("owner missing")?.to_owned();
        resources.push(owner.clone());
        let peer = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", "last-page-peer"]).await?;
        let peer = peer["result"]["control"]["resource"]["resource_id"].as_str().ok_or("peer missing")?.to_owned();
        resources.push(peer.clone());
        let controlled = cli(&root, &["control", &owner, "--controller", "trace-owner"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("owner epoch missing")?;
        let owner_options = ["--controller", "trace-owner", "--epoch", epoch];
        let controlled = cli(&root, &["control", &peer, "--controller", "trace-peer"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("peer epoch missing")?;
        let peer_options = ["--controller", "trace-peer", "--epoch", epoch];
        let mut start = vec![mode, &owner, "start", "--scope", "browser", "--idempotency-key", "last-page-start"];
        start.extend(owner_options);
        let started = cli(&root, &start).await?;
        let mut mark = vec!["eval", &owner, "performance.mark('dure-owner-before-last-page-close'); 1"];
        mark.extend(owner_options); cli(&root, &mark).await?;
        let mut mark = vec!["eval", &peer, "performance.mark('dure-peer-before-last-page-close'); 1"];
        mark.extend(peer_options); cli(&root, &mark).await?;
        let mut close = vec!["tab-close", &owner];close.extend(owner_options);
        cli(&root, &close).await?;
        let owner_state = cli(&root, &["show", &owner]).await?;
        let peer_before = cli(&root, &[mode, &peer, "status"]).await?;
        let path = root.join(format!("{mode}-after-last-page.json"));
        let mut stop = vec![mode, &owner, "stop", path.to_str().unwrap(), "--idempotency-key", "last-page-stop"];
        stop.extend(owner_options);
        // Keep the actual CLI error as evidence and still perform all cleanup.
        let stopped = cli(&root, &stop).await;
        let peer_after = cli(&root, &[mode, &peer, "status"]).await?;
        let file = if path.exists() {
            Some(serde_json::from_slice::<Value>(&fs::read(&path).map_err(|error|error.to_string())?).map_err(|error|error.to_string())?)
        } else { None };
        let mut read = vec!["eval", &peer, "performance.getEntriesByName('dure-peer-before-last-page-close').length"];
        read.extend(peer_options);
        let peer_mark = cli(&root, &read).await?;
        Ok(json!({
            "start":started["result"]["response"]["data"]["interval"],
            "ownerState":owner_state,"peerBusyBefore":peer_before["result"]["busy"],
            "peerBusyAfter":peer_after["result"]["busy"],
            "stopSucceeded":stopped.is_ok(),"stopError":stopped.as_ref().err(),
            "stop":stopped.as_ref().ok().map(|result|&result["result"]["response"]["data"]),
            "ownerMark":file.as_ref().is_some_and(|file|file.to_string().contains("dure-owner-before-last-page-close")),
            "peerTraceMark":file.as_ref().is_some_and(|file|file.to_string().contains("dure-peer-before-last-page-close")),
            "peerStillUsable":peer_mark["result"]["response"]["data"]["result"] == 1,
            "file":path
        }))
    }.await;
    let mut closed = Vec::new();
    for resource in resources {
        closed.push(cli(&root, &["close", &resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let server_closed = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_TRACE_LAST_PAGE mode={mode} root={} evidence={evidence:?} resources_closed={} backend_stopped={} server_closed={server_closed:?}",
        root.display(),
        closed.iter().all(Result::is_ok),
        stopped["kind"] == "dure.backend.response"
    );
    assert!(closed.iter().all(Result::is_ok), "{closed:?}");
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["ownerState"]["result"]["pages"], json!([]));
    assert_eq!(
        evidence["ownerState"]["result"]["control"]["current_page"],
        Value::Null
    );
    assert_eq!(evidence["peerBusyBefore"], true);
    assert_eq!(evidence["peerStillUsable"], true);
    assert_eq!(evidence["stopSucceeded"], true, "{evidence}");
    assert_eq!(evidence["ownerMark"], true);
    assert_eq!(evidence["peerTraceMark"], true);
    assert_eq!(evidence["peerBusyAfter"], false);
}
