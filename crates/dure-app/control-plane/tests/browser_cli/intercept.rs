use super::*;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("interception evidence: {evidence:?}"))
    }
}

async fn http_fixture() -> (
    String,
    Arc<Mutex<Vec<String>>>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let received = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::clone(&received);
    let (stop, mut stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break };
                    let requests = Arc::clone(&requests);
                    connections.spawn(async move {
                        let _ = timeout(Duration::from_secs(5), async {
                            let mut bytes = Vec::new();
                            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                                let mut chunk = [0; 4096];
                                let count = socket.read(&mut chunk).await?;
                                if count == 0 || bytes.len() > 64 * 1024 { return Ok::<_, std::io::Error>(()); }
                                bytes.extend_from_slice(&chunk[..count]);
                            }
                            let request = String::from_utf8_lossy(&bytes);
                            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                            requests.lock().await.push(path.clone());
                            let body = if path == "/start" { "<!doctype html><title>Interception fixture</title>" } else { "server response" };
                            let kind = if path == "/start" { "text/html" } else { "text/plain" };
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
                            socket.shutdown().await
                        }).await;
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        connections.shutdown().await;
    });
    (base, received, stop, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn actual_cli_interception_applies_every_pattern_and_restores_requests() {
    let (root, endpoint, server) = fixture().await;
    let (base, received, stop_http, http) = http_fixture().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control", resource, "--controller", "intercept-proof"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page", page, "--controller", "intercept-proof", "--epoch", epoch];
        let url = format!("{base}/start");
        let mut navigate = vec!["goto", resource, &url]; navigate.extend(shared);
        cli(&root, &navigate).await?;
        let mut baseline = vec!["eval", resource, "fetch('/baseline').then(r=>r.text())"]; baseline.extend(shared);
        let result = cli(&root, &baseline).await?;
        require(result["result"]["response"]["data"]["result"] == "server response", &result)?;
        let mut enable = vec!["intercept", resource, "enable", "--patterns", "*/blocked-a,*/blocked-b", "--abort"]; enable.extend(shared);
        let blocked = cli(&root, &enable).await?;
        require(blocked["result"]["response"]["data"]["enabled"] == true, &blocked)?;
        let mut fetch = vec!["eval", resource, "Promise.all(['/blocked-a','/blocked-b','/allowed'].map(url=>fetch(url).then(r=>r.text()).catch(()=> 'blocked')))"]; fetch.extend(shared);
        let result = cli(&root, &fetch).await?;
        require(result["result"]["response"]["data"]["result"] == json!(["blocked", "blocked", "server response"]), &result)?;
        let mut mock = vec!["intercept", resource, "enable", "--patterns", "*/mock-*", "--body", "한글 대체 응답", "--status", "201", "--content-type", "text/plain; charset=utf-8", "--response-headers", "{\"X-Fixture\":\"mock\"}", "--resource-types", "Fetch"]; mock.extend(shared);
        cli(&root, &mock).await?;
        let mut read_mock = vec!["eval", resource, "fetch('/mock-one').then(async r=>({status:r.status,header:r.headers.get('x-fixture'),body:await r.text()}))"]; read_mock.extend(shared);
        let result = cli(&root, &read_mock).await?;
        require(result["result"]["response"]["data"]["result"] == json!({"status":201,"header":"mock","body":"한글 대체 응답"}), &result)?;
        let list = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        require(list["result"]["enabled"] == true && list["result"]["available"] == true && list["result"]["rules"].as_array().is_some_and(|rules| rules.len() == 2), &list)?;
        let before = received.lock().await.clone();
        require(before.contains(&"/baseline".into()) && before.contains(&"/allowed".into()) && !before.iter().any(|path| path.starts_with("/blocked-") || path.starts_with("/mock-")), &before)?;
        let mut disable = vec!["intercept", resource, "disable"]; disable.extend(shared);
        cli(&root, &disable).await?;
        let result = cli(&root, &fetch).await?;
        require(result["result"]["response"]["data"]["result"] == json!(["server response", "server response", "server response"]), &result)?;
        let list = cli(&root, &["intercept", resource, "list", "--page", page]).await?;
        require(list["result"]["enabled"] == false && list["result"]["rules"] == json!([]), &list)?;
        Ok(json!({"before":before,"after":received.lock().await.clone(),"state":list}))
    }.await;
    println!(
        "BROWSER_INTERCEPT_BEFORE_CLOSE root={} evidence={evidence:?}",
        root.display()
    );
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    let _ = stop_http.send(());
    let http_retired = timeout(Duration::from_secs(10), http).await;
    println!(
        "BROWSER_INTERCEPT_CLI root={} evidence={evidence:?} stopped={stopped:?} retired={retired:?} http={http_retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}

#[path = "intercept_recovery.rs"]
mod recovery;
#[path = "intercept_scope.rs"]
mod scope;

#[path = "intercept_cancellation.rs"]
mod cancellation;
