use super::*;
use std::sync::Arc;

async fn reply(server: &mut WebSocketStream<TcpStream>, request: &Value, result: Value) {
    server
        .send(Message::text(
            json!({"id":request["id"],"result":result}).to_string(),
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn frame_completion_failure_and_cancellation_do_not_control_recording() {
    for outcome in ["completed", "rejected", "canceled"] {
        let (client, mut server) = pair().await;
        let client = Arc::new(client);
        let read = {
            let client = Arc::clone(&client);
            tokio::spawn(async move {
                client
                    .capture_screenshot(json!({"format":"jpeg"}), "view")
                    .await
            })
        };
        let capture = request(&mut server).await;
        assert_eq!(capture["method"], "Page.captureScreenshot");
        assert_eq!(capture["sessionId"], "view");
        if outcome == "canceled" {
            read.abort();
        }
        let recording = {
            let client = Arc::clone(&client);
            tokio::spawn(async move {
                client
                    .request("Page.startScreenRecording", json!({}), Some("view"))
                    .await
            })
        };
        let start = timeout(Duration::from_secs(1), request(&mut server))
            .await
            .unwrap();
        assert_eq!(start["method"], "Page.startScreenRecording");
        reply(&mut server, &start, json!({"stream":"recording"})).await;
        assert_eq!(recording.await.unwrap().unwrap()["stream"], "recording");
        if outcome == "rejected" {
            server
                .send(Message::text(
                    json!({"id":capture["id"],"error":{"code":-32000,"message":"fixture"}})
                        .to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(read.await.unwrap(), Err("browser_cdp_request_rejected"));
        } else {
            reply(&mut server, &capture, json!({"data":"image"})).await;
            if outcome == "canceled" {
                assert!(read.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(read.await.unwrap().unwrap()["data"], "image");
            }
        }
        let following = {
            let client = Arc::clone(&client);
            tokio::spawn(async move {
                client
                    .request("Runtime.getIsolateId", json!({}), Some("view"))
                    .await
            })
        };
        let following_request = request(&mut server).await;
        assert_eq!(
            following_request["method"], "Runtime.getIsolateId",
            "no late stop can interrupt recording"
        );
        reply(
            &mut server,
            &following_request,
            json!({"id":"same renderer"}),
        )
        .await;
        following.await.unwrap().unwrap();
        client.retire().await;
    }
}
