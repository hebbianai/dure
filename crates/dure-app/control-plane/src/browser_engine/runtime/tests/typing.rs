use super::*;
use crate::browser_engine::cdp::BrowserCdp;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn selector_type_dispatches_controls_and_each_unicode_character() {
    prove_typing(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn keyboard_type_dispatches_controls_and_each_unicode_character() {
    prove_typing(false).await;
}

async fn prove_typing(selector: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-keyboard-type-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity = identity("typing:unicode");
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("typing-agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<form><input id=first><input id=second><button>Submit</button></form>';window.typedEvents=[];window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();submits++};for(const type of ['input','keydown','keyup'])document.addEventListener(type,e=>typedEvents.push({type,key:e.key,data:e.data,target:e.target.id,trusted:e.isTrusted}));document.querySelector('#first').focus();true"})).await?;
        let text = "한글🦉\tB\n";
        let action = if selector {
            json!({"kind":"find","locator":{"kind":"nth","selector":"#first","index":0},"action":{"kind":"type","text":text}})
        } else {
            json!({"kind":"type_text","text":text})
        };
        let action = serde_json::from_value(action).map_err(|_|"typing_fixture_action_invalid")?;
        let result = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,action).await?;
        if !result.response.success { return Err("typing_fixture_command_failed".into()); }
        let state = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"({first:document.querySelector('#first').value,second:document.querySelector('#second').value,submits,events:typedEvents})"})).await?["result"].clone();
        let control = runtime.control().await;
        if control.controller.as_ref()!=Some(&lease) || control.keyboard.is_some() { return Err("typing_fixture_control_changed".into()); }
        Ok(state)
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_TYPING selector={selector} root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let state = evidence.unwrap();
    assert_eq!(state["first"], "한글🦉", "{state}");
    assert_eq!(state["second"], "B", "{state}");
    assert_eq!(state["submits"], 1, "{state}");
    let events = state["events"].as_array().unwrap();
    assert!(events.iter().all(|event| event["trusted"] == true));
    let inserted: Vec<_> = events
        .iter()
        .filter(|event| event["type"] == "input")
        .map(|event| event["data"].clone())
        .collect();
    assert_eq!(
        inserted,
        vec![json!("한"), json!("글"), json!("🦉"), json!("B")]
    );
    let keys: Vec<_> = events
        .iter()
        .filter(|event| event["type"] != "input")
        .map(|event| json!([event["type"], event["key"]]))
        .collect();
    assert_eq!(
        keys,
        vec![
            json!(["keydown", "Tab"]),
            json!(["keyup", "Tab"]),
            json!(["keydown", "Enter"]),
            json!(["keyup", "Enter"])
        ]
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn typing_follows_focus_after_dom_replacement() {
    interrupted(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium"]
async fn cancelled_typing_fences_partial_input_without_repeating_it() {
    interrupted(true).await;
}

async fn interrupted(cancelled: bool) {
    let root = tempfile::Builder::new()
        .prefix("dure-typing-interrupted-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let identity = identity("typing:interrupted");
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let handler = if cancelled {
            "window.calls++;prompt('typing paused')"
        } else {
            "document.open();document.write('<input id=replacement>');document.close();document.querySelector('#replacement').focus()"
        };
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":format!("document.body.innerHTML='<input id=field>';window.calls=0;document.querySelector('#field').oninput=()=>{{{handler}}};document.querySelector('#field').focus();true")})).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable",json!({}),Some(&session)).await?;
        let command = authority(&runtime,&lease,&page).await;
        let action = serde_json::from_value(json!({"kind":"type_text","text":"한남은"})).map_err(|_| "typing_fixture_action_invalid")?;
        let mut typing = Box::pin(runtime.action(&lease.controller_id,&command,action));
        let result = if cancelled {
            tokio::select! {
                result = &mut typing => return Err(if result.is_ok() { "typing_fixture_finished_before_prompt" } else { "typing_fixture_failed_before_prompt" }.into()),
                pending = timeout(Duration::from_secs(3),async {
                    loop {
                        if runtime.dialog(&page.page_id).await?.dialog.is_some() { return Ok::<_,BrowserRuntimeError>(()); }
                        sleep(Duration::from_millis(10)).await;
                    }
                }) => pending.map_err(|_| "typing_fixture_prompt_timeout")??,
            }
            drop(typing);
            timeout(Duration::from_secs(3),async {
                loop {
                    let changed = runtime.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    if runtime.control().await.phase == BrowserResourcePhase::OutcomeUnknown { return; }
                    changed.await;
                }
            }).await.map_err(|_| "typing_fixture_cancellation_not_fenced")?;
            observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await?;
            None
        } else {
            Some(typing.await?)
        };
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({value:document.querySelector('input').value,calls:window.calls,replaced:!!document.querySelector('#replacement')})","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        let control = runtime.control().await;
        let replay = runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"type_text","text":"한남은"})).unwrap()).await;
        Ok((result,actual?,control,replay))
    }.await;
    let closed = runtime.close(&identity).await;
    println!(
        "BROWSER_TYPING_INTERRUPTED cancelled={cancelled} root={} evidence={evidence:?} closed={closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    let (result, actual, control, replay) = evidence.unwrap();
    let actual = &actual["result"]["value"];
    assert!(replay.is_err(), "{replay:?}");
    if cancelled {
        assert_eq!(control.phase, BrowserResourcePhase::OutcomeUnknown);
        assert!(control.in_flight.is_some());
        assert_eq!(actual["value"], "한");
        assert_eq!(actual["calls"], 1);
    } else {
        let result = result.unwrap();
        // Replacing markup and moving focus does not navigate this page.
        // Remaining characters follow the newly focused input, as Tab does.
        assert!(result.response.success, "{result:?}");
        assert_eq!(actual["replaced"], true);
        assert_eq!(actual["value"], "남은");
        assert_eq!(control.phase, BrowserResourcePhase::Ready);
        assert!(control.in_flight.is_none());
    }
}
