use super::*;
use dure_app::BrowserProfileIdV1;

mod publication;
mod retirement;
mod reuse;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn profile_replacement_keeps_the_tab_invalidates_refs_and_reopens_original_storage() {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-replacement-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profiles:replacement");
    let profiles = [
        BrowserProfileIdV1::new("profile:a").unwrap(),
        BrowserProfileIdV1::new("profile:b").unwrap(),
    ];
    let runtime = BrowserRuntime::launch_profile(
        resource.clone(),
        &config,
        &root,
        &profile_spec(&profiles[0]),
    )
    .await
    .unwrap();
    let (url, stop_http, server) = super::super::service_worker::fixture().await;
    let url = format!("{url}/");
    let evidence:Result<_,BrowserRuntimeError>=async {
        let lease=runtime.request_control(BrowserControllerId::new("profile-agent").unwrap(),None).await?.controller.ok_or("controller missing")?;
        let page=first_page(&runtime).await?;
        apply(&runtime,&lease,&page,json!({"kind":"navigate","url":url})).await?;
        let original=runtime.host.lock().await.page_identity(&page.page_id)?;
        apply(&runtime,&lease,&original,json!({"kind":"evaluate","script":"document.body.innerHTML='<button>Increment</button>';localStorage.setItem('profile','한글 A');document.cookie='profile=A;Max-Age=86400;Path=/';document.onkeyup=e=>localStorage.setItem('released-key',e.key);document.onmouseup=()=>localStorage.setItem('released-pointer','yes');true"})).await?;
        let old_ref=click_reference(&runtime.snapshot(&original, &Default::default()).await?)?;
        apply(&runtime,&lease,&original,json!({"kind":"key_down","key":"Shift"})).await?;
        apply(&runtime,&lease,&original,json!({"kind":"mouse","action":{"kind":"down"}})).await?;
        let changed=runtime.set_profile(&lease.controller_id,&authority(&runtime,&lease,&original).await,&config,&profile_spec(&profiles[1])).await?;
        let after=runtime.observe().await?;
        let next=after.pages.first().ok_or("replacement page missing")?.page.clone();
        let stale=runtime.host.lock().await.validate_element(&old_ref).map(|_|());
        let isolated=apply(&runtime,&lease,&next,json!({"kind":"evaluate","script":"({profile:localStorage.getItem('profile'),cookie:document.cookie,url:location.href})"})).await?;
        apply(&runtime,&lease,&next,json!({"kind":"evaluate","script":"localStorage.setItem('profile','한글 B');window.counter=0;document.body.innerHTML='<button onclick=counter++>Increment</button>';true"})).await?;
        let reference=click_reference(&runtime.snapshot(&next, &Default::default()).await?)?;
        let before_noop=runtime.host.lock().await.instance_for_page(&next.page_id)?.clone();
        let noop=runtime.set_profile(&lease.controller_id,&authority(&runtime,&lease,&next).await,&config,&profile_spec(&profiles[1])).await?;
        let after_noop=runtime.host.lock().await.instance_for_page(&next.page_id)?.clone();
        let valid_noop_ref=runtime.host.lock().await.validate_element(&reference).map(|_|());
        apply(&runtime,&lease,&next,json!({"kind":"click","target":{"kind":"reference","reference":reference}})).await?;
        let count=apply(&runtime,&lease,&next,json!({"kind":"evaluate","script":"counter"})).await?;
        let returned=runtime.set_profile(&lease.controller_id,&authority(&runtime,&lease,&next).await,&config,&profile_spec(&profiles[0])).await?;
        let final_view=runtime.observe().await?;
        let final_page=final_view.pages.first().ok_or("returned page missing")?.page.clone();
        let restored=apply(&runtime,&lease,&final_page,json!({"kind":"evaluate","script":"({profile:localStorage.getItem('profile'),cookie:document.cookie,key:localStorage.getItem('released-key'),pointer:localStorage.getItem('released-pointer')})"})).await?;
        Ok(((lease,original,changed,after,next,stale,isolated),(before_noop,noop,after_noop,valid_noop_ref,count,returned,final_view,restored)))
    }.await;
    let closed = runtime.close(&resource).await;
    let _ = stop_http.send(());
    let server = server.await;
    println!(
        "BROWSER_PROFILE_REPLACEMENT root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        (lease, original, changed, after, next, stale, isolated),
        (before_noop, noop, after_noop, valid_noop_ref, count, returned, final_view, restored),
    ) = evidence.unwrap();
    assert!(changed.response.success && noop.response.success && returned.response.success);
    assert_eq!(after.pages.len(), 1);
    assert_eq!(final_view.pages.len(), 1);
    assert_eq!(next.page_id, original.page_id);
    assert!(next.document_revision > original.document_revision);
    assert_eq!(stale, Err(BrowserAdmissionError::DocumentChanged));
    assert_eq!(after.pages[0].profile_id, Some(profiles[1].clone()));
    assert_eq!(after.control.controller, Some(lease.clone()));
    assert!(after.control.pointer.is_none() && after.control.keyboard.is_none());
    assert_eq!(
        isolated["result"],
        json!({"profile":null,"cookie":"","url":url})
    );
    assert_eq!(before_noop, after_noop);
    assert_eq!(valid_noop_ref, Ok(()));
    assert_eq!(count["result"], 1);
    assert_eq!(final_view.pages[0].page.page_id, original.page_id);
    assert!(final_view.pages[0].page.document_revision > next.document_revision);
    assert_eq!(final_view.pages[0].profile_id, Some(profiles[0].clone()));
    assert_eq!(final_view.control.controller, Some(lease));
    assert_eq!(
        restored["result"],
        json!({"profile":"한글 A","cookie":"profile=A","key":"Shift","pointer":"yes"})
    );
}
