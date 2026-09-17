use super::*;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("HAR evidence: {evidence:?}"))
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
                        let result = timeout(Duration::from_secs(5), async {
                            let mut data = Vec::new();
                            loop {
                                let mut chunk = [0; 4096];
                                let count = socket.read(&mut chunk).await?;
                                if count == 0 { return Ok::<_, std::io::Error>(()); }
                                data.extend_from_slice(&chunk[..count]);
                                if data.len() > 64 * 1024 { return Ok(()); }
                                if let Some(end) = data.windows(4).position(|part| part == b"\r\n\r\n") {
                                    let headers = String::from_utf8_lossy(&data[..end]);
                                    let length = headers.lines().find_map(|line| {
                                        let (name, value) = line.split_once(':')?;
                                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                                    }).unwrap_or(0);
                                    if data.len() >= end + 4 + length { break; }
                                }
                            }
                            let first = String::from_utf8_lossy(&data);
                            let redirect = first.starts_with("GET /redirect ");
                            let html = first.starts_with("GET /start ");
                            let body = if html { "<!doctype html><title>HAR fixture</title>" } else { "한글 응답" };
                            let status = if redirect { "302 Found" } else { "200 OK" };
                            let location = if redirect { "Location: /done\r\n" } else { "" };
                            let kind = if html { "text/html" } else { "text/plain; charset=utf-8" };
                            let headers = format!("HTTP/1.1 {status}\r\n{location}Content-Type: {kind}\r\nContent-Length: {}\r\nX-Har-Response: fixture\r\nSet-Cookie: har_fixture=local; Path=/; SameSite=Lax\r\nConnection: close\r\n\r\n", body.len());
                            socket.write_all(headers.as_bytes()).await?;
                            socket.write_all(body.as_bytes()).await?;
                            socket.shutdown().await
                        }).await;
                        result.is_ok()
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
async fn actual_cli_har_records_an_interval_and_recovers_the_original_artifact() {
    let (root, endpoint, server) = fixture().await;
    println!("BROWSER_HAR_CLI_OWNED root={}", root.display());
    let (base, stop_http, http) = http_fixture().await;
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control", resource, "--controller", "har-proof"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page", page, "--controller", "har-proof", "--epoch", epoch];
        let url = format!("{base}/start");
        let mut navigate = vec!["goto", resource, &url]; navigate.extend(shared);
        cli(&root, &navigate).await?;
        let mut before = vec!["eval", resource, "fetch('/before').then(r=>r.text())"]; before.extend(shared);
        cli(&root, &before).await?;
        let mut start = vec!["capture", resource, "start", "--idempotency-key", "har-start-once"]; start.extend(shared);
        let started = cli(&root, &start).await?;
        require(started["result"]["response"]["data"]["started"] == true, &started)?;
        let mut request = vec!["eval", resource, "fetch('/record?label='+encodeURIComponent('한글'),{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8','X-Har-Request':'fixture'},body:'한글 요청'}).then(r=>r.text()).then(()=>fetch('/redirect')).then(r=>r.text())"]; request.extend(shared);
        cli(&root, &request).await?;
        cli(&root, &["wait",resource,"load","networkidle","--timeout","3000","--page",page]).await?;
        let output = root.join("recorded.har");
        let mut stop = vec!["capture", resource, "stop", "--output", output.to_str().unwrap(), "--idempotency-key", "har-stop-once"]; stop.extend(shared);
        let stopped = cli(&root, &stop).await?;
        let original = fs::read(&output).map_err(|error| error.to_string())?;
        let har: Value = serde_json::from_slice(&original).map_err(|error| error.to_string())?;
        require(har["log"]["version"] == "1.2", &har)?;
        let entries = har["log"]["entries"].as_array().ok_or("HAR entries missing")?;
        let post = entries.iter().find(|entry| entry["request"]["method"] == "POST").ok_or("HAR POST missing")?;
        require(post["request"]["postData"]["text"] == "한글 요청", post)?;
        require(post["request"]["queryString"].as_array().is_some_and(|query| query.iter().any(|pair| pair["name"] == "label" && pair["value"] == "한글")), post)?;
        for (field, name) in [("request", "x-har-request"), ("response", "x-har-response")] {
            require(post[field]["headers"].as_array().is_some_and(|headers| headers.iter().any(|header| header["name"].as_str().is_some_and(|key| key.eq_ignore_ascii_case(name)) && header["value"] == "fixture")), post)?;
        }
        require(post["response"]["cookies"].as_array().is_some_and(|cookies| cookies.iter().any(|cookie| cookie["name"] == "har_fixture" && cookie["value"] == "local")), post)?;
        require(post["response"]["status"] == 200 && post["response"]["bodySize"].as_i64().is_some_and(|size|size > 0), post)?;
        require(post["startedDateTime"].as_str().is_some_and(|time| time.ends_with('Z') && time.contains('T')), post)?;
        require(post["time"].as_f64().is_some_and(|time|time >= 0.0) && post["timings"].is_object(), post)?;
        require(entries.iter().any(|entry| entry["response"]["status"] == 302 && entry["response"]["redirectURL"] == "/done"), &har)?;
        require(entries.iter().any(|entry| entry["request"]["url"] == format!("{base}/done")), &har)?;
        require(!entries.iter().any(|entry| entry["request"]["url"] == format!("{base}/before")), &har)?;
        let mut after = vec!["eval", resource, "fetch('/after').then(r=>r.text())"]; after.extend(shared);
        cli(&root, &after).await?;
        let recovered = root.join("recovered.har");
        cli(&root, &["artifact", "har-stop-once", "--output", recovered.to_str().unwrap()]).await?;
        require(fs::read(&recovered).map_err(|error|error.to_string())? == original, "artifact changed after stop")?;
        let receipt = cli(&root, &["receipt", "har-stop-once"]).await?;
        require(receipt["receipt"]["state"] == "succeeded" && receipt["result_available"] == true, &receipt)?;
        Ok(json!({"har":har,"stop":stopped,"receipt":receipt,"bytes":original.len()}))
    }.await;
    println!(
        "BROWSER_HAR_CLI_BEFORE_CLOSE root={} evidence={evidence:?}",
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
        "BROWSER_HAR_CLI root={} evidence={evidence:?} stopped={stopped:?} retired={retired:?} http={http_retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
