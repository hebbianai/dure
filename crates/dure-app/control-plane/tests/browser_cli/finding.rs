use super::cli;
use serde_json::{Value, json};
use std::path::Path;

async fn command(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    arguments: &[&str],
) -> Result<Value, String> {
    let mut args = vec![
        arguments[0],
        resource,
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(&arguments[1..]);
    cli(home, &args).await
}

async fn eval(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    script: &str,
) -> Result<Value, String> {
    Ok(command(home, resource, page, epoch, &["eval", script]).await?["result"]["response"]["data"]["result"].clone())
}

fn require(condition: bool, evidence: impl std::fmt::Debug) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(format!("browser semantic locator: {evidence:?}"))
    }
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
) -> Result<(), String> {
    let html = r#"<button id=wrong data-agent-browser-located=true onclick="window.wrong++">Wrong</button>
      <button id=wanted title=Wanted onclick="window.wanted++;window.trusted=event.isTrusted">Wanted</button>
      <label for=field>한글 이름</label><input id=field placeholder="한글 입력" value=Initial>
      <label>주문<textarea id=area>Initial</textarea></label>
      <span id=caption>접근성 이름</span><button id=accessible aria-labelledby=caption onclick="window.ariaClicks++"><span>Different</span></button>
      <button hidden aria-label="접근성 이름" onclick="window.wrong++">Hidden</button>
      <button id=compound onclick="window.compound++">Save <span>changes</span></button>
      <input type=checkbox aria-label=Check onchange="window.checkChanges++">
      <div contenteditable role=textbox aria-label=Editor>Old <b>rich</b> text</div>
      <button data-testid="literal'[]" onclick="window.literal++">Literal</button>
      <img alt=Picture width=20 height=20 src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='red'/%3E%3C/svg%3E" onclick="window.images++">
      <button class=order onclick="window.order.push(0)">First</button><button class=order onclick="window.order.push(1)">Middle</button><button class=order onclick="window.order.push(2)">Last</button>
      <div title=Hover onmouseenter="window.hovers++" style="width:80px;height:30px">Hover</div>
      <h2>Account <span>settings</span></h2><div role=presentation>Backdrop</div>
      <button title=Disabled disabled onclick="window.wrong++">Disabled</button>"#;
    eval(home, resource, page, epoch, &format!("document.body.innerHTML={};window.wrong=0;window.wanted=0;window.trusted=false;window.ariaClicks=0;window.compound=0;window.checkChanges=0;window.literal=0;window.images=0;window.order=[];window.hovers=0;window.markerWrites=0;new MutationObserver(records=>{{markerWrites+=records.filter(r=>r.type==='attributes'&&r.attributeName==='data-agent-browser-located').length}}).observe(document.body,{{subtree:true,attributes:true}})", json!(html))).await?;
    let denied = cli(
        home,
        &["find", resource, "title", "Wanted", "click", "--page", page],
    )
    .await;
    require(
        denied
            .as_ref()
            .is_err_and(|error| error.contains("browser_controller_changed")),
        &denied,
    )?;
    command(
        home,
        resource,
        page,
        epoch,
        &["find", "title", "Wanted", "click", "--exact"],
    )
    .await?;
    let marker = eval(home, resource, page, epoch, "({wrong,wanted,originalMarker:document.querySelector('#wrong').getAttribute('data-agent-browser-located'),trusted,markerWrites})").await?;
    println!("BROWSER_FIND_MARKER_EVIDENCE {marker}");
    require(
        marker
            == json!({"wrong":0,"wanted":1,"originalMarker":"true","trusted":true,"markerWrites":0}),
        &marker,
    )?;

    let before = cli(home, &["show", resource]).await?;
    let read = cli(
        home,
        &[
            "find",
            resource,
            "role",
            "heading",
            "text",
            "--name",
            "Account settings",
            "--exact",
            "--page",
            page,
        ],
    )
    .await?;
    let after = cli(home, &["show", resource]).await?;
    require(read["result"]["data"]["text"] == "Account settings", &read)?;
    require(
        before["result"]["control"] == after["result"]["control"],
        &after,
    )?;
    let presentation = cli(
        home,
        &[
            "find",
            resource,
            "role",
            "presentation",
            "text",
            "--page",
            page,
        ],
    )
    .await?;
    require(
        presentation["result"]["data"]["text"] == "Backdrop",
        &presentation,
    )?;
    for args in [
        vec!["find", "label", "한글 이름", "fill", "교체", "--exact"],
        vec!["find", "placeholder", "한글 입력", "fill", "", "--exact"],
        vec!["find", "label", "한글 이름", "type", "한글 최종", "--exact"],
        vec!["find", "label", "주문", "fill", "주문 내용"],
        vec![
            "find",
            "role",
            "textbox",
            "fill",
            "새 본문",
            "--name",
            "Editor",
            "--exact",
        ],
        vec![
            "find",
            "role",
            "button",
            "click",
            "--name",
            "접근성 이름",
            "--exact",
        ],
        vec!["find", "text", "Save changes", "click", "--exact"],
        vec!["find", "label", "Check", "check", "--exact"],
        vec!["find", "label", "Check", "check", "--exact"],
        vec!["find", "label", "Check", "uncheck", "--exact"],
        vec!["find", "testid", "literal'[]", "click"],
        vec!["find", "alt", "Picture", "click", "--exact"],
        vec!["find", "first", ".order", "click"],
        vec!["find", "last", ".order", "click"],
        vec!["find", "nth", ".order", "click", "--index", "1"],
        vec!["find", "nth", ".order", "click", "--index", "-2"],
        vec!["find", "title", "Hover", "hover", "--exact"],
        vec!["find", "label", "한글 이름", "focus", "--exact"],
    ] {
        command(home, resource, page, epoch, &args).await?;
    }
    let effects = eval(home, resource, page, epoch, "({wrong,wanted,ariaClicks,compound,checkChanges,checked:document.querySelector('[type=checkbox]').checked,literal,images,order,hovers,markerWrites,field:document.querySelector('#field').value,area:document.querySelector('#area').value,editor:document.querySelector('[contenteditable]').textContent,focus:document.activeElement.id})").await?;
    println!("BROWSER_FIND_ACTION_EVIDENCE {effects}");
    require(
        effects["wrong"] == 0
            && effects["wanted"] == 1
            && effects["ariaClicks"] == 1
            && effects["compound"] == 1
            && effects["checkChanges"] == 2
            && effects["checked"] == false
            && effects["literal"] == 1
            && effects["images"] == 1
            && effects["order"] == json!([0, 2, 1, 1])
            && effects["hovers"].as_u64().is_some_and(|count| count >= 1)
            && effects["markerWrites"] == 0
            && effects["field"] == "한글 최종"
            && effects["area"] == "주문 내용"
            && effects["editor"] == "새 본문"
            && effects["focus"] == "field",
        &effects,
    )?;
    for (args, code) in [
        (
            vec!["find", "title", "Disabled", "click", "--exact"],
            "browser_element_disabled",
        ),
        (
            vec!["find", "title", "Absent", "click", "--exact"],
            "browser_element_not_found",
        ),
        (
            vec!["find", "nth", ".order", "click", "--index", "99"],
            "browser_element_not_found",
        ),
        (
            vec!["find", "first", "[", "click"],
            "browser_selector_invalid",
        ),
    ] {
        let result = command(home, resource, page, epoch, &args).await;
        require(
            result.as_ref().is_err_and(|error| error.contains(code)),
            &result,
        )?;
    }
    let retained = eval(
        home,
        resource,
        page,
        epoch,
        "({wrong,markerWrites,focus:document.activeElement.id})",
    )
    .await?;
    require(
        retained == json!({"wrong":0,"markerWrites":0,"focus":"field"}),
        &retained,
    )?;
    // Event handlers can invalidate a located node without changing its name.
    let hostile = r#"<input id=other value=Other><input title=Redirect value=Original onfocus="document.querySelector('#other').focus()">
      <button title=Replace onmouseenter="this.outerHTML='<button title=Replace onclick=window.replacementClicks++>Replacement</button>'" onclick="window.originalClicks++">Original</button>"#;
    eval(
        home,
        resource,
        page,
        epoch,
        &format!(
            "document.body.innerHTML={};window.originalClicks=0;window.replacementClicks=0",
            json!(hostile)
        ),
    )
    .await?;
    for args in [
        vec![
            "find",
            "title",
            "Redirect",
            "fill",
            "MUST NOT TYPE",
            "--exact",
        ],
        vec!["find", "title", "Replace", "click", "--exact"],
    ] {
        let rejected = command(home, resource, page, epoch, &args).await;
        require(rejected.is_err(), &rejected)?;
        let view = cli(home, &["show", resource]).await?;
        require(
            view["result"]["control"]["phase"] == "ready"
                && view["result"]["control"]["in_flight"].is_null(),
            &view,
        )?;
    }
    let guarded = eval(home, resource, page, epoch, "({other:document.querySelector('#other').value,original:document.querySelector('[title=Redirect]').value,originalClicks,replacementClicks})").await?;
    println!("BROWSER_FIND_TARGET_CHANGE_EVIDENCE {guarded}");
    require(
        guarded
            == json!({"other":"Other","original":"Original","originalClicks":0,"replacementClicks":0}),
        &guarded,
    )?;
    eval(home, resource, page, epoch, "document.body.innerHTML='<div id=shadow></div>';document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow input<input title=Shadow aria-label=Shadow></label><button title=ShadowButton onclick=window.shadowClicks++>Shadow button</button>';window.shadowClicks=0").await?;
    command(
        home,
        resource,
        page,
        epoch,
        &["find", "title", "Shadow", "fill", "그림자 입력", "--exact"],
    )
    .await?;
    command(
        home,
        resource,
        page,
        epoch,
        &[
            "find",
            "role",
            "button",
            "click",
            "--name",
            "Shadow button",
            "--exact",
        ],
    )
    .await?;
    let shadow = eval(home, resource, page, epoch, "({value:document.querySelector('#shadow').shadowRoot.querySelector('input').value,shadowClicks})").await?;
    println!("BROWSER_FIND_SHADOW_EVIDENCE {shadow}");
    require(
        shadow == json!({"value":"그림자 입력","shadowClicks":1}),
        &shadow,
    )?;
    Ok(())
}
