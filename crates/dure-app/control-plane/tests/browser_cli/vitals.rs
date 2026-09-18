use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

async fn site() -> (
    String,
    Arc<AtomicUsize>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&requests);
    let (http_stop, mut http_stopped) = oneshot::channel();
    let http = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = &mut http_stopped => break,
            };
            let (mut socket, _) = accepted.unwrap();
            let mut request = [0; 8192];
            let count = socket.read(&mut request).await.unwrap();
            println!(
                "BROWSER_VITALS_HTTP address={} bytes={count} line={:?}",
                socket.local_addr().unwrap(),
                String::from_utf8_lossy(&request[..count]).lines().next()
            );
            if count == 0 {
                continue;
            }
            if !String::from_utf8_lossy(&request[..count]).contains("favicon") {
                observed.fetch_add(1, Ordering::SeqCst);
            }
            let body = r#"<!doctype html><link rel=icon href=data:,><h1>Measured page 한글</h1><script>
sessionStorage.loads=Number(sessionStorage.loads||0)+1;
console.timeStamp('Hydrated',10,25,'Main','Scheduler ⚛','primary');
console.timeStamp('Short',11,13,'Components ⚛','Components','tertiary-light');
console.timeStamp('Long',14,24,'Components ⚛','Components','tertiary');
</script>"#;
            let body = if String::from_utf8_lossy(&request[..count]).starts_with("GET /depart ") {
                format!("{body}<script>setTimeout(()=>location.replace('/foreign'),200)</script>")
            } else {
                body.to_owned()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (origin, requests, http_stop, http)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn real_cli_measures_reload_and_url_without_reloading_its_peer() {
    let (origin, requests, http_stop, http) = site().await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let mut owned = Vec::new();
        for (index, name) in ["vitals-owner", "vitals-peer"].iter().enumerate() {
            let created = cli(&root, &["create", "--idempotency-key", name]).await?;
            let id = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
            resources.push(id.clone());
            let controlled = cli(&root, &["control", &id, "--controller", name]).await?;
            let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?.to_owned();
            let url = format!("{origin}/{index}");
            cli(&root, &["goto", &id, &url, "--controller", name, "--epoch", &epoch]).await?;
            owned.push((id, epoch));
        }
        let (resource, epoch) = &owned[0];
        let authority = ["--controller", "vitals-owner", "--epoch", epoch];
        let before = cli(&root, &["show", resource]).await?;
        let mut args = vec!["exec", resource, "--command", "web-vitals --json", "--idempotency-key", "vitals-reload"]; args.extend(authority);
        let reloaded = cli(&root, &args).await?;
        let reload_data = reloaded["result"]["response"]["data"].clone();
        let after = cli(&root, &["show", resource]).await?;
        let destination = format!("{origin}/destination");
        let mut args = vec!["vitals", resource, &destination, "--idempotency-key", "vitals-url"]; args.extend(authority);
        let navigated = cli(&root, &args).await?;
        let mut args = vec!["eval", resource, "Number(sessionStorage.loads)"]; args.extend(authority);
        let loads = cli(&root, &args).await?;
        let (peer, peer_epoch) = &owned[1];
        let peer = cli(&root, &["eval", peer, "({loads:Number(sessionStorage.loads),installed:!!window.__AB_VITALS_INSTALLED__})", "--controller", "vitals-peer", "--epoch", peer_epoch]).await?;
        let receipt = cli(&root, &["receipt", "vitals-reload"]).await?;
        Ok(json!({"reload":reload_data,"navigated":navigated["result"]["response"]["data"],"destination":destination,"ownerLoads":loads["result"]["response"]["data"]["result"],"peer":peer["result"]["response"]["data"]["result"],"samePage":before["result"]["control"]["current_page"]["page_id"]==after["result"]["control"]["current_page"]["page_id"],"newDocument":before["result"]["control"]["current_page"]["document_revision"]!=after["result"]["control"]["current_page"]["document_revision"],"receipt":receipt["receipt"]["state"]}))
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
    let _ = http_stop.send(());
    http.await.unwrap();
    println!(
        "BROWSER_VITALS_REAL_CLI root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?} requests={}",
        root.display(),
        requests.load(Ordering::SeqCst)
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    assert_eq!(evidence["ownerLoads"], 3);
    assert_eq!(evidence["peer"], json!({"loads":1,"installed":false}));
    assert_eq!(evidence["samePage"], true);
    assert_eq!(evidence["newDocument"], true);
    assert_eq!(evidence["receipt"], "succeeded");
    assert_eq!(evidence["navigated"]["url"], evidence["destination"]);
    for data in [&evidence["reload"], &evidence["navigated"]] {
        assert!(data["ttfb"].as_f64().is_some_and(|v| v >= 0.0));
        assert!(data["fcp"].as_f64().is_some_and(|v| v > 0.0));
        assert!(data["lcp"]["startTime"].as_f64().is_some_and(|v| v > 0.0));
        assert_eq!(data["cls"]["score"], 0.0);
        assert!(data["inp"].is_null());
        assert_eq!(
            data["hydration"],
            json!({"startTime":10,"endTime":25,"duration":15})
        );
        assert_eq!(data["phases"][0]["label"], "Hydrated");
        assert_eq!(data["hydratedComponents"][0]["name"], "Long");
        assert_eq!(data["hydratedComponents"][1]["name"], "Short");
        assert!(
            data["report"]
                .as_str()
                .is_some_and(|s| s.contains("LCP") && s.contains("Hydrated"))
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn disconnected_measurement_finishes_once_and_foreign_navigation_cannot_supply_metrics() {
    let (origin, requests, http_stop, http) = site().await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--idempotency-key", "vitals-fault-create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
        resources.push(resource.clone());
        let controlled = cli(&root, &["control", &resource, "--controller", "vitals-owner"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let authority = ["--controller", "vitals-owner", "--epoch", epoch];
        let mut args = vec!["goto", &resource, &origin]; args.extend(authority); cli(&root, &args).await?;
        let shown = cli(&root, &["show", &resource]).await?;
        let control = &shown["result"]["control"];
        let body = json!({"kind":"action","caller":"vitals-owner",
            "authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"vitals-lost","command_sequence":control["next_command_sequence"]},
            "action":{"kind":"vitals"}});
        let request = envelope(&endpoint, "browser.resource", body.clone());
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
        socket.write_all(format!("{request}\n").as_bytes()).await.map_err(|e|e.to_string())?;
        drop(socket);
        let receipt = timeout(Duration::from_secs(20), async {
            loop {
                let receipt = cli(&root, &["receipt", "vitals-lost"]).await?;
                if ["succeeded", "failed"].iter().any(|s|receipt["receipt"]["state"]==*s) { return Ok::<_,String>(receipt); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_|"measurement receipt timeout")??;
        let before_replay = requests.load(Ordering::SeqCst);
        let replay = backend(&endpoint, "browser.resource", body).await;
        let after_replay = requests.load(Ordering::SeqCst);
        let shown = cli(&root, &["show", &resource]).await?;
        let control = &shown["result"]["control"];
        let mut stale = json!({"kind":"action","caller":"foreign","authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"vitals-denied","command_sequence":control["next_command_sequence"]},"action":{"kind":"vitals"}});
        stale["authority"]["lease"]["controller_id"] = json!("foreign");
        let denied = backend(&endpoint, "browser.resource", stale).await;
        let after_denied = requests.load(Ordering::SeqCst);
        let depart = format!("{origin}/depart");
        let mut args = vec!["vitals", &resource, &depart, "--idempotency-key", "vitals-depart"];args.extend(authority);
        let departed = cli(&root, &args).await;
        // The generic CLI helper deliberately rejects failed operations. Read
        // the retained failed receipt through its backend envelope instead.
        let final_receipt = backend(&endpoint, "browser.resource", json!({"kind":"receipt","operation_id":"vitals-depart"})).await["result"].clone();
        Ok(json!({"receipt":receipt,"replay":replay,"beforeReplay":before_replay,"afterReplay":after_replay,"afterDenied":after_denied,"denied":denied,"departed":format!("{departed:?}"),"departureRejected":departed.is_err(),"finalReceipt":final_receipt}))
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
    let _ = http_stop.send(());
    http.await.unwrap();
    println!(
        "BROWSER_VITALS_FAULTS root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["receipt"]["receipt"]["state"], "succeeded");
    assert_eq!(evidence["replay"]["result"]["replayed"], true);
    assert_eq!(evidence["beforeReplay"], 2);
    assert_eq!(evidence["afterReplay"], evidence["beforeReplay"]);
    assert_eq!(evidence["afterDenied"], evidence["beforeReplay"]);
    assert_eq!(
        evidence["denied"]["error"]["code"],
        "browser_controller_changed"
    );
    assert_eq!(evidence["departureRejected"], true);
    assert_eq!(evidence["finalReceipt"]["receipt"]["state"], "failed");
    assert_eq!(
        evidence["finalReceipt"]["error"]["code"],
        "browser_document_changed"
    );
    assert!(evidence["finalReceipt"]["result"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn measurement_registration_is_removed_after_same_document_reload_and_rejected_navigation() {
    let (origin, requests, http_stop, http) = site().await;
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str().ok_or("resource missing")?.to_owned();
        resources.push(resource.clone());
        let controlled = cli(&root, &["control", &resource, "--controller", "vitals-owner"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let authority = ["--controller", "vitals-owner", "--epoch", epoch];
        let mut args = vec!["init-script", &resource, "add", "window.userInit='preserved';"];
        args.extend(authority);
        cli(&root, &args).await?;
        let current = format!("{origin}/current");
        let mut args = vec!["goto", &resource, &current]; args.extend(authority);
        cli(&root, &args).await?;
        let before = cli(&root, &["show", &resource]).await?;
        let fragment = format!("{current}#measured");
        let mut args = vec!["vitals", &resource, &fragment]; args.extend(authority);
        let same_document = cli(&root, &args).await?;
        let after = cli(&root, &["show", &resource]).await?;
        let mut cases = Vec::new();
        for route in ["after-same", "after-reload", "after-failure"] {
            let measurement = match route {
                "after-reload" => {
                    let mut args = vec!["vitals", &resource]; args.extend(authority);
                    Some(cli(&root, &args).await?)
                }
                "after-failure" => {
                    // Chromium rejects its restricted port without depending
                    // on a race to reuse an unbound local fixture port.
                    let mut args = vec!["vitals", &resource, "http://127.0.0.1:1/rejected", "--idempotency-key", "vitals-rejected-navigation"];
                    args.extend(authority);
                    let rejected = cli(&root, &args).await;
                    let receipt = backend(&endpoint, "browser.resource", json!({"kind":"receipt","operation_id":"vitals-rejected-navigation"})).await;
                    Some(json!({"rejected":rejected.is_err(),"receipt":receipt["result"]}))
                }
                _ => None,
            };
            let url = format!("{origin}/{route}");
            let mut args = vec!["goto", &resource, &url]; args.extend(authority);
            cli(&root, &args).await?;
            let mut args = vec!["eval", &resource, "({installed:!!window.__AB_VITALS_INSTALLED__,userInit:window.userInit,loads:Number(sessionStorage.loads)})"];
            args.extend(authority);
            let observed = cli(&root, &args).await?;
            cases.push(json!({"route":route,"measurement":measurement,"observed":observed["result"]["response"]["data"]["result"]}));
        }
        Ok(json!({"sameDocument":before["result"]["control"]["current_page"]==after["result"]["control"]["current_page"],"sameDocumentUrl":same_document["result"]["response"]["data"]["url"],"fragment":fragment,"cases":cases}))
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
    let _ = http_stop.send(());
    http.await.unwrap();
    println!(
        "BROWSER_VITALS_CLEANUP root={} evidence={evidence:?} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["sameDocument"], true);
    assert_eq!(evidence["sameDocumentUrl"], evidence["fragment"]);
    assert_eq!(requests.load(Ordering::SeqCst), 5);
    for (index, loads) in [2, 4, 5].into_iter().enumerate() {
        assert_eq!(
            evidence["cases"][index]["observed"],
            json!({"installed":false,"userInit":"preserved","loads":loads})
        );
    }
    let failed = &evidence["cases"][2]["measurement"];
    assert_eq!(failed["rejected"], true);
    assert_eq!(failed["receipt"]["receipt"]["state"], "failed");
    assert!(
        failed["receipt"]["result"]["response"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("ERR_UNSAFE_PORT"))
    );
}
