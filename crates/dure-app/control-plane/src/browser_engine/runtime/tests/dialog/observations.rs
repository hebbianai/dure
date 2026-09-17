use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn built_in_queries_share_isolated_node_semantics_without_page_callbacks() {
    let (runtime, identity, root) = super::authority::launch("observation:isolated").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.title='Observation';document.body.innerHTML='<input id=observed aria-label=Observed value=한글 data-proof=kept type=checkbox checked style=\"color:rgb(12,34,56)\"><button id=label>Visible<span hidden>Hidden</span></button>';true"})).await?;
        let snapshot = runtime.snapshot(&page, &Default::default()).await?;
        let refs = snapshot.data["refs"].as_object().unwrap();
        let reference = |name| {
            let element = refs.iter().find(|(_, data)| data["name"] == name).unwrap().0;
            json!({"kind":"reference","reference":{"snapshot":snapshot.snapshot,"element":element}})
        };
        let field = reference("Observed");
        let label = reference("Visible");
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":r#"
window.observerCalls=[];
for(const [prototype,key] of [[Node.prototype,'textContent'],[HTMLElement.prototype,'innerText'],[Element.prototype,'innerHTML'],[HTMLInputElement.prototype,'value'],[HTMLInputElement.prototype,'checked'],[HTMLInputElement.prototype,'disabled'],[Document.prototype,'title']]) {
  const descriptor=Object.getOwnPropertyDescriptor(prototype,key);
  Object.defineProperty(prototype,key,{...descriptor,get(){observerCalls.push(key);return descriptor.get.call(this)}});
}
for(const [owner,key] of [[Document.prototype,'querySelector'],[Document.prototype,'querySelectorAll'],[Document.prototype,'evaluate'],[Element.prototype,'getAttribute'],[Element.prototype,'getBoundingClientRect'],[window,'getComputedStyle']]) {
  const original=owner[key];owner[key]=function(...args){observerCalls.push(key);return original.apply(this,args)};
}
true
"#})).await?;
        let before = runtime.control().await;
        let mut results = Vec::new();
        for kind in ["text","html","value","attribute","box","styles","visible","enabled","checked"] {
            let text = matches!(kind,"text"|"html");
            for target in [json!({"kind":"css","selector":if text {"#label"} else {"#observed"}}), if text {label.clone()} else {field.clone()}] {
                let mut query = json!({"kind":kind,"target":target});
                if kind == "attribute" {query["name"]=json!("data-proof");}
                results.push((kind.to_owned(), runtime.query(&page,&serde_json::from_value(query).unwrap()).await));
            }
        }
        for query in [json!({"kind":"count","target":{"kind":"css","selector":"input"}}),json!({"kind":"count","target":{"kind":"css","selector":"xpath=//input"}}),json!({"kind":"value","target":{"kind":"css","selector":"xpath=//input"}}),json!({"kind":"title"}),json!({"kind":"url"})] {
            results.push((query["kind"].as_str().unwrap().to_owned(),runtime.query(&page,&serde_json::from_value(query).unwrap()).await));
        }
        let after = runtime.control().await;
        let calls = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"observerCalls"})).await?;
        Ok((results,calls,before,after))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_OBSERVER_ISOLATED root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (results, calls, before, after) = evidence.unwrap();
    assert_eq!(
        calls["result"],
        json!([]),
        "built-in reads executed page callbacks: {calls:?}"
    );
    assert_eq!(before, after);
    for (kind, result) in results {
        let result = result.unwrap()["data"].clone();
        match kind.as_str() {
            "text" => assert_eq!(result["text"], "Visible"),
            "html" => assert_eq!(result["html"], "Visible<span hidden=\"\">Hidden</span>"),
            "value" => assert_eq!(result["value"], "한글"),
            "attribute" => assert_eq!(result["value"], "kept"),
            "styles" => assert_eq!(result["styles"]["color"], "rgb(12, 34, 56)"),
            "box" => assert!(result["width"].as_f64().is_some_and(|width| width > 0.0)),
            "visible" | "enabled" | "checked" => assert_eq!(result[&kind], true),
            "count" => assert_eq!(result["count"], 1),
            "title" => assert_eq!(result["title"], "Observation"),
            "url" => assert_eq!(result["url"], "about:blank"),
            _ => unreachable!(),
        }
    }
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn css_query_resumes_after_observed_human_dialog_wait() {
    exercise("css").await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn reference_query_resumes_after_observed_human_dialog_wait() {
    exercise("reference").await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn snapshot_resumes_after_observed_human_dialog_wait() {
    exercise("snapshot").await;
}

async fn exercise(kind: &str) {
    let (runtime, identity, root) = super::authority::launch("observation:dialog").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"document.body.innerHTML='<input id=observed aria-label=Observed value=before>';window.answers=0;true"})).await?;
        let snapshot = runtime.snapshot(&page, &Default::default()).await?;
        let element = snapshot.data["refs"].as_object().unwrap().iter().find(|(_, data)| data["name"] == "Observed").unwrap().0;
        let reference = json!({"kind":"reference","reference":{"snapshot":snapshot.snapshot,"element":element}});
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        observer.request("Runtime.evaluate", json!({"expression":"setTimeout(()=>{const answer=prompt('Observer human wait');window.answers++;document.querySelector('#observed').value=answer},0);true","returnByValue":true}), Some(&session)).await?;
        let opened = super::authority::pending(&runtime, &page).await?;
        let before = runtime.control().await;
        let started = Instant::now();
        let (observed, answered) = tokio::join!(
            async {
                if kind == "snapshot" { return runtime.snapshot(&page, &Default::default()).await.map(|value|value.data); }
                runtime.query(&page, &serde_json::from_value(json!({"kind":"value","target":if kind == "reference" {reference} else {json!({"kind":"css","selector":"#observed"})}})).unwrap()).await
            },
            async {
                sleep(Duration::from_secs(8)).await;
                runtime.respond_dialog(&lease.controller_id, &authority(&runtime, &lease, &page).await,
                    &opened.dialog.unwrap().identity, serde_json::from_value(json!({"kind":"accept","text":"한글 관찰"})).unwrap()).await
            }
        );
        let elapsed = started.elapsed();
        let cleanup = if answered.is_err() { Some(observer.request("Page.handleJavaScriptDialog", json!({"accept":false}), Some(&session)).await) } else { None };
        let actual = observer.request("Runtime.evaluate", json!({"expression":"({answers,value:document.querySelector('#observed').value})","returnByValue":true}), Some(&session)).await;
        observer.retire().await;
        Ok((observed,answered,elapsed,cleanup,actual,before,runtime.control().await))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_OBSERVER_DIALOG kind={kind} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (observed, answered, elapsed, cleanup, actual, before, after) = evidence.unwrap();
    let answered = answered.unwrap();
    assert!(cleanup.is_none(), "{cleanup:?}");
    let observed = observed.unwrap();
    if kind == "snapshot" {
        assert!(
            observed["snapshot"].as_str().unwrap().contains("한글 관찰"),
            "{observed:?}"
        );
    } else {
        assert_eq!(observed["data"]["value"], "한글 관찰");
    }
    assert_eq!(
        actual.unwrap()["result"]["value"],
        json!({"answers":1,"value":"한글 관찰"})
    );
    assert!(
        elapsed >= Duration::from_secs(8) && elapsed < Duration::from_secs(11),
        "{elapsed:?}"
    );
    assert_eq!(after.phase, BrowserResourcePhase::Ready);
    assert_eq!(after.controller, before.controller);
    assert_eq!(
        answered.control.next_command_sequence.get(),
        before.next_command_sequence.get() + 1
    );
    assert_eq!(
        after.next_command_sequence,
        answered.control.next_command_sequence
    );
    assert!(after.in_flight.is_none() && after.dialog_response.is_none());
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn observer_loss_ends_a_dialog_suspended_query() {
    lost_observation(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn resource_retirement_ends_a_dialog_suspended_query() {
    lost_observation(true).await;
}

async fn lost_observation(retiring: bool) {
    let (runtime, identity, root) = super::authority::launch("observation:loss").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable",json!({}),Some(&session)).await?;
        observer.request("Runtime.evaluate",json!({"expression":"setTimeout(()=>prompt('Observer lifetime'),0);true","returnByValue":true}),Some(&session)).await?;
        super::authority::pending(&runtime,&page).await?;
        let query = serde_json::from_value(json!({"kind":"title"})).unwrap();
        let observed = runtime.query(&page,&query);
        tokio::pin!(observed);
        let pending = timeout(Duration::from_millis(250),observed.as_mut()).await;
        if retiring { runtime.begin_retirement(&identity).await?; } else { runtime.test_binding().events.close().await; }
        let ended = timeout(Duration::from_secs(2),observed).await;
        let cleanup = observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await;
        observer.retire().await;
        Ok((pending,ended,cleanup))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_OBSERVER_LIFETIME retiring={retiring} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (pending, ended, cleanup) = evidence.unwrap();
    assert!(pending.is_err(), "{pending:?}");
    assert!(matches!(ended, Ok(Err(_))), "{ended:?}");
    cleanup.unwrap();
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn xpath_queries_and_actions_use_the_same_isolated_selector() {
    let (runtime, identity, root) = super::authority::launch("observation:xpath").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"window.hits=[];document.body.innerHTML='<button onclick=hits.push(1)>First</button><button onclick=hits.push(2)>Second</button>';true"})).await?;
        let query = runtime.query(&page,&serde_json::from_value(json!({"kind":"text","target":{"kind":"css","selector":"xpath=(//button)[2]"}})).unwrap()).await?;
        let clicked = apply(&runtime,&lease,&page,json!({"kind":"click","target":{"kind":"css","selector":"xpath=(//button)[2]"}})).await;
        let actual = apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"hits"})).await?;
        Ok((query,clicked,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_OBSERVER_XPATH root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (query, clicked, actual) = evidence.unwrap();
    assert_eq!(query["data"]["text"], "Second");
    clicked.unwrap();
    assert_eq!(actual["result"], json!([2]));
}
