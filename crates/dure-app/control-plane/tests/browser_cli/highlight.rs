use super::*;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    condition
        .then_some(())
        .ok_or_else(|| format!("highlight fixture: {evidence:?}"))
}

async fn recorded(root: &Path, args: &[&str]) -> Result<Value, String> {
    let result = cli(root, args).await;
    println!("BROWSER_HIGHLIGHT_COMMAND args={args:?} result={result:?}");
    result
}

async fn action(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        values[0],
        resource,
        "--page",
        page,
        "--controller",
        "highlight-proof",
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(&values[1..]);
    Ok(recorded(root, &args).await?["result"]["response"]["data"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned headless Chromium, native engine and Node"]
async fn actual_highlight_lifetime_authority_and_receipt_recovery() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = recorded(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        resources.push(resource.to_owned());
        let shown = recorded(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let controlled = recorded(&root, &["control", resource, "--controller", "highlight-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("controller missing")?;
        let setup = r#"document.body.innerHTML='<input id=focus value="한글 kept"><button id=target style="position:absolute;left:60px;top:120px;width:180px;height:40px" disabled>Disabled target</button><button id=other style="position:absolute;left:280px;top:120px">Other target</button>';document.querySelector('#focus').focus();window.clicks=0;window.inputs=0;document.addEventListener('click',()=>window.clicks++);document.addEventListener('input',()=>window.inputs++);true"#;
        action(&root, resource, page, epoch, &["eval", setup]).await?;
        let state = "({focus:document.activeElement.id,value:document.querySelector('#focus').value,clicks:window.clicks,inputs:window.inputs,x:scrollX,y:scrollY})";
        let before = action(&root, resource, page, epoch, &["eval", state]).await?;
        let inspect = "(()=>{const s=getComputedStyle(document.querySelector('#target'));return {color:s.outlineColor,width:s.outlineWidth,style:s.outlineStyle,offset:s.outlineOffset,other:document.querySelector('#other').style.outline};})()";
        let cleared = "document.querySelector('#target').style.outline==='' && document.querySelector('#target').style.outlineOffset===''";
        let started = std::time::Instant::now();
        action(&root, resource, page, epoch, &["highlight", "#target"]).await?;
        let highlighted = action(&root, resource, page, epoch, &["eval", inspect]).await?;
        require(highlighted["result"] == json!({"color":"rgb(255, 0, 0)","width":"2px","style":"solid","offset":"2px","other":""}), &highlighted)?;
        let after = action(&root, resource, page, epoch, &["eval", state]).await?;
        require(before == after, (&before, &after))?;
        action(&root, resource, page, epoch, &["wait", "function", cleared, "--timeout", "10000"]).await?;
        let elapsed_ms = started.elapsed().as_millis();
        require(elapsed_ms >= 2800, elapsed_ms)?;

        let snapshot = recorded(&root, &["snapshot", resource, "--page", page]).await?;
        let reference = snapshot["references"].as_object().and_then(|refs| refs.iter().find(|(_, entry)| entry["name"] == "Disabled target")).map(|(reference, _)| reference).ok_or("disabled reference missing")?;
        recorded(&root, &["highlight", resource, reference, "--controller", "highlight-proof", "--epoch", epoch]).await?;
        require(action(&root, resource, page, epoch, &["eval", inspect]).await? == highlighted, "reference did not highlight exact disabled node")?;
        let screenshot = root.join("highlight.png");
        recorded(&root, &["screenshot", resource, "--page", page, "--output", screenshot.to_str().ok_or("screenshot path")?]).await?;
        require(fs::read(&screenshot).map_err(|error| error.to_string())?.starts_with(b"\x89PNG\r\n\x1a\n"), &screenshot)?;
        action(&root, resource, page, epoch, &["wait", "function", cleared, "--timeout", "10000"]).await?;
        let missing = recorded(&root, &["highlight", resource, "#target", "--page", page]).await;
        require(missing.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &missing)?;
        let obsolete = action(&root, resource, page, "stale", &["highlight", "#target"]).await;
        require(obsolete.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &obsolete)?;
        recorded(&root, &["snapshot", resource, "--page", page]).await?;
        let stale = action(&root, resource, page, epoch, &["highlight", reference]).await;
        require(stale.as_ref().is_err_and(|error| error.contains("browser_snapshot_changed")), &stale)?;
        require(action(&root, resource, page, epoch, &["eval", cleared]).await?["result"] == true, "rejected commands changed outline")?;

        // A lost response is recovered from the durable receipt without replaying the effect.
        let view = recorded(&root, &["show", resource]).await?;
        let control = &view["result"]["control"];
        let identity = &view["result"]["pages"][0]["page"];
        let lost = json!({"kind":"action","caller":"highlight-proof","authority":{"lease":control["controller"],"page":identity,"command_sequence":control["next_command_sequence"],"operation_id":"highlight-lost-response"},"action":{"kind":"highlight","target":{"kind":"css","selector":"#target"}}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error| error.to_string())?;
        socket.write_all(format!("{}\n", envelope(&endpoint, "browser.resource", lost.clone())).as_bytes()).await.map_err(|error| error.to_string())?;
        drop(socket);
        let receipt = timeout(Duration::from_secs(10), async {
            loop {
                let receipt = recorded(&root, &["receipt", "highlight-lost-response"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded") => return Ok::<_, String>(receipt),
                    Some("failed") => return Err(format!("lost highlight failed: {receipt}")),
                    _ => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.map_err(|_| "highlight receipt deadline")??;
        require(action(&root, resource, page, epoch, &["eval", inspect]).await? == highlighted, &receipt)?;
        action(&root, resource, page, epoch, &["wait", "function", cleared, "--timeout", "10000"]).await?;
        action(&root, resource, page, epoch, &["eval", "document.querySelector('#target').style.outline='4px solid blue';true"]).await?;
        let newer = action(&root, resource, page, epoch, &["eval", inspect]).await?;
        let replayed = backend(&endpoint, "browser.resource", lost).await;
        require(replayed["result"]["replayed"] == true, &replayed)?;
        require(action(&root, resource, page, epoch, &["eval", inspect]).await? == newer, "receipt recovery repeated highlight")?;
        require(action(&root, resource, page, epoch, &["eval", state]).await? == before, "highlight changed page input or focus")?;
        action(&root, resource, page, epoch, &["reload"]).await?;
        let old_document = action(&root, resource, page, epoch, &["highlight", reference]).await;
        require(old_document.as_ref().is_err_and(|error| error.contains("browser_document_changed")), &old_document)?;
        Ok(json!({"highlighted":highlighted,"pagePreserved":after,"clearElapsedMs":elapsed_ms,"screenshot":screenshot,"staleSnapshot":stale,"staleDocument":old_document,"replayed":replayed}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources.iter().rev() {
        closed.push(recorded(&root, &["close", resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_HIGHLIGHT_CLI root={} evidence={evidence:?} closed={closed:?} shutdown={stopped} retired={retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    for result in closed {
        result.unwrap();
    }
    evidence.unwrap();
}
