use super::*;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn destination_close_joins_its_shared_construction_and_preserves_the_origin() {
    destination_close(false).await;
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn destination_close_joins_canceled_shared_construction_and_preserves_the_origin() {
    destination_close(true).await;
}

async fn destination_close(cancel: bool) {
    let (runtime, identity, root) = launch("shared:destination-close-origin").await;
    let runtime = Arc::new(runtime);
    let destination_id = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("shared:destination-close").unwrap(),
        generation: identity.generation.clone(),
        workspace_id: BrowserWorkspaceId::new("workspace:destination-close").unwrap(),
    };
    let destination = Arc::new(BrowserRuntime::new(destination_id.clone(), &root));
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .ok_or("controller missing")?;
        apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.destinationProof='원본 유지';true"}),
        )
        .await?;
        let instance = runtime
            .host
            .lock()
            .await
            .instance_for_page(&page.page_id)?
            .clone();
        let mut cdp = runtime.test_binding().cdp.clone();
        let before = live_targets(&mut cdp).await?;
        let worker = runtime.test_binding().engine.clone().lock_owned().await;
        let source = Arc::clone(&runtime);
        let owner = Arc::clone(&destination);
        let mut creation = Some(tokio::spawn(async move {
            owner.attach_shared_from(&source, &instance).await
        }));
        // A Host page proves destination observation has attached. The worker
        // lock still prevents construction from completing publication.
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if destination.host.lock().await.pages().len() == 1 {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let targets = live_targets(&mut cdp).await?;
        let canceled = if cancel {
            let task = creation.take().unwrap();
            task.abort();
            matches!(task.await, Err(error) if error.is_cancelled())
        } else {
            false
        };
        let owner = Arc::clone(&destination);
        let closing_id = destination_id.clone();
        let mut closing = tokio::spawn(async move { owner.close(&closing_id).await });
        let fenced = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if destination.control().await.phase == BrowserResourcePhase::Retiring {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let early = tokio::time::timeout(Duration::from_millis(500), &mut closing).await;
        let premature = early.is_ok();
        drop(worker);
        let closed = match early {
            Ok(result) => result,
            Err(_) => closing.await,
        };
        let rejected = match creation {
            Some(task) => matches!(task.await, Ok(Err(_))),
            None => canceled,
        };
        let after = live_targets(&mut cdp).await?;
        let control = destination.control().await;
        let remaining = runtime.observe().await?.pages;
        let exited = runtime.test_binding().instance.browser_has_exited().await?;
        let value = apply(
            &runtime,
            &lease,
            &page,
            json!({"kind":"evaluate","script":"window.destinationProof"}),
        )
        .await?
        .response
        .data["result"]
            .clone();
        Ok((
            observed,
            targets.difference(&before).count(),
            fenced,
            premature,
            closed,
            rejected,
            before,
            after,
            control,
            page,
            remaining,
            (exited, value),
        ))
    }
    .await;
    let destination_closed = destination.close(&destination_id).await;
    let origin_closed = runtime.close(&identity).await;
    println!(
        "BROWSER_SHARED_DESTINATION_CLOSE cancel={cancel} root={} evidence={evidence:?} destination={destination_closed:?} origin={origin_closed:?}",
        root.display()
    );
    assert!(destination_closed.is_ok(), "{destination_closed:?}");
    assert!(origin_closed.is_ok(), "{origin_closed:?}");
    let (
        observed,
        created,
        fenced,
        premature,
        closed,
        rejected,
        before,
        after,
        control,
        page,
        remaining,
        (exited, value),
    ) = evidence.unwrap();
    assert!(observed.is_ok(), "{observed:?}");
    assert_eq!(created, 1);
    assert!(fenced.is_ok(), "{fenced:?}");
    assert!(!premature, "Close must join the retained construction task");
    assert!(matches!(closed, Ok(Ok(()))), "{closed:?}");
    assert!(rejected);
    assert_eq!(
        before, after,
        "Only the unpublished destination target retires"
    );
    assert_eq!(control.phase, BrowserResourcePhase::Closed);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].page, page);
    assert!(!exited);
    assert_eq!(value, "원본 유지");
}
