use super::*;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("HAR source scope: {evidence:?}"))
    }
}

async fn http_fixture() -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break };
                    requests.spawn(async move {
                        timeout(Duration::from_secs(5), async {
                            let mut data = [0; 8192];
                            let mut received = 0;
                            while !data[..received].windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                if received == data.len() { return Err(std::io::Error::other("fixture headers exceed limit")); }
                                let count = socket.read(&mut data[received..]).await?;
                                if count == 0 { return Ok::<_, std::io::Error>(()); }
                                received += count;
                            }
                            let request = String::from_utf8_lossy(&data[..received]);
                            let (kind, body) = if request.starts_with("GET /frame ") {
                                ("text/html", "<!doctype html><script>fetch('/frame-record').then(r=>r.text()).then(text=>parent.postMessage(text,'*'))</script>")
                            } else if request.starts_with("GET /worker.js ") {
                                ("text/javascript", "fetch('/worker-record').then(r=>r.text()).then(text=>postMessage(text))")
                            } else if request.lines().next().is_some_and(|line| line.contains("-record ")) {
                                ("text/plain; charset=utf-8", "captured 한글")
                            } else {
                                ("text/html", "<!doctype html><title>HAR source fixture</title>")
                            };
                            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
                            socket.write_all(headers.as_bytes()).await?;
                            socket.write_all(body.as_bytes()).await?;
                            socket.shutdown().await
                        }).await
                    });
                }
                _ = requests.join_next(), if !requests.is_empty() => {}
            }
        }
        requests.shutdown().await;
    });
    (base, stop, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn har_records_frame_and_worker_requests_across_navigation_without_neighbor_requests() {
    let (root, endpoint, server) = fixture().await;
    println!("BROWSER_HAR_SOURCES_OWNED root={}", root.display());
    let (base, stop_http, http) = http_fixture().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control", resource, "--controller", "har-proof"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page", page, "--controller", "har-proof", "--epoch", epoch];
        let url = format!("{base}/start");
        let mut navigate = vec!["goto", resource, &url]; navigate.extend(shared);
        cli(&root, &navigate).await?;
        let neighbor_url = format!("{base}/neighbor");
        let mut new = vec!["tab-new", resource, &neighbor_url]; new.extend(shared);
        let opened = cli(&root, &new).await?;
        let neighbor = opened["result"]["observation"]["pages"].as_array().and_then(|pages| pages.iter().find(|candidate| candidate["url"] == neighbor_url)).and_then(|candidate| candidate["page"]["page_id"].as_str()).ok_or("neighbor missing")?;
        for target in [page, neighbor] {
            cli(&root, &["capture", resource, "start", "--page", target, "--controller", "har-proof", "--epoch", epoch]).await?;
        }
        let frame_url = format!("{}/frame", base.replace("127.0.0.1", "localhost"));
        let script = format!("Promise.all([fetch('/page-record').then(r=>r.text()),new Promise(resolve=>{{window.worker=new Worker('/worker.js');worker.onmessage=event=>resolve(event.data)}}),new Promise(resolve=>{{addEventListener('message',event=>resolve(event.data),{{once:true}});document.body.appendChild(Object.assign(document.createElement('iframe'),{{src:{}}}))}})])", json!(frame_url));
        let mut evaluate = vec!["eval", resource, &script]; evaluate.extend(shared);
        let effects = cli(&root, &evaluate).await?;
        require(effects["result"]["response"]["data"]["result"] == json!(["captured 한글", "captured 한글", "captured 한글"]), &effects)?;
        cli(&root, &["eval", resource, "fetch('/neighbor-record').then(r=>r.text())", "--page", neighbor, "--controller", "har-proof", "--epoch", epoch]).await?;
        let mut retire = vec!["eval", resource, "worker.terminate();document.querySelector('iframe').remove();true"]; retire.extend(shared);
        cli(&root, &retire).await?;
        let after_url = format!("{base}/after-navigation");
        let mut navigate = vec!["goto", resource, &after_url]; navigate.extend(shared);
        cli(&root, &navigate).await?;
        let mut documents = Vec::new();
        for (target, name) in [(page, "page"), (neighbor, "neighbor")] {
            cli(&root, &["tab-switch", resource, "--page", target, "--controller", "har-proof", "--epoch", epoch]).await?;
            cli(&root, &["wait", resource, "load", "networkidle", "--timeout", "3000", "--page", target]).await?;
            let output = root.join(format!("{name}.har"));
            cli(&root, &["capture", resource, "stop", "--page", target, "--controller", "har-proof", "--epoch", epoch, "--output", output.to_str().unwrap()]).await?;
            let bytes = fs::read(output).map_err(|error| error.to_string())?;
            let har: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            require(har["log"]["_dure"]["complete"] == true && har["log"]["_dure"]["truncated"] == false, &har)?;
            require(har["log"]["_dure"]["page"]["page_id"] == target, &har)?;
            documents.push(har);
        }
        let entries = documents[0]["log"]["entries"].as_array().ok_or("entries missing")?;
        for suffix in ["/page-record", "/frame-record", "/worker-record", "/after-navigation"] {
            require(entries.iter().any(|entry| entry["request"]["url"].as_str().is_some_and(|url| url.ends_with(suffix)) && entry["_dure"]["state"] == "finished"), (&suffix, &documents))?;
        }
        require(!entries.iter().any(|entry| entry["request"]["url"].as_str().is_some_and(|url| url.ends_with("/neighbor-record"))), &documents)?;
        let neighbor_entries = documents[1]["log"]["entries"].as_array().ok_or("neighbor entries missing")?;
        require(neighbor_entries.iter().any(|entry| entry["request"]["url"].as_str().is_some_and(|url| url.ends_with("/neighbor-record"))), &documents)?;
        require(!neighbor_entries.iter().any(|entry| entry["request"]["url"].as_str().is_some_and(|url| ["/page-record", "/frame-record", "/worker-record", "/after-navigation"].iter().any(|suffix| url.ends_with(suffix)))), &documents)?;
        Ok(json!({"effects":effects["result"]["response"]["data"]["result"],"documents":documents}))
    }.await;
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
        "BROWSER_HAR_SOURCES root={} evidence={evidence:?} retired={retired:?} http={http_retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
