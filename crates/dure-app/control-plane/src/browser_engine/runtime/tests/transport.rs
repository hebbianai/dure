use super::*;
use crate::browser_engine::cdp::BrowserCdp;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn lost_native_response_fences_the_resource_without_repeating_input() {
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::oneshot;

    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-loss-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let mut runtime = BrowserRuntime::launch(identity("resource:loss"), &config, &root)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/evaluation-loss",
        listener.local_addr().unwrap()
    );
    let upstream = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .chromium
        .endpoint()
        .to_owned();
    let dispatches = Arc::new(AtomicUsize::new(0));
    let observed_dispatches = Arc::clone(&dispatches);
    let (retire, mut retired) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (socket, _) = tokio::select! {
            _ = &mut retired => return,
            socket = listener.accept() => socket.unwrap(),
        };
        let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
        let uri: tokio_tungstenite::tungstenite::http::Uri = upstream.parse().unwrap();
        let socket = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = tokio_tungstenite::client_async(upstream, socket)
            .await
            .unwrap();
        loop {
            let request = tokio::select! {
                _ = &mut retired => break,
                request = client.next() => match request { Some(Ok(request)) if request.is_text() => request, _ => break },
            };
            let command: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            chrome.send(request).await.unwrap();
            loop {
                let message = chrome.next().await.unwrap().unwrap();
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let response: Value = serde_json::from_str(text).unwrap();
                if response["id"] == command["id"] {
                    if command["method"] == "Runtime.evaluate"
                        && command["params"]["expression"] == "++window.responseLossWrites"
                    {
                        assert!(response.get("result").is_some(), "{response}");
                        observed_dispatches.fetch_add(1, Ordering::SeqCst);
                        // Evaluation uses the renderer CDP connection. Discard
                        // its actual acknowledged effect at that transport.
                        client.close(None).await.unwrap();
                        let _ = retired.await;
                        let _ = chrome.close(None).await;
                        return;
                    }
                    client.send(message).await.unwrap();
                    break;
                }
                client.send(message).await.unwrap();
            }
        }
        let _ = chrome.close(None).await;
    });
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        let page = first_page(&runtime).await?;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.responseLossWrites=0"}),
        )
        .await?;
        runtime.test_binding().cdp.retire().await;
        runtime.test_binding_mut().cdp = BrowserCdp::connect(&address).await?;
        let action = json!({"kind":"evaluate","script":"++window.responseLossWrites"});
        let lost = apply(&runtime, &lease, &page, action.clone()).await;
        let control = runtime.control().await;
        let repeated = apply(&runtime, &lease, &page, action).await;
        // Read the fixture's effect directly after the Host has fenced writes.
        // This test-only observation never goes through the product action API.
        let effect = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .require(json!({"action":"evaluate","script":"window.responseLossWrites"}))
            .await?;
        Ok((lost, control, repeated, effect))
    }
    .await;
    let _ = retire.send(());
    let proxy_closed = proxy.await;
    let retired = runtime.close(&identity("resource:loss")).await;
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    println!(
        "BROWSER_EVALUATION_RESPONSE_LOSS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "retirement: {retired:?}");
    let (lost, control, repeated, effect) = evidence.unwrap();
    assert!(matches!(
        lost,
        Err(BrowserRuntimeError::Engine(BrowserEngineError {
            outcome_unknown: true,
            ..
        }))
    ));
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(matches!(
        repeated,
        Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::OutcomeUnknown
        ))
    ));
    assert_eq!(dispatches.load(Ordering::SeqCst), 1);
    assert_eq!(effect["result"], 1);
}
