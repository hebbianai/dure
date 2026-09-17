use super::*;
use crate::browser_engine::NativeBrowserEngineConfig;
use futures_util::{SinkExt, StreamExt};
use hmux_session_protocol::browser_resource::*;
use std::path::Path;
use tokio::{
    net::TcpListener,
    sync::oneshot,
    time::{Duration, sleep},
};

mod navigation;
mod peers;

async fn launch(name: &str) -> (BrowserRuntime, BrowserResourceIdentity, std::path::PathBuf) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-environment-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({
        "resource_id":name,"generation":"generation:1","workspace_id":"workspace:1",
    }))
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    (runtime, identity, root)
}

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> Result<super::super::BrowserActionResult, BrowserRuntimeError> {
    let sequence = runtime.control().await.next_command_sequence;
    runtime
        .action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("environment:{sequence}")).unwrap(),
            },
            serde_json::from_value(action).unwrap(),
        )
        .await
}

const OBSERVE: &str = "({width:innerWidth,height:innerHeight,print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches})";

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn overrides_need_the_target_session_and_retire_with_the_page() {
    let (runtime, identity, root) = launch("environment:lifetime").await;
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let original = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?.response.data["result"].clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut temporary = BrowserCdp::connect(&endpoint).await?;
        let session = temporary.attach(target.as_str()).await?;
        temporary.request("Emulation.setDeviceMetricsOverride",json!({"width":777,"height":551,"deviceScaleFactor":1,"mobile":false}),Some(&session)).await?;
        temporary.request("Emulation.setEmulatedMedia",json!({"media":"print","features":[{"name":"prefers-color-scheme","value":"dark"}]}),Some(&session)).await?;
        let during = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?.response.data["result"].clone();
        drop(temporary);
        sleep(Duration::from_millis(100)).await;
        let after = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?.response.data["result"].clone();
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"viewport","width":777,"height":551}})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"media","media":"print","color_scheme":"dark"}})).await?;
        // The cleanup worker releases scoped handles asynchronously without
        // detaching the retained session or clearing its emulation.
        let mut cdp = runtime.test_binding().cdp.clone();
        let session = cdp.attach(target.as_str()).await?;
        let group = cdp.object_group(&session)?;
        let object = cdp.request("Runtime.evaluate",json!({"expression":"document.body","objectGroup":group.name()}),Some(&session)).await?;
        let object = object["result"]["objectId"].as_str().ok_or("fixture_remote_object_missing")?;
        drop(group);
        let released = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let observed = cdp.request("Runtime.callFunctionOn",json!({"objectId":object,"functionDeclaration":"function(){return this.tagName}","returnByValue":true}),Some(&session)).await;
                if observed.is_err() { break observed; }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_| "fixture_object_release_timeout")?;
        let retained = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":OBSERVE})).await?.response.data["result"].clone();

        apply(&runtime,&lease,&page,json!({"kind":"new_page","url":"about:blank"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"close_page"})).await?;
        runtime.observe().await?;
        let absent = !runtime.observe().await?.pages.iter().any(|entry|entry.page.page_id==page.page_id);
        Ok((released,json!({"original":original,"temporaryAttached":during,"temporaryDetached":after,"runtimeRetained":retained,"closedPageAbsent":absent})))
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_ENVIRONMENT_LIFETIME root={} result={result:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(
        runtime
            .test_binding()
            .cdp
            .clone()
            .request("Browser.getVersion", json!({}), None)
            .await,
        Err("browser_cdp_retired")
    );
    let (released, evidence) = result.unwrap();
    assert_eq!(released, Err("browser_cdp_request_rejected"));
    assert_eq!(
        evidence["temporaryAttached"],
        json!({"width":777,"height":551,"print":true,"dark":true})
    );
    assert_eq!(evidence["temporaryDetached"]["print"], false);
    assert_eq!(evidence["temporaryDetached"]["width"], 777);
    assert_eq!(evidence["runtimeRetained"], evidence["temporaryAttached"]);
    assert_eq!(evidence["closedPageAbsent"], true);
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_lost_emulation_reply_fences_input_after_the_actual_effect() {
    lost_reply(
        json!({"kind":"media","media":"print"}),
        "Emulation.setEmulatedMedia",
        "({print:matchMedia('print').matches,writes:window.writes})",
        json!({"print":true,"writes":0}),
    )
    .await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_lost_offline_reply_fences_input_after_the_actual_effect() {
    lost_reply(
        json!({"kind":"offline","offline":true}),
        "Network.emulateNetworkConditions",
        "({online:navigator.onLine,writes:window.writes})",
        json!({"online":false,"writes":0}),
    )
    .await;
}

async fn lost_reply(action: Value, method: &'static str, observe: &'static str, expected: Value) {
    fault_reply(action, method, observe, expected, false).await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn lost_device_metrics_reply_does_not_dispatch_the_user_agent_step() {
    lost_reply(
        json!({"kind":"device","name":"iPhone 15"}),
        "Emulation.setDeviceMetricsOverride",
        "({width:screen.width,phone:navigator.userAgent.includes('iPhone'),writes:window.writes})",
        json!({"width":393,"phone":false,"writes":0}),
    )
    .await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn lost_device_user_agent_reply_fences_after_both_actual_effects() {
    lost_reply(
        json!({"kind":"device","name":"iPhone 15"}),
        "Emulation.setUserAgentOverride",
        "({width:screen.width,phone:navigator.userAgent.includes('iPhone'),writes:window.writes})",
        json!({"width":393,"phone":true,"writes":0}),
    )
    .await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn rejected_user_agent_after_applied_metrics_is_an_incomplete_device_action() {
    fault_reply(
        json!({"kind":"device","name":"iPhone 15"}),
        "Emulation.setUserAgentOverride",
        "({width:screen.width,phone:navigator.userAgent.includes('iPhone'),writes:window.writes})",
        json!({"width":393,"phone":false,"writes":0}),
        true,
    )
    .await;
}

async fn fault_reply(
    action: Value,
    method: &'static str,
    observe: &'static str,
    expected: Value,
    reject: bool,
) {
    let (mut runtime, identity, root) = launch("environment:loss").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/environment-loss",
        listener.local_addr().unwrap()
    );
    let actual = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .chromium
        .endpoint()
        .to_owned();
    let (retire, retired) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
        let uri: tokio_tungstenite::tungstenite::http::Uri = actual.parse().unwrap();
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = tokio_tungstenite::client_async(actual, stream)
            .await
            .unwrap();
        while let Some(request) = client.next().await {
            let request = request.unwrap();
            let command: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            if reject && command["method"] == method {
                let response = json!({"id":command["id"],"sessionId":command["sessionId"],"error":{"code":-32000,"message":"fixture rejection"}});
                client
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        response.to_string().into(),
                    ))
                    .await
                    .unwrap();
                effect.send(response).unwrap();
                let _ = retired.await;
                let _ = chrome.close(None).await;
                return;
            }
            chrome.send(request).await.unwrap();
            loop {
                let message = chrome.next().await.unwrap().unwrap();
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let response: Value = serde_json::from_str(text).unwrap();
                if response["id"] == command["id"] {
                    if command["method"] == method {
                        assert!(response.get("result").is_some(), "{response}");
                        let inspect = json!({"id":9999,"method":"Runtime.evaluate","params":{"expression":observe,"returnByValue":true},"sessionId":command["sessionId"]});
                        chrome
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                inspect.to_string().into(),
                            ))
                            .await
                            .unwrap();
                        loop {
                            let message = chrome.next().await.unwrap().unwrap();
                            let Ok(text) = message.to_text() else {
                                continue;
                            };
                            let observed: Value = serde_json::from_str(text).unwrap();
                            if observed["id"] == 9999 {
                                println!("ENVIRONMENT_PROXY_DIAG {observed}");
                                break;
                            }
                        }
                        effect.send(response).unwrap();
                        client.close(None).await.unwrap();
                        let _ = retired.await;
                        let _ = chrome.close(None).await;
                        return;
                    }
                    client.send(message).await.unwrap();
                    break;
                }
            }
        }
    });
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.writes=0;true"}),
        )
        .await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let mut cdp = BrowserCdp::connect(&address).await?;
        cdp.attach(target.as_str()).await?;
        runtime.test_binding_mut().cdp = cdp;
        let lost = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"environment","action":action}),
        )
        .await;
        let phase = runtime.control().await.phase;
        let later = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"++window.writes"}),
        )
        .await;
        let actual = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .require(json!({"action":"evaluate","script":observe}))
            .await?;
        Ok((lost, phase, later, actual))
    }
    .await;
    let _ = retire.send(());
    let effect = observed_effect.await;
    let proxy = proxy.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_ENVIRONMENT_LOSS root={} result={result:?} effect={effect:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    proxy.unwrap();
    effect.unwrap();
    let (lost, phase, later, actual) = result.unwrap();
    assert!(matches!(
        lost,
        Err(BrowserRuntimeError::Engine(BrowserEngineError {
            outcome_unknown: true,
            ..
        }))
    ));
    assert_eq!(phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(matches!(
        later,
        Err(BrowserRuntimeError::Admission(
            super::super::BrowserAdmissionError::OutcomeUnknown
        ))
    ));
    assert_eq!(actual["result"], expected);
}
