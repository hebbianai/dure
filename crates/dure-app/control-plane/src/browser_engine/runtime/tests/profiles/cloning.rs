use super::*;
use crate::browser_engine::runtime::BrowserProfileAction;
use dure_app::BrowserProfileIdV1;
use std::sync::atomic::Ordering;

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cancelled_clone_in_new_profile_retains_both_pages_until_close() {
    cancelled(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cancelled_clone_in_shared_profile_closes_only_its_own_targets() {
    cancelled(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cancelled_clone_retires_shared_destination_before_the_origin_process() {
    cancelled_with_order(true, true).await;
}

async fn cancelled(shared: bool) {
    cancelled_with_order(shared, false).await;
}

async fn cancelled_with_order(shared: bool, destination_first: bool) {
    let config = config();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-clone-cancel-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:clone-cancel");
    let peer_resource = identity("profile:clone-peer");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut peer = None;
    let mut http = GatedPage::start().await;
    let mut stage = "prepare";
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        let first = first_page(&runtime).await?;
        apply(&runtime, &lease, &first, json!({"kind":"navigate","url":http.url})).await?;
        let original = runtime.host.lock().await.page_identity(&first.page_id)?;
        let original_owner = Arc::clone(&runtime.execution(&original).await?.binding.instance);
        let source = if shared {
            peer = Some(BrowserRuntime::launch_profile(peer_resource.clone(), &config, &root, &profile_spec(&b)).await?);
            peer.as_ref().unwrap().profile_source(&b).await
        } else { None };
        let profile = profile_spec(&b);
        let action = BrowserProfileAction::Clone;
        let admitted = authority(&runtime, &lease, &original).await;
        http.armed.store(true, Ordering::SeqCst);
        let mut cloning = Box::pin(async {
            runtime.admit_profile_change(&lease.controller_id, &admitted, &config, action, &profile, source).await?.finish().await
        });
        tokio::select! {
            result = &mut cloning => return Err(if result.is_ok() {"fixture clone completed before gate"} else {"fixture clone failed before gate"}.into()),
            request = timeout(Duration::from_secs(20), http.requested.recv()) => { request.map_err(|_| "fixture request timeout")?.ok_or("fixture request lost")?; },
        }
        let during = runtime.host.lock().await.pages();
        let cloned = during.iter().find(|page| page.page_id != original.page_id).ok_or("cloned page missing")?.clone();
        let destination = Arc::clone(&runtime.execution(&cloned).await?.binding.instance);
        drop(cloning);
        let fenced = timeout(Duration::from_secs(5), async {
            loop {
                let changed = runtime.changed.notified();
                tokio::pin!(changed); changed.as_mut().enable();
                let control = runtime.control().await;
                if control.phase == BrowserResourcePhase::OutcomeUnknown { return control; }
                changed.await;
            }
        }).await.map_err(|_| "fixture cancellation fence missing")?;
        let alive = (!original_owner.browser_has_exited().await?, !destination.browser_has_exited().await?);
        let _ = http.release.send(true);
        stage = "origin close";
        if destination_first {
            // Exercise retirement while the source process is still alive,
            // independent of the random instance IDs used by resource close.
            runtime.begin_retirement(&resource).await?;
            let instance = destination.connection().await.instance().clone();
            runtime.retire_binding(&instance).await?;
            if original_owner.browser_has_exited().await? {
                return Err("fixture source exited before destination retirement".into());
            }
        }
        runtime.close(&resource).await?;
        stage = "origin exit observation";
        let after_origin = (original_owner.browser_has_exited().await?, destination.browser_has_exited().await?);
        let peer_value = if let Some(peer) = &peer {
            stage = "peer page observation";
            let page = first_page(peer).await?;
            stage = "peer control";
            let lease = peer.request_control(BrowserControllerId::new("peer-agent").unwrap(), None).await?.controller.ok_or("peer controller missing")?;
            stage = "peer evaluation";
            let value = apply(peer, &lease, &page, json!({"kind":"evaluate","script":"'한글 다른 리소스 유지'"})).await?;
            stage = "peer close";
            peer.close(&peer_resource).await?;
            Some(value)
        } else { None };
        let destination_exited = destination.browser_has_exited().await?;
        Ok((original, during, cloned, fenced, alive, after_origin, peer_value, destination_exited))
    }.await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let peer_closed = match &peer {
        Some(peer) => peer.close(&peer_resource).await,
        None => Ok(()),
    };
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_CLONE_CANCEL shared={shared} stage={stage} root={} evidence={evidence:?} cleanup={closed:?} peer={peer_closed:?} server={server:?}",
        root.display()
    );
    assert!(
        closed.is_ok() && peer_closed.is_ok(),
        "{closed:?} {peer_closed:?}"
    );
    assert!(server.is_ok(), "{server:?}");
    let (original, during, cloned, fenced, alive, after_origin, peer_value, destination_exited) =
        evidence.unwrap();
    assert_eq!(during.len(), 2);
    assert!(during.contains(&original));
    assert_ne!(cloned.page_id, original.page_id);
    assert_eq!(fenced.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(fenced.in_flight.is_some());
    assert_eq!(alive, (true, true));
    assert_eq!(after_origin, (true, !shared));
    if shared {
        assert_eq!(peer_value.unwrap()["result"], "한글 다른 리소스 유지");
    }
    assert!(destination_exited);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cloned_page_dialog_and_handoff_preserve_the_original_document() {
    let config = config();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-clone-dialog-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:clone-dialog");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut http = GatedPage::with_html("<!doctype html><meta charset=utf-8><script>if(location.hash==='#dialog'){window.answer=prompt('한글 복제 입력','기본값');localStorage.setItem('clone-answer',window.answer)}</script><p>Clone dialog</p>").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.ok_or("controller missing")?;
        let first = first_page(&runtime).await?;
        apply(&runtime, &lease, &first, json!({"kind":"navigate","url":http.url})).await?;
        let page = runtime.host.lock().await.page_identity(&first.page_id)?;
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"window.originalOnly='원본 유지';location.hash='dialog';true"})).await?;
        let original = runtime.host.lock().await.page_identity(&first.page_id)?;
        let authority = authority(&runtime, &lease, &original).await;
        let profile = profile_spec(&b);
        let action = BrowserProfileAction::Clone;
        http.armed.store(true, Ordering::SeqCst);
        let (cloned, answered) = timeout(Duration::from_secs(45), async {
            tokio::join!(async { runtime.admit_profile_change(&lease.controller_id, &authority, &config, action, &profile, None).await?.finish().await }, async {
                timeout(Duration::from_secs(20), http.requested.recv()).await.map_err(|_| "fixture request timeout")?.ok_or("fixture request lost")?;
                let pages = runtime.host.lock().await.pages();
                let cloned = pages.iter().find(|page| page.page_id != original.page_id).ok_or("cloned page missing")?.clone();
                let transfer = runtime.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)).await?;
                let _ = http.release.send(true);
                let dialog = timeout(Duration::from_secs(5), async {
                    loop {
                        let changed = runtime.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
                        if let Some(dialog) = runtime.dialog(&cloned.page_id).await?.dialog { return Ok::<_, BrowserRuntimeError>(dialog); }
                        changed.await;
                    }
                }).await.map_err(|_| "fixture clone dialog timeout")??;
                let response_authority = super::super::authority(&runtime, &lease, &dialog.identity.page).await;
                let response = runtime.respond_dialog(&lease.controller_id, &response_authority, &dialog.identity,
                    serde_json::from_value(json!({"kind":"accept","text":"복제 응답\n--help"})).unwrap()).await?;
                Ok::<_, BrowserRuntimeError>((pages, transfer, dialog, response))
            })
        }).await.map_err(|_| "fixture clone dialog deadline")?;
        let (during, transfer, dialog, response) = answered?;
        let cloned = cloned?;
        let after = runtime.observe().await?;
        let human = after.control.controller.clone().ok_or("final controller missing")?;
        let page: BrowserPageIdentity = serde_json::from_value(cloned.response.data["page"].clone()).map_err(|_| "clone result page missing")?;
        let value = apply(&runtime, &human, &page, json!({"kind":"evaluate","script":"({answer:window.answer,stored:localStorage.getItem('clone-answer'),original:window.originalOnly??null})"})).await?;
        let original_value = apply(&runtime, &human, &original, json!({"kind":"evaluate","script":"window.originalOnly"})).await?;
        Ok((original, during, transfer, dialog, response, cloned, after, value, original_value))
    }.await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_CLONE_DIALOG root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (original, during, transfer, dialog, response, cloned, after, value, original_value) =
        evidence.unwrap();
    assert_eq!(during.len(), 2);
    assert!(during.contains(&original));
    assert_ne!(dialog.identity.page.page_id, original.page_id);
    assert_eq!(dialog.message, "한글 복제 입력");
    assert_eq!(transfer.requested_controller.unwrap().as_str(), "human");
    assert!(response.response.success && cloned.response.success);
    assert_eq!(after.pages.len(), 2);
    assert_eq!(
        after.control.controller.unwrap().controller_id.as_str(),
        "human"
    );
    assert!(after.control.in_flight.is_none() && after.control.dialog_response.is_none());
    assert_eq!(
        value["result"],
        json!({"answer":"복제 응답\n--help","stored":"복제 응답\n--help","original":null})
    );
    assert_eq!(original_value["result"], "원본 유지");
}
