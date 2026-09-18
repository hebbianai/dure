use super::*;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    condition
        .then_some(())
        .ok_or_else(|| format!("current page fixture: {evidence:?}"))
}

async fn recorded(root: &Path, args: &[&str]) -> Result<Value, String> {
    let result = cli(root, args).await;
    println!(
        "BROWSER_CURRENT_COMMAND {}",
        json!({"args":args,"result":result})
    );
    result
}

async fn action(
    root: &Path,
    resource: &str,
    page: Option<&str>,
    epoch: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        values[0],
        resource,
        "--controller",
        "current-proof",
        "--epoch",
        epoch,
    ];
    if let Some(page) = page {
        args.extend_from_slice(&["--page", page]);
    }
    args.extend_from_slice(&values[1..]);
    recorded(root, &args).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned headless Chromium, native engine and Node"]
async fn current_target_survives_profile_routing_handoff_and_page_close() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = recorded(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        resources.push(resource.to_owned());
        let shown = recorded(&root, &["show", resource]).await?;
        let original = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("original page missing")?;
        let controlled = recorded(&root, &["control", resource, "--controller", "current-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        action(&root, resource, Some(original), epoch, &["tab-new", "about:blank"]).await?;
        let tabs = recorded(&root, &["show", resource]).await?;
        let added = tabs["result"]["pages"].as_array().and_then(|pages| pages.iter().find(|row| row["page"]["page_id"] != original)).and_then(|row| row["page"]["page_id"].as_str()).ok_or("added page missing")?;
        let profile = recorded(&root, &["tab", "profile", "create", "--label", "Current target profile", "--scope", "isolated"]).await?;
        let profile_id = profile["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        recorded(&root, &["tab", "profile", "set", resource, "--page", added, "--profile", profile_id, "--controller", "current-proof", "--epoch", epoch]).await?;
        let view = recorded(&root, &["show", resource]).await?;
        let pages = view["result"]["pages"].as_array().ok_or("page list missing")?;
        require(pages.len() == 2 && pages[0]["profile_id"] != pages[1]["profile_id"], &view)?;
        let other = pages[0]["page"]["page_id"].as_str().ok_or("other page missing")?;
        let selected = pages[1]["page"]["page_id"].as_str().ok_or("selected page missing")?;
        for page in [other, selected] {
            action(&root, resource, Some(page), epoch, &["eval", "document.title='Current target '+location.href;document.body.innerHTML='<input id=value aria-label=Value value=original>';true"]).await?;
        }
        action(&root, resource, Some(selected), epoch, &["tab-switch"]).await?;
        let current = recorded(&root, &["tab", "current", resource]).await?;
        require(current["result"]["tab"]["page"]["page_id"] == selected, (&current, &view))?;
        let listed = recorded(&root, &["tab", "list", resource]).await?;
        let listed_tabs = listed["result"]["tabs"].as_array().ok_or("tab list missing")?;
        require(listed_tabs.len() == 2 && listed_tabs.iter().filter(|tab| tab["active"] == true).count() == 1, &listed)?;
        require(listed_tabs.iter().any(|tab| tab["active"] == true && tab["page"]["page_id"] == selected), &listed)?;
        let selected_row = recorded(&root, &["tab", "show", resource, "--page", selected]).await?;
        require(selected_row["result"]["tab"]["page"]["page_id"] == selected, &selected_row)?;
        let title = recorded(&root, &["get", resource, "title"]).await?;
        require(title["result"]["data"]["title"] == "Current target about:blank", &title)?;
        action(&root, resource, None, epoch, &["fill", "#value", "선택한 탭"]).await?;
        let current_value = recorded(&root, &["get", resource, "value", "#value"]).await?;
        require(current_value["result"]["data"]["value"] == "선택한 탭", &current_value)?;
        let other_value = recorded(&root, &["get", resource, "value", "#value", "--page", other]).await?;
        require(other_value["result"]["data"]["value"] == "original", &other_value)?;
        let snapshot = recorded(&root, &["snapshot", resource]).await?;
        let reference = snapshot["references"].as_object().and_then(|refs| refs.iter().find(|(_, row)| row["name"] == "Value")).map(|(reference, _)| reference).ok_or("reference missing")?;
        recorded(&root, &["tab", "switch", resource, "--page", other, "--controller", "current-proof", "--epoch", epoch]).await?;
        require(recorded(&root, &["tab", "current", resource]).await?["result"]["tab"]["page"]["page_id"] == other, "current did not follow cross-profile switch")?;
        let stale = action(&root, resource, None, epoch, &["fill", reference, "stale"]).await;
        require(stale.as_ref().is_err_and(|error| error.contains("browser_snapshot_changed")), &stale)?;
        let handoff = recorded(&root, &["control", resource, "--controller", "next-controller"]).await?;
        let next_epoch = handoff["result"]["controller"]["epoch"].as_str().ok_or("next epoch missing")?;
        let obsolete = action(&root, resource, None, epoch, &["fill", "#value", "obsolete"]).await;
        require(obsolete.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &obsolete)?;
        recorded(&root, &["fill", resource, "#value", "new controller", "--controller", "next-controller", "--epoch", next_epoch]).await?;
        require(recorded(&root, &["get", resource, "value", "#value"]).await?["result"]["data"]["value"] == "new controller", "handoff changed current page")?;
        let missing = recorded(&root, &["get", resource, "title", "--page", "missing"]).await;
        require(missing.as_ref().is_err_and(|error| error.contains("browser_page_required")), &missing)?;
        recorded(&root, &["tab", "close", resource, "--controller", "next-controller", "--epoch", next_epoch]).await?;
        let after_close = recorded(&root, &["tab", "current", resource]).await?;
        require(after_close["result"]["tab"]["page"]["page_id"] == selected, &after_close)?;
        require(recorded(&root, &["get", resource, "value", "#value"]).await?["result"]["data"]["value"] == "선택한 탭", "close selected the wrong remaining page")?;
        Ok(json!({"initial":view,"current":current,"listed":listed,"staleReference":stale,"oldController":obsolete,"afterClose":after_close}))
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
        "BROWSER_CURRENT_CLI {}",
        json!({"root":root,"evidence":evidence,"closed":closed,"shutdown":stopped,"retired":format!("{retired:?}")})
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    for result in closed {
        result.unwrap();
    }
    evidence.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned headless Chromium, native engine and Node"]
async fn selecting_the_same_current_tab_preserves_its_snapshot() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = recorded(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str()
            .ok_or("resource missing")?;
        resources.push(resource.to_owned());
        let shown = recorded(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"]
            .as_str()
            .ok_or("page missing")?;
        let controlled = recorded(
            &root,
            &["control", resource, "--controller", "current-proof"],
        )
        .await?;
        let epoch = controlled["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("epoch missing")?;
        action(
            &root,
            resource,
            Some(page),
            epoch,
            &[
                "eval",
                "document.body.innerHTML='<input id=value aria-label=Value>';true",
            ],
        )
        .await?;
        let snapshot = recorded(&root, &["snapshot", resource]).await?;
        let reference = snapshot["references"]
            .as_object()
            .and_then(|refs| refs.iter().find(|(_, row)| row["name"] == "Value"))
            .map(|(reference, _)| reference)
            .ok_or("reference missing")?;
        action(&root, resource, Some(page), epoch, &["tab-switch"]).await?;
        let filled = action(
            &root,
            resource,
            None,
            epoch,
            &["fill", reference, "same tab"],
        )
        .await?;
        let value = recorded(&root, &["get", resource, "value", "#value"]).await?;
        require(value["result"]["data"]["value"] == "same tab", &value)?;
        Ok(json!({"snapshot":snapshot,"filled":filled,"value":value}))
    }
    .await;
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
        "BROWSER_SAME_CURRENT_CLI {}",
        json!({"root":root,"evidence":evidence,"closed":closed,"shutdown":stopped,"retired":format!("{retired:?}")})
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    for result in closed {
        result.unwrap();
    }
    evidence.unwrap();
}
