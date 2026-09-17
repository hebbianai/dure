use super::cli;
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn command(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    name: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut arguments = vec![
        name,
        resource,
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
        "--",
    ];
    arguments.extend_from_slice(values);
    cli(home, &arguments).await
}

async fn evaluate(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    Ok(command(home, resource, page, epoch, "eval", &[script]).await?["result"]["response"]["data"]["result"].clone())
}

fn require(condition: bool, observation: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser basic action observation: {observation:?}"))
    }
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
) -> Result<(), String> {
    let html = r#"<select id=choice aria-label=Choice onchange='window.changes++'><option value=one>One</option><option value=two>Two</option></select><input id=check type=checkbox aria-label=Check onchange='window.checkChanges++'><input id=text value=Initial aria-label=Text><div id=hover onmouseenter='window.hoverCount++' style='width:100px;height:50px'>Hover</div><button id=double ondblclick='window.doubleCount++'>Double</button><button id=source onmousedown='window.dragDown++'>Source</button><button id=drop onmouseup='window.dragUp++'>Drop</button><div style='height:1800px'></div><button id=below>Below</button>"#;
    let setup = format!(
        "document.body.innerHTML={};window.changes=0;window.checkChanges=0;window.hoverCount=0;window.doubleCount=0;window.dragDown=0;window.dragUp=0",
        json!(html)
    );
    evaluate(home, resource, page, epoch, &setup).await?;
    let snapshot = cli(home, &["snapshot", resource, "--page", page]).await?;
    let refs = snapshot["references"]
        .as_object()
        .ok_or("fixture references missing")?;
    let reference = |name: &str| -> Result<&str, String> {
        refs.iter()
            .find(|(_, entry)| entry["name"] == name)
            .map(|(key, _)| key.as_str())
            .ok_or_else(|| format!("fixture ref {name} missing: {snapshot}"))
    };
    command(
        home,
        resource,
        page,
        epoch,
        "select",
        &[reference("Choice")?, "two"],
    )
    .await?;
    command(home, resource, page, epoch, "check", &[reference("Check")?]).await?;
    command(home, resource, page, epoch, "check", &[reference("Check")?]).await?;
    let checked = evaluate(
        home,
        resource,
        page,
        epoch,
        "document.querySelector('#check').checked",
    )
    .await?;
    require(checked == true, &checked)?;
    command(
        home,
        resource,
        page,
        epoch,
        "uncheck",
        &[reference("Check")?],
    )
    .await?;
    command(home, resource, page, epoch, "focus", &[reference("Text")?]).await?;
    command(home, resource, page, epoch, "type", &["한글 추가"]).await?;
    let typed = evaluate(
        home,
        resource,
        page,
        epoch,
        "document.querySelector('#text').value",
    )
    .await?;
    require(
        typed
            .as_str()
            .is_some_and(|text| text.contains("Initial") && text.contains("한글 추가")),
        &typed,
    )?;
    command(
        home,
        resource,
        page,
        epoch,
        "select-all",
        &[reference("Text")?],
    )
    .await?;
    command(home, resource, page, epoch, "inserttext", &["교체"]).await?;
    let replaced = evaluate(
        home,
        resource,
        page,
        epoch,
        "document.querySelector('#text').value",
    )
    .await?;
    require(replaced == "교체", &replaced)?;
    command(home, resource, page, epoch, "clear", &[reference("Text")?]).await?;
    command(home, resource, page, epoch, "hover", &["#hover"]).await?;
    command(
        home,
        resource,
        page,
        epoch,
        "dblclick",
        &[reference("Double")?],
    )
    .await?;
    command(
        home,
        resource,
        page,
        epoch,
        "drag",
        &[reference("Source")?, reference("Drop")?],
    )
    .await?;
    let state = evaluate(home, resource, page, epoch, "({choice:document.querySelector('#choice').value,changes,checked:document.querySelector('#check').checked,checkChanges,text:document.querySelector('#text').value,hoverCount,doubleCount,dragDown,dragUp})").await?;
    require(
        state["choice"] == "two"
            && state["changes"] == 1
            && state["checked"] == false
            && state["checkChanges"] == 2
            && state["text"] == ""
            && state["hoverCount"].as_u64().is_some_and(|count| count >= 1)
            && state["doubleCount"] == 1
            && state["dragDown"] == 1
            && state["dragUp"] == 1,
        &state,
    )?;
    command(home, resource, page, epoch, "scroll", &["down", "400"]).await?;
    let scrolled = evaluate(home, resource, page, epoch, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(scrollY))))").await?;
    require(
        scrolled.as_f64().is_some_and(|value| value > 0.0),
        &scrolled,
    )?;
    command(home, resource, page, epoch, "scrollintoview", &["#below"]).await?;
    let below = evaluate(home, resource, page, epoch, "new Promise(resolve=>requestAnimationFrame(()=>{let r=document.querySelector('#below').getBoundingClientRect();resolve(r.top>=0&&r.bottom<=innerHeight)}))").await?;
    require(below == true, &below)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|error| error.to_string())?
    );
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<!doctype html><button onclick='window.writes++'>Navigate proof</button><script>window.writes=0;window.boot=crypto.randomUUID()</script>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let navigation: Result<_, String> = async {
        command(
            home,
            resource,
            page,
            epoch,
            "goto",
            &[&format!("{origin}/one")],
        )
        .await?;
        command(
            home,
            resource,
            page,
            epoch,
            "goto",
            &[&format!("{origin}/two")],
        )
        .await?;
        command(home, resource, page, epoch, "back", &[]).await?;
        let back = evaluate(home, resource, page, epoch, "location.pathname").await?;
        require(back == "/one", &back)?;
        command(home, resource, page, epoch, "forward", &[]).await?;
        let forward = evaluate(
            home,
            resource,
            page,
            epoch,
            "({path:location.pathname,boot})",
        )
        .await?;
        require(forward["path"] == "/two", &forward)?;
        let snapshot = cli(home, &["snapshot", resource, "--page", page]).await?;
        let old_ref = snapshot["references"]
            .as_object()
            .ok_or("navigation refs missing")?
            .keys()
            .next()
            .ok_or("navigation button missing")?;
        command(home, resource, page, epoch, "reload", &[]).await?;
        let stale = command(home, resource, page, epoch, "click", &[old_ref]).await;
        require(
            stale
                .as_ref()
                .is_err_and(|error| error.contains("browser_document_changed")),
            &stale,
        )?;
        let reloaded = evaluate(
            home,
            resource,
            page,
            epoch,
            "({path:location.pathname,boot,writes})",
        )
        .await?;
        require(
            reloaded["path"] == "/two"
                && reloaded["boot"] != forward["boot"]
                && reloaded["writes"] == 0,
            &reloaded,
        )?;
        Ok(json!({"back":back,"forward":forward,"reloaded":reloaded}))
    }
    .await;
    server.abort();
    println!(
        "BROWSER_BASIC_ACTIONS_EVIDENCE {}",
        json!({"forms":state,"scrollY":scrolled,"belowVisible":below,"navigation":navigation?})
    );
    Ok(())
}
