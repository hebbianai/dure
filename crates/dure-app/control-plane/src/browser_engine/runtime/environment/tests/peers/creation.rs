use super::*;
use std::collections::BTreeSet;

mod destination;
mod response_loss;
mod retained;

async fn live_targets(cdp: &mut BrowserCdp) -> Result<BTreeSet<String>, BrowserRuntimeError> {
    let census = cdp.request("Target.getTargets", json!({}), None).await?;
    census["targetInfos"]
        .as_array()
        .ok_or("fixture_census_missing")?
        .iter()
        .map(|info| {
            info["targetId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "fixture_target_missing".into())
        })
        .collect()
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn resource_close_waits_for_its_canceled_construction_to_settle() {
    let (runtime, identity, root) = launch("shared:closing-creation").await;
    let runtime = Arc::new(runtime);
    let evidence: Result<_, BrowserRuntimeError> = async {
        let mut cdp = runtime.test_binding().cdp.clone();
        let before = live_targets(&mut cdp).await?;
        let worker = runtime.test_binding().engine.clone().lock_owned().await;
        let owner = Arc::clone(&runtime);
        let peer_identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("shared:closing-creation-peer").unwrap(),
            generation: identity.generation.clone(),
            workspace_id: BrowserWorkspaceId::new("workspace:closing-creation-peer").unwrap(),
        };
        let creation = tokio::spawn(async move { owner.share_instance(peer_identity).await });
        let created = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if live_targets(&mut cdp).await?.difference(&before).count() == 1 {
                    return Ok::<_, BrowserRuntimeError>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        creation.abort();
        let canceled = matches!(creation.await, Err(error) if error.is_cancelled());
        let owner = Arc::clone(&runtime);
        let closing_identity = identity.clone();
        let mut closing = tokio::spawn(async move { owner.close(&closing_identity).await });
        let early = tokio::time::timeout(Duration::from_secs(5), &mut closing).await;
        let premature = early.is_ok();
        drop(worker);
        let closed = match early {
            Ok(result) => result,
            Err(_) => closing.await,
        };
        let exited = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let worker_exited = runtime
                    .test_binding()
                    .engine
                    .lock()
                    .await
                    .child
                    .try_wait()
                    .map_err(|_| "fixture_worker_wait_failed")?
                    .is_some();
                if worker_exited && runtime.test_binding().instance.browser_has_exited().await? {
                    return Ok::<_, BrowserRuntimeError>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        Ok((created, canceled, premature, closed, exited))
    }
    .await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_CREATION_CLOSE root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (created, canceled, premature, closed, exited) = evidence.unwrap();
    assert!(matches!(created, Ok(Ok(()))), "{created:?}");
    assert!(canceled);
    assert!(matches!(closed, Ok(Ok(()))), "{closed:?}");
    assert!(matches!(exited, Ok(Ok(()))), "{exited:?}");
    assert!(
        !premature,
        "Close must await its still-running native construction"
    );
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn canceling_resource_creation_retires_its_unpublished_page() {
    let (runtime, identity, root) = launch("shared:canceled-creation").await;
    let runtime = Arc::new(runtime);
    let evidence: Result<_, BrowserRuntimeError> = async {
        let original = runtime.observe().await?.pages[0].page.clone();
        let mut cdp = runtime.test_binding().cdp.clone();
        let before = live_targets(&mut cdp).await?;
        // Construction needs this actual worker lock before it can publish a
        // runtime. Hold it until the native target exists and cancel the caller.
        let worker = runtime.test_binding().engine.clone().lock_owned().await;
        let owner = Arc::clone(&runtime);
        let peer_identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("shared:canceled-peer").unwrap(),
            generation: identity.generation.clone(),
            workspace_id: BrowserWorkspaceId::new("workspace:canceled-peer").unwrap(),
        };
        let creation = tokio::spawn(async move { owner.share_instance(peer_identity).await });
        let created = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let after = live_targets(&mut cdp).await?;
                let created = after.difference(&before).cloned().collect::<Vec<_>>();
                if !created.is_empty() {
                    return Ok::<_, BrowserRuntimeError>(created);
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        creation.abort();
        let canceled = matches!(creation.await, Err(error) if error.is_cancelled());
        drop(worker);
        let created = created.map_err(|_| "fixture_creation_not_observed")??;
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let live = live_targets(&mut cdp).await?;
                if created.iter().all(|target| !live.contains(target)) {
                    return Ok::<_, BrowserRuntimeError>(());
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
        Ok((created, canceled, gone, original, remaining, worker_live))
    }
    .await;
    let retired = runtime.close(&identity).await;
    let browser_exited = runtime.test_binding().instance.browser_has_exited().await;
    println!(
        "BROWSER_CANCELED_CREATION root={} evidence={evidence:?} retired={retired:?} browser_exited={browser_exited:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    assert!(matches!(browser_exited, Ok(true)), "{browser_exited:?}");
    let (created, canceled, gone, original, remaining, worker_live) = evidence.unwrap();
    assert_eq!(created.len(), 1);
    assert!(
        canceled,
        "The caller must be canceled before receiving its runtime"
    );
    assert!(worker_live);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].page, original);
    assert!(matches!(gone, Ok(Ok(()))), "{gone:?}");
}
