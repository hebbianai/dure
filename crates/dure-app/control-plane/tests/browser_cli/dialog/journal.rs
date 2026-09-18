use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn disconnected_dialog_response_replays_without_answering_a_new_prompt() {
    let (root, endpoint, server) = fixture().await;
    let result: Result<_,String> = async {
        let created = cli(&root,&["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root,&["show",resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let controlled = cli(&root,&["control",resource,"--controller","agent-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page",page,"--controller","agent-proof","--epoch",epoch];
        let mut setup = vec!["eval",resource,"document.body.innerHTML='<button id=ask>Ask</button>';window.answers=[];window.count=0;document.querySelector('#ask').onclick=()=>{count++;answers.push(prompt('Durable dialog'))};true"];
        setup.extend(shared);
        cli(&root,&setup).await?;
        let mut observer = Observer::connect(&root).await?;
        let mut original = Value::Null;
        let mut proof = Vec::new();
        for index in 0..2 {
            let shown = cli(&root,&["show",resource]).await?;
            let view = &shown["result"];
            let click = json!({"kind":"action","caller":"agent-proof","authority":{"lease":view["control"]["controller"],"page":view["pages"][0]["page"],"operation_id":format!("durable-trigger:{index}"),"command_sequence":view["control"]["next_command_sequence"]},"action":{"kind":"click","target":{"kind":"css","selector":"#ask"}}});
            let (clicked,answer) = tokio::join!(backend(&endpoint,"browser.resource",click),async {
                let response: Result<_,String> = async {
                    timeout(Duration::from_secs(2),async {
                        loop { if observer.next().await?["method"] == "Page.javascriptDialogOpening" { return Ok::<_,String>(()); } }
                    }).await.map_err(|_|"dialog event timeout")??;
                    let observed = cli(&root,&["dialog",resource,"status","--page",page]).await?;
                    let view = &observed["result"];
                    if index == 0 {
                        original = json!({"kind":"dialog_respond","caller":"agent-proof","authority":{"lease":view["control"]["controller"],"page":view["page"],"operation_id":"durable-dialog-answer","command_sequence":view["control"]["next_command_sequence"]},"dialog":view["dialog"]["identity"],"response":{"kind":"accept","text":"한글 durable"}});
                        let mut invalid = original.clone();
                        invalid["response"] = json!({"kind":"dismiss","text":"unexpected"});
                        let rejected = backend(&endpoint,"browser.resource",invalid).await;
                        if rejected["error"]["code"] != "browser_request_invalid" { return Err(format!("invalid dialog response accepted: {rejected}")); }
                        let mut invalid = original.clone();
                        invalid["caller"] = json!("other");
                        invalid["authority"]["operation_id"] = json!("wrong-dialog-caller");
                        let rejected = backend(&endpoint,"browser.resource",invalid).await;
                        if rejected["error"]["code"] != "browser_caller_mismatch" { return Err(format!("wrong dialog caller accepted: {rejected}")); }
                        let after = cli(&root,&["dialog",resource,"status","--page",page]).await?;
                        if after["result"] != *view { return Err(format!("rejection changed dialog authority: {after}")); }
                        let mut lost = UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
                        let request = envelope(&endpoint,"browser.resource",original.clone());
                        lost.write_all(format!("{request}\n").as_bytes()).await.map_err(|e|e.to_string())?;
                        drop(lost);
                        timeout(Duration::from_secs(3),async {
                            loop {
                                let receipt = cli(&root,&["receipt","durable-dialog-answer"]).await?;
                                if receipt["receipt"]["state"] == "succeeded" { return Ok::<_,String>(receipt); }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        }).await.map_err(|_|"lost dialog receipt timeout".to_string())?
                    } else {
                        let replayed = backend(&endpoint,"browser.resource",original.clone()).await;
                        let after = cli(&root,&["dialog",resource,"status","--page",page]).await?;
                        if replayed["result"]["replayed"] != true || after["result"]["dialog"] != view["dialog"] || after["result"]["control"] != view["control"] || view["dialog"]["identity"] == original["dialog"] {
                            return Err(format!("replay changed current dialog: replay={replayed} before={observed} after={after}"));
                        }
                        let mut dismiss = vec!["dialog",resource,"dismiss"];
                        dismiss.extend(shared);
                        cli(&root,&dismiss).await?;
                        Ok(replayed)
                    }
                }.await;
                if response.is_err() { let _ = observer.request("Page.handleJavaScriptDialog",json!({"accept":false})).await; }
                response
            });
            if clicked["result"]["result"]["response"]["success"] != true { return Err(format!("trigger failed: {clicked}; answer={answer:?}")); }
            proof.push(answer?);
        }
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({answers,count})","returnByValue":true})).await?;
        observer.socket.close(None).await.map_err(|e|e.to_string())?;
        if actual["result"]["value"] != json!({"answers":["한글 durable",null],"count":2}) { return Err(format!("dialog actual effect: {actual}")); }
        cli(&root,&["close",resource]).await?;
        let recovered = backend(&endpoint,"browser.resource",original).await;
        if recovered["result"]["replayed"] != true { return Err(format!("dialog receipt after close: {recovered}")); }
        Ok(json!({"actual":actual,"receipts":proof,"recovered":recovered}))
    }.await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_DIALOG_JOURNAL root={} result={result:?} retired={retired:?}",
        root.display()
    );
    assert_eq!(stopped["kind"], "dure.backend.response");
    retired.unwrap().unwrap().unwrap();
    result.unwrap();
}
