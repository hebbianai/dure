use super::*;

#[test]
#[ignore = "requires isolated native app roots and configured legacy discovery"]
fn native_compatibility_source_converts_without_losing_checkout_ownership() {
    compatibility_conversion(false);
}

#[test]
#[ignore = "requires isolated native app roots and configured legacy discovery"]
fn native_existing_primary_converts_a_compatibility_source() {
    compatibility_conversion(true);
}

fn compatibility_conversion(primary_exists: bool) {
    let legacy_home = PathBuf::from(std::env::var_os("HEBBIAN_HOME").unwrap());
    let legacy_root = legacy_home.join("state/hebbian-agent/hmux-hosts");
    let fixture = fixture::ConversionFixture::new(
        SessionConversionTarget::Standalone,
        Some(legacy_root.clone()),
    );
    let catalog = product_catalog().unwrap();
    assert_ne!(catalog.discovery_root(), legacy_root);
    assert!(catalog.discovery_paths().any(|root| root == legacy_root));
    let source = fixture.source.session().descriptor().clone();
    assert_eq!(
        fixture.source.session().discovery_root(),
        Some(legacy_root.as_path())
    );
    let registration = capture_git_checkout_registration(&fixture.checkout)
        .unwrap()
        .unwrap();
    let before = read_git_checkout_claims(&registration).unwrap();
    assert_eq!(before.len(), 1);
    let mut request = fixture::request(
        "convert-checkout-namespace",
        &fixture.checkout,
        &source,
        SessionConversionTarget::Standalone,
    );
    request.confirmed = true;
    if primary_exists {
        hmux_host::local_discovery::DiscoveryRoot::create(catalog.discovery_root()).unwrap();
    }
    let converted = fixture
        .manager
        .convert_session(fixture.app.handle(), request);
    let source_after = hmux_client::probe_local_process_generation(&source.provider_process);
    let claim_after = read_git_checkout_claims(&registration).unwrap();
    let source_stays_closed = converted.as_ref().ok().map(|_| {
        matches!(
            ManagedSessionCreator::new(&fixture.current.runtime)
                .with_discovery_root(&legacy_root)
                .create_or_reconcile_and_advance(fixture.create.clone())
                .unwrap(),
            hmux_client::ManagedCreateAdvanceResolution::AuthorityUnavailable(_)
        )
    });

    // Capture behavior before exact cleanup, including the RED path where the
    // source remains live in its original namespace. Never stop by display name.
    let target = converted
        .as_ref()
        .ok()
        .and_then(|receipt| receipt.replacement_session.as_ref());
    let target_root = target.map(|target| {
        catalog
            .open(&SessionSelector::new(
                &target.session_id,
                Some(target.workspace_id.clone()),
            ))
            .unwrap()
            .discovery_root()
            .unwrap()
            .to_path_buf()
    });
    if let Some(target) = target {
        fixture
            .manager
            .terminate_standalone_session(
                &target.session_id,
                &target.workspace_id,
                Duration::from_secs(3),
            )
            .unwrap();
    }
    let remaining = read_git_checkout_claims(&registration).unwrap();
    close_source(&fixture);
    let receipt = converted.expect("conversion must find the approved compatibility source");
    assert_eq!(receipt.outcome, "converted", "{receipt:?}");
    assert_eq!(
        source_after.unwrap(),
        hmux_client::LocalProcessGenerationStatus::Absent
    );
    assert_eq!(target_root.as_deref(), Some(fixture.discovery.as_path()));
    assert_eq!(claim_after, before);
    assert_eq!(source_stays_closed, Some(true));
    assert!(
        remaining.is_empty(),
        "target close stranded the original claim"
    );
}

fn close_source(fixture: &fixture::ConversionFixture) {
    let source = fixture.source.session();
    crate::session_checkout::close(
        fixture.current.runtime.clone(),
        source.discovery_root().map(Path::to_path_buf),
        hmux_client::ManagedCreateReconcileRequest::new(
            fixture.source.receipt().idempotency_key(),
            &source.descriptor().session_id,
            &source.descriptor().workspace_id,
        )
        .unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires isolated native app roots and configured legacy discovery"]
fn native_interrupted_conversion_reopens_its_original_namespace() {
    let legacy_home = PathBuf::from(std::env::var_os("HEBBIAN_HOME").unwrap());
    let legacy_root = legacy_home.join("state/hebbian-agent/hmux-hosts");
    let fixture = fixture::ConversionFixture::new(
        SessionConversionTarget::Standalone,
        Some(legacy_root.clone()),
    );
    let catalog = product_catalog().unwrap();
    let original_catalog = LocalSessionCatalog::new(&legacy_root);
    let source = fixture.source.session().descriptor();
    let mut request = fixture::request(
        "convert-checkout-original-namespace",
        &fixture.checkout,
        source,
        SessionConversionTarget::Standalone,
    );
    request.confirmed = true;
    let state = operation::reserve(&original_catalog, request.clone(), |request, checkpoint| {
        launch::prepare(
            &original_catalog,
            request,
            checkpoint,
            fixture.current.clone(),
        )
    })
    .unwrap();
    let operation::ReservedConversion::Pending(pending) = state else {
        panic!("the original conversion must own its prepared launch");
    };
    let (prepared, mut reservation) = *pending;
    let frozen = reservation
        .operation_checkpoint()
        .unwrap()
        .canonical_payload
        .clone();
    let mut checkpoint = prepared.initial_checkpoint.clone();
    reservation.checkpoint_resume(checkpoint.clone()).unwrap();
    prepared.retain_source_checkout(&original_catalog).unwrap();
    retirement::finish(
        &original_catalog,
        &fixture.current.runtime,
        &request,
        Some(source),
        &checkpoint,
    )
    .unwrap();
    checkpoint.source_terminated = true;
    reservation.checkpoint_resume(checkpoint).unwrap();
    drop(reservation);
    // The first caller is gone. Its old namespace is now configured for lookup,
    // and neither the source nor the retry's mutable cwd hint can prepare again.
    assert_eq!(
        hmux_client::probe_local_process_generation(&source.provider_process).unwrap(),
        hmux_client::LocalProcessGenerationStatus::Absent
    );
    request.cwd = "/unavailable-retry-hint".into();
    request.expected_conversation_id = None;
    request.expected_source_fence = None;
    let converted = fixture
        .manager
        .convert_session(fixture.app.handle(), request.clone());
    let replay = converted.as_ref().ok().map(|_| {
        fixture
            .manager
            .convert_session(fixture.app.handle(), request.clone())
    });
    let original = hmux_client::recovery_journal::existing_operation::read(
        &legacy_root,
        &request.conversion_id,
        ACTION_TO_STANDALONE,
    )
    .unwrap();
    let fresh = hmux_client::recovery_journal::existing_operation::read(
        catalog.discovery_root(),
        &request.conversion_id,
        ACTION_TO_STANDALONE,
    )
    .unwrap();
    let target = converted
        .as_ref()
        .ok()
        .and_then(|receipt| receipt.replacement_session.as_ref());
    let target_root = target.map(|target| {
        catalog
            .open(&SessionSelector::new(
                &target.session_id,
                Some(target.workspace_id.clone()),
            ))
            .unwrap()
            .discovery_root()
            .unwrap()
            .to_path_buf()
    });
    if let Some(target) = target {
        fixture
            .manager
            .terminate_standalone_session(
                &target.session_id,
                &target.workspace_id,
                Duration::from_secs(3),
            )
            .unwrap();
    }
    let claims = read_git_checkout_claims(
        &capture_git_checkout_registration(&fixture.checkout)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    close_source(&fixture);
    let receipt = converted.expect("retry must reopen the original operation namespace");
    assert_eq!(receipt.outcome, "converted", "{receipt:?}");
    assert!(receipt.replayed);
    let replay = replay
        .unwrap()
        .expect("completed replay must retain the original namespace");
    assert_eq!(replay.outcome, "converted", "{replay:?}");
    let target = receipt.replacement_session.as_ref().unwrap();
    let replay_target = replay.replacement_session.as_ref().unwrap();
    assert_eq!(replay_target.session_id, target.session_id);
    assert_eq!(replay_target.terminal_epoch, target.terminal_epoch);
    assert_eq!(target_root.as_deref(), Some(legacy_root.as_path()));
    assert!(
        fresh.is_none(),
        "replay must not reserve a second operation"
    );
    let Some(hmux_client::recovery_journal::existing_operation::RecoveryOperationObservation::Completed {
        completion, ..
    }) = original else {
        panic!("the original operation must complete, not remain stranded");
    };
    assert_eq!(
        completion.operation_checkpoint.unwrap().canonical_payload,
        frozen
    );
    assert!(claims.is_empty());
}
