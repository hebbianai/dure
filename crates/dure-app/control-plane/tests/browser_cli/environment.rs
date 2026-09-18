use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::{fs, path::Path};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
    time::{Duration, timeout},
};

#[path = "environment/device.rs"]
mod device;

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser environment: {evidence:?}"))
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
    let mut arguments = vec![
        command,
        resource,
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
    ];
    arguments.extend_from_slice(values);
    cli(home, &arguments).await
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

const OBSERVE: &str = "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screenWidth:screen.width,print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches,motion:matchMedia('(prefers-reduced-motion:reduce)').matches,clicks:window.clicks})";

fn dimensions(path: &Path) -> Result<(u32, u32), String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    require(
        bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "invalid viewport PNG",
    )?;
    Ok((
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    ))
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
    let server = tokio::spawn(async move {
        let body = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Emulation fixture</title><style>body{margin:0;background:#426f90}button{position:fixed;right:8px;bottom:8px;width:80px;height:40px} @media print{body{background:#935277}}</style><button id=corner onclick='window.clicks++'>Corner</button><a id=download href=data:application/octet-stream;base64,cGFnZQ== download=page.bin>Download</a><script>window.clicks=0</script>";
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let size = socket.read(&mut request).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..size]);
            let ua = request
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
                .map(|(_, value)| value.trim())
                .unwrap_or("");
            let body = if request.starts_with("GET /user-agent HTTP/") {
                ua.to_owned()
            } else {
                format!("{body}<script>window.requestUA={}</script>", json!(ua))
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let mut other_resource = None;
    let result: Result<(),String> = async {
        write(home,resource,page,epoch,"goto",&[&origin]).await?;
        write(home,resource,page,epoch,"tab-new",&[&origin]).await?;
        let tabs = cli(home,&["show",resource]).await?;
        let peer = tabs["result"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["page"]["page_id"]!=page && entry["url"].as_str().is_some_and(|url|url.starts_with(&origin)))).ok_or("environment peer missing")?["page"]["page_id"].as_str().unwrap();
        let peer_before = eval(home,resource,peer,epoch,OBSERVE).await?;
        device::exercise(home,resource,page,epoch,endpoint,&origin,peer).await?;
        let baseline = eval(home,resource,page,epoch,OBSERVE).await?;
        write(home,resource,page,epoch,"viewport",&["640","480","--idempotency-key","viewport-proof"]).await?;
        write(home,resource,page,epoch,"media",&["print","--color-scheme","dark","--reduced-motion","reduce"]).await?;
        let desktop = eval(home,resource,page,epoch,OBSERVE).await?;
        require(desktop["width"]==640 && desktop["height"]==480 && desktop["dpr"]==1 && desktop["print"]==true && desktop["dark"]==true && desktop["motion"]==true,&desktop)?;
        let image = home.join("environment-desktop.png");
        cli(home,&["screenshot",resource,"--page",page,"--output",image.to_str().unwrap()]).await?;
        require(dimensions(&image)?==(640,480),dimensions(&image))?;
        cli(home,&["snapshot",resource,"--page",page]).await?;
        cli(home,&["find",resource,"text","Corner","text","--exact","--page",page]).await?;
        let pdf = home.join("environment.pdf");
        write(home,resource,page,epoch,"pdf",&["--output",pdf.to_str().unwrap()]).await?;
        let download = home.join("environment-download.bin");
        write(home,resource,page,epoch,"download",&["#download","--output",download.to_str().unwrap()]).await?;
        require(fs::read(&download).map_err(|error|error.to_string())?==b"page","wrong environment download")?;
        let observed = eval(home,resource,page,epoch,OBSERVE).await?;
        require(observed==desktop,(&observed,&desktop))?;
        write(home,resource,page,epoch,"click",&["#corner"]).await?;
        require(eval(home,resource,page,epoch,OBSERVE).await?["clicks"]==1,"desktop corner hit failed")?;
        let denied = cli(home,&["viewport",resource,"800","600","--page",page]).await;
        require(denied.as_ref().is_err_and(|error|error.contains("browser_controller_changed")),&denied)?;
        let duplicate = write(home,resource,page,epoch,"viewport",&["800","600","--idempotency-key","viewport-proof"]).await;
        require(duplicate.as_ref().is_err_and(|error|error.contains("browser_operation_conflict")),&duplicate)?;
        require(eval(home,resource,page,epoch,OBSERVE).await?["width"]==640,"rejected command resized page")?;
        let peer_after = eval(home,resource,peer,epoch,OBSERVE).await?;
        require(peer_before==peer_after,(&peer_before,&peer_after))?;

        write(home,resource,page,epoch,"set",&["viewport","400","600","--scale","2","--mobile"]).await?;
        write(home,resource,page,epoch,"media",&["screen","--color-scheme","light"]).await?;
        let mobile = eval(home,resource,page,epoch,OBSERVE).await?;
        require(mobile["width"]==400 && mobile["height"]==600 && mobile["dpr"]==2 && mobile["screenWidth"]==400 && mobile["print"]==false && mobile["dark"]==false && mobile["motion"]==baseline["motion"],&mobile)?;
        let image = home.join("environment-mobile.png");
        cli(home,&["screenshot",resource,"--page",page,"--output",image.to_str().unwrap()]).await?;
        require(dimensions(&image)?==(800,1200),dimensions(&image))?;
        write(home,resource,page,epoch,"click",&["#corner"]).await?;
        require(eval(home,resource,page,epoch,OBSERVE).await?["clicks"]==2,"mobile corner hit failed")?;
        let before_navigation = cli(home,&["show",resource]).await?;
        let old_page = before_navigation["result"]["pages"].as_array().unwrap().iter().find(|entry|entry["page"]["page_id"]==page).unwrap()["page"].clone();
        write(home,resource,page,epoch,"goto",&[&format!("{origin}/next")]).await?;
        let navigated = eval(home,resource,page,epoch,OBSERVE).await?;
        require(navigated["width"]==400 && navigated["height"]==600 && navigated["dpr"]==2 && navigated["dark"]==false,&navigated)?;
        let shown = cli(home,&["show",resource]).await?;
        let control = &shown["result"]["control"];
        let stale = backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":old_page,"operation_id":"viewport-stale-document","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"viewport","width":900,"height":900}}})).await;
        require(stale["error"]["code"]=="browser_document_changed",&stale)?;

        let shown = cli(home,&["show",resource]).await?;
        let control = &shown["result"]["control"];
        let current_page = shown["result"]["pages"].as_array().unwrap().iter().find(|entry|entry["page"]["page_id"]==page).unwrap()["page"].clone();
        let lost = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"viewport-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"viewport","width":720,"height":540}}});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{}\n",envelope(endpoint,"browser.resource",lost.clone())).as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        timeout(Duration::from_secs(10),async {
            loop {
                let receipt = cli(home,&["receipt","viewport-lost-client"]).await?;
                if receipt["receipt"]["state"]=="succeeded" { return Ok::<_,String>(()); }
                if receipt["receipt"]["state"]=="failed" { return Err(format!("viewport lost request failed: {receipt}")); }
            }
        }).await.map_err(|_|"viewport receipt timeout")??;
        require(eval(home,resource,page,epoch,OBSERVE).await?["width"]==720,"lost viewport did not apply")?;
        write(home,resource,page,epoch,"viewport",&["900","600"]).await?;
        let replayed = backend(endpoint,"browser.resource",lost).await;
        require(replayed["result"]["replayed"]==true,&replayed)?;
        require(eval(home,resource,page,epoch,OBSERVE).await?["width"]==900,"replay restored old viewport")?;

        let created = cli(home,&["create"]).await?;
        let other = created["result"]["control"]["resource"]["resource_id"].as_str().unwrap().to_owned();
        other_resource = Some(other.clone());
        let shown = cli(home,&["show",&other]).await?;
        let other_page = shown["result"]["pages"][0]["page"]["page_id"].as_str().unwrap();
        let controller = cli(home,&["control",&other,"--controller","agent-proof"]).await?;
        let other_epoch = controller["result"]["controller"]["epoch"].as_str().unwrap();
        write(home,&other,other_page,other_epoch,"goto",&[&origin]).await?;
        let other_state = eval(home,&other,other_page,other_epoch,OBSERVE).await?;
        // Separate Chrome windows may have different native content heights.
        // The override's dimensions, pixel ratio and media must not propagate.
        require(["width","dpr","print","dark","motion"].iter().all(|key|other_state[*key]==baseline[*key]),("other resource",&other_state,&baseline))?;
        write(home,resource,page,epoch,"viewport",&["reset"]).await?;
        write(home,resource,page,epoch,"set",&["media","reset"]).await?;
        let reset = eval(home,resource,page,epoch,OBSERVE).await?;
        require(reset==baseline,("reset in the same window",&reset,&baseline))?;
        write(home,resource,peer,epoch,"tab-close",&[]).await?;
        write(home,resource,page,epoch,"tab-switch",&[]).await?;
        println!("BROWSER_ENVIRONMENT_CLI {}",json!({"root":home,"baseline":baseline,"desktop":desktop,"mobile":mobile,"navigated":navigated,"peerBefore":peer_before,"peerAfter":peer_after,"otherResource":other_state,"reset":reset,"desktopPng":[640,480],"mobilePng":[800,1200],"cornerClicks":2,"staleDocumentRejected":true,"lostClientReplayedWithoutResize":true}));
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
