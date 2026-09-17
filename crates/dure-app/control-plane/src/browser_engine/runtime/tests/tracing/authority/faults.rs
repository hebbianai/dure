use super::*;
use std::sync::Arc;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_start_reply_releases_the_interval_and_preserves_the_peer() {
    lost_reply("trace", true, false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_start_caller_retains_cleanup_until_owner_retirement() {
    lost_reply("profiler", true, true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_stop_reply_still_exports_the_original_interval() {
    lost_reply("trace", false, false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_stop_caller_retains_cleanup_until_owner_retirement() {
    lost_reply("profiler", false, true).await;
}

async fn lost_reply(mode: &'static str, starting: bool, cancel: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-authority-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("trace:authority-loss");
    let peer_id = identity("trace:authority-loss-peer");
    let runtime = Arc::new(
        BrowserRuntime::launch(owner.clone(), &collector::config(), &root)
            .await
            .unwrap(),
    );
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let instance = &runtime.test_binding().instance;
    let endpoint = instance.connection().await.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/trace-authority-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let (effect, observed) = tokio::sync::oneshot::channel();
    let proxy = tokio::spawn(super::super::super::pages::lose_reply(
        listener,
        endpoint.clone(),
        if starting {
            "Tracing.start"
        } else {
            "Tracing.end"
        },
        effect,
        stopped,
    ));
    instance.replace_test_endpoint(address).await;
    let mut caller = None;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("owner").unwrap(), None).await?.controller.unwrap();
        let page = first_page(&runtime).await?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(), None).await?.controller.unwrap();
        let peer_page = first_page(&peer).await?;
        mark(&peer, &peer_lease, &peer_page, "dure-peer-before-trace-loss").await?;
        let command = if starting {
            start_action(mode, "browser")
        } else {
            let started = apply(&runtime, &lease, &page, start_action(mode, "browser")).await?;
            mark(&runtime, &lease, &page, "dure-original-trace-before-lost-stop").await?;
            stop_action(&started)
        };
        let authority = authority(&runtime, &lease, &page).await;
        let stop_authority = if starting { None } else {
            Some(hmux_session_protocol::browser_tracing::BrowserTracingStopAuthority {
                lease: authority.lease.clone(), command_sequence: authority.command_sequence,
                operation_id: authority.operation_id.clone(),
                instance_id: runtime.tracing_state(&owner, &page.page_id).await?.tracing.instance_id,
                recording: serde_json::from_value(command["action"]["recording"].clone()).map_err(|_|"trace_fixture_recording_missing")?,
            })
        };
        let call_runtime = Arc::clone(&runtime);
        caller = Some(tokio::spawn(async move {
            if let Some(authority) = stop_authority {
                call_runtime.stop_tracing(&lease.controller_id, &authority).await
            } else {
                call_runtime.action(&lease.controller_id, &authority, serde_json::from_value(command).unwrap()).await
            }
        }));
        let acknowledged = timeout(Duration::from_secs(8), observed).await.map_err(|_| "trace_fixture_effect_not_observed")?.map_err(|_| "trace_fixture_effect_lost")?;
        let task = caller.take().unwrap();
        if cancel { task.abort(); }
        let result = task.await;
        let response = result.as_ref().ok().and_then(|result| result.as_ref().ok()).map(|result| &result.response);
        let output = if !starting && !cancel {
            Some(artifact(&response.ok_or("trace_fixture_stop_response_missing")?.data, &root.join("original.json"))?)
        } else { None };
        let phase = timeout(Duration::from_secs(8), async {
            loop {
                let phase = runtime.control().await.phase;
                if !cancel || phase == BrowserResourcePhase::OutcomeUnknown { break phase; }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_| "trace_fixture_cancellation_unsettled")?;
        let status = runtime.tracing_state(&owner, &page.page_id).await;
        let peer_status = peer.tracing_state(&peer_id, &peer_page.page_id).await?;
        // The retained worker keeps its original proxy connection. Restoring the
        // next connection does not restart or replace that interval.
        instance.replace_test_endpoint(endpoint.clone()).await;
        runtime.close(&owner).await?;
        let after = peer.tracing_state(&peer_id, &peer_page.page_id).await?;
        let before_mark = apply(&peer, &peer_lease, &peer_page, json!({"kind":"evaluate","script":"performance.getEntriesByName('dure-peer-before-trace-loss').length"})).await?;
        let started = apply(&peer, &peer_lease, &peer_page, start_action(mode, "browser")).await?;
        mark(&peer, &peer_lease, &peer_page, "dure-peer-after-trace-loss").await?;
        let stopped = apply(&peer, &peer_lease, &peer_page, stop_action(&started)).await?;
        let replacement = artifact(&stopped, &root.join("peer.json"))?;
        Ok(json!({
            "acknowledged":acknowledged.get("result").is_some(),
            "callerCanceled":result.as_ref().is_err_and(|error| error.is_cancelled()),
            "responseSuccess":response.map(|response| response.success),
            "responseError":response.and_then(|response| response.error.as_deref()),
            "phase":phase,"busyBeforeClose":status.as_ref().ok().map(|status|status.tracing.busy),"peerBusyBeforeClose":peer_status.tracing.busy,
            "ownerStatusFenced":matches!(status,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::OutcomeUnknown))),
            "peerIntervalHidden":peer_status.tracing.interval.is_none(),
            "busyAfterClose":after.tracing.busy,"peerBeforeMark":before_mark["result"],
            "originalMark":output.as_ref().map(|output| output.to_string().contains("dure-original-trace-before-lost-stop")),
            "peerMark":replacement.to_string().contains("dure-peer-after-trace-loss"),
            "peerCleanupConfirmed":stopped["interval"]["cleanup_confirmed"],
            "sameBrowser":peer.test_binding().instance.connection().await.endpoint()==endpoint,
            "browserAlive":!peer.test_binding().instance.browser_has_exited().await?
        }))
    }.await;
    if let Some(caller) = caller {
        caller.abort();
        let _ = caller.await;
    }
    instance.replace_test_endpoint(endpoint).await;
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_TRACE_AUTHORITY_LOSS mode={mode} starting={starting} cancel={cancel} root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(proxy_closed.is_ok());
    let evidence = evidence.unwrap();
    for key in [
        "acknowledged",
        "peerIntervalHidden",
        "peerMark",
        "peerCleanupConfirmed",
        "sameBrowser",
        "browserAlive",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(evidence["callerCanceled"], cancel);
    assert_eq!(evidence["ownerStatusFenced"], cancel);
    assert_eq!(evidence["peerBusyBeforeClose"], cancel);
    assert_eq!(evidence["busyAfterClose"], false);
    assert_eq!(evidence["peerBeforeMark"], 1);
    if cancel {
        assert_eq!(evidence["phase"], "outcome_unknown");
        assert_eq!(evidence["busyBeforeClose"], Value::Null);
    } else {
        assert_eq!(evidence["busyBeforeClose"], false);
        assert_eq!(evidence["phase"], "ready");
        assert_eq!(evidence["responseSuccess"], !starting);
        if starting {
            assert_eq!(evidence["responseError"], "browser_cdp_response_timeout");
        } else {
            assert_eq!(evidence["originalMark"], true);
        }
    }
}
