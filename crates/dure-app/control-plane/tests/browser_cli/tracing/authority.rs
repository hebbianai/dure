use super::*;

fn stop_request(control: &Value, instance: &Value, operation: &str, recording: &str) -> Value {
    json!({"kind":"tracing_stop","caller":control["controller"]["controller_id"],
        "authority":{"lease":control["controller"],"command_sequence":control["next_command_sequence"],
            "operation_id":operation,"instance_id":instance,"recording":recording}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn retained_stop_rejects_foreign_authority_and_replays_only_its_journaled_result() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        for operation in ["guarded-owner", "guarded-peer"] {
            let created = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", operation]).await?;
            resources.push(created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned());
        }
        let owner = &resources[0]; let peer = &resources[1];
        let controlled = cli(&root, &["control", owner, "--controller", "trace-owner"]).await?;
        let original_lease = controlled["result"]["controller"].clone();
        let epoch = original_lease["epoch"].as_str().ok_or("owner epoch missing")?;
        let options = ["--controller", "trace-owner", "--epoch", epoch];
        let mut start = vec!["trace", owner, "start", "--scope", "browser", "--idempotency-key", "guarded-start"];start.extend(options);
        let started = cli(&root, &start).await?;
        let mut mark = vec!["eval", owner, "performance.mark('dure-authorized-closed-trace'); 1"];mark.extend(options);cli(&root, &mark).await?;
        let mut close = vec!["tab-close", owner];close.extend(options);cli(&root, &close).await?;
        cli(&root, &["control", peer, "--controller", "trace-peer"]).await?;
        let peer_control = cli(&root, &["show", peer]).await?["result"]["control"].clone();
        let peer_status = cli(&root, &["trace", peer, "status"]).await?;
        let instance = &peer_status["result"]["instances"][0]["instance_id"];
        cli(&root, &["control", owner, "--controller", "trace-human"]).await?;
        let control = cli(&root, &["show", owner]).await?["result"]["control"].clone();
        let correct = stop_request(&control, instance, "guarded-stop", "guarded-start");
        let mut stale = stop_request(&control, instance, "guarded-stale-controller", "guarded-start");
        stale["caller"] = original_lease["controller_id"].clone(); stale["authority"]["lease"] = original_lease;
        let mut gap = stop_request(&control, instance, "guarded-sequence-gap", "guarded-start");
        let sequence = control["next_command_sequence"].as_str().ok_or("sequence missing")?.parse::<u64>().map_err(|_|"invalid sequence")?;
        gap["authority"]["command_sequence"] = (sequence+1).to_string().into();
        let input = json!({"kind":"action","caller":"trace-human","authority":{"lease":control["controller"],
            "command_sequence":control["next_command_sequence"],"operation_id":"guarded-retired-input","page":started["result"]["response"]["data"]["interval"]["origin"]},
            "action":{"kind":"evaluate","script":"window.mustNotRun=true"}});
        let mut rejected = Vec::new();
        for (request, expected) in [
            (stop_request(&peer_control, instance, "guarded-peer-stop", "guarded-start"), "browser_permit_mismatch"),
            (stale, "browser_controller_changed"),
            (stop_request(&control, instance, "guarded-wrong-recording", "different-start"), "browser_permit_mismatch"),
            (gap, "browser_command_sequence_gap"),
            (input, "browser_page_gone"),
        ] {
            let result = backend(&endpoint, "browser.resource", request).await;
            rejected.push(json!({"expected":expected,"actual":result["error"]["code"]}));
        }
        let after_rejection = cli(&root, &["show", owner]).await?;
        let path = root.join("authorized-after-close.json");
        let epoch = control["controller"]["epoch"].as_str().ok_or("human epoch missing")?;
        let stopped = cli(&root, &["trace", owner, "stop", path.to_str().unwrap(), "--recording", "guarded-start",
            "--controller", "trace-human", "--epoch", epoch, "--idempotency-key", "guarded-stop"]).await?;
        let replay = backend(&endpoint, "browser.resource", correct).await;
        let foreign_replay = backend(&endpoint, "browser.resource",
            stop_request(&peer_control, instance, "guarded-stop", "guarded-start")).await;
        let recovered = root.join("authorized-recovered.json");
        cli(&root, &["artifact", "guarded-stop", "--output", recovered.to_str().unwrap()]).await?;
        let bytes = fs::read(path).map_err(|error|error.to_string())?;
        let trace: Value = serde_json::from_slice(&bytes).map_err(|error|error.to_string())?;
        let peer_epoch = peer_control["controller"]["epoch"].as_str().ok_or("peer epoch missing")?;
        let peer_alive = cli(&root, &["eval", peer, "1", "--controller", "trace-peer", "--epoch", peer_epoch]).await?;
        let peer_after = cli(&root, &["trace", peer, "status"]).await?;
        Ok(json!({"rejected":rejected,"sequenceUnchanged":after_rejection["result"]["control"]["next_command_sequence"]==control["next_command_sequence"],
            "peerIntervalHidden":peer_status["result"]["instances"][0]["interval"].is_null(),
            "peerBusyBefore":peer_status["result"]["busy"],"peerBusyAfter":peer_after["result"]["busy"],
            "peerAlive":peer_alive["result"]["response"]["data"]["result"]==1,"replayed":replay["result"]["replayed"],
            "foreignReplayError":foreign_replay["error"]["code"],
            "sameRecoveredBytes":bytes==fs::read(recovered).map_err(|error|error.to_string())?,
            "originalMark":trace.to_string().contains("dure-authorized-closed-trace"),
            "originalProvenance":stopped["result"]["response"]["data"]["artifact"]["page"]==started["result"]["response"]["data"]["interval"]["origin"]}))
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
        "BROWSER_TRACE_STOP_AUTHORITY root={} evidence={evidence:?} resources_closed={} server_closed={server_closed:?}",
        root.display(),
        closed.iter().all(Result::is_ok)
    );
    assert!(closed.iter().all(Result::is_ok), "{closed:?}");
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    for rejection in evidence["rejected"].as_array().unwrap() {
        assert_eq!(rejection["actual"], rejection["expected"]);
    }
    for key in [
        "sequenceUnchanged",
        "peerIntervalHidden",
        "peerBusyBefore",
        "peerAlive",
        "replayed",
        "sameRecoveredBytes",
        "originalMark",
        "originalProvenance",
    ] {
        assert_eq!(evidence[key], true, "{key}: {evidence}");
    }
    assert_eq!(evidence["peerBusyAfter"], false);
    assert_eq!(evidence["foreignReplayError"], "browser_operation_conflict");
}
