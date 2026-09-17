use super::*;
use crate::browser_engine::cdp::BrowserCdp;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

impl BrowserCdp {
    pub(in crate::browser_engine) async fn wait_for_object_releases(
        &self,
    ) -> Result<(), &'static str> {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                self.objects.check()?;
                if self.objects.queue.lock().unwrap().bytes == 0 {
                    return Ok(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "fixture_object_release_timeout")?
    }
}

async fn pair() -> (BrowserCdp, WebSocketStream<TcpStream>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/objects",
        listener.local_addr().unwrap()
    );
    let (client, server) = tokio::join!(BrowserCdp::connect(&address), async {
        let (socket, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(socket).await.unwrap()
    });
    (client.unwrap(), server)
}

async fn request(server: &mut WebSocketStream<TcpStream>) -> Value {
    timeout(Duration::from_secs(2), async {
        loop {
            if let Message::Text(text) = server.next().await.unwrap().unwrap() {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .unwrap()
}

async fn reply(server: &mut WebSocketStream<TcpStream>, request: &Value, result: Value) {
    server
        .send(Message::text(
            json!({"id":request["id"],"result":result}).to_string(),
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn dropped_groups_release_without_another_command_and_blocked_objects_do_not_block_dialogs() {
    let (mut client, mut server) = pair().await;
    let (session, ()) = tokio::join!(client.attach("target"), async {
        let attach = request(&mut server).await;
        reply(&mut server, &attach, json!({"sessionId":"session"})).await;
    });
    let session = session.unwrap();
    let group = client.object_group(&session).unwrap();
    let name = group.name().to_owned();
    drop(group);
    let released = request(&mut server).await;
    assert_eq!(released["method"], "Runtime.releaseObjectGroup");
    assert_eq!(released["sessionId"], session);
    assert_eq!(released["params"]["objectGroup"], name);
    reply(&mut server, &released, json!({})).await;
    client
        .release_objects(
            session.clone(),
            vec!["mirror".into()],
            std::future::pending(),
            || async { Ok(true) },
        )
        .unwrap();
    let held = request(&mut server).await;
    assert_eq!(held["method"], "Runtime.releaseObject");
    assert_eq!(held["params"]["objectId"], "mirror");
    let (dialog, ()) = tokio::join!(
        client.request(
            "Page.handleJavaScriptDialog",
            json!({"accept":false}),
            Some(&session)
        ),
        async {
            let dialog = request(&mut server).await;
            assert_eq!(dialog["method"], "Page.handleJavaScriptDialog");
            reply(&mut server, &dialog, json!({"answered":true})).await;
        }
    );
    assert_eq!(dialog.unwrap()["answered"], true);
    reply(&mut server, &held, json!({})).await;
    client.retire().await;
    assert_eq!(client.objects.check(), Err("browser_cdp_retired"));
}

#[tokio::test]
async fn release_failure_closes_the_owned_event_connection_without_a_followup_request() {
    let (mut client, mut server) = pair().await;
    client.retain_events().await;
    client
        .release_objects(
            "source".into(),
            vec!["mirror".into()],
            std::future::pending(),
            || async { Ok(true) },
        )
        .unwrap();
    let held = request(&mut server).await;
    server
        .send(Message::text(
            json!({"id":held["id"],"error":{"code":-32000,"message":"fixture release failure"}})
                .to_string(),
        ))
        .await
        .unwrap();
    let ended = timeout(Duration::from_secs(2), client.next_event()).await;
    assert!(matches!(ended, Ok(Err(_))), "{ended:?}");
    assert!(client.objects.check().is_err());
    client.retire().await;
}

#[tokio::test]
async fn overflow_cancels_a_suspended_release_and_wakes_the_event_observer() {
    let (mut client, _server) = pair().await;
    client.retain_events().await;
    let (started, ready) = oneshot::channel();
    let (owned, released) = oneshot::channel::<()>();
    client
        .objects
        .enqueue(4 * 1024 * 1024, async move {
            let _owned = owned;
            started.send(()).unwrap();
            std::future::pending().await
        })
        .unwrap();
    ready.await.unwrap();
    assert_eq!(
        client.objects.enqueue(1, async { Ok(()) }),
        Err("browser_object_release_limit")
    );
    let ended = timeout(Duration::from_millis(250), client.next_event()).await;
    let dropped = timeout(Duration::from_millis(250), released).await;
    client.retire().await;
    assert!(
        matches!(ended, Ok(Err(_))),
        "overflow left its connection alive: {ended:?}"
    );
    assert!(
        matches!(dropped, Ok(Err(_))),
        "suspended cleanup was not canceled: {dropped:?}"
    );
}

#[tokio::test]
async fn retirement_awaits_cancellation_of_active_and_queued_cleanup() {
    let (client, _server) = pair().await;
    let (started, ready) = oneshot::channel();
    let (active, active_dropped) = oneshot::channel::<()>();
    client
        .objects
        .enqueue(10, async move {
            let _owned = active;
            let _ = started.send(());
            std::future::pending().await
        })
        .unwrap();
    ready.await.unwrap();
    let (queued, queued_dropped) = oneshot::channel::<()>();
    client
        .objects
        .enqueue(10, async move {
            let _owned = queued;
            std::future::pending().await
        })
        .unwrap();
    tokio::join!(client.retire(), client.retire(), client.retire());
    assert!(active_dropped.await.is_err());
    assert!(queued_dropped.await.is_err());
    assert_eq!(client.objects.queue.lock().unwrap().bytes, 0);
    assert!(client.objects.task.lock().await.is_none());
}

#[tokio::test]
async fn context_closure_cancels_only_its_release_and_allows_later_objects_to_drain() {
    let (mut client, mut server) = pair().await;
    let (closed, lifetime) = oneshot::channel::<()>();
    client
        .release_objects(
            "source".into(),
            vec!["old-context".into()],
            async {
                let _ = lifetime.await;
            },
            || async { Err("unexpected_reconciliation") },
        )
        .unwrap();
    let old = request(&mut server).await;
    assert_eq!(old["params"]["objectId"], "old-context");
    closed.send(()).unwrap();
    client
        .release_objects(
            "source".into(),
            vec!["new-context".into()],
            std::future::pending(),
            || async { Ok(true) },
        )
        .unwrap();
    let next = request(&mut server).await;
    assert_eq!(next["params"]["objectId"], "new-context");
    reply(&mut server, &next, json!({})).await;
    // A late reply for the canceled request cannot complete another command.
    reply(&mut server, &old, json!({"old":true})).await;
    let (alive, ()) = tokio::join!(
        client.request("Runtime.getIsolateId", json!({}), Some("source")),
        async {
            let check = request(&mut server).await;
            reply(&mut server, &check, json!({"id":"alive"})).await;
        }
    );
    assert_eq!(alive.unwrap()["id"], "alive");
    client.retire().await;
}
