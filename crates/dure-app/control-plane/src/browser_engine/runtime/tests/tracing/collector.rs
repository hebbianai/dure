use super::*;
use crate::browser_engine::runtime::tracing::{NativeTracing, TraceMode, TraceResult};
use std::sync::Arc;

pub(super) mod faults;

pub(super) fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

async fn start(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
    mode: TraceMode,
) -> Result<NativeTracing, BrowserRuntimeError> {
    let target = runtime.host.lock().await.target_for(page)?.clone();
    Ok(NativeTracing::spawn(
        runtime.test_binding().instance.connection().await,
        target,
        mode,
    ))
}

fn summarize(result: &TraceResult) -> Result<Value, BrowserRuntimeError> {
    let document: Value = if result.bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&result.bytes).map_err(|_| "trace_fixture_artifact_invalid")?
    };
    Ok(
        json!({"started":result.started,"ended":result.ended,"streamClosed":result.stream_closed,"eventCount":result.event_count,"dataLoss":result.data_loss,"error":result.error,"actualEventCount":document["traceEvents"].as_array().map(Vec::len),"metadata":document["metadata"],"bytes":result.bytes.len(),"marks":document["traceEvents"].as_array().map(|events|events.iter().filter(|e|e["name"].as_str().is_some_and(|name|name.starts_with("dure-collector-"))).cloned().collect::<Vec<_>>())}),
    )
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn trace_and_profiler_return_original_artifacts_and_reject_overlapping_native_owners() {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-collector-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("trace:collector");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let (origin, stop, server) = server().await;
    let mut retained = Vec::new();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let lease=runtime.request_control(BrowserControllerId::new("collector").unwrap(),None).await?.controller.unwrap();
        let page=navigate_marker(&runtime,&lease,&first_page(&runtime).await?,&origin,"collector").await?;
        let mut results=Vec::new();
        for (name,mode) in [("trace",TraceMode::Trace),("profiler",TraceMode::Profiler{categories:None})] {
            let trace=start(&runtime,&page,mode).await?;retained.push(trace.clone());trace.started().await?;
            let competing=start(&runtime,&page,TraceMode::Trace).await?;retained.push(competing.clone());
            let rejected=competing.started().await;
            let rejected_result=competing.stop().await?;
            let marker=format!("dure-collector-{name}");
            let write=mark(&runtime,&lease,&page,&marker).await?;
            let captured=trace.stop().await?;
            let recovered=trace.stop().await?;
            std::fs::write(root.join(format!("{name}.json")),&captured.bytes).map_err(|_|"trace_fixture_write_failed")?;
            results.push(json!({"kind":name,"write":write,"rejected":rejected.err(),"rejectedCapture":summarize(&rejected_result)?,"sameReceipt":Arc::ptr_eq(&captured,&recovered),"captured":summarize(&captured)?}));
        }
        let retiring=start(&runtime,&page,TraceMode::Trace).await?;retained.push(retiring.clone());retiring.started().await?;
        let retired=retiring.retire().await?;
        let after=start(&runtime,&page,TraceMode::Profiler{categories:Some(vec!["blink.user_timing".into()])}).await?;retained.push(after.clone());after.started().await?;
        mark(&runtime,&lease,&page,"dure-collector-after-retirement").await?;
        let replacement=after.stop().await?;
        Ok(json!({"modes":results,"retired":summarize(&retired)?,"replacement":summarize(&replacement)?}))
    }.await;
    for trace in retained {
        let _ = trace.retire().await;
    }
    let closed = runtime.close(&resource).await;
    let _ = stop.send(());
    let server_closed = server.await;
    println!(
        "BROWSER_TRACE_COLLECTOR root={} evidence={evidence:?} closed={closed:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(server_closed.is_ok());
    let evidence = evidence.unwrap();
    for mode in evidence["modes"].as_array().unwrap() {
        assert_eq!(mode["write"], 1);
        assert_eq!(mode["sameReceipt"], true);
        assert_eq!(mode["rejected"], "browser_cdp_request_rejected");
        assert_eq!(mode["rejectedCapture"]["started"], false);
        assert_eq!(mode["rejectedCapture"]["bytes"], 0);
        let captured = &mode["captured"];
        assert_eq!(captured["error"], Value::Null);
        assert_eq!(captured["started"], true);
        assert_eq!(captured["ended"], true);
        assert_eq!(captured["streamClosed"], true);
        assert_eq!(captured["eventCount"], captured["actualEventCount"]);
        assert!(!captured["marks"].as_array().unwrap().is_empty());
        if mode["kind"] == "trace" {
            assert_eq!(captured["metadata"], Value::Null);
        }
        if mode["kind"] == "profiler" && cfg!(target_os = "macos") {
            assert_eq!(
                captured["metadata"]["clock-domain"],
                "MAC_MACH_ABSOLUTE_TIME"
            );
        }
    }
    assert_eq!(evidence["retired"]["ended"], true);
    assert_eq!(evidence["retired"]["streamClosed"], true);
    assert_eq!(evidence["retired"]["bytes"], 0);
    assert_eq!(evidence["retired"]["error"], "browser_trace_retired");
    assert_eq!(evidence["replacement"]["error"], Value::Null);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_start_reply_retires_the_original_native_interval() {
    lost_reply(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn canceled_stop_waiter_recovers_completion_after_the_native_reply_is_lost() {
    lost_reply(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn trace_connection_cleanup_preserves_the_page_environment() {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-environment-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("trace:environment");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let mut retained = Vec::new();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("trace:environment").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":777,"height":551}})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"media","media":"print","color_scheme":"dark"}})).await?;
        let observe=json!({"kind":"evaluate","script":"({width:innerWidth,height:innerHeight,print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches})"});
        let before=apply(&runtime,&lease,&page,observe.clone()).await?["result"].clone();
        let trace=start(&runtime,&page,TraceMode::Trace).await?;retained.push(trace.clone());trace.started().await?;
        let competing=start(&runtime,&page,TraceMode::Trace).await?;retained.push(competing.clone());
        let rejected=competing.started().await;
        competing.retire().await?;
        sleep(Duration::from_millis(100)).await;
        let after_rejection=apply(&runtime,&lease,&page,observe.clone()).await?["result"].clone();
        trace.stop().await?;
        sleep(Duration::from_millis(100)).await;
        let after_stop=apply(&runtime,&lease,&page,observe.clone()).await?["result"].clone();
        let trace=start(&runtime,&page,TraceMode::Profiler{categories:None}).await?;retained.push(trace.clone());trace.started().await?;trace.retire().await?;
        sleep(Duration::from_millis(100)).await;
        let after_retirement=apply(&runtime,&lease,&page,observe).await?["result"].clone();
        Ok(json!({"before":before,"afterRejection":after_rejection,"afterStop":after_stop,"afterRetirement":after_retirement,"rejected":rejected.err()}))
    }.await;
    for trace in retained {
        let _ = trace.retire().await;
    }
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_TRACE_ENVIRONMENT root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    let evidence = evidence.unwrap();
    assert_eq!(
        evidence["before"],
        json!({"width":777,"height":551,"print":true,"dark":true})
    );
    assert_eq!(evidence["rejected"], "browser_cdp_request_rejected");
    for key in ["afterRejection", "afterStop", "afterRetirement"] {
        assert_eq!(evidence[key], evidence["before"], "{key}");
    }
}

async fn lost_reply(starting: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-response-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("trace:loss");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let instance = &runtime.test_binding().instance;
    let endpoint = instance.connection().await.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/trace-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let (effect, observed) = tokio::sync::oneshot::channel();
    let proxy = tokio::spawn(super::super::pages::lose_reply(
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
    let mut retained = Vec::new();
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let trace=start(&runtime,&page,TraceMode::Trace).await?;retained.push(trace.clone());
        let acknowledged=if starting {
            timeout(Duration::from_secs(8),observed).await.map_err(|_|"trace_fixture_start_not_observed")?.map_err(|_|"trace_fixture_effect_lost")?
        } else {
            trace.started().await?;
            let mut waiting=Box::pin(trace.stop());
            let acknowledged=tokio::select! {
                result=&mut waiting=>return Err(if result.is_ok(){"trace_fixture_stop_not_lost"}else{"trace_fixture_stop_failed"}.into()),
                observed=timeout(Duration::from_secs(8),observed)=>observed.map_err(|_|"trace_fixture_stop_not_observed")?.map_err(|_|"trace_fixture_effect_lost")?,
            };
            drop(waiting);
            acknowledged
        };
        let startup=trace.started().await;
        let result=if starting {trace.retire().await?}else{trace.stop().await?};
        instance.replace_test_endpoint(endpoint.clone()).await;
        let replacement=start(&runtime,&page,TraceMode::Trace).await?;retained.push(replacement.clone());replacement.started().await?;
        let replacement=replacement.stop().await?;
        Ok(json!({"acknowledged":acknowledged,"startupError":startup.err(),"capture":summarize(&result)?,"replacement":summarize(&replacement)?}))
    }.await;
    for trace in retained {
        let _ = trace.retire().await;
    }
    instance.replace_test_endpoint(endpoint).await;
    let closed = runtime.close(&resource).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_TRACE_LOSS starting={starting} root={} evidence={evidence:?} closed={closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(proxy_closed.is_ok());
    let evidence = evidence.unwrap();
    assert_eq!(evidence["capture"]["ended"], true);
    assert_eq!(evidence["capture"]["streamClosed"], true);
    assert_eq!(evidence["replacement"]["error"], Value::Null);
    if starting {
        assert_eq!(evidence["startupError"], "browser_cdp_response_timeout");
        assert_eq!(evidence["capture"]["bytes"], 0);
    } else {
        assert_eq!(evidence["capture"]["error"], Value::Null);
        assert!(evidence["capture"]["bytes"].as_u64().unwrap() > 0);
    }
}
