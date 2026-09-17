use super::*;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    condition
        .then_some(())
        .ok_or_else(|| format!("workspace context: {evidence:?}"))
}

async fn recorded(root: &Path, cwd: &Path, args: &[&str]) -> Result<Value, String> {
    let result = cli_from(root, args, Some(cwd)).await;
    println!(
        "BROWSER_WORKSPACE_COMMAND {}",
        json!({"cwd":cwd,"args":args,"result":result})
    );
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn default_workspace_create_and_list_keep_distinct_task_resources() {
    let (root, endpoint, server) = fixture().await;
    let one = root.join("one");
    let two = root.join("two");
    let nested = one.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir(&two).unwrap();
    let store = SqliteDomainStore::open(root.join("backend/application-state.sqlite3"))
        .await
        .unwrap();
    let workspace = |id: &str, path: &Path| WorkspaceRecordV1 {
        workspace_id: WorkspaceIdV1::new(id).unwrap(),
        project_id: ProjectIdV1::new("project-browser").unwrap(),
        root_path: path.to_str().unwrap().into(),
        base_commit_sha: None,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    store
        .upsert_workspace(&workspace("workspace:one", &one))
        .await
        .unwrap();
    store
        .upsert_workspace(&workspace("workspace:two", &two))
        .await
        .unwrap();
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let listed = recorded(&root, &nested, &["list"]).await?;
        require(listed["result"]["workspace_id"] == "workspace:one" && listed["result"]["resources"] == json!([]), &listed)?;
        let first = recorded(&root, &nested, &["create", "--idempotency-key", "workspace-context-one"]).await?;
        let first_identity = &first["result"]["control"]["resource"];
        let first_id = first_identity["resource_id"].as_str().ok_or("first resource missing")?;
        resources.push(first_id.to_owned());
        require(first_identity["workspace_id"] == "workspace:one", first_identity)?;
        let parent = recorded(&root, &two, &["create", "--worktree", "id:workspace-browser"]).await?;
        let parent_identity = &parent["result"]["control"]["resource"];
        let parent_id = parent_identity["resource_id"].as_str().ok_or("parent resource missing")?;
        resources.push(parent_id.to_owned());
        require(parent_identity["workspace_id"] == "workspace-browser", parent_identity)?;
        let path_selector = format!("path:{}", two.display());
        let second = recorded(&root, &nested, &["create", "--worktree", &path_selector]).await?;
        let second_identity = &second["result"]["control"]["resource"];
        let second_id = second_identity["resource_id"].as_str().ok_or("second resource missing")?;
        resources.push(second_id.to_owned());
        require(second_identity["workspace_id"] == "workspace:two", second_identity)?;
        require(first_id != parent_id && first_id != second_id && parent_id != second_id, &resources)?;
        for (cwd, expected, id) in [(&nested, "workspace:one", first_id), (&two, "workspace:two", second_id), (&root, "workspace-browser", parent_id)] {
            let result = recorded(&root, cwd, &["list"]).await?;
            require(result["result"]["workspace_id"] == expected, &result)?;
            let rows = result["result"]["resources"].as_array().ok_or("resources missing")?;
            require(rows.len() == 1 && rows[0]["resource"]["resource_id"] == id, rows)?;
        }
        let replayed = recorded(&root, &nested, &["create", "--idempotency-key", "workspace-context-one"]).await?;
        require(replayed["replayed"] == true && replayed["result"]["control"]["resource"] == *first_identity, &replayed)?;
        store.upsert_workspace(&workspace("workspace:duplicate", &one)).await.map_err(|error| error.to_string())?;
        let rejected = recorded(&root, &nested, &["create"]).await;
        require(rejected.as_ref().is_err_and(|error| error.contains("browser_workspace_ambiguous")), &rejected)?;
        let retained = recorded(&root, &two, &["list", "--workspace", "workspace:one"]).await?;
        require(retained["result"]["resources"].as_array().is_some_and(|rows| rows.len() == 1 && rows[0]["resource"]["resource_id"] == first_id), &retained)?;
        let catalog = recorded(&root, &nested, &["workspaces"]).await?;
        require(catalog["result"]["workspaces"].as_array().is_some_and(|rows| rows.len() == 4), &catalog)?;
        Ok(json!({"first":first,"parent":parent,"second":second,"replayed":replayed,"duplicateRefusal":rejected,"retained":retained,"catalog":catalog}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources.iter().rev() {
        closed.push(recorded(&root, &root, &["close", resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let joined = timeout(Duration::from_secs(40), server).await;
    store.close().await;
    println!(
        "BROWSER_WORKSPACE_PROOF {}",
        json!({"home":root,"evidence":evidence,"closed":closed,"stopped":stopped})
    );
    assert!(closed.iter().all(Result::is_ok), "{closed:?}");
    assert_eq!(stopped["kind"], "dure.backend.response");
    joined.unwrap().unwrap().unwrap();
    evidence.unwrap();
}
