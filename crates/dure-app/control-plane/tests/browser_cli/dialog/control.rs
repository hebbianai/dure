use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn cli_control_requests_handoff_while_a_prompt_is_blocking_input() {
    let (root, endpoint, server) = fixture().await;
    let evidence: Result<_,String> = async {
        let created = cli(&root,&["create"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or("resource missing")?;
        let shown = cli(&root,&["show",resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        let controlled = cli(&root,&["control",resource,"--controller","agent-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page",page,"--controller","agent-proof","--epoch",epoch];
        let mut setup = vec!["eval",resource,"document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>window.answer=prompt('Handoff');true"];
        setup.extend(shared);
        cli(&root,&setup).await?;
        let current = cli(&root,&["show",resource]).await?;
        let view = &current["result"];
        let click = json!({"kind":"action","caller":"agent-proof","authority":{"lease":view["control"]["controller"],"page":view["pages"][0]["page"],"operation_id":"control-dialog-trigger","command_sequence":view["control"]["next_command_sequence"]},"action":{"kind":"click","target":{"kind":"css","selector":"#ask"}}});
        let mut observer = Observer::connect(&root).await?;
        let (clicked,response) = tokio::join!(backend(&endpoint,"browser.resource",click),async {
            let opened = timeout(Duration::from_secs(2),async {
                loop { if observer.next().await?["method"] == "Page.javascriptDialogOpening" { return Ok::<_,String>(()); } }
            }).await;
            let control = timeout(Duration::from_secs(1),cli(&root,&["control",resource,"--controller","human"])).await;
            let mut respond = vec!["dialog",resource,"accept","인계 완료"];
            respond.extend(shared);
            let answered = cli(&root,&respond).await;
            if answered.is_err() { let _ = observer.request("Page.handleJavaScriptDialog",json!({"accept":false})).await; }
            (opened,control,answered)
        });
        let final_state = cli(&root,&["show",resource]).await?;
        let actual = observer.request("Runtime.evaluate",json!({"expression":"window.answer","returnByValue":true})).await?;
        observer.socket.close(None).await.map_err(|e|e.to_string())?;
        Ok((clicked,response,final_state,actual))
    }.await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    let retired = timeout(Duration::from_secs(40), server).await;
    println!(
        "BROWSER_DIALOG_CLI_HANDOFF root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    retired.unwrap().unwrap().unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    let (clicked, (opened, control, answered), final_state, actual) = evidence.unwrap();
    opened.unwrap().unwrap();
    let control = control
        .expect("CLI control waited for the input blocked by the dialog")
        .unwrap();
    assert_eq!(
        control["result"]["controller"]["controller_id"],
        "agent-proof"
    );
    assert_eq!(control["result"]["requested_controller"], "human");
    assert_eq!(control["result"]["in_flight"], "control-dialog-trigger");
    answered.unwrap();
    assert_eq!(clicked["result"]["result"]["response"]["success"], true);
    assert_eq!(actual["result"]["value"], "인계 완료");
    assert_eq!(
        final_state["result"]["control"]["controller"]["controller_id"],
        "human"
    );
    assert_eq!(final_state["result"]["control"]["phase"], "ready");
    assert!(final_state["result"]["control"]["pointer"].is_null());
}
