use super::*;

mod faults;
mod streams;

fn start_action(mode: &str, scope: &str) -> Value {
    json!({"kind":"tracing","action":{"kind":"start","mode":mode,"scope":scope}})
}

fn stop_action(started: &Value) -> Value {
    json!({"kind":"tracing","action":{"kind":"stop","recording":started["interval"]["operation_id"]}})
}

fn artifact(response: &Value, path: &Path) -> Result<Value, BrowserRuntimeError> {
    let bytes = STANDARD
        .decode(
            response["artifact_payload"]["base64"]
                .as_str()
                .ok_or("trace_fixture_artifact_missing")?,
        )
        .map_err(|_| "trace_fixture_artifact_invalid")?;
    std::fs::write(path, &bytes).map_err(|_| "trace_fixture_write_failed")?;
    serde_json::from_slice(&bytes).map_err(|_| "trace_fixture_artifact_invalid".into())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn task_capture_rejects_peer_creation_and_explicit_browser_scope_includes_private_peers() {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-authority-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("trace:authority");
    let peer_id = identity("trace:authority-peer");
    let runtime = BrowserRuntime::launch(owner.clone(), &collector::config(), &root)
        .await
        .unwrap();
    let (origin, stop, server) = server().await;
    let mut peer = None;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let page = navigate_marker(&runtime, &lease, &first_page(&runtime).await?, &origin, "owner").await?;
        let started = apply(&runtime, &lease, &page, start_action("trace", "task")).await?;
        let rejected = match runtime.share_instance(peer_id.clone()).await {
            Err(error) => matches!(error, BrowserRuntimeError::Admission(BrowserAdmissionError::TracingAlreadyActive)),
            Ok(unexpected) => { unexpected.close(&peer_id).await?; false },
        };
        mark(&runtime, &lease, &page, "dure-collector-task-only").await?;
        let task = apply(&runtime, &lease, &page, stop_action(&started)).await?;
        let task_file = artifact(&task, &root.join("task.json"))?;
        peer = Some(runtime.share_instance(peer_id.clone()).await?);
        let peer = peer.as_ref().unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(), None).await?.controller.unwrap();
        let peer_page = first_page(peer).await?;
        let private = apply(peer, &peer_lease, &peer_page, json!({"kind":"new_window"})).await?;
        let private: BrowserPageIdentity = serde_json::from_value(private["page"].clone()).map_err(|_|"trace_fixture_private_page_missing")?;
        let scope_required = matches!(apply(&runtime, &lease, &page, start_action("trace", "task")).await, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::TracingScopeRequired)));
        let started = apply(&runtime, &lease, &page, start_action("trace", "browser")).await?;
        let peer_status = peer.tracing_state(&peer_id, &peer_page.page_id).await?;
        let peer_denied = matches!(apply(peer, &peer_lease, &peer_page, stop_action(&started)).await, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::PermitMismatch)));
        let private = navigate_marker(peer, &peer_lease, &private, &origin, "dure-private-trace-visible").await?;
        mark(peer, &peer_lease, &private, "dure-collector-private-peer").await?;
        let human = runtime.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)).await?.controller.unwrap();
        let stopped = apply(&runtime, &human, &page, stop_action(&started)).await?;
        let file = artifact(&stopped, &root.join("browser.json"))?;
        let empty = runtime.tracing_state(&owner, &page.page_id).await?;
        Ok(json!({"peerCreationRejected":rejected,"taskMark":task_file.to_string().contains("dure-collector-task-only"),"scopeRequired":scope_required,"peerStopRejected":peer_denied,"peerBusy":peer_status.tracing.busy,"peerIntervalHidden":peer_status.tracing.interval.is_none(),"privatePeerMark":file.to_string().contains("dure-collector-private-peer"),"privatePeerUrl":file.to_string().contains("dure-private-trace-visible"),"scope":stopped["interval"]["scope"],"finished":stopped["interval"]["cleanup_confirmed"],"busyAfterStop":empty.tracing.busy,"eventCount":stopped["eventCount"],"actualEventCount":file["traceEvents"].as_array().map(Vec::len)}))
    }.await;
    let peer_closed = match peer {
        Some(peer) => peer.close(&peer_id).await,
        None => Ok(()),
    };
    let closed = runtime.close(&owner).await;
    let _ = stop.send(());
    let server_closed = server.await;
    println!(
        "BROWSER_TRACE_AUTHORITY root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(server_closed.is_ok());
    let evidence = evidence.unwrap();
    for key in [
        "peerCreationRejected",
        "taskMark",
        "scopeRequired",
        "peerStopRejected",
        "peerBusy",
        "peerIntervalHidden",
        "privatePeerMark",
        "privatePeerUrl",
        "finished",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(evidence["scope"], "browser");
    assert_eq!(evidence["busyAfterStop"], false);
    assert_eq!(evidence["eventCount"], evidence["actualEventCount"]);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn owner_retirement_releases_its_trace_while_peer_keeps_the_same_browser() {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-retire-owner-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("trace:retire-owner");
    let peer_id = identity("trace:retire-peer");
    let runtime = BrowserRuntime::launch(owner.clone(), &collector::config(), &root)
        .await
        .unwrap();
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("owner").unwrap(), None).await?.controller.unwrap();
        let page = first_page(&runtime).await?;
        apply(&runtime, &lease, &page, start_action("profiler", "browser")).await?;
        let connection = peer.test_binding().instance.connection().await.endpoint().to_owned();
        runtime.close(&owner).await?;
        let peer_page = first_page(&peer).await?;
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(), None).await?.controller.unwrap();
        let status = peer.tracing_state(&peer_id, &peer_page.page_id).await?;
        let rejected = matches!(apply(&peer, &peer_lease, &peer_page, start_action("profiler", "task")).await, Err(BrowserRuntimeError::Admission(BrowserAdmissionError::TracingScopeRequired)));
        let started = apply(&peer, &peer_lease, &peer_page, json!({"kind":"tracing","action":{"kind":"start","mode":"profiler","scope":"browser","categories":["blink.user_timing"]}})).await?;
        mark(&peer, &peer_lease, &peer_page, "dure-collector-peer-after-close").await?;
        let stopped = apply(&peer, &peer_lease, &peer_page, stop_action(&started)).await?;
        let file = artifact(&stopped, &root.join("peer-profile.json"))?;
        Ok(json!({"sameBrowser":peer.test_binding().instance.connection().await.endpoint()==connection,"browserAlive":!peer.test_binding().instance.browser_has_exited().await?,"busyAfterClose":status.tracing.busy,"priorSharingRetained":rejected,"peerMark":file.to_string().contains("dure-collector-peer-after-close"),"metadata":file["metadata"]}))
    }.await;
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    println!(
        "BROWSER_TRACE_RETIRE_OWNER root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    let evidence = evidence.unwrap();
    for key in [
        "sameBrowser",
        "browserAlive",
        "priorSharingRetained",
        "peerMark",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(evidence["busyAfterClose"], false);
}
