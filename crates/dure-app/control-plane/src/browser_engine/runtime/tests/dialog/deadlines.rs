use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn losing_the_dialog_observer_ends_a_suspended_operation_as_unknown() {
    let (runtime, identity, root) = super::authority::launch("dialog:observer-loss").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        let command = authority(&runtime, &lease, &page).await;
        let (triggered, lost) = tokio::join!(
            timeout(Duration::from_secs(4), runtime.action(&lease.controller_id, &command,
                serde_json::from_value(json!({"kind":"evaluate","script":"window.answer=prompt('Observer loss');answer"})).unwrap())),
            async {
                let pending = super::authority::pending(&runtime, &page).await;
                runtime.test_binding().events.close().await;
                pending
            }
        );
        let control = runtime.control().await;
        // The test's independent page handler is cleanup only. It cannot
        // supply a replacement observation or turn the lost effect into success.
        let cleanup = observer.request("Page.handleJavaScriptDialog", json!({"accept":false}), Some(&session)).await;
        observer.retire().await;
        Ok((triggered, lost, control, cleanup))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_OBSERVER_LOSS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (triggered, lost, control, cleanup) = evidence.unwrap();
    lost.unwrap();
    cleanup.unwrap();
    assert!(matches!(
        triggered,
        Ok(Err(BrowserRuntimeError::Engine(BrowserEngineError {
            outcome_unknown: true,
            ..
        })))
    ));
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(control.in_flight.is_some());
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn consecutive_dialogs_exclude_only_human_wait_from_the_existing_execution_budget() {
    let (runtime, identity, root) = super::authority::launch("dialog:execution-budget").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        let command = authority(&runtime, &lease, &page).await;
        let started = Instant::now();
        let (triggered, responses) = tokio::join!(
            timeout(Duration::from_secs(40), runtime.action(&lease.controller_id, &command,
                // Keep the pending evaluation reachable: an unrooted promise
                // can produce Chromium's "Promise was collected" response
                // before the Host execution budget is exhausted.
                serde_json::from_value(json!({"kind":"evaluate","script":"window.pendingEvaluation=(async()=>{window.answers=[];for(let i=0;i<2;i++){await new Promise(r=>setTimeout(r,750));answers.push(prompt('Budget '+i));}return await new Promise(resolve=>window.releaseEvaluation=resolve);})()"})).unwrap())),
            async {
                let mut evidence = Vec::new();
                for _ in 0..2 {
                    let answered: Result<_, BrowserRuntimeError> = async {
                        let opened = super::authority::pending(&runtime, &page).await?;
                        sleep(Duration::from_secs(6)).await;
                        let waiting = runtime.dialog(&page.page_id).await?;
                        let dialog = opened.dialog.as_ref().ok_or("fixture_dialog_missing")?;
                        let response = runtime.respond_dialog(&lease.controller_id,
                            &authority(&runtime, &lease, &page).await, &dialog.identity,
                            serde_json::from_value(json!({"kind":"accept","text":"기다린 답"})).unwrap()).await?;
                        Ok((opened, waiting, response.response.success))
                    }.await;
                    if answered.is_err() {
                        let _ = observer.request("Page.handleJavaScriptDialog", json!({"accept":false}), Some(&session)).await;
                    }
                    evidence.push(answered);
                }
                evidence
            }
        );
        let elapsed = started.elapsed();
        let actual = observer.request("Runtime.evaluate", json!({"expression":"answers","returnByValue":true}), Some(&session)).await;
        let control = runtime.control().await;
        observer.retire().await;
        Ok((command, triggered, responses, elapsed, actual, control))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_EXECUTION_BUDGET root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (command, triggered, responses, elapsed, actual, control) = evidence.unwrap();
    assert!(matches!(
        triggered,
        Ok(Err(BrowserRuntimeError::Engine(BrowserEngineError {
            outcome_unknown: true,
            ..
        })))
    ));
    assert!(
        elapsed >= Duration::from_secs(32) && elapsed < Duration::from_secs(40),
        "{elapsed:?}"
    );
    let mut previous = None;
    for response in responses {
        let (opened, waiting, success) = response.unwrap();
        assert!(success);
        assert_eq!(waiting.dialog, opened.dialog);
        assert_eq!(waiting.control.phase, BrowserResourcePhase::Ready);
        assert_eq!(
            waiting.control.in_flight.as_ref(),
            Some(&command.operation_id)
        );
        assert_ne!(previous, opened.dialog);
        previous = opened.dialog;
    }
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!(["기다린 답", "기다린 답"])
    );
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn admitted_evaluation_preserves_values_and_known_script_errors() {
    let (runtime, identity, root) = super::authority::launch("dialog:evaluation-results").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        let mut cases = Vec::new();
        for script in [
            "Promise.resolve('한글 결과')",
            "undefined",
            "throw new Error('fixture evaluation error')",
            "6*7",
        ] {
            let command = authority(&runtime, &lease, &page).await;
            let result = runtime
                .action(
                    &lease.controller_id,
                    &command,
                    serde_json::from_value(json!({"kind":"evaluate","script":script})).unwrap(),
                )
                .await?;
            cases.push(result);
        }
        Ok(cases)
    }
    .await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_EVALUATION_RESULTS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let cases = evidence.unwrap();
    assert_eq!(cases[0].response.data["result"], "한글 결과");
    assert_eq!(cases[0].response.data["origin"], "about:blank");
    assert!(cases[1].response.success && cases[1].response.data["result"].is_null());
    assert!(!cases[2].response.success);
    assert!(
        cases[2]
            .response
            .error
            .as_ref()
            .unwrap()
            .contains("fixture evaluation error")
    );
    assert_eq!(cases[3].response.data["result"], 42);
    for case in cases {
        assert_eq!(case.control.phase, BrowserResourcePhase::Ready);
        assert!(case.control.in_flight.is_none());
    }
}
