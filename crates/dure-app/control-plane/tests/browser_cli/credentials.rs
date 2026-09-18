use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use tokio::net::TcpListener;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("credentials fixture: {evidence:?}"))
    }
}

async fn fetch(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    path: &str,
) -> Result<Value, String> {
    let script = format!(
        "fetch({}).then(async r=>({{status:r.status,body:await r.json()}}))",
        json!(path)
    );
    Ok(cli(
        root,
        &[
            "eval",
            resource,
            &script,
            "--page",
            page,
            "--controller",
            "credentials-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn actual_cli_credentials_replace_reset_and_isolate_basic_authorization() {
    let (root, endpoint, server) = fixture().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let expected = format!("Basic {}", STANDARD.encode("사용자:암호:one"));
    let expected_empty = format!("Basic {}", STANDARD.encode("empty:"));
    let (stop_http, mut http_stopped) = oneshot::channel();
    let http = tokio::spawn(async move {
        loop {
            let (socket, _) = tokio::select! {
                _ = &mut http_stopped => return Ok::<_,String>(()),
                accepted = listener.accept() => accepted.map_err(|error| error.to_string())?,
            };
            let mut socket = BufReader::new(socket);
            let request = timeout(Duration::from_secs(5), async {
                let mut lines = Vec::new();
                let mut total = 0;
                loop {
                    let mut line = String::new();
                    if socket
                        .read_line(&mut line)
                        .await
                        .map_err(|error| error.to_string())?
                        == 0
                    {
                        return Ok::<_, String>(None);
                    }
                    total += line.len();
                    if total > 16 * 1024 {
                        return Err("fixture request too large".into());
                    }
                    if line == "\r\n" {
                        return Ok(Some(lines));
                    }
                    lines.push(line);
                }
            })
            .await
            .map_err(|_| "fixture request timeout")??;
            let Some(lines) = request else {
                continue;
            };
            let header = |name: &str| {
                lines
                    .iter()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| value.trim())
                    .unwrap_or("")
            };
            let authorization = header("authorization");
            let accepted = authorization == expected || authorization == expected_empty;
            let path = lines[0].split_whitespace().nth(1).unwrap_or("");
            let status = if path.starts_with("/protected") && !accepted {
                "401 Unauthorized"
            } else {
                "200 OK"
            };
            let body = if path.starts_with("/worker.js") {
                "onmessage=e=>fetch(e.data).then(async r=>postMessage({status:r.status,body:await r.json()}))".to_owned()
            } else if path.starts_with("/frame") {
                "<!doctype html><script>fetch('/protected?frame').then(async r=>parent.postMessage({status:r.status,body:await r.json()},'*'))</script>".to_owned()
            } else if path.starts_with("/start") {
                "<!doctype html><meta charset=utf-8><title>Credentials fixture</title>".to_owned()
            } else {
                json!({"hasAuthorization":!authorization.is_empty(),"accepted":accepted,"emptyPassword":authorization==expected_empty,"custom":header("x-fixture")}).to_string()
            };
            let challenge = if status.starts_with("401") {
                "WWW-Authenticate: Basic realm=\"Dure disposable fixture\"\r\n"
            } else {
                ""
            };
            let content_type = if path.starts_with("/worker.js") {
                "text/javascript"
            } else if path.starts_with("/start") || path.starts_with("/frame") {
                "text/html"
            } else {
                "application/json"
            };
            let response = format!(
                "HTTP/1.1 {status}\r\n{challenge}Content-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
        }
    });
    let evidence: Result<Value,String> = async {
        let created = cli(&root, &["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root, &["show",resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let control = cli(&root, &["control",resource,"--controller","credentials-proof"]).await?;
        let epoch = control["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page",page,"--controller","credentials-proof","--epoch",epoch];
        let url = format!("{base}/start");
        let mut navigate = vec!["goto",resource,&url]; navigate.extend(shared);
        cli(&root,&navigate).await?;
        let before = fetch(&root,resource,page,epoch,"/inspect?before").await?;
        require(before["status"]==200 && before["body"]["hasAuthorization"]==false,&before)?;
        let mut headers = vec!["headers",resource,r#"{"x-fixture":"old"}"#]; headers.extend(shared);
        cli(&root,&headers).await?;
        let original_view = cli(&root,&["show",resource]).await?;
        let original_control = &original_view["result"]["control"];
        let original_page = &original_view["result"]["pages"][0]["page"];
        let original_body = json!({"kind":"action","caller":"credentials-proof","authority":{"lease":original_control["controller"],"page":original_page,"operation_id":"credentials-original","command_sequence":original_control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"headers","headers":{"authorization":format!("Basic {}",STANDARD.encode("사용자:암호:one"))}}}});
        let mut set = vec!["set",resource,"credentials","--user","사용자","--pass","암호:one","--idempotency-key","credentials-original"]; set.extend(shared);
        let configured = cli(&root,&set).await?;
        let authenticated = fetch(&root,resource,page,epoch,"/protected?correct").await?;
        require(authenticated["status"]==200 && authenticated["body"]["accepted"]==true && authenticated["body"]["custom"]=="",&authenticated)?;
        require(!configured.to_string().contains("암호") && !configured.to_string().contains(&STANDARD.encode("사용자:암호:one")),"credential echoed by configuration")?;
        let mut intercept = vec!["intercept",resource,"enable","--patterns","*/blocked","--abort"]; intercept.extend(shared);
        cli(&root,&intercept).await?;
        let frame_url = format!("{}/frame",base.replace("127.0.0.1","localhost"));
        let script = format!("Promise.all([new Promise(resolve=>{{window.credentialsWorker=new Worker('/worker.js');credentialsWorker.onmessage=e=>resolve(e.data);credentialsWorker.postMessage('/protected?worker')}}),new Promise(resolve=>{{addEventListener('message',e=>resolve(e.data),{{once:true}});document.body.appendChild(Object.assign(document.createElement('iframe'),{{src:{}}}))}})])",json!(frame_url));
        let mut sources = vec!["eval",resource,&script]; sources.extend(shared);
        let sources = cli(&root,&sources).await?;
        require(sources["result"]["response"]["data"]["result"].as_array().is_some_and(|results|results.len()==2 && results.iter().all(|result|result["status"]==200 && result["body"]["accepted"]==true)),&sources)?;
        let mut wrong = vec!["set",resource,"credentials","wrong","password"]; wrong.extend(shared);
        cli(&root,&wrong).await?;
        let rejected = fetch(&root,resource,page,epoch,"/protected?wrong").await?;
        require(rejected["status"]==401 && rejected["body"]["accepted"]==false,&rejected)?;
        let mut worker = vec!["eval",resource,"new Promise(resolve=>{credentialsWorker.onmessage=e=>resolve(e.data);credentialsWorker.postMessage('/protected?worker-wrong')})"]; worker.extend(shared);
        let rejected_worker = cli(&root,&worker).await?;
        require(rejected_worker["result"]["response"]["data"]["result"]["status"]==401,&rejected_worker)?;
        let changed_sequence = cli(&root,&set).await;
        require(changed_sequence.is_err_and(|error|error.contains("browser_operation_conflict")),"a new authority reused the original operation")?;
        let replay = backend(&endpoint,"browser.resource",original_body).await;
        require(replay["result"]["replayed"]==true,&replay)?;
        let after_replay = fetch(&root,resource,page,epoch,"/inspect?replay").await?;
        require(after_replay["body"]["accepted"]==false,"replay restored old credentials")?;
        let mut empty = vec!["set",resource,"auth","empty",""]; empty.extend(shared);
        cli(&root,&empty).await?;
        let empty_password = fetch(&root,resource,page,epoch,"/protected?empty").await?;
        require(empty_password["status"]==200 && empty_password["body"]["emptyPassword"]==true,&empty_password)?;
        let current = cli(&root,&["show",resource]).await?;
        let control = &current["result"]["control"];
        let current_page = current["result"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["page"]["page_id"]==page)).ok_or("current page missing")?["page"].clone();
        let lost = json!({"kind":"action","caller":"credentials-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"credentials-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"headers","headers":{"authorization":format!("Basic {}",STANDARD.encode("old:lost"))}}}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{}\n",envelope(&endpoint,"browser.resource",lost.clone())).as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(10),async {
            loop {
                let receipt = cli(&root,&["receipt","credentials-lost-client"]).await?;
                if receipt["receipt"]["state"]=="succeeded" { return Ok::<_,String>(()); }
                if receipt["receipt"]["state"]=="failed" { return Err(format!("lost credentials failed: {receipt}")); }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.map_err(|_|"credential receipt deadline")??;
        cli(&root,&empty).await?;
        let recovered = backend(&endpoint,"browser.resource",lost).await;
        require(recovered["result"]["replayed"]==true,&recovered)?;
        require(fetch(&root,resource,page,epoch,"/protected?after-loss").await?["body"]["emptyPassword"]==true,"lost response replay restored old headers")?;
        let mut blocked = vec!["eval",resource,"fetch('/blocked').then(()=>false).catch(()=>true)"]; blocked.extend(shared);
        require(cli(&root,&blocked).await?["result"]["response"]["data"]["result"]==true,"credential replacement lost interception")?;
        cli(&root,&navigate).await?;
        require(fetch(&root,resource,page,epoch,"/protected?navigated").await?["status"]==200,"navigation lost authorization")?;
        let neighbor_url = format!("{base}/start?neighbor");
        let mut open = vec!["tab-new",resource,&neighbor_url]; open.extend(shared);
        let opened = cli(&root,&open).await?;
        let neighbor = opened["result"]["observation"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["url"]==neighbor_url)).and_then(|entry|entry["page"]["page_id"].as_str()).ok_or("neighbor missing")?;
        let neighbor_state = fetch(&root,resource,neighbor,epoch,"/inspect?neighbor").await?;
        require(neighbor_state["body"]["hasAuthorization"]==false,&neighbor_state)?;
        let other = cli(&root,&["create"]).await?;
        let other_resource = other["result"]["control"]["resource"]["resource_id"].as_str().ok_or("other resource missing")?;
        let other_view = cli(&root,&["show",other_resource]).await?;
        let other_page = other_view["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("other page missing")?;
        let other_control = cli(&root,&["control",other_resource,"--controller","credentials-proof"]).await?;
        let other_epoch = other_control["result"]["controller"]["epoch"].as_str().ok_or("other epoch missing")?;
        cli(&root,&["goto",other_resource,&url,"--page",other_page,"--controller","credentials-proof","--epoch",other_epoch]).await?;
        let other_state = fetch(&root,other_resource,other_page,other_epoch,"/inspect?other").await?;
        require(other_state["body"]["hasAuthorization"]==false,&other_state)?;
        let mut reset = vec!["set",resource,"credentials","reset"]; reset.extend(shared);
        cli(&root,&reset).await?;
        let cleared = fetch(&root,resource,page,epoch,"/inspect?cleared").await?;
        require(cleared["body"]["hasAuthorization"]==false,&cleared)?;
        require(cli(&root,&blocked).await?["result"]["response"]["data"]["result"]==true,"credential reset lost interception")?;
        let mut disable = vec!["intercept",resource,"disable"]; disable.extend(shared);
        cli(&root,&disable).await?;
        require(fetch(&root,resource,page,epoch,"/blocked").await?["status"]==200,"interception disable did not restore requests")?;
        Ok(json!({"before":before,"authenticated":authenticated,"wrong":rejected,"empty":empty_password,"neighbor":neighbor_state,"otherResource":other_state,"cleared":cleared,"sources":sources["result"]["response"]["data"]["result"],"workerRejected":rejected_worker["result"]["response"]["data"]["result"],"interceptionPreserved":true,"replayedWithoutRestoring":true}))
    }.await;
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
        "BROWSER_CREDENTIALS_CLI root={} evidence={evidence:?} retired={retired:?} http={http_retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    http_retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}
