use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn function_wait_keeps_known_timeout_and_script_error_results() {
    exercise(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn function_wait_stops_probing_before_granting_human_handoff() {
    exercise(true).await;
}

async fn exercise(handoff: bool) {
    let (runtime, identity, root) = super::authority::launch("function:completion").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.probes=0;true"})).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        let command = authority(&runtime,&lease,&page).await;
        let started = Instant::now();
        let (result, requested) = tokio::join!(
            runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"wait_function","wait":{"expression":"(window.probes++,false)","timeout_ms":if handoff {120000} else {500}}})).unwrap()),
            async {
                if !handoff { return Ok(None); }
                timeout(Duration::from_secs(2),async {
                    loop {
                        let count = observer.request("Runtime.evaluate",json!({"expression":"window.probes","returnByValue":true}),Some(&session)).await?;
                        if count["result"]["value"].as_u64().unwrap_or(0) > 0 { break; }
                        sleep(Duration::from_millis(10)).await;
                    }
                    Ok::<_,BrowserRuntimeError>(())
                }).await.map_err(|_|"fixture_probe_not_started")??;
                runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await.map(Some)
            }
        );
        let elapsed = started.elapsed();
        let after = observer.request("Runtime.evaluate",json!({"expression":"window.probes","returnByValue":true}),Some(&session)).await;
        sleep(Duration::from_millis(150)).await;
        let settled = observer.request("Runtime.evaluate",json!({"expression":"window.probes","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        let script_error = if handoff { None } else {
            Some(runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"wait_function","wait":{"expression":"(()=>{throw Error('Known function failure')})()","timeout_ms":1000}})).unwrap()).await)
        };
        Ok((elapsed,result,requested,after,settled,script_error,runtime.control().await))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_FUNCTION_COMPLETION handoff={handoff} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (elapsed, result, requested, after, settled, script_error, control) = evidence.unwrap();
    requested.unwrap();
    let result = result.unwrap();
    assert!(!result.response.success);
    assert_eq!(
        result.response.error.as_deref(),
        Some(if handoff {
            "browser_wait_cancelled_for_handoff"
        } else {
            "browser_wait_timeout"
        })
    );
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert!(control.in_flight.is_none());
    let after = after.unwrap()["result"]["value"].clone();
    assert!(after.as_u64().unwrap() > 0);
    assert_eq!(settled.unwrap()["result"]["value"], after);
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    if handoff {
        assert_eq!(control.controller.unwrap().controller_id.as_str(), "human");
    } else {
        assert!(elapsed >= Duration::from_millis(500), "{elapsed:?}");
        let response = script_error.unwrap().unwrap().response;
        assert!(!response.success);
        assert!(response.error.unwrap().contains("Known function failure"));
    }
}
