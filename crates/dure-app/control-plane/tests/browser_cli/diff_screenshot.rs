use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn real_screenshot_diff_preserves_authority_files_and_recovers_lost_response() {
    let (root, endpoint, server) = fixture().await;
    let mut resources = Vec::new();
    let evidence: Result<_, String> = async {
        let mut owned = Vec::new();
        for name in ["image-diff-owner", "image-diff-peer"] {
            let created = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", name]).await?;
            let id = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?.to_owned();
            resources.push(id.clone());
            let controlled = cli(&root, &["control", &id, "--controller", name]).await?;
            let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?.to_owned();
            cli(&root, &["eval", &id, "document.body.innerHTML='<style>body{margin:0}button{display:block;width:20px;height:20px;border:0;padding:0;background:rgb(0,0,0)}</style><button id=sample aria-label=sample></button>';true", "--controller", name, "--epoch", &epoch]).await?;
            owned.push((id, epoch));
        }
        let (id, epoch) = &owned[0];
        let peer_before = cli(&root, &["show", &owned[1].0]).await?;
        let baseline_path = root.join("baseline.png");
        cli(&root, &["screenshot", id, "--element", "#sample", "--output", baseline_path.to_str().unwrap()]).await?;
        let baseline = fs::read(&baseline_path).map_err(|e| e.to_string())?;
        let original = cli(&root, &["snapshot", id]).await?;
        let reference = original["references"].as_object().ok_or("refs missing")?.iter().find(|(_, v)| v["role"] == "button").ok_or("button reference missing")?.0;
        fs::write(root.join("preserved.png"), b"existing destination").map_err(|e| e.to_string())?;
        let before = cli(&root, &["show", id]).await?;
        let equal = cli_from(&root, &["diff", id, "screenshot", "--baseline", "baseline.png", "--selector", reference, "--output", "preserved.png"], Some(&root)).await?;
        let after = cli(&root, &["show", id]).await?;
        let equal_preserved = fs::read(root.join("preserved.png")).map_err(|e| e.to_string())? == b"existing destination";
        cli(&root, &["eval", id, "document.querySelector('#sample').style.background='white';true", "--controller", "image-diff-owner", "--epoch", epoch]).await?;
        let changed = cli_from(&root, &["exec", id, "--command", "diff screenshot -b baseline.png -s '#sample' -t 0 -o changed.png --json"], Some(&root)).await?;
        let changed_bytes = fs::read(root.join("changed.png")).map_err(|e| e.to_string())?;
        let threshold = cli_from(&root, &["diff", id, "screenshot", "--baseline", "baseline.png", "--selector", "#sample", "--threshold", "1", "--output", "preserved.png"], Some(&root)).await?;
        cli(&root, &["eval", id, "document.querySelector('#sample').style.width='30px';true", "--controller", "image-diff-owner", "--epoch", epoch]).await?;
        let dimensions = cli_from(&root, &["diff", id, "screenshot", "--baseline", "baseline.png", "--selector", "#sample", "--output", "preserved.png"], Some(&root)).await?;
        cli(&root, &["snapshot", id]).await?;
        let stale = cli_from(&root, &["diff", id, "screenshot", "--baseline", "baseline.png", "--selector", reference], Some(&root)).await.err();
        let foreign_reference = cli_from(&root, &["diff", &owned[1].0, "screenshot", "--baseline", "baseline.png", "--selector", reference], Some(&root)).await.err();
        fs::write(root.join("broken.png"), b"not an image").map_err(|e| e.to_string())?;
        let malformed = cli_from(&root, &["diff", id, "screenshot", "--baseline", "broken.png", "--output", "preserved.png"], Some(&root)).await.err();
        cli(&root, &["eval", id, "document.querySelector('#sample').style.width='20px';true", "--controller", "image-diff-owner", "--epoch", epoch]).await?;
        let current = cli(&root, &["show", id]).await?;
        let page = &current["result"]["control"]["current_page"];
        let uploaded = backend(&endpoint, "browser.resource", json!({"kind":"upload_chunk","resource":page["resource"],"chunk":{"file":{"name":"baseline.png","size":baseline.len(),"sha256":format!("{:x}",Sha256::digest(&baseline))},"offset":0,"base64":STANDARD.encode(&baseline)}})).await;
        let baseline_id = uploaded["result"]["result"]["id"].as_str().ok_or_else(|| format!("upload: {uploaded}"))?;
        let foreign = backend(&endpoint, "browser.resource", json!({"kind":"capture_diff","page":peer_before["result"]["control"]["current_page"],"baseline":baseline_id,"threshold":0.1,"options":{},"operation_id":"image-diff-foreign-upload"})).await;
        let body = json!({"kind":"capture_diff","page":page,"baseline":baseline_id,"threshold":0.0,"options":{"target":{"kind":"css","selector":"#sample"}},"operation_id":"image-diff-lost-response"});
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.map_err(|e| e.to_string())?;
        socket.write_all(format!("{}\n", envelope(&endpoint, "browser.resource", body.clone())).as_bytes()).await.map_err(|e| e.to_string())?;
        drop(socket);
        let recovered = timeout(Duration::from_secs(20), async {
            loop {
                let receipt = cli(&root, &["receipt", "image-diff-lost-response"]).await?;
                match receipt["receipt"]["state"].as_str() {
                    Some("succeeded") => return Ok::<_, String>(receipt),
                    Some("failed") => return Err(format!("comparison receipt: {receipt}")),
                    _ => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }).await.map_err(|_| "comparison recovery deadline")??;
        // Alter pixels after completion: replay must return the original result.
        cli(&root, &["eval", id, "document.querySelector('#sample').style.background='black';true", "--controller", "image-diff-owner", "--epoch", epoch]).await?;
        let duplicate = backend(&endpoint, "browser.resource", body).await;
        cli(&root, &["artifact", "image-diff-lost-response", "--output", root.join("recovered.png").to_str().unwrap()]).await?;
        let peer_after = cli(&root, &["show", &owned[1].0]).await?;
        Ok(json!({"equal":equal["result"],"changed":changed["result"],"threshold":threshold["result"],"dimensions":dimensions["result"],"equalPreserved":equal_preserved,"destinationPreserved":fs::read(root.join("preserved.png")).map_err(|e|e.to_string())?==b"existing destination","baselinePreserved":fs::read(&baseline_path).map_err(|e|e.to_string())?==baseline,"png":changed_bytes.starts_with(b"\x89PNG\r\n\x1a\n"),"sameControl":before["result"]["control"]==after["result"]["control"],"peerUnchanged":peer_before["result"]["control"]==peer_after["result"]["control"],"stale":stale,"foreignReference":foreign_reference,"malformed":malformed,"foreignUpload":foreign,"recovered":recovered,"duplicate":duplicate,"sameRecoveredImage":fs::read(root.join("recovered.png")).map_err(|e|e.to_string())?==changed_bytes}))
    }.await;
    let mut closed = Vec::new();
    for resource in resources {
        closed.push(cli(&root, &["close", &resource]).await);
    }
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let server_closed = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_IMAGE_DIFF_CLEANUP root={} closed={closed:?} stopped={stopped:?} server_closed={server_closed:?}",
        root.display()
    );
    assert!(closed.iter().all(Result::is_ok));
    assert_eq!(stopped["kind"], "dure.backend.response");
    server_closed.unwrap().unwrap().unwrap();
    let evidence = evidence.unwrap();
    println!("BROWSER_IMAGE_DIFF_JSON {evidence}");
    for key in [
        "equalPreserved",
        "destinationPreserved",
        "baselinePreserved",
        "png",
        "sameControl",
        "peerUnchanged",
        "sameRecoveredImage",
    ] {
        assert_eq!(evidence[key], true, "{key}");
    }
    assert_eq!(evidence["equal"]["match"], true);
    assert!(evidence["equal"]["artifact"].is_null());
    assert_eq!(evidence["changed"]["match"], false);
    assert_eq!(evidence["changed"]["differentPixels"], 400);
    assert_eq!(evidence["changed"]["mismatchPercentage"], 100.0);
    assert_eq!(evidence["threshold"]["match"], true);
    assert!(evidence["threshold"]["artifact"].is_null());
    assert_eq!(
        evidence["dimensions"]["dimensionMismatch"],
        json!({"expected":{"width":20,"height":20},"actual":{"width":30,"height":20}})
    );
    assert!(evidence["dimensions"]["artifact"].is_null());
    for (key, code) in [
        ("stale", "browser_snapshot_changed"),
        ("foreignReference", "browser_reference_page_mismatch"),
        ("malformed", "browser_diff_image_invalid"),
    ] {
        assert!(
            evidence[key]
                .as_str()
                .is_some_and(|error| error.contains(code)),
            "{key}: {}",
            evidence[key]
        );
    }
    assert!(
        evidence["foreignUpload"]
            .to_string()
            .contains("browser_upload_incomplete")
    );
    assert_eq!(evidence["recovered"]["result_available"], true);
    assert_eq!(evidence["recovered"]["result"]["match"], false);
    assert_eq!(evidence["duplicate"]["result"]["replayed"], true);
    assert_eq!(evidence["duplicate"]["result"]["result"]["match"], false);
}
