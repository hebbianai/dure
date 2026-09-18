use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, UnixStream},
    sync::Mutex,
    time::{Duration, timeout},
};

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser policy: {evidence:?}"))
    }
}

async fn write(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    command: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        command,
        resource,
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(values);
    cli(home, &args).await
}

async fn eval(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    Ok(
        write(home, resource, page, epoch, "eval", &[script]).await?["result"]["response"]["data"]
            ["result"]
            .clone(),
    )
}

const GEO: &str = "new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy}),e=>resolve({error:e.code}),{maximumAge:0,timeout:2000}))";
const PERMISSION: &str = "navigator.permissions.query({name:'geolocation'}).then(p=>p.state)";
const PROBE: &str = "fetch('/probe',{cache:'no-store'}).then(async r=>({online:navigator.onLine,body:await r.json()})).catch(()=>({online:navigator.onLine,error:'fetch'}))";

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().unwrap().port();
    let origin = format!("http://127.0.0.1:{port}");
    let other_origin = format!("http://localhost:{port}");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed_requests = Arc::clone(&requests);
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let mut reader = BufReader::new(socket);
            let mut first = String::new();
            if reader.read_line(&mut first).await.is_err() {
                continue;
            }
            let path = first.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let mut headers = serde_json::Map::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    headers.insert(name.to_ascii_lowercase(), value.trim().into());
                }
            }
            let body = if path.starts_with("/probe") {
                let seen = json!({"path":path,"headers":headers});
                observed_requests.lock().await.push(seen.clone());
                seen.to_string()
            } else {
                "<!doctype html><meta charset=utf-8><title>Browser policy fixture</title><button id=fixture>Policy</button>".to_owned()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
                if path.starts_with("/probe") {
                    "application/json"
                } else {
                    "text/html"
                },
                body.len()
            );
            let _ = reader.get_mut().write_all(response.as_bytes()).await;
        }
    });
    let mut other_resource = None;
    let result: Result<_,String> = async {
        write(home,resource,page,epoch,"goto",&[&origin]).await?;
        write(home,resource,page,epoch,"tab-new",&[&origin]).await?;
        let shown = cli(home,&["show",resource]).await?;
        let peer = shown["result"]["pages"].as_array().unwrap().iter().find(|entry|entry["page"]["page_id"]!=page && entry["url"].as_str().is_some_and(|url|url.starts_with(&origin))).ok_or("policy peer missing")?["page"]["page_id"].as_str().unwrap();
        let baseline = eval(home,resource,page,epoch,PROBE).await?;
        require(baseline["online"]==true && baseline["body"]["headers"].get("x-dure-policy").is_none(),&baseline)?;
        write(home,resource,page,epoch,"headers",&[r#"{"X-Dure-Policy":"first","X-Replace":"old","__proto__":"literal"}"#,"--idempotency-key","headers-policy-proof"]).await?;
        let first = eval(home,resource,page,epoch,PROBE).await?;
        println!("BROWSER_POLICY_HEADERS_FIRST {first}");
        require(first["body"]["headers"]["x-dure-policy"]=="first" && first["body"]["headers"]["__proto__"]=="literal",&first)?;
        let peer_state = eval(home,resource,peer,epoch,PROBE).await?;
        require(peer_state["online"]==true && peer_state["body"]["headers"].get("x-dure-policy").is_none(),&peer_state)?;
        write(home,resource,page,epoch,"set",&["headers",r#"{"X-Dure-Policy":"second"}"#]).await?;
        let second = eval(home,resource,page,epoch,PROBE).await?;
        require(second["body"]["headers"]["x-dure-policy"]=="second" && second["body"]["headers"].get("x-replace").is_none() && second["body"]["headers"].get("__proto__").is_none(),&second)?;
        let inspected = cli(home,&["show",resource]).await?;
        let control_before_invalid = inspected["result"]["control"].clone();
        let live_page = inspected["result"]["pages"].as_array().unwrap().iter().find(|entry|entry["page"]["page_id"]==page).unwrap()["page"].clone();
        for (index,action) in [json!({"kind":"geolocation","latitude":91,"longitude":0}),json!({"kind":"headers","headers":{"x":"one\r\nx-injected:two"}}),json!({"kind":"headers","headers":{"X":"one","x":"two"}}),json!({"kind":"permission","permission":"geolocation","setting":"granted","origin":origin,"browserContextId":"unowned-context"})].into_iter().enumerate() {
            let invalid = backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control_before_invalid["controller"],"page":live_page,"operation_id":format!("policy-invalid-{index}"),"command_sequence":control_before_invalid["next_command_sequence"]},"action":{"kind":"environment","action":action}})).await;
            require(invalid["error"]["code"].as_str().is_some(),&invalid)?;
        }
        require(cli(home,&["show",resource]).await?["result"]["control"]==control_before_invalid,"invalid backend input changed Host control")?;
        let denied = cli(home,&["headers",resource,r#"{"X-Dure-Policy":"denied"}"#,"--page",page]).await;
        require(denied.as_ref().is_err_and(|e|e.contains("browser_controller_changed")),&denied)?;
        let duplicate = write(home,resource,page,epoch,"headers",&[r#"{"X-Dure-Policy":"conflict"}"#,"--idempotency-key","headers-policy-proof"]).await;
        require(duplicate.as_ref().is_err_and(|e|e.contains("browser_operation_conflict")),&duplicate)?;
        write(home,resource,page,epoch,"offline",&["on"]).await?;
        let before_requests = requests.lock().await.len();
        let offline = eval(home,resource,page,epoch,PROBE).await?;
        require(offline==json!({"online":false,"error":"fetch"}),&offline)?;
        require(requests.lock().await.len()==before_requests,"offline fetch reached server")?;
        cli(home,&["network",resource,"--page",page]).await?;
        cli(home,&["snapshot",resource,"--page",page]).await?;
        require(eval(home,resource,page,epoch,PROBE).await?==offline,"observation removed offline setting")?;
        require(eval(home,resource,peer,epoch,PROBE).await?["online"]==true,"offline leaked to peer")?;
        write(home,resource,page,epoch,"set",&["offline","off"]).await?;
        write(home,resource,page,epoch,"goto",&[&format!("{origin}/next")]).await?;
        let navigated = eval(home,resource,page,epoch,PROBE).await?;
        require(navigated["online"]==true && navigated["body"]["headers"]["x-dure-policy"]=="second",&navigated)?;

        write(home,resource,page,epoch,"geo",&["37.5665","126.978","--accuracy","3.5"]).await?;
        write(home,resource,peer,epoch,"geo",&["35.1796","129.0756","--accuracy","4"]).await?;
        write(home,resource,page,epoch,"permission",&["geolocation","denied",&origin]).await?;
        require(eval(home,resource,page,epoch,GEO).await?==json!({"error":1}),"denied location was readable")?;
        write(home,resource,page,epoch,"permission",&["geolocation","granted",&origin]).await?;
        let location = eval(home,resource,page,epoch,GEO).await?;
        require(location==json!({"latitude":37.5665,"longitude":126.978,"accuracy":3.5}),&location)?;
        let peer_location = eval(home,resource,peer,epoch,GEO).await?;
        require(peer_location==json!({"latitude":35.1796,"longitude":129.0756,"accuracy":4}),&peer_location)?;
        write(home,resource,page,epoch,"set",&["geo","unavailable"]).await?;
        require(eval(home,resource,page,epoch,GEO).await?==json!({"error":2}),"unavailable location did not report POSITION_UNAVAILABLE")?;
        write(home,resource,page,epoch,"geo",&["37.5665","126.978"]).await?;
        write(home,resource,peer,epoch,"goto",&[&other_origin]).await?;
        require(eval(home,resource,peer,epoch,PERMISSION).await?=="prompt","permission leaked to another origin")?;
        write(home,resource,page,epoch,"permission",&["geolocation","denied",&origin]).await?;
        write(home,resource,page,epoch,"geo",&["reset"]).await?;
        require(eval(home,resource,page,epoch,GEO).await?==json!({"error":1}),"permission revoke failed")?;
        write(home,resource,page,epoch,"permission",&["geolocation","prompt",&origin]).await?;
        require(eval(home,resource,page,epoch,PERMISSION).await?=="prompt","permission reset failed")?;

        let created = cli(home,&["create"]).await?;
        let other = created["result"]["control"]["resource"]["resource_id"].as_str().unwrap().to_owned();
        other_resource = Some(other.clone());
        let shown = cli(home,&["show",&other]).await?;
        let other_page = shown["result"]["pages"][0]["page"]["page_id"].as_str().unwrap();
        let controller = cli(home,&["control",&other,"--controller","agent-proof"]).await?;
        let other_epoch = controller["result"]["controller"]["epoch"].as_str().unwrap();
        write(home,resource,page,epoch,"permission",&["geolocation","granted",&origin]).await?;
        write(home,resource,page,epoch,"offline",&["on"]).await?;
        write(home,&other,other_page,other_epoch,"goto",&[&origin]).await?;
        let other_state = eval(home,&other,other_page,other_epoch,PROBE).await?;
        require(other_state["online"]==true && other_state["body"]["headers"].get("x-dure-policy").is_none(),&other_state)?;
        require(eval(home,&other,other_page,other_epoch,PERMISSION).await?=="prompt","permission leaked to another resource")?;
        write(home,resource,page,epoch,"offline",&["off"]).await?;
        write(home,resource,page,epoch,"permission",&["geolocation","prompt",&origin]).await?;

        let shown = cli(home,&["show",resource]).await?;
        let control = &shown["result"]["control"];
        let current_page = shown["result"]["pages"].as_array().unwrap().iter().find(|entry|entry["page"]["page_id"]==page).unwrap()["page"].clone();
        let lost = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"headers-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"headers","headers":{"x-dure-policy":"lost"}}}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|e|e.to_string())?;
        socket.write_all(format!("{}\n",envelope(endpoint,"browser.resource",lost.clone())).as_bytes()).await.map_err(|e|e.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(10),async {
            loop {
                let receipt = cli(home,&["receipt","headers-lost-client"]).await?;
                if receipt["receipt"]["state"]=="succeeded" { return Ok::<_,String>(()); }
                if receipt["receipt"]["state"]=="failed" { return Err(format!("lost headers: {receipt}")); }
            }
        }).await.map_err(|_|"headers receipt timeout")??;
        require(eval(home,resource,page,epoch,PROBE).await?["body"]["headers"]["x-dure-policy"]=="lost","lost request did not apply")?;
        write(home,resource,page,epoch,"headers",&[r#"{"X-Dure-Policy":"newer"}"#]).await?;
        require(backend(endpoint,"browser.resource",lost).await["result"]["replayed"]==true,"lost request did not replay")?;
        require(eval(home,resource,page,epoch,PROBE).await?["body"]["headers"]["x-dure-policy"]=="newer","replay restored old headers")?;
        write(home,resource,page,epoch,"headers",&["reset"]).await?;
        let reset = eval(home,resource,page,epoch,PROBE).await?;
        require(reset["body"]["headers"].get("x-dure-policy").is_none(),&reset)?;
        write(home,resource,peer,epoch,"tab-close",&[]).await?;
        write(home,resource,page,epoch,"tab-switch",&[]).await?;
        println!("BROWSER_POLICY_CLI {}",json!({"root":home,"first":first,"replaced":second,"offline":offline,"afterNavigation":navigated,"location":location,"peerLocation":peer_location,"otherResource":other_state,"reset":reset,"lostClientReplayedWithoutOverwrite":true,"requests":requests.lock().await.len()}));
        Ok(())
    }.await;
    let retired = if let Some(other) = other_resource {
        cli(home, &["close", &other]).await.map(|_| ())
    } else {
        Ok(())
    };
    server.abort();
    let _ = server.await;
    result.and(retired)
}
