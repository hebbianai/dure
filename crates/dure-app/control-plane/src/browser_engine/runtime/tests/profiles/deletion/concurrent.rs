use super::*;

async fn prepare(
    runtime: &BrowserRuntime,
    config: &NativeBrowserEngineConfig,
    url: &str,
    retained_profile: &BrowserProfileIdV1,
) -> Result<
    (
        BrowserControllerLease,
        BrowserPageIdentity,
        BrowserPageIdentity,
    ),
    BrowserRuntimeError,
> {
    let lease = runtime
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .await?
        .controller
        .ok_or("controller missing")?;
    let first = first_page(runtime).await?;
    apply(
        runtime,
        &lease,
        &first,
        json!({"kind":"navigate","url":url}),
    )
    .await?;
    let original = runtime.host.lock().await.page_identity(&first.page_id)?;
    let admitted = authority(runtime, &lease, &original).await;
    let cloned = runtime
        .admit_profile_change(
            &lease.controller_id,
            &admitted,
            config,
            BrowserProfileAction::Clone,
            &profile_spec(retained_profile),
            None,
        )
        .await?
        .finish()
        .await?;
    let retained: BrowserPageIdentity =
        serde_json::from_value(cloned.response.data["page"].clone())
            .map_err(|_| "retained page missing")?;
    apply(runtime,&lease,&retained,json!({"kind":"evaluate","script":"localStorage.setItem('retained','한글 저장');window.retained='원래 문서';true"})).await?;
    let retained = runtime.host.lock().await.page_identity(&retained.page_id)?;
    Ok((lease, original, retained))
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn deleting_one_owner_of_canceled_clone_keeps_destination_fenced_until_its_retirement() {
    scenario(true).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn deleting_while_navigation_caller_waits_preserves_the_other_profile() {
    scenario(false).await;
}

async fn scenario(cross_profile: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-delete-concurrent-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:delete-concurrent");
    let a = BrowserProfileIdV1::new("profile:a").unwrap();
    let b = BrowserProfileIdV1::new("profile:b").unwrap();
    let c = BrowserProfileIdV1::new("profile:c").unwrap();
    let runtime =
        BrowserRuntime::launch_profile(resource.clone(), &config, &root, &profile_spec(&a))
            .await
            .unwrap();
    let mut http = GatedPage::start().await;
    let evidence:Result<_,BrowserRuntimeError>=async {
        let (lease,original,retained)=prepare(&runtime,&config,&http.url,&b).await?;
        let original_owner=Arc::clone(&runtime.execution(&original).await?.binding.instance);
        let retained_owner=Arc::clone(&runtime.execution(&retained).await?.binding.instance);
        let admitted=authority(&runtime,&lease,&original).await;
        let profile = profile_spec(&c);
        let action=BrowserProfileAction::Clone;
        http.armed.store(true,Ordering::SeqCst);
        let mut pending=Box::pin(async {
            if cross_profile {
                runtime.admit_profile_change(&lease.controller_id,&admitted,&config,action,&profile,None).await?.finish().await.map(|_|())
            } else {
                apply(&runtime,&lease,&original,json!({"kind":"navigate","url":http.url})).await.map(|_|())
            }
        });
        tokio::select! {
            result=&mut pending=>return Err(if result.is_ok(){"fixture action finished before gate"}else{"fixture action failed before gate"}.into()),
            request=timeout(Duration::from_secs(15),http.requested.recv())=>{request.map_err(|_|"native request deadline")?.ok_or("native request lost")?;},
        }
        let destination=if cross_profile {
            let page=runtime.host.lock().await.pages().into_iter().find(|p|p.page_id!=original.page_id && p.page_id!=retained.page_id).ok_or("destination page missing")?;
            Some(Arc::clone(&runtime.execution(&page).await?.binding.instance))
        } else {None};
        let (after_source,destination_alive,finished)=if cross_profile {
            drop(pending);
            timeout(Duration::from_secs(5),async {
                loop {
                    let changed=runtime.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
                    if runtime.control().await.phase==BrowserResourcePhase::OutcomeUnknown {return;}
                    changed.await;
                }
            }).await.map_err(|_|"clone cancellation fence missing")?;
            runtime.begin_profile_retirement(&a).await?.await?;
            let after_source=runtime.control().await;
            let alive=!destination.as_ref().unwrap().browser_has_exited().await?;
            let _=http.release.send(true);
            runtime.begin_profile_retirement(&c).await?.await?;
            (after_source,Some(alive),None)
        } else {
            let retiring=runtime.begin_profile_retirement(&a).await?;
            let _=http.release.send(true);
            let (finished,retired)=tokio::join!(pending.as_mut(),retiring);
            retired?;
            (runtime.control().await,None,Some(finished))
        };
        let after=runtime.control().await;
        let pages=runtime.host.lock().await.pages();
        let owners=(original_owner.browser_has_exited().await?,retained_owner.browser_has_exited().await?);
        let destination_exited=match destination {Some(owner)=>Some(owner.browser_has_exited().await?),None=>None};
        let value=apply(&runtime,&lease,&retained,json!({"kind":"evaluate","script":"({stored:localStorage.getItem('retained'),document:window.retained})"})).await;
        Ok((after_source,destination_alive,finished,after,pages,retained,owners,destination_exited,value))
    }.await;
    let _ = http.release.send(true);
    let closed = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_DELETE_CONCURRENT cross={cross_profile} root={} evidence={evidence:?} cleanup={closed:?} server={server:?}",
        root.display()
    );
    assert!(closed.is_ok(), "{closed:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        after_source,
        destination_alive,
        finished,
        after,
        pages,
        retained,
        owners,
        destination_exited,
        value,
    ) = evidence.unwrap();
    if cross_profile {
        assert_eq!(after_source.phase, BrowserResourcePhase::OutcomeUnknown);
        assert!(after_source.in_flight.is_some());
        assert_eq!(destination_alive, Some(true));
        assert_eq!(destination_exited, Some(true));
    } else {
        assert!(finished.is_some());
        assert!(destination_alive.is_none() && destination_exited.is_none());
    }
    assert_eq!(owners, (true, false));
    assert_eq!(pages, vec![retained]);
    assert_eq!(after.phase, BrowserResourcePhase::Ready);
    assert!(after.in_flight.is_none());
    assert_eq!(
        value.unwrap()["result"],
        json!({"stored":"한글 저장","document":"원래 문서"})
    );
}
