use super::*;
use crate::browser_engine::cdp::BrowserCdp;
use tokio::time::Instant;
mod authority;
mod conditions;
mod console;
mod consumers;
mod deadlines;
mod faults;
mod function;
mod function_budget;
mod har;
mod headers;
mod history;
mod interception;
mod lifetime;
mod native;
mod navigation;
mod observations;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn a_dialog_response_can_complete_the_input_that_opened_it() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-dialog-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = identity("dialog:input");
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>window.answer=prompt('Dialog fixture','original');true"})).await?;
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let observer_session = observer.attach(target.as_str()).await?;
        observer.retain_events().await;
        observer.request("Page.enable",json!({}),Some(&observer_session)).await?;
        let mut response_connection = runtime.test_binding().cdp.clone();
        let response_session = response_connection.attach(target.as_str()).await?;
        response_connection.request("Page.enable",json!({}),Some(&response_session)).await?;
        let action_authority = authority(&runtime,&lease,&page).await;
        let click = serde_json::from_value(json!({"kind":"click","target":{"kind":"css","selector":"#ask"}})).unwrap();
        let started = Instant::now();
        let (clicked, dialog) = tokio::join!(
            runtime.action(&lease.controller_id,&action_authority,click),
            async {
                let opened = timeout(Duration::from_secs(8),async {
                    loop {
                        let event = observer.next_event().await?;
                        if event["method"] == "Page.javascriptDialogOpening" { return Ok::<_, &'static str>(event); }
                    }
                }).await;
                let before = runtime.control().await;
                let answered = timeout(Duration::from_secs(2),response_connection.request("Page.handleJavaScriptDialog",json!({"accept":true,"promptText":"한글 응답"}),Some(&response_session))).await;
                // The independent fixture connection is cleanup only. Record
                // a failed product response before dismissing the blocked page.
                let cleanup = if !matches!(answered,Ok(Ok(_))) {
                    Some(observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&observer_session)).await)
                } else { None };
                (opened,before,answered,cleanup)
            }
        );
        let elapsed = started.elapsed();
        let phase = runtime.control().await;
        let actual = observer.request("Runtime.evaluate",json!({"expression":"window.answer","returnByValue":true}),Some(&observer_session)).await;
        observer.retire().await;
        Ok((clicked,dialog,elapsed,phase,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_INPUT root={} evidence={result:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (clicked, (opened, before, answered, cleanup), _, phase, actual) = result.unwrap();
    assert!(matches!(opened, Ok(Ok(_))), "{opened:?}");
    assert!(before.in_flight.is_some(), "{before:?}");
    assert!(
        matches!(answered, Ok(Ok(_))),
        "dialog response was blocked by its own triggering input: {answered:?}; cleanup={cleanup:?}"
    );
    assert!(clicked.is_ok(), "{clicked:?}");
    assert_eq!(phase.phase, BrowserResourcePhase::Ready);
    assert_eq!(actual.unwrap()["result"]["value"], "한글 응답");
}
