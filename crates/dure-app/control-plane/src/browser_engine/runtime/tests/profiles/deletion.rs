use super::*;
use crate::browser_engine::runtime::BrowserProfileAction;
use dure_app::BrowserProfileIdV1;
use std::sync::atomic::Ordering;

mod concurrent;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn deleting_canceled_action_owner_preserves_other_profile_control_and_document() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-delete-action-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:delete-action");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut http = GatedPage::start().await;
    let evidence:Result<_,BrowserRuntimeError>=async {
        let lease=runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.ok_or("controller missing")?;
        let first=first_page(&runtime).await?;
        apply(&runtime,&lease,&first,json!({"kind":"navigate","url":http.url})).await?;
        let original=runtime.host.lock().await.page_identity(&first.page_id)?;
        let original_owner=Arc::clone(&runtime.execution(&original).await?.binding.instance);
        let admitted=authority(&runtime,&lease,&original).await;
        let cloned=runtime.admit_profile_change(&lease.controller_id,&admitted,&config,BrowserProfileAction::Clone,&profile_spec(&b),None).await?.finish().await?;
        let selected:BrowserPageIdentity=serde_json::from_value(cloned.response.data["page"].clone()).map_err(|_|"retained page missing")?;
        apply(&runtime,&lease,&selected,json!({"kind":"evaluate","script":"localStorage.setItem('retained','한글 저장');window.retained='원래 문서';true"})).await?;
        let selected=runtime.host.lock().await.page_identity(&selected.page_id)?;
        let retained_owner=Arc::clone(&runtime.execution(&selected).await?.binding.instance);
        http.armed.store(true,Ordering::SeqCst);
        let mut navigating=Box::pin(apply(&runtime,&lease,&original,json!({"kind":"navigate","url":http.url})));
        tokio::select! {
            result=&mut navigating=>return Err(if result.is_ok(){"fixture navigation finished before gate"}else{"fixture navigation failed before gate"}.into()),
            request=timeout(Duration::from_secs(15),http.requested.recv())=>{request.map_err(|_|"navigation request deadline")?.ok_or("navigation request lost")?;},
        }
        drop(navigating);
        let fenced=timeout(Duration::from_secs(5),async {
            loop {
                let changed=runtime.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
                let control=runtime.control().await;
                if control.phase==BrowserResourcePhase::OutcomeUnknown{return control;}
                changed.await;
            }
        }).await.map_err(|_|"canceled action fence missing")?;
        let deleting=runtime.begin_profile_retirement(&a).await?;
        let _=http.release.send(true);
        deleting.await?;
        let after=runtime.control().await;
        let pages=runtime.host.lock().await.pages();
        let owners=(original_owner.browser_has_exited().await?,retained_owner.browser_has_exited().await?);
        let value=apply(&runtime,&lease,&selected,json!({"kind":"evaluate","script":"({stored:localStorage.getItem('retained'),document:window.retained})"})).await;
        Ok((fenced,after,pages,selected,owners,value))
    }.await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_DELETE_CANCELED_ACTION root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (fenced, after, pages, selected, owners, value) = evidence.unwrap();
    assert!(fenced.in_flight.is_some());
    assert_eq!(owners, (true, false));
    assert_eq!(pages, vec![selected]);
    assert_eq!(after.phase, BrowserResourcePhase::Ready);
    assert!(after.in_flight.is_none());
    assert_eq!(
        value.unwrap()["result"],
        json!({"stored":"한글 저장","document":"원래 문서"})
    );
}
