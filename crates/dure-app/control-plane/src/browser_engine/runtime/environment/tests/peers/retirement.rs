use super::*;

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn final_instance_retirement_completes_a_dropped_resources_pending_cleanup() {
    let (runtime, identity, root) = launch("shared:dropped-retirement").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let peer = runtime
            .share_instance(BrowserResourceIdentity {
                resource_id: BrowserResourceId::new("shared:dropped-retirement-peer").unwrap(),
                generation: identity.generation.clone(),
                workspace_id: BrowserWorkspaceId::new("workspace:dropped-retirement").unwrap(),
            })
            .await?;
        let peer_identity = peer.control().await.resource;
        let retired_host = Arc::clone(&peer.host);
        let mut retired_cdp = peer.test_binding().cdp.clone();
        let caller = Arc::downgrade(&peer.test_binding().instance);
        // The real registration is gone, so the pending creation barrier cannot
        // confirm resource retirement. Drop must retain its cleanup authority.
        peer.test_binding().events.close().await;
        let first = peer.close(&peer_identity).await;
        drop(peer);
        let caller_gone = tokio::time::timeout(Duration::from_secs(5), async {
            while caller.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let before = retired_host.lock().await.projection().phase;
        let surviving = runtime.observe().await?.pages;
        runtime.close(&identity).await?;
        let worker_exited = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_some();
        let browser_exited = runtime.test_binding().instance.browser_has_exited().await?;
        let after = retired_host.lock().await.projection().phase;
        let connection = retired_cdp
            .request("Browser.getVersion", json!({}), None)
            .await;
        retired_cdp.retire().await;
        Ok((
            first,
            caller_gone,
            before,
            surviving.len(),
            worker_exited,
            browser_exited,
            after,
            connection,
        ))
    }
    .await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_DROPPED_RETIREMENT root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (first, caller_gone, before, surviving, worker_exited, browser_exited, after, connection) =
        evidence.unwrap();
    assert!(first.is_err());
    assert!(
        caller_gone.is_ok(),
        "The dropped caller must release its lease handle"
    );
    assert_eq!(before, BrowserResourcePhase::Retiring);
    assert_eq!(surviving, 1);
    assert!(worker_exited && browser_exited);
    assert_eq!(after, BrowserResourcePhase::Closed);
    assert_eq!(connection, Err("browser_cdp_retired"));
}

#[tokio::test]
#[ignore = "requires pinned Chromium and native browser engine"]
async fn final_resource_retirement_resolves_a_peers_uncertain_page_retirement() {
    let (runtime, identity, root) = launch("shared:retirement-fault").await;
    let mut peers = Vec::new();
    let evidence: Result<_, BrowserRuntimeError> = async {
        peers.push(
            runtime
                .share_instance(BrowserResourceIdentity {
                    resource_id: BrowserResourceId::new("shared:retirement-peer").unwrap(),
                    generation: identity.generation.clone(),
                    workspace_id: BrowserWorkspaceId::new("workspace:retirement-peer").unwrap(),
                })
                .await?,
        );
        // Remove the actual registration before its resource can drain the
        // creation barrier. No missing-source fallback may claim page closure.
        peers[0].test_binding().events.close().await;
        let peer_identity = peers[0].control().await.resource;
        let first = peers[0].close(&peer_identity).await;
        let pending = peers[0].control().await.phase;
        runtime.close(&identity).await?;
        let worker_exited = runtime
            .test_binding()
            .engine
            .lock()
            .await
            .child
            .try_wait()
            .map_err(|_| "fixture_worker_wait_failed")?
            .is_some();
        let browser_exited = runtime.test_binding().instance.browser_has_exited().await?;
        let resolved = peers[0].close(&peer_identity).await;
        let phase = peers[0].control().await.phase;
        Ok((
            first,
            pending,
            worker_exited,
            browser_exited,
            resolved,
            phase,
        ))
    }
    .await;
    let mut peer_retirements = Vec::new();
    for peer in &peers {
        peer_retirements.push(peer.close(&peer.control().await.resource).await);
    }
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_FINAL_RETIREMENT root={} evidence={evidence:?} peers={peer_retirements:?} retired={retired:?}",
        root.display()
    );
    assert!(
        peer_retirements.iter().all(Result::is_ok),
        "{peer_retirements:?}"
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (first, pending, worker_exited, browser_exited, resolved, phase) = evidence.unwrap();
    assert!(first.is_err());
    assert_eq!(pending, BrowserResourcePhase::Retiring);
    assert!(
        worker_exited,
        "The last active resource must retire the actual instance even while another resource's page retirement is unresolved"
    );
    assert!(resolved.is_ok(), "{resolved:?}");
    assert!(browser_exited, "The owned Chromium child must also exit");
    assert_eq!(phase, BrowserResourcePhase::Closed);
}
