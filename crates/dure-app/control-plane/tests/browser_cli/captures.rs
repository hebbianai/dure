use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use tokio::{io::AsyncWriteExt, net::UnixStream, time::timeout};

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

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser capture: {evidence:?}"))
    }
}

fn png_size(path: &Path) -> Result<(u32, u32), String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    require(
        bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24,
        "PNG header",
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
    let dimensions = eval(home,resource,page,epoch,"document.body.innerHTML='';document.body.style.margin='0';const canvas=document.body.appendChild(document.createElement('canvas'));canvas.style.display='block';canvas.width=innerWidth;canvas.height=innerHeight;const ctx=canvas.getContext('2d');const image=ctx.createImageData(canvas.width,canvas.height);let value=12345;for(let i=0;i<image.data.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;image.data[i]=i%4===3?255:value&255;}ctx.putImageData(image,0,0);({width:innerWidth,height:innerHeight})").await?;
    let before = cli(home, &["show", resource]).await?;
    let detailed = home.join("detailed.png");
    let detail = cli(
        home,
        &[
            "screenshot",
            resource,
            "--page",
            page,
            "--output",
            detailed.to_str().unwrap(),
            "--idempotency-key",
            "capture-detailed-proof",
        ],
    )
    .await?;
    let after = cli(home, &["show", resource]).await?;
    require(
        before["result"]["control"] == after["result"]["control"],
        "image capture changed Host control",
    )?;
    require(
        fs::metadata(&detailed).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024,
        &detail,
    )?;
    let expected = (
        dimensions["width"].as_u64().unwrap() as u32,
        dimensions["height"].as_u64().unwrap() as u32,
    );
    require(png_size(&detailed)? == expected, &dimensions)?;
    eval(home,resource,page,epoch,"document.body.innerHTML='<style>@page{size:A4;margin:12mm}body{margin:0}</style><div style=\"height:1700px;background:#00ff00\">Dure browser PDF proof</div><div style=\"height:100px;background:#ff0000\">Capture bottom marker</div>';window.printCalls=0;window.onbeforeprint=()=>window.printCalls++;scrollTo(0,100)").await?;
    let layout_before = eval(
        home,
        resource,
        page,
        epoch,
        "({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,contentWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight})",
    )
    .await?;
    let full = home.join("full.png");
    cli(
        home,
        &[
            "full-screenshot",
            resource,
            "--page",
            page,
            "--output",
            full.to_str().unwrap(),
            "--idempotency-key",
            "capture-full-proof",
        ],
    )
    .await?;
    require(
        png_size(&full)? == (layout_before["contentWidth"].as_u64().unwrap() as u32, 1800),
        png_size(&full)?,
    )?;
    let jpeg = home.join("full.jpeg");
    cli(
        home,
        &[
            "full-screenshot",
            resource,
            "--page",
            page,
            "--output",
            jpeg.to_str().unwrap(),
            "--format",
            "jpeg",
            "--idempotency-key",
            "capture-jpeg-proof",
        ],
    )
    .await?;
    let jpeg_bytes = fs::read(&jpeg).map_err(|e| e.to_string())?;
    require(
        jpeg_bytes.starts_with(&[0xff, 0xd8]) && jpeg_bytes.ends_with(&[0xff, 0xd9]),
        "JPEG framing",
    )?;
    let layout_after = eval(
        home,
        resource,
        page,
        epoch,
        "({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,contentWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight})",
    )
    .await?;
    require(
        layout_before == layout_after,
        json!({"before":layout_before,"after":layout_after}),
    )?;
    let pdf = home.join("print.pdf");
    let denied = cli(
        home,
        &[
            "pdf",
            resource,
            "--page",
            page,
            "--output",
            pdf.to_str().unwrap(),
        ],
    )
    .await;
    require(
        denied
            .as_ref()
            .is_err_and(|e| e.contains("browser_controller_changed")),
        &denied,
    )?;
    cli(
        home,
        &[
            "pdf",
            resource,
            "--page",
            page,
            "--output",
            pdf.to_str().unwrap(),
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
            "--idempotency-key",
            "print-browser-proof",
        ],
    )
    .await?;
    require(
        fs::read(&pdf)
            .map_err(|e| e.to_string())?
            .starts_with(b"%PDF-"),
        "PDF framing",
    )?;
    require(
        eval(home, resource, page, epoch, "window.printCalls").await? == 1,
        "PDF handler count",
    )?;

    // Lose the client's socket after admission, then recover the exact file.
    let current = cli(home, &["show", resource]).await?;
    let control = &current["result"]["control"];
    let body = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current["result"]["pages"][0]["page"],"operation_id":"print-lost-browser-proof","command_sequence":control["next_command_sequence"]},"action":{"kind":"print_pdf"}});
    let request = envelope(endpoint, "browser.resource", body.clone());
    let mut socket = UnixStream::connect(&endpoint.socket_path)
        .await
        .map_err(|e| e.to_string())?;
    socket
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(socket);
    let recovered = timeout(Duration::from_secs(20), async {
        loop {
            let receipt = cli(home, &["receipt", "print-lost-browser-proof"]).await?;
            if receipt["receipt"]["state"] == "succeeded" {
                return Ok::<_, String>(receipt);
            }
            if receipt["receipt"]["state"] == "failed" {
                return Err(format!("print receipt: {receipt}"));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "print recovery deadline")??;
    require(recovered["result_available"] == true, &recovered)?;
    let duplicate = backend(endpoint, "browser.resource", body).await;
    require(duplicate["result"]["replayed"] == true, &duplicate)?;
    require(
        eval(home, resource, page, epoch, "window.printCalls").await? == 2,
        "PDF replay ran handlers again",
    )?;
    let invalid = backend(
        endpoint,
        "browser.resource",
        json!({"kind":"artifact","operation_id":"capture-full-proof","offset":u64::MAX}),
    )
    .await;
    require(
        invalid
            .to_string()
            .contains("browser_artifact_offset_invalid"),
        &invalid,
    )?;
    cli(
        home,
        &[
            "artifact",
            "print-lost-browser-proof",
            "--output",
            home.join("print-lost.pdf").to_str().unwrap(),
        ],
    )
    .await?;
    println!(
        "BROWSER_CAPTURE_EVIDENCE {}",
        json!({"root":home,"detail":detail,"fullSize":png_size(&full)?,"layoutBefore":layout_before,"layoutAfter":layout_after,"printHandlers":2,"lostPrint":recovered})
    );
    // Leave no print hook in later feature fixtures.
    eval(
        home,
        resource,
        page,
        epoch,
        "window.onbeforeprint=null;document.body.style.margin='8px';scrollTo(0,0)",
    )
    .await?;
    Ok(())
}

pub(super) async fn recover(home: &Path) -> Result<(), String> {
    for (operation, original) in [
        ("capture-detailed-proof", "detailed.png"),
        ("capture-full-proof", "full.png"),
        ("capture-jpeg-proof", "full.jpeg"),
        ("print-browser-proof", "print.pdf"),
        ("print-lost-browser-proof", "print-lost.pdf"),
    ] {
        let output = home.join(format!("recovered-{original}"));
        cli(
            home,
            &["artifact", operation, "--output", output.to_str().unwrap()],
        )
        .await?;
        require(
            fs::read(home.join(original)).map_err(|e| e.to_string())?
                == fs::read(&output).map_err(|e| e.to_string())?,
            operation,
        )?;
    }
    Ok(())
}
