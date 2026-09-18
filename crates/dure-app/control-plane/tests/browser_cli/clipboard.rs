use super::*;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    condition
        .then_some(())
        .ok_or_else(|| format!("clipboard fixture: {evidence:?}"))
}

async fn action(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        values[0],
        resource,
        "--page",
        page,
        "--controller",
        "clipboard-proof",
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(&values[1..]);
    Ok(cli(root, &args).await?["result"]["response"]["data"]["result"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned headless Chromium, native engine and Node"]
async fn actual_clipboard_permissions_authority_isolation_and_receipt_recovery() {
    let (root, endpoint, server) = fixture().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop_http, mut http_stopped) = oneshot::channel();
    let http = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut http_stopped => break,
                accepted = listener.accept() => {
                    let (socket, _) = accepted.map_err(|error| error.to_string())?;
                    requests.spawn(async move {
                        let mut socket = BufReader::new(socket);
                        timeout(Duration::from_secs(5), async {
                            let mut total = 0;
                            loop {
                                let mut line = String::new();
                                if socket.read_line(&mut line).await.map_err(|error| error.to_string())? == 0 { return Ok::<_,String>(()); }
                                total += line.len();
                                if total > 16 * 1024 { return Err("HTTP fixture request too large".into()); }
                                if line == "\r\n" { break; }
                            }
                            let body = "<!doctype html><meta charset=utf-8><title>Clipboard fixture</title><input id=focus value='보존할 입력'><script>window.instance=crypto.randomUUID()</script>";
                            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            socket.write_all(response.as_bytes()).await.map_err(|error| error.to_string())
                        }).await.map_err(|_| "HTTP fixture timeout".to_owned())?
                    });
                },
                Some(result) = requests.join_next(), if !requests.is_empty() => { result.map_err(|error| error.to_string())??; }
            }
        }
        while let Some(result) = requests.join_next().await {
            result.map_err(|error| error.to_string())??;
        }
        Ok::<_, String>(())
    });
    let mut resources = Vec::new();
    let evidence: Result<Value,String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        resources.push(resource.to_owned());
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let controlled = cli(&root, &["control", resource, "--controller", "clipboard-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("controller missing")?;
        action(&root, resource, page, epoch, &["goto", &origin]).await?;
        let inspect = "({instance:window.instance,value:document.querySelector('#focus').value,focus:document.activeElement.id})";
        action(&root, resource, page, epoch, &["focus", "#focus"]).await?;
        let original = action(&root, resource, page, epoch, &["eval", inspect]).await?;
        for permission in ["clipboard-read", "clipboard-write"] {
            action(&root, resource, page, epoch, &["permission", permission, "denied", &origin]).await?;
        }
        let denied_read = action(&root, resource, page, epoch, &["clipboard", "read"]).await;
        require(denied_read.as_ref().is_err_and(|error| error.contains("NotAllowedError")), &denied_read)?;
        let denied_write = action(&root, resource, page, epoch, &["clipboard", "write", "must not write"]).await;
        require(denied_write.as_ref().is_err_and(|error| error.contains("NotAllowedError")), &denied_write)?;
        for permission in ["clipboard-read", "clipboard-write"] {
            action(&root, resource, page, epoch, &["permission", permission, "granted", &origin]).await?;
        }
        let initial = action(&root, resource, page, epoch, &["clipboard", "read"]).await?;
        require(initial == json!({"text":""}), &initial)?;
        let text = "한글 여러 줄\n🚀 ' \" \\ --help";
        let written = action(&root, resource, page, epoch, &["clipboard", "write", "--text", text]).await?;
        let read = action(&root, resource, page, epoch, &["clipboard", "read"]).await?;
        require(written == json!({"written":text}) && read == json!({"text":text}), (&written, &read))?;
        let maximum = "한".repeat(2730) + "ab";
        action(&root, resource, page, epoch, &["clipboard", "write", &maximum]).await?;
        require(action(&root, resource, page, epoch, &["clipboard", "read"]).await? == json!({"text":maximum}), "8192-byte round trip")?;
        let too_large = action(&root, resource, page, epoch, &["clipboard", "write", &(maximum.clone() + "x")]).await;
        require(too_large.as_ref().is_err_and(|error| error.contains("browser_clipboard_text_too_large")), &too_large)?;
        for command in [["read"].as_slice(), ["write", "uncontrolled"].as_slice()] {
            let mut args = vec!["clipboard", resource, "--page", page]; args.extend_from_slice(command);
            let denied = cli(&root, &args).await;
            require(denied.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &denied)?;
        }
        let stale = action(&root, resource, page, "stale-epoch", &["clipboard", "write", "stale"]).await;
        require(stale.as_ref().is_err_and(|error| error.contains("browser_controller_changed")), &stale)?;
        let after = action(&root, resource, page, epoch, &["eval", inspect]).await?;
        require(original == after, (&original, &after))?;

        // Shortcuts use Chromium's selection and editing defaults, preserving
        // Korean text and the page's ability to cancel an input event.
        action(&root, resource, page, epoch, &["select-all", "#focus"]).await?;
        let copied = cli(&root, &["clipboard", resource, "copy", "--page", page, "--controller", "clipboard-proof", "--epoch", epoch]).await?;
        require(copied["result"]["response"]["data"]["copied"] == true, &copied)?;
        require(action(&root, resource, page, epoch, &["clipboard", "read"]).await? == json!({"text":"보존할 입력"}), "copy did not use the selected input")?;
        action(&root, resource, page, epoch, &["eval", "document.body.insertAdjacentHTML('beforeend','<textarea id=paste>replace</textarea>');window.pasteEvents=0;document.querySelector('#paste').addEventListener('paste',()=>window.pasteEvents++);true"]).await?;
        action(&root, resource, page, epoch, &["select-all", "#paste"]).await?;
        let pasted = cli(&root, &["exec", resource, "--command", "clipboard paste", "--page", page, "--controller", "clipboard-proof", "--epoch", epoch]).await?;
        require(pasted["result"]["response"]["data"]["pasted"] == true, &pasted)?;
        require(cli(&root, &["get", resource, "value", "#paste", "--page", page]).await?["result"]["data"]["value"] == "보존할 입력", "paste did not replace the selection")?;
        require(action(&root, resource, page, epoch, &["eval", "window.pasteEvents"]).await? == 1, "paste event missing or repeated")?;
        action(&root, resource, page, epoch, &["eval", "document.querySelector('#paste').addEventListener('keydown',event=>{if(event.key.toLowerCase()==='v'&&(event.metaKey||event.ctrlKey))event.preventDefault()});true"]).await?;
        action(&root, resource, page, epoch, &["clipboard", "write", "blocked paste"]).await?;
        action(&root, resource, page, epoch, &["select-all", "#paste"]).await?;
        action(&root, resource, page, epoch, &["clipboard", "paste"]).await?;
        require(cli(&root, &["get", resource, "value", "#paste", "--page", page]).await?["result"]["data"]["value"] == "보존할 입력", "paste bypassed preventDefault")?;
        require(action(&root, resource, page, epoch, &["eval", "window.pasteEvents"]).await? == 1, "cancelled shortcut emitted paste")?;

        // Journal recovery must not overwrite a newer clipboard value.
        let view = cli(&root, &["show", resource]).await?;
        let control = &view["result"]["control"];
        let identity = &view["result"]["pages"][0]["page"];
        let lost = json!({"kind":"action","caller":"clipboard-proof","authority":{"lease":control["controller"],"page":identity,"command_sequence":control["next_command_sequence"],"operation_id":"clipboard-lost-response"},"action":{"kind":"evaluate","script":"navigator.clipboard.writeText('lost-original').then(()=>({written:'lost-original'}))"}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error| error.to_string())?;
        socket.write_all(format!("{}\n", envelope(&endpoint, "browser.resource", lost.clone())).as_bytes()).await.map_err(|error| error.to_string())?;
        drop(socket);
        let receipt = timeout(Duration::from_secs(10), async {
            loop {
                let receipt = cli(&root, &["receipt", "clipboard-lost-response"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded") => return Ok::<_,String>(receipt),
                    Some("failed") => return Err(format!("lost clipboard failed: {receipt}")),
                    _ => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.map_err(|_| "clipboard receipt deadline")??;
        require(action(&root, resource, page, epoch, &["clipboard", "read"]).await? == json!({"text":"lost-original"}), &receipt)?;
        action(&root, resource, page, epoch, &["clipboard", "write", "newer"]).await?;
        let recovered = backend(&endpoint, "browser.resource", lost).await;
        require(recovered["result"]["replayed"] == true, &recovered)?;
        require(action(&root, resource, page, epoch, &["clipboard", "read"]).await? == json!({"text":"newer"}), "recovery repeated the write")?;

        // Headless clipboard belongs to the browser process, shared by its tabs.
        let opened = action(&root, resource, page, epoch, &["tab-new", &origin]).await;
        opened?;
        let tabs = cli(&root, &["show", resource]).await?;
        let neighbor = tabs["result"]["pages"].as_array().and_then(|pages| pages.iter().find(|entry| entry["page"]["page_id"] != page)).and_then(|entry| entry["page"]["page_id"].as_str()).ok_or("neighbor missing")?;
        require(action(&root, resource, neighbor, epoch, &["clipboard", "read"]).await? == json!({"text":"newer"}), "same browser tab clipboard differs")?;
        let another_origin = origin.replace("127.0.0.1", "localhost");
        action(&root, resource, neighbor, epoch, &["goto", &another_origin]).await?;
        let permission_state = action(&root, resource, neighbor, epoch, &["eval", "navigator.permissions.query({name:'clipboard-read'}).then(p=>p.state)"]).await?;
        require(permission_state != "granted", &permission_state)?;

        let profile = cli(&root, &["tab", "profile", "create", "--label", "Clipboard isolation", "--scope", "isolated"]).await?;
        let profile_id = profile["result"]["profile"]["profile"]["profileId"].as_str().ok_or("profile missing")?;
        let other = cli(&root, &["create", "--profile", profile_id]).await?;
        let other_resource = other["result"]["control"]["resource"]["resource_id"].as_str().ok_or("other resource missing")?;
        resources.push(other_resource.to_owned());
        let other_view = cli(&root, &["show", other_resource]).await?;
        let other_page = other_view["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("other page missing")?;
        let other_control = cli(&root, &["control", other_resource, "--controller", "clipboard-proof"]).await?;
        let other_epoch = other_control["result"]["controller"]["epoch"].as_str().ok_or("other epoch missing")?;
        action(&root, other_resource, other_page, other_epoch, &["goto", &origin]).await?;
        action(&root, other_resource, other_page, other_epoch, &["permission", "clipboard-read", "granted", &origin]).await?;
        let isolated = action(&root, other_resource, other_page, other_epoch, &["clipboard", "read"]).await?;
        require(isolated == json!({"text":""}), &isolated)?;
        action(&root, resource, neighbor, epoch, &["tab-switch"]).await?;
        action(&root, resource, neighbor, epoch, &["goto", &origin]).await?;
        action(&root, resource, neighbor, epoch, &["clipboard", "write", ""]).await?;
        require(action(&root, resource, neighbor, epoch, &["clipboard", "read"]).await? == json!({"text":""}), "empty write differs")?;
        Ok(json!({"read":read,"written":written,"maximumBytes":maximum.len(),"pagePreserved":after,"permissionOtherOrigin":permission_state,"isolated":isolated,"sameBrowserTabsShareClipboard":true,"lostResponseReplayedWithoutWrite":true,"emptyWrite":true,"copied":copied,"pasted":pasted,"cancelledPastePreserved":true}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources.iter().rev() {
        closed.push(cli(&root, &["close", resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    let _ = stop_http.send(());
    let http_retired = timeout(Duration::from_secs(10), http).await;
    println!(
        "BROWSER_CLIPBOARD_CLI root={} evidence={evidence:?} closed={closed:?} retired={retired:?} http={http_retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    for result in closed {
        result.unwrap();
    }
    evidence.unwrap();
}
