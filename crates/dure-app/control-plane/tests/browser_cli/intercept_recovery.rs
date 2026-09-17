use super::super::*;
use super::require;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn interception_response_loss_replays_without_replacing_newer_rules() {
    let (root, endpoint, server) = fixture().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        cli(&root, &["control", resource, "--controller", "intercept-proof"]).await?;
        let view = cli(&root, &["show", resource]).await?;
        let control = &view["result"]["control"];
        let page = view["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let epoch = control["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let body = json!({"kind":"action","caller":"intercept-proof","authority":{"lease":control["controller"],"page":view["result"]["pages"][0]["page"],"operation_id":"intercept-lost-enable","command_sequence":control["next_command_sequence"]},"action":{"kind":"interception","action":{"kind":"enable","rule":{"patterns":["*/old"],"effect":{"kind":"abort"}}}}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{}\n", envelope(&endpoint, "browser.resource", body.clone())).as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        let receipt = timeout(Duration::from_secs(10), async {
            loop {
                let receipt = cli(&root, &["receipt", "intercept-lost-enable"]).await?;
                if receipt["receipt"]["state"] == "succeeded" { break Ok::<_,String>(receipt); }
                if receipt["receipt"]["state"] == "failed" { break Err(format!("enable failed: {receipt}")); }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.map_err(|_|"interception receipt deadline".to_string())??;
        let shared = ["--page", page, "--controller", "intercept-proof", "--epoch", epoch];
        let mut disable = vec!["intercept", resource, "disable"]; disable.extend(shared);
        cli(&root, &disable).await?;
        let mut newer = vec!["intercept", resource, "enable", "--patterns", "*/new", "--abort"]; newer.extend(shared);
        cli(&root, &newer).await?;
        let before = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        let replay = backend(&endpoint, "browser.resource", body.clone()).await;
        require(replay["result"]["replayed"] == true, &replay)?;
        let after = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        require(after["result"] == before["result"] && after["result"]["rules"][0]["patterns"] == json!(["*/new"]), &after)?;
        let mut changed = body.clone(); changed["action"]["action"]["rule"]["patterns"] = json!(["*/changed"]);
        let conflict = backend(&endpoint, "browser.resource", changed).await;
        require(conflict.to_string().contains("browser_operation_conflict"), &conflict)?;
        cli(&root, &["close", resource]).await?;
        let closed_replay = backend(&endpoint, "browser.resource", body).await;
        require(closed_replay["result"]["replayed"] == true, &closed_replay)?;
        Ok(json!({"receipt":receipt,"afterReplay":after,"closedReplay":closed_replay}))
    }.await;
    let stopped = backend(&endpoint, "backend.shutdown", json!({"schemaVersion":2,"mode":"stop"})).await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!("BROWSER_INTERCEPT_RECOVERY root={} evidence={evidence:?} retired={retired:?}", root.display());
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
