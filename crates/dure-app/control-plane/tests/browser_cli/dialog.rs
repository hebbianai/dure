use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{WebSocketStream, client_async, tungstenite::Message};
#[path = "dialog/control.rs"]
mod control;
#[path = "dialog/journal.rs"]
mod journal;
#[path = "dialog/retirement.rs"]
mod retirement;

struct Observer {
    socket: WebSocketStream<TcpStream>,
    next: u64,
    session: Option<String>,
}

impl Observer {
    async fn connect(root: &Path) -> Result<Self, String> {
        // This fixture owns the only resource in this disposable backend.
        let ports: Vec<_> = fs::read_dir(root.join("backend"))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("profile/DevToolsActivePort"))
            .filter(|path| path.is_file())
            .collect();
        if ports.len() != 1 {
            return Err(format!("fixture browser ports: {ports:?}"));
        }
        let port_file = fs::read_to_string(&ports[0]).map_err(|e| e.to_string())?;
        let mut lines = port_file.lines();
        let port = lines.next().ok_or("fixture port missing")?;
        let path = lines.next().ok_or("fixture endpoint missing")?;
        let stream = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .map_err(|e| e.to_string())?;
        let (socket, _) = client_async(format!("ws://127.0.0.1:{port}{path}"), stream)
            .await
            .map_err(|e| e.to_string())?;
        let mut observer = Self {
            socket,
            next: 1,
            session: None,
        };
        let target = selected_target(root).await?;
        let attached = observer
            .request(
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
            )
            .await?;
        observer.session = Some(
            attached["sessionId"]
                .as_str()
                .ok_or("fixture session missing")?
                .into(),
        );
        observer.request("Page.enable", json!({})).await?;
        Ok(observer)
    }

    async fn next(&mut self) -> Result<Value, String> {
        loop {
            let message = self
                .socket
                .next()
                .await
                .ok_or("fixture disconnected")?
                .map_err(|e| e.to_string())?;
            if let Message::Text(text) = message {
                return serde_json::from_str(&text).map_err(|e| e.to_string());
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        let mut request = json!({"id":id,"method":method,"params":params});
        if let Some(session) = &self.session {
            request["sessionId"] = session.clone().into();
        }
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|e| e.to_string())?;
        timeout(Duration::from_secs(5), async {
            loop {
                let response = self.next().await?;
                if response["id"] == id {
                    if !response["error"].is_null() {
                        return Err(format!("fixture {method}: {response}"));
                    }
                    return Ok(response["result"].clone());
                }
            }
        })
        .await
        .map_err(|_| format!("fixture {method} timeout"))?
    }
}

async fn selected_target(root: &Path) -> Result<String, String> {
    // The sole fixture worker selects its owned page at launch or through an
    // admitted CLI action. A browser census also includes the process owner's
    // unclaimed bootstrap page and cannot identify our page.
    let sockets: Vec<_> = fs::read_dir(root.join("backend"))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("worker.sock"))
        .filter(|path| path.exists())
        .collect();
    if sockets.len() != 1 {
        return Err(format!("fixture worker sockets: {sockets:?}"));
    }
    timeout(Duration::from_secs(5), async {
        let mut worker = UnixStream::connect(&sockets[0])
            .await
            .map_err(|e| e.to_string())?;
        worker
            .write_all(b"{\"id\":\"fixture-page\",\"action\":\"tab_list\"}\n")
            .await
            .map_err(|e| e.to_string())?;
        let mut response = String::new();
        BufReader::new(worker)
            .read_line(&mut response)
            .await
            .map_err(|e| e.to_string())?;
        let response: Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
        if response["id"] != "fixture-page" || response["success"] != true {
            return Err(format!("fixture worker selection: {response}"));
        }
        let selected: Vec<_> = response["data"]["tabs"]
            .as_array()
            .ok_or("fixture tabs missing")?
            .iter()
            .filter(|tab| tab["active"] == true)
            .collect();
        match selected.as_slice() {
            [tab] => tab["targetId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "fixture target missing".into()),
            _ => Err(format!("fixture selected tabs: {selected:?}")),
        }
    })
    .await
    .map_err(|_| "fixture worker selection timeout".to_string())?
}

pub(super) async fn exercise(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<(), String> {
    let shared = [
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
    ];
    let mut setup = vec![
        "eval",
        resource,
        "document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>window.dialogAnswer=prompt('CLI dialog fixture','original');true",
    ];
    setup.extend(shared);
    cli(root, &setup).await?;
    let mut observer = Observer::connect(root).await?;
    let current = cli(root, &["show", resource]).await?;
    let view = &current["result"];
    let click = json!({"kind":"action","caller":"agent-proof","authority":{"lease":view["control"]["controller"],"page":view["pages"][0]["page"],"operation_id":"dialog-trigger","command_sequence":view["control"]["next_command_sequence"]},"action":{"kind":"click","target":{"kind":"css","selector":"#ask"}}});
    let (clicked, evidence) = tokio::join!(backend(endpoint, "browser.resource", click), async {
        let opened = timeout(Duration::from_secs(8), async {
            loop {
                let event = observer.next().await?;
                if event["method"] == "Page.javascriptDialogOpening" {
                    return Ok::<_, String>(event);
                }
            }
        })
        .await
        .map_err(|_| "fixture dialog did not open".to_string())
        .and_then(|r| r);
        let status = timeout(
            Duration::from_secs(3),
            cli(root, &["dialog", resource, "status", "--page", page]),
        )
        .await;
        let mut args = vec!["dialog", resource, "accept", "한글 CLI 응답"];
        args.extend(shared);
        let answered = timeout(Duration::from_secs(3), cli(root, &args)).await;
        let cleanup = if matches!(answered, Ok(Ok(_))) {
            None
        } else {
            Some(
                observer
                    .request("Page.handleJavaScriptDialog", json!({"accept":false}))
                    .await,
            )
        };
        (opened, status, answered, cleanup)
    });
    let actual = observer
        .request(
            "Runtime.evaluate",
            json!({"expression":"window.dialogAnswer","returnByValue":true}),
        )
        .await;
    observer
        .socket
        .close(None)
        .await
        .map_err(|e| e.to_string())?;
    println!("BROWSER_DIALOG_CLI clicked={clicked} evidence={evidence:?} actual={actual:?}");
    let (opened, status, answered, cleanup) = evidence;
    opened?;
    let status = status.map_err(|_| "dialog status blocked".to_string())??;
    if status["result"]["dialog"]["kind"] != "prompt"
        || status["result"]["dialog"]["message"] != "CLI dialog fixture"
        || status["result"]["dialog"]["default_prompt"] != "original"
        || status["result"]["control"]["in_flight"] != "dialog-trigger"
    {
        return Err(format!("dialog status: {status}"));
    }
    answered.map_err(|_| "dialog response blocked".to_string())??;
    if cleanup.is_some()
        || clicked["result"]["result"]["response"]["success"] != true
        || actual?["result"]["value"] != "한글 CLI 응답"
    {
        return Err(format!(
            "dialog effect or cleanup: clicked={clicked} cleanup={cleanup:?}"
        ));
    }
    Ok(())
}
