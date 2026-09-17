use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn push_state_preserves_document_refs_router_receiver_and_resource_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = "<!doctype html><meta charset=utf-8><link rel=icon href=data:,><button onclick='window.clicks++'>Increment</button><input value=한글><script>window.clicks=0;window.originalDocument=document;window.originalInput=document.querySelector('input');window.historyEvents=[];addEventListener('popstate',e=>historyEvents.push(['popstate',e.state]));addEventListener('navigate',()=>historyEvents.push(['navigate']));</script>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-pushstate-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("history:owner");
    let launched = BrowserRuntime::launch(resource.clone(), &config, &root).await;
    let runtime = match launched {
        Ok(runtime) => runtime,
        Err(error) => {
            server.abort();
            let _ = server.await;
            panic!("{error:?}");
        }
    };
    let mut peer = None;
    let evidence: Result<_, BrowserRuntimeError> = async {
        peer = Some(runtime.share_instance(identity("history:peer")).await?);
        let peer = peer.as_ref().ok_or("fixture_peer_missing")?;
        let peer_before = serde_json::to_value(peer.observe().await?).unwrap();
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.ok_or("fixture_lease_missing")?;
        apply(&runtime, &lease, &first_page(&runtime).await?, json!({"kind":"navigate","url":format!("{origin}/start")})).await?;
        let page = first_page(&runtime).await?;
        let snapshot = runtime.snapshot(&page, &Default::default()).await?;
        let reference = click_reference(&snapshot)?;
        let before = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"({url:location.href,length:history.length})"})).await?;
        let proposal = authority(&runtime, &lease, &page).await;
        let action = json!({"kind":"push_state","url":"../next?lang=ko#section"});
        let pushed = runtime.action(&lease.controller_id, &proposal, serde_json::from_value(action.clone()).unwrap()).await?;
        let repeated = runtime.action(&lease.controller_id, &proposal, serde_json::from_value(action).unwrap()).await;
        let same_page = first_page(&runtime).await?;
        // A same-document URL mutation must leave the existing bound node usable.
        let clicked = apply(&runtime, &lease, &page, json!({"kind":"click","target":{"kind":"reference","reference":reference}})).await?;
        let after = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"({url:location.href,length:history.length,events:historyEvents,clicks,sameDocument:document===originalDocument,sameInput:document.querySelector('input')===originalInput,value:originalInput.value})"})).await?;
        let noop = apply(&runtime, &lease, &page, json!({"kind":"push_state","url":format!("{origin}/next?lang=ko#section")})).await?;
        let after_noop = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"({length:history.length,events:historyEvents})"})).await?;
        let back = apply(&runtime, &lease, &page, json!({"kind":"back"})).await?;
        let forward = apply(&runtime, &lease, &page, json!({"kind":"forward"})).await?;
        // A collaborator method must retain its receiver. A detached call would
        // throw and incorrectly take the generic history path instead.
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.routerCalls=[];window.next={router:{push(url){if(this!==window.next.router)throw Error('receiver lost');routerCalls.push(url);history.pushState({router:true},'',url)}}};historyEvents=[];true"})).await?;
        let router = apply(&runtime, &lease, &page, json!({"kind":"push_state","url":"/router"})).await?;
        let routed = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"({calls:routerCalls,events:historyEvents,state:history.state})"})).await?;
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"next.router.push=function(){throw Error('router unavailable')};true"})).await?;
        let fallback = apply(&runtime, &lease, &page, json!({"kind":"push_state","url":"/fallback"})).await?;
        let fallback_events = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"historyEvents"})).await?;
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"delete window.next;true"})).await?;
        let rejected = runtime.action(&lease.controller_id, &authority(&runtime, &lease, &page).await, serde_json::from_value(json!({"kind":"push_state","url":"https://different.invalid/path"})).unwrap()).await?;
        let after_rejected = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"location.href"})).await?;
        let recovered = apply(&runtime, &lease, &page, json!({"kind":"push_state","url":"/recovered"})).await?;
        let human = runtime.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)).await?.controller.ok_or("fixture_human_missing")?;
        let denied = runtime.action(&lease.controller_id, &authority(&runtime, &lease, &page).await, serde_json::from_value(json!({"kind":"push_state","url":"/wrong-owner"})).unwrap()).await;
        let final_value = apply(&runtime, &human, &page, json!({"kind":"evaluate","script":"({url:location.href,sameDocument:document===originalDocument,sameInput:document.querySelector('input')===originalInput,value:originalInput.value})"})).await?;
        let peer_after = serde_json::to_value(peer.observe().await?).unwrap();
        Ok((
            (before,pushed,repeated.is_err(),same_page,page,clicked,after,noop,after_noop,back,forward),
            (router,routed,fallback,fallback_events,rejected,after_rejected,recovered),
            (denied,final_value,peer_before,peer_after),
        ))
    }.await;
    let peer_closed = if let Some(peer) = peer {
        Some(peer.close(&identity("history:peer")).await)
    } else {
        None
    };
    let closed = runtime.close(&resource).await;
    server.abort();
    let server_closed = server.await;
    println!(
        "BROWSER_PUSHSTATE root={} evidence={evidence:?} peer_closed={peer_closed:?} closed={closed:?} server={server_closed:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(peer_closed.is_some_and(|result| result.is_ok()));
    assert!(server_closed.is_ok() || server_closed.is_err_and(|error| error.is_cancelled()));
    let (
        (
            before,
            pushed,
            repeated_denied,
            same_page,
            page,
            _clicked,
            after,
            noop,
            after_noop,
            back,
            forward,
        ),
        (router, routed, fallback, fallback_events, rejected, after_rejected, recovered),
        (denied, final_value, peer_before, peer_after),
    ) = evidence.unwrap();
    let next = format!("{origin}/next?lang=ko#section");
    assert!(pushed.response.success);
    assert_eq!(pushed.response.data, json!({"url":next}));
    assert!(repeated_denied);
    assert_eq!(same_page, page);
    assert_eq!(
        after["result"],
        json!({"url":next,"length":before["result"]["length"].as_u64().unwrap()+1,"events":[["popstate",null],["navigate"]],"clicks":1,"sameDocument":true,"sameInput":true,"value":"한글"})
    );
    assert_eq!(noop["url"], next);
    assert_eq!(
        after_noop["result"],
        json!({"length":after["result"]["length"],"events":after["result"]["events"]})
    );
    assert_eq!(back["url"], format!("{origin}/start"));
    assert_eq!(forward["url"], next);
    assert_eq!(router["url"], format!("{origin}/router"));
    assert_eq!(
        routed["result"],
        json!({"calls":["/router"],"events":[],"state":{"router":true}})
    );
    assert_eq!(fallback["url"], format!("{origin}/fallback"));
    assert_eq!(
        fallback_events["result"],
        json!([["popstate", null], ["navigate"]])
    );
    assert!(!rejected.response.success);
    assert!(rejected.response.error.unwrap().contains("SecurityError"));
    assert_eq!(after_rejected["result"], format!("{origin}/fallback"));
    assert_eq!(recovered["url"], format!("{origin}/recovered"));
    assert!(matches!(
        denied,
        Err(BrowserRuntimeError::Admission(
            BrowserAdmissionError::ControllerChanged
        ))
    ));
    assert_eq!(
        final_value["result"],
        json!({"url":format!("{origin}/recovered"),"sameDocument":true,"sameInput":true,"value":"한글"})
    );
    assert_eq!(peer_before, peer_after);
}
