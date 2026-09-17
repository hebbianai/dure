use super::super::{BrowserCdp, Monitor};
use super::*;
use futures_util::{SinkExt, StreamExt};
use hmux_host::browser_resource::BrowserResourceHost;
use hmux_session_protocol::browser_resource::*;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify, broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn late_console_metadata_releases_its_mirror_without_recreating_a_closed_page() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/late-console",
        listener.local_addr().unwrap()
    );
    let (client, server) = tokio::join!(BrowserCdp::connect(&address), async {
        let (socket, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(socket).await.unwrap()
    });
    let mut server = server;
    let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("r").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    });
    let target = BrowserTargetId::new("target").unwrap();
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            target.clone(),
            BrowserDocumentId::new("document").unwrap(),
        )
        .unwrap();
    host.network()
        .attach(
            BrowserNetworkId::new("source").unwrap(),
            target.clone(),
            target,
            true,
            Instant::now(),
        )
        .unwrap();
    let mut monitor = Monitor {
        instance: BrowserInstanceId::new("instance").unwrap(),
        resource: Arc::new(host.projection().resource),
        changed: Arc::new(Notify::new()),
        navigation: broadcast::channel(128).0,
        cdp: client.unwrap(),
        host: Arc::new(Mutex::new(host)),
        initializing: false,
        contexts: Default::default(),
        private_contexts: Default::default(),
        interceptions: Default::default(),
        barriers: mpsc::channel(32).0,
    };
    monitor.console_event(&json!({"method":"Runtime.executionContextCreated","sessionId":"source","params":{"context":{"id":7}}})).await.unwrap();
    monitor
        .host
        .lock()
        .await
        .page_closed(&page.page_id)
        .unwrap();
    monitor.console_event(&json!({"method":"Runtime.consoleAPICalled","sessionId":"source","params":{"executionContextId":7,"type":"log","timestamp":1700000000000.0,"args":[{"type":"object","objectId":"late-mirror","description":"Object"}]}})).await.unwrap();
    let released = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Message::Text(text) = server.next().await.unwrap().unwrap() {
                let request: Value = serde_json::from_str(&text).unwrap();
                server
                    .send(Message::text(
                        json!({"id":request["id"],"result":{}}).to_string(),
                    ))
                    .await
                    .unwrap();
                return request;
            }
        }
    })
    .await;
    monitor.cdp.retire().await;
    let request = released.unwrap();
    assert_eq!(request["method"], "Runtime.releaseObject");
    assert_eq!(request["sessionId"], "source");
    assert_eq!(request["params"]["objectId"], "late-mirror");
    assert!(monitor.host.lock().await.pages().is_empty());
}
