use super::*;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

#[path = "react/failures.rs"]
mod failures;
#[path = "react/lifecycle.rs"]
mod lifecycle;

async fn site(mode: &str) -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let bundled = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/browser_cli/react/bundle.mjs"))
        .arg(mode)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        bundled.status.success(),
        "{}",
        String::from_utf8_lossy(&bundled.stderr)
    );
    let bundle: Value = serde_json::from_slice(&bundled.stdout).unwrap();
    assert_eq!(bundle["react"], "19.2.7");
    assert_eq!(bundle["reactDom"], "19.2.7");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = &mut stopped => break,
            };
            let (mut socket, _) = accepted.unwrap();
            let mut request = [0; 8192];
            let count = socket.read(&mut request).await.unwrap();
            if count == 0 {
                continue;
            }
            let request = String::from_utf8_lossy(&request[..count]);
            let (mime, body) = if request.starts_with("GET /app.js ") {
                (
                    "text/javascript",
                    bundle["source"].as_str().unwrap().to_owned(),
                )
            } else {
                (
                    "text/html",
                    format!(
                        "<!doctype html><meta charset=utf-8><link rel=icon href=data:,><div id=root>{}</div><script>window.fixtureOriginalCommit=window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.onCommitFiberRoot; sessionStorage.loads=Number(sessionStorage.loads||0)+1;</script><script src=/app.js></script>",
                        bundle["markup"].as_str().unwrap()
                    ),
                )
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (origin, stop, task)
}

async fn action(root: &Path, resource: &str, epoch: &str, args: &[&str]) -> Result<Value, String> {
    let mut command = vec![args[0], resource];
    command.extend_from_slice(&args[1..]);
    command.extend(["--controller", "react-owner", "--epoch", epoch]);
    cli(root, &command).await
}

fn data(value: &Value) -> &Value {
    &value["result"]["response"]["data"]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned Chromium, native engine, Node and installed React fixture dependencies"]
async fn actual_react_tree_inspection_render_changes_suspense_and_cleanup() {
    let (origin, stop, site) = site("development").await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<Value, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser", "--enable", "react-devtools"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
        resources.push(resource.clone());
        let controlled = cli(&root, &["control", &resource, "--controller", "react-owner"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        action(&root, &resource, epoch, &["goto", &origin]).await?;
        action(&root, &resource, epoch, &["wait", "function", "window.reactFixtureReady === '19.2.7'"]).await?;
        let tree = action(&root, &resource, epoch, &["exec", "--command", "react tree --json"]).await?;
        let counter = data(&tree)["nodes"].as_array().ok_or("tree missing")?.iter().find(|node| node["name"] == "Counter").ok_or_else(||format!("Counter missing: {tree}"))?["id"].to_string();
        let inspected = action(&root, &resource, epoch, &["react", "inspect", &counter]).await?;
        action(&root, &resource, epoch, &["react", "renders", "start"]).await?;
        let duplicate = action(&root, &resource, epoch, &["react", "renders", "start"]).await;
        action(&root, &resource, epoch, &["click", "#increment"]).await?;
        let updated = action(&root, &resource, epoch, &["react", "inspect", &counter]).await?;
        action(&root, &resource, epoch, &["click", "#suspend"]).await?;
        action(&root, &resource, epoch, &["wait", "selector", "#pending"]).await?;
        let suspended = action(&root, &resource, epoch, &["exec", "--command", "react suspense --only-dynamic --json"]).await?;
        action(&root, &resource, epoch, &["click", "#resolve"]).await?;
        action(&root, &resource, epoch, &["wait", "selector", "#resolved"]).await?;
        let resolved = action(&root, &resource, epoch, &["react", "suspense"]).await?;
        let renders = action(&root, &resource, epoch, &["react", "renders", "stop"]).await?;
        let cleaned = action(&root, &resource, epoch, &["eval", "({active:!!window.__AB_RENDERS_ACTIVE__,restored:window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot===window.fixtureOriginalCommit})"]).await?;
        action(&root, &resource, epoch, &["reload"]).await?;
        action(&root, &resource, epoch, &["wait", "function", "window.reactFixtureReady === '19.2.7'"]).await?;
        let reloaded = action(&root, &resource, epoch, &["eval", "({active:!!window.__AB_RENDERS_ACTIVE__,hook:!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__,loads:Number(sessionStorage.loads)})"]).await?;
        let next_tree = action(&root, &resource, epoch, &["react", "tree"]).await?;
        Ok(json!({"tree":data(&tree),"inspected":data(&inspected),"updated":data(&updated),"duplicateRejected":duplicate.is_err(),"suspended":data(&suspended),"resolved":data(&resolved),"renders":data(&renders),"cleaned":data(&cleaned)["result"],"reloaded":data(&reloaded)["result"],"nextTree":data(&next_tree)}))
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
    let _ = stop.send(());
    site.await.unwrap();
    println!(
        "BROWSER_REACT_NATIVE root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert!(
        evidence["inspected"]["text"]
            .as_str()
            .unwrap()
            .contains("한글 counter")
    );
    assert_ne!(evidence["inspected"]["text"], evidence["updated"]["text"]);
    assert!(
        evidence["updated"]["text"]
            .as_str()
            .unwrap()
            .contains("State: 1")
    );
    assert_eq!(evidence["duplicateRejected"], true);
    assert!(
        evidence["suspended"]["boundaries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["isSuspended"] == true)
    );
    assert!(
        evidence["resolved"]["boundaries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["isSuspended"] == false)
    );
    let counter = evidence["renders"]["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Counter")
        .unwrap();
    assert!(counter["count"].as_u64().unwrap() >= 1);
    assert!(
        counter["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["type"] == "state"
                && change["prev"] == "0"
                && change["next"] == "1")
    );
    assert_eq!(evidence["cleaned"], json!({"active":false,"restored":true}));
    assert_eq!(
        evidence["reloaded"],
        json!({"active":false,"hook":true,"loads":2})
    );
    assert!(
        evidence["nextTree"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["name"] == "Counter")
    );
}
