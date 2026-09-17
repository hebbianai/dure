use super::*;
use tokio::time::{Duration, timeout};

// Faults live exclusively in this disposable page's isolated observer world.
// Real Chromium still decodes the image and owns the bitmap, canvas and CDP
// handles. Weak references expose retention without becoming another owner.
const INSTALL: &str = r#"(() => {
  const probe = globalThis.captureProbe = {closed:0, written:0};
  probe.ready = new Promise(resolve => probe.entered = resolve);
  probe.gate = new Promise(resolve => probe.release = resolve);
  probe.done = new Promise(resolve => probe.finished = resolve);
  const decode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (...args) => {
    if (probe.fault === 'decode') throw Error('fixture decode failure');
    const bitmap = await decode(...args);
    const close = bitmap.close.bind(bitmap);
    bitmap.close = () => { close(); probe.closed++; probe.finished(); };
    if (probe.pause === 'decode') { probe.entered(); await probe.gate; }
    return bitmap;
  };
  const encode = OffscreenCanvas.prototype.convertToBlob;
  OffscreenCanvas.prototype.convertToBlob = async function (...args) {
    probe.canvas = new WeakRef(this);
    if (probe.pause === 'encode') { probe.entered(); await probe.gate; }
    if (probe.fault === 'encode') {
      const error = Error('fixture encode failure');
      probe.failure = new WeakRef(error); throw error;
    }
    if (probe.fault === 'size') return {size:64*1024*1024+1};
    return encode.apply(this, args);
  };
  Object.defineProperty(Object.prototype, 'bytes', {configurable:true, set(value) {
    Object.defineProperty(this, 'bytes', {value, writable:true, configurable:true});
    probe.carrier = new WeakRef(this); probe.written++;
  }});
  probe.restore = () => {
    globalThis.createImageBitmap = decode;
    OffscreenCanvas.prototype.convertToBlob = encode;
    delete Object.prototype.bytes;
  };
  return true;
})()"#;

async fn evaluate(
    cdp: &mut BrowserCdp,
    session: &str,
    context: i64,
    expression: &str,
) -> Result<Value, BrowserRuntimeError> {
    let reply = cdp
        .request_with_deadline(
            "Runtime.evaluate",
            json!({"expression":expression,"contextId":context,"returnByValue":true,"awaitPromise":true}),
            Some(session),
            // The suspension barrier includes the preceding native screenshot,
            // whose existing capture deadline is thirty seconds.
            Duration::from_secs(30),
        )
        .await?;
    if reply.get("exceptionDetails").is_some() {
        println!("CAPTURE_FAULT_SCRIPT {reply}");
        return Err("capture_fault_script_failed".into());
    }
    Ok(reply["result"]["value"].clone())
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn annotated_capture_cancellation_releases_late_objects_and_preserves_page() {
    prove_faults(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn annotated_capture_decode_and_encode_errors_are_not_byte_limits() {
    prove_faults(false).await;
}

async fn prove_faults(cancel: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-capture-fault-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(
        json!({"resource_id":"capture:fault","generation":"g","workspace_id":"w"}),
    )
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let mut cdp = runtime.test_binding().cdp.clone();
        let session = cdp.attach(target.as_str()).await?;
        let context = cdp.isolated_context(&session).await?;
        let lease = runtime.request_control(BrowserControllerId::new("capture-agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=entry>한글 보존</button>';true"})).await?;
        let snapshot = runtime.snapshot(&page,&Default::default()).await?;
        let element = snapshot.data["refs"].as_object().unwrap().iter().find(|(_, value)| value["name"] == "한글 보존").ok_or("capture_fault_reference_missing")?.0.clone();
        let query = serde_json::from_value(json!({"kind":"text","target":{"kind":"reference","reference":{"snapshot":snapshot.snapshot,"element":element}}})).unwrap();
        let before = runtime.control().await;
        let options = serde_json::from_value(json!({"annotate":true})).unwrap();
        let mut receipts = Vec::new();
        for stage in if cancel { vec!["decode","encode","encode-reject"] } else { vec!["decode","encode","size"] } {
            evaluate(&mut cdp,&session,context,INSTALL).await?;
            evaluate(&mut cdp,&session,context,&format!("captureProbe.{}={};true",if cancel {"pause"} else {"fault"},json!(if stage == "encode-reject" {"encode"} else {stage}))).await?;
            if stage == "encode-reject" { evaluate(&mut cdp,&session,context,"captureProbe.fault='encode';true").await?; }
            let outcome = if cancel {
                let mut capture = Box::pin(runtime.capture_image(&page,&options));
                tokio::select! {
                    result = &mut capture => {
                        println!("CAPTURE_FAULT_EARLY stage={stage} result={:?}",result.err());
                        return Err("capture_fault_did_not_suspend".into());
                    }
                    ready = evaluate(&mut cdp,&session,context,"captureProbe.ready.then(()=>true)") => { ready?; println!("CAPTURE_CANCEL_READY stage={stage}"); }
                }
                drop(capture);
                println!("CAPTURE_CANCEL_DROPPED stage={stage}");
                // The exact release worker must finish before the delayed JS
                // result arrives, otherwise a late-object leak could be masked.
                cdp.wait_for_object_releases().await?;
                evaluate(&mut cdp,&session,context,"captureProbe.release();captureProbe.done.then(()=>true)").await?;
                println!("CAPTURE_CANCEL_FINISHED stage={stage}");
                let mut latest = Value::Null;
                let cleanup = timeout(Duration::from_secs(3),async {
                    loop {
                        cdp.request("HeapProfiler.collectGarbage",json!({}),Some(&session)).await?;
                        let state = evaluate(&mut cdp,&session,context,"({closed:captureProbe.closed,written:captureProbe.written,retained:!!captureProbe.carrier?.deref(),errorRetained:!!captureProbe.failure?.deref()})").await?;
                        latest = state.clone();
                        let written = if stage == "encode-reject" {0} else {1};
                        if state["closed"] == 1 && state["written"] == written && state["retained"] == false && state["errorRetained"] == false { break Ok::<_,BrowserRuntimeError>(state); }
                        tokio::task::yield_now().await;
                    }
                }).await;
                let cleanup = match cleanup { Ok(result) => result?, Err(_) => latest };
                json!({"cancelled":true,"cleanup":cleanup})
            } else {
                let result = runtime.capture_image(&page,&options).await;
                let code = match result {
                    Err(BrowserRuntimeError::Observation(code)) => code,
                    other => { println!("CAPTURE_FAULT_UNEXPECTED stage={stage} error={:?}",other.err()); return Err("capture_fault_wrong_error_kind".into()); }
                };
                let expected = if stage == "size" {"browser_capture_byte_limit"} else {"browser_capture_annotation_failed"};
                let state = evaluate(&mut cdp,&session,context,"({closed:captureProbe.closed,written:captureProbe.written,width:captureProbe.canvas?.deref()?.width,height:captureProbe.canvas?.deref()?.height})").await?;
                json!({"error":code,"expected":expected,"cleanup":state})
            };
            evaluate(&mut cdp,&session,context,"captureProbe.restore();true").await?;
            let reference = runtime.query(&page,&query).await?;
            if reference["data"]["text"] != "한글 보존" || runtime.control().await != before { return Err("capture_fault_changed_page_or_control".into()); }
            receipts.push(json!({"stage":stage,"outcome":outcome}));
        }
        let recovered = runtime.capture_image(&page,&options).await?;
        if !recovered.file.bytes.starts_with(b"\x89PNG\r\n\x1a\n") || recovered.annotations.len() != 1 { return Err("capture_fault_recovery_failed".into()); }
        if cancel {
            evaluate(&mut cdp,&session,context,INSTALL).await?;
            evaluate(&mut cdp,&session,context,"captureProbe.pause='encode';true").await?;
            let mut capture = Box::pin(runtime.capture_image(&page,&options));
            tokio::select! {
                _ = &mut capture => return Err("capture_fault_close_did_not_suspend".into()),
                ready = evaluate(&mut cdp,&session,context,"captureProbe.ready.then(()=>true)") => { ready?; }
            }
            let instance = std::sync::Arc::clone(&runtime.test_binding().instance);
            let (captured, closed) = timeout(Duration::from_secs(10),async {
                tokio::join!(&mut capture, runtime.close(&identity))
            }).await.map_err(|_|"capture_fault_close_timeout")?;
            closed?;
            let error = captured.err().ok_or("capture_fault_retired_image_returned")?;
            if !instance.browser_has_exited().await? || !matches!(cdp.request("Runtime.getIsolateId",json!({}),Some(&session)).await,Err("browser_cdp_retired")) { return Err("capture_fault_connection_survived_close".into()); }
            receipts.push(json!({"stage":"close-during-encode","error":format!("{error:?}"),"browser_exited":true,"connection_retired":true}));
        }
        Ok(receipts)
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_CAPTURE_FAULTS cancel={cancel} root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    for receipt in evidence.unwrap() {
        if receipt["stage"] == "close-during-encode" {
            assert_eq!(
                receipt["error"], "Observation(\"browser_renderer_lifecycle_changed\")",
                "{receipt}"
            );
        }
        if cancel && receipt["stage"] != "close-during-encode" {
            let cleanup = &receipt["outcome"]["cleanup"];
            assert_eq!(cleanup["closed"], 1, "{receipt}");
            assert_eq!(
                cleanup["written"],
                if receipt["stage"] == "encode-reject" {
                    0
                } else {
                    1
                },
                "{receipt}"
            );
            assert_eq!(cleanup["retained"], false, "{receipt}");
            assert_eq!(cleanup["errorRetained"], false, "{receipt}");
        }
        if !cancel {
            let outcome = &receipt["outcome"];
            assert_eq!(outcome["error"], outcome["expected"], "{receipt}");
            assert_eq!(outcome["cleanup"]["written"], 0, "{receipt}");
            if receipt["stage"] != "decode" {
                assert_eq!(outcome["cleanup"]["closed"], 1, "{receipt}");
                assert_eq!(outcome["cleanup"]["width"], 0, "{receipt}");
                assert_eq!(outcome["cleanup"]["height"], 0, "{receipt}");
            }
        }
    }
}
