#![cfg(unix)]

use dure_control_plane::browser_engine::{
    NativeBrowserEngineConfig,
    runtime::{BrowserRuntime, BrowserSnapshot},
};
use hmux_session_protocol::browser_resource::*;
use serde_json::{Value, json};
use std::path::Path;

struct Page {
    runtime: BrowserRuntime,
    identity: BrowserResourceIdentity,
    page: BrowserPageIdentity,
    lease: BrowserControllerLease,
}

impl Page {
    async fn launch() -> Self {
        let root = tempfile::Builder::new()
            .prefix("dure-reference-proof-")
            .tempdir_in("/tmp")
            .unwrap()
            .keep();
        let config = NativeBrowserEngineConfig::pinned(
            Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
            Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
        )
        .unwrap();
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("reference:test").unwrap(),
            generation: BrowserResourceGeneration::new("generation:test").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace:test").unwrap(),
        };
        let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
            .await
            .unwrap();
        let lease = runtime
            .request_control(BrowserControllerId::new("agent-proof").unwrap(), None)
            .await
            .unwrap()
            .controller
            .unwrap();
        let page = runtime.observe().await.unwrap().pages.remove(0).page;
        println!("BROWSER_REFERENCE_ROOT {}", root.display());
        Self {
            runtime,
            identity,
            page,
            lease,
        }
    }

    async fn act(&self, action: Value) -> Result<Value, String> {
        let sequence = self.runtime.control().await.next_command_sequence;
        let authority = BrowserActionAuthority {
            lease: self.lease.clone(),
            page: self.page.clone(),
            operation_id: BrowserOperationId::new(format!("step:{sequence}")).unwrap(),
            command_sequence: sequence,
        };
        let result = self
            .runtime
            .action(
                &self.lease.controller_id,
                &authority,
                serde_json::from_value(action).map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| format!("{error:?}"))?;
        if !result.response.success {
            return Err(format!("{:?}", result.response.error));
        }
        Ok(result.response.data)
    }

    async fn eval(&self, script: &str) -> Result<Value, String> {
        Ok(self.act(json!({"kind":"evaluate","script":script})).await?["result"].clone())
    }

    async fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        self.runtime
            .snapshot(&self.page, &Default::default())
            .await
            .map_err(|error| format!("{error:?}"))
    }

    async fn query(&self, kind: &str, target: Value) -> Result<Value, String> {
        let query = serde_json::from_value(json!({"kind":kind,"target":target})).unwrap();
        self.runtime
            .query(&self.page, &query)
            .await
            .map(|value| value["data"].clone())
            .map_err(|error| format!("{error:?}"))
    }

    async fn close(&self) {
        self.runtime.close(&self.identity).await.unwrap();
    }
}

fn target(snapshot: &BrowserSnapshot, name: &str) -> Result<Value, String> {
    let element = snapshot.data["refs"]
        .as_object()
        .ok_or("refs missing")?
        .iter()
        .find(|(_, value)| value["name"] == name)
        .ok_or_else(|| format!("missing {name}: {}", snapshot.data))?
        .0;
    Ok(json!({"kind":"reference","reference":{"snapshot":snapshot.snapshot,"element":element}}))
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn removed_snapshot_element_must_not_resolve_to_a_replacement() {
    let page = Page::launch().await;
    let evidence: Result<_, String> = async {
        page.eval("window.wrong=0;document.body.innerHTML='<button onclick=\"window.wrong+=100\">Upload</button>'").await?;
        let snapshot = page.snapshot().await?;
        let original = target(&snapshot, "Upload")?;
        page.eval("document.body.innerHTML='<button onclick=\"window.wrong++\">Upload</button>'").await?;
        let before_query = page.runtime.control().await;
        let query = page.query("text", original.clone()).await;
        let after_query = page.runtime.control().await;
        let click = page.act(json!({"kind":"click","target":original})).await;
        let wrong = page.eval("window.wrong").await?;
        Ok(json!({"click":click,"query":query,"queryUnchanged":before_query==after_query,
            "wrong":wrong,"phase":page.runtime.control().await.phase}))
    }.await;
    page.close().await;
    let evidence = evidence.unwrap();
    println!("BROWSER_STALE_ELEMENT_DIAGNOSIS {evidence}");
    assert_eq!(evidence["wrong"], 0);
    assert!(
        evidence["click"]["Err"]
            .as_str()
            .is_some_and(|error| error.contains("browser_element_changed"))
    );
    assert!(
        evidence["query"]["Err"]
            .as_str()
            .is_some_and(|error| error.contains("browser_element_changed"))
    );
    assert_eq!(evidence["queryUnchanged"], true);
    assert_eq!(evidence["phase"], "ready");
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn observed_nodes_survive_renaming_and_support_element_actions() {
    let page = Page::launch().await;
    let evidence: Result<_, String> = async {
        page.eval(r#"document.body.innerHTML=`
            <button id="original" onclick="window.originalClicks++" ondblclick="window.doubles++">Original</button>
            <input id="field" aria-label="Field" value="old">
            <input id="check" type="checkbox" aria-label="Check" onchange="window.checkChanges++">
            <select id="choice" aria-label="Choice" onchange="window.selectChanges++"><option value="one">One</option><option value="two">Two</option></select>
            <button id="hover" onmouseenter="window.hovers++">Hover</button>
            <div id="source" role="button" aria-label="Source" style="width:60px;height:60px;background:red" onmousedown="window.dragDown++">source</div>
            <div id="end" role="button" aria-label="End" style="margin-left:140px;width:60px;height:60px;background:blue" onmouseup="window.dragUp++">end</div>
            <div id="shadow"></div><button id="below" style="margin-top:1600px">Below</button>`;
            window.originalClicks=0;window.doubles=0;window.wrong=0;window.checkChanges=0;window.selectChanges=0;window.hovers=0;window.dragDown=0;window.dragUp=0;window.shadowClicks=0;
            shadow.attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow field"><button onclick="window.shadowClicks++">Shadow button</button>';
            document.addEventListener('mouseup',event=>window.lastButtons=event.buttons);
        "#).await?;
        let snapshot = page.snapshot().await?;
        let original = target(&snapshot, "Original")?;
        let mut forged = original.clone();
        forged["reference"]["element"] = json!("e9223372036854775807");
        let before_forged = page.runtime.control().await;
        let forged_result = page.act(json!({"kind":"click","target":forged.clone()})).await;
        let forged_unchanged = before_forged == page.runtime.control().await;
        let forged_drag = page.act(json!({"kind":"drag","source":original.clone(),"target":forged})).await;
        let forged_drag_unchanged = before_forged == page.runtime.control().await;
        page.eval("original.textContent='Renamed';document.body.insertAdjacentHTML('afterbegin','<button onclick=\"window.wrong++\">Original</button>');document.body.append(original)").await?;
        let renamed = page.query("text", original.clone()).await?;
        page.act(json!({"kind":"click","target":original.clone()})).await?;
        page.act(json!({"kind":"double_click","target":original})).await?;
        let field = target(&snapshot, "Field")?;
        page.act(json!({"kind":"fill","target":field.clone(),"text":"한글 원본"})).await?;
        page.act(json!({"kind":"select_all","target":field.clone()})).await?;
        let selection = page.eval("({start:field.selectionStart,end:field.selectionEnd,value:field.value})").await?;
        let value = page.query("value", field.clone()).await?;
        let enabled = page.query("enabled", field.clone()).await?;
        let html = page.query("html", field.clone()).await?;
        let visible = page.query("visible", field.clone()).await?;
        let bounds = page.query("box", field.clone()).await?;
        let styles = page.query("styles", field).await?;
        let check = target(&snapshot, "Check")?;
        page.act(json!({"kind":"check","target":check.clone()})).await?;
        let checked = page.query("checked", check.clone()).await?;
        page.act(json!({"kind":"uncheck","target":check})).await?;
        page.act(json!({"kind":"select","target":target(&snapshot,"Choice")?,"values":["Two"]})).await?;
        page.act(json!({"kind":"hover","target":target(&snapshot,"Hover")?})).await?;
        page.act(json!({"kind":"drag","source":target(&snapshot,"Source")?,"target":target(&snapshot,"End")?})).await?;
        page.act(json!({"kind":"fill","target":target(&snapshot,"Shadow field")?,"text":"그림자 원본"})).await?;
        page.act(json!({"kind":"click","target":target(&snapshot,"Shadow button")?})).await?;
        page.act(json!({"kind":"scroll_into_view","target":target(&snapshot,"Below")?})).await?;
        let state = page.eval("({originalClicks,doubles,wrong,checkChanges,selectChanges,hovers,dragDown,dragUp,lastButtons,shadowClicks,shadowValue:shadow.shadowRoot.querySelector('input').value,choice:choice.value,checked:check.checked,belowVisible:below.getBoundingClientRect().bottom<=innerHeight})").await?;
        Ok(json!({"state":state,"selection":selection,"renamed":renamed,"value":value,"enabled":enabled,"html":html,"visible":visible,"bounds":bounds,"styled":styles["styles"]["display"].is_string(),"checked":checked,"forged":forged_result,"forgedUnchanged":forged_unchanged,"forgedDrag":forged_drag,"forgedDragUnchanged":forged_drag_unchanged}))
    }.await;
    page.close().await;
    let evidence = evidence.unwrap();
    println!("BROWSER_REFERENCE_ACTIONS {evidence}");
    assert_eq!(evidence["renamed"]["text"], "Renamed");
    assert_eq!(
        evidence["state"],
        json!({"originalClicks":3,"doubles":1,"wrong":0,"checkChanges":2,"selectChanges":1,"hovers":1,"dragDown":1,"dragUp":1,"lastButtons":0,"shadowClicks":1,"shadowValue":"그림자 원본","choice":"two","checked":false,"belowVisible":true})
    );
    assert_eq!(
        evidence["selection"],
        json!({"start":0,"end":5,"value":"한글 원본"})
    );
    assert_eq!(evidence["value"]["value"], "한글 원본");
    assert_eq!(evidence["enabled"]["enabled"], true);
    assert_eq!(evidence["visible"]["visible"], true);
    assert_eq!(evidence["checked"]["checked"], true);
    assert!(
        evidence["bounds"]["width"]
            .as_f64()
            .is_some_and(|width| width > 0.0)
    );
    assert_eq!(evidence["styled"], true);
    assert_eq!(evidence["forgedUnchanged"], true);
    assert_eq!(evidence["forgedDragUnchanged"], true);
    assert!(
        evidence["forged"]["Err"]
            .as_str()
            .is_some_and(|error| error.contains("ElementNotObserved"))
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn replacement_during_a_gesture_never_receives_a_new_press() {
    let page = Page::launch().await;
    let evidence: Result<_, String> = async {
        page.eval(r#"window.originalClicks=0;window.wrong=0;window.downs=0;window.ups=0;window.lastButtons=0;
            document.body.innerHTML='<button id="original">Original</button><div id="source" role="button" aria-label="Source" style="width:60px;height:60px;background:red">source</div><div id="end" role="button" aria-label="End" style="margin-left:150px;width:80px;height:80px;background:blue">end</div>';
            original.onclick=()=>{window.originalClicks++;original.outerHTML='<button onclick="window.wrong++">Original</button>';};
            end.onmouseenter=()=>{end.outerHTML='<div id="replacement" role="button" aria-label="End" style="margin-left:150px;width:80px;height:80px;background:green" onmousedown="window.wrong++">end</div>';};
            document.addEventListener('mousedown',()=>window.downs++);
            document.addEventListener('mouseup',event=>{window.ups++;window.lastButtons=event.buttons;});
        "#).await?;
        let snapshot = page.snapshot().await?;
        let double_click = page.act(json!({"kind":"double_click","target":target(&snapshot,"Original")?})).await;
        let drag = page.act(json!({"kind":"drag","source":target(&snapshot,"Source")?,"target":target(&snapshot,"End")?})).await;
        let state = page.eval("({originalClicks,wrong,downs,ups,lastButtons})").await?;
        Ok(json!({"doubleClick":double_click,"drag":drag,"state":state,"phase":page.runtime.control().await.phase}))
    }.await;
    page.close().await;
    let evidence = evidence.unwrap();
    println!("BROWSER_REFERENCE_GESTURE_CHANGE {evidence}");
    for key in ["doubleClick", "drag"] {
        assert!(
            evidence[key]["Err"]
                .as_str()
                .is_some_and(|error| error.contains("browser_element_changed")),
            "{evidence}"
        );
    }
    assert_eq!(
        evidence["state"],
        json!({"originalClicks":1,"wrong":0,"downs":2,"ups":2,"lastButtons":0})
    );
    assert_eq!(evidence["phase"], "ready");
}
