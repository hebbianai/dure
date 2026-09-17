use super::*;

#[tokio::test]
async fn late_attachment_cannot_recreate_a_replaced_tab_through_its_live_opener() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/retired-attachment",
        listener.local_addr().unwrap()
    );
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut methods = Vec::new();
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            let method = request["method"].as_str().unwrap().to_owned();
            let result = match method.as_str() {
                "Target.getTargets" => json!({"targetInfos":[{"targetId":"opener","type":"page"}]}),
                "Page.getFrameTree" => {
                    json!({"frameTree":{"frame":{"id":"retired","loaderId":"late-document"}}})
                }
                _ => json!({}),
            };
            methods.push(method);
            if peer
                .send(Message::text(
                    json!({"id":request["id"],"result":result}).to_string(),
                ))
                .await
                .is_err()
            {
                break;
            }
        }
        methods
    });
    let cdp = BrowserCdp::connect(&address).await.unwrap();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("replacement").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let original_instance = BrowserInstanceId::new("original").unwrap();
    let mut host = BrowserResourceHost::new(identity.clone());
    let original = host
        .register_page(
            original_instance.clone(),
            BrowserTargetId::new("retired").unwrap(),
            BrowserDocumentId::new("old").unwrap(),
        )
        .unwrap();
    host.register_page(
        original_instance.clone(),
        BrowserTargetId::new("opener").unwrap(),
        BrowserDocumentId::new("peer").unwrap(),
    )
    .unwrap();
    let lease = host
        .request_control(BrowserControllerId::new("controller").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    let mut permit = host
        .begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: original,
                command_sequence: host.projection().next_command_sequence,
                operation_id: BrowserOperationId::new("replacement").unwrap(),
            },
            None,
        )
        .unwrap();
    let instance = BrowserInstanceId::new("next").unwrap();
    let replacement = BrowserTargetId::new("replacement").unwrap();
    let creation = host.prepare_page_replacement(&permit, &instance).unwrap();
    host.register_instance_binding(&identity, instance.clone())
        .unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    host.reserve_created_page_target(&creation, replacement.clone())
        .unwrap();
    host.observe_page_document(
        instance,
        replacement.clone(),
        BrowserDocumentId::new("new").unwrap(),
    )
    .unwrap();
    let (_, retired) = host
        .replace_page_binding(&mut permit, &replacement)
        .unwrap();
    let expected = host.pages();
    let host = Arc::new(Mutex::new(host));
    let state = monitor(
        Arc::clone(&host),
        cdp.clone(),
        mpsc::channel(32).0,
        original_instance,
        Arc::new(Notify::new()),
    )
    .await;
    let mut source = Source {
        cdp: cdp.clone(),
        resources: BTreeMap::from([(identity.resource_id, state)]),
    };
    let census = source.census().await;
    let retained = host.lock().await.owns_page_target(retired.target());
    let event = source.event(json!({"method":"Target.attachedToTarget","params":{
        "sessionId":"late-session","waitingForDebugger":true,
        "targetInfo":{"targetId":"retired","type":"page","url":"about:blank","openerId":"opener"}
    }})).await;
    let pages = host.lock().await.pages();
    source.cdp.retire().await;
    let methods = peer.await.unwrap();
    println!(
        "BROWSER_REPLACEMENT_LATE_ATTACHMENT census={census:?} retained={retained} event={event:?} expected={expected:?} pages={pages:?} methods={methods:?}"
    );
    assert!(census.is_ok() && event.is_ok());
    assert!(retained);
    assert_eq!(pages, expected);
    assert_eq!(
        methods,
        vec!["Target.getTargets", "Target.detachFromTarget"]
    );
}

#[tokio::test]
async fn rejected_retired_attachment_detach_requires_exact_target_absence() {
    for (targets, expected) in [
        (json!([]), Ok(())),
        (
            json!([{"targetId":"retiring"}]),
            Err("browser_cdp_request_rejected"),
        ),
        (
            json!([{"missing":"target identity"}]),
            Err("browser_network_event_invalid"),
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!(
            "ws://{}/devtools/browser/retired-detach",
            listener.local_addr().unwrap()
        );
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut methods = Vec::new();
            while let Some(Ok(Message::Text(text))) = peer.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                methods.push(request["method"].as_str().unwrap().to_owned());
                let response = if request["method"] == "Target.detachFromTarget" {
                    json!({"id":request["id"],"error":{"code":-32000,"message":"fixture session absent"}})
                } else {
                    json!({"id":request["id"],"result":{"targetInfos":targets}})
                };
                if peer
                    .send(Message::text(response.to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            methods
        });
        let mut cdp = BrowserCdp::connect(&address).await.unwrap();
        let result = detach_retiring_target(
            &mut cdp,
            &BrowserTargetId::new("retiring").unwrap(),
            "late-session",
            None,
        )
        .await;
        cdp.retire().await;
        let methods = peer.await.unwrap();
        println!(
            "BROWSER_REPLACEMENT_DETACH_ABSENCE result={result:?} expected={expected:?} methods={methods:?}"
        );
        assert_eq!(result, expected);
        assert_eq!(
            methods,
            vec!["Target.detachFromTarget", "Target.getTargets"]
        );
    }
}

#[tokio::test]
async fn replacement_attachment_retains_its_source_until_host_publishes_frame_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "ws://{}/devtools/browser/replacement-attachment",
        listener.local_addr().unwrap()
    );
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut methods = Vec::new();
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            let method = request["method"].as_str().unwrap().to_owned();
            let result = if method == "Page.getFrameTree" {
                json!({"frameTree":{"frame":{"id":"replacement-frame","loaderId":"prepared-document"}}})
            } else {
                json!({})
            };
            methods.push(method);
            if peer
                .send(Message::text(
                    json!({"id":request["id"],"result":result}).to_string(),
                ))
                .await
                .is_err()
            {
                break;
            }
        }
        methods
    });
    let cdp = BrowserCdp::connect(&address).await.unwrap();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("replacement-owner").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let mut host = BrowserResourceHost::new(identity.clone());
    let original = host
        .register_page(
            BrowserInstanceId::new("original").unwrap(),
            BrowserTargetId::new("original-target").unwrap(),
            BrowserDocumentId::new("original-document").unwrap(),
        )
        .unwrap();
    let lease = host
        .request_control(BrowserControllerId::new("controller").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    let mut permit = host
        .begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: original.clone(),
                command_sequence: host.projection().next_command_sequence,
                operation_id: BrowserOperationId::new("replace").unwrap(),
            },
            None,
        )
        .unwrap();
    let instance = BrowserInstanceId::new("destination").unwrap();
    let target = BrowserTargetId::new("replacement-target").unwrap();
    let creation = host.prepare_page_replacement(&permit, &instance).unwrap();
    host.register_instance_binding(&identity, instance.clone())
        .unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    let host = Arc::new(Mutex::new(host));
    let state = monitor(
        Arc::clone(&host),
        cdp.clone(),
        mpsc::channel(32).0,
        instance,
        Arc::new(Notify::new()),
    )
    .await;
    let mut source = Source {
        cdp: cdp.clone(),
        resources: BTreeMap::from([(identity.resource_id, state)]),
    };
    let attached = source
        .event(json!({"method":"Target.attachedToTarget","params":{
            "sessionId":"replacement-session","waitingForDebugger":true,
            "targetInfo":{"targetId":"replacement-target","type":"page","url":"about:blank"}
        }}))
        .await;
    let frame_id = BrowserFrameId::new("replacement-frame").unwrap();
    let (before, unpublished, retained, old_frame, publication) = {
        let mut host = host.lock().await;
        (
            host.pages(),
            host.page_for_target(&target),
            host.network().page_source(&target),
            host.frame_identity(&original, &frame_id),
            host.replace_page_binding(&mut permit, &target),
        )
    };
    let navigated = source
        .event(
            json!({"method":"Page.frameNavigated","sessionId":"replacement-session","params":{
                "frame":{"id":"replacement-frame","loaderId":"navigated-document"}
            }}),
        )
        .await;
    let (after, frame) = {
        let host = host.lock().await;
        let page = host.page_identity(&original.page_id).unwrap();
        (host.pages(), host.frame_identity(&page, &frame_id))
    };
    source.cdp.retire().await;
    let methods = peer.await.unwrap();
    assert_eq!(attached, Ok(()));
    assert_eq!(before, vec![original.clone()]);
    assert_eq!(unpublished, None);
    assert_eq!(
        retained,
        Some(BrowserNetworkId::new("replacement-session").unwrap())
    );
    assert!(
        old_frame.is_err(),
        "an unpublished replacement cannot attach a frame to the source page"
    );
    let (published, _) = publication.unwrap();
    assert_eq!(published.page_id, original.page_id);
    assert_eq!(navigated, Ok(()));
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].page_id, original.page_id);
    assert!(after[0].document_revision > original.document_revision);
    assert_eq!(frame.unwrap().page, after[0]);
    assert!(
        methods
            .iter()
            .any(|method| method == "Runtime.runIfWaitingForDebugger")
    );
    assert!(
        !methods
            .iter()
            .any(|method| method == "Target.detachFromTarget")
    );
}
