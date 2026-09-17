use super::*;

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn recording_retains_short_intermediate_content_before_the_final_frame() {
    recording_interval("mp4").await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn admitted_webm_recording_preserves_intermediate_frames_and_seek() {
    recording_interval("webm").await;
}

async fn recording_interval(format: &str) {
    let root = tempfile::Builder::new()
        .prefix("dure-recording-interval-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("recording:interval");
    let runtime = BrowserRuntime::launch(owner.clone(), &config(), &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"document.body.style.background='red';true"}),
        )
        .await?;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"record","action":"start"}),
        )
        .await?;
        // A live viewer must coexist with the recording's native Page session.
        runtime.frame(&page).await?;
        sleep(Duration::from_millis(250)).await;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"document.body.style.background='lime';true"}),
        )
        .await?;
        sleep(Duration::from_millis(250)).await;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"document.body.style.background='blue';true"}),
        )
        .await?;
        sleep(Duration::from_millis(250)).await;
        let stopped = apply(
            &runtime,
            &lease,
            &page,
            if format == "mp4" {
                json!({"kind":"record","action":"stop"})
            } else {
                json!({"kind":"record","action":"stop","format":format})
            },
        )
        .await?;
        let bytes = STANDARD
            .decode(
                stopped["artifact_payload"]["base64"]
                    .as_str()
                    .ok_or("recording_fixture_artifact_missing")?,
            )
            .map_err(|_| "recording_fixture_artifact_invalid")?;
        std::fs::write(root.join(format!("interval.{format}")), &bytes).unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let mut cdp = runtime.test_binding().cdp.clone();
        let session = cdp.attach(target.as_str()).await?;
        let mime = format!("video/{format}");
        if stopped["artifact_payload"]["mime_type"] != mime {
            return Err("recording_fixture_container_mismatch".into());
        }
        let decoded = decode_video_as(&mut cdp, &session, &bytes, &mime).await?;
        std::fs::write(
            root.join("decoded.json"),
            serde_json::to_vec_pretty(&decoded).unwrap(),
        )
        .unwrap();
        Ok(decoded)
    }
    .await;
    let closed = runtime.close(&owner).await;
    println!(
        "BROWSER_RECORDING_INTERVAL root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let decoded = evidence.unwrap();
    let samples = decoded["result"]["value"]["samples"].as_array().unwrap();
    for channel in 0..3 {
        assert!(
            samples.iter().any(|pixel| (0..3).all(|i| if i == channel {
                pixel[i].as_u64().unwrap() > 200
            } else {
                pixel[i].as_u64().unwrap() < 40
            })),
            "missing channel {channel}: {decoded}"
        );
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn admitted_recording_survives_navigation_handoff_and_peer_retirement() {
    let root = tempfile::Builder::new()
        .prefix("dure-recording-core-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("recording:owner");
    let runtime = BrowserRuntime::launch(owner.clone(), &config(), &root)
        .await
        .unwrap();
    let peer_id = identity("recording:peer");
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let peer_page = first_page(&peer).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.style.background='red';true"})).await?;
        apply(&peer,&peer_lease,&peer_page,json!({"kind":"evaluate","script":"document.body.style.background='green';true"})).await?;
        let start = authority(&runtime,&lease,&page).await;
        let started = runtime.action(&lease.controller_id,&start,serde_json::from_value(json!({"kind":"record","action":"start"})).unwrap()).await?;
        let peer_started = apply(&peer,&peer_lease,&peer_page,json!({"kind":"record","action":"start"})).await?;
        let duplicate = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,serde_json::from_value(json!({"kind":"record","action":"start"})).unwrap()).await;
        sleep(Duration::from_millis(250)).await;
        apply(&runtime,&lease,&page,json!({"kind":"navigate","url":"about:blank"})).await?;
        let current = first_page(&runtime).await?;
        let status = runtime.recording_state(&owner,&current.page_id).await?;
        let human = runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await?.controller.unwrap();
        let old_owner = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&current).await,serde_json::from_value(json!({"kind":"record","action":"stop"})).unwrap()).await;
        apply(&runtime,&human,&current,json!({"kind":"evaluate","script":"document.body.style.background='blue';true"})).await?;
        sleep(Duration::from_millis(250)).await;
        let stop = authority(&runtime,&human,&current).await;
        let stopped = runtime.action(&human.controller_id,&stop,serde_json::from_value(json!({"kind":"record","action":"stop"})).unwrap()).await?;
        std::fs::write(root.join("stop-response.json"),serde_json::to_vec_pretty(&stopped).unwrap()).unwrap();
        if !stopped.response.success { println!("BROWSER_RECORDING_STOP_FAILURE {:?}",stopped.response.error); }
        let replay = runtime.action(&human.controller_id,&stop,serde_json::from_value(json!({"kind":"record","action":"stop"})).unwrap()).await;
        let empty_stop = runtime.action(&human.controller_id,&authority(&runtime,&human,&current).await,serde_json::from_value(json!({"kind":"record","action":"stop"})).unwrap()).await;
        let bytes = STANDARD.decode(stopped.response.data["artifact_payload"]["base64"].as_str().ok_or("recording_fixture_artifact_missing")?).map_err(|_| "recording_fixture_artifact_invalid")?;
        std::fs::write(root.join("admitted.mp4"),&bytes).unwrap();
        let target = runtime.host.lock().await.target_for(&current)?.clone();
        let mut cdp = runtime.test_binding().cdp.clone();
        let session = cdp.attach(target.as_str()).await?;
        let decoded = decode_video(&mut cdp,&session,&bytes).await?;
        let cleared = runtime.recording_state(&owner,&current.page_id).await?;
        let retained_streams = runtime.test_binding().retirement.recordings.lock().await.len();
        // Retiring this resource also retires an active recording, while the
        // shared browser instance and the other resource's recorder stay live.
        apply(&runtime,&human,&current,json!({"kind":"record","action":"start"})).await?;
        runtime.close(&owner).await?;
        let peer_status = peer.recording_state(&peer_id,&peer_page.page_id).await?;
        let peer_stopped = apply(&peer,&peer_lease,&peer_page,json!({"kind":"record","action":"stop"})).await?;
        Ok(json!({"started":started,"start":start,"status":status,"navigated":current!=page,"decoded":decoded,"stopped":stopped,"cleared":cleared,"retained_streams":retained_streams,"duplicate_denied":matches!(duplicate,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::RecordingAlreadyActive))),"old_owner_denied":matches!(old_owner,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::ControllerChanged))),"replay_denied":matches!(replay,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::CommandAlreadyDispatched))),"empty_stop_denied":matches!(empty_stop,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::RecordingNotActive))),"peer_started":peer_started,"peer_status":peer_status,"peer_stopped":peer_stopped}))
    }.await;
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    if let Ok(evidence) = &evidence {
        std::fs::write(
            root.join("evidence.json"),
            serde_json::to_vec_pretty(evidence).unwrap(),
        )
        .unwrap();
    }
    println!(
        "BROWSER_RECORDING_CORE root={} result={} closed={closed:?} peer_closed={peer_closed:?}",
        root.display(),
        if evidence.is_ok() { "ok" } else { "error" }
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    let evidence = evidence.unwrap();
    for key in [
        "navigated",
        "duplicate_denied",
        "old_owner_denied",
        "replay_denied",
        "empty_stop_denied",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(
        evidence["status"]["operation_id"],
        evidence["start"]["operation_id"]
    );
    assert_eq!(
        evidence["stopped"]["response"]["data"]["recording_operation_id"],
        evidence["start"]["operation_id"]
    );
    assert!(evidence["cleared"]["operation_id"].is_null());
    assert_eq!(evidence["retained_streams"], 0);
    assert_eq!(
        evidence["peer_status"]["operation_id"],
        evidence["peer_started"]["recording_operation_id"]
    );
    assert_eq!(evidence["peer_stopped"]["stopped"], true);
    let decoded = &evidence["decoded"]["result"]["value"];
    assert!(
        decoded["duration"].as_f64().is_some_and(|v| v > 0.0),
        "{decoded}"
    );
    let samples = decoded["samples"].as_array().unwrap();
    assert!(
        samples
            .iter()
            .any(|p| p[0].as_u64().unwrap() > 200 && p[2].as_u64().unwrap() < 40),
        "{decoded}"
    );
    assert!(
        samples
            .iter()
            .any(|p| p[2].as_u64().unwrap() > 200 && p[0].as_u64().unwrap() < 40),
        "{decoded}"
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn cancelled_record_start_retains_native_cleanup_and_fences_replay() {
    lost_recording_reply(true, true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn lost_record_stop_reply_fences_replay_and_preserves_peer() {
    lost_recording_reply(false, false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn cancelled_record_stop_retains_its_worker_until_native_cleanup() {
    lost_recording_reply(false, true).await;
}

async fn lost_recording_reply(starting: bool, cancelled: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-recording-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let owner = identity("recording:loss");
    let (chromium, engine) = crate::browser_engine::tests::exclusive_engine(&config(), &root)
        .await
        .unwrap();
    let endpoint = engine.chromium.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/recording-loss",
        listener.local_addr().unwrap()
    );
    let (retire, retired) = tokio::sync::oneshot::channel();
    let (effect, observed) = tokio::sync::oneshot::channel();
    let method = if starting {
        "Page.startScreenRecording"
    } else {
        "Page.stopScreenRecording"
    };
    let proxy = tokio::spawn(super::super::pages::lose_reply(
        listener,
        endpoint.clone(),
        method,
        effect,
        retired,
    ));
    let runtime =
        super::super::pages::with_connections(chromium, engine, owner.clone(), &address, &endpoint)
            .await
            .unwrap();
    let peer_id = identity("recording:loss-peer");
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let peer_page = first_page(&peer).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        if !starting {apply(&runtime,&lease,&page,json!({"kind":"record","action":"start"})).await?;sleep(Duration::from_millis(150)).await;}
        let authority = authority(&runtime,&lease,&page).await;
        let command = if starting {"start"} else {"stop"};
        let action = serde_json::from_value(json!({"kind":"record","action":command})).unwrap();
        let mut pending = Box::pin(runtime.action(&lease.controller_id,&authority,action));
        let acknowledged = tokio::select! {
            result = &mut pending => return Err(if result.is_ok(){"recording_fixture_reply_not_lost"}else{"recording_fixture_failed_before_effect"}.into()),
            observed = timeout(Duration::from_secs(8),observed) => observed.map_err(|_|"recording_fixture_effect_timeout")?.map_err(|_|"recording_fixture_effect_missing")?,
        };
        let unknown = if cancelled {drop(pending);true} else {
            matches!(pending.await,Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown)
        };
        timeout(Duration::from_secs(3),async {
            loop {
                let changed=runtime.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
                if runtime.control().await.phase==BrowserResourcePhase::OutcomeUnknown {break;}
                changed.await;
            }
        }).await.map_err(|_|"recording_fixture_cancellation_unfenced")?;
        let replay = runtime.action(&lease.controller_id,&authority,serde_json::from_value(json!({"kind":"record","action":command})).unwrap()).await;
        runtime.close(&owner).await?;
        let peer_after = first_page(&peer).await?;
        Ok(json!({"unknown":unknown,"acknowledged":acknowledged,"replay_denied":matches!(replay,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::OutcomeUnknown))),"peer_unchanged":peer_page==peer_after,"phase":runtime.control().await.phase}))
    }.await;
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    let _ = retire.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_RECORDING_LOSS starting={starting} cancelled={cancelled} root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_ok(), "{peer_closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let evidence = evidence.unwrap();
    for key in ["unknown", "replay_denied", "peer_unchanged"] {
        assert_eq!(evidence[key], true, "{evidence}");
    }
    assert!(
        evidence["acknowledged"]["result"]["stream"].is_string(),
        "{evidence}"
    );
    assert_eq!(evidence["phase"], "closed");
}
