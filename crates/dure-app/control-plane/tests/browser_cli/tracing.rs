use super::*;

#[path = "tracing/authority.rs"]
mod authority;
#[path = "tracing/page_retirement.rs"]
mod page_retirement;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn real_cli_traces_and_recovers_profiler_output_after_a_lost_stop_connection() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", "trace-create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
        resources.push(resource.clone());
        let controlled = cli(&root, &["control", &resource, "--controller", "trace-agent"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--controller", "trace-agent", "--epoch", epoch];
        let mut args = vec!["exec", &resource, "--command", "trace start", "--idempotency-key", "trace-start"]; args.extend(shared);
        let started = cli(&root, &args).await?;
        let mut args = vec!["eval", &resource, "performance.mark('dure-real-trace'); 1"];args.extend(shared);cli(&root, &args).await?;
        let trace_path = root.join("trace.json");
        let mut args = vec!["trace", &resource, "stop", trace_path.to_str().unwrap(), "--idempotency-key", "trace-stop"];args.extend(shared);
        let stopped = cli(&root, &args).await?;
        let trace_bytes = fs::read(&trace_path).map_err(|error| error.to_string())?;
        let trace: Value = serde_json::from_slice(&trace_bytes).map_err(|error| error.to_string())?;
        let recovered_path = root.join("trace-recovered.json");
        cli(&root, &["artifact", "trace-stop", "--output", recovered_path.to_str().unwrap()]).await?;
        let recovered = fs::read(recovered_path).map_err(|error| error.to_string())?;
        let receipt = cli(&root, &["receipt", "trace-stop"]).await?;
        let mut args = vec!["exec", &resource, "--command", "profiler start --categories blink.user_timing --scope browser", "--idempotency-key", "profiler-start"];args.extend(shared);
        let profiler = cli(&root, &args).await?;
        let mut args = vec!["eval", &resource, "performance.mark('dure-real-profiler'); 1"];args.extend(shared);cli(&root, &args).await?;
        let shown = cli(&root, &["show", &resource]).await?;
        let control = &shown["result"]["control"];
        let request = envelope(&endpoint, "browser.resource", json!({
            "kind":"action","caller":"trace-agent",
            "authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"profiler-stop-lost","command_sequence":control["next_command_sequence"]},
            "action":{"kind":"tracing","action":{"kind":"stop","recording":profiler["result"]["response"]["data"]["interval"]["operation_id"]}}
        }));
        let mut disconnected = UnixStream::connect(&endpoint.socket_path).await.map_err(|error| error.to_string())?;
        disconnected.write_all(format!("{request}\n").as_bytes()).await.map_err(|error| error.to_string())?;
        drop(disconnected);
        let lost = timeout(Duration::from_secs(15), async {
            loop {
                let receipt = cli(&root, &["receipt", "profiler-stop-lost"]).await?;
                if receipt["receipt"]["state"] == "succeeded" { return Ok::<_, String>(receipt); }
                if receipt["receipt"]["state"] == "failed" {return Err(format!("stop failed: {receipt}"));}
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_|"lost stop did not complete")??;
        let profile_path = root.join("profile.json");
        cli(&root, &["artifact", "profiler-stop-lost", "--output", profile_path.to_str().unwrap()]).await?;
        let profile: Value = serde_json::from_slice(&fs::read(profile_path).map_err(|error|error.to_string())?).map_err(|error|error.to_string())?;
        let status = cli(&root, &["profiler", &resource, "status"]).await?;
        Ok(json!({"taskScope":started["result"]["response"]["data"]["interval"]["scope"],"traceMark":trace.to_string().contains("dure-real-trace"),"eventCount":stopped["result"]["response"]["data"]["eventCount"],"actualEventCount":trace["traceEvents"].as_array().map(Vec::len),"sameRecoveredBytes":trace_bytes==recovered,"traceReceipt":receipt["receipt"]["state"],"lostStopReceipt":lost["receipt"]["state"],"profilerMark":profile.to_string().contains("dure-real-profiler"),"metadata":profile["metadata"],"busy":status["result"]["busy"]}))
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
        "BROWSER_TRACE_REAL_CLI root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    for key in ["traceMark", "sameRecoveredBytes", "profilerMark"] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(evidence["taskScope"], "task");
    assert_eq!(evidence["busy"], false);
    assert_eq!(evidence["traceReceipt"], "succeeded");
    assert_eq!(evidence["lostStopReceipt"], "succeeded");
    assert_eq!(evidence["eventCount"], evidence["actualEventCount"]);
}
