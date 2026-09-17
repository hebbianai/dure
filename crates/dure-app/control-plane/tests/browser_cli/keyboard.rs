use super::{backend, cli, envelope};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::path::Path;
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    time::{Duration, timeout},
};

#[path = "keyboard/editing.rs"]
mod editing;

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
async fn read(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    Ok(
        action(root, resource, page, epoch, "eval", &[script]).await?["result"]["response"]["data"]
            ["result"]
            .clone(),
    )
}

pub(super) async fn exercise(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<String, String> {
    action(root, resource, page, epoch, "eval", &["document.body.innerHTML='<input id=keyboard-target><button id=keyboard-button style=\"position:fixed;left:200px;top:100px;width:100px;height:60px\">Pointer</button>';document.querySelector('input').focus();window.keyboardEvents=[];for(const type of ['keydown','keyup','pointerdown','pointerup','click'])document.addEventListener(type,e=>keyboardEvents.push({type:e.type,key:e.key,code:e.code,shift:e.shiftKey,ctrl:e.ctrlKey,meta:e.metaKey,repeat:e.repeat,trusted:e.isTrusted}));true"]).await?;
    action(root, resource, page, epoch, "key", &["Shift+a"]).await?;
    let actual = read(
        root,
        resource,
        page,
        epoch,
        "({text:document.querySelector('input').value,events:keyboardEvents})",
    )
    .await?;
    println!(
        "BROWSER_KEYBOARD_CHORD_CLI {}",
        json!({"root":root,"actual":actual})
    );
    if actual["text"] != "A" {
        return Err(format!("Shift+a did not insert uppercase A: {actual}"));
    }
    read(
        root,
        resource,
        page,
        epoch,
        "document.querySelector('input').value='';keyboardEvents=[];true",
    )
    .await?;
    for (command, key) in [
        ("keydown", "Shift"),
        ("key", "a"),
        ("keydown", "KeyA"),
        ("keydown", "a"),
        ("keyup", "KeyA"),
        ("keyup", "Shift"),
        ("keydown", "ShiftLeft"),
        ("keydown", "ShiftRight"),
        ("keyup", "ShiftLeft"),
        ("key", "b"),
        ("keyup", "ShiftRight"),
        ("key", "c"),
        ("key", "Shift+1"),
        ("key", "+"),
        ("key", "한"),
    ] {
        action(root, resource, page, epoch, command, &[key]).await?;
    }
    let repeated = read(
        root,
        resource,
        page,
        epoch,
        "({text:document.querySelector('input').value,events:keyboardEvents})",
    )
    .await?;
    if repeated["text"] != "AAABc!+한"
        || !repeated["events"].as_array().is_some_and(|events| {
            events.iter().any(|e| {
                e["type"] == "keydown"
                    && e["code"] == "KeyA"
                    && e["repeat"] == true
                    && e["shift"] == true
            })
        })
    {
        return Err(format!("held keys or repeat changed: {repeated}"));
    }
    read(root,resource,page,epoch,"document.querySelector('input').value='replace me';document.querySelector('input').focus();true").await?;
    action(
        root,
        resource,
        page,
        epoch,
        "key",
        &[if cfg!(target_os = "macos") {
            "Meta+a"
        } else {
            "Control+a"
        }],
    )
    .await?;
    action(root, resource, page, epoch, "key", &["z"]).await?;
    let edited = read(
        root,
        resource,
        page,
        epoch,
        "document.querySelector('input').value",
    )
    .await?;
    if edited != "z" {
        return Err(format!(
            "native select-all chord did not replace text: {edited}"
        ));
    }
    editing::exercise(root, resource, page, epoch).await?;
    read(root, resource, page, epoch, "keyboardEvents=[];true").await?;
    action(root, resource, page, epoch, "keydown", &["Shift"]).await?;
    action(root, resource, page, epoch, "click", &["#keyboard-button"]).await?;
    let shifted_click = read(root, resource, page, epoch, "keyboardEvents").await?;
    if !shifted_click.as_array().is_some_and(|events| {
        events
            .iter()
            .any(|e| e["type"] == "click" && e["shift"] == true && e["trusted"] == true)
    }) {
        return Err(format!("pointer did not share held Shift: {shifted_click}"));
    }
    action(root, resource, page, epoch, "keyup", &["Shift"]).await?;

    action(root, resource, page, epoch, "tab-new", &["about:blank"]).await?;
    let shown = cli(root, &["show", resource]).await?;
    let peer = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["page"]["page_id"] != page && p["url"] == "about:blank")
        .ok_or("keyboard peer missing")?["page"]["page_id"]
        .as_str()
        .unwrap();
    read(
        root,
        resource,
        peer,
        epoch,
        "document.body.innerHTML='<input>';document.querySelector('input').focus();true",
    )
    .await?;
    read(root, resource, page, epoch, "keyboardEvents=[];true").await?;
    action(root, resource, page, epoch, "keydown", &["Shift"]).await?;
    action(root, resource, peer, epoch, "key", &["a"]).await?;
    let peer_text = read(
        root,
        resource,
        peer,
        epoch,
        "document.querySelector('input').value",
    )
    .await?;
    let page_drain = read(root, resource, page, epoch, "keyboardEvents").await?;
    if peer_text != "a"
        || !page_drain.as_array().is_some_and(|events| {
            events
                .iter()
                .filter(|e| e["type"] == "keyup" && e["key"] == "Shift")
                .count()
                == 1
        })
    {
        return Err(format!("keyboard leaked to peer: {peer_text} {page_drain}"));
    }
    action(root, resource, peer, epoch, "tab-close", &[]).await?;
    read(root, resource, page, epoch, "keyboardEvents=[];true").await?;
    action(root, resource, page, epoch, "hover", &["#keyboard-button"]).await?;
    action(root, resource, page, epoch, "keydown", &["Shift"]).await?;
    action(root, resource, page, epoch, "mouse", &["down"]).await?;
    let handoff = cli(
        root,
        &["control", resource, "--controller", "human-keyboard-proof"],
    )
    .await?;
    if handoff["result"]["controller"]["controller_id"] != "human-keyboard-proof"
        || !handoff["result"]["keyboard"].is_null()
        || !handoff["result"]["pointer"].is_null()
    {
        return Err(format!("control granted before input drain: {handoff}"));
    }
    if action(root, resource, page, epoch, "keyup", &["Shift"])
        .await
        .is_ok()
    {
        return Err("old controller released a key after handoff".into());
    }
    let returned = cli(root, &["control", resource, "--controller", "agent-proof"]).await?;
    let epoch = returned["result"]["controller"]["epoch"].as_str().unwrap();
    let handoff_events = read(root, resource, page, epoch, "keyboardEvents").await?;
    if !handoff_events.as_array().is_some_and(|events| {
        let pointer = events
            .iter()
            .position(|e| e["type"] == "pointerup" && e["shift"] == true);
        let key = events
            .iter()
            .position(|e| e["type"] == "keyup" && e["key"] == "Shift" && e["shift"] == false);
        matches!((pointer,key),(Some(pointer),Some(key)) if pointer<key)
            && events.iter().filter(|e| e["type"] == "keyup").count() == 1
    }) {
        return Err(format!(
            "handoff input release missing or reordered: {handoff_events}"
        ));
    }

    read(root,resource,page,epoch,"keyboardEvents=[];document.querySelector('input').value='';document.querySelector('input').focus();true").await?;
    let shown = cli(root, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let current = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["page"]["page_id"] == page)
        .unwrap()["page"]
        .clone();
    for (i, input) in [
        json!({"kind":"key_down","key":""}),
        json!({"kind":"key_up","key":"invalid key"}),
        json!({"kind":"press","key":"Control+"}),
        json!({"kind":"key_down","key":"a","modifiers":8}),
    ]
    .into_iter()
    .enumerate()
    {
        let result=backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current,"operation_id":format!("keyboard-invalid-{i}"),"command_sequence":control["next_command_sequence"]},"action":input})).await;
        if result["error"].is_null() {
            return Err(format!("invalid keyboard proposal admitted: {result}"));
        }
    }
    if cli(root, &["show", resource]).await?["result"]["control"] != *control {
        return Err("invalid keyboard proposal changed Host state".into());
    }
    let lost = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current,"operation_id":"keyboard-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"key_down","key":"a"}});
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
            let receipt = cli(root, &["receipt", "keyboard-lost-client"]).await?;
            if receipt["receipt"]["state"] == "succeeded" {
                return Ok::<_, String>(());
            }
            if receipt["receipt"]["state"] == "failed" {
                return Err(format!("lost keyboard operation: {receipt}"));
            }
        }
    })
    .await
    .map_err(|_| "keyboard receipt timeout")??;
    action(root, resource, page, epoch, "keyup", &["a"]).await?;
    action(root, resource, page, epoch, "keydown", &["Shift"]).await?;
    if backend(endpoint, "browser.resource", lost).await["result"]["replayed"] != true {
        return Err("lost keyboard operation was redispatched".into());
    }
    let replayed = read(
        root,
        resource,
        page,
        epoch,
        "({text:document.querySelector('input').value,events:keyboardEvents})",
    )
    .await?;
    let after = cli(root, &["show", resource]).await?;
    if replayed["text"] != "a"
        || after["result"]["control"]["keyboard"]["keys"] != json!(["ShiftLeft"])
    {
        return Err(format!(
            "keyboard replay repeated text or replaced newer contacts: {replayed} {after}"
        ));
    }
    action(root, resource, page, epoch, "keyup", &["Shift"]).await?;
    println!(
        "BROWSER_KEYBOARD_LIFECYCLE_CLI {}",
        json!({"root":root,"heldRepeat":repeated,"nativeEditing":edited,"shiftedClick":shifted_click,"pageDrain":page_drain,"peerText":peer_text,"handoffDrain":handoff_events,"lostClientReplay":replayed})
    );
    Ok(epoch.to_owned())
}
