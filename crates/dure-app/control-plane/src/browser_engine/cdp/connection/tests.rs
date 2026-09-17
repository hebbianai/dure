use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::oneshot};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::Message,
    tungstenite::protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    },
};

mod frame;

async fn pair() -> (Connection, WebSocketStream<TcpStream>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/budget",
        listener.local_addr().unwrap()
    );
    let server = async {
        let (socket, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(socket).await.unwrap()
    };
    let (client, server) = tokio::join!(Connection::connect(&address), server);
    (client.unwrap(), server)
}

async fn request(server: &mut WebSocketStream<TcpStream>) -> Value {
    loop {
        if let Message::Text(text) = server.next().await.unwrap().unwrap() {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

#[tokio::test]
async fn stream_read_failure_is_distinct_from_invalid_handles_and_other_requests() {
    let (client, mut server) = pair().await;
    let cases = [
        (
            "IO.read",
            -32000,
            "Read failed",
            "browser_cdp_stream_read_failed",
        ),
        (
            "IO.read",
            -32602,
            "Read failed",
            "browser_cdp_request_rejected",
        ),
        (
            "IO.read",
            -32602,
            "Invalid stream handle",
            "browser_cdp_request_rejected",
        ),
        (
            "IO.read",
            -32000,
            "Read failed. more",
            "browser_cdp_request_rejected",
        ),
        (
            "Page.captureScreenshot",
            -32000,
            "Read failed",
            "browser_cdp_request_rejected",
        ),
        (
            "IO.close",
            -32000,
            "Read failed",
            "browser_cdp_request_rejected",
        ),
    ];
    let peer = tokio::spawn(async move {
        for (_, code, message, _) in cases {
            let request = request(&mut server).await;
            server
                .send(Message::text(
                    json!({"id":request["id"],"error":{"code":code,"message":message}}).to_string(),
                ))
                .await
                .unwrap();
        }
    });
    let mut results = Vec::new();
    for (method, _, _, expected) in cases {
        results.push((
            client.request(method, json!({}), Some("source")).await,
            expected,
        ));
    }
    client.retire().await;
    peer.await.unwrap();
    for (result, expected) in results {
        assert_eq!(result, Err(expected));
    }
}

#[tokio::test]
async fn interception_gone_is_distinct_from_other_native_rejections() {
    let (client, mut server) = pair().await;
    let peer = tokio::spawn(async move {
        for error in [
            json!({"code":-32602,"message":"Invalid InterceptionId."}),
            json!({"code":-32000,"message":"Invalid InterceptionId."}),
            json!({"code":-32602,"message":"Invalid parameters"}),
            json!({"code":-32602,"message":"Invalid InterceptionId. additional data"}),
        ] {
            let request = request(&mut server).await;
            server
                .send(Message::text(
                    json!({"id":request["id"],"error":error}).to_string(),
                ))
                .await
                .unwrap();
        }
        let request = request(&mut server).await;
        server
            .send(Message::text(
                json!({"id":request["id"],"result":{"retained":true}}).to_string(),
            ))
            .await
            .unwrap();
    });
    let mut results = Vec::new();
    for _ in 0..4 {
        results.push(
            client
                .request(
                    "Fetch.continueRequest",
                    json!({"requestId":"observed"}),
                    Some("source"),
                )
                .await,
        );
    }
    let retained = client
        .request("Runtime.getIsolateId", json!({}), Some("source"))
        .await;
    client.retire().await;
    peer.await.unwrap();
    assert_eq!(results[0], Err("browser_cdp_interception_gone"));
    for result in &results[1..] {
        assert_eq!(*result, Err("browser_cdp_request_rejected"));
    }
    assert_eq!(retained.unwrap()["retained"], true);
}

async fn header(server: &mut WebSocketStream<TcpStream>, length: usize) {
    // No payload is sent. A size rejection must happen from the header while
    // the peer stays open, rather than after allocation, EOF or a timeout.
    let mut bytes = vec![0x81, 127];
    bytes.extend((length as u64).to_be_bytes());
    server.get_mut().write_all(&bytes).await.unwrap();
}

#[tokio::test]
async fn dom_snapshot_admits_bulk_reply_and_restores_control_limit() {
    let (client, mut server) = pair().await;
    let (retire, retired) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let snapshot = request(&mut server).await;
        assert_eq!(snapshot["method"], "DOMSnapshot.captureSnapshot");
        assert_eq!(snapshot["sessionId"], "same-session");
        let reply = json!({
            "id":snapshot["id"],
            "result":{"strings":["x".repeat(3 * 1024 * 1024)],"documents":[]}
        });
        if server.send(Message::text(reply.to_string())).await.is_err() {
            return;
        }
        tokio::select! {
            biased;
            _ = retired => {},
            message = server.next() => {
                if let Some(Ok(Message::Text(text))) = message {
                    let ordinary: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(ordinary["method"], "Runtime.fixture");
                    header(&mut server, CONTROL_BYTES + 1).await;
                }
            }
        }
    });
    let snapshot = client
        .request_until(
            "DOMSnapshot.captureSnapshot",
            json!({"computedStyles":["cursor"]}),
            Some("same-session"),
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "browser_cdp_response_timeout"
            },
        )
        .await;
    let ordinary = client
        .request("Runtime.fixture", json!({}), Some("same-session"))
        .await;
    let _ = retire.send(());
    client.retire().await;
    peer.await.unwrap();
    assert_eq!(
        snapshot
            .as_ref()
            .map(|value| value["strings"][0].as_str().unwrap().len()),
        Ok(3 * 1024 * 1024),
        "{snapshot:?}"
    );
    assert_eq!(ordinary, Err("browser_cdp_read_failed"));
}

#[tokio::test]
async fn network_body_admits_bulk_reply_and_restores_control_limit() {
    for method in [
        "Network.getResponseBody",
        "DOMStorage.getDOMStorageItems",
        "Network.getAllCookies",
    ] {
        let (client, mut server) = pair().await;
        let (retire, retired) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let snapshot = request(&mut server).await;
            assert_eq!(snapshot["method"], method);
            assert_eq!(snapshot["sessionId"], "same-session");
            let reply = json!({
                "id":snapshot["id"],
                "result":{"body":"x".repeat(3 * 1024 * 1024),"base64Encoded":false}
            });
            if server.send(Message::text(reply.to_string())).await.is_err() {
                return;
            }
            tokio::select! {
                biased;
                _ = retired => {},
                message = server.next() => {
                    if let Some(Ok(Message::Text(text))) = message {
                        let ordinary: Value = serde_json::from_str(&text).unwrap();
                        assert_eq!(ordinary["method"], "Runtime.fixture");
                        header(&mut server, CONTROL_BYTES + 1).await;
                    }
                }
            }
        });
        let snapshot = client
            .request_until(
                method,
                json!({"requestId":"request:1"}),
                Some("same-session"),
                async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "browser_cdp_response_timeout"
                },
            )
            .await;
        let ordinary = client
            .request("Runtime.fixture", json!({}), Some("same-session"))
            .await;
        let _ = retire.send(());
        client.retire().await;
        peer.await.unwrap();
        assert_eq!(
            snapshot
                .as_ref()
                .map(|value| value["body"].as_str().unwrap().len()),
            Ok(3 * 1024 * 1024),
            "{snapshot:?}"
        );
        assert_eq!(ordinary, Err("browser_cdp_read_failed"));
    }
}

#[tokio::test]
async fn bulk_response_limits_reject_headers_before_payload() {
    for (method, limit) in [
        ("DOMSnapshot.captureSnapshot", CAPTURE_BYTES),
        ("Network.getResponseBody", CAPTURE_BYTES),
        ("DOMStorage.getDOMStorageItems", CAPTURE_BYTES),
        ("Network.getAllCookies", CAPTURE_BYTES),
        ("DOMStorage.getDOMStorageItemsExtra", CONTROL_BYTES),
        ("Network.getCookies", CONTROL_BYTES),
        ("Network.getResponseBodyExtra", CONTROL_BYTES),
        ("DOMSnapshot.getSnapshot", CONTROL_BYTES),
    ] {
        let (client, mut server) = pair().await;
        let (retire, retired) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let received = request(&mut server).await;
            assert_eq!(received["method"], method);
            header(&mut server, limit + 1).await;
            let _ = retired.await;
        });
        let response = timeout(
            Duration::from_secs(1),
            client.request(method, json!({}), Some("same-session")),
        )
        .await;
        let _ = retire.send(());
        client.retire().await;
        peer.await.unwrap();
        assert_eq!(response.unwrap(), Err("browser_cdp_read_failed"));
    }
}

#[tokio::test]
async fn browser_capture_reuses_session_across_fragmented_reply_and_control_limit() {
    let (client, mut server) = pair().await;
    let (retire, retired) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let attach = request(&mut server).await;
        assert_eq!(attach["method"], "Target.attachToTarget");
        server
            .send(Message::text(
                json!({"id":attach["id"],"result":{"sessionId":"same-session"}}).to_string(),
            ))
            .await
            .unwrap();
        let capture = request(&mut server).await;
        assert_eq!(capture["method"], "Page.captureScreenshot");
        assert_eq!(capture["sessionId"], "same-session");
        server
            .send(Message::text(
                json!({"method":"Page.fixture","params":{"retained":true}}).to_string(),
            ))
            .await
            .unwrap();
        let reply =
            json!({"id":capture["id"],"result":{"data":"a".repeat(3*1024*1024)}}).to_string();
        let chunks: Vec<_> = reply.as_bytes().chunks(1024 * 1024).collect();
        for (index, chunk) in chunks.iter().enumerate() {
            server
                .send(Message::Frame(Frame::message(
                    chunk.to_vec(),
                    OpCode::Data(if index == 0 {
                        Data::Text
                    } else {
                        Data::Continue
                    }),
                    index + 1 == chunks.len(),
                )))
                .await
                .unwrap();
            server
                .send(Message::Ping(vec![1, 2, 3].into()))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let ordinary = request(&mut server).await;
        assert_eq!(ordinary["method"], "Runtime.fixture");
        header(&mut server, CONTROL_BYTES + 1).await;
        let _ = retired.await;
    });
    client.retain_events();
    let session = client.attach("target").await.unwrap();
    let capture = client
        .capture_screenshot(json!({}), &session)
        .await
        .unwrap();
    assert_eq!(capture["data"].as_str().unwrap().len(), 3 * 1024 * 1024);
    assert_eq!(client.attach("target").await.unwrap(), session);
    assert_eq!(client.pop_event().unwrap()["method"], "Page.fixture");
    assert_eq!(
        timeout(
            Duration::from_secs(1),
            client.request("Runtime.fixture", json!({}), Some(&session))
        )
        .await
        .unwrap(),
        Err("browser_cdp_read_failed")
    );
    let _ = retire.send(());
    peer.await.unwrap();
}

#[tokio::test]
async fn browser_capture_limit_restores_on_rejection_timeout_and_cancellation() {
    for mode in ["rejection", "timeout", "cancellation"] {
        let (client, mut server) = pair().await;
        let (send_header, wait_header) = oneshot::channel();
        let (retire, retired) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let capture = request(&mut server).await;
            if mode == "rejection" {
                server
                    .send(Message::text(
                        json!({"id":capture["id"],"error":{"code":-32000,"message":"fixture"}})
                            .to_string(),
                    ))
                    .await
                    .unwrap();
            }
            wait_header.await.unwrap();
            header(&mut server, CONTROL_BYTES + 1).await;
            let _ = retired.await;
        });
        if mode == "cancellation" {
            assert!(
                timeout(
                    Duration::from_millis(30),
                    client.capture_screenshot(json!({}), "session")
                )
                .await
                .is_err()
            );
        } else {
            let response = client
                .request_with_limit(
                    "Page.captureScreenshot",
                    json!({}),
                    Some("session"),
                    Duration::from_millis(30),
                    CAPTURE_BYTES,
                )
                .await;
            assert_eq!(
                response,
                Err(if mode == "rejection" {
                    "browser_cdp_request_rejected"
                } else {
                    "browser_cdp_response_timeout"
                })
            );
        }
        send_header.send(()).unwrap();
        // No new request sets the limit: a passive read must already be small.
        assert_eq!(
            timeout(Duration::from_secs(1), client.next_event())
                .await
                .unwrap(),
            Err("browser_cdp_read_failed"),
            "{mode}"
        );
        let _ = retire.send(());
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn browser_capture_rejects_oversize_header_before_payload() {
    let (client, mut server) = pair().await;
    let (retire, retired) = oneshot::channel();
    let peer = tokio::spawn(async move {
        request(&mut server).await;
        header(&mut server, CAPTURE_BYTES + 1).await;
        let _ = retired.await;
    });
    assert_eq!(
        timeout(
            Duration::from_secs(1),
            client.capture_screenshot(json!({}), "session")
        )
        .await
        .unwrap(),
        Err("browser_cdp_read_failed")
    );
    let _ = retire.send(());
    peer.await.unwrap();
}

#[tokio::test]
async fn browser_control_bounds_the_assembled_fragmented_message() {
    let (client, mut server) = pair().await;
    let (retire, retired) = oneshot::channel();
    let peer = tokio::spawn(async move {
        request(&mut server).await;
        for index in 0..3 {
            server
                .send(Message::Frame(Frame::message(
                    vec![b'a'; 1024 * 1024],
                    OpCode::Data(if index == 0 {
                        Data::Text
                    } else {
                        Data::Continue
                    }),
                    index == 2,
                )))
                .await
                .unwrap();
        }
        let _ = retired.await;
    });
    assert_eq!(
        client.request("Runtime.fixture", json!({}), None).await,
        Err("browser_cdp_read_failed")
    );
    let _ = retire.send(());
    peer.await.unwrap();
}

#[tokio::test]
async fn browser_socket_resumes_backpressure_without_resubmitting_input() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/backpressure",
        listener.local_addr().unwrap()
    );
    let (client, server) = tokio::join!(
        async {
            let stream = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            Socket::connect(&address, stream, WebSocketConfig::default())
                .await
                .unwrap()
        },
        async {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        }
    );
    let mut socket = client;
    let mut server = server;
    let peer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let message = server.next().await.unwrap().unwrap();
        assert_eq!(message.into_text().unwrap(), "x".repeat(16 * 1024 * 1024));
        assert_eq!(
            server.next().await.unwrap().unwrap().into_text().unwrap(),
            "next"
        );
        server.send(Message::text("done")).await.unwrap();
    });
    timeout(Duration::from_secs(5), async {
        socket
            .send(Message::text("x".repeat(16 * 1024 * 1024)))
            .await
            .unwrap();
        socket.send(Message::text("next")).await.unwrap();
        assert_eq!(socket.next().await.unwrap().into_text().unwrap(), "done");
    })
    .await
    .unwrap();
    peer.await.unwrap();
}

#[tokio::test]
async fn browser_socket_reports_graceful_disconnection() {
    let (client, mut server) = pair().await;
    let peer = tokio::spawn(async move {
        server.close(None).await.unwrap();
        let _ = server.next().await;
    });
    assert_eq!(
        timeout(Duration::from_secs(1), client.next_event())
            .await
            .unwrap(),
        Err("browser_cdp_disconnected")
    );
    peer.await.unwrap();
}

#[tokio::test]
async fn dialog_reply_can_overtake_the_pending_renderer_reply_on_one_connection() {
    let (client, mut server) = pair().await;
    let peer = tokio::spawn(async move {
        let first = request(&mut server).await;
        let second = request(&mut server).await;
        assert_eq!(first["method"], "Input.dispatchMouseEvent");
        assert_eq!(second["method"], "Page.handleJavaScriptDialog");
        assert_eq!(first["sessionId"], second["sessionId"]);
        for (request, value) in [(second, "answered"), (first, "clicked")] {
            server
                .send(Message::text(
                    json!({"id":request["id"],"result":{"value":value}}).to_string(),
                ))
                .await
                .unwrap();
        }
        let _ = server.next().await;
    });
    let (clicked, answered) = tokio::join!(
        client.request("Input.dispatchMouseEvent", json!({}), Some("page-session")),
        client.request(
            "Page.handleJavaScriptDialog",
            json!({"accept":true}),
            Some("page-session")
        ),
    );
    assert_eq!(clicked.unwrap()["value"], "clicked");
    assert_eq!(answered.unwrap()["value"], "answered");
    client.retire().await;
    peer.await.unwrap();
}

#[tokio::test]
async fn retiring_the_connection_resolves_a_pending_renderer_request() {
    let (client, mut server) = pair().await;
    let (result, ()) = tokio::join!(
        client.request("Runtime.evaluate", json!({}), Some("session")),
        async {
            assert_eq!(request(&mut server).await["method"], "Runtime.evaluate");
            client.retire().await;
        },
    );
    assert_eq!(result, Err("browser_cdp_closed"));
    assert_eq!(client.next_event().await, Err("browser_cdp_closed"));
    assert_eq!(
        client.request("Browser.getVersion", json!({}), None).await,
        Err("browser_cdp_closed")
    );
}

#[tokio::test]
async fn a_pending_capture_does_not_accept_an_oversize_control_reply() {
    let (client, mut server) = pair().await;
    let peer = tokio::spawn(async move {
        let capture = request(&mut server).await;
        let control = request(&mut server).await;
        assert_eq!(capture["method"], "Page.captureScreenshot");
        assert_eq!(control["method"], "Runtime.fixture");
        for request in [control, capture] {
            server
                .send(Message::text(
                    json!({"id":request["id"],"result":{"data":"a".repeat(3*1024*1024)}})
                        .to_string(),
                ))
                .await
                .unwrap();
        }
        let _ = server.next().await;
    });
    let (capture, control) = tokio::join!(
        client.capture_screenshot(json!({}), "session"),
        client.request("Runtime.fixture", json!({}), Some("session")),
    );
    assert_eq!(control, Err("browser_cdp_read_failed"));
    assert_eq!(
        capture.unwrap()["data"].as_str().unwrap().len(),
        3 * 1024 * 1024
    );
    client.retire().await;
    peer.await.unwrap();
}
