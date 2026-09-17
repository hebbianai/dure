use crate::browser_engine::{cdp::BrowserCdp, chromium::OwnedChromium};
use serde_json::json;
use std::path::Path;

#[tokio::test]
#[ignore = "requires the pinned native Chromium fixture"]
async fn handler_probe_preserves_page_effects_and_observes_native_properties() {
    let root = tempfile::Builder::new()
        .prefix("dure-cursor-handler-probe-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let executable = std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap();
    let mut browser = OwnedChromium::launch(Path::new(&executable), &root)
        .await
        .unwrap();
    let observed = async {
        let page = browser.launch_page().await.map_err(|_| "probe_page")?;
        let mut cdp = BrowserCdp::connect(browser.endpoint()).await?;
        let session = cdp.attach(page.as_str()).await?;
        let group = cdp.object_group(&session)?;
        let mut rows = Vec::new();
        let setup = cdp.request("Runtime.evaluate", json!({"expression":"window.handlerReads=0;window.nativeObject=Object;window.node=document.createElement('div');document.body.appendChild(node);node","objectGroup":group.name()}), Some(&session)).await?;
        let object = setup["result"]["objectId"].as_str().ok_or("probe_object")?;
        for (name, setup) in [
            ("empty", "true"),
            ("property", "node.onclick=()=>{};true"),
            ("own-getter", "nativeObject.defineProperty(node,'onclick',{configurable:true,get(){handlerReads++;return null}});true"),
            ("pure-prototype-getter", "nativeObject.defineProperty(HTMLElement.prototype,'onclick',{configurable:true,get(){return null}});true"),
            ("prototype-getter", "nativeObject.defineProperty(HTMLElement.prototype,'onclick',{configurable:true,get(){handlerReads++;return null}});true"),
            ("global-getter", "nativeObject.defineProperty(window,'Object',{configurable:true,get(){handlerReads++;return nativeObject}});true"),
        ] {
            cdp.request("Runtime.evaluate", json!({"expression":setup}), Some(&session)).await?;
            let result = cdp.request("Runtime.callFunctionOn", json!({
                "objectId":object,"functionDeclaration":include_str!("handler.js"),
                "returnByValue":true,"throwOnSideEffect":true,"silent":true,"objectGroup":group.name()
            }), Some(&session)).await?;
            let reads = cdp.request("Runtime.evaluate", json!({"expression":"handlerReads","returnByValue":true}), Some(&session)).await?;
            rows.push(json!({"name":name,"result":result,"reads":reads["result"]["value"]}));
        }
        drop(group);
        cdp.retire().await;
        Ok::<_, &'static str>(rows)
    }.await;
    let retired = browser.close().await;
    println!(
        "BROWSER_CURSOR_HANDLER_PROBE {}",
        json!({"root":root,"observation":observed,"retired":format!("{retired:?}")})
    );
    assert!(retired.is_ok(), "{retired:?}");
    let rows = observed.unwrap();
    assert!(rows.iter().all(|row| row["reads"] == 0), "{rows:?}");
    assert_eq!(rows[0]["result"]["result"]["value"], false, "{rows:?}");
    for row in &rows[1..4] {
        assert_eq!(row["result"]["result"]["value"], true, "{row:?}");
    }
    for row in &rows[4..] {
        assert!(row["result"].get("exceptionDetails").is_some(), "{row:?}");
    }
}
