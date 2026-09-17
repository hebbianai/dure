use super::{BrowserAction, BrowserRuntime, BrowserRuntimeError, BrowserSnapshot};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngineConfig};
use hmux_host::browser_resource::BrowserAdmissionError;
use hmux_session_protocol::browser_resource::*;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::{sleep, timeout};

mod dialog;
mod frames;
mod init_script;
mod pages;
mod profiles;
mod react;
mod recording;
mod service_worker;
mod touch;
mod tracing;
mod transport;
mod typing;
mod worker;

fn profile_spec(id: &dure_app::BrowserProfileIdV1) -> dure_app::BrowserProfileSpecV1 {
    dure_app::BrowserProfileSpecV1::new(
        id.clone(),
        "Profile fixture".into(),
        if id.is_default() {
            dure_app::BrowserProfileScopeV1::Default
        } else {
            dure_app::BrowserProfileScopeV1::Isolated
        },
        dure_app::BrowserProfileUserAgentModeV1::Clean,
    )
    .unwrap()
}

fn identity(name: &str) -> BrowserResourceIdentity {
    BrowserResourceIdentity {
        resource_id: BrowserResourceId::new(name).unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:test").unwrap(),
    }
}

async fn authority(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
) -> BrowserActionAuthority {
    let sequence = runtime.control().await.next_command_sequence;
    BrowserActionAuthority {
        lease: lease.clone(),
        page: page.clone(),
        command_sequence: sequence,
        operation_id: BrowserOperationId::new(format!("operation:{sequence}")).unwrap(),
    }
}

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> Result<Value, BrowserRuntimeError> {
    let authority = authority(runtime, lease, page).await;
    let result = runtime
        .action(
            &lease.controller_id,
            &authority,
            serde_json::from_value(action).unwrap(),
        )
        .await?;
    if !result.response.success {
        return Err("fixture_action_rejected".into());
    }
    Ok(result.response.data)
}

async fn first_page(runtime: &BrowserRuntime) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
    runtime
        .observe()
        .await?
        .pages
        .into_iter()
        .next()
        .map(|page| page.page)
        .ok_or_else(|| "fixture_page_missing".into())
}

fn click_reference(
    snapshot: &BrowserSnapshot,
) -> Result<BrowserElementReference, BrowserRuntimeError> {
    let (element, _) = snapshot.data["refs"]
        .as_object()
        .ok_or("fixture_refs_missing")?
        .iter()
        .find(|(_, value)| value["role"] == "button" && value["name"] == "Increment")
        .ok_or("fixture_button_missing")?;
    Ok(BrowserElementReference {
        snapshot: snapshot.snapshot.clone(),
        element: BrowserElementId::new(element).unwrap(),
    })
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn host_runtime_controls_korean_input_isolation_refs_and_handoff() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let body = "<!doctype html><meta charset=utf-8><title>Browser resource fixture</title><input id=plain aria-label=Plain><div id=rich contenteditable=true aria-label=Rich>Initial</div><button onclick='window.writes++'>Increment</button><script>window.writes=0;window.richEvents=0;document.querySelector('#rich').addEventListener('input',()=>window.richEvents++)</script>";
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let mut socket = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((socket, _)) => socket,
                    Err(_) => break,
                },
                _ = &mut stopped => break,
            };
            // Chromium may keep a speculative connection idle while another
            // resource requests the document on a separate connection.
            connections.spawn(async move {
                let mut request = [0; 4096];
                if socket.read(&mut request).await.unwrap_or(0) == 0 {
                    return;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
        connections.shutdown().await;
    });
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-runtime-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let a = BrowserRuntime::launch(identity("resource:a"), &config, &root)
        .await
        .unwrap();
    let b_result = BrowserRuntime::launch(identity("resource:b"), &config, &root).await;
    if b_result.is_err() {
        a.close(&identity("resource:a")).await.unwrap();
    }
    let b = b_result.unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let agent = BrowserControllerId::new("agent").unwrap();
        let a_lease = a.request_control(agent.clone(), None).await?.controller.unwrap();
        let b_lease = b.request_control(agent.clone(), None).await?.controller.unwrap();
        apply(&a, &a_lease, &first_page(&a).await?, json!({"kind":"navigate","url":url})).await?;
        apply(&b, &b_lease, &first_page(&b).await?, json!({"kind":"navigate","url":url})).await?;
        let a_page = first_page(&a).await?;
        let b_page = first_page(&b).await?;
        for (selector, text) in [("#plain", "한글 입력"), ("#rich", "한글 편집 가능"), ("#rich", "")] {
            apply(&a, &a_lease, &a_page, json!({"kind":"fill","target":{"kind":"css","selector":selector},"text":text})).await?;
        }
        let cleared = apply(&a, &a_lease, &a_page, json!({"kind":"evaluate","script":"document.querySelector('#rich').textContent"})).await?;
        apply(&a, &a_lease, &a_page, json!({"kind":"fill","target":{"kind":"css","selector":"#rich"},"text":"한글 편집 가능"})).await?;
        apply(&a, &a_lease, &a_page, json!({"kind":"evaluate","script":"localStorage.setItem('owner','A');document.cookie='owner=A;path=/'"})).await?;
        let snapshot = a.snapshot(&a_page, &Default::default()).await?;
        let reference = click_reference(&snapshot)?;
        let request = authority(&a, &a_lease, &a_page).await;
        let click = json!({"kind":"click","target":{"kind":"reference","reference":reference}});
        let clicked = a.action(&agent, &request, serde_json::from_value(click.clone()).unwrap()).await?;
        let repeated = a.action(&agent, &request, serde_json::from_value(click.clone()).unwrap()).await;
        apply(&a, &a_lease, &a_page, json!({"kind":"new_page","url":url})).await?;
        let new_page = a.observe().await?.pages.into_iter().find(|page| page.page.page_id != a_page.page_id).ok_or("fixture_new_page_missing")?.page;
        a.snapshot(&new_page, &Default::default()).await?;
        let observer_switch = a.snapshot(&a_page, &Default::default()).await;
        apply(&a, &a_lease, &a_page, json!({"kind":"select_page"})).await?;
        a.snapshot(&a_page, &Default::default()).await?;
        apply(&a, &a_lease, &new_page, json!({"kind":"select_page"})).await?;
        a.snapshot(&new_page, &Default::default()).await?;
        let stale_ref = a.action(&agent, &authority(&a, &a_lease, &a_page).await, serde_json::from_value(click).unwrap()).await;

        let request = authority(&a, &a_lease, &a_page).await;
        let slow: BrowserAction = serde_json::from_value(json!({"kind":"evaluate","script":"new Promise(resolve=>setTimeout(()=>resolve(++window.writes),150))"})).unwrap();
        let human = BrowserControllerId::new("human").unwrap();
        let (drained, pending) = tokio::join!(
            a.action(&agent, &request, slow),
            async {
                timeout(Duration::from_secs(5), async {
                    loop {
                        if a.control().await.in_flight.is_some() { break; }
                        sleep(Duration::from_millis(5)).await;
                    }
                }).await.map_err(|_| BrowserRuntimeError::Observation("fixture_admission_timeout"))?;
                a.request_control(human.clone(), Some(&a_lease)).await
            }
        );
        let drained = drained?;
        let pending = pending?;
        let human_lease = a.control().await.controller.ok_or("fixture_controller_missing")?;
        let stale_lease = apply(&a, &a_lease, &a_page, json!({"kind":"evaluate","script":"++window.writes"})).await;
        let read = "({plain:document.querySelector('#plain').value,rich:document.querySelector('#rich').textContent,events:window.richEvents,writes:window.writes,storage:localStorage.getItem('owner'),cookie:document.cookie})";
        let a_state = apply(&a, &human_lease, &a_page, json!({"kind":"evaluate","script":read})).await?;
        let b_state = apply(&b, &b_lease, &b_page, json!({"kind":"evaluate","script":read})).await?;
        let endpoint = a.test_binding().engine.lock().await.chromium.endpoint().to_string();
        let origin_probe = format!("new Promise(resolve=>{{const socket=new WebSocket({endpoint:?});socket.onopen=()=>{{socket.close();resolve(true)}};socket.onerror=()=>resolve(false);setTimeout(()=>{{socket.close();resolve(false)}},1000)}})");
        let cross_origin = apply(&b, &b_lease, &b_page, json!({"kind":"evaluate","script":origin_probe})).await?;
        let screenshot = a.screenshot(&a_page).await?;
        Ok((cleared, clicked, repeated, stale_ref, drained, pending, human_lease, stale_lease, a_state, b_state, screenshot, observer_switch, cross_origin))
    }.await;
    let a_retired = a.close(&identity("resource:a")).await;
    let b_retired = b.close(&identity("resource:b")).await;
    let _ = stop.send(());
    server.await.unwrap();
    assert!(a_retired.is_ok(), "A retirement: {a_retired:?}");
    assert!(b_retired.is_ok(), "B retirement: {b_retired:?}");
    let (
        cleared,
        clicked,
        repeated,
        stale_ref,
        drained,
        pending,
        human,
        stale_lease,
        a_state,
        b_state,
        screenshot,
        observer_switch,
        cross_origin,
    ) = evidence.unwrap();
    assert!(observer_switch.is_ok(), "{observer_switch:?}");
    assert_eq!(cleared["result"], "");
    assert!(clicked.response.success);
    assert!(matches!(
        repeated,
        Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::CommandAlreadyDispatched
        ))
    ));
    assert!(matches!(
        stale_ref,
        Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::SnapshotChanged
        ))
    ));
    assert!(drained.response.success);
    assert_eq!(
        pending.requested_controller.as_ref().map(|id| id.as_str()),
        Some("human")
    );
    assert_eq!(human.controller_id.as_str(), "human");
    assert!(matches!(
        stale_lease,
        Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::ControllerChanged
        ))
    ));
    assert_eq!(a_state["result"]["plain"], "한글 입력");
    assert_eq!(a_state["result"]["rich"], "한글 편집 가능");
    assert_eq!(a_state["result"]["events"], 3);
    assert_eq!(a_state["result"]["writes"], 2);
    assert_eq!(a_state["result"]["storage"], "A");
    assert_eq!(b_state["result"]["plain"], "");
    assert_eq!(b_state["result"]["rich"], "Initial");
    assert_eq!(b_state["result"]["writes"], 0);
    assert!(b_state["result"]["storage"].is_null());
    assert_eq!(b_state["result"]["cookie"], "");
    assert_eq!(
        cross_origin["result"], false,
        "page-origin CDP connection bypassed the Host"
    );
    assert!(screenshot["base64"].as_str().unwrap().starts_with("iVBOR"));
    println!(
        "BROWSER_RUNTIME_EVIDENCE {}",
        json!({"a":a_state,"b":b_state,"retired":true})
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn pinned_worker_refuses_to_retarget_after_its_tab_closes() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let parent = tempfile::Builder::new()
        .prefix("dure-browser-engine-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) =
        crate::browser_engine::tests::exclusive_engine(&config, &parent)
            .await
            .unwrap();
    let result: Result<_, BrowserEngineError> = async {
        engine.require(json!({"action":"navigate","url":"about:blank"})).await?;
        engine.require(json!({"action":"evaluate","script":"window.wrongTargetWrites=0"})).await?;
        engine.require(json!({"action":"tab_new","url":"about:blank"})).await?;
        engine.require(json!({"action":"tab_close"})).await?;
        engine.request(json!({"action":"evaluate","script":"window.wrongTargetWrites=(window.wrongTargetWrites||0)+1"})).await
    }.await;
    let retired = engine.close().await;
    let browser_retired = chromium.close().await;
    assert!(browser_retired.is_ok(), "{browser_retired:?}");
    assert!(retired.is_ok(), "owned worker retirement: {retired:?}");
    let response = result.unwrap();
    assert!(
        !response.success,
        "a closed bound tab must not redirect input into its neighbor: {response:?}"
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn browser_exit_cannot_autolaunch_a_replacement_for_the_next_action() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-browser-generation-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let result: Result<_, BrowserEngineError> = async {
        let state = engine.require(json!({"action":"cdp_url"})).await?;
        let mut observer = super::super::cdp::BrowserCdp::connect(state["cdpUrl"].as_str().unwrap()).await.map_err(BrowserEngineError::before)?;
        let _ = observer.request("Browser.close", json!({}), None).await;
        timeout(Duration::from_secs(5), async {
            loop {
                if observer.request("Browser.getVersion", json!({}), None).await.is_err() { break; }
                sleep(Duration::from_millis(10)).await;
            }
        }).await.map_err(|_| BrowserEngineError::before("fixture_chromium_did_not_exit"))?;
        let action = engine.request(json!({"action":"evaluate","script":"window.replacementWrites=(window.replacementWrites||0)+1"})).await;
        let after = engine.request(json!({"action":"cdp_url"})).await;
        Ok((state["cdpUrl"].clone(), action, after))
    }.await;
    let retired = engine.close().await;
    let browser_retired = chromium.close().await;
    assert!(browser_retired.is_ok(), "{browser_retired:?}");
    assert!(retired.is_ok(), "retirement: {retired:?}");
    let (before, action, after) = result.unwrap();
    if let Ok(response) = &after {
        if response.success {
            assert_eq!(
                response.data["cdpUrl"], before,
                "the engine silently recreated Chromium: {action:?}"
            );
        }
    }
    assert!(action.is_err() || action.as_ref().is_ok_and(|response| !response.success));
}
