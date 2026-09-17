use super::*;
use std::collections::BTreeSet;
use std::sync::atomic::Ordering;

mod interaction;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn new_profile_navigation_preserves_the_public_logical_page_inventory() {
    prove_publication(false).await;
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn existing_profile_navigation_preserves_the_public_logical_page_inventory() {
    prove_publication(true).await;
}

async fn prove_publication(existing: bool) {
    let config = NativeBrowserEngineConfig::pinned(
        Path::new(&std::env::var("DURE_BROWSER_TEST_BINARY").unwrap()),
        Path::new(&std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap()),
    )
    .unwrap();
    let root = tempfile::Builder::new()
        .prefix("dure-profile-publication-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    let resource = identity("profile:publication");
    let profiles = [
        BrowserProfileIdV1::new("profile:a").unwrap(),
        BrowserProfileIdV1::new("profile:b").unwrap(),
    ];
    let runtime = Arc::new(
        BrowserRuntime::launch_profile(
            resource.clone(),
            &config,
            &root,
            &profile_spec(&profiles[0]),
        )
        .await
        .unwrap(),
    );
    let mut http = GatedPage::start().await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let lease = runtime
            .request_control(BrowserControllerId::new("profile-agent").unwrap(), None)
            .await?
            .controller
            .ok_or("fixture_controller_missing")?;
        let first = first_page(&runtime).await?;
        let original_instance = runtime
            .host
            .lock()
            .await
            .instance_for_page(&first.page_id)?
            .clone();
        let original_owner = Arc::clone(&runtime.execution(&first).await?.binding.instance);
        let destination_instance = if existing {
            Some(
                runtime
                    .launch_binding(&config, Some(&profile_spec(&profiles[1])))
                    .await?,
            )
        } else {
            None
        };
        apply(
            &runtime,
            &lease,
            &first,
            json!({"kind":"navigate","url":http.url}),
        )
        .await?;
        let original = runtime.host.lock().await.page_identity(&first.page_id)?;
        let before = runtime.host.lock().await.pages();
        let admitted = authority(&runtime, &lease, &original).await;
        http.armed.store(true, Ordering::SeqCst);
        let (owned, config, profile, controller) = (
            Arc::clone(&runtime),
            config.clone(),
            profiles[1].clone(),
            lease.controller_id.clone(),
        );
        let mut action = tokio::spawn(async move {
            owned
                .set_profile(&controller, &admitted, &config, &profile_spec(&profile))
                .await
        });
        let requested = timeout(Duration::from_secs(20), http.requested.recv()).await;
        let (during, control) = {
            let host = runtime.host.lock().await;
            (host.pages(), host.projection())
        };
        let pending = !action.is_finished();
        // Settle every gate/task before making any behavioral assertion.
        let _ = http.release.send(true);
        let completed = timeout(Duration::from_secs(40), &mut action).await;
        if completed.is_err() {
            action.abort();
            let _ = action.await;
        }
        let after = runtime.observe().await;
        let original_exited = original_owner.browser_has_exited().await;
        Ok((
            before,
            original,
            original_instance,
            destination_instance,
            requested,
            during,
            control,
            pending,
            completed,
            after,
            original_exited,
            lease,
        ))
    }
    .await;
    let _ = http.release.send(true);
    let retired = runtime.close(&resource).await;
    let server = http.close().await;
    println!(
        "BROWSER_PROFILE_PUBLICATION existing={existing} root={} evidence={evidence:?} cleanup={retired:?} server={server:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    assert!(server.is_ok(), "{server:?}");
    let (
        before,
        original,
        original_instance,
        destination_instance,
        requested,
        during,
        control,
        pending,
        completed,
        after,
        original_exited,
        lease,
    ) = evidence.unwrap();
    assert!(matches!(requested, Ok(Some(()))), "{requested:?}");
    assert!(
        pending,
        "the fixture observed the request before releasing its response"
    );
    assert_eq!(control.controller, Some(lease.clone()));
    assert!(control.in_flight.is_some());
    let ids = |pages: &[BrowserPageIdentity]| {
        pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(
        ids(&during),
        ids(&before),
        "a native replacement must not publish another logical tab while navigation waits"
    );
    assert!(completed.unwrap().unwrap().unwrap().response.success);
    let after = after.unwrap();
    assert_eq!(
        ids(&after
            .pages
            .iter()
            .map(|page| page.page.clone())
            .collect::<Vec<_>>()),
        ids(&before)
    );
    let replaced = after
        .pages
        .iter()
        .find(|page| page.page.page_id == original.page_id)
        .unwrap();
    assert!(replaced.page.document_revision > original.document_revision);
    assert_eq!(replaced.profile_id, Some(profiles[1].clone()));
    assert_eq!(replaced.url, http.url);
    assert_eq!(after.control.controller, Some(lease));
    assert!(after.control.in_flight.is_none());
    assert!(original_exited.unwrap());
    if let Some(destination) = destination_instance {
        assert_ne!(destination, original_instance);
    }
}
