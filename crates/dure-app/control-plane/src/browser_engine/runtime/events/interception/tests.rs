use super::*;
use futures_util::{SinkExt, StreamExt};
use hmux_session_protocol::browser_resource::*;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn interception_waits_for_the_request_type_before_deciding_a_worker_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/interception-order",
        listener.local_addr().unwrap()
    );
    let (client, peer) = tokio::join!(BrowserCdp::connect(&address), async {
        let (socket, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(socket).await.unwrap()
    });
    let mut peer = peer;
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
            BrowserDocumentId::new("doc").unwrap(),
        )
        .unwrap();
    for (source, engine_target) in [
        ("page-source", target.clone()),
        ("worker-source", BrowserTargetId::new("worker").unwrap()),
    ] {
        host.network()
            .attach(
                BrowserNetworkId::new(source).unwrap(),
                engine_target,
                target.clone(),
                true,
                Instant::now(),
            )
            .unwrap();
    }
    let lease = host
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    let permit = host
        .begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page,
                operation_id: BrowserOperationId::new("enable").unwrap(),
                command_sequence: host.projection().next_command_sequence,
            },
            [],
        )
        .unwrap();
    host.configure_interception(&permit, &serde_json::from_value(json!({"kind":"enable","rule":{"patterns":["*/blocked"],"resource_types":["Fetch"],"effect":{"kind":"abort"}}})).unwrap()).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
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
    let paused = json!({"method":"Fetch.requestPaused","sessionId":"page-source","params":{"requestId":"fetch:1","networkId":"request:1","request":{"url":"http://fixture/blocked","headers":{}},"resourceType":"XHR"}});
    let (first, premature) = tokio::join!(monitor.event(paused), async {
        let message = timeout(Duration::from_millis(50), peer.next()).await;
        let Ok(Some(Ok(Message::Text(message)))) = message else {
            return None;
        };
        let request: Value = serde_json::from_str(&message).unwrap();
        peer.send(Message::text(
            json!({"id":request["id"],"result":{}}).to_string(),
        ))
        .await
        .unwrap();
        Some(request)
    });
    let mut decided = None;
    if first.is_ok() && premature.is_none() {
        let event = json!({"method":"Network.requestWillBeSent","sessionId":"worker-source","params":{"requestId":"request:1","request":{"url":"http://fixture/blocked","method":"GET","headers":{}},"type":"Fetch","wallTime":1700000000.0,"timestamp":1.0}});
        let (applied, reply) = tokio::join!(monitor.event(event), async {
            let message = timeout(Duration::from_secs(2), peer.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let Message::Text(message) = message else {
                panic!("expected CDP request")
            };
            let request: Value = serde_json::from_str(&message).unwrap();
            peer.send(Message::text(
                json!({"id":request["id"],"result":{}}).to_string(),
            ))
            .await
            .unwrap();
            request
        });
        decided = Some((applied, reply));
    }
    monitor.interception_event(&json!({"method":"Fetch.requestPaused","sessionId":"page-source","params":{"requestId":"fetch:2","networkId":"missing:2","request":{"url":"http://fixture/blocked","headers":{}},"resourceType":"XHR"}})).unwrap();
    monitor.interceptions.back_mut().unwrap().received = Instant::now() - Duration::from_secs(6);
    let expired = monitor.interception_wait_remaining();
    monitor.cdp.retire().await;
    println!(
        "BROWSER_INTERCEPTION_ORDER first={first:?} premature={premature:?} decided={decided:?}"
    );
    first.unwrap();
    assert!(
        premature.is_none(),
        "request escaped before its canonical type arrived: {premature:?}"
    );
    let (applied, reply) = decided.unwrap();
    applied.unwrap();
    assert_eq!(reply["method"], "Fetch.failRequest");
    assert_eq!(reply["params"]["requestId"], "fetch:1");
    assert_eq!(reply["sessionId"], "page-source");
    assert_eq!(expired, Err("browser_interception_metadata_timeout"));
}
