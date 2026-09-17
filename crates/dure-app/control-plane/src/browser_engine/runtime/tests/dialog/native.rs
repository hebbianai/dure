use super::*;

macro_rules! dialog_case {
    ($name:ident, $kind:literal, $accept:literal) => {
        #[tokio::test]
        #[ignore = "requires the pinned native engine and Chromium paths"]
        async fn $name() {
            exercise($kind, $accept).await;
        }
    };
}

dialog_case!(back_accepts_after_human_wait, "back", true);
dialog_case!(back_cancels_after_human_wait, "back", false);
dialog_case!(forward_accepts_after_human_wait, "forward", true);
dialog_case!(forward_cancels_after_human_wait, "forward", false);
dialog_case!(reload_accepts_after_human_wait, "reload", true);
dialog_case!(reload_cancels_after_human_wait, "reload", false);
dialog_case!(scroll_handler_retains_human_wait, "scroll", true);
dialog_case!(
    overridden_scroll_retains_human_wait,
    "scroll_override",
    true
);
dialog_case!(function_probe_retains_human_wait, "wait_function", true);
dialog_case!(
    function_poll_budget_excludes_human_wait,
    "wait_function_retry",
    true
);

async fn exercise(kind: &str, accept: bool) {
    let (runtime, identity, root) = super::authority::launch("dialog:native-consumer").await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<title>History fixture</title><button id=activate>Activate</button><div style='height:3000px'>Scrollable</div>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    println!(
        "BROWSER_NATIVE_DIALOG_START kind={kind} accept={accept} root={}",
        root.display()
    );
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        for route in ["first", "second"] {
            apply(&runtime, &lease, &first_page(&runtime).await?, json!({"kind":"navigate","url":format!("{base}/{route}")})).await?;
        }
        if kind == "forward" {
            apply(&runtime, &lease, &first_page(&runtime).await?, json!({"kind":"back"})).await?;
        }
        let page = first_page(&runtime).await?;
        let history = matches!(kind,"back"|"forward"|"reload");
        let script = if history {
            "window.calls=0;onbeforeunload=e=>{calls++;e.preventDefault();e.returnValue=''};true"
        } else {
            "window.calls=0;window.answers=[];window.ask=()=>{calls++;answers.push(prompt('Native consumer wait'));return true};true"
        };
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":script})).await?;
        apply(&runtime, &lease, &page, json!({"kind":"click","target":{"kind":"css","selector":"#activate"}})).await?;
        if kind == "scroll" {
            apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"onscroll=()=>{onscroll=null;ask()};true"})).await?;
        }
        if kind == "scroll_override" {
            apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.originalScroll=window.scrollBy;window.scrollBy=function(...args){ask();return originalScroll.apply(window,args)};true"})).await?;
        }
        let action = match kind {
            "scroll" | "scroll_override" => json!({"kind":"scroll","direction":"down","amount":300}),
            "wait_function" => json!({"kind":"wait_function","wait":{"expression":"ask()","timeout_ms":120000}}),
            "wait_function_retry" => json!({"kind":"wait_function","wait":{"expression":"(window.probes=(window.probes||0)+1,window.probes===1?(ask(),false):true)","timeout_ms":1000}}),
            _ => json!({"kind":kind}),
        };
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut observer = BrowserCdp::connect(&endpoint).await?;
        let session = observer.attach(target.as_str()).await?;
        observer.request("Page.enable", json!({}), Some(&session)).await?;
        let command = authority(&runtime, &lease, &page).await;
        let started = Instant::now();
        let (triggered, response) = tokio::join!(
            runtime.action(&lease.controller_id, &command, serde_json::from_value(action).unwrap()),
            async {
                let response: Result<_, BrowserRuntimeError> = async {
                    let opened = super::authority::pending(&runtime, &page).await?;
                    sleep(Duration::from_secs(32)).await;
                    let waiting = runtime.dialog(&page.page_id).await?;
                    let proposal = if history {
                        json!({"kind":if accept {"accept"} else {"dismiss"}})
                    } else { json!({"kind":"accept","text":"한글 응답"}) };
                    let answered = runtime.respond_dialog(&lease.controller_id, &authority(&runtime, &lease, &page).await,
                        &opened.dialog.as_ref().unwrap().identity, serde_json::from_value(proposal).unwrap()).await;
                    Ok((opened, waiting, answered))
                }.await;
                let cleanup = if !matches!(&response, Ok((_,_,Ok(_)))) {
                    Some(observer.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await)
                } else {None};
                (response, cleanup)
            }
        );
        let actual = observer.request("Runtime.evaluate",json!({"expression":"({url:location.href,calls:window.calls,answers:window.answers,scroll:scrollY,probes:window.probes})","returnByValue":true}),Some(&session)).await;
        observer.retire().await;
        let current = runtime.host.lock().await.page_identity(&page.page_id);
        Ok((started.elapsed(),page,current,triggered,response,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    server.abort();
    let _ = server.await;
    println!(
        "BROWSER_NATIVE_DIALOG kind={kind} accept={accept} root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (elapsed, page, current, triggered, (response, cleanup), actual) = evidence.unwrap();
    let (opened, waiting, answered) = response.unwrap();
    assert!(elapsed >= Duration::from_secs(32));
    assert_eq!(waiting.control.phase, BrowserResourcePhase::Ready);
    assert_eq!(waiting.dialog, opened.dialog);
    assert!(answered.is_ok(), "{answered:?}");
    assert!(cleanup.is_none(), "{cleanup:?}");
    let result = triggered.unwrap();
    assert!(result.response.success, "{result:?}");
    assert_eq!(result.control.phase, BrowserResourcePhase::Ready);
    let actual = actual.unwrap()["result"]["value"].clone();
    let current = current.unwrap();
    assert_eq!(current.page_id, page.page_id);
    if matches!(kind, "back" | "forward" | "reload") {
        let route = if (kind == "back" && accept) || (kind == "forward" && !accept) {
            "first"
        } else {
            "second"
        };
        assert_eq!(actual["url"], format!("{base}/{route}"));
        if accept {
            assert!(current.document_revision > page.document_revision);
        } else {
            assert_eq!(current, page);
            assert_eq!(actual["calls"], 1);
        }
    } else {
        assert_eq!(actual["calls"], 1);
        assert_eq!(actual["answers"], json!(["한글 응답"]));
        if matches!(kind, "scroll" | "scroll_override") {
            assert_eq!(actual["scroll"], 300);
        } else {
            assert_eq!(result.response.data["result"], true);
            if kind == "wait_function_retry" {
                assert_eq!(actual["probes"], 2);
            }
        }
    }
}
