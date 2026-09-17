use super::*;
use crate::browser_engine::cdp::BrowserCdp;
use base64::{Engine, engine::general_purpose::STANDARD};

mod authority;
mod collector;

async fn server() -> (
    String,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else {break};
                    requests.spawn(async move {
                        let mut bytes = [0;4096];
                        let _ = socket.read(&mut bytes).await;
                        let body = "<!doctype html><title>Tracing fixture</title><p>Tracing fixture</p>";
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = socket.write_all(response.as_bytes()).await;
                    });
                    while requests.try_join_next().is_some() {}
                }
            }
        }
        requests.shutdown().await;
    });
    (url, stop, task)
}

async fn observer(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
) -> Result<(BrowserCdp, String), BrowserRuntimeError> {
    let connection = runtime.test_binding().instance.connection().await;
    let target = runtime.host.lock().await.target_for(page)?.clone();
    let mut cdp = BrowserCdp::connect(connection.endpoint()).await?;
    cdp.retain_events().await;
    let session = cdp.attach(target.as_str()).await?;
    Ok((cdp, session))
}

async fn finish(cdp: &mut BrowserCdp, session: &str) -> Result<Value, &'static str> {
    cdp.request("Tracing.end", json!({}), Some(session)).await?;
    timeout(Duration::from_secs(30), async {
        let mut events = Vec::new();
        let complete = loop {
            let event = cdp.next_event().await?;
            if event["sessionId"] != session {
                continue;
            }
            match event["method"].as_str() {
                Some("Tracing.dataCollected") => {
                    events.extend(
                        event["params"]["value"]
                            .as_array()
                            .ok_or("trace_events_missing")?
                            .iter()
                            .cloned(),
                    );
                }
                Some("Tracing.tracingComplete") => break event["params"].clone(),
                _ => {}
            }
        };
        if let Some(handle) = complete["stream"].as_str() {
            let read: Result<_, &'static str> = async {
                let mut bytes = Vec::new();
                loop {
                    let chunk = cdp
                        .request(
                            "IO.read",
                            json!({"handle":handle,"size":65536}),
                            Some(session),
                        )
                        .await?;
                    let data = chunk["data"].as_str().ok_or("trace_stream_data_missing")?;
                    if chunk["base64Encoded"] == true {
                        bytes.extend(
                            STANDARD
                                .decode(data)
                                .map_err(|_| "trace_stream_base64_invalid")?,
                        );
                    } else {
                        bytes.extend(data.as_bytes());
                    }
                    if bytes.len() > 96 * 1024 * 1024 {
                        return Err("trace_fixture_bytes_limit");
                    }
                    if chunk["eof"] == true {
                        break;
                    }
                }
                serde_json::from_slice::<Value>(&bytes).map_err(|_| "trace_stream_json_invalid")
            }
            .await;
            let closed = cdp
                .request("IO.close", json!({"handle":handle}), Some(session))
                .await;
            let trace = read?;
            closed?;
            events.extend(
                trace["traceEvents"]
                    .as_array()
                    .ok_or("trace_stream_events_missing")?
                    .iter()
                    .cloned(),
            );
        }
        Ok(json!({"traceEvents":events,"complete":complete}))
    })
    .await
    .map_err(|_| "trace_fixture_complete_timeout")?
}

async fn mark(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    name: &str,
) -> Result<Value, BrowserRuntimeError> {
    let script = format!(
        "performance.mark({name:?});for(let i=0;i<10000;i++)Math.sqrt(i);performance.getEntriesByName({name:?}).length"
    );
    Ok(apply(
        runtime,
        lease,
        page,
        json!({"kind":"evaluate","script":script}),
    )
    .await?["result"]
        .clone())
}

async fn navigate_marker(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    origin: &str,
    marker: &str,
) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
    let url = format!("{origin}/{marker}");
    apply(runtime, lease, page, json!({"kind":"navigate","url":url})).await?;
    runtime
        .observe()
        .await?
        .pages
        .into_iter()
        .find(|row| row.page.page_id == page.page_id)
        .map(|row| row.page)
        .ok_or_else(|| "trace_fixture_page_missing".into())
}

fn summarize(trace: &Value, markers: &[String]) -> Value {
    let events = trace["traceEvents"].as_array().unwrap();
    json!({
        "eventCount":events.len(),"complete":trace["complete"],
        "markers":markers.iter().map(|marker| json!({"marker":marker,"events":events.iter().filter(|event| event.to_string().contains(marker)).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "processes":events.iter().filter(|event|event["name"]=="process_name").collect::<Vec<_>>()
    })
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn native_tracing_scope_and_session_ownership_probe() {
    run_scope(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn native_tracing_private_context_and_custom_categories_probe() {
    run_scope(true).await;
}

async fn run_scope(private_peer: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-tracing-scope-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let owner = identity("trace:owner");
    let peer_id = identity("trace:peer");
    let independent_id = identity("trace:independent");
    let runtime = BrowserRuntime::launch(owner.clone(), &config, &root)
        .await
        .unwrap();
    let peer = runtime.share_instance(peer_id.clone()).await.unwrap();
    let independent = BrowserRuntime::launch(independent_id.clone(), &config, &root)
        .await
        .unwrap();
    let (origin, stop, server) = server().await;
    let mut retained = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let peer_page = first_page(&peer).await?;
        let independent_page = first_page(&independent).await?;
        let lease = runtime.request_control(BrowserControllerId::new("owner").unwrap(),None).await?.controller.unwrap();
        let peer_lease = peer.request_control(BrowserControllerId::new("peer").unwrap(),None).await?.controller.unwrap();
        let independent_lease = independent.request_control(BrowserControllerId::new("independent").unwrap(),None).await?.controller.unwrap();
        let peer_page = if private_peer {
            let created = apply(&peer,&peer_lease,&peer_page,json!({"kind":"new_window"})).await?;
            serde_json::from_value(created["page"].clone()).map_err(|_| "trace_fixture_private_page_missing")?
        } else {peer_page};
        let page = navigate_marker(&runtime,&lease,&page,&origin,"dure-trace-owner-initial").await?;
        let mut peer_page = navigate_marker(&peer,&peer_lease,&peer_page,&origin,"dure-trace-peer-initial").await?;
        let independent_page = navigate_marker(&independent,&independent_lease,&independent_page,&origin,"dure-trace-independent-initial").await?;
        let (mut cdp, session) = observer(&runtime, &page).await?;
        retained.push(cdp.clone());
        let (mut peer_cdp, peer_session) = observer(&peer, &peer_page).await?;
        retained.push(peer_cdp.clone());
        let peer_target = peer.host.lock().await.target_for(&peer_page)?.clone();
        let target_info = peer_cdp.request("Target.getTargetInfo",json!({"targetId":peer_target.as_str()}),None).await?;
        let contexts = peer_cdp.request("Target.getBrowserContexts",json!({}),None).await?;
        let peer_context = target_info["targetInfo"]["browserContextId"].clone();
        let confirmed_private = contexts["browserContextIds"].as_array().ok_or("trace_fixture_contexts_missing")?.contains(&peer_context);
        let (mut independent_cdp, independent_session) = observer(&independent, &independent_page).await?;
        retained.push(independent_cdp.clone());
        let mut observations = Vec::new();
        for mode in if private_peer {["PrivateStream", "PrivateCategories"]}else{["ReturnAsStream", "ReportEvents"]} {
            let streaming = matches!(mode,"ReturnAsStream"|"PrivateStream");
            let config = if streaming {
                json!({"recordMode":"recordContinuously"})
            } else if private_peer {
                json!({"enableSampling":true,"includedCategories":["navigation","blink.user_timing"]})
            } else {
                json!({"enableSampling":true,"includedCategories":["devtools.timeline","disabled-by-default-devtools.timeline","disabled-by-default-devtools.timeline.frame","disabled-by-default-devtools.timeline.stack","v8.execute","disabled-by-default-v8.cpu_profiler","disabled-by-default-v8.cpu_profiler.hires","v8","disabled-by-default-v8.runtime_stats","blink","blink.user_timing","latencyInfo","renderer.scheduler","sequence_manager","toplevel"]})
            };
            let params = json!({"traceConfig":config,"transferMode":if streaming {"ReturnAsStream"}else{"ReportEvents"}});
            cdp.request("Tracing.start", params.clone(), Some(&session)).await?;
            let conflict = peer_cdp.request("Tracing.start", params.clone(), Some(&peer_session)).await;
            let foreign_stop = peer_cdp.request("Tracing.end", json!({}), Some(&peer_session)).await;
            independent_cdp.request("Tracing.start", params, Some(&independent_session)).await?;
            let markers = ["owner", "peer", "independent"].map(|name| format!("dure-trace-{name}-{mode}"));
            peer_page = navigate_marker(&peer,&peer_lease,&peer_page,&origin,&markers[1]).await?;
            let writes = [mark(&runtime,&lease,&page,&markers[0]).await?,mark(&peer,&peer_lease,&peer_page,&markers[1]).await?,mark(&independent,&independent_lease,&independent_page,&markers[2]).await?];
            let trace = finish(&mut cdp, &session).await?;
            let separate = finish(&mut independent_cdp, &independent_session).await?;
            for (name, data) in [("owner", &trace), ("independent", &separate)] {
                std::fs::write(root.join(format!("{mode}-{name}.json")), data.to_string()).map_err(|_| "trace_evidence_write_failed")?;
            }
            observations.push(json!({"mode":mode,"conflict":format!("{conflict:?}"),"conflictRejected":conflict.is_err(),"foreignStopRejected":foreign_stop.is_err(),"writes":writes,"owner":summarize(&trace,&markers),"independent":summarize(&separate,&markers)}));
        }
        // The original connection owns the native interval. Retiring it must
        // be observed before attempting another session's capture.
        cdp.request("Tracing.start", json!({"transferMode":"ReturnAsStream","traceConfig":{"includedCategories":["blink.user_timing"]}}), Some(&session)).await?;
        cdp.retire().await;
        let after_retirement = peer_cdp.request("Tracing.start", json!({"transferMode":"ReturnAsStream","traceConfig":{"includedCategories":["blink.user_timing"]}}), Some(&peer_session)).await;
        let replacement_trace = if after_retirement.is_ok() {Some(finish(&mut peer_cdp, &peer_session).await?)} else {None};
        Ok(json!({"observations":observations,"privatePeer":private_peer,"confirmedPrivate":confirmed_private,"peerContext":peer_context,"afterRetirement":format!("{after_retirement:?}"),"replacementCompleted":replacement_trace.is_some()}))
    }.await;
    for cdp in retained {
        cdp.retire().await;
    }
    let closed = runtime.close(&owner).await;
    let peer_closed = peer.close(&peer_id).await;
    let independent_closed = independent.close(&independent_id).await;
    let _ = stop.send(());
    let server_closed = server.await;
    println!(
        "BROWSER_TRACING_SCOPE root={} evidence={evidence:?} closed={closed:?} peer_closed={peer_closed:?} independent_closed={independent_closed:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(peer_closed.is_ok());
    assert!(independent_closed.is_ok());
    assert!(server_closed.is_ok());
    let evidence = evidence.unwrap();
    std::fs::write(root.join("receipt.json"), evidence.to_string()).unwrap();
    assert_eq!(evidence["confirmedPrivate"], private_peer);
    for observation in evidence["observations"].as_array().unwrap() {
        assert_eq!(observation["writes"], json!([1, 1, 1]));
        assert_eq!(observation["conflictRejected"], true);
        assert_eq!(observation["foreignStopRejected"], true);
        assert!(
            !observation["owner"]["markers"][0]["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            !observation["independent"]["markers"][2]["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
