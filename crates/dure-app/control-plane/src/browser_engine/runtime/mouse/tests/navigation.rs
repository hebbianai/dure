use super::*;
use tokio::time::{Duration, sleep, timeout};

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_release_navigation_cannot_receive_the_admitted_close() {
    release_navigation(false).await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_key_release_navigation_cannot_receive_the_admitted_close() {
    release_navigation(true).await;
}

async fn release_navigation(keyboard: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-pointer-navigation-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity:BrowserResourceIdentity=serde_json::from_value(json!({"resource_id":"pointer:navigation","generation":"generation:1","workspace_id":"workspace:1"})).unwrap();
    let mut runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/pointer-navigation",
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
                    && command["method"]
                        == if keyboard {
                            "Input.dispatchKeyEvent"
                        } else {
                            "Input.dispatchMouseEvent"
                        }
                    && command["params"]["type"] == if keyboard { "keyUp" } else { "mouseReleased" }
                    && observed.is_some()
                {
                    assert!(reply.get("result").is_some(), "{reply}");
                    // Observe the page handler's real navigation before forwarding
                    // the release reply. No new input/navigation is injected.
                    let frame=timeout(Duration::from_secs(2),async {
                        loop {
                            let probe=json!({"id":9999,"method":"Page.getFrameTree","params":{},"sessionId":command["sessionId"]});
                            chrome.send(tokio_tungstenite::tungstenite::Message::Text(probe.to_string().into())).await.unwrap();
                            loop {
                                let message=chrome.next().await.unwrap().unwrap();
                                let tokio_tungstenite::tungstenite::Message::Text(text)=message else {continue;};
                                let response:Value=serde_json::from_str(&text).unwrap();
                                if response["id"]==9999 {
                                    let frame=&response["result"]["frameTree"]["frame"];
                                    if frame["url"]=="about:blank?pointer-replacement" {return frame.clone();}
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
    let result:Result<_,BrowserRuntimeError>=async {
        let page=runtime.observe().await?.pages[0].page.clone();
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=target style=\"position:fixed;left:100px;top:100px;width:100px;height:100px\">Navigate on release</button>';document.querySelector('#target').onpointerup=()=>location.replace('about:blank?pointer-replacement');document.addEventListener('keyup',()=>location.replace('about:blank?pointer-replacement'));true"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"new_page","url":"about:blank"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"hover","target":{"kind":"css","selector":"#target"}})).await?;
        apply(&runtime,&lease,&page,if keyboard {json!({"kind":"key_down","key":"Shift"})} else {json!({"kind":"mouse","action":{"kind":"down"}})}).await?;
        runtime.test_binding_mut().cdp =BrowserCdp::connect(&address).await?;
        let attempted=apply(&runtime,&lease,&page,json!({"kind":"close_page"})).await;
        let after=runtime.observe().await?;
        Ok((page,attempted,after))
    }.await;
    let navigation = timeout(Duration::from_secs(5), navigation).await;
    let closed = runtime.close(&identity).await;
    proxy.abort();
    let _ = proxy.await;
    println!(
        "BROWSER_POINTER_NAVIGATION keyboard={keyboard} root={} result={result:?} actualNavigation={navigation:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    assert!(matches!(navigation, Ok(Ok(_))));
    let (page, attempted, after) = result.unwrap();
    assert!(
        matches!(
            attempted,
            Err(BrowserRuntimeError::Admission(
                hmux_host::browser_resource::BrowserAdmissionError::DocumentChanged
            ))
        ),
        "{attempted:?}"
    );
    assert!(after.pages.iter().any(|p| p.page.page_id == page.page_id
        && p.page.document_revision != page.document_revision
        && p.url == "about:blank?pointer-replacement"));
}
