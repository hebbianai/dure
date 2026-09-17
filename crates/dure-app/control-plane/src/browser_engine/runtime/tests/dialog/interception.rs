use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn interception_loss_reports_unavailability_and_cannot_reapply_rules() {
    let (runtime, identity, root) = super::authority::launch("interception:loss").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let rule = json!({"kind":"interception","action":{"kind":"enable","rule":{"patterns":["*/blocked"],"effect":{"kind":"abort"}}}});
        let enabled = runtime.action(&lease.controller_id, &authority(&runtime,&lease,&page).await, serde_json::from_value(rule.clone()).unwrap()).await?;
        let before = runtime.interception_state(&identity, &page.page_id).await?;
        runtime.test_binding().events.close().await;
        let lost = runtime.interception_state(&identity, &page.page_id).await?;
        let rejected = runtime.action(&lease.controller_id, &authority(&runtime,&lease,&page).await, serde_json::from_value(rule).unwrap()).await;
        let after = runtime.interception_state(&identity, &page.page_id).await?;
        Ok((enabled, before, lost, rejected, after))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_INTERCEPTION_LOSS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok());
    let (enabled, before, lost, rejected, after) = evidence.unwrap();
    assert!(enabled.response.success && before.enabled && before.available);
    assert!(lost.enabled && !lost.available && after.enabled && !after.available);
    assert_eq!(
        serde_json::to_value(lost.rules).unwrap(),
        serde_json::to_value(after.rules).unwrap()
    );
    assert!(matches!(rejected, Err(BrowserRuntimeError::Observation(_))));
}
#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn interception_enable_and_disable_finish_while_a_human_prompt_stays_open() {
    let (runtime, identity, root) = super::authority::launch("interception:prompt").await;
    println!("BROWSER_INTERCEPTION_PROMPT_OWNED root={}", root.display());
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target=runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint=runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer=BrowserCdp::connect(&endpoint).await?;
        let session=observer.attach(target.as_str()).await?;
        let observations:Result<_,BrowserRuntimeError>=async {
            observer.request("Page.enable",json!({}),Some(&session)).await?;
            observer.request("Runtime.evaluate",json!({"expression":"window.answers=0;setTimeout(()=>{window.answer=prompt('Interception human wait');answers++},0);true","returnByValue":true}),Some(&session)).await?;
            let opened=super::authority::pending(&runtime,&page).await?;
            let before=runtime.control().await;
            let started=Instant::now();
            let state=timeout(Duration::from_secs(2),runtime.interception_state(&identity,&page.page_id)).await;
            let after=runtime.control().await;
            let begin=timeout(Duration::from_secs(2),runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"interception","action":{"kind":"enable","rule":{"patterns":["*"],"effect":{"kind":"abort"}}}})).unwrap())).await;
            let recording=timeout(Duration::from_secs(2),runtime.interception_state(&identity,&page.page_id)).await;
            let stopped=timeout(Duration::from_secs(2),runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"interception","action":{"kind":"disable"}})).unwrap())).await;
            let still_open=runtime.dialog(&page.page_id).await;
            let elapsed=started.elapsed();
            let answered=runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&opened.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"한글 규칙"})).unwrap()).await;
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
        "BROWSER_INTERCEPTION_PROMPT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (observations, actual) = evidence.unwrap();
    let (state, before, after, begin, recording, stopped, still_open, elapsed, answered) =
        observations.unwrap();
    assert!(!state.unwrap().unwrap().enabled);
    assert_eq!(before, after);
    let begin = begin.unwrap().unwrap();
    assert!(begin.response.success && begin.observation.is_none());
    assert!(recording.unwrap().unwrap().enabled);
    let stopped = stopped.unwrap().unwrap();
    assert!(stopped.response.success && stopped.observation.is_none());
    assert_eq!(stopped.response.data["enabled"], false);
    assert!(still_open.unwrap().dialog.is_some());
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    answered.unwrap();
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answers":1,"answer":"한글 규칙"})
    );
}
