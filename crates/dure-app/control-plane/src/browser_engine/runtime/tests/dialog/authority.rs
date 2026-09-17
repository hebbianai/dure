use super::*;
use hmux_session_protocol::browser_dialog::*;

pub(super) async fn launch(
    name: &str,
) -> (BrowserRuntime, BrowserResourceIdentity, std::path::PathBuf) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-dialog-authority-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = identity(name);
    let runtime = BrowserRuntime::launch(identity.clone(), &config, &root)
        .await
        .unwrap();
    (runtime, identity, root)
}

pub(super) async fn pending(
    runtime: &BrowserRuntime,
    page: &BrowserPageIdentity,
) -> Result<BrowserDialogObservation, BrowserRuntimeError> {
    timeout(Duration::from_secs(2), async {
        loop {
            let observed = runtime.dialog(&page.page_id).await?;
            if observed.dialog.is_some() {
                return Ok(observed);
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| BrowserRuntimeError::Observation("fixture_dialog_open_timeout"))?
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn actual_dialog_kinds_share_one_authorized_response_path() {
    let (runtime, identity, root) = launch("dialog:kinds").await;
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let target = runtime.host.lock().await.target_for(&page)?.clone();
        let endpoint = runtime.test_binding().engine.lock().await.chromium.endpoint().to_owned();
        let mut cleanup = BrowserCdp::connect(&endpoint).await?;
        let session = cleanup.attach(target.as_str()).await?;
        cleanup.request("Page.enable",json!({}),Some(&session)).await?;
        let mut cases = Vec::new();
        for (script,kind,response,expected) in [
            ("alert('Alert fixture');window.answer='continued'",BrowserDialogKind::Alert,json!({"kind":"accept"}),json!("continued")),
            ("window.answer=confirm('Confirm fixture')",BrowserDialogKind::Confirm,json!({"kind":"accept"}),json!(true)),
            ("window.answer=confirm('Confirm fixture')",BrowserDialogKind::Confirm,json!({"kind":"dismiss"}),json!(false)),
            ("window.answer=prompt('Prompt fixture','default')",BrowserDialogKind::Prompt,json!({"kind":"accept","text":"한글\n--help"}),json!("한글\n--help")),
            ("window.answer=prompt('Prompt fixture','default')",BrowserDialogKind::Prompt,json!({"kind":"accept","text":""}),json!("")),
            ("window.answer=prompt('Prompt fixture','default')",BrowserDialogKind::Prompt,json!({"kind":"dismiss"}),Value::Null),
        ] {
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":format!("document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>{{{script}}};true")})).await?;
            let command = authority(&runtime,&lease,&page).await;
            let (clicked,answer) = tokio::join!(runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"click","target":{"kind":"css","selector":"#ask"}})).unwrap()),async {
                let response: Result<_,BrowserRuntimeError> = async {
                    let observed = pending(&runtime,&page).await?;
                    let dialog = observed.dialog.as_ref().unwrap();
                    if dialog.kind != kind { return Err("fixture_dialog_kind".into()); }
                    let mut wrong = dialog.identity.clone();
                    wrong.revision = std::num::NonZeroU64::new(u64::MAX).unwrap();
                    let proposal = authority(&runtime,&lease,&page).await;
                    let stale = runtime.respond_dialog(&lease.controller_id,&proposal,&wrong,serde_json::from_value(response.clone()).unwrap()).await;
                    if !matches!(stale,Err(BrowserRuntimeError::Admission(BrowserAdmissionError::DialogChanged))) { return Err("fixture_stale_dialog_accepted".into()); }
                    // A network renderer barrier waits behind this prompt,
                    // while the event loop must keep accepting its response.
                    let (network,answered) = tokio::join!(async { runtime.test_binding().events.synchronize(&target).await },runtime.respond_dialog(&lease.controller_id,&proposal,&dialog.identity,serde_json::from_value(response.clone()).unwrap()));
                    network?;
                    Ok((observed,answered?))
                }.await;
                if response.is_err() { let _ = cleanup.request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&session)).await; }
                response
            });
            let actual = cleanup.request("Runtime.evaluate",json!({"expression":"window.answer","returnByValue":true}),Some(&session)).await?;
            cases.push(json!({"kind":kind,"answered":answer.is_ok(),"clicked":clicked.is_ok(),"actual":actual}));
            println!("BROWSER_DIALOG_KIND {:?}",cases.last());
            answer?;
            clicked?;
            if actual["result"]["value"] != expected { return Err("fixture_dialog_effect_mismatch".into()); }
            if runtime.dialog(&page.page_id).await?.dialog.is_some() { return Err("fixture_dialog_not_closed".into()); }
        }
        cleanup.retire().await;
        Ok(cases)
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_KINDS root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    evidence.unwrap();
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn dialog_response_drains_the_triggering_input_before_handoff() {
    let (runtime, identity, root) = launch("dialog:handoff").await;
    let evidence: Result<_,BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=ask>Ask</button>';document.querySelector('#ask').onclick=()=>window.answer=prompt('handoff');true"})).await?;
        let command = authority(&runtime,&lease,&page).await;
        let (clicked,answer) = tokio::join!(runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"click","target":{"kind":"css","selector":"#ask"}})).unwrap()),async {
            let observed = pending(&runtime,&page).await?;
            let human = BrowserControllerId::new("human").unwrap();
            let transfer = runtime.request_control(human.clone(),Some(&lease)).await?;
            if transfer.controller.as_ref() != Some(&lease) || transfer.requested_controller.as_ref() != Some(&human) { return Err(BrowserRuntimeError::Observation("fixture_handoff_not_pending")); }
            let response = runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&observed.dialog.unwrap().identity,serde_json::from_value(json!({"kind":"accept","text":"drained"})).unwrap()).await?;
            Ok(response)
        });
        let control = runtime.control().await;
        let actual = runtime.test_binding().engine.lock().await.require(json!({"action":"evaluate","script":"window.answer"})).await?;
        Ok((clicked,answer,control,actual))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DIALOG_HANDOFF root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (clicked, answered, control, actual) = evidence.unwrap();
    assert!(clicked.is_ok() && answered.is_ok());
    assert_eq!(actual["result"], "drained");
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert_eq!(control.controller.unwrap().controller_id.as_str(), "human");
    assert!(control.in_flight.is_none() && control.dialog_response.is_none());
    assert!(control.pointer.is_none());
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn beforeunload_responses_preserve_or_commit_the_same_pages_document() {
    let (runtime, identity, root) = launch("dialog:beforeunload").await;
    let result: Result<_,BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        let mut cases = Vec::new();
        for accept in [false,true] {
            let page = first_page(&runtime).await?;
            apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<button id=leave>Leave</button>';onbeforeunload=e=>{e.preventDefault();return ''};document.querySelector('#leave').onclick=()=>location.href='about:blank?after';true"})).await?;
            let command = authority(&runtime,&lease,&page).await;
            let (clicked,answer) = tokio::join!(runtime.action(&lease.controller_id,&command,serde_json::from_value(json!({"kind":"click","target":{"kind":"css","selector":"#leave"}})).unwrap()),async {
                let observed = pending(&runtime,&page).await?;
                let dialog = observed.dialog.unwrap();
                if dialog.kind != BrowserDialogKind::BeforeUnload { return Err(BrowserRuntimeError::Observation("fixture_beforeunload_kind")); }
                runtime.respond_dialog(&lease.controller_id,&authority(&runtime,&lease,&page).await,&dialog.identity,serde_json::from_value(json!({"kind":if accept {"accept"} else {"dismiss"}})).unwrap()).await
            });
            let observed = runtime.observe().await?;
            println!("BROWSER_BEFOREUNLOAD accept={accept} clicked={clicked:?} answered={answer:?} observed={observed:?}");
            clicked?;
            answer?;
            let after = &observed.pages[0];
            if after.page.page_id != page.page_id || (accept && (after.url != "about:blank?after" || after.page.document_revision == page.document_revision)) || (!accept && after.page != page) {
                return Err("fixture_beforeunload_document".into());
            }
            cases.push(json!({"accepted":accept,"before":page,"after":after.page,"url":after.url}));
        }
        Ok(cases)
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_BEFOREUNLOAD_FINAL root={} result={result:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    result.unwrap();
}
