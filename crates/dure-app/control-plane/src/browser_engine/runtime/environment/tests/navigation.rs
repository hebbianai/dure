use super::*;
use tokio::time::timeout;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_metrics_resize_navigation_cannot_receive_the_user_agent_step() {
    let (mut runtime, identity, root) = launch("environment:navigation").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/device-navigation",
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
    let (observed, navigation) = oneshot::channel();
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
        let mut observed = Some(observed);
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
                let done = reply["id"] == command["id"];
                if done
                    && command["method"] == "Emulation.setDeviceMetricsOverride"
                    && observed.is_some()
                {
                    assert!(reply.get("result").is_some(), "{reply}");
                    // Delay only the reply until the real resize handler has
                    // committed its navigation. The proxy injects no input.
                    let frame = timeout(Duration::from_secs(2), async {
                        loop {
                            let probe = json!({"id":9999,"method":"Page.getFrameTree","params":{},"sessionId":command["sessionId"]});
                            chrome.send(tokio_tungstenite::tungstenite::Message::Text(probe.to_string().into())).await.unwrap();
                            loop {
                                let message = chrome.next().await.unwrap().unwrap();
                                let tokio_tungstenite::tungstenite::Message::Text(text) = message else { continue; };
                                let response: Value = serde_json::from_str(&text).unwrap();
                                if response["id"] == 9999 {
                                    let frame = &response["result"]["frameTree"]["frame"];
                                    if frame["url"] == "about:blank?device-replacement" { return frame.clone(); }
                                    break;
                                }
                            }
                            sleep(Duration::from_millis(5)).await;
                        }
                    }).await.unwrap();
                    observed.take().unwrap().send(frame).unwrap();
                }
                client.send(message).await.unwrap();
                if done {
                    break;
                }
            }
        }
    });
    let result: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.onresize=()=>location.replace('about:blank?device-replacement');true"})).await?;
        runtime.test_binding_mut().cdp = BrowserCdp::connect(&address).await?;
        let attempted = apply(&runtime,&lease,&page,json!({"kind":"environment","action":{"kind":"device","name":"iPhone 15"}})).await;
        let phase = runtime.control().await.phase;
        let actual = runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"({url:location.href,phone:navigator.userAgent.includes('iPhone'),writes:window.writes??0})"})).await?;
        let later = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.writes=1"})).await;
        Ok((attempted,phase,actual,later))
    }.await;
    let navigation = timeout(Duration::from_secs(5), navigation).await;
    let closed = runtime.close(&identity).await;
    proxy.abort();
    let _ = proxy.await;
    println!(
        "BROWSER_DEVICE_NAVIGATION root={} result={result:?} navigation={navigation:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(matches!(navigation, Ok(Ok(_))));
    let (attempted, phase, actual, later) = result.unwrap();
    assert!(
        matches!(
            attempted,
            Err(BrowserRuntimeError::Engine(BrowserEngineError {
                outcome_unknown: true,
                ..
            }))
        ),
        "{attempted:?}"
    );
    assert_eq!(phase, BrowserResourcePhase::OutcomeUnknown);
    assert_eq!(
        actual["result"],
        json!({"url":"about:blank?device-replacement","phone":false,"writes":0})
    );
    assert!(matches!(
        later,
        Err(BrowserRuntimeError::Admission(
            super::super::super::BrowserAdmissionError::OutcomeUnknown
        ))
    ));
}
