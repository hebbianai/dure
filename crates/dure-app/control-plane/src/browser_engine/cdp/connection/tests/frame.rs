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

async fn image(server: &mut WebSocketStream<TcpStream>, session: &str, data: &str) {
    server.send(Message::text(json!({"method":"Page.screencastFrame","sessionId":session,"params":{"sessionId":1,"data":data}}).to_string())).await.unwrap();
}

#[tokio::test]
async fn frame_matches_its_session_and_stops_before_returning_the_bulk_image() {
    let (client, mut server) = pair().await;
    let client = Arc::new(client);
    let read = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.capture_frame("view").await })
    };
    let start = request(&mut server).await;
    assert_eq!(start["method"], "Page.startScreencast");
    reply(&mut server, &start, json!({})).await;
    image(&mut server, "other-page", "wrong").await;
    let data = "a".repeat(CONTROL_BYTES + 128);
    image(&mut server, "view", &data).await;
    let stop = request(&mut server).await;
    assert_eq!(stop["method"], "Page.stopScreencast");
    assert_eq!(stop["sessionId"], "view");
    assert!(
        !read.is_finished(),
        "the stop acknowledgement owns completion"
    );
    reply(&mut server, &stop, json!({})).await;
    assert_eq!(read.await.unwrap().unwrap()["data"], data);
    let ordinary = {
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            client
                .request("Runtime.fixture", json!({}), Some("view"))
                .await
        })
    };
    request(&mut server).await;
    header(&mut server, CONTROL_BYTES + 1).await;
    assert_eq!(ordinary.await.unwrap(), Err("browser_cdp_read_failed"));
    client.retire().await;
}

#[tokio::test]
async fn canceling_a_reader_still_stops_before_the_next_capture_starts() {
    let (client, mut server) = pair().await;
    let client = Arc::new(client);
    let read = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.capture_frame("view").await })
    };
    let start = request(&mut server).await;
    read.abort();
    assert!(read.await.unwrap_err().is_cancelled());
    let next = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.capture_frame("next-view").await })
    };
    reply(&mut server, &start, json!({})).await;
    image(&mut server, "view", "first").await;
    let stop = request(&mut server).await;
    assert_eq!(stop["method"], "Page.stopScreencast");
    assert_eq!(stop["sessionId"], "view");
    reply(&mut server, &stop, json!({})).await;
    let start = request(&mut server).await;
    assert_eq!(start["method"], "Page.startScreencast");
    assert_eq!(start["sessionId"], "next-view");
    reply(&mut server, &start, json!({})).await;
    image(&mut server, "next-view", "second").await;
    let stop = request(&mut server).await;
    reply(&mut server, &stop, json!({})).await;
    assert_eq!(next.await.unwrap().unwrap()["data"], "second");
    client.retire().await;
}

#[tokio::test]
async fn canceling_a_reader_stops_before_recording_can_start() {
    let (client, mut server) = pair().await;
    let client = Arc::new(client);
    let read = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.capture_frame("view").await })
    };
    let start = request(&mut server).await;
    read.abort();
    assert!(read.await.unwrap_err().is_cancelled());
    let recording = {
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            client
                .request("Page.startScreenRecording", json!({}), Some("view"))
                .await
        })
    };
    reply(&mut server, &start, json!({})).await;
    image(&mut server, "view", "last").await;
    let stop = request(&mut server).await;
    assert_eq!(stop["method"], "Page.stopScreencast");
    reply(&mut server, &stop, json!({})).await;
    let start = request(&mut server).await;
    assert_eq!(start["method"], "Page.startScreenRecording");
    reply(&mut server, &start, json!({"stream":"recording"})).await;
    assert_eq!(recording.await.unwrap().unwrap()["stream"], "recording");
    client.retire().await;
}

#[tokio::test]
async fn a_rejected_start_is_stopped_and_a_rejected_stop_retires_the_connection() {
    let (client, mut server) = pair().await;
    let client = Arc::new(client);
    let read = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.capture_frame("view").await })
    };
    let start = request(&mut server).await;
    server
        .send(Message::text(
            json!({"id":start["id"],"error":{"code":-32000,"message":"start failure"}}).to_string(),
        ))
        .await
        .unwrap();
    let stop = request(&mut server).await;
    assert_eq!(stop["method"], "Page.stopScreencast");
    server
        .send(Message::text(
            json!({"id":stop["id"],"error":{"code":-32000,"message":"stop failure"}}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(read.await.unwrap(), Err("browser_frame_stop_unknown"));
    assert_eq!(
        client.request("Target.getTargets", json!({}), None).await,
        Err("browser_cdp_closed")
    );
    client.retire().await;
}
