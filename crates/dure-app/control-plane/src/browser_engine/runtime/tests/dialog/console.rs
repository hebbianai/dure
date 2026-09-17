use super::*;
use hmux_session_protocol::browser_console::BrowserConsoleQuery;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn closing_a_logged_frame_context_does_not_retire_console_observation() {
    let (runtime, identity, root) = super::authority::launch("console:context-close").await;
    println!("BROWSER_CONSOLE_CONTEXT_OWNED root={}", root.display());
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let action: BrowserAction = serde_json::from_value(json!({"kind":"evaluate","script":r#"
new Promise(resolve=>{
  const frame=document.createElement('iframe');
  frame.onload=()=>{frame.contentWindow.console.log('retired frame',{value:'한글'});frame.remove();resolve(true)};
  frame.srcdoc='<title>Ephemeral console context</title>';document.body.append(frame);
})
"#})).map_err(|_|BrowserRuntimeError::Observation("fixture_action_invalid"))?;
        let applied = runtime.action(&lease.controller_id,&authority(&runtime,&lease,&page).await,action).await;
        let observed = runtime.console(&identity,&page.page_id,Default::default()).await;
        let later = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"console.log('still observing');true"})).await;
        let remaining = runtime.console(&identity,&page.page_id,Default::default()).await;
        Ok((applied,observed,later,remaining))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_CONSOLE_CONTEXT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (applied, observed, later, remaining) = evidence.unwrap();
    applied.unwrap();
    assert!(
        observed
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.text.starts_with("retired frame"))
    );
    later.unwrap();
    assert!(
        remaining
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.text == "still observing")
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn console_mirror_and_node_group_cleanup_release_real_chromium_handles() {
    let (runtime, identity, root) = super::authority::launch("console:objects").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let mut cdp = runtime
            .execution_for_target(&target)
            .await?
            .renderer_cdp(runtime.test_binding().cdp.clone(), target.clone());
        let session = cdp.attach(target.as_str()).await?;
        let mut cases = Vec::new();
        for group_owned in [true, false] {
            let group = cdp.object_group(&session)?;
            let created = cdp
                .request(
                    "Runtime.evaluate",
                    json!({"expression":"({proof:'한글'})","objectGroup":group.name()}),
                    Some(&session),
                )
                .await?;
            let object = created["result"]["objectId"]
                .as_str()
                .ok_or("fixture_object_missing")?;
            let before = cdp
                .request(
                    "Runtime.getProperties",
                    json!({"objectId":object,"ownProperties":true}),
                    Some(&session),
                )
                .await?;
            if group_owned {
                drop(group);
            } else {
                cdp.release_objects(
                    session.clone(),
                    vec![object.to_owned()],
                    std::future::pending(),
                    || async { Ok(true) },
                )?;
                // Keep the group alive until the exact mirror is proved gone.
                let gone = timeout(Duration::from_secs(2), async {
                    loop {
                        let read = cdp
                            .request(
                                "Runtime.getProperties",
                                json!({"objectId":object,"ownProperties":true}),
                                Some(&session),
                            )
                            .await;
                        if read.is_err() {
                            break read;
                        }
                        sleep(Duration::from_millis(5)).await;
                    }
                })
                .await;
                cases.push((group_owned, before, gone));
                drop(group);
                continue;
            }
            let gone = timeout(Duration::from_secs(2), async {
                loop {
                    let read = cdp
                        .request(
                            "Runtime.getProperties",
                            json!({"objectId":object,"ownProperties":true}),
                            Some(&session),
                        )
                        .await;
                    if read.is_err() {
                        break read;
                    }
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await;
            cases.push((group_owned, before, gone));
        }
        // A rejected read of the released handle does not retire this healthy
        // connection; retirement cannot masquerade as successful object release.
        let alive = cdp
            .request("Runtime.getIsolateId", json!({}), Some(&session))
            .await;
        Ok((cases, alive))
    }
    .await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_CONSOLE_OBJECTS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (cases, alive) = evidence.unwrap();
    alive.unwrap();
    assert_eq!(cases.len(), 2);
    for (_, before, gone) in cases {
        assert!(before["result"].as_array().unwrap().iter().any(|property|property["name"] == "proof" && property["value"]["value"] == "한글"));
        assert!(
            matches!(gone, Ok(Err("browser_cdp_request_rejected"))),
            "{gone:?}"
        );
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn console_frames_workers_navigation_and_pages_keep_passive_source_attribution() {
    let (runtime, identity, root) = super::authority::launch("console:sources").await;
    println!(
        "BROWSER_CONSOLE_OWNED resource={identity:?} root={}",
        root.display()
    );
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":r#"
window.consoleGetterCalls=0;
console.log('main 한글',Object.defineProperty({},'secret',{get(){consoleGetterCalls++;return 'private'}}));
Promise.all([
  new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=resolve;frame.srcdoc='<script>console.info("frame 한글")<\/script>';document.body.append(frame)}),
  new Promise(resolve=>{window.worker=new Worker(URL.createObjectURL(new Blob(['console.warn("worker 한글");postMessage("ready");'],{type:'text/javascript'})));worker.onmessage=resolve})
]).then(()=>true)
"#})).await?;
        let before = runtime.control().await;
        let logs = runtime.console(&identity,&page.page_id,Default::default()).await?;
        let after = runtime.control().await;
        let getters = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"consoleGetterCalls"})).await?;
        apply(&runtime,&lease,&page,json!({"kind":"new_page","url":"about:blank"})).await?;
        let other = runtime.observe().await?.pages.into_iter().find(|entry|entry.page.page_id != page.page_id).unwrap().page;
        apply(&runtime,&lease,&other,json!({"kind":"evaluate","script":"console.log('other page');true"})).await?;
        let separate = runtime.console(&identity,&other.page_id,Default::default()).await?;
        let original = runtime.console(&identity,&page.page_id,Default::default()).await?;
        apply(&runtime,&lease,&page,json!({"kind":"navigate","url":"about:blank"})).await?;
        let across = runtime.console(&identity,&page.page_id,Default::default()).await?;
        Ok((logs,before,after,getters,separate,original,across))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_CONSOLE_SOURCES root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (logs, before, after, getters, separate, original, across) = evidence.unwrap();
    assert_eq!(before, after);
    assert_eq!(getters["result"], 0);
    let main = logs
        .entries
        .iter()
        .find(|entry| entry.text.starts_with("main 한글"))
        .unwrap();
    let frame = logs
        .entries
        .iter()
        .find(|entry| entry.text == "frame 한글")
        .unwrap();
    let worker = logs
        .entries
        .iter()
        .find(|entry| entry.text == "worker 한글")
        .unwrap();
    assert_eq!(frame.level, "info");
    assert_eq!(worker.level, "warning");
    assert_ne!(main.source, worker.source);
    assert_eq!(separate.entries.len(), 1);
    assert_eq!(separate.entries[0].text, "other page");
    assert_eq!(original.entries.len(), logs.entries.len());
    assert!(across.page.document_revision > original.page.document_revision);
    assert_eq!(
        serde_json::to_value(across.entries).unwrap(),
        serde_json::to_value(original.entries).unwrap()
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn console_read_and_clear_finish_while_human_prompt_and_object_cleanup_are_pending() {
    let (runtime, identity, root) = super::authority::launch("console:prompt").await;
    println!(
        "BROWSER_CONSOLE_OWNED resource={identity:?} root={}",
        root.display()
    );
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable",json!({}),Some(&session)).await?;
        observer.request("Runtime.evaluate",json!({"expression":"window.answers=0;setTimeout(()=>{console.log('before prompt',{value:'한글'});window.answer=prompt('Console human wait');answers++;console.log('after prompt')},0);true","returnByValue":true}),Some(&session)).await?;
        let opened = super::authority::pending(&runtime,&page).await?;
        let before = runtime.control().await;
        let started = Instant::now();
        let logs = timeout(Duration::from_secs(2),runtime.console(&identity,&page.page_id,BrowserConsoleQuery::default())).await;
        let after = runtime.control().await;
        let clear_authority = authority(&runtime,&lease,&page).await;
        let clear = timeout(Duration::from_secs(2),runtime.action(&lease.controller_id,&clear_authority,serde_json::from_value(json!({"kind":"console_clear"})).unwrap())).await;
        let empty = timeout(Duration::from_secs(2),runtime.console(&identity,&page.page_id,Default::default())).await;
        let still_open = runtime.dialog(&page.page_id).await;
        let elapsed = started.elapsed();
        let answered = runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&opened.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"한글 답"})).unwrap()).await;
        let cleanup = if answered.is_err() {Some(observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await)} else {None};
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({answers,answer})","returnByValue":true}),Some(&session)).await;
        let remaining = runtime.console(&identity,&page.page_id,Default::default()).await;
        observer.retire().await;
        Ok((logs,before,after,clear,empty,still_open,elapsed,answered,cleanup,actual,remaining))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_CONSOLE_PROMPT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (
        logs,
        before,
        after,
        clear,
        empty,
        still_open,
        elapsed,
        answered,
        cleanup,
        actual,
        remaining,
    ) = evidence.unwrap();
    assert_eq!(before, after);
    assert!(
        logs.unwrap()
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.text.starts_with("before prompt"))
    );
    let clear = clear.unwrap().unwrap();
    assert!(clear.response.success && clear.observation.is_none());
    assert!(empty.unwrap().unwrap().entries.is_empty());
    assert!(still_open.unwrap().dialog.is_some());
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    answered.unwrap();
    assert!(cleanup.is_none());
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answers":1,"answer":"한글 답"})
    );
    assert_eq!(remaining.unwrap().entries[0].text, "after prompt");
}
