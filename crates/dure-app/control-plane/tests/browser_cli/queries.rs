use super::{backend, cli};
use dure_control_plane::ControlPlaneEndpoint;
use serde_json::{Value, json};
use std::path::Path;

async fn read(
    home: &Path,
    resource: &str,
    page: &str,
    command: &str,
    values: &[&str],
) -> Result<Value, String> {
    let mut arguments = vec![command, resource, "--page", page, "--"];
    arguments.extend_from_slice(values);
    let result = cli(home, &arguments).await?;
    Ok(result["result"]["data"].clone())
}

fn require(condition: bool, observation: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser observer query: {observation:?}"))
    }
}

pub(super) async fn without_controller(
    home: &Path,
    resource: &str,
    page: &str,
) -> Result<(), String> {
    let before = cli(home, &["show", resource]).await?;
    let url = read(home, resource, page, "get", &["url"]).await?;
    let title = read(home, resource, page, "get", &["title"]).await?;
    let after = cli(home, &["show", resource]).await?;
    require(
        url["url"] == "about:blank" && title["title"] == "",
        (&url, &title),
    )?;
    require(before["result"]["control"]["controller"].is_null(), &before)?;
    require(before == after, (&before, &after))
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
) -> Result<(), String> {
    let setup = "document.title='Observer queries';document.body.innerHTML='<input id=value aria-label=Value value=한글 data-proof=kept><input id=checked type=checkbox checked><button id=disabled disabled>Disabled</button><div id=hidden hidden>Hidden</div><div id=content style=\"color:rgb(12,34,56)\"><b>Visible text</b></div>';document.querySelector('#value').focus();window.queryWrites=0;document.addEventListener('input',()=>window.queryWrites++)";
    cli(
        home,
        &[
            "eval",
            resource,
            setup,
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?;
    let snapshot = cli(home, &["snapshot", resource, "--page", page]).await?;
    let reference = snapshot["references"]
        .as_object()
        .ok_or("query refs missing")?
        .iter()
        .find(|(_, entry)| entry["name"] == "Value")
        .ok_or("query value ref missing")?
        .0;
    let before = cli(home, &["show", resource]).await?;
    let text = read(home, resource, page, "get", &["text", "#content"]).await?;
    let html = read(home, resource, page, "get", &["html", "#content"]).await?;
    let value = read(home, resource, page, "get", &["value", reference]).await?;
    let attribute = read(
        home,
        resource,
        page,
        "get",
        &["attr", reference, "data-proof"],
    )
    .await?;
    let absent = read(
        home,
        resource,
        page,
        "get",
        &["attr", reference, "data-absent"],
    )
    .await?;
    let count = read(home, resource, page, "get", &["count", "input"]).await?;
    let bounds = read(home, resource, page, "get", &["box", reference]).await?;
    let styles = read(home, resource, page, "get", &["styles", "#content"]).await?;
    let title = read(home, resource, page, "get", &["title"]).await?;
    let visible = read(home, resource, page, "is", &["visible", reference]).await?;
    let hidden = read(home, resource, page, "is", &["visible", "#hidden"]).await?;
    let enabled = read(home, resource, page, "is", &["enabled", reference]).await?;
    let disabled = read(home, resource, page, "is", &["enabled", "#disabled"]).await?;
    let checked = read(home, resource, page, "is", &["checked", "#checked"]).await?;
    let after = cli(home, &["show", resource]).await?;
    require(
        text["text"] == "Visible text" && html["html"] == "<b>Visible text</b>",
        (&text, &html),
    )?;
    require(
        value["value"] == "한글" && attribute["value"] == "kept" && absent["value"].is_null(),
        (&value, &attribute, &absent),
    )?;
    require(
        count["count"] == 2 && title["title"] == "Observer queries",
        (&count, &title),
    )?;
    require(
        bounds["width"].as_f64().is_some_and(|width| width > 0.0),
        &bounds,
    )?;
    require(styles["styles"]["color"] == "rgb(12, 34, 56)", &styles)?;
    require(
        visible["visible"] == true
            && hidden["visible"] == false
            && enabled["enabled"] == true
            && disabled["enabled"] == false
            && checked["checked"] == true,
        (&visible, &hidden, &enabled, &disabled, &checked),
    )?;
    require(before == after, (&before, &after))?;
    let unchanged = cli(
        home,
        &[
            "eval",
            resource,
            "({focus:document.activeElement.id,writes:window.queryWrites})",
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?;
    require(
        unchanged["result"]["response"]["data"]["result"] == json!({"focus":"value","writes":0}),
        &unchanged,
    )?;

    cli(home, &["snapshot", resource, "--page", page]).await?;
    let stale = read(home, resource, page, "get", &["value", reference]).await;
    require(
        stale
            .as_ref()
            .is_err_and(|error| error.contains("browser_snapshot_changed")),
        &stale,
    )?;
    for selector in ["@e1", "ref=e1", "e1"] {
        let raw = read(home, resource, page, "get", &["value", selector]).await;
        require(raw.is_err(), &raw)?;
    }
    cli(
        home,
        &[
            "tab-new",
            resource,
            "about:blank",
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?;
    let pages = cli(home, &["show", resource]).await?;
    let other = pages["result"]["pages"]
        .as_array()
        .ok_or("query pages missing")?
        .iter()
        .find(|entry| entry["page"]["page_id"] != page)
        .and_then(|entry| entry["page"]["page_id"].as_str())
        .ok_or("query other page missing")?;
    let inactive = read(home, resource, page, "get", &["title"]).await;
    require(
        inactive
            .as_ref()
            .is_err_and(|error| error.contains("browser_page_selection_required")),
        &inactive,
    )?;
    let active = read(home, resource, other, "get", &["title"]).await?;
    require(active["title"] == "", &active)?;
    let after_rejection = cli(home, &["show", resource]).await?;
    require(pages == after_rejection, (&pages, &after_rejection))?;
    let other_page = pages["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["page"]["page_id"] == other)
        .unwrap()["page"]
        .clone();
    let element = snapshot["result"]["data"]["refs"]
        .as_object()
        .ok_or("native query refs missing")?
        .iter()
        .find(|(_, entry)| entry["name"] == "Value")
        .ok_or("native query value missing")?
        .0;
    let mismatched = backend(
        endpoint,
        "browser.resource",
        json!({
            "kind":"query", "page":other_page,
            "query":{"kind":"value","target":{"kind":"reference","reference":{
                "snapshot":snapshot["result"]["snapshot"],"element":element
            }}}
        }),
    )
    .await;
    require(
        mismatched
            .to_string()
            .contains("browser_reference_page_mismatch"),
        &mismatched,
    )?;
    let arbitrary = backend(
        endpoint,
        "browser.resource",
        json!({
            "kind":"query", "page":other_page,
            "query":{"kind":"evaluate","script":"document.title='observer bypass'"}
        }),
    )
    .await;
    require(
        arbitrary.to_string().contains("browser_request_invalid"),
        &arbitrary,
    )?;
    let still_active = read(home, resource, other, "get", &["title"]).await?;
    require(still_active["title"] == "", &still_active)?;
    cli(
        home,
        &[
            "tab-switch",
            resource,
            "--page",
            page,
            "--controller",
            "agent-proof",
            "--epoch",
            epoch,
        ],
    )
    .await?;
    println!(
        "BROWSER_QUERY_EVIDENCE {}",
        json!({"text":text,"value":value,"attribute":attribute,"count":count,"bounds":bounds,"color":styles["styles"]["color"],"focusAndWrites":unchanged["result"]["response"]["data"]["result"],"controlUnchanged":true,"inactiveRejected":true,"staleRejected":true})
    );
    Ok(())
}
