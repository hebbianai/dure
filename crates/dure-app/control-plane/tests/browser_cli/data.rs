use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::path::Path;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
    task::JoinSet,
    time::{Duration, sleep, timeout},
};

#[path = "data/state.rs"]
mod state;
#[path = "data/state_encryption.rs"]
mod state_encryption;
#[path = "data/state_save.rs"]
mod state_save;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn actual_cli_storage_reads_preserve_native_data_boundaries() {
    let (root, endpoint, server) = super::fixture().await;
    let evidence: Result<(), String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"]
            .as_str()
            .ok_or("fixture resource missing")?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"]
            .as_str()
            .ok_or("fixture page missing")?;
        let controlled = cli(&root, &["control", resource, "--controller", "agent-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("fixture epoch missing")?;
        exercise(&root, resource, page, epoch, &endpoint).await?;
        cli(&root, &["close", resource]).await?;
        Ok(())
    }
    .await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_STORAGE_CLI root={} evidence={evidence:?} stopped={stopped:?} retired={retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    evidence.unwrap();
}

fn require(condition: bool, value: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser data: {value:?}"))
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

async fn read(
    home: &Path,
    resource: &str,
    page: &str,
    command: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut args = vec![command, resource, "--page", page];
    args.extend_from_slice(values);
    Ok(cli(home, &args).await?["result"]["data"].clone())
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

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let request_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = request_count.clone();
    let server = tokio::spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let Ok((mut socket,_)) = connection else { break; };
                    let count = count.clone();
                    requests.spawn(async move {
            let mut request = Vec::new();
            let mut part = [0;4096];
            while request.len()<16*1024 && !request.windows(4).any(|part|part==b"\r\n\r\n") {
                let read=timeout(Duration::from_secs(2),socket.read(&mut part)).await.ok().and_then(Result::ok).unwrap_or(0);
                if read==0 { return; }
                request.extend_from_slice(&part[..read]);
            }
            if !request.windows(4).any(|part|part==b"\r\n\r\n") { return; }
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let request=String::from_utf8_lossy(&request);
            let cookie=request.lines().find_map(|line|line.split_once(':').filter(|(name,_)|name.eq_ignore_ascii_case("cookie")).map(|(_,value)|value.trim())).unwrap_or("");
            if cookie.contains("state-redirect=on") {
                let host=request.lines().find_map(|line|line.split_once(':').filter(|(name,_)|name.eq_ignore_ascii_case("host")).map(|(_,value)|value.trim())).unwrap_or("");
                if host.starts_with("localhost:") {
                    let response=format!("HTTP/1.1 302 Found\r\nLocation: http://{}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",host.replacen("localhost","127.0.0.1",1));
                    let _=socket.write_all(response.as_bytes()).await;
                    return;
                }
            }
            let mut body=if request.starts_with("GET /echo ") { json!({"cookie":cookie}).to_string() } else { "<!doctype html><title>Browser data fixture</title><input id=focus><button>Observe</button>".into() };
            if cookie.contains("state-hooks=on") && !request.starts_with("GET /echo ") {
                body.push_str("<script>window.stateReads=0;for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){window.stateReads++;throw Error('page storage hook')}});</script>");
            }
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            let _=socket.write_all(response.as_bytes()).await;
                    });
                }
                _ = requests.join_next(), if !requests.is_empty() => {}
            }
        }
    });
    let mut other_resource = None;
    let mut other_profile = None;
    let result = async {
        write(home,resource,page,epoch,"goto",&[&origin]).await?;
        let key="키 ' \" \\ __proto__";
        let local="로컬 값\n🚀";
        let session="세션 값";
        write(home,resource,page,epoch,"storage",&["local","set",key,local,"--idempotency-key","storage-local-proof"]).await?;
        write(home,resource,page,epoch,"storage",&["session","set",key,session]).await?;
        write(home,resource,page,epoch,"storage",&["local","set","",""]).await?;
        write(home,resource,page,epoch,"storage",&["local","set","__proto__","literal prototype key"]).await?;
        write(home,resource,page,epoch,"storage",&["local","set","constructor","literal constructor key"]).await?;
        eval(home,resource,page,epoch,"window.originalLocal=localStorage;window.originalSession=sessionStorage;window.storageReads=0;for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{configurable:true,get(){window.storageReads++;return {getItem(){return 'forged'},setItem(){throw Error('page setter')},clear(){throw Error('page clear')}}}});document.getElementById('focus').focus();true").await?;
        let before=cli(home,&["show",resource]).await?;
        let local_read=read(home,resource,page,"storage",&["local","get",key]).await?;
        let session_read=read(home,resource,page,"storage",&["session","get",key]).await?;
        let empty=read(home,resource,page,"storage",&["local","get",""]).await?;
        let missing=read(home,resource,page,"storage",&["session","get","absent"]).await?;
        let local_all=read(home,resource,page,"storage",&["local","get"]).await?;
        let session_all=read(home,resource,page,"storage",&["session"]).await?;
        require(local_all==json!({"data":{(key):local,"":"","__proto__":"literal prototype key","constructor":"literal constructor key"}}),&local_all)?;
        require(session_all==json!({"data":{(key):session}}),&session_all)?;
        require(read(home,resource,page,"exec",&["--command","storage local"]).await?==local_all,"native local read-all differs")?;
        require(read(home,resource,page,"exec",&["--command","storage session get"]).await?==session_all,"native session read-all differs")?;
        let after=cli(home,&["show",resource]).await?;
        require(local_read["value"]==local && session_read["value"]==session && empty["value"]=="" && missing["value"].is_null(),(&local_read,&session_read,&empty,&missing))?;
        require(before==after,(&before,&after))?;
        let observer=eval(home,resource,page,epoch,"({reads:storageReads,focus:document.activeElement.id})").await?;
        require(observer==json!({"reads":0,"focus":"focus"}),&observer)?;
        let denied=cli(home,&["storage",resource,"local","clear","--page",page]).await;
        require(denied.as_ref().is_err_and(|error|error.contains("browser_controller_changed")),&denied)?;
        write(home,resource,page,epoch,"storage",&["local","set",key,"updated"]).await?;
        require(eval(home,resource,page,epoch,&format!("originalLocal.getItem({})",json!(key))).await?=="updated","storage setter ran page hook")?;
        let duplicate=write(home,resource,page,epoch,"storage",&["local","set",key,local,"--idempotency-key","storage-local-proof"]).await;
        require(duplicate.as_ref().is_err_and(|error|error.contains("browser_operation_conflict")),&duplicate)?;
        require(read(home,resource,page,"storage",&["local","get",key]).await?["value"]=="updated","duplicate changed storage")?;
        let shown=cli(home,&["show",resource]).await?;
        let control=&shown["result"]["control"];
        let identity=shown["result"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["page"]["page_id"]==page)).unwrap()["page"].clone();
        let body=json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":identity,"operation_id":"storage-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"data","action":{"kind":"storage_set","area":"local","key":"receipt","value":"original"}}});
        let request=envelope(endpoint,"browser.resource",body.clone());
        let mut socket=UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{request}\n").as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(10),async {
            loop {
                let receipt=cli(home,&["receipt","storage-lost-client"]).await?;
                if receipt["receipt"]["state"]=="succeeded" { return Ok::<_,String>(()); }
                if receipt["receipt"]["state"]=="failed" { return Err(format!("lost storage operation failed: {receipt}")); }
                sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_|"storage receipt deadline")??;
        require(read(home,resource,page,"storage",&["local","get","receipt"]).await?["value"]=="original","lost operation did not write")?;
        write(home,resource,page,epoch,"storage",&["local","set","receipt","newer"]).await?;
        let recovered=backend(endpoint,"browser.resource",body).await;
        require(recovered["result"]["replayed"]==true,&recovered)?;
        require(read(home,resource,page,"storage",&["local","get","receipt"]).await?["value"]=="newer","receipt recovery repeated the write")?;

        write(home,resource,page,epoch,"cookie",&["set","keep","preserved","--path","/"]).await?;
        write(home,resource,page,epoch,"cookie",&["set","remove","http-secret","--http-only","--same-site","Lax","--path","/"]).await?;
        write(home,resource,page,epoch,"cookie",&["set","scoped","only-path","--path","/scope","--expires","4102444800"]).await?;
        let cookies=read(home,resource,page,"cookie",&["get"]).await?;
        let secret=cookies["cookies"].as_array().and_then(|cookies|cookies.iter().find(|cookie|cookie["name"]=="remove")).ok_or("HTTP-only cookie missing")?;
        require(secret["httpOnly"]==true && secret["sameSite"]=="Lax",secret)?;
        let script=eval(home,resource,page,epoch,"document.cookie").await?;
        require(!script.as_str().unwrap_or_default().contains("remove="),&script)?;
        let http=eval(home,resource,page,epoch,"fetch('/echo').then(response=>response.json())").await?;
        require(http["cookie"].as_str().is_some_and(|cookie|cookie.contains("remove=http-secret") && cookie.contains("keep=preserved")),&http)?;
        let scoped=read(home,resource,page,"cookie",&["get","--url",&format!("{origin}/scope")]).await?;
        require(scoped["cookies"].as_array().is_some_and(|cookies|cookies.iter().any(|cookie|cookie["name"]=="scoped")),&scoped)?;
        require(!cookies["cookies"].as_array().unwrap().iter().any(|cookie|cookie["name"]=="scoped"),&cookies)?;
        write(home,resource,page,epoch,"cookie",&["delete","remove","--url",&origin,"--path","/"]).await?;
        let remaining=read(home,resource,page,"cookie",&["get"]).await?;
        require(remaining["cookies"].as_array().is_some_and(|cookies|cookies.len()==1 && cookies[0]["name"]=="keep"),&remaining)?;
        let rejected_cookie=write(home,resource,page,epoch,"cookie",&["set","invalid-domain","value","--domain","..","--secure"]).await;
        require(rejected_cookie.as_ref().is_err_and(|error|error.contains("browser_data_rejected") || error.contains("browser_cookie_rejected")),&rejected_cookie)?;
        let phase=cli(home,&["show",resource]).await?;
        require(phase["result"]["control"]["phase"]=="ready",&phase)?;
        write(home,resource,page,epoch,"cookie",&["set","__Secure-proof","value","--domain","127.0.0.1","--secure","--same-site","None","--path","/"]).await?;
        let secure=read(home,resource,page,"cookie",&["get","--url","https://127.0.0.1/scope#한글"]).await?;
        require(secure["cookies"].as_array().is_some_and(|cookies|cookies.iter().any(|cookie|cookie["name"]=="__Secure-proof" && cookie["secure"]==true && cookie["sameSite"]=="None")),&secure)?;
        write(home,resource,page,epoch,"cookie",&["delete","__Secure-proof","--domain","127.0.0.1","--path","/"]).await?;

        let isolated=cli(home,&["tab","profile","create","--label","Storage isolation fixture"]).await?;
        let profile=isolated["result"]["profile"]["profile"]["profileId"].as_str().filter(|id|*id!="default").ok_or("isolated profile identity missing")?.to_owned();
        other_profile=Some(profile.clone());
        let created=cli(home,&["create","--workspace","workspace-browser","--profile",&profile]).await?;
        let other=created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("second resource missing")?.to_owned();
        other_resource=Some(other.clone());
        let shown=cli(home,&["show",&other]).await?;
        let other_page=shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("second page missing")?;
        let lease=cli(home,&["control",&other,"--controller","agent-proof"]).await?;
        let other_epoch=lease["result"]["controller"]["epoch"].as_str().ok_or("second lease missing")?;
        write(home,&other,other_page,other_epoch,"goto",&[&origin]).await?;
        require(read(home,&other,other_page,"storage",&["local","get",key]).await?["value"].is_null(),"local storage leaked across resources")?;
        require(read(home,&other,other_page,"storage",&["session","get",key]).await?["value"].is_null(),"session storage leaked across resources")?;
        require(read(home,&other,other_page,"storage",&["local","get"]).await?==json!({"data":{}}),"read-all leaked local storage across resources")?;
        require(read(home,&other,other_page,"storage",&["session","get"]).await?==json!({"data":{}}),"read-all leaked session storage across resources")?;
        require(read(home,&other,other_page,"cookie",&["get"]).await?["cookies"]==json!([]),"cookie leaked across resources")?;

        let created=write(home,resource,page,epoch,"tab-new",&[&origin]).await?;
        let new_page=created["result"]["response"]["data"]["page"]["page_id"].as_str().ok_or("new page identity missing")?;
        require(new_page!=page && created["result"]["response"]["data"]["navigation"]["url"].as_str().is_some_and(|url|url.starts_with(&origin)),&created)?;
        let tabs=cli(home,&["show",resource]).await?;
        require(tabs["result"]["pages"].as_array().is_some_and(|pages|[page,new_page].iter().all(|id|pages.iter().any(|entry|entry["page"]["page_id"]==*id))),&tabs)?;
        require(read(home,resource,new_page,"storage",&["local","get",key]).await?["value"]=="updated","same-origin local storage was not shared")?;
        require(read(home,resource,new_page,"storage",&["session","get",key]).await?["value"].is_null(),"new tab inherited session storage")?;
        require(read(home,resource,new_page,"storage",&["local","get"]).await?==read(home,resource,page,"storage",&["local","get"]).await?,"same-origin read-all differs across tabs")?;
        require(read(home,resource,new_page,"storage",&["session","get"]).await?==json!({"data":{}}),"read-all inherited another tab's session storage")?;
        write(home,resource,new_page,epoch,"storage",&["session","set",key,"other tab"]).await?;
        write(home,resource,page,epoch,"tab-switch",&[]).await?;
        require(read(home,resource,page,"storage",&["session","get",key]).await?["value"]==session,"session storage was shared across tabs")?;
        write(home,resource,page,epoch,"storage",&["local","clear"]).await?;
        write(home,resource,page,epoch,"storage",&["session","clear"]).await?;
        require(eval(home,resource,page,epoch,"({local:originalLocal.length,session:originalSession.length,reads:storageReads})").await?==json!({"local":0,"session":0,"reads":0}),"clear executed page hooks or left values")?;
        write(home,resource,new_page,epoch,"tab-switch",&[]).await?;
        require(read(home,resource,new_page,"storage",&["local","get",key]).await?["value"].is_null(),"local clear not shared")?;
        require(read(home,resource,new_page,"storage",&["session","get",key]).await?["value"]=="other tab","session clear escaped its tab")?;
        require(read(home,resource,new_page,"storage",&["local","get"]).await?==json!({"data":{}}),"read-all retained cleared local entries")?;
        require(read(home,resource,new_page,"storage",&["session","get"]).await?==json!({"data":{(key):"other tab"}}),"read-all lost another tab's session entries")?;
        require(read(home,resource,page,"storage",&["session","get"]).await?==json!({"data":{}}),"read-all retained cleared session entries")?;
        write(home,resource,new_page,epoch,"tab-close",&[]).await?;
        write(home,resource,page,epoch,"tab-switch",&[]).await?;

        let stale=cli(home,&["show",resource]).await?;
        let old_page=stale["result"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["page"]["page_id"]==page)).unwrap()["page"].clone();
        write(home,resource,page,epoch,"goto",&[&format!("{origin}/new-document")]).await?;
        let current=cli(home,&["show",resource]).await?;
        let control=&current["result"]["control"];
        let rejected=backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":old_page,"operation_id":"storage-stale-document","command_sequence":control["next_command_sequence"]},"action":{"kind":"data","action":{"kind":"storage_set","area":"local","key":"stale","value":"must not write"}}})).await;
        require(rejected["error"]["code"]=="browser_document_changed",&rejected)?;
        require(read(home,resource,page,"storage",&["local","get","stale"]).await?["value"].is_null(),&rejected)?;
        write(home,resource,page,epoch,"storage",&["local","set","origin-proof","local origin value"]).await?;
        write(home,resource,page,epoch,"storage",&["session","set","origin-proof","session origin value"]).await?;
        let other_origin=origin.replacen("127.0.0.1","localhost",1);
        write(home,resource,page,epoch,"goto",&[&other_origin]).await?;
        for area in ["local","session"] {
            require(read(home,resource,page,"storage",&[area,"get"]).await?==json!({"data":{}}),"read-all escaped its current origin")?;
        }
        write(home,resource,page,epoch,"goto",&[&origin]).await?;
        require(read(home,resource,page,"storage",&["local","get"]).await?==json!({"data":{"origin-proof":"local origin value"}}),"local origin storage was not restored")?;
        require(read(home,resource,page,"storage",&["session","get"]).await?==json!({"data":{"origin-proof":"session origin value"}}),"session origin storage was not restored")?;

        // File import uses only parsed cookie data; requests in cURL exports
        // are never executed and JSON scope is supplied by the explicit flags.
        for (index, contents) in [
            r#"[{"name":"imported","value":"json=value","domain":"unrequested.test"},{"name":"empty","value":""}]"#,
            "imported=header=value; empty=",
            "curl https://unrequested.invalid -H 'Cookie: imported=curl=value; empty='",
        ].iter().enumerate() {
            let file = home.join(format!("cookie-import-{index}.txt"));
            std::fs::write(&file, contents).map_err(|error| error.to_string())?;
            let file = file.to_str().ok_or("import path encoding")?;
            if index == 1 {
                write(home,resource,page,epoch,"exec",&["--command",&format!("cookies set --curl '{file}'")]).await?;
            } else {
                write(home,resource,page,epoch,"cookie",&["set","--curl",file]).await?;
            }
            let cookies=read(home,resource,page,"cookie",&["get"]).await?;
            let expected=["json=value","header=value","curl=value"][index];
            require(cookies["cookies"].as_array().is_some_and(|cookies|cookies.iter().any(|cookie|cookie["name"]=="imported" && cookie["value"]==expected) && cookies.iter().any(|cookie|cookie["name"]=="empty" && cookie["value"]=="")),&cookies)?;
        }
        let sent=eval(home,resource,page,epoch,"fetch('/echo').then(response=>response.json())").await?;
        require(sent["cookie"].as_str().is_some_and(|cookie|cookie.contains("imported=curl=value") && cookie.contains("empty=")),&sent)?;
        write(home,resource,page,epoch,"cookie",&["set","other-origin","default-profile","--url",&other_origin]).await?;
        write(home,&other,other_page,other_epoch,"cookie",&["set","retained","other-profile"]).await?;

        let view=cli(home,&["show",resource]).await?;
        let control=&view["result"]["control"];
        let body=json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":control["current_page"],"operation_id":"cookies-clear-lost-response","command_sequence":control["next_command_sequence"]},"action":{"kind":"data","action":{"kind":"cookies_clear"}}});
        let mut socket=UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{}\n",envelope(endpoint,"browser.resource",body.clone())).as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(10),async {
            loop {
                let receipt=cli(home,&["receipt","cookies-clear-lost-response"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded")=>return Ok::<_,String>(()),
                    Some("failed")=>return Err(format!("cookie clear failed: {receipt}")),
                    _=>sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.map_err(|_|"cookie clear receipt deadline")??;
        for url in [&origin,&format!("{origin}/scope"),&other_origin] {
            require(read(home,resource,page,"cookie",&["get","--url",url]).await?["cookies"]==json!([]),"clear left cookies in its profile")?;
        }
        let isolated=read(home,&other,other_page,"cookie",&["get"]).await?;
        require(isolated["cookies"].as_array().is_some_and(|cookies|cookies.len()==1 && cookies[0]["name"]=="retained" && cookies[0]["value"]=="other-profile"),&isolated)?;
        require(read(home,resource,page,"storage",&["local","get","origin-proof"]).await?["value"]=="local origin value","cookie clear removed local storage")?;
        require(read(home,resource,page,"storage",&["session","get","origin-proof"]).await?["value"]=="session origin value","cookie clear removed session storage")?;
        write(home,resource,page,epoch,"cookie",&["set","after-clear","newer"]).await?;
        let recovered=backend(endpoint,"browser.resource",body).await;
        require(recovered["result"]["replayed"]==true,&recovered)?;
        require(read(home,resource,page,"cookie",&["get"]).await?["cookies"].as_array().is_some_and(|cookies|cookies.len()==1 && cookies[0]["name"]=="after-clear"),"receipt recovery repeated cookie clear")?;
        let cleared=write(home,resource,page,epoch,"exec",&["--command","cookies clear"]).await?;
        require(cleared["result"]["response"]["data"]["cleared"]==true,&cleared)?;
        require(read(home,resource,page,"cookie",&["get"]).await?["cookies"]==json!([]),"exec clear did not remove the new cookie")?;
        state_save::exercise(home,resource,page,epoch,(&origin,&other_origin),(&other,other_page,other_epoch),&request_count).await?;
        state_encryption::exercise(home,resource,page,epoch,(&origin,&other_origin),(&other,other_page,other_epoch)).await?;
        state::exercise(home,resource,page,epoch,endpoint,(&origin,&other_origin),(&other,other_page)).await?;
        println!("BROWSER_DATA_EVIDENCE {}",json!({"root":home,"observer":observer,"httpOnlySent":true,"cookieDeleteKeptUnrelated":remaining,"secureCookie":true,"knownCookieRejectionDrained":true,"urlCookieFilter":true,"resourceIsolation":true,"localSharedAcrossTabs":true,"sessionIsolatedAcrossTabs":true,"pageHooksNotExecuted":true,"staleDocumentRejected":true,"lostClientRecoveredWithoutWriteReplay":true,"cookieImportFormats":3,"cookieImportsSent":true,"cookieClearAcrossOrigins":true,"cookieClearPreservedOtherProfileAndStorage":true,"lostCookieClearRecoveredWithoutReplay":true}));
        Ok(())
    }.await;
    let retired = if let Some(other) = other_resource {
        cli(home, &["close", &other]).await.map(|_| ())
    } else {
        Ok(())
    };
    let retired = match (retired, other_profile) {
        (Ok(()), Some(profile)) => cli(home, &["tab", "profile", "delete", "--profile", &profile])
            .await
            .and_then(|reply| require(reply["result"]["deleted"] == true, reply)),
        (result, _) => result,
    };
    server.abort();
    let _ = server.await;
    result.and(retired)
}
