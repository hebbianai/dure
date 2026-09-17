use super::*;
use crate::browser_engine::runtime::BrowserActionResult;
use collector::faults::{Fault, invalid_stream};
use hmux_session_protocol::browser_tracing::BrowserTracingStopAuthority;
use std::sync::Arc;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn missing_stream_retains_the_interval_until_explicit_physical_retirement() {
    stream_fault(Fault::MissingStream, "browser_trace_stream_missing", false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_stream_close_reply_cannot_release_the_interval_or_repeat_native_cleanup() {
    stream_fault(
        Fault::CloseReplyLoss,
        "browser_trace_stream_close_failed",
        false,
    )
    .await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn rejected_stream_read_with_confirmed_cleanup_preserves_peer_capture_and_input() {
    stream_fault(Fault::ReadRejected, "browser_cdp_request_rejected", true).await;
}

async fn retained_stop(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    started: &Value,
) -> Result<BrowserActionResult, BrowserRuntimeError> {
    let request = authority(runtime, lease, page).await;
    runtime
        .stop_tracing(
            &lease.controller_id,
            &BrowserTracingStopAuthority {
                lease: lease.clone(),
                command_sequence: request.command_sequence,
                operation_id: request.operation_id,
                instance_id: runtime
                    .tracing_state(&page.resource, &page.page_id)
                    .await?
                    .tracing
                    .instance_id,
                recording: serde_json::from_value(started["interval"]["operation_id"].clone())
                    .map_err(|_| "trace_fixture_recording_missing")?,
            },
        )
        .await
}

async fn stream_fault(fault: Fault, expected_error: &str, cleanup_confirmed: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-authority-stream-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("trace:stream-owner");
    let peer_id = identity("trace:stream-peer");
    let runtime = BrowserRuntime::launch(owner.clone(), &collector::config(), &root)
        .await
        .unwrap();
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let instance = Arc::clone(&runtime.test_binding().instance);
    let endpoint = instance.connection().await.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/trace-stream-fault",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let proxy = tokio::spawn(invalid_stream(listener, endpoint.clone(), stopped, fault));
    instance.replace_test_endpoint(address).await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("owner").unwrap(), None).await?.controller.unwrap();
        let page = first_page(&runtime).await?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(), None).await?.controller.unwrap();
        let peer_page = first_page(&peer).await?;
        mark(&peer, &peer_lease, &peer_page, "dure-peer-before-stream-fault").await?;
        let started = apply(&runtime, &lease, &page, start_action("trace", "browser")).await?;
        let stopped = retained_stop(&runtime, &lease, &page, &started).await?;
        let status = runtime.tracing_state(&owner, &page.page_id).await?;
        let peer_status = peer.tracing_state(&peer_id, &peer_page.page_id).await?;
        let peer_before = apply(&peer, &peer_lease, &peer_page,
            json!({"kind":"evaluate","script":"performance.getEntriesByName('dure-peer-before-stream-fault').length"})).await?;
        let alive_before_close = !instance.browser_has_exited().await?;
        // Restore only future connections. The finished native worker retains
        // its original response and cannot resend end, read, or stream close.
        instance.replace_test_endpoint(endpoint.clone()).await;
        let mut retry_error = None;
        let mut peer_capture = false;
        let mut peer_blocked = false;
        if cleanup_confirmed {
            let started = apply(&peer, &peer_lease, &peer_page, start_action("trace", "browser")).await?;
            mark(&peer, &peer_lease, &peer_page, "dure-peer-after-stream-fault").await?;
            let captured = retained_stop(&peer, &peer_lease, &peer_page, &started).await?;
            let document = artifact(&captured.response.data, &root.join("peer.json"))?;
            peer_capture = document.to_string().contains("dure-peer-after-stream-fault");
        } else {
            let retried = retained_stop(&runtime, &lease, &page, &started).await?;
            retry_error = retried.response.error;
            peer_blocked = matches!(apply(&peer, &peer_lease, &peer_page, start_action("trace", "browser")).await,
                Err(BrowserRuntimeError::Admission(BrowserAdmissionError::TracingAlreadyActive)));
        }
        runtime.close(&owner).await?;
        let peer_phase = peer.control().await.phase;
        let peer_after = apply(&peer, &peer_lease, &peer_page,
            json!({"kind":"evaluate","script":"performance.getEntriesByName('dure-peer-before-stream-fault').length"})).await;
        Ok(json!({"success":stopped.response.success,"error":stopped.response.error,
            "artifactMissing":stopped.response.data.get("artifact_payload").is_none(),
            "busy":status.tracing.busy,"interval":status.tracing.interval,
            "peerBusy":peer_status.tracing.busy,"peerIntervalHidden":peer_status.tracing.interval.is_none(),
            "peerBeforeMark":peer_before["result"],"aliveBeforeClose":alive_before_close,
            "retryError":retry_error,"peerCapture":peer_capture,"peerBlocked":peer_blocked,
            "sameEndpoint":instance.connection().await.endpoint()==endpoint,
            "browserExited":instance.browser_has_exited().await?,"peerPhase":peer_phase,
            "peerAfterMark":peer_after.as_ref().ok().map(|value| &value["result"]),
            "peerInputRejected":matches!(peer_after, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ResourceClosed)))
        }))
    }.await;
    instance.replace_test_endpoint(endpoint).await;
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_TRACE_AUTHORITY_STREAM fault={fault:?} root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    let proxy = proxy_closed.unwrap();
    let evidence = evidence.unwrap();
    assert_eq!(evidence["success"], false);
    assert_eq!(evidence["error"], expected_error);
    for key in [
        "artifactMissing",
        "peerIntervalHidden",
        "aliveBeforeClose",
        "sameEndpoint",
    ] {
        assert_eq!(evidence[key], true, "{key}: {evidence}");
    }
    assert_eq!(evidence["busy"], !cleanup_confirmed);
    assert_eq!(evidence["peerBusy"], !cleanup_confirmed);
    assert_eq!(evidence["peerBeforeMark"], 1);
    assert_eq!(evidence["browserExited"], !cleanup_confirmed);
    assert_eq!(evidence["peerCapture"], cleanup_confirmed);
    assert_eq!(evidence["peerBlocked"], !cleanup_confirmed);
    assert_eq!(proxy["knownStream"], true);
    assert_eq!(proxy["corrupted"], true);
    let closes = if matches!(fault, Fault::MissingStream) {
        0
    } else {
        1
    };
    assert_eq!(proxy["closeRequests"], closes);
    assert_eq!(proxy["closeAcknowledged"], closes == 1);
    if cleanup_confirmed {
        assert!(evidence["interval"].is_null());
        assert_eq!(evidence["peerPhase"], "ready");
        assert_eq!(evidence["peerAfterMark"], 1);
    } else {
        assert_eq!(evidence["interval"]["cleanup_confirmed"], false);
        assert_eq!(evidence["retryError"], expected_error);
        assert_eq!(evidence["peerPhase"], "closed");
        assert_eq!(evidence["peerInputRejected"], true);
    }
}
