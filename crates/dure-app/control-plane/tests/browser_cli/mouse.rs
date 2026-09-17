use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::path::Path;
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    time::{Duration, timeout},
};

async fn action(
    root: &Path,
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
    cli(root, &args).await
}

pub(super) async fn exercise(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<String, String> {
    action(root,resource,page,epoch,"eval",&["document.body.innerHTML='<button id=pointer-target style=\"position:fixed;left:200px;top:100px;width:100px;height:60px\">Pointer</button>';window.pointerEvents=[];for(const type of ['pointermove','pointerdown','pointerup','click','wheel'])document.addEventListener(type,e=>window.pointerEvents.push({type:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,button:e.button,target:e.target.id,trusted:e.isTrusted}));true"]).await?;
    action(root, resource, page, epoch, "hover", &["#pointer-target"]).await?;
    action(root, resource, page, epoch, "mouse", &["down"]).await?;
    action(root, resource, page, epoch, "mouse", &["up"]).await?;
    let events = action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    println!(
        "BROWSER_MOUSE_HOVER_CLI {}",
        json!({"root":root,"events":events})
    );
    if !events.as_array().is_some_and(|events| {
        events.iter().any(|e| {
            e["type"] == "click" && e["target"] == "pointer-target" && e["trusted"] == true
        })
    }) {
        return Err(format!(
            "mouse down/up did not continue the bound hover: {events}"
        ));
    }
    let shown = cli(root, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let current_page = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["page"]["page_id"] == page)
        .unwrap()["page"]
        .clone();
    for (index, input) in [
        json!({"kind":"move","x":1000001,"y":0}),
        json!({"kind":"down","button":"none"}),
        json!({"kind":"up","x":10}),
        json!({"kind":"move","x":10,"y":10,"buttons":1}),
    ]
    .into_iter()
    .enumerate()
    {
        let result=backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":format!("mouse-invalid-{index}"),"command_sequence":control["next_command_sequence"]},"action":{"kind":"mouse","action":input}})).await;
        if result["error"].is_null() {
            return Err(format!("invalid mouse proposal admitted: {result}"));
        }
    }
    if cli(root, &["show", resource]).await?["result"]["control"] != *control {
        return Err("invalid mouse input changed Host control".into());
    }
    action(root,resource,page,epoch,"eval",&["window.pointerEvents=[];document.body.style.height='3000px';document.addEventListener('contextmenu',e=>e.preventDefault());true"]).await?;
    for values in [
        &["move", "50", "50"][..],
        &["down"],
        &["move", "80", "85"],
        &["up"],
        &["down", "right"],
        &["down", "middle"],
        &["up", "middle"],
        &["move", "90", "95"],
        &["up", "right"],
    ] {
        action(root, resource, page, epoch, "mouse", values).await?;
    }
    let held = action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    let events = held.as_array().ok_or("mouse event list missing")?;
    if !events
        .iter()
        .any(|e| e["type"] == "pointermove" && e["x"] == 80 && e["y"] == 85 && e["buttons"] == 1)
        || !events
            .iter()
            .any(|e| e["type"] == "pointermove" && e["x"] == 90 && e["buttons"] == 2)
    {
        return Err(format!("held mouse movement lost buttons: {held}"));
    }
    action(
        root,
        resource,
        page,
        epoch,
        "mouse",
        &["move", "400", "400"],
    )
    .await?;
    action(root, resource, page, epoch, "mouse", &["wheel", "240"]).await?;
    action(
        root,
        resource,
        page,
        epoch,
        "wait",
        &["function", "scrollY>0", "--timeout", "3000"],
    )
    .await?;
    let wheel=action(root,resource,page,epoch,"eval",&["scrollY"]).await?["result"]["response"]["data"]["result"].clone();
    action(root, resource, page, epoch, "tab-new", &["about:blank"]).await?;
    let shown = cli(root, &["show", resource]).await?;
    let peer = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["page"]["page_id"] != page && e["url"] == "about:blank")
        .ok_or("mouse peer missing")?["page"]["page_id"]
        .as_str()
        .unwrap();
    action(root,resource,peer,epoch,"eval",&["window.pointerEvents=[];document.addEventListener('pointermove',e=>pointerEvents.push({buttons:e.buttons,x:e.clientX,y:e.clientY}));true"]).await?;
    action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents=[];true"],
    )
    .await?;
    action(
        root,
        resource,
        page,
        epoch,
        "mouse",
        &["move", "250", "130"],
    )
    .await?;
    action(root, resource, page, epoch, "mouse", &["down"]).await?;
    action(root, resource, peer, epoch, "mouse", &["move", "60", "70"]).await?;
    let peer_events = action(
        root,
        resource,
        peer,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    if !peer_events.as_array().is_some_and(|events| {
        events.iter().any(|e| e["x"] == 60 && e["y"] == 70)
            && events.iter().all(|e| e["buttons"] == 0)
    }) {
        return Err(format!("pointer leaked across pages: {peer_events}"));
    }
    let released = action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    if !released.as_array().is_some_and(|events| {
        events
            .iter()
            .any(|e| e["type"] == "pointerup" && e["buttons"] == 0)
    }) {
        return Err(format!("old page contact was not drained: {released}"));
    }
    action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents=[];true"],
    )
    .await?;
    action(
        root,
        resource,
        page,
        epoch,
        "mouse",
        &["move", "250", "130"],
    )
    .await?;
    action(root, resource, page, epoch, "mouse", &["down"]).await?;
    let handoff = cli(
        root,
        &["control", resource, "--controller", "human-pointer-proof"],
    )
    .await?;
    if handoff["result"]["controller"]["controller_id"] != "human-pointer-proof"
        || !handoff["result"]["pointer"].is_null()
    {
        return Err(format!("handoff granted with held pointer: {handoff}"));
    }
    if action(root, resource, page, epoch, "mouse", &["up"])
        .await
        .is_ok()
    {
        return Err("old controller released after handoff".into());
    }
    let returned = cli(root, &["control", resource, "--controller", "agent-proof"]).await?;
    let epoch = returned["result"]["controller"]["epoch"].as_str().unwrap();
    let handoff_events = action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    if !handoff_events
        .as_array()
        .is_some_and(|events| events.iter().filter(|e| e["type"] == "pointerup").count() == 1)
    {
        return Err(format!(
            "handoff release missing or duplicated: {handoff_events}"
        ));
    }
    action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents=[];true"],
    )
    .await?;
    action(
        root,
        resource,
        page,
        epoch,
        "mouse",
        &["move", "250", "130"],
    )
    .await?;
    let shown = cli(root, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let current_page = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["page"]["page_id"] == page)
        .unwrap()["page"]
        .clone();
    let lost = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"mouse-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"mouse","action":{"kind":"down"}}});
    let mut socket = UnixStream::connect(&endpoint.socket_path)
        .await
        .map_err(|e| e.to_string())?;
    socket
        .write_all(format!("{}\n", envelope(endpoint, "browser.resource", lost.clone())).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(socket);
    timeout(Duration::from_secs(10), async {
        loop {
            let receipt = cli(root, &["receipt", "mouse-lost-client"]).await?;
            if receipt["receipt"]["state"] == "succeeded" {
                return Ok::<_, String>(());
            }
            if receipt["receipt"]["state"] == "failed" {
                return Err(format!("mouse lost client: {receipt}"));
            }
        }
    })
    .await
    .map_err(|_| "mouse receipt timeout")??;
    action(
        root,
        resource,
        page,
        epoch,
        "mouse",
        &["move", "280", "140"],
    )
    .await?;
    if backend(endpoint, "browser.resource", lost).await["result"]["replayed"] != true {
        return Err("mouse client retry was not replayed".into());
    }
    action(root, resource, page, epoch, "mouse", &["up"]).await?;
    let replay_events = action(
        root,
        resource,
        page,
        epoch,
        "eval",
        &["window.pointerEvents"],
    )
    .await?["result"]["response"]["data"]["result"]
        .clone();
    if !replay_events.as_array().is_some_and(|events| {
        events.iter().filter(|e| e["type"] == "pointerdown").count() == 1
            && events
                .iter()
                .any(|e| e["type"] == "pointerup" && e["x"] == 280 && e["y"] == 140)
    }) {
        return Err(format!(
            "replay repeated input or restored coordinates: {replay_events}"
        ));
    }
    action(root, resource, peer, epoch, "tab-close", &[]).await?;
    action(root, resource, page, epoch, "tab-switch", &[]).await?;
    println!(
        "BROWSER_MOUSE_LIFECYCLE_CLI {}",
        json!({"root":root,"heldMovement":held,"wheelY":wheel,"peerEvents":peer_events,"pageDrain":released,"handoffDrain":handoff_events,"lostClientReplay":replay_events})
    );
    Ok(epoch.to_owned())
}
