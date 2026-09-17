use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn pending_function_obeys_timeout_without_replay_or_handoff() {
    exercise("pending", 400, 1).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn late_function_success_cannot_outlive_the_requested_timeout() {
    exercise("late", 400, 1).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn later_function_probes_use_the_remaining_total_budget() {
    exercise("retry", 900, 2).await;
}

async fn exercise(kind: &str, timeout_ms: u64, expected_probes: u64) {
    let (runtime, identity, root) = super::authority::launch("function:budget").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.probes=0;window.completions=0;true"})).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        let expression = match kind {
            "pending" => "(window.probes++,window.pendingProbe=new Promise(resolve=>window.releaseProbe=()=>{window.completions++;resolve(true)}))",
            "late" => "(window.probes++,window.pendingProbe=new Promise(resolve=>setTimeout(()=>{window.completions++;resolve(true)},1600)))",
            _ => "(window.probes++,window.pendingProbe=new Promise(resolve=>setTimeout(()=>{window.completions++;resolve(window.probes>1)},window.probes===1?450:900)))",
        };
        let command = authority(&runtime, &lease, &page).await;
        let started = Instant::now();
        let (result, requested) = tokio::join!(
            runtime.action(&lease.controller_id, &command, serde_json::from_value(json!({"kind":"wait_function","wait":{"expression":expression,"timeout_ms":timeout_ms}})).unwrap()),
            async {
                if kind != "pending" { return Ok(None); }
                timeout(Duration::from_secs(2), async {
                    loop {
                        let count = observer.request("Runtime.evaluate", json!({"expression":"window.probes","returnByValue":true}), Some(&session)).await?;
                        if count["result"]["value"] == 1 { break; }
                        sleep(Duration::from_millis(10)).await;
                    }
                    Ok::<_,BrowserRuntimeError>(())
                }).await.map_err(|_|"fixture_probe_not_started")??;
                runtime.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)).await.map(Some)
            }
        );
        let elapsed = started.elapsed();
        let control = runtime.control().await;
        let replay = runtime.action(&lease.controller_id, &command,
            serde_json::from_value(json!({"kind":"evaluate","script":"window.probes++;true"})).unwrap()).await;
        // Complete the original page-side Promise after recording the product
        // timeout. Its late effects cannot authorize a replay or a new lease.
        let settled = observer.request("Runtime.evaluate", json!({"expression":if kind == "pending" {
            "window.releaseProbe();window.pendingProbe.then(()=>({probes,completions}))"
        } else { "window.pendingProbe.then(()=>({probes,completions}))" },"returnByValue":true,"awaitPromise":true}), Some(&session)).await;
        let settled_control = runtime.control().await;
        observer.retire().await;
        Ok((result,requested,elapsed,control,replay,settled,settled_control))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_FUNCTION_BUDGET kind={kind} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (result, requested, elapsed, control, replay, settled, settled_control) = evidence.unwrap();
    requested.unwrap();
    assert!(
        matches!(
            result,
            Err(BrowserRuntimeError::Engine(BrowserEngineError {
                outcome_unknown: true,
                ..
            }))
        ),
        "{result:?}"
    );
    assert!(elapsed >= Duration::from_millis(timeout_ms), "{elapsed:?}");
    assert!(
        elapsed < Duration::from_millis(timeout_ms + 700),
        "{elapsed:?}"
    );
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(control.in_flight.is_some());
    assert_eq!(
        control.controller.as_ref().unwrap().controller_id.as_str(),
        "agent"
    );
    if kind == "pending" {
        assert_eq!(
            control.requested_controller.as_ref().unwrap().as_str(),
            "human"
        );
    }
    assert!(replay.is_err(), "{replay:?}");
    assert_eq!(
        settled.unwrap()["result"]["value"],
        json!({"probes":expected_probes,"completions":expected_probes})
    );
    assert_eq!(settled_control, control);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn completed_function_promises_and_zero_timeout_keep_known_results() {
    let (runtime, identity, root) = super::authority::launch("function:known-budget").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let mut cases = Vec::new();
        for (timeout_ms, value) in [(0, true), (0, false), (1000, true)] {
            apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.probes=0;true"})).await?;
            let started = Instant::now();
            let result = runtime.action(&lease.controller_id, &authority(&runtime, &lease, &page).await,
                serde_json::from_value(json!({"kind":"wait_function","wait":{"expression":format!("(window.probes++,new Promise(resolve=>setTimeout(()=>resolve({value}),150)))"),"timeout_ms":timeout_ms}})).unwrap()).await?;
            let elapsed = started.elapsed();
            let actual = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.probes"})).await?;
            cases.push((timeout_ms,value,result,elapsed,actual));
        }
        Ok(cases)
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_FUNCTION_KNOWN_BUDGET root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    for (_, value, result, elapsed, actual) in evidence.unwrap() {
        assert_eq!(result.response.success, value);
        assert_eq!(result.response.data["result"], value);
        assert_eq!(
            result.response.error.as_deref(),
            if value {
                None
            } else {
                Some("browser_wait_timeout")
            }
        );
        assert_eq!(result.control.phase, BrowserResourcePhase::Ready);
        assert!(result.control.in_flight.is_none());
        assert_eq!(actual["result"], 1);
        assert!(elapsed >= Duration::from_millis(150), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn explicit_function_timeout_allows_a_longer_successful_promise() {
    let (runtime, identity, root) = super::authority::launch("function:long-budget").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let started = Instant::now();
        let result = runtime.action(&lease.controller_id, &authority(&runtime, &lease, &page).await,
            serde_json::from_value(json!({"kind":"wait_function","wait":{"expression":"window.longProbe=new Promise(resolve=>setTimeout(()=>resolve(true),22000))","timeout_ms":30000}})).unwrap()).await;
        Ok((result, started.elapsed()))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_FUNCTION_LONG_BUDGET root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (result, elapsed) = evidence.unwrap();
    let result = result.unwrap();
    assert!(result.response.success);
    assert_eq!(result.response.data["result"], true);
    assert_eq!(result.control.phase, BrowserResourcePhase::Ready);
    assert!(result.control.in_flight.is_none());
    assert!(elapsed >= Duration::from_secs(22), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(25), "{elapsed:?}");
}
