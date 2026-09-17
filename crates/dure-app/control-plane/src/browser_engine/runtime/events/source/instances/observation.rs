use super::*;
use hmux_session_protocol::browser_dialog::{BrowserDialogResponse, BrowserPromptText};

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine configuration"]
async fn browser_instances_withdrawal_preserves_peer_observation_and_dialogs() {
    observe(false).await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine configuration"]
async fn browser_instances_connection_loss_preserves_peer_observation_and_dialogs() {
    observe(true).await;
}

async fn observe(disconnect: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-instance-events-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let identity = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("resource:instances").unwrap(),
        generation: BrowserResourceGeneration::new("generation:1").unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
    };
    let host = Arc::new(Mutex::new(BrowserResourceHost::new(identity.clone())));
    let mut browsers = Vec::new();
    let mut connections = Vec::new();
    let mut observers = Vec::new();
    let evidence: Result<_,String> = async {
        let mut targets = Vec::new();
        let mut sessions = Vec::new();
        for index in 0..2 {
            browsers.push(OwnedChromium::launch(&config.chromium,&root).await.map_err(|error|format!("{error:?}"))?);
            let target = browsers[index].launch_page().await.map_err(|error|format!("{error:?}"))?;
            host.lock().await.reserve_page_target(&identity,browsers[index].connection().instance().clone(),target.clone()).map_err(|error|format!("{error:?}"))?;
            let mut cdp = BrowserCdp::connect(browsers[index].endpoint()).await?;
            sessions.push(cdp.attach(target.as_str()).await?);
            connections.push(cdp);
            targets.push(target);
        }
        // Both instances already have reservations in the same canonical Host.
        // Each production observer must attach only its own instance's pages.
        for index in 0..2 {
            observers.push(BrowserEventMonitor::start(Arc::clone(&host),browsers[index].endpoint(),browsers[index].connection().instance().clone(), Arc::new(tokio::sync::Notify::new())).await?);
            observers[index].synchronize(&targets[index]).await?;
        }
        let before = host.lock().await.pages();
        let foreign_single = observers[0].synchronize(&targets[1]).await;
        let foreign_pages = observers[0].synchronize_pages(&[&targets[1]]).await;
        let foreign_interception = observers[0].apply_interception(targets[1].clone()).await;
        let peer_page = host.lock().await.page_for_target(&targets[1]).ok_or("peer page missing")?;
        let lease = host.lock().await.request_control(BrowserControllerId::new("controller").unwrap(),None).map_err(|error|format!("{error:?}"))?.controller.unwrap();
        connections[1].request("Runtime.evaluate",json!({"expression":"setTimeout(()=>{window.answer=prompt('Independent profile prompt')},0);true","returnByValue":true}),Some(&sessions[1])).await?;
        let dialog = timeout(Duration::from_secs(5),async {
            loop {
                observers[1].synchronize_events().await?;
                let observed = host.lock().await.dialog_observation(&peer_page.page_id).map_err(|_|"peer dialog observation failed")?;
                if let Some(dialog) = observed.dialog { return Ok::<_,&'static str>(dialog); }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_|"peer dialog did not open")??;
        let permit = {
            let mut host = host.lock().await;
            let authority = BrowserActionAuthority { lease:lease.clone(),page:peer_page.clone(),command_sequence:host.projection().next_command_sequence,operation_id:BrowserOperationId::new("peer-response").unwrap() };
            host.begin_dialog_response(&lease.controller_id,&authority,&dialog.identity,BrowserDialogResponse::Accept { text:Some(BrowserPromptText::try_from(String::from("프로필 응답 유지")).unwrap()) }).map_err(|error|format!("{error:?}"))?
        };
        let lost = if disconnect {
            observers[0].cdp.retire().await;
            Some(observers[0].synchronize_events().await)
        } else { None };
        observers[0].close().await;
        let control = host.lock().await.projection();
        let source = host.lock().await.dispatch_dialog(&permit).map_err(|error|format!("{error:?}"))?.clone();
        let answered = observers[1].cdp.request("Page.handleJavaScriptDialog",json!({"accept":true,"promptText":"프로필 응답 유지"}),Some(source.as_str())).await;
        if answered.is_err() { let _ = connections[1].request("Page.handleJavaScriptDialog",json!({"accept":false}),Some(&sessions[1])).await; }
        answered?;
        host.lock().await.finish_dialog_response(permit,BrowserActionOutcome::Completed).map_err(|error|format!("{error:?}"))?;
        observers[1].synchronize(&targets[1]).await?;
        let actual = connections[1].request("Runtime.evaluate",json!({"expression":"window.answer","returnByValue":true}),Some(&sessions[1])).await?;
        let host = host.lock().await;
        let peer_network = host.network_snapshot(&peer_page,Instant::now()).map_err(|error|format!("{error:?}"))?;
        let peer_dialog = host.dialog_observation(&peer_page.page_id).map_err(|error|format!("{error:?}"))?;
        Ok((before,host.pages(),foreign_single,foreign_pages,foreign_interception,lost,control,actual,peer_network,peer_dialog))
    }.await;
    for observer in &observers {
        observer.close().await;
    }
    for connection in &connections {
        connection.retire().await;
    }
    let mut retired = Vec::new();
    for browser in &mut browsers {
        retired.push(browser.close().await);
    }
    println!(
        "BROWSER_INSTANCE_OBSERVATION root={} disconnect={disconnect} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.iter().all(Result::is_ok), "{retired:?}");
    let (before, after, single, pages, interception, lost, control, actual, network, dialog) =
        evidence.unwrap();
    assert_eq!(before.len(), 2);
    assert_eq!(after, before);
    assert_eq!(single, Err("browser_page_owner_mismatch"));
    assert_eq!(pages, Err("browser_page_owner_mismatch"));
    assert_eq!(interception, Err("browser_page_owner_mismatch"));
    if disconnect {
        assert!(lost.unwrap().is_err());
    }
    assert_eq!(control.phase, BrowserResourcePhase::Ready);
    assert_eq!(actual["result"]["value"], "프로필 응답 유지");
    assert!(network.complete);
    assert!(dialog.dialog.is_none());
}
