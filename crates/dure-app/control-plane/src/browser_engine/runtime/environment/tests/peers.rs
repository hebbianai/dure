use super::*;
use std::sync::Arc;

mod creation;
mod retirement;
mod shared;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn retiring_a_native_worker_preserves_another_pages_admitted_emulation() {
    let (runtime, identity, root) = launch("environment:peer-worker").await;
    let mut workers = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = runtime.observe().await?.pages[0].page.clone();
        let lease = runtime
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .await?
            .controller
            .unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"new_page","url":"about:blank"}))
            .await?;
        let other = runtime
            .observe()
            .await?
            .pages
            .into_iter()
            .find(|entry| entry.page.page_id != page.page_id)
            .ok_or("fixture_peer_page_missing")?
            .page;
        let peer_identity = |name| BrowserResourceIdentity {
            resource_id: BrowserResourceId::new(name).unwrap(),
            generation: identity.generation.clone(),
            workspace_id: BrowserWorkspaceId::new("workspace:peer").unwrap(),
        };
        workers.push(runtime.share_instance(peer_identity("peer:first")).await?);

        for action in [
            json!({"kind":"viewport","width":701,"height":503}),
            json!({"kind":"media","media":"print","color_scheme":"dark"}),
            json!({"kind":"offline","offline":true}),
        ] {
            apply(&runtime, &lease, &page, json!({"kind":"environment","action":action})).await?;
        }
        let inspect = json!({"kind":"evaluate","script":"({width:innerWidth,height:innerHeight,print:matchMedia('print').matches,dark:matchMedia('(prefers-color-scheme:dark)').matches,online:navigator.onLine})"});
        let before = apply(&runtime, &lease, &page, inspect.clone()).await?.response.data["result"].clone();
        workers[0].close(&workers[0].control().await.resource).await?;
        let after_retirement = apply(&runtime, &lease, &page, inspect.clone()).await?.response.data["result"].clone();
        workers.push(runtime.share_instance(peer_identity("peer:replacement")).await?);
        let after_replacement = apply(&runtime, &lease, &page, inspect.clone()).await?.response.data["result"].clone();
        workers[1].close(&workers[1].control().await.resource).await?;
        // Observe the actual peer through its production action path after
        // resource retirement; do not reapply settings to mask a detached handler.
        let after_second_retirement = apply(&runtime, &lease, &page, inspect).await?.response.data["result"].clone();
        let pages = runtime.observe().await?.pages;
        Ok((before, after_retirement, after_replacement, after_second_retirement, page, other, pages))
    }.await;
    let mut worker_retirements = Vec::new();
    for worker in &mut workers {
        worker_retirements.push(worker.close(&worker.control().await.resource).await);
    }
    let retired = runtime.close(&identity).await;
    let worker_exited = runtime
        .test_binding()
        .engine
        .lock()
        .await
        .child
        .try_wait()
        .unwrap()
        .is_some();
    println!(
        "BROWSER_PEER_EMULATION root={} evidence={evidence:?} workers={worker_retirements:?} retired={retired:?}",
        root.display()
    );
    assert!(
        worker_retirements.iter().all(Result::is_ok),
        "{worker_retirements:?}"
    );
    assert!(retired.is_ok(), "{retired:?}");
    assert!(
        worker_exited,
        "The final resource must await the actual worker exit"
    );
    let (before, after_retirement, after_replacement, after_second_retirement, page, other, pages) =
        evidence.unwrap();
    assert_eq!(
        before,
        json!({"width":701,"height":503,"print":true,"dark":true,"online":false})
    );
    assert_eq!(pages.len(), 2);
    assert!(pages.iter().any(|entry| entry.page == page));
    assert!(pages.iter().any(|entry| entry.page == other));
    assert_eq!(
        after_retirement, before,
        "Retiring a peer worker must preserve admitted emulation"
    );
    assert_eq!(
        after_replacement, before,
        "Attaching a replacement peer worker must preserve admitted emulation"
    );
    assert_eq!(after_second_retirement, before);
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn dropping_a_shared_resource_retires_its_pages_without_retiring_the_peer() {
    let (runtime, identity, root) = launch("environment:dropped-peer").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let original = runtime.observe().await?.pages[0].page.clone();
        let peer = runtime
            .share_instance(BrowserResourceIdentity {
                resource_id: BrowserResourceId::new("dropped:peer").unwrap(),
                generation: identity.generation.clone(),
                workspace_id: BrowserWorkspaceId::new("workspace:dropped").unwrap(),
            })
            .await?;
        let page = peer.observe().await?.pages[0].page.clone();
        let target = peer.host.lock().await.target_for(&page)?.clone();
        let retired_host = Arc::clone(&peer.host);
        drop(peer);
        let mut cdp = runtime.test_binding().cdp.clone();
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let census = cdp.request("Target.getTargets", json!({}), None).await?;
                let targets = census["targetInfos"]
                    .as_array()
                    .ok_or("fixture_census_missing")?;
                let closed =
                    retired_host.lock().await.projection().phase == BrowserResourcePhase::Closed;
                if closed
                    && !targets
                        .iter()
                        .any(|info| info["targetId"].as_str() == Some(target.as_str()))
                {
                    return Ok::<_, &'static str>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let remaining = runtime.observe().await?.pages;
        let worker_live = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_none();
        Ok((gone, original, remaining, worker_live))
    }
    .await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DROPPED_RESOURCE root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (gone, original, remaining, worker_live) = evidence.unwrap();
    assert!(matches!(gone, Ok(Ok(()))), "{gone:?}");
    assert!(worker_live);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].page, original);
}
