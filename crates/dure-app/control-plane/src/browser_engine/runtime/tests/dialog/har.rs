use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

fn document(result: &super::super::super::BrowserActionResult) -> Value {
    let bytes = STANDARD
        .decode(
            result.response.data["artifact_payload"]["base64"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn capture_status_start_and_stop_finish_while_a_human_prompt_stays_open() {
    let (runtime, identity, root) = super::authority::launch("har:prompt").await;
    println!("BROWSER_HAR_PROMPT_OWNED root={}", root.display());
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target=runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint=runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer=BrowserCdp::connect(&endpoint).await?;
        let session=observer.attach(target.as_str()).await?;
        let observations:Result<_,BrowserRuntimeError>=async {
            observer.request("Page.enable",json!({}),Some(&session)).await?;
            observer.request("Runtime.evaluate",json!({"expression":"window.answers=0;setTimeout(()=>{window.answer=prompt('HAR human wait');answers++},0);true","returnByValue":true}),Some(&session)).await?;
            let opened=super::authority::pending(&runtime,&page).await?;
            let before=runtime.control().await;
            let started=Instant::now();
            let state=timeout(Duration::from_secs(2),runtime.network_capture_state(&identity,&page.page_id)).await;
            let after=runtime.control().await;
            let begin=timeout(Duration::from_secs(2),runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"network_capture","action":"start"})).unwrap())).await;
            let recording=timeout(Duration::from_secs(2),runtime.network_capture_state(&identity,&page.page_id)).await;
            let stopped=timeout(Duration::from_secs(2),runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"network_capture","action":"stop"})).unwrap())).await;
            let still_open=runtime.dialog(&page.page_id).await;
            let elapsed=started.elapsed();
            let answered=runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&opened.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"한글 HAR"})).unwrap()).await;
            Ok((state,before,after,begin,recording,stopped,still_open,elapsed,answered))
        }.await;
        // Keep the exact product result before any fixture-only dismissal.
        if observations.as_ref().map_or(true, |value|value.8.is_err()) { let _=observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await; }
        let actual=observer.request("Runtime.evaluate",json!({"expression":"({answers,answer})","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        Ok((observations,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_HAR_PROMPT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (observations, actual) = evidence.unwrap();
    let (state, before, after, begin, recording, stopped, still_open, elapsed, answered) =
        observations.unwrap();
    assert!(!state.unwrap().unwrap().recording);
    assert_eq!(before, after);
    let begin = begin.unwrap().unwrap();
    assert!(begin.response.success && begin.observation.is_none());
    assert!(recording.unwrap().unwrap().recording);
    let stopped = stopped.unwrap().unwrap();
    assert!(stopped.response.success && stopped.observation.is_none());
    let har = document(&stopped);
    assert_eq!(har["log"]["version"], "1.2");
    assert_eq!(har["log"]["entries"], json!([]));
    assert!(still_open.unwrap().dialog.is_some());
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    answered.unwrap();
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answers":1,"answer":"한글 HAR"})
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_event_observation_still_exports_retained_history_as_incomplete() {
    let (runtime, identity, root) = super::authority::launch("har:observation-loss").await;
    println!("BROWSER_HAR_LOSS_OWNED root={}", root.display());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/retained-har", listener.local_addr().unwrap());
    let (stop_http, mut stop) = tokio::sync::oneshot::channel::<()>();
    let http = tokio::spawn(async move {
        loop {
            tokio::select! {
                _=&mut stop => break,
                accepted=listener.accept() => {
                    let Ok((mut socket,_))=accepted else {break};
                    let _=timeout(Duration::from_secs(2),async {
                        use tokio::io::{AsyncReadExt,AsyncWriteExt};
                        let mut request=[0;4096];
                        let mut received=0;
                        while !request[..received].windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            if received == request.len() {
                                return Err(std::io::Error::other("fixture request headers exceed limit"));
                            }
                            let count=socket.read(&mut request[received..]).await?;
                            if count == 0 { return Ok(()); }
                            received += count;
                        }
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 44\r\nConnection: close\r\n\r\n<!doctype html><title>Retained HAR</title>OK").await?;
                        socket.shutdown().await
                    }).await;
                }
            }
        }
    });
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        let begin = runtime
            .action(
                &lease.controller_id,
                &authority(&runtime, &lease, &page).await,
                serde_json::from_value(json!({"kind":"network_capture","action":"start"})).unwrap(),
            )
            .await?;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"navigate","url":url}),
        )
        .await?;
        let page = first_page(&runtime).await?;
        let recorded = runtime
            .network_capture_state(&identity, &page.page_id)
            .await?;
        if recorded.recorded == 0 {
            return Err("fixture_har_history_missing".into());
        }
        runtime.test_binding().events.close().await;
        let state = runtime
            .network_capture_state(&identity, &page.page_id)
            .await;
        let stopped = runtime
            .action(
                &lease.controller_id,
                &authority(&runtime, &lease, &page).await,
                serde_json::from_value(json!({"kind":"network_capture","action":"stop"})).unwrap(),
            )
            .await;
        Ok((begin, state, stopped))
    }
    .await;
    let retired = runtime.close(&identity).await;
    let _ = stop_http.send(());
    let http_retired = timeout(Duration::from_secs(4), http).await;
    println!(
        "BROWSER_HAR_LOSS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    http_retired.unwrap().unwrap();
    let (begin, state, stopped) = evidence.unwrap();
    assert!(begin.response.success);
    let state = state.unwrap();
    assert!(state.recording && !state.complete);
    let stopped = stopped.unwrap();
    assert!(stopped.response.success);
    let har = document(&stopped);
    assert_eq!(har["log"]["_dure"]["complete"], false);
    assert!(
        har["log"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["request"]["url"] == url)
    );
}
