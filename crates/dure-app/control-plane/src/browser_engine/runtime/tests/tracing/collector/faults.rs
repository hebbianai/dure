use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    accept_async, client_async,
    tungstenite::{Message, http::Uri},
};

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn malformed_completion_metadata_still_closes_the_announced_stream() {
    capture_fault(Fault::Metadata).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn missing_stream_completion_cannot_export_an_empty_success() {
    capture_fault(Fault::MissingStream).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn malformed_stream_json_still_closes_the_announced_stream() {
    capture_fault(Fault::StreamJson).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn rejected_stream_read_still_closes_the_announced_stream() {
    capture_fault(Fault::ReadRejected).await;
}

#[derive(Clone, Copy, Debug)]
pub(in crate::browser_engine::runtime::tests::tracing) enum Fault {
    Metadata,
    MissingStream,
    StreamJson,
    ReadRejected,
    CloseReplyLoss,
}

async fn capture_fault(fault: Fault) {
    let root = tempfile::Builder::new()
        .prefix("dure-trace-metadata-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("trace:metadata");
    let runtime = BrowserRuntime::launch(resource.clone(), &config(), &root)
        .await
        .unwrap();
    let binding = runtime.test_binding();
    let diagnostics = std::env::var_os("DURE_BROWSER_TEST_SHUTDOWN_DIAG");
    if let Some(helper) = &diagnostics {
        let recorded: Result<_, BrowserRuntimeError> = async {
            let processes = binding
                .cdp
                .clone()
                .request("SystemInfo.getProcessInfo", json!({}), None)
                .await?;
            let pid = processes["processInfo"]
                .as_array()
                .ok_or("trace_fixture_processes_missing")?
                .iter()
                .find(|row| row["type"] == "browser")
                .and_then(|row| row["id"].as_u64())
                .ok_or("trace_fixture_browser_pid_missing")?;
            let output = tokio::process::Command::new("node")
                .arg(helper)
                .arg("record")
                .arg(&root)
                .arg(pid.to_string())
                .output()
                .await
                .map_err(|_| "trace_fixture_diagnostics_unavailable")?;
            println!(
                "BROWSER_SHUTDOWN_OWNER root={} result={output:?}",
                root.display()
            );
            if !output.status.success() {
                return Err("trace_fixture_diagnostics_failed".into());
            }
            Ok(())
        }
        .await;
        if let Err(error) = recorded {
            let closed = runtime.close(&resource).await;
            panic!("shutdown ownership recording failed: {error:?}, cleanup={closed:?}");
        }
    }
    let endpoint = binding.instance.connection().await.endpoint().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/trace-metadata",
        listener.local_addr().unwrap()
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let proxy = tokio::spawn(invalid_stream(listener, endpoint.clone(), stopped, fault));
    binding.instance.replace_test_endpoint(address).await;
    let mut retained = None;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let trace = start(&runtime, &page, TraceMode::Trace).await?;
        retained = Some(trace.clone());
        trace.started().await?;
        let captured = trace.stop().await?;
        summarize(&captured)
    }
    .await;
    if let Some(trace) = retained {
        let _ = trace.retire().await;
    }
    binding.instance.replace_test_endpoint(endpoint).await;
    let closed = runtime.close(&resource).await;
    if closed.is_err()
        && let Some(helper) = diagnostics
    {
        let diagnostic = tokio::process::Command::new("node")
            .arg(helper)
            .arg("sample")
            .arg(&root)
            .output()
            .await;
        println!(
            "BROWSER_SHUTDOWN_DIAGNOSTIC root={} result={diagnostic:?}",
            root.display()
        );
    }
    let _ = stop.send(());
    let proxy_closed = proxy.await;
    println!(
        "BROWSER_TRACE_METADATA fault={fault:?} root={} evidence={evidence:?} closed={closed:?} proxy_closed={proxy_closed:?}",
        root.display()
    );
    assert!(closed.is_ok());
    let evidence = evidence.unwrap();
    let proxy = proxy_closed.unwrap();
    let (code, closes) = match fault {
        Fault::Metadata => ("browser_trace_completion_invalid", 1),
        Fault::MissingStream => ("browser_trace_stream_missing", 0),
        Fault::StreamJson => ("browser_trace_stream_json_invalid", 1),
        Fault::ReadRejected => ("browser_cdp_request_rejected", 1),
        Fault::CloseReplyLoss => ("browser_trace_stream_close_failed", 1),
    };
    assert_eq!(evidence["error"], code);
    assert_eq!(evidence["bytes"], 0);
    assert_eq!(evidence["ended"], true);
    assert_eq!(proxy["corrupted"], true);
    assert_eq!(proxy["knownStream"], true);
    assert_eq!(proxy["closeRequests"], closes);
    assert_eq!(proxy["closeAcknowledged"], closes == 1);
    assert_eq!(
        evidence["streamClosed"],
        closes == 1 && !matches!(fault, Fault::CloseReplyLoss)
    );
}

pub(in crate::browser_engine::runtime::tests::tracing) async fn invalid_stream(
    listener: TcpListener,
    endpoint: String,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
    fault: Fault,
) -> Value {
    let (stream, _) = listener.accept().await.unwrap();
    let mut client = accept_async(stream).await.unwrap();
    let uri: Uri = endpoint.parse().unwrap();
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", uri.port_u16().unwrap()))
        .await
        .unwrap();
    let (mut chrome, _) = client_async(endpoint, stream).await.unwrap();
    let mut stream = None;
    let mut close_id = None;
    let mut read_id = None;
    let mut close_requests = 0;
    let mut close_acknowledged = false;
    let mut corrupted = false;
    loop {
        tokio::select! {
            _=&mut stopped=>break,
            message=client.next()=>{
                let Some(Ok(message))=message else {break;};
                if let Ok(text)=message.to_text() {
                    let request:Value=serde_json::from_str(text).unwrap();
                    if request["method"]=="IO.close" && stream.as_ref().is_some_and(|stream|request["params"]["handle"]==*stream) {
                        close_requests+=1;close_id=Some(request["id"].clone());
                    }
                    if request["method"]=="IO.read" && stream.as_ref().is_some_and(|stream|request["params"]["handle"]==*stream) {
                        read_id=Some(request["id"].clone());
                    }
                }
                if chrome.send(message).await.is_err() {break;}
            },
            message=chrome.next()=>{
                let Some(Ok(mut message))=message else {break;};
                if let Ok(text)=message.to_text() {
                    let mut response:Value=serde_json::from_str(text).unwrap();
                    if close_id.as_ref().is_some_and(|id|response["id"]==*id) && response.get("result").is_some() {
                        close_acknowledged=true;
                        if matches!(fault, Fault::CloseReplyLoss) {corrupted=true;continue;}
                    }
                    if response["method"]=="Tracing.tracingComplete" {
                        stream=response["params"]["stream"].as_str().map(str::to_owned);
                        match fault {
                            Fault::Metadata=>{response["params"]["dataLossOccurred"]=json!("invalid");corrupted=true;},
                            Fault::MissingStream=>{response["params"].as_object_mut().unwrap().remove("stream");corrupted=true;},
                            _=>{},
                        }
                        message=Message::text(response.to_string());
                    }
                    if !corrupted && read_id.as_ref().is_some_and(|id|response["id"]==*id) && response.get("result").is_some() {
                        match fault {
                            Fault::StreamJson=>{response["result"]=json!({"data":"{broken","eof":true,"base64Encoded":false});corrupted=true;},
                            Fault::ReadRejected=>{
                                response.as_object_mut().unwrap().remove("result");
                                response["error"]=json!({"code":-32000,"message":"owned trace fixture read failure"});corrupted=true;
                            },
                            _=>{},
                        }
                        message=Message::text(response.to_string());
                    }
                }
                if client.send(message).await.is_err() {break;}
            },
        }
    }
    let _ = client.close(None).await;
    let _ = chrome.close(None).await;
    json!({"knownStream":stream.is_some(),"corrupted":corrupted,"closeRequests":close_requests,"closeAcknowledged":close_acknowledged})
}
