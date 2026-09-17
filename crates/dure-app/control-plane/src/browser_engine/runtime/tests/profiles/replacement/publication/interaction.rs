use super::*;
use hmux_session_protocol::browser_dialog::BrowserDialogKind;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn profile_navigation_dialog_uses_the_original_tab_and_drains_handoff() {
    let config = config();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-dialog-publication-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:dialog-publication");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut http = GatedPage::with_html("<!doctype html><meta charset=utf-8><script>if(location.hash==='#dialog'){window.answer=prompt('한글 프로필 전환','기본');localStorage.setItem('answer',window.answer)}</script><p>Profile dialog</p>").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.ok_or("fixture_controller_missing")?;
        let page = first_page(&runtime).await?;
        apply(&runtime, &lease, &page, json!({"kind":"navigate","url":http.url})).await?;
        let page = runtime.host.lock().await.page_identity(&page.page_id)?;
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"location.hash='dialog';true"})).await?;
        let page = runtime.host.lock().await.page_identity(&page.page_id)?;
        let action = authority(&runtime, &lease, &page).await;
        http.armed.store(true, Ordering::SeqCst);
        let selected_profile = profile_spec(&b);
        let (changed, answered) = timeout(Duration::from_secs(45), async {
            tokio::join!(runtime.set_profile(&lease.controller_id, &action, &config, &selected_profile), async {
                timeout(Duration::from_secs(20), http.requested.recv()).await.map_err(|_| "fixture_request_timeout")?.ok_or("fixture_request_closed")?;
                let before = runtime.host.lock().await.pages();
                let human = BrowserControllerId::new("human").unwrap();
                let transfer = runtime.request_control(human, Some(&lease)).await?;
                let _ = http.release.send(true);
                let observed = timeout(Duration::from_secs(5), async {
                    loop {
                        let changed = runtime.changed.notified();
                        tokio::pin!(changed);
                        changed.as_mut().enable();
                        let observed = runtime.dialog(&page.page_id).await?;
                        if observed.dialog.is_some() { return Ok::<_, BrowserRuntimeError>(observed); }
                        changed.await;
                    }
                }).await.map_err(|_| "fixture_dialog_timeout")??;
                let dialog = observed.dialog.ok_or("fixture_dialog_missing")?;
                let response = runtime.respond_dialog(&lease.controller_id,
                    &authority(&runtime, &lease, &dialog.identity.page).await,
                    &dialog.identity, serde_json::from_value(json!({"kind":"accept","text":"전환 완료\n--help"})).unwrap()).await?;
                Ok::<_, BrowserRuntimeError>((before, transfer, dialog, response))
            })
        }).await.map_err(|_| "fixture_profile_dialog_timeout")?;
        let (during, transfer, dialog, response) = answered?;
        let changed = changed?;
        let after = runtime.observe().await?;
        let human = after.control.controller.clone().ok_or("fixture_final_controller_missing")?;
        let page_after = runtime.host.lock().await.page_identity(&page.page_id)?;
        let value = apply(&runtime, &human, &page_after, json!({"kind":"evaluate","script":"({answer:window.answer,stored:localStorage.getItem('answer')})"})).await?;
        Ok((page, lease, during, transfer, dialog, response, changed, after, value))
    }.await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_DIALOG_PUBLICATION root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (page, lease, during, transfer, dialog, response, changed, after, value) =
        evidence.unwrap();
    assert_eq!(during.len(), 1);
    assert_eq!(during[0].page_id, page.page_id);
    assert_eq!(transfer.controller, Some(lease));
    assert_eq!(transfer.requested_controller.unwrap().as_str(), "human");
    assert_eq!(dialog.identity.page.page_id, page.page_id);
    assert!(dialog.identity.page.document_revision > page.document_revision);
    assert_eq!(dialog.kind, BrowserDialogKind::Prompt);
    assert_eq!(dialog.message, "한글 프로필 전환");
    assert!(response.response.success && changed.response.success);
    assert_eq!(after.pages.len(), 1);
    assert_eq!(after.pages[0].page.page_id, page.page_id);
    assert_eq!(after.pages[0].profile_id, Some(b));
    assert_eq!(
        after.control.controller.unwrap().controller_id.as_str(),
        "human"
    );
    assert!(after.control.in_flight.is_none() && after.control.dialog_response.is_none());
    assert_eq!(
        value["result"],
        json!({"answer":"전환 완료\n--help","stored":"전환 완료\n--help"})
    );
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cancelled_new_profile_navigation_retains_both_owners_until_resource_close() {
    cancelled(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn cancelled_existing_profile_navigation_retains_both_owners_until_resource_close() {
    cancelled(true).await;
}

async fn cancelled(existing: bool) {
    let config = config();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-cancel-publication-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:cancel-publication");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut http = GatedPage::start().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .ok_or("fixture_controller_missing")?;
        let page = first_page(&runtime).await?;
        let original = Arc::clone(&runtime.execution(&page).await?.binding.instance);
        let original_target = runtime.host.lock().await.target_for(&page)?.clone();
        if existing {
            runtime
                .launch_binding(&config, Some(&profile_spec(&b)))
                .await?;
        }
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"navigate","url":http.url}),
        )
        .await?;
        let page = runtime.host.lock().await.page_identity(&page.page_id)?;
        let before = runtime.host.lock().await.pages();
        let action = authority(&runtime, &lease, &page).await;
        http.armed.store(true, Ordering::SeqCst);
        let selected_profile = profile_spec(&b);
        let mut switching = Box::pin(runtime.set_profile(
            &lease.controller_id,
            &action,
            &config,
            &selected_profile,
        ));
        tokio::select! {
            _ = &mut switching => return Err("fixture_profile_finished_before_gate".into()),
            requested = timeout(Duration::from_secs(20), http.requested.recv()) => {
                requested.map_err(|_| "fixture_request_timeout")?.ok_or("fixture_request_closed")?;
            },
        }
        let (during, selected, retained) = {
            let host = runtime.host.lock().await;
            (
                host.pages(),
                host.page_identity(&page.page_id)?,
                host.page_target_is_retiring(&original_target),
            )
        };
        let destination = Arc::clone(&runtime.execution(&selected).await?.binding.instance);
        drop(switching);
        let fenced = timeout(Duration::from_secs(5), async {
            loop {
                let changed = runtime.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let control = runtime.control().await;
                if control.phase == BrowserResourcePhase::OutcomeUnknown {
                    return control;
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| "fixture_cancellation_fence_timeout")?;
        let alive = (
            !original.browser_has_exited().await?,
            !destination.browser_has_exited().await?,
        );
        let _ = http.release.send(true);
        let closed = runtime.close(&resource).await;
        let exited = (
            original.browser_has_exited().await?,
            destination.browser_has_exited().await?,
        );
        let final_control = runtime.control().await;
        Ok((
            before,
            page,
            during,
            selected,
            retained,
            fenced,
            alive,
            closed,
            exited,
            final_control,
        ))
    }
    .await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_CANCEL_PUBLICATION existing={existing} root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (before, page, during, selected, retained, fenced, alive, retired, exited, final_control) =
        evidence.unwrap();
    let ids = |pages: &[BrowserPageIdentity]| {
        pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(ids(&during), ids(&before));
    assert_eq!(selected.page_id, page.page_id);
    assert!(selected.document_revision > page.document_revision);
    assert!(retained);
    assert_eq!(fenced.phase, BrowserResourcePhase::OutcomeUnknown);
    assert!(fenced.in_flight.is_some());
    assert_eq!(alive, (true, true));
    assert!(retired.is_ok(), "{retired:?}");
    assert_eq!(exited, (true, true));
    assert_eq!(final_control.phase, BrowserResourcePhase::Closed);
}

fn config() -> NativeBrowserEngineConfig {
    NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap()
}
