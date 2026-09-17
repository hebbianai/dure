use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn history_observes_main_frame_load_same_document_and_missing_entries() {
    exercise(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn reload_keeps_its_active_deadline_when_main_frame_load_stalls() {
    exercise(true).await;
}

async fn exercise(stall: bool) {
    let (runtime, identity, root) = super::authority::launch("history:completion").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hung = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicU64::new(0));
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let server = {
        let hung = Arc::clone(&hung);
        let requests = Arc::clone(&requests);
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let mut socket = tokio::select! {
                    accepted = listener.accept() => match accepted { Ok((socket, _)) => socket, Err(_) => break },
                    _ = &mut stopped => break,
                };
                let hung = Arc::clone(&hung);
                let requests = Arc::clone(&requests);
                connections.spawn(async move {
                    let mut request = [0; 4096];
                    let read = socket.read(&mut request).await.unwrap_or(0);
                    let script = request[..read].starts_with(b"GET /load.js ");
                    let child = request[..read].starts_with(b"GET /child ");
                    let body = if script {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if hung.load(Ordering::SeqCst) { std::future::pending::<()>().await; }
                        sleep(Duration::from_millis(700)).await;
                        "window.loaded=true;document.title='Loaded history';"
                    } else if child {
                        "<title>Fast child</title>"
                    } else {
                        "<title>Pending history</title><script>addEventListener('pageshow',e=>window.restored=e.persisted)</script><iframe src=/child></iframe><script src=/load.js></script>"
                    };
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",if script {"text/javascript"} else {"text/html"},body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
            connections.shutdown().await;
        })
    };
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let initial = first_page(&runtime).await?;
        let empty = apply(&runtime,&lease,&initial,json!({"kind":"back"})).await?;
        if empty["url"] != "about:blank" || first_page(&runtime).await? != initial { return Err("fixture_empty_history_changed".into()); }
        for route in ["first", "second"] {
            apply(&runtime,&lease,&first_page(&runtime).await?,json!({"kind":"navigate","url":format!("{base}/{route}")})).await?;
        }
        if stall {
            hung.store(true, Ordering::SeqCst);
            let before = requests.load(Ordering::SeqCst);
            let page = first_page(&runtime).await?;
            let command = authority(&runtime,&lease,&page).await;
            let started = Instant::now();
            let result = runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"reload"})).unwrap()).await;
            return Ok((Some((started.elapsed(),result,requests.load(Ordering::SeqCst)-before)),Vec::new()));
        }
        let page = first_page(&runtime).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        let cases: Result<Vec<_>, BrowserRuntimeError> = async {
            let mut cases = Vec::new();
            for (kind,route) in [("back","first"),("forward","second"),("reload","second")] {
                let page = first_page(&runtime).await?;
                let before = requests.load(Ordering::SeqCst);
                let started = Instant::now();
                let result = apply(&runtime,&lease,&page,json!({"kind":kind})).await?;
                let elapsed = started.elapsed();
                let actual = observer.request("Runtime.evaluate",json!({"expression":"({url:location.href,loaded:window.loaded,restored:window.restored})","returnByValue":true}),Some(&session)).await?;
                let actual = &actual["result"]["value"];
                let fetched = requests.load(Ordering::SeqCst)-before;
                cases.push(json!({"kind":kind,"url":result["url"],"actual":actual,"fetched":fetched,"elapsed_ms":elapsed.as_millis()}));
                if result["url"] != format!("{base}/{route}") || result["url"] != actual["url"] || actual["loaded"] != true { return Err("fixture_history_returned_before_load".into()); }
                if fetched > 0 {
                    if elapsed < Duration::from_millis(700) { return Err("fixture_history_accepted_child_load".into()); }
                } else if kind == "reload" || actual["restored"] != true { return Err("fixture_history_completion_missing".into()); }
            }
            let document = first_page(&runtime).await?;
            for fragment in ["one", "two"] {
                apply(&runtime,&lease,&document,json!({"kind":"navigate","url":format!("{base}/second#{fragment}")})).await?;
            }
            for (kind,fragment) in [("back","one"),("forward","two"),("forward","two")] {
                let result = apply(&runtime,&lease,&document,json!({"kind":kind})).await?;
                if result["url"] != format!("{base}/second#{fragment}") || first_page(&runtime).await? != document { return Err("fixture_same_document_history_changed".into()); }
                cases.push(json!({"kind":kind,"fragment":fragment,"result":result}));
            }
            Ok(cases)
        }.await;
        observer.retire().await;
        Ok((None,cases?))
    }.await;
    let retired = runtime.close(&identity).await;
    let _ = stop.send(());
    let _ = server.await;
    println!(
        "BROWSER_HISTORY_COMPLETION stall={stall} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (hung, cases) = evidence.unwrap();
    if let Some((elapsed, result, requested)) = hung {
        assert!(matches!(result,Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown));
        assert!(
            elapsed >= Duration::from_secs(19) && elapsed < Duration::from_secs(24),
            "{elapsed:?}"
        );
        assert_eq!(requested, 1);
    } else {
        assert_eq!(cases.len(), 6);
    }
}
