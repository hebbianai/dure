use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::{net::TcpListener, sync::oneshot, time::timeout};

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn failed_shared_publication_retains_the_created_target_after_cleanup_rejection() {
    let (runtime, identity, root) = launch("shared:retained-cleanup").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/retained-cleanup",
        listener.local_addr().unwrap()
    );
    let actual = runtime
        .test_binding()
        .instance
        .replace_test_endpoint(address)
        .await;
    let (stop, stopped) = oneshot::channel();
    let (created, observed) = oneshot::channel();
    let commands = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let proxy = tokio::spawn(reject_first_close(
        listener,
        actual.clone(),
        stopped,
        created,
        Arc::clone(&commands),
    ));
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .ok_or("controller missing")?;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.retainedProof='원본 공유 리소스';true"}),
        )
        .await?;
        // The existing observer rejects an already-present resource identity
        // after native creation. Reject that target's first cleanup attempt too.
        let failure = match runtime.share_instance(identity.clone()).await {
            Ok(created) => {
                let _ = created.close(&identity).await;
                return Err("fixture duplicate publication accepted".into());
            }
            Err(error) => error,
        };
        let target = timeout(Duration::from_secs(5), observed)
            .await
            .map_err(|_| "fixture creation missing")?
            .map_err(|_| "fixture creation signal lost")?;
        let mut cdp = runtime.test_binding().cdp.clone();
        let retired = timeout(Duration::from_secs(5), async {
            loop {
                if !live_targets(&mut cdp).await?.contains(&target) {
                    return Ok::<_, BrowserRuntimeError>(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let retained = live_targets(&mut cdp).await?.contains(&target);
        let after = runtime.observe().await?.pages[0].page.clone();
        let exited = runtime.test_binding().instance.browser_has_exited().await?;
        let value = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.retainedProof"}),
        )
        .await?;
        Ok((
            failure,
            target,
            retired,
            retained,
            page,
            after,
            exited,
            value.response.data["result"].clone(),
        ))
    }
    .await;
    runtime
        .test_binding()
        .instance
        .replace_test_endpoint(actual)
        .await;
    let closed = runtime.close(&identity).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    let commands = commands.lock().await.clone();
    println!(
        "BROWSER_SHARED_RETAINED_CLEANUP root={} evidence={evidence:?} closed={closed:?} proxy={proxy_closed:?} commands={commands:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (_, _, retired, retained, before, after, exited, value) = evidence.unwrap();
    assert!(matches!(retired, Ok(Ok(()))), "{retired:?}");
    assert!(!retained);
    assert_eq!(before, after);
    assert!(!exited);
    assert_eq!(value, "원본 공유 리소스");
    assert_eq!(
        commands
            .iter()
            .filter(|m| m.as_str() == "Target.createTarget")
            .count(),
        1
    );
    assert_eq!(
        commands
            .iter()
            .filter(|m| m.as_str() == "Target.closeTarget")
            .count(),
        2
    );
}

async fn reject_first_close(
    listener: TcpListener,
    actual: String,
    mut stopped: oneshot::Receiver<()>,
    created: oneshot::Sender<String>,
    commands: Arc<tokio::sync::Mutex<Vec<String>>>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let rejected = Arc::new(AtomicBool::new(false));
    let created = Arc::new(tokio::sync::Mutex::new(Some(created)));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted.unwrap();
                let actual = actual.clone();
                let rejected = Arc::clone(&rejected);
                let created = Arc::clone(&created);
                let commands = Arc::clone(&commands);
                tasks.spawn(async move {
                    let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
                    let uri: tokio_tungstenite::tungstenite::http::Uri = actual.parse().unwrap();
                    let socket = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap())).await.unwrap();
                    let (mut chrome, _) = tokio_tungstenite::client_async(actual, socket).await.unwrap();
                    let mut creation = None;
                    loop {
                        tokio::select! {
                            message = client.next() => {
                                let Some(Ok(message)) = message else { break };
                                if message.is_close() { break; }
                                if let Ok(text) = message.to_text() {
                                    let request: Value = serde_json::from_str(text).unwrap();
                                    if let Some(method) = request["method"].as_str() {
                                        commands.lock().await.push(method.to_owned());
                                        if method == "Target.createTarget" { creation=Some(request["id"].clone()); }
                                        if method == "Target.closeTarget" && !rejected.swap(true,Ordering::SeqCst) {
                                            client.send(tokio_tungstenite::tungstenite::Message::Text(json!({"id":request["id"],"error":{"code":-32000,"message":"fixture cleanup rejected"}}).to_string().into())).await.unwrap();
                                            continue;
                                        }
                                    }
                                }
                                if chrome.send(message).await.is_err() { break; }
                            }
                            message = chrome.next() => {
                                let Some(Ok(message)) = message else { break };
                                if let Ok(text) = message.to_text() {
                                    let response: Value = serde_json::from_str(text).unwrap();
                                    if creation.as_ref()==Some(&response["id"]) {
                                        let target=response["result"]["targetId"].as_str().unwrap().to_owned();
                                        if let Some(created)=created.lock().await.take() { let _=created.send(target); }
                                    }
                                }
                                if client.send(message).await.is_err() { break; }
                            }
                        }
                    }
                    let _=client.close(None).await;
                    let _=chrome.close(None).await;
                });
            }
        }
    }
    tasks.shutdown().await;
}
