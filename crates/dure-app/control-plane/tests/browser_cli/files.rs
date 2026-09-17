use super::cli;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{Duration, timeout};

async fn evaluate(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    let result = cli(
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
    .await?;
    Ok(result["result"]["response"]["data"]["result"].clone())
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
) -> Result<(), String> {
    let sources = [
        ("첨부 파일.txt", "한글 업로드\n".repeat(12_001)),
        ("large.txt", "second file\n".repeat(18_001)),
        ("empty.txt", String::new()),
    ];
    let mut paths = Vec::new();
    for (name, bytes) in &sources {
        let path = home.join(name);
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        paths.push(path.to_str().unwrap().to_owned());
    }
    evaluate(home, resource, page, epoch, "window.uploadChanges=0;document.body.innerHTML='<form id=uploadForm><input id=attachments name=attachments type=file multiple aria-label=Attachments onchange=\"window.uploadChanges++\"></form><input id=single type=file aria-label=Single>'").await?;
    let snapshot = cli(home, &["snapshot", resource, "--page", page]).await?;
    let reference = snapshot["references"]
        .as_object()
        .ok_or("upload refs missing")?
        .iter()
        .find(|(_, entry)| entry["name"] == "Attachments")
        .ok_or("upload input missing")?
        .0;
    let mut args = vec!["upload", resource, reference.as_str()];
    args.extend(paths.iter().map(String::as_str));
    let denied = cli(home, &args).await;
    if !denied
        .as_ref()
        .is_err_and(|error| error.contains("browser_controller_changed"))
    {
        return Err(format!("uncontrolled upload: {denied:?}"));
    }
    args.extend([
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
        "--idempotency-key",
        "upload-cli-proof",
    ]);
    let uploaded = cli(home, &args).await?;
    let repeated = cli(home, &args).await;
    if !repeated
        .as_ref()
        .is_err_and(|error| error.contains("browser_operation_conflict"))
    {
        return Err(format!("repeated upload: {repeated:?}"));
    }
    let actual = evaluate(home, resource, page, epoch, "Promise.all(Array.from(attachments.files,async file=>({name:file.name,size:file.size,text:await file.text()})))").await?;
    let mut manifests = Vec::new();
    for (index, (name, contents)) in sources.iter().enumerate() {
        if actual[index]["name"] != *name
            || actual[index]["size"] != contents.len()
            || actual[index]["text"] != *contents
        {
            return Err(format!("uploaded file differs: {name}"));
        }
        manifests.push(json!({"name":name,"size":contents.len(),"sha256":format!("{:x}",Sha256::digest(contents.as_bytes()))}));
    }
    if uploaded["result"]["response"]["data"]["files"] != json!(manifests) {
        return Err(format!("upload manifest differs: {uploaded}"));
    }
    let received = submit_form(home, resource, page, epoch, &sources).await?;
    if received != manifests {
        return Err(format!("HTTP upload differs: {received:?}"));
    }
    let single = cli(
        home,
        &[
            "upload",
            resource,
            "#single",
            &paths[0],
            &paths[1],
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await;
    if !single
        .as_ref()
        .is_err_and(|error| error.contains("browser_upload_multiple_required"))
    {
        return Err(format!("single input admitted multiple files: {single:?}"));
    }
    evaluate(home, resource, page, epoch, "window.retainedFiles=Array.from(attachments.files);attachments.outerHTML='<input id=attachments type=file multiple aria-label=Attachments onchange=\"window.uploadChanges++\">'").await?;
    let stale = cli(
        home,
        &[
            "upload",
            resource,
            reference,
            &paths[0],
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await;
    if !stale
        .as_ref()
        .is_err_and(|error| error.contains("browser_element_changed"))
    {
        return Err(format!("stale upload reference: {stale:?}"));
    }
    let retained = evaluate(
        home,
        resource,
        page,
        epoch,
        "Promise.all(retainedFiles.map(async file=>({size:file.size,text:await file.text()})))",
    )
    .await?;
    for (index, (_, contents)) in sources.iter().enumerate() {
        if retained[index]["text"] != *contents {
            return Err("attached file bytes retired early".into());
        }
    }
    let effects = evaluate(home,resource,page,epoch,"({changes:uploadChanges,replacementFiles:attachments.files.length,singleFiles:single.files.length})").await?;
    if effects != json!({"changes":1,"replacementFiles":0,"singleFiles":0}) {
        return Err(format!("upload effects: {effects}"));
    }
    let receipt = cli(home, &["receipt", "upload-cli-proof"]).await?;
    if receipt["receipt"]["state"] != "succeeded"
        || receipt["result"]["response"]["data"]["files"] != json!(manifests)
    {
        return Err(format!("upload receipt: {receipt}"));
    }
    println!(
        "BROWSER_UPLOAD_EVIDENCE {}",
        json!({"files":manifests,"httpReceived":received,"effects":effects,"retainedAfterInputReplacement":true,"receiptRecovered":true,"root":home})
    );
    Ok(())
}

async fn submit_form(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    sources: &[(&str, String)],
) -> Result<Vec<Value>, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let mut server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let mut request = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 8192];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 || request.len() + read > 1024 * 1024 {
                return Err("upload HTTP request incomplete or too large".to_string());
            }
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers =
            String::from_utf8(request[..header_end].to_vec()).map_err(|error| error.to_string())?;
        if !headers.starts_with("POST /upload HTTP/1.1\r\n") {
            return Err(format!("unexpected upload request: {headers}"));
        }
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .ok_or("upload content length missing")?;
        if length > 1024 * 1024 || request.len() > header_end + length {
            return Err("upload HTTP body invalid".into());
        }
        let received = request.len();
        request.resize(header_end + length, 0);
        socket
            .read_exact(&mut request[received..])
            .await
            .map_err(|error| error.to_string())?;
        socket.write_all(b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK").await.map_err(|error| error.to_string())?;
        Ok((headers, request[header_end..].to_vec()))
    });
    let result = async {
        let script = format!("fetch({},{{method:'POST',body:new FormData(uploadForm)}}).then(async response=>({{status:response.status,text:await response.text()}}))", json!(url));
        let response = evaluate(home, resource, page, epoch, &script).await?;
        if response != json!({"status":200,"text":"OK"}) {
            return Err(format!("upload HTTP response: {response}"));
        }
        let (headers, body) = timeout(Duration::from_secs(5), &mut server).await
            .map_err(|_| "upload HTTP receive deadline".to_string())?
            .map_err(|error| error.to_string())??;
        let boundary = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if !name.eq_ignore_ascii_case("content-type") { return None; }
            value.trim().strip_prefix("multipart/form-data; boundary=")
        }).ok_or("upload multipart boundary missing")?;
        let body = String::from_utf8(body).map_err(|error| error.to_string())?;
        let delimiter = format!("--{boundary}");
        let parts: Vec<_> = body.split(&delimiter).collect();
        if parts.len() != sources.len() + 2 || !parts[0].is_empty() || parts.last() != Some(&"--\r\n") {
            return Err("upload multipart framing differs".into());
        }
        let mut manifests = Vec::new();
        for ((name, contents), part) in sources.iter().zip(parts.iter().skip(1)) {
            let (header, bytes) = part.split_once("\r\n\r\n").ok_or("upload part headers missing")?;
            let bytes = bytes.strip_suffix("\r\n").ok_or("upload part terminator missing")?;
            if !header.contains(&format!("name=\"attachments\"; filename=\"{name}\"")) || bytes != contents {
                return Err(format!("uploaded HTTP part differs: {name}"));
            }
            manifests.push(json!({"name":name,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes.as_bytes()))}));
        }
        Ok(manifests)
    }.await;
    server.abort();
    result
}
