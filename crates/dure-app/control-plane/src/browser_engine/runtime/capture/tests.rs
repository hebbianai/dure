use super::*;
use crate::browser_engine::NativeBrowserEngineConfig;
use hmux_session_protocol::browser_resource::*;
use std::path::Path;

mod element;
mod faults;
mod frame;

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> Result<Value, BrowserRuntimeError> {
    let sequence = runtime.control().await.next_command_sequence;
    let result = runtime
        .action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("capture:{sequence}")).unwrap(),
            },
            serde_json::from_value(action).unwrap(),
        )
        .await?;
    if !result.response.success {
        return Err("capture_fixture_action_failed".into());
    }
    Ok(result.response.data["result"].clone())
}

const OBSERVE: &str = "({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches,getterCalls:window.getterCalls})";

fn dimensions(bytes: &[u8], jpeg: bool) -> (u32, u32) {
    if !jpeg {
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        return (
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        );
    }
    assert!(bytes.starts_with(&[0xff, 0xd8]));
    let mut offset = 2;
    while offset + 9 < bytes.len() {
        assert_eq!(bytes[offset], 0xff);
        let marker = bytes[offset + 1];
        if matches!(marker, 0xc0..=0xc3) {
            return (
                u32::from(u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]])),
                u32::from(u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]])),
            );
        }
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]);
        offset += 2 + usize::from(length);
    }
    panic!("JPEG dimensions missing");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn scaled_capture_preserves_state_and_bounds_physical_pixels() {
    let root = tempfile::Builder::new()
        .prefix("dure-capture-formats-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({
        "resource_id":"capture:formats","generation":"generation:1","workspace_id":"workspace:1"
    }))
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":400,"height":600,"scale":2,"mobile":true}})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"media","media":"print","color_scheme":"dark"}})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.head.innerHTML='<meta name=viewport content=\"width=device-width,initial-scale=1\">';document.body.style.cssText='margin:0;height:900px;background:linear-gradient(red,blue)';window.getterCalls=0;Object.defineProperty(window,'devicePixelRatio',{configurable:true,get(){window.getterCalls++;return 0.1}});scrollTo(0,120);true"})).await?;
        let before = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?;
        let mut receipts = Vec::new();
        for (full_page,jpeg,expected) in [(false,false,(800,1200)),(true,false,(800,1800)),(true,true,(800,1800))] {
            let control = runtime.control().await;
            let options: ImageCapture = serde_json::from_value(json!({"full_page":full_page,"format":if jpeg {"jpeg"} else {"png"}})).unwrap();
            let CapturedImage { file, viewport, .. } = runtime.capture_image(&page,&options).await?;
            assert_eq!(viewport, json!({"width":400.0,"height":600.0,"pixel_ratio":2.0}));
            let size = dimensions(&file.bytes,jpeg);
            std::fs::write(root.join(format!("{}-{}.{}",size.0,size.1,if jpeg {"jpeg"} else {"png"})),&file.bytes).unwrap();
            let after_control = runtime.control().await;
            assert_eq!(control,after_control);
            let after = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?;
            assert_eq!(after,before);
            assert_eq!(size,expected);
            receipts.push(json!({"full":full_page,"jpeg":jpeg,"dimensions":size,"bytes":file.bytes.len(),"after":after}));
        }
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.style.height='10001px';true"})).await?;
        let control = runtime.control().await;
        let limited = runtime.capture_image(&page,&serde_json::from_value(json!({"full_page":true})).unwrap()).await;
        let limit = limited.as_ref().err().map(|error|format!("{error:?}"));
        println!("BROWSER_CAPTURE_FORMATS {}",json!({"root":root,"captures":receipts,"limit":limit}));
        if !limit.as_ref().is_some_and(|error|error.contains("browser_capture_pixel_limit")) {
            return Err("capture_fixture_pixel_limit_not_enforced".into());
        }
        assert_eq!(runtime.control().await,control);
        assert_eq!(apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?,before);
        Ok(())
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_CAPTURE_FORMATS_RETIRED root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    result.unwrap();
}
