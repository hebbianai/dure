use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Copy)]
enum Fault {
    AfterData,
    InvalidHandle,
    NeverReadable,
}

#[tokio::test]
async fn a_readable_stream_failure_stops_once_without_reentering_initial_readiness() {
    prove(Fault::AfterData).await;
}

#[tokio::test]
async fn an_invalid_stream_handle_is_not_a_readiness_wait() {
    prove(Fault::InvalidHandle).await;
}

#[tokio::test]
async fn initial_stream_readiness_has_a_finite_failure_boundary() {
    prove(Fault::NeverReadable).await;
}

async fn prove(fault: Fault) {
    let resource = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("recording:stream-fault").unwrap(),
        generation: BrowserResourceGeneration::new("generation").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
    };
    let mut host = BrowserResourceHost::new(resource.clone());
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("target").unwrap(),
            BrowserDocumentId::new("document").unwrap(),
        )
        .unwrap();
    let control = host
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .unwrap();
    let lease = control.controller.unwrap();
    let authority = BrowserActionAuthority {
        lease: lease.clone(),
        page: page.clone(),
        operation_id: BrowserOperationId::new("start").unwrap(),
        command_sequence: control.next_command_sequence,
    };
    let action = host
        .begin_action(&lease.controller_id, &authority, [])
        .unwrap();
    let prepared = host.prepare_recording(&action, true).unwrap();
    let capture = host.recording_acknowledged(prepared).unwrap().unwrap();
    host.finish_action(action, BrowserActionOutcome::Completed)
        .unwrap();
    let host = Arc::new(Mutex::new(host));
    let changed = Arc::new(tokio::sync::Notify::new());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/recording-fault",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut reads = 0;
        let mut stops = 0;
        let mut closes = 0;
        while let Some(Ok(message)) = socket.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            let mut response = json!({"id":request["id"]});
            assert_eq!(request["sessionId"], "owned-session");
            match request["method"].as_str().unwrap() {
                "Page.captureScreenshot" => response["result"] = json!({"data":"fixture-frame"}),
                "IO.read" => {
                    reads += 1;
                    if matches!(fault, Fault::AfterData) && reads == 2 {
                        response["result"] =
                            json!({"data":"first-video-fragment","base64Encoded":false,"eof":true});
                    } else {
                        response["error"] = if matches!(fault, Fault::InvalidHandle) {
                            json!({"code":-32602,"message":"Invalid stream handle"})
                        } else {
                            json!({"code":-32000,"message":"Read failed"})
                        };
                    }
                }
                "Page.stopScreenRecording" => {
                    stops += 1;
                    response["result"] = json!({"stream":"owned-stream"});
                }
                "IO.close" => {
                    closes += 1;
                    response["result"] = json!({});
                }
                method => panic!("unexpected native command {method}"),
            }
            if socket
                .send(Message::text(response.to_string()))
                .await
                .is_err()
            {
                break;
            }
        }
        (reads, stops, closes)
    });
    let cdp = BrowserCdp::connect(&address).await.unwrap();
    let worker = RecordingWorker::start(
        Arc::clone(&host),
        changed,
        cdp.clone(),
        NativeRecording {
            session: "owned-session".into(),
            stream: "owned-stream".into(),
            worker: None,
        },
        capture,
    );
    let captured = tokio::time::timeout(Duration::from_secs(8), worker.wait()).await;
    // Retire the exact command connection before checking the assertions,
    // including when the timeout is the finding under test.
    cdp.retire().await;
    worker.retire().await;
    let calls = server.await.unwrap();
    let captured = captured.unwrap().unwrap();
    assert!(captured.stopped && captured.closed, "{captured:?}");
    assert_eq!((calls.1, calls.2), (1, 1));
    match fault {
        Fault::AfterData => {
            assert_eq!(calls.0, 3);
            assert_eq!(captured.bytes, b"first-video-fragment");
            assert_eq!(captured.error, Some("browser_cdp_stream_read_failed"));
        }
        Fault::InvalidHandle => {
            assert_eq!(calls.0, 1);
            assert_eq!(captured.error, Some("browser_cdp_request_rejected"));
        }
        Fault::NeverReadable => {
            assert!(calls.0 >= 2);
            assert_eq!(captured.error, Some("browser_cdp_stream_read_failed"));
        }
    }
    let status = host
        .lock()
        .await
        .recording_status(&resource, &page.page_id)
        .unwrap();
    assert!(status.finished);
    assert_eq!(status.phase, BrowserResourcePhase::Ready);
}
