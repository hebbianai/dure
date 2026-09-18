use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn real_snapshot_diff_preserves_page_authority_and_compares_caller_files() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let mut owned = Vec::new();
        for name in ["diff-owner", "diff-peer"] {
            let created = cli(&root, &["create", "--idempotency-key", name]).await?;
            let id = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
            resources.push(id.clone());
            let controlled = cli(&root, &["control", &id, "--controller", name]).await?;
            let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?.to_owned();
            cli(&root, &["eval", &id, "document.body.innerHTML='<main id=main><h1>원래 제목</h1><button>누르기</button></main><aside>별도 영역</aside>';true", "--controller", name, "--epoch", &epoch]).await?;
            owned.push((id, epoch));
        }
        let (id, epoch) = &owned[0];
        let peer_before = cli(&root, &["snapshot", &owned[1].0]).await?;
        let baseline = cli(&root, &["snapshot", id]).await?;
        let text = baseline["result"]["data"]["snapshot"].as_str().ok_or("snapshot missing")?;
        fs::write(root.join("baseline.txt"), text).map_err(|e| e.to_string())?;
        let before = cli(&root, &["show", id]).await?;
        let equal = cli_from(&root, &["diff", id, "snapshot", "--baseline", "baseline.txt"], Some(&root)).await?;
        let after = cli(&root, &["show", id]).await?;
        let original_ref = baseline["references"].as_object().ok_or("refs missing")?.iter().find(|(_, value)| value["role"] == "button").ok_or("button missing")?.0;
        let stale = cli(&root, &["click", id, original_ref, "--controller", "diff-owner", "--epoch", epoch]).await.err();
        cli(&root, &["eval", id, "document.querySelector('h1').textContent='수정 제목';true", "--controller", "diff-owner", "--epoch", epoch]).await?;
        let changed = cli_from(&root, &["exec", id, "--command", "diff snapshot -b baseline.txt --json"], Some(&root)).await?;
        let scoped = cli(&root, &["exec", id, "--command", "diff snapshot -s '#main' -c -d 8"]).await?;
        let peer_after = cli(&root, &["snapshot", &owned[1].0]).await?;
        fs::write(root.join("large-baseline.txt"), "old line with a long name\n".repeat(13000)).map_err(|e| e.to_string())?;
        let large = cli_from(&root, &["diff", id, "snapshot", "--baseline", "large-baseline.txt"], Some(&root)).await?;
        Ok(json!({"largeRemovals":large["result"]["data"]["diff"]["removals"],"equal":equal["result"]["data"]["diff"],"changed":changed["result"]["data"]["diff"],"scoped":scoped["result"]["data"]["diff"],"stale":stale,"samePage":before["result"]["control"]["current_page"]==after["result"]["control"]["current_page"],"sameController":before["result"]["control"]["controller"]==after["result"]["control"]["controller"],"sameSequence":before["result"]["control"]["next_command_sequence"]==after["result"]["control"]["next_command_sequence"],"peerUnchanged":peer_before["result"]["data"]["snapshot"]==peer_after["result"]["data"]["snapshot"]}))
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
        "BROWSER_DIFF_CLEANUP root={} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    println!("BROWSER_DIFF_JSON {evidence}");
    assert_eq!(evidence["largeRemovals"], 13000);
    assert_eq!(evidence["equal"]["changed"], false);
    assert_eq!(evidence["equal"]["diff"], "");
    assert_eq!(evidence["changed"]["changed"], true);
    assert!(
        evidence["changed"]["additions"]
            .as_u64()
            .is_some_and(|n| n > 0)
    );
    assert!(
        evidence["changed"]["removals"]
            .as_u64()
            .is_some_and(|n| n > 0)
    );
    let changed = evidence["changed"]["diff"].as_str().unwrap();
    assert!(changed.contains("원래 제목") && changed.contains("수정 제목"));
    let scoped = evidence["scoped"]["diff"].as_str().unwrap();
    assert!(scoped.contains("수정 제목") && !scoped.contains("별도 영역"));
    assert!(
        evidence["stale"]
            .as_str()
            .is_some_and(|error| error.contains("browser_snapshot_changed"))
    );
    for key in [
        "samePage",
        "sameController",
        "sameSequence",
        "peerUnchanged",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn snapshot_depth_preserves_u32_values_and_native_snapshot_grammar() {
    let (root, endpoint, server) = fixture().await;
    let mut resource = None;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--idempotency-key", "depth-owner"]).await?;
        let id = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
        resource = Some(id.clone());
        let controlled = cli(&root, &["control", &id, "--controller", "depth-owner"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        cli(&root, &["eval", &id, "document.body.innerHTML='<main><h1>한글 깊이</h1><section><button>중첩 버튼</button></section></main>';true", "--controller", "depth-owner", "--epoch", epoch]).await?;
        let before = cli(&root, &["show", &id]).await?;
        let page = &before["result"]["control"]["current_page"];
        let baseline = cli(&root, &["snapshot", &id]).await?;
        let expected = &baseline["result"]["data"]["snapshot"];
        let mut typed = Vec::new();
        for depth in [2147483647_u64, 2147483648, 4294967295] {
            let response = backend(&endpoint, "browser.resource", json!({"kind":"snapshot","page":page,"options":{"depth":depth}})).await;
            typed.push(json!({"depth":depth,"sameSnapshot":response["result"]["result"]["data"]["snapshot"]==*expected,"response":response}));
        }
        let mut invalid = Vec::new();
        for depth in [json!(-1), json!(4294967296_u64), json!(1.5)] {
            invalid.push(backend(&endpoint, "browser.resource", json!({"kind":"snapshot","page":page,"options":{"depth":depth}})).await);
        }
        let mut commands = Vec::new();
        for depth in ["2147483648", "4294967295", "+4294967295"] {
            for native in [false, true] {
                let command = format!("diff snapshot -d {depth}");
                let result = if native { cli(&root, &["exec", &id, "--command", &command]).await }
                    else { cli(&root, &["diff", &id, "snapshot", "--depth", depth]).await };
                commands.push(json!({"depth":depth,"native":native,"sameSnapshot":result.as_ref().is_ok_and(|v|v["result"]["data"]["snapshot"]==*expected),"result":result}));
            }
        }
        let ignored = cli(&root, &["exec", &id, "--command", "snapshot -d 4294967295"]).await?;
        let shallow = cli(&root, &["diff", &id, "snapshot", "--depth", "0"]).await?;
        let after = cli(&root, &["show", &id]).await?;
        // Snapshot publication advances the projection revision while retaining
        // the page, controller, input contacts and command sequence.
        let mut before_control = before["result"]["control"].clone();
        let mut after_control = after["result"]["control"].clone();
        let before_revision = before_control.as_object_mut().ok_or("control missing")?.remove("revision").ok_or("revision missing")?;
        let after_revision = after_control.as_object_mut().ok_or("control missing")?.remove("revision").ok_or("revision missing")?;
        let revision_advanced = after_revision.as_str().ok_or("revision invalid")?.parse::<u64>().map_err(|e|e.to_string())? > before_revision.as_str().ok_or("revision invalid")?.parse::<u64>().map_err(|e|e.to_string())?;
        Ok(json!({"typed":typed,"invalid":invalid,"commands":commands,"nativeIgnored":ignored["result"]["data"]["snapshot"]==*expected,"shallow":shallow["result"]["data"]["snapshot"],"expected":expected,"sameControl":before_control==after_control,"revisionAdvanced":revision_advanced}))
    }.await;
    let closed = match resource {
        Some(id) => cli(&root, &["close", &id]).await,
        None => Ok(Value::Null),
    };
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let server_closed = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_DEPTH_CLEANUP root={} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    println!("BROWSER_DEPTH_JSON {evidence}");
    for row in evidence["typed"]
        .as_array()
        .unwrap()
        .iter()
        .chain(evidence["commands"].as_array().unwrap())
    {
        assert_eq!(row["sameSnapshot"], true, "{row}");
    }
    for response in evidence["invalid"].as_array().unwrap() {
        assert_eq!(response["kind"], "dure.backend.error", "{response}");
    }
    assert_eq!(evidence["nativeIgnored"], true);
    assert_eq!(evidence["sameControl"], true);
    assert_eq!(evidence["revisionAdvanced"], true);
    assert_ne!(evidence["shallow"], evidence["expected"]);
    assert!(!evidence["shallow"].as_str().unwrap().contains("중첩 버튼"));
}
