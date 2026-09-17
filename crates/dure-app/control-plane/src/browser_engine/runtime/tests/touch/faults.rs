use super::*;
use crate::browser_engine::cdp::BrowserCdp;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn a_lost_touch_start_reply_cannot_grant_another_controller() {
    lost_touch_reply(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn a_lost_touch_cancel_reply_cannot_complete_human_handoff() {
    lost_touch_reply(false).await;
}

async fn lost_touch_reply(start: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-touch-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("touch:loss");
    let mut runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let endpoint = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .chromium
        .endpoint()
        .to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/touch-loss",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let (effect, observed_effect) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
        let uri: tokio_tungstenite::tungstenite::http::Uri = endpoint.parse().unwrap();
        let socket = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = tokio_tungstenite::client_async(endpoint, socket)
            .await
            .unwrap();
        while let Some(Ok(message)) = client.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let command: Value = serde_json::from_str(&text).unwrap();
            chrome.send(Message::Text(text)).await.unwrap();
            while let Some(Ok(message)) = chrome.next().await {
                let Message::Text(ref text) = message else {
                    continue;
                };
                let reply: Value = serde_json::from_str(text).unwrap();
                let done = reply["id"] == command["id"];
                if done
                    && command["method"] == "Input.dispatchTouchEvent"
                    && command["params"]["type"] == if start { "touchStart" } else { "touchCancel" }
                {
                    assert!(reply.get("result").is_some(), "{reply}");
                    // The real browser applied input. Lose only its matching reply.
                    effect.send(reply).unwrap();
                    client.close(None).await.unwrap();
                    let _ = stopped.await;
                    return;
                }
                client.send(message).await.unwrap();
                if done {
                    break;
                }
            }
        }
    });
    let evidence:Result<_,BrowserRuntimeError>=async {
        let page=first_page(&runtime).await?;
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":PAGE})).await?;
        // Retain one actual CDP session from contact start through cancellation.
        runtime.test_binding_mut().cdp=BrowserCdp::connect(&address).await?;
        let rejected=if start {
            let attempted=apply(&runtime,&lease,&page,json!({"kind":"tap","target":{"kind":"css","selector":"button"}})).await;
            matches!(attempted,Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown)
        } else {
            let admission=authority(&runtime,&lease,&page).await;
            let permit=runtime.host.lock().await.begin_action(&lease.controller_id,&admission,[])?;
            runtime.execution(&page).await?.touch_event(&permit,TouchAction::Start{x:150.0,y:150.0}).await?;
            runtime.host.lock().await.finish_action(permit,BrowserActionOutcome::Completed)?;
            let transferred=runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await;
            matches!(transferred,Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown)
        };
        let control=runtime.control().await;
        let refused=runtime.request_control(BrowserControllerId::new("human").unwrap(),Some(&lease)).await;
        let actual=runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"({trace:window.trace,clicks:window.clicks})"})).await?;
        Ok(json!({"rejected":rejected,"control":control,"refused":matches!(refused,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::OutcomeUnknown))),"actual":actual["result"]}))
    }.await;
    let _ = stop.send(());
    let effect = timeout(Duration::from_secs(5), observed_effect).await;
    if effect.is_err() {
        proxy.abort();
    }
    let proxy = proxy.await;
    let closed = runtime.close(&resource).await;
    println!(
        "BROWSER_TOUCH_LOSS start={start} root={} evidence={evidence:?} effect={effect:?} proxy={proxy:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(matches!(effect, Ok(Ok(_))));
    assert!(proxy.is_ok(), "{proxy:?}");
    let result = evidence.unwrap();
    assert_eq!(result["rejected"], true);
    assert_eq!(result["refused"], true);
    assert_eq!(result["control"]["phase"], "outcome_unknown");
    assert_eq!(result["control"]["controller"]["controller_id"], "agent");
    if !start {
        assert_eq!(result["control"]["requested_controller"], "human");
    }
    assert_eq!(result["actual"]["clicks"], 0);
    let kind = if start { "touchstart" } else { "touchcancel" };
    assert_eq!(
        result["actual"]["trace"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == kind && e["trusted"] == true)
            .count(),
        1
    );
}
