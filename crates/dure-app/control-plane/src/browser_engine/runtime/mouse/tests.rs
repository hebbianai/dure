use super::*;
use crate::browser_engine::NativeBrowserEngineConfig;
use futures_util::{SinkExt, StreamExt};
use hmux_session_protocol::browser_resource::*;
use std::path::Path;
use tokio::{net::TcpListener, sync::oneshot};

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
                operation_id: BrowserOperationId::new(format!("mouse:{sequence}")).unwrap(),
            },
            serde_json::from_value(action).unwrap(),
        )
        .await
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_lost_release_reply_prevents_controller_transfer_after_the_actual_effect() {
    release_loss(false).await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_lost_key_release_reply_prevents_controller_transfer_after_the_actual_effect() {
    release_loss(true).await;
}

async fn release_loss(keyboard: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-pointer-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity:BrowserResourceIdentity=serde_json::from_value(json!({"resource_id":"pointer:loss","generation":"generation:1","workspace_id":"workspace:1"})).unwrap();
    let mut runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/pointer-loss",
        listener.local_addr().unwrap()
    );
    let endpoint = runtime
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
        let uri: tokio_tungstenite::tungstenite::http::Uri = endpoint.parse().unwrap();
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = tokio_tungstenite::client_async(endpoint, stream)
            .await
            .unwrap();
        while let Some(Ok(message)) = client.next().await {
            let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                continue;
            };
            let command: Value = serde_json::from_str(&text).unwrap();
            chrome
                .send(tokio_tungstenite::tungstenite::Message::Text(text))
                .await
                .unwrap();
            while let Some(Ok(message)) = chrome.next().await {
                let tokio_tungstenite::tungstenite::Message::Text(ref text) = message else {
                    continue;
                };
                let reply: Value = serde_json::from_str(text).unwrap();
                if reply["id"] == command["id"]
                    && command["method"]
                        == if keyboard {
                            "Input.dispatchKeyEvent"
                        } else {
                            "Input.dispatchMouseEvent"
                        }
                    && command["params"]["type"] == if keyboard { "keyUp" } else { "mouseReleased" }
                {
                    assert!(reply.get("result").is_some(), "{reply}");
                    effect.send(reply).unwrap();
                    client.close(None).await.unwrap();
                    let _ = retired.await;
                    return;
                }
                let done = reply["id"] == command["id"];
                client.send(message).await.unwrap();
                if done {
                    break;
                }
            }
        }
    });
    let result:Result<_,BrowserRuntimeError>=async {
        let page=runtime.observe().await?.pages[0].page.clone();
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=target style=\"position:fixed;left:100px;top:100px;width:100px;height:100px\">Contact</button>';window.ups=0;window.clicks=0;window.writes=0;document.addEventListener('pointerup',()=>window.ups++);document.addEventListener('keyup',()=>window.ups++);document.addEventListener('click',()=>window.clicks++);true"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"hover","target":{"kind":"css","selector":"#target"}})).await?;
        apply(&runtime,&lease,&page,if keyboard {json!({"kind":"key_down","key":"Shift"})} else {json!({"kind":"mouse","action":{"kind":"down"}})}).await?;
        runtime.test_binding_mut().cdp =BrowserCdp::connect(&address).await?;
        let transfer=runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await;
        let control=runtime.control().await;
        let later=apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"++window.writes"})).await;
        let actual=runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"({ups:window.ups,clicks:window.clicks,writes:window.writes})"})).await?;
        Ok((transfer,control,later,actual))
    }.await;
    let _ = retire.send(());
    let effect = tokio::time::timeout(std::time::Duration::from_secs(5), observed_effect).await;
    if effect.is_err() {
        proxy.abort();
    }
    let proxy = proxy.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_POINTER_RELEASE_LOSS keyboard={keyboard} root={} result={result:?} effect={effect:?} proxy={proxy:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(proxy.is_ok());
    assert!(matches!(effect, Ok(Ok(_))));
    let (transfer, control, later, actual) = result.unwrap();
    assert!(matches!(
        transfer,
        Err(BrowserRuntimeError::Engine(BrowserEngineError {
            outcome_unknown: true,
            ..
        }))
    ));
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert_eq!(control.controller.unwrap().controller_id.as_str(), "agent");
    assert_eq!(control.requested_controller.unwrap().as_str(), "human");
    assert!(matches!(
        later,
        Err(BrowserRuntimeError::Admission(
            hmux_host::browser_resource::BrowserAdmissionError::OutcomeUnknown
        ))
    ));
    assert_eq!(
        actual["result"],
        json!({"ups":1,"clicks":if keyboard {0} else {1},"writes":0})
    );
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn current_page_wheel_retains_capture_geometry_serialization() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-wheel-capture-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity: BrowserResourceIdentity = serde_json::from_value(
        json!({"resource_id":"wheel:capture","generation":"g","workspace_id":"w"}),
    )
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime.request_control(BrowserControllerId::new("wheel-agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.body.style.height='10000px';true"})).await?;
        let binding = runtime.test_binding();
        let engine = binding.engine.lock().await;
        let mut wheel = Box::pin(apply(&runtime, &lease, &page, json!({"kind":"mouse","action":{"kind":"wheel","x":100,"y":100,"delta_y":120}})));
        let early = tokio::time::timeout(std::time::Duration::from_secs(1), &mut wheel).await;
        let serialized_wheel = early.is_err();
        drop(engine);
        let delivered = match early { Ok(result) => result?, Err(_) => wheel.await? };
        if !delivered.response.success { return Err("wheel_fixture_dispatch_failed".into()); }
        let observed = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(scrollY))))"})).await?;
        // Input that can change capture geometry must retain the engine lock.
        apply(&runtime, &lease, &page, json!({"kind":"key_down","key":"Control"})).await?;
        let engine = binding.engine.lock().await;
        let mut modified = Box::pin(apply(&runtime, &lease, &page, json!({"kind":"mouse","action":{"kind":"wheel","x":100,"y":100,"delta_y":1}})));
        let early = tokio::time::timeout(std::time::Duration::from_millis(100), &mut modified).await;
        let serialized = early.is_err();
        drop(engine);
        match early { Ok(result) => result?, Err(_) => modified.await? };
        apply(&runtime, &lease, &page, json!({"kind":"key_up","key":"Control"})).await?;
        Ok((serialized_wheel, observed.response.data["result"].clone(), serialized))
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_WHEEL_CAPTURE root={} result={result:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    let (serialized_wheel, scrolled, serialized) = result.unwrap();
    assert!(
        serialized,
        "modified wheels retain capture geometry serialization"
    );
    assert_eq!(scrolled, 120);
    assert!(
        serialized_wheel,
        "wheel input must wait until capture restores the admitted page geometry"
    );
}

mod navigation;
