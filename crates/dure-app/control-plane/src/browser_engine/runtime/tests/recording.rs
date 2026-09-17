use super::*;
use crate::browser_engine::cdp::BrowserCdp;
use base64::{Engine, engine::general_purpose::STANDARD};

mod core;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn native_screen_recording_returns_an_owned_video_stream() {
    let root = tempfile::Builder::new()
        .prefix("dure-recording-probe-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity = identity("recording:probe");
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let address = endpoint.strip_prefix("ws://").ok_or("recording_fixture_endpoint")?.split('/').next().unwrap();
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().map_err(|_| "recording_fixture_protocol_client")?;
        let protocol = client.get(format!("http://{address}/json/protocol")).send().await.map_err(|_| "recording_fixture_protocol_response")?.error_for_status().map_err(|_| "recording_fixture_protocol_status")?.bytes().await.map_err(|_| "recording_fixture_protocol_read")?;
        std::fs::write(root.join("protocol.json"),protocol).unwrap();
        let mut cdp = BrowserCdp::connect(&endpoint).await?;
        let session = cdp.attach(target.as_str()).await?;
        cdp.request("Page.enable",json!({}),Some(&session)).await?;
        let setup = cdp.request("Runtime.evaluate",json!({"expression":"document.body.style.background='red';window.recordingChanges=0;window.recordingTimer=setInterval(()=>{document.body.style.background=++recordingChanges%2?'blue':'red'},100);true","returnByValue":true}),Some(&session)).await?;
        let started = cdp.request("Page.startScreenRecording",json!({"audio":false,"maxWidth":400,"maxHeight":300,"frameRate":10}),Some(&session)).await;
        println!("BROWSER_RECORDING_PROBE_STARTED root={} result={started:?}",root.display());
        let result: Result<_, BrowserRuntimeError> = async {
            let started = started?;
            let duplicate_start = cdp.request("Page.startScreenRecording",json!({"audio":false}),Some(&session)).await;
            if duplicate_start != Err("browser_cdp_request_rejected") { return Err("recording_fixture_duplicate_start_admitted".into()); }
            sleep(Duration::from_millis(650)).await;
            let stopped = cdp.request("Page.stopScreenRecording",json!({}),Some(&session)).await?;
            println!("BROWSER_RECORDING_PROBE_STOPPED result={stopped:?}");
            let stream = stopped["stream"].as_str().ok_or("recording_fixture_stream_missing")?;
            let duplicate_stop = cdp.request("Page.stopScreenRecording",json!({}),Some(&session)).await;
            if duplicate_stop != Err("browser_cdp_request_rejected") { return Err("recording_fixture_duplicate_stop_admitted".into()); }
            let wrong_session = cdp.request("IO.read",json!({"handle":stream,"size":64}),None).await;
            if wrong_session != Err("browser_cdp_request_rejected") { return Err("recording_fixture_foreign_stream_read".into()); }
            let mut bytes = Vec::new();
            let read: Result<_,BrowserRuntimeError> = timeout(Duration::from_secs(5),async {
                loop {
                    let chunk = cdp.request("IO.read",json!({"handle":stream,"size":65536}),Some(&session)).await?;
                    let data=chunk["data"].as_str().ok_or("recording_fixture_chunk_missing")?;
                    if chunk["base64Encoded"]==true {
                        bytes.extend(STANDARD.decode(data).map_err(|_| "recording_fixture_chunk_invalid")?);
                    } else { bytes.extend(data.as_bytes()); }
                    if bytes.len()>8*1024*1024 { return Err("recording_fixture_byte_limit".into()); }
                    if chunk["eof"]==true { return Ok(()); }
                }
            }).await.unwrap_or(Err("recording_fixture_read_timeout".into()));
            let closed = cdp.request("IO.close",json!({"handle":stream}),Some(&session)).await;
            read?;
            closed?;
            let after_close = cdp.request("IO.read",json!({"handle":stream,"size":64}),Some(&session)).await;
            if after_close != Err("browser_cdp_request_rejected") { return Err("recording_fixture_closed_stream_read".into()); }
            std::fs::write(root.join("recording.bin"),&bytes).unwrap();
            let decoded = decode_video(&mut cdp, &session, &bytes).await?;
            std::fs::write(root.join("decoded.json"),serde_json::to_vec_pretty(&decoded).unwrap()).unwrap();
            Ok(json!({"setup":setup,"started":started,"stopped":stopped,"size":bytes.len(),"prefix":bytes.iter().take(32).copied().collect::<Vec<_>>(),"decoded":decoded}))
        }.await;
        cdp.retire().await;
        result
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_RECORDING_PROBE root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let evidence = evidence.unwrap();
    assert!(evidence["size"].as_u64().unwrap() > 128, "{evidence}");
    let decoded = &evidence["decoded"]["result"]["value"];
    assert!(
        decoded["duration"].as_f64().is_some_and(|v| v > 0.0),
        "{evidence}"
    );
    assert!(
        decoded["width"].as_u64().is_some_and(|v| v > 0 && v <= 400),
        "{evidence}"
    );
    assert!(
        decoded["height"]
            .as_u64()
            .is_some_and(|v| v > 0 && v <= 300),
        "{evidence}"
    );
    let samples = decoded["samples"].as_array().unwrap();
    assert!(
        samples
            .iter()
            .any(|p| p[0].as_u64().unwrap() > 200 && p[2].as_u64().unwrap() < 40),
        "{evidence}"
    );
    assert!(
        samples
            .iter()
            .any(|p| p[2].as_u64().unwrap() > 200 && p[0].as_u64().unwrap() < 40),
        "{evidence}"
    );
}

async fn decode_video(
    cdp: &mut BrowserCdp,
    session: &str,
    bytes: &[u8],
) -> Result<Value, BrowserRuntimeError> {
    decode_video_as(cdp, session, bytes, "video/mp4").await
}

async fn decode_video_as(
    cdp: &mut BrowserCdp,
    session: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<Value, BrowserRuntimeError> {
    let encoded = STANDARD.encode(bytes);
    let script = format!(
        r#"(async()=>{{const bytes=Uint8Array.from(atob({}),x=>x.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{{type:{}}}));const video=document.createElement('video');video.muted=true;try{{const ready=new Promise((resolve,reject)=>{{video.onloadeddata=resolve;video.onerror=()=>reject(Error('decode failed'));}});video.src=url;await ready;const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');const samples=[];for(let i=0;i<12;i++){{const next=new Promise(resolve=>video.onseeked=resolve);video.currentTime=video.duration*(i+0.5)/12;await next;ctx.drawImage(video,0,0);samples.push([...ctx.getImageData(canvas.width/2,canvas.height/2,1,1).data]);}}return{{width:canvas.width,height:canvas.height,duration:video.duration,samples}};}}finally{{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}}}})()"#,
        json!(encoded),
        json!(mime)
    );
    Ok(cdp
        .request(
            "Runtime.evaluate",
            json!({"expression":script,"awaitPromise":true,"returnByValue":true}),
            Some(session),
        )
        .await?)
}
