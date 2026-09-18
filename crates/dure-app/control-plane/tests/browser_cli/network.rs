use super::cli;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio::time::{Duration, sleep, timeout};

fn require(condition: bool, value: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("network observation: {value:?}"))
    }
}

async fn evaluate(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    cli(
        home,
        &[
            "eval",
            resource,
            script,
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    original_page: &str,
    epoch: &str,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let url = format!("http://{address}/start");
    let finished = Arc::new(AtomicUsize::new(0));
    let finished_server = Arc::clone(&finished);
    let server = tokio::spawn(async move {
        let mut responses = JoinSet::new();
        loop {
            tokio::select! {
                socket = listener.accept() => {
                    let Ok((mut socket, _)) = socket else { break; };
                    let finished = Arc::clone(&finished_server);
                    responses.spawn(async move {
                        let mut request = [0; 4096];
                        let _ = socket.read(&mut request).await;
                        let request = String::from_utf8_lossy(&request);
                        let stream = request.starts_with("GET /stream?");
                        let popup = request.starts_with("GET /popup ");
                        let (kind, body) = if stream {
                            ("text/plain", "complete".to_string())
                        } else if request.starts_with("GET /worker.js ") {
                            ("text/javascript", "fetch('/stream?worker').then(r=>r.text()).then(()=>postMessage('worker-finished'))".into())
                        } else if request.starts_with("GET /frame ") {
                            ("text/html", "<!doctype html><script>fetch('/stream?frame').then(r=>r.text()).then(()=>parent.postMessage('frame-finished','*'))</script>".into())
                        } else {
                            ("text/html", "<!doctype html><title>Network tracking</title><script>window.streamDone=false;fetch('/stream?page').then(r=>r.text()).then(()=>window.streamDone=true);window.received=[];addEventListener('message',event=>received.push(event.data))</script>".into())
                        };
                        if popup { sleep(Duration::from_millis(2500)).await; }
                        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = socket.write_all(header.as_bytes()).await;
                        if stream { sleep(Duration::from_millis(2500)).await; }
                        let _ = socket.write_all(body.as_bytes()).await;
                        if stream || popup { finished.fetch_add(1, Ordering::SeqCst); }
                    });
                }
                _ = responses.join_next(), if !responses.is_empty() => {}
            }
        }
    });
    let evidence: Result<_, String> = async {
        let created = cli(home, &["tab-new", resource, &url, "--page", original_page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        let page = created["result"]["observation"]["pages"].as_array().and_then(|pages| pages.iter().find(|page| page["url"] == url)).and_then(|page| page["page"]["page_id"].as_str()).ok_or_else(|| format!("new network page missing: {created}"))?.to_string();
        let first = cli(home, &["network", resource, "--page", &page]).await?;
        require(first["result"]["requests"].as_array().unwrap().iter().any(|request| request["url"] == url && request["resource_type"] == "Document"), &first)?;
        for (case, marker) in [("page", "?page"), ("frame", "?frame"), ("worker", "?worker")] {
            if case == "frame" {
                let frame = format!("http://localhost:{}/frame", address.port());
                evaluate(home, resource, &page, epoch, &format!("document.body.appendChild(Object.assign(document.createElement('iframe'),{{src:{}}}));true", json!(frame))).await?;
            } else if case == "worker" {
                evaluate(home, resource, &page, epoch, "window.worker=new Worker('/worker.js');worker.onmessage=event=>received.push(event.data);true").await?;
            }
            let pending = timeout(Duration::from_secs(2), async {
                loop {
                    let observed = cli(home, &["network", resource, "--page", &page]).await?;
                    if observed["result"]["requests"].as_array().is_some_and(|requests| requests.iter().any(|request| request["url"].as_str().is_some_and(|url| url.ends_with(marker)) && request["status"] == 200 && request["state"] == "pending")) { break Ok::<_, String>(observed); }
                    sleep(Duration::from_millis(20)).await;
                }
            }).await.map_err(|_| format!("{case}: pending body with headers not observed"))??;
            require(pending["result"]["complete"] == true && pending["result"]["idle"] == false, &pending)?;
            let before = cli(home, &["show", resource]).await?;
            let neighbor = cli(home, &["network", resource, "--page", original_page]).await?;
            require(!neighbor["result"]["requests"].as_array().unwrap().iter().any(|request| request["url"].as_str().is_some_and(|url| url.ends_with(marker))), &neighbor)?;
            let after = cli(home, &["show", resource]).await?;
            require(before["result"]["control"] == after["result"]["control"], &after)?;
            let waited = cli(home, &["wait", resource, "load", "networkidle", "--timeout", "5000", "--page", &page]).await;
            let done = cli(home, &["network", resource, "--page", &page]).await?;
            if let Err(error) = waited {
                return Err(format!("{case}: {error}; network={done}"));
            }
            require(done["result"]["complete"] == true && done["result"]["idle"] == true && done["result"]["pending"] == 0, &done)?;
            require(done["result"]["requests"].as_array().unwrap().iter().any(|request| request["url"].as_str().is_some_and(|url| url.ends_with(marker)) && request["state"] == "finished"), &done)?;
            println!("BROWSER_NETWORK_SCOPE_EVIDENCE {}", json!({"case":case,"pending":pending["result"]["pending"],"complete":done["result"]["complete"],"quiet_ms":done["result"]["quiet_ms"],"serverCompletedBodies":finished.load(Ordering::SeqCst)}));
        }
        let page_effects = evaluate(home, resource, &page, epoch, "({streamDone,received})").await?;
        let effects = &page_effects["result"]["response"]["data"]["result"];
        require(effects["streamDone"] == true && effects["received"].as_array().is_some_and(|events| events.contains(&json!("frame-finished")) && events.contains(&json!("worker-finished"))), &page_effects)?;
        evaluate(home, resource, &page, epoch, "worker.terminate();document.querySelector('iframe').remove();true").await?;
        let sources_retired = cli(home, &["network", resource, "--page", &page]).await?;
        println!("BROWSER_NETWORK_SOURCE_RETIREMENT {sources_retired}");
        require(sources_retired["result"]["complete"] == true, &sources_retired)?;
        cli(home, &["wait", resource, "load", "networkidle", "--timeout", "2000", "--page", &page]).await?;
        let before_popup = cli(home, &["show", resource]).await?;
        let popup_url = format!("http://{address}/popup");
        evaluate(home, resource, &page, epoch, &format!("const button=document.body.appendChild(document.createElement('button'));button.id='open-popup';button.textContent='Open popup';button.onclick=()=>window.openedPopup=window.open({});true", json!(popup_url))).await?;
        cli(home, &["click", resource, "#open-popup", "--page", &page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        let opened = evaluate(home, resource, &page, epoch, "({opened:!!window.openedPopup,closed:window.openedPopup?.closed})").await?;
        require(opened["result"]["response"]["data"]["result"]["opened"] == true, &opened)?;
        let popup_page = timeout(Duration::from_secs(2), async {
            loop {
                let observed = cli(home, &["show", resource]).await?;
                if let Some(new_page) = observed["result"]["pages"].as_array().unwrap().iter().find(|candidate| !before_popup["result"]["pages"].as_array().unwrap().iter().any(|previous| previous["page"]["page_id"] == candidate["page"]["page_id"])) {
                    break Ok::<_, String>(new_page["page"]["page_id"].as_str().unwrap().to_string());
                }
                sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_| "popup page not observed".to_string())??;
        cli(home, &["tab-switch", resource, "--page", &popup_page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        let popup_before = cli(home, &["network", resource, "--page", &popup_page]).await?;
        cli(home, &["wait", resource, "load", "networkidle", "--timeout", "7000", "--page", &popup_page]).await?;
        let popup_after = cli(home, &["network", resource, "--page", &popup_page]).await?;
        println!("BROWSER_NETWORK_POPUP_EVIDENCE {}", json!({"before":popup_before,"after":popup_after,"serverCompletedBodies":finished.load(Ordering::SeqCst)}));
        require(finished.load(Ordering::SeqCst) >= 5, &popup_after)?;
        cli(home, &["tab-close", resource, "--page", &popup_page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        cli(home, &["tab-close", resource, "--page", &page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        cli(home, &["tab-switch", resource, "--page", original_page, "--controller", "agent-proof", "--epoch", epoch]).await?;
        let remaining = cli(home, &["network", resource, "--page", original_page]).await?;
        require(remaining["result"]["complete"] == true, &remaining)?;
        Ok(())
    }.await;
    server.abort();
    let _ = server.await;
    evidence
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn network_observation_across_frames_workers_and_popups() {
    let (root, endpoint, server) = super::fixture().await;
    let result: Result<_, String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str()
            .ok_or("resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"]
            .as_str()
            .ok_or("page missing")?;
        let controlled = cli(&root, &["control", resource, "--controller", "agent-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("epoch missing")?;
        exercise(&root, resource, page, epoch).await
    }
    .await;
    println!(
        "BROWSER_NETWORK_FOCUSED_BEFORE_CLOSE root={} result={result:?}",
        root.display()
    );
    let stopped = super::backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    timeout(Duration::from_secs(40), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    println!(
        "BROWSER_NETWORK_FOCUSED root={} result={result:?}",
        root.display()
    );
    assert_eq!(stopped["kind"], "dure.backend.response");
    result.unwrap();
}
