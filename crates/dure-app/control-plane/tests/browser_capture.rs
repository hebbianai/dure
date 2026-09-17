#![cfg(unix)]

use base64::{Engine, engine::general_purpose::STANDARD};
use dure_control_plane::browser_engine::{NativeBrowserEngineConfig, runtime::BrowserRuntime};
use hmux_session_protocol::browser_resource::*;
use serde_json::json;
use std::path::Path;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn detailed_viewport_capture_survives_the_control_message_budget() {
    let root = tempfile::Builder::new()
        .prefix("dure-capture-proof-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("capture:detail").unwrap(),
        generation: BrowserResourceGeneration::new("generation:detail").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:detail").unwrap(),
    };
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, String> = async {
        let control = runtime.request_control(BrowserControllerId::new("capture-proof").unwrap(), None).await.map_err(|e|format!("{e:?}"))?;
        let lease = control.controller.unwrap();
        let page = runtime.observe().await.map_err(|e|format!("{e:?}"))?.pages.remove(0).page;
        let action = serde_json::from_value(json!({"kind":"evaluate","script":"document.body.style.margin='0';const canvas=document.body.appendChild(document.createElement('canvas'));canvas.width=innerWidth;canvas.height=innerHeight;const ctx=canvas.getContext('2d');const image=ctx.createImageData(canvas.width,canvas.height);let value=12345;for(let i=0;i<image.data.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;image.data[i]=i%4===3?255:value&255;}ctx.putImageData(image,0,0);({width:innerWidth,height:innerHeight})"})).unwrap();
        let authority = BrowserActionAuthority {
            lease: lease.clone(), page:page.clone(),
            operation_id: BrowserOperationId::new("capture:setup").unwrap(),
            command_sequence:control.next_command_sequence,
        };
        let setup = runtime.action(&lease.controller_id,&authority,action).await.map_err(|e|format!("{e:?}"))?;
        if !setup.response.success { return Err(format!("setup: {:?}",setup.response)); }
        let capture = runtime.screenshot(&page).await;
        println!("BROWSER_DETAILED_CAPTURE_EVIDENCE {}", json!({"root":root,"dimensions":setup.response.data["result"],"result":capture.as_ref().map(|capture|json!({"base64Bytes":capture["base64"].as_str().map(str::len)})).map_err(|error|format!("{error:?}"))}));
        let capture = capture.map_err(|error|format!("{error:?}"))?;
        std::fs::write(root.join("capture.json"),serde_json::to_vec(&capture).unwrap()).map_err(|e|e.to_string())?;
        Ok(capture["base64"].as_str().unwrap().len())
    }.await;
    let retired = runtime.close(&identity).await;
    assert!(retired.is_ok(), "retirement: {retired:?}");
    assert!(
        evidence
            .as_ref()
            .is_ok_and(|length| *length > 2 * 1024 * 1024),
        "{evidence:?}"
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn scaled_viewport_capture_preserves_native_pixel_ratio() {
    let root = tempfile::Builder::new()
        .prefix("dure-capture-scale-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({"resource_id":"capture:scale","generation":"generation:scale","workspace_id":"workspace:scale"})).unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<_, String> = async {
        let control = runtime.request_control(BrowserControllerId::new("capture-proof").unwrap(), None).await.map_err(|e|format!("{e:?}"))?;
        let lease = control.controller.unwrap();
        let page = runtime.observe().await.map_err(|e|format!("{e:?}"))?.pages.remove(0).page;
        let action = serde_json::from_value(json!({"kind":"environment","action":{"kind":"viewport","width":400,"height":600,"scale":2,"mobile":true}})).unwrap();
        let authority = BrowserActionAuthority { lease: lease.clone(), page:page.clone(), operation_id:BrowserOperationId::new("capture:scale").unwrap(), command_sequence:control.next_command_sequence };
        let applied = runtime.action(&lease.controller_id,&authority,action).await.map_err(|e|format!("{e:?}"))?;
        if !applied.response.success { return Err(format!("viewport: {:?}",applied.response)); }
        let captured = runtime.screenshot(&page).await.map_err(|e|format!("{e:?}"))?;
        let bytes = STANDARD.decode(captured["base64"].as_str().unwrap()).map_err(|e|e.to_string())?;
        std::fs::write(root.join("mobile.png"),&bytes).map_err(|e|e.to_string())?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len()<24 { return Err("invalid PNG".into()); }
        let dimensions = (u32::from_be_bytes(bytes[16..20].try_into().unwrap()),u32::from_be_bytes(bytes[20..24].try_into().unwrap()));
        Ok(dimensions)
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_CAPTURE_SCALE root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(result.unwrap(), (800, 1200));
}
