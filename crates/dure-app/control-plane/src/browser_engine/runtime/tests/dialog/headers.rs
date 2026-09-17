use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn request_headers_finish_during_human_prompt_and_loss_rejects_replacement() {
    let (runtime, identity, root) = super::authority::launch("headers:prompt-loss").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        let operations: Result<_, BrowserRuntimeError> = async {
            observer.request("Page.enable",json!({}),Some(&session)).await?;
            observer.request("Runtime.evaluate",json!({"expression":"window.answers=0;setTimeout(()=>{window.answer=prompt('Headers human wait');answers++},0);true","returnByValue":true}),Some(&session)).await?;
            let opened = super::authority::pending(&runtime,&page).await?;
            let action = json!({"kind":"environment","action":{"kind":"headers","headers":{"authorization":"Basic ZHVyZTpmaXh0dXJl"}}});
            let started = Instant::now();
            let configured = timeout(Duration::from_secs(2), runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(action).unwrap())).await;
            let elapsed = started.elapsed();
            let pending = runtime.dialog(&page.page_id).await?;
            let answered = runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&opened.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"한글 인증"})).unwrap()).await;
            Ok((configured,elapsed,pending,answered))
        }.await;
        if operations.as_ref().map_or(true,|value|value.3.is_err()) { let _ = observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await; }
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({answers,answer})","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        let before = runtime.host.lock().await.request_headers(&target).cloned();
        runtime.test_binding().events.close().await;
        let rejected = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"environment","action":{"kind":"headers","headers":{}}})).unwrap()).await;
        let unchanged = runtime.host.lock().await.request_headers(&target).cloned() == before;
        Ok((operations,actual,rejected,unchanged))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_HEADERS_PROMPT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok());
    let (operations, actual, rejected, unchanged) = evidence.unwrap();
    let (configured, elapsed, pending, answered) = operations.unwrap();
    let configured = configured.unwrap().unwrap();
    assert!(configured.response.success && configured.observation.is_none());
    assert_eq!(configured.response.data, json!({"applied":true}));
    assert!(elapsed < Duration::from_secs(2));
    assert!(pending.dialog.is_some());
    answered.unwrap();
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answers":1,"answer":"한글 인증"})
    );
    assert!(matches!(rejected, Err(BrowserRuntimeError::Observation(_))));
    assert!(unchanged);
}
