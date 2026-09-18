use super::*;
mod boundaries;
mod loading;
mod shadow;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn condition_waits_do_not_invoke_page_getters_or_functions() {
    let (runtime, identity, root) = super::authority::launch("wait:isolated").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":r#"
document.body.innerHTML='<div id=shown>한글 준비</div><div id=hidden hidden>Hidden</div>';window.waitCalls=[];
for(const [owner,key] of [[Document.prototype,'querySelector'],[Document.prototype,'evaluate'],[Element.prototype,'getBoundingClientRect'],[window,'getComputedStyle']]) {
  const original=owner[key];owner[key]=function(...args){waitCalls.push(key);return original.apply(this,args)};
}
for(const [owner,key] of [[HTMLElement.prototype,'innerText'],[Document.prototype,'readyState']]) {
  const descriptor=Object.getOwnPropertyDescriptor(owner,key);Object.defineProperty(owner,key,{...descriptor,get(){waitCalls.push(key);return descriptor.get.call(this)}});
}
true
"#})).await?;
        let before = runtime.control().await;
        let mut results = Vec::new();
        for (selector,state) in [("#shown","attached"),("#shown","visible"),("#hidden","hidden"),("#absent","detached")] {
            results.push(runtime.wait(&page,&serde_json::from_value(json!({"condition":{"kind":"selector","target":{"kind":"css","selector":selector},"state":state},"timeout_ms":1000})).unwrap()).await);
        }
        for condition in [json!({"kind":"text","text":"한글 준비"}),json!({"kind":"load","state":"domcontentloaded"}),json!({"kind":"load","state":"load"}),json!({"kind":"url","pattern":"about:blank"})] {
            results.push(runtime.wait(&page,&serde_json::from_value(json!({"condition":condition,"timeout_ms":1000})).unwrap()).await);
        }
        let after = runtime.control().await;
        let calls = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"waitCalls"})).await?;
        Ok((results,calls,before,after))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_WAIT_ISOLATED root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (results, calls, before, after) = evidence.unwrap();
    for result in results {
        assert_eq!(result.unwrap()["waited"], true);
    }
    assert_eq!(calls["result"], json!([]), "{calls:?}");
    assert_eq!(before, after);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn selector_wait_keeps_its_budget_after_a_human_dialog() {
    exercise("selector").await;
}
#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn text_wait_keeps_its_budget_after_a_human_dialog() {
    exercise("text").await;
}
#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn url_wait_keeps_its_budget_after_a_human_dialog() {
    exercise("url").await;
}
#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn literal_duration_finishes_while_a_human_dialog_is_still_open() {
    exercise("duration").await;
}
#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn network_snapshot_retains_the_requested_pages_human_wait() {
    exercise("network").await;
}

async fn exercise(kind: &str) {
    let (runtime, identity, root) = super::authority::launch("wait:dialog").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable",json!({}),Some(&session)).await?;
        observer.request("Runtime.evaluate",json!({"expression":"window.waitReady=new Promise(resolve=>setTimeout(()=>{window.answer=prompt('Condition wait');setTimeout(()=>{document.body.innerHTML='<div id=ready>한글 준비</div>';location.hash='ready';resolve(true)},250)},0));true","returnByValue":true}),Some(&session)).await?;
        let opened = super::authority::pending(&runtime,&page).await?;
        let condition = match kind {
            "selector" => json!({"kind":"selector","target":{"kind":"css","selector":"#ready"},"state":"attached"}),
            "text" => json!({"kind":"text","text":"한글 준비"}),
            "url" => json!({"kind":"url","pattern":"**#ready"}),
            _ => json!({"kind":"duration"}),
        };
        let (waited,answered) = tokio::join!(
            async {
                let started = Instant::now();
                let result = if kind == "network" {
                    async { runtime.execution(&page).await?.network_snapshot(&page).await }.await.map(|value|serde_json::to_value(value).unwrap())
                } else {
                    runtime.wait(&page,&serde_json::from_value(json!({"condition":condition,"timeout_ms":if kind=="duration" {100} else {1000}})).unwrap()).await
                };
                (result,started.elapsed(),runtime.dialog(&page.page_id).await)
            },
            async {
                sleep(Duration::from_secs(8)).await;
                runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&opened.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"한글 응답"})).unwrap()).await
            }
        );
        let cleanup = if answered.is_err() {Some(observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await)} else {None};
        let actual = observer.request("Runtime.evaluate",json!({"expression":"waitReady.then(()=>answer)","returnByValue":true,"awaitPromise":true}),Some(&session)).await;
        observer.retire().await;
        Ok((waited,answered,cleanup,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_WAIT_DIALOG kind={kind} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let ((waited, elapsed, dialog), answered, cleanup, actual) = evidence.unwrap();
    answered.unwrap();
    assert!(cleanup.is_none(), "{cleanup:?}");
    assert_eq!(actual.unwrap()["result"]["value"], "한글 응답");
    let waited = waited.unwrap();
    if kind == "network" {
        assert_eq!(waited["complete"], true);
    } else {
        assert_eq!(waited["waited"], true);
    }
    if kind == "duration" {
        assert!(
            elapsed >= Duration::from_millis(100) && elapsed < Duration::from_secs(1),
            "{elapsed:?}"
        );
        assert!(dialog.unwrap().dialog.is_some());
    } else {
        assert!(
            elapsed >= Duration::from_secs(8) && elapsed < Duration::from_secs(10),
            "{elapsed:?}"
        );
        assert!(dialog.unwrap().dialog.is_none());
    }
}
