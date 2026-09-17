use super::*;
use crate::browser_engine::NativeBrowserEngineConfig;
use futures_util::{SinkExt, StreamExt};
use hmux_session_protocol::browser_resource::*;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn policy_connection_loss_keeps_chromium_downloads_in_the_owned_directory() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-download-policy-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let (mut chromium, mut engine) = crate::browser_engine::tests::exclusive_engine(&config, &root)
        .await
        .unwrap();
    let directory = chromium.download_directory();
    let result: Result<_, String> = async {
        let mut policy = prepare(&chromium).await.map_err(String::from)?;
        policy.cdp.request("Browser.setDownloadBehavior", json!({"behavior":"deny","eventsEnabled":true}), None).await.map_err(String::from)?;
        let script = r#"window.save=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['RESOURCE OWNED']));a.download='owned.txt';document.body.append(a);a.click();};save();true"#;
        engine.require(json!({"action":"evaluate","script":script})).await.map_err(|error|format!("{error:?}"))?;
        let canceled = timeout(Duration::from_secs(5), async {
            loop {
                let event = policy.cdp.next_event().await?;
                if event["method"] == "Browser.downloadProgress" && event["params"]["state"] == "canceled" {
                    return Ok::<_, &'static str>(event);
                }
            }
        }).await.map_err(|_|"denied download deadline")?.map_err(String::from)?;
        if tokio::fs::read_dir(&directory).await.map_err(|error|error.to_string())?.next_entry().await.map_err(|error|error.to_string())?.is_some() {
            return Err("denied download created a file".into());
        }
        // This fault removes the actual DevTools override connection. No new
        // allow policy or download path is sent before the second download.
        drop(policy);
        engine.require(json!({"action":"evaluate","script":"save();true"})).await.map_err(|error|format!("{error:?}"))?;
        let file = directory.join("owned.txt");
        let bytes = timeout(Duration::from_secs(5), async {
            loop {
                match tokio::fs::read(&file).await {
                    Ok(bytes) => return Ok::<_, String>(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => sleep(Duration::from_millis(25)).await,
                    Err(error) => return Err(error.to_string()),
                }
            }
        }).await.map_err(|_|"default download deadline")??;
        if bytes != b"RESOURCE OWNED" { return Err(format!("wrong downloaded bytes: {bytes:?}")); }
        Ok(json!({"canceled":canceled,"defaultPath":file,"bytes":bytes.len()}))
    }.await;
    let retired = engine.close().await;
    let browser_retired = chromium.close().await;
    assert!(browser_retired.is_ok(), "{browser_retired:?}");
    println!(
        "BROWSER_DOWNLOAD_POLICY_EVIDENCE {}",
        json!({"root":root,"result":result,"retired":retired})
    );
    assert!(retired.is_ok(), "{retired:?}");
    tokio::fs::remove_dir_all(&directory).await.unwrap();
    result.unwrap();
}

async fn apply(
    runtime: &BrowserRuntime,
    lease: &BrowserControllerLease,
    page: &BrowserPageIdentity,
    action: Value,
) -> Result<super::super::BrowserActionResult, BrowserRuntimeError> {
    let sequence = runtime.control().await.next_command_sequence;
    runtime
        .action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("download-fault:{sequence}"))
                    .unwrap(),
            },
            serde_json::from_value(action).unwrap(),
        )
        .await
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn a_lost_download_attachment_reply_fences_further_page_input() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-download-fault-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity: BrowserResourceIdentity = serde_json::from_value(json!({
        "resource_id":"download:fault", "generation":"generation:1", "workspace_id":"workspace:1",
    }))
    .unwrap();
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let (retire, retired) = oneshot::channel();
    let (attached, attachment) = oneshot::channel();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/download-fault",
        listener.local_addr().unwrap()
    );
    let actual = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .chromium
        .endpoint()
        .to_owned();
    let proxy = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut client = tokio_tungstenite::accept_async(socket).await.unwrap();
        let uri: tokio_tungstenite::tungstenite::http::Uri = actual.parse().unwrap();
        let socket = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
            .await
            .unwrap();
        let (mut chrome, _) = tokio_tungstenite::client_async(actual, socket)
            .await
            .unwrap();
        let attachment = 'requests: loop {
            let request = client.next().await.unwrap().unwrap();
            let command: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            let attach = command["method"] == "Target.attachToTarget";
            if !attach {
                assert_eq!(command["method"], "Target.getTargets");
            }
            chrome.send(request).await.unwrap();
            loop {
                let message = chrome.next().await.unwrap().unwrap();
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let response: Value = serde_json::from_str(text).unwrap();
                if response["id"] == command["id"] {
                    if attach {
                        assert!(response["result"]["sessionId"].as_str().is_some());
                        break 'requests response;
                    }
                    client.send(message).await.unwrap();
                    break;
                }
                client.send(message).await.unwrap();
            }
        };
        attached.send(attachment).unwrap();
        // Chromium created the real session, but the runtime never sees its ID.
        // Keep that session alive until after we inspect Host's next admission.
        client.close(None).await.unwrap();
        let _ = retired.await;
        let _ = chrome.close(None).await;
    });
    let result: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        let page = runtime.observe().await?.pages[0].page.clone();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=download>Download</button>';window.writes=0;true"})).await?;
        let mut connection = BrowserCdp::connect(&address).await?;
        connection.retain_events().await;
        runtime.test_binding().downloads.lock().await.as_mut().unwrap().cdp = connection;
        let download = apply(&runtime, &lease, &page, json!({"kind":"download","target":{"kind":"css","selector":"#download"},"timeout_ms":500})).await;
        let phase = runtime.control().await.phase;
        let later = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"++window.writes"})).await;
        let writes = runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"window.writes"})).await?;
        Ok((download, phase, later, writes))
    }.await;
    let _ = retire.send(());
    let proof = attachment.await;
    let proxy_closed = proxy.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_DOWNLOAD_ATTACHMENT_EVIDENCE root={} result={result:?} attachment={proof:?} retired={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    proxy_closed.unwrap();
    proof.unwrap();
    let (download, phase, later, writes) = result.unwrap();
    assert!(download.is_err(), "{download:?}");
    assert_eq!(phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(
        matches!(
            later,
            Err(BrowserRuntimeError::Admission(
                super::super::BrowserAdmissionError::OutcomeUnknown
            ))
        ),
        "{later:?}"
    );
    assert_eq!(writes["result"], 0);
}
