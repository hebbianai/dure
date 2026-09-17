use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug)]
enum CloseFault {
    Rejected,
    LostAcknowledgement,
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn uncertain_profile_retirement_keeps_both_native_owners_for_resource_close() {
    for fault in [CloseFault::Rejected, CloseFault::LostAcknowledgement] {
        prove_retirement(fault).await;
    }
}

async fn prove_retirement(fault: CloseFault) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-retirement-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:retirement");
    let profiles = [
        BrowserProfileIdV1::new("profile:a").unwrap(),
        BrowserProfileIdV1::new("profile:b").unwrap(),
    ];
    let mut runtime = BrowserRuntime::launch_profile(
        resource.clone(),
        &config,
        &root,
        &profile_spec(&profiles[0]),
    )
    .await
    .unwrap();
    let endpoint = runtime
        .test_binding()
        .instance
        .connection()
        .await
        .endpoint()
        .to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/profile-retirement",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = oneshot::channel();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let proxy = tokio::spawn(proxy(
        listener,
        endpoint.clone(),
        fault,
        stopped,
        Arc::clone(&commands),
    ));
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime
            .request_control(BrowserControllerId::new("profile-agent").unwrap(), None)
            .await?
            .controller
            .ok_or("controller missing")?;
        let page = first_page(&runtime).await?;
        let old_target = runtime.host.lock().await.target_for(&page)?.clone();
        let original = runtime.test_binding().cdp.clone();
        let fault_connection = BrowserCdp::connect(&address).await?;
        runtime.test_binding_mut().cdp = fault_connection.clone();
        let previous = Arc::clone(&runtime.test_binding().instance);
        let result = runtime
            .set_profile(
                &lease.controller_id,
                &authority(&runtime, &lease, &page).await,
                &config,
                &profile_spec(&profiles[1]),
            )
            .await;
        let (control, pages, retained, next_instance) = {
            let host = runtime.host.lock().await;
            (
                host.projection(),
                host.pages(),
                host.page_target_is_retiring(&old_target),
                host.instance_for_page(&page.page_id)?.clone(),
            )
        };
        let next = Arc::clone(
            &runtime
                .execution_for_instance(&next_instance)?
                .binding
                .instance,
        );
        let profiles_after = (previous.profile_id().await, next.profile_id().await);
        let process_alive = (
            !previous.browser_has_exited().await?,
            !next.browser_has_exited().await?,
        );
        // The independent endpoint observes Chrome's actual effect; it does not
        // repair or replay the rejected/lost product command.
        let mut observation = BrowserCdp::connect(&endpoint).await?;
        let targets = observation
            .request("Target.getTargets", json!({}), None)
            .await;
        observation.retire().await;
        let targets = targets?;
        let old_live = targets["targetInfos"]
            .as_array()
            .ok_or("fixture_targets_missing")?
            .iter()
            .any(|info| info["targetId"].as_str() == Some(old_target.as_str()));
        let closed = runtime.close(&resource).await;
        let exited = (
            previous.browser_has_exited().await?,
            next.browser_has_exited().await?,
        );
        let final_control = runtime.control().await;
        fault_connection.retire().await;
        original.retire().await;
        Ok((
            (page, result, control, pages, retained, profiles_after),
            (process_alive, old_live, closed, exited, final_control),
        ))
    }
    .await;
    let cleanup = runtime.close(&resource).await;
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    let commands = commands.lock().await.clone();
    println!(
        "BROWSER_PROFILE_RETIREMENT_FAULT fault={fault:?} root={} evidence={evidence:?} cleanup={cleanup:?} proxy={proxy_closed:?} commands={commands:?}",
        root.display()
    );
    assert!(cleanup.is_ok(), "{cleanup:?}");
    assert!(proxy_closed.is_ok(), "{proxy_closed:?}");
    let (
        (page, result, control, pages, retained, profiles_after),
        (alive, old_live, closed, exited, final_control),
    ) = evidence.unwrap();
    assert!(matches!(
        result,
        Err(BrowserRuntimeError::Engine(BrowserEngineError {
            code: "browser_profile_replacement_incomplete",
            outcome_unknown: true,
            ..
        }))
    ));
    assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].page_id, page.page_id);
    assert!(pages[0].document_revision > page.document_revision);
    assert!(retained);
    assert_eq!(
        profiles_after,
        (Some(profiles[0].clone()), Some(profiles[1].clone()))
    );
    assert_eq!(alive, (true, true));
    assert_eq!(old_live, matches!(fault, CloseFault::Rejected));
    assert!(closed.is_ok(), "{closed:?}");
    assert_eq!(exited, (true, true));
    assert_eq!(final_control.phase, BrowserResourcePhase::Closed);
    assert_eq!(
        commands
            .iter()
            .filter(|method| method.as_str() == "Target.closeTarget")
            .count(),
        1
    );
}

async fn proxy(
    listener: TcpListener,
    endpoint: String,
    fault: CloseFault,
    mut stopped: oneshot::Receiver<()>,
    commands: Arc<Mutex<Vec<String>>>,
) {
    let (socket, _) = tokio::select! {
        _ = &mut stopped => return,
        accepted = listener.accept() => accepted.unwrap(),
    };
    let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
    let uri: tokio_tungstenite::tungstenite::http::Uri = endpoint.parse().unwrap();
    let socket = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
        .await
        .unwrap();
    let (mut chrome, _) = tokio_tungstenite::client_async(endpoint, socket)
        .await
        .unwrap();
    let mut close_request = None;
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            message = client.next() => {
                let Some(Ok(message)) = message else { break };
                if message.is_close() { break; }
                if let Ok(text) = message.to_text() {
                    let request: Value = serde_json::from_str(text).unwrap();
                    if let Some(method) = request["method"].as_str() {
                        commands.lock().await.push(method.to_owned());
                        if method == "Target.closeTarget" {
                            if matches!(fault, CloseFault::Rejected) {
                                client.send(tokio_tungstenite::tungstenite::Message::Text(json!({"id":request["id"],"error":{"code":-32000,"message":"fixture close rejection"}}).to_string().into())).await.unwrap();
                                continue;
                            }
                            close_request = Some(request["id"].clone());
                        }
                    }
                }
                if chrome.send(message).await.is_err() { break; }
            }
            message = chrome.next() => {
                let Some(Ok(message)) = message else { break };
                if let Ok(text) = message.to_text() {
                    let response: Value = serde_json::from_str(text).unwrap();
                    if close_request.as_ref() == Some(&response["id"]) {
                        assert_eq!(response["result"]["success"], true, "{response}");
                        // Chrome closed the exact target. Lose its reply while
                        // leaving the original Browser process owner alive.
                        break;
                    }
                }
                if client.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = client.close(None).await;
    let _ = chrome.close(None).await;
}
