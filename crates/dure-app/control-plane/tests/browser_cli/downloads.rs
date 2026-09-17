use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
    sync::Mutex,
    task::JoinSet,
    time::{Duration, sleep, timeout},
};

fn bytes() -> Vec<u8> {
    (0..320_013).map(|index| (index % 256) as u8).collect()
}

fn require(condition: bool, value: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser download: {value:?}"))
    }
}

async fn eval(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    Ok(cli(
        home,
        &[
            "eval",
            resource,
            script,
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone())
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
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed_requests = Arc::clone(&requests);
    let server = tokio::spawn(async move {
        let mut responses = JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let Ok((mut socket, _)) = connection else { break; };
                    let requests = Arc::clone(&observed_requests);
                    responses.spawn(async move {
                        let mut request = [0;4096];
                        let read = socket.read(&mut request).await.unwrap_or(0);
                        let request = String::from_utf8_lossy(&request[..read]);
                        let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                        requests.lock().await.push(path.clone());
                        let (name, body) = match path.as_str() {
                            "/empty" => ("empty.bin", Vec::new()),
                            "/foreign" => ("foreign.bin", b"OTHER PAGE".to_vec()),
                            _ => ("server.bin", bytes()),
                        };
                        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        if socket.write_all(header.as_bytes()).await.is_err() { return; }
                        if path == "/slow" { sleep(Duration::from_millis(700)).await; }
                        let _ = socket.write_all(&body).await;
                    });
                }
                _ = responses.join_next(), if !responses.is_empty() => {}
            }
        }
    });
    let result = async {
        let setup = format!("document.body.innerHTML='<a id=selected>Download binary</a><a id=empty>Download empty</a><a id=slow>Download slowly</a><button id=none>No download</button>';for(const id of ['selected','empty','slow']){{document.getElementById(id).href={}+'/'+id;document.getElementById(id).download=id+'.bin';}}window.downloadClicks=0;document.getElementById('selected').onclick=()=>window.downloadClicks++;true",json!(origin));
        eval(home,resource,page,epoch,&setup).await?;
        let snapshot=cli(home,&["snapshot",resource,"--page",page]).await?;
        let reference=snapshot["references"].as_object().and_then(|refs|refs.iter().find(|(_, value)|value["name"]=="Download binary")).ok_or("download ref missing")?.0;
        let output=home.join("downloaded.bin");
        std::fs::write(&output,b"existing destination").map_err(|error|error.to_string())?;
        let denied=cli(home,&["download",resource,reference,"--output",output.to_str().unwrap()]).await;
        require(denied.as_ref().is_err_and(|error|error.contains("browser_controller_changed")), &denied)?;
        require(requests.lock().await.is_empty(), &requests)?;
        let args=["download",resource,reference,"--output",output.to_str().unwrap(),"--controller","agent-proof","--epoch",epoch,"--idempotency-key","download-binary-proof"];
        let downloaded=cli(home,&args).await?;
        require(std::fs::read(&output).map_err(|error|error.to_string())?==bytes(), &downloaded)?;
        require(downloaded["result"]["artifact"]["suggestedFilename"]=="server.bin", &downloaded)?;
        let duplicate=cli(home,&args).await;
        require(duplicate.as_ref().is_err_and(|error|error.contains("browser_operation_conflict")), &duplicate)?;
        require(eval(home,resource,page,epoch,"downloadClicks").await?==1,"duplicate click")?;
        let empty=home.join("empty.bin");
        let empty_result=cli(home,&["download",resource,"#empty","--page",page,"--output",empty.to_str().unwrap(),"--controller","agent-proof","--epoch",epoch,"--idempotency-key","download-empty-proof"]).await?;
        require(std::fs::read(&empty).map_err(|error|error.to_string())?.is_empty(), &empty_result)?;
        let protected=home.join("keep.bin");
        std::fs::write(&protected,b"keep me").map_err(|error|error.to_string())?;
        let no_file=cli(home,&["download",resource,"#none","--page",page,"--output",protected.to_str().unwrap(),"--controller","agent-proof","--epoch",epoch,"--timeout","250"]).await;
        require(no_file.as_ref().is_err_and(|error|error.contains("browser_download_timeout")), &no_file)?;
        require(std::fs::read(&protected).unwrap()==b"keep me","timeout replaced destination")?;
        eval(home,resource,page,epoch,"document.getElementById('selected').outerHTML='<a id=selected>Download binary</a>';true").await?;
        let stale=cli(home,&["download",resource,reference,"--output",protected.to_str().unwrap(),"--controller","agent-proof","--epoch",epoch]).await;
        require(stale.as_ref().is_err_and(|error|error.contains("browser_element_changed")), &stale)?;
        require(std::fs::read(&protected).unwrap()==b"keep me","stale ref replaced destination")?;

        // Another page starts first. Its GUID must not select the artifact or
        // complete the requested page's operation.
        let mixed_setup=format!("document.body.insertAdjacentHTML('beforeend','<button id=openOther>Open other</button><button id=mixed>Download this page</button>');openOther.onclick=()=>window.otherDownload=window.open('about:blank');mixed.onclick=()=>{{const a=otherDownload.document.createElement('a');a.href={}+'/foreign';otherDownload.document.body.appendChild(a);a.click();setTimeout(()=>{{const b=document.createElement('a');b.href={}+'/selected';document.body.appendChild(b);b.click();}},350);}};true",json!(origin),json!(origin));
        eval(home,resource,page,epoch,&mixed_setup).await?;
        cli(home,&["click",resource,"#openOther","--page",page,"--controller","agent-proof","--epoch",epoch]).await?;
        require(eval(home,resource,page,epoch,"!!otherDownload").await?==true,"popup blocked")?;
        let mixed=home.join("mixed.bin");
        let mixed_result=cli(home,&["download",resource,"#mixed","--page",page,"--output",mixed.to_str().unwrap(),"--controller","agent-proof","--epoch",epoch]).await?;
        require(std::fs::read(&mixed).map_err(|error|error.to_string())?==bytes(), &mixed_result)?;
        eval(home,resource,page,epoch,"otherDownload.close();true").await?;

        let current=cli(home,&["show",resource]).await?;
        let control=&current["result"]["control"];
        let identity=current["result"]["pages"].as_array().and_then(|pages|pages.iter().find(|entry|entry["page"]["page_id"]==page)).ok_or("download page gone")?["page"].clone();
        let body=json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":identity,"operation_id":"download-lost-proof","command_sequence":control["next_command_sequence"]},"action":{"kind":"download","target":{"kind":"css","selector":"#slow"},"timeout_ms":5000}});
        let request=envelope(endpoint,"browser.resource",body.clone());
        let mut socket=UnixStream::connect(&endpoint.socket_path).await.map_err(|error|error.to_string())?;
        socket.write_all(format!("{request}\n").as_bytes()).await.map_err(|error|error.to_string())?;
        drop(socket);
        let receipt=timeout(Duration::from_secs(10),async {
            loop {
                let receipt=cli(home,&["receipt","download-lost-proof"]).await?;
                if receipt["receipt"]["state"]=="succeeded" { return Ok::<_,String>(receipt); }
                if receipt["receipt"]["state"]=="failed" { return Err(format!("download failed after disconnect: {receipt}")); }
                sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_|"download receipt deadline")??;
        let replay=backend(endpoint,"browser.resource",body).await;
        require(replay["result"]["replayed"]==true, &replay)?;
        let lost=home.join("lost.bin");
        cli(home,&["artifact","download-lost-proof","--output",lost.to_str().unwrap()]).await?;
        require(std::fs::read(&lost).map_err(|error|error.to_string())?==bytes(), &receipt)?;
        let requests=requests.lock().await.clone();
        require(requests.iter().filter(|path|path.as_str()=="/slow").count()==1, &requests)?;
        require(requests.iter().filter(|path|path.as_str()=="/selected").count()==2, &requests)?;
        require(requests.iter().any(|path|path=="/foreign"), &requests)?;
        println!("BROWSER_DOWNLOAD_EVIDENCE {}",json!({"root":home,"size":bytes().len(),"sha256":format!("{:x}",Sha256::digest(bytes())),"empty":empty_result["result"]["artifact"],"requests":requests,"crossPageFileMatched":true,"lostClientRecovered":true,"timeoutPreservedDestination":true,"staleReferenceRejected":true}));
        Ok(())
    }.await;
    server.abort();
    let _ = server.await;
    result
}

pub(super) async fn recover(home: &Path) -> Result<(), String> {
    for (operation, name) in [
        ("download-binary-proof", "downloaded.bin"),
        ("download-empty-proof", "empty.bin"),
        ("download-lost-proof", "lost.bin"),
    ] {
        let output = home.join(format!("recovered-{name}"));
        cli(
            home,
            &["artifact", operation, "--output", output.to_str().unwrap()],
        )
        .await?;
        require(
            std::fs::read(output).map_err(|error| error.to_string())?
                == std::fs::read(home.join(name)).map_err(|error| error.to_string())?,
            operation,
        )?;
    }
    println!(
        "BROWSER_DOWNLOAD_RECOVERY_EVIDENCE {}",
        json!({"root":home,"identicalFiles":3})
    );
    Ok(())
}
