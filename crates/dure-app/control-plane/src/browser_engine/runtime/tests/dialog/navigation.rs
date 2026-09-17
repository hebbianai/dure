use super::*;
use std::sync::Arc;
use tokio::sync::Notify;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn navigation_waits_for_load_and_preserves_same_document_and_new_page_behavior() {
    navigate(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn navigation_retains_its_whole_active_budget_when_load_never_finishes() {
    navigate(true).await;
}

async fn navigate(stall: bool) {
    let (runtime, identity, root) = super::authority::launch("navigation:load").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/document", listener.local_addr().unwrap());
    let pending = Arc::new(Notify::new());
    let requested = Arc::clone(&pending);
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let mut socket = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((socket, _)) => socket,
                    Err(_) => break,
                },
                _ = &mut stopped => break,
            };
            let requested = Arc::clone(&requested);
            connections.spawn(async move {
                let mut request = [0; 4096];
                let read = socket.read(&mut request).await.unwrap_or(0);
                let script = request[..read].starts_with(b"GET /load.js ");
                let body = if script {
                    requested.notify_one();
                    if stall {
                        std::future::pending::<()>().await;
                    }
                    sleep(Duration::from_millis(700)).await;
                    "document.title='Loaded document';window.loaded=true;"
                } else {
                    "<title>Pending document</title><script src=/load.js></script>"
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",if script {"text/javascript"} else {"text/html"},body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
        connections.shutdown().await;
    });
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        let original_target = runtime.host.lock().await.target_for(&page)?.clone();
        let started = Instant::now();
        let action = serde_json::from_value(json!({"kind":"navigate","url":url})).unwrap();
        let command = authority(&runtime, &lease, &page).await;
        let (result, request) = tokio::join!(
            runtime.action(&lease.controller_id, &command, action),
            timeout(Duration::from_secs(3), pending.notified())
        );
        let elapsed = started.elapsed();
        if request.is_err() {
            return Err("fixture_navigation_not_requested".into());
        }
        if stall {
            return Ok((elapsed, result, None));
        }
        let current = first_page(&runtime).await?;
        let fragment = apply(
            &runtime,
            &lease,
            &current,
            json!({"kind":"navigate","url":format!("{url}#section")}),
        )
        .await?;
        let fragment_page = first_page(&runtime).await?;
        let new = apply(
            &runtime,
            &lease,
            &fragment_page,
            json!({"kind":"new_page","url":url}),
        )
        .await?;
        let pages = runtime.observe().await?.pages;
        let original = runtime
            .host
            .lock()
            .await
            .target_for(&fragment_page)?
            .clone();
        Ok((
            elapsed,
            result,
            Some((
                current,
                fragment_page,
                fragment,
                new,
                pages,
                original_target,
                original,
            )),
        ))
    }
    .await;
    let retired = runtime.close(&identity).await;
    let _ = stop.send(());
    let _ = server.await;
    println!(
        "BROWSER_NAVIGATION_LOAD stall={stall} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (elapsed, result, normal) = evidence.unwrap();
    if stall {
        assert!(matches!(result, Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown));
        assert!(
            elapsed >= Duration::from_secs(19) && elapsed < Duration::from_secs(24),
            "{elapsed:?}"
        );
    } else {
        let response = result.unwrap().response;
        assert!(response.success, "{response:?}");
        assert_eq!(response.data["title"], "Loaded document");
        assert!(elapsed >= Duration::from_millis(700), "{elapsed:?}");
        let (current, fragment_page, fragment, new, pages, target, original) = normal.unwrap();
        assert_eq!(fragment_page, current);
        assert_eq!(fragment["url"], format!("{url}#section"));
        assert_eq!(new["navigation"]["title"], "Loaded document");
        assert_eq!(pages.len(), 2);
        assert_eq!(original, target);
        assert_ne!(new["targetId"], json!(target));
    }
}
