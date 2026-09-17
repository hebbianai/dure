use super::*;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    condition
        .then_some(())
        .ok_or_else(|| format!("named tab fixture: {evidence:?}"))
}

async fn command(
    root: &Path,
    resource: &str,
    caller: &str,
    epoch: &str,
    arguments: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        "--resource",
        resource,
        "--controller",
        caller,
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(arguments);
    cli(root, &args).await
}

async fn named(root: &Path, resource: &str, label: &str) -> Result<Value, String> {
    Ok(cli(root, &["tab", "show", resource, "--label", label]).await?["result"]["tab"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned headless Chromium, native engine and Node"]
async fn named_tabs_preserve_resource_profile_and_lost_response_ownership() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        resources.push(resource.to_owned());
        let controlled = cli(&root, &["control", resource, "--controller", "label-agent"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("lease missing")?;
        let first = command(&root, resource, "label-agent", epoch, &["exec", "--command", "tab new --label docs about:blank"]).await?;
        require(first["result"]["response"]["data"]["label"] == "docs", &first)?;
        let docs = named(&root, resource, "docs").await?;
        let docs_id = docs["page"]["page_id"].as_str().ok_or("named page missing")?;
        command(&root, resource, "label-agent", epoch, &["eval", "window.labelGuard='한글 원본';document.title='First title';true"]).await?;
        let before = cli(&root, &["show", resource]).await?;
        let duplicate = command(&root, resource, "label-agent", epoch, &["tab", "create", "--label", "docs"]).await;
        require(duplicate.as_ref().is_err_and(|error| error.contains("browser_tab_label_taken")), &duplicate)?;
        require(cli(&root, &["show", resource]).await?["result"]["pages"] == before["result"]["pages"], "duplicate created or changed a page")?;
        require(command(&root, resource, "label-agent", epoch, &["eval", "window.labelGuard"]).await?["result"]["response"]["data"]["result"] == "한글 원본", "duplicate touched the source document")?;
        command(&root, resource, "label-agent", epoch, &["goto", "about:blank"]).await?;
        let navigated = named(&root, resource, "docs").await?;
        require(navigated["page"]["page_id"] == docs_id && navigated["label"] == "docs", &navigated)?;

        let profile = cli(&root, &["tab", "profile", "create", "--label", "Named fixture profile"]).await?;
        let profile_id = profile["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        let isolated = command(&root, resource, "label-agent", epoch, &["tab", "create", "--label", "archive", "--profile", profile_id]).await?;
        require(isolated["result"]["response"]["data"]["label"] == "archive", &isolated)?;
        let archive = named(&root, resource, "archive").await?;
        require(archive["profile_id"] == profile_id, &archive)?;
        command(&root, resource, "label-agent", epoch, &["exec", "--command", "tab docs"]).await?;
        require(cli(&root, &["tab", "current", resource]).await?["result"]["tab"]["page"]["page_id"] == docs_id, "label selected another tab")?;
        cli(&root, &["tab", "profile", "set", resource, "--page", docs_id, "--profile", profile_id, "--controller", "label-agent", "--epoch", epoch]).await?;
        let replaced = named(&root, resource, "docs").await?;
        require(replaced["page"]["page_id"] == docs_id && replaced["profile_id"] == profile_id && replaced["label"] == "docs", &replaced)?;

        let peer_created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let peer = peer_created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("peer missing")?;
        resources.push(peer.to_owned());
        let peer_control = cli(&root, &["control", peer, "--controller", "label-agent"]).await?;
        let peer_epoch = peer_control["result"]["controller"]["epoch"].as_str().ok_or("peer lease missing")?;
        command(&root, peer, "label-agent", peer_epoch, &["tab", "create", "--label", "docs"]).await?;
        let peer_page = named(&root, peer, "docs").await?;
        require(peer_page["page"]["resource"]["resource_id"] == peer, &peer_page)?;
        let next = cli(&root, &["control", resource, "--controller", "label-human"]).await?;
        let next_epoch = next["result"]["controller"]["epoch"].as_str().ok_or("next lease missing")?;
        require(named(&root, resource, "docs").await?["page"] == replaced["page"], "handoff changed the label binding")?;
        let stale = command(&root, resource, "label-agent", epoch, &["exec", "--command", "tab close docs"]).await;
        require(stale.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &stale)?;
        command(&root, resource, "label-human", next_epoch, &["exec", "--command", "tab close docs"]).await?;
        require(named(&root, resource, "docs").await.is_err(), "closed name still resolves")?;
        command(&root, resource, "label-human", next_epoch, &["exec", "--command", "tab archive"]).await?;
        command(&root, resource, "label-human", next_epoch, &["tab", "create", "--label", "docs", "--profile", profile_id]).await?;
        let reused = named(&root, resource, "docs").await?;
        require(reused["page"]["page_id"] != docs_id && reused["profile_id"] == profile_id, &reused)?;
        require(named(&root, peer, "docs").await?["page"] == peer_page["page"], "close/reuse crossed resources")?;

        // Drop exactly the creation reply; recover the same journaled action.
        let shown = cli(&root, &["show", resource]).await?;
        let control = &shown["result"]["control"];
        let body = json!({"kind":"action","caller":"label-human","authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"named-tab-lost-reply","command_sequence":control["next_command_sequence"]},"action":{"kind":"new_page","url":"about:blank","label":"lost"}});
        let request = envelope(&endpoint, "browser.resource", body.clone());
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{request}\n").as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(20), async {
            loop {
                let receipt = cli(&root, &["receipt", "named-tab-lost-reply"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded") => return Ok::<_,String>(()),
                    Some("failed") => return Err(format!("named creation failed: {receipt}")),
                    _ => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.map_err(|_|"named creation receipt deadline")??;
        let recovered_page = named(&root, resource, "lost").await?;
        let before_recovery = cli(&root, &["tab", "list", resource]).await?;
        let recovered = backend(&endpoint, "browser.resource", body).await;
        require(recovered["result"]["replayed"] == true, &recovered)?;
        require(recovered["result"]["result"]["response"]["data"]["page"] == recovered_page["page"], &recovered)?;
        require(cli(&root, &["tab", "list", resource]).await?["result"] == before_recovery["result"], "recovery repeated creation")?;
        Ok(json!({"duplicateBeforeCreation":true,"navigationRetained":true,"profileCreationAndReplacementRetained":true,"resourceIsolation":true,"handoffRetained":true,"closeAndReuse":true,"lostResponseRecoveredOnce":true,"recoveredPage":recovered_page["page"]}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources.iter().rev() {
        closed.push(cli(&root, &["close", resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_NAMED_TABS_EVIDENCE {}",
        json!({"root":root,"evidence":evidence,"closed":closed,"shutdown":stopped,"retired":format!("{retired:?}")})
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    for result in closed {
        result.unwrap();
    }
    evidence.unwrap();
}
