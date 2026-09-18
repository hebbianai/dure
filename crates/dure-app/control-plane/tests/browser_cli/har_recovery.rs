use super::*;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("HAR recovery: {evidence:?}"))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn har_stop_response_loss_replays_the_receipt_without_stopping_a_new_recording() {
    let (root, endpoint, server) = fixture().await;
    println!("BROWSER_HAR_RECOVERY_OWNED root={}", root.display());
    let evidence:Result<_,String>=async {
        let created=cli(&root,&["create"]).await?;
        let resource=created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let view=cli(&root,&["show",resource]).await?;
        let page=view["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let granted=cli(&root,&["control",resource,"--controller","har-proof"]).await?;
        let epoch=granted["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared=["--page",page,"--controller","har-proof","--epoch",epoch];
        let mut start=vec!["capture",resource,"start","--idempotency-key","har-first-start"];start.extend(shared);
        cli(&root,&start).await?;
        let view=cli(&root,&["show",resource]).await?;
        let control=&view["result"]["control"];
        let body=json!({"kind":"action","caller":"har-proof","authority":{"lease":control["controller"],"page":view["result"]["pages"][0]["page"],"operation_id":"har-lost-stop","command_sequence":control["next_command_sequence"]},"action":{"kind":"network_capture","action":"stop"}});
        let mut socket=UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{}\n",envelope(&endpoint,"browser.resource",body.clone())).as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        let receipt=timeout(Duration::from_secs(10),async {
            loop {
                match cli(&root,&["receipt","har-lost-stop"]).await {
                    Ok(receipt) if receipt["receipt"]["state"]=="succeeded" => break Ok::<_,String>(receipt),
                    Ok(receipt) if receipt["receipt"]["state"]=="failed" => break Err(format!("stop failed: {receipt}")),
                    Ok(_)=>{},
                    Err(error)=>break Err(error),
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.map_err(|_|"HAR receipt deadline".to_string())??;
        require(receipt["result_available"]==true,&receipt)?;
        let stopped=cli(&root,&["capture",resource,"status","--page",page]).await?;
        require(stopped["result"]["recording"]==false,&stopped)?;
        let mut next=vec!["capture",resource,"start","--idempotency-key","har-second-start"];next.extend(shared);
        cli(&root,&next).await?;
        let replay=backend(&endpoint,"browser.resource",body.clone()).await;
        require(replay["result"]["replayed"]==true,&replay)?;
        let recording=cli(&root,&["capture",resource,"status","--page",page]).await?;
        require(recording["result"]["recording"]==true,&recording)?;
        let mut changed=body.clone();changed["action"]["action"]="start".into();
        let conflict=backend(&endpoint,"browser.resource",changed).await;
        require(conflict.to_string().contains("browser_operation_conflict"),&conflict)?;
        let first=root.join("original-lost.har");
        cli(&root,&["artifact","har-lost-stop","--output",first.to_str().unwrap()]).await?;
        let bytes=fs::read(&first).map_err(|error|error.to_string())?;
        let har:Value=serde_json::from_slice(&bytes).map_err(|error|error.to_string())?;
        require(har["log"]["version"]=="1.2",&har)?;
        cli(&root,&["close",resource]).await?;
        let recovered=root.join("after-close.har");
        cli(&root,&["artifact","har-lost-stop","--output",recovered.to_str().unwrap()]).await?;
        require(fs::read(recovered).map_err(|error|error.to_string())?==bytes,"artifact changed after resource retirement")?;
        Ok(json!({"receipt":receipt,"replay":replay,"recordingAfterReplay":recording,"bytes":bytes.len(),"har":har}))
    }.await;
    println!(
        "BROWSER_HAR_RECOVERY_BEFORE_CLOSE root={} evidence={evidence:?}",
        root.display()
    );
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_HAR_RECOVERY root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
