use super::*;
use hmux_session_protocol::browser_dialog::BrowserDialogResponse;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn click_prompt_survives_human_response_time() {
    exercise("click", Duration::from_secs(6)).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn key_prompt_survives_human_response_time() {
    exercise("key", Duration::from_secs(6)).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn evaluation_prompt_survives_the_native_engine_deadline() {
    exercise("evaluate", Duration::from_secs(32)).await;
}

async fn exercise(kind: &str, human_wait: Duration) {
    let (runtime, identity, root) = super::authority::launch("dialog:human-wait").await;
    println!(
        "BROWSER_DIALOG_LIFETIME_START kind={kind} root={}",
        root.display()
    );
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=ask>Ask</button>';window.count=0;window.ask=()=>{count++;window.answer=prompt('Human wait','original')};document.querySelector('#ask').onclick=ask;document.onkeydown=ask;true"})).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        let command = authority(&runtime, &lease, &page).await;
        let action = match kind {
            "click" => json!({"kind":"click","target":{"kind":"css","selector":"#ask"}}),
            "key" => json!({"kind":"key_down","key":"a"}),
            _ => json!({"kind":"evaluate","script":"ask();answer"}),
        };
        let started = Instant::now();
        let (triggered, response) = tokio::join!(
            runtime.action(&lease.controller_id, &command, serde_json::from_value(action).unwrap()),
            async {
                let first = super::authority::pending(&runtime, &page).await?;
                sleep(human_wait).await;
                let after = runtime.dialog(&page.page_id).await;
                let answered = match &after {
                    Ok(observed) => match &observed.dialog {
                        Some(dialog) => runtime.respond_dialog(
                            &lease.controller_id,
                            &authority(&runtime, &lease, &page).await,
                            &dialog.identity,
                            serde_json::from_value::<BrowserDialogResponse>(json!({"kind":"accept","text":"오래 기다린 응답"})).unwrap(),
                        ).await,
                        None => Err(BrowserRuntimeError::Observation("fixture_dialog_disappeared")),
                    },
                    Err(_) => Err(BrowserRuntimeError::Observation("fixture_dialog_unobservable")),
                };
                let cleanup = if answered.is_err() {
                    Some(observer.request("Page.handleJavaScriptDialog", json!({"accept":false}), Some(&session)).await)
                } else { None };
                Ok::<_, BrowserRuntimeError>((first, after, answered, cleanup))
            }
        );
        let actual = observer.request("Runtime.evaluate", json!({"expression":"({answer,count})","returnByValue":true}), Some(&session)).await;
        observer.retire().await;
        Ok((page, command, started.elapsed(), triggered, response, actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_LIFETIME kind={kind} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (page, command, elapsed, triggered, response, actual) = evidence.unwrap();
    let (first, after, answered, cleanup) = response.unwrap();
    let after = after.unwrap();
    assert!(elapsed >= human_wait);
    assert_eq!(after.page, page);
    assert_eq!(after.dialog, first.dialog);
    assert_eq!(after.control.phase, BrowserResourcePhase::Ready);
    assert_eq!(
        after.control.in_flight.as_ref(),
        Some(&command.operation_id)
    );
    assert!(answered.is_ok(), "{answered:?}");
    assert!(cleanup.is_none(), "{cleanup:?}");
    assert!(triggered.is_ok(), "{triggered:?}");
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answer":"오래 기다린 응답","count":1})
    );
}
