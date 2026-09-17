use super::*;

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_source_close_preserves_its_active_standalone_replacement_checkout() {
    conversion_fixture(ConversionCase::StandaloneSourceClose);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_standalone_managed_roundtrip_releases_the_original_checkout() {
    conversion_fixture(ConversionCase::StandaloneRoundtrip);
}

pub(super) fn assert_roundtrip_releases_checkout(
    manager: &HmuxManager,
    app: &AppHandle<tauri::test::MockRuntime>,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    source_key: &str,
) {
    let registration = capture_git_checkout_registration(Path::new(&request.cwd))
        .unwrap()
        .unwrap();
    let original = read_git_checkout_claims(&registration).unwrap();
    assert_eq!(original.len(), 1);
    let converted = manager.convert_session(app, request.clone()).unwrap();
    assert_eq!(converted.outcome, "converted", "{converted:?}");
    let standalone = converted.replacement_session.unwrap();
    let catalog = product_catalog().unwrap();
    let standalone_descriptor = catalog
        .find(&SessionSelector::new(
            &standalone.session_id,
            Some(standalone.workspace_id.clone()),
        ))
        .unwrap();
    let returned = manager
        .convert_session(
            app,
            SessionConversionRequest {
                conversion_id: "convert-checkout-roundtrip".into(),
                source_session_id: standalone.session_id.clone(),
                source_workspace_id: standalone.workspace_id.clone(),
                expected_source_fence: None,
                target: SessionConversionTarget::Managed,
                ..request.clone()
            },
        )
        .unwrap();
    assert_eq!(returned.outcome, "converted", "{returned:?}");
    let target = returned.replacement_session.unwrap();
    let target_descriptor = catalog
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(read_git_checkout_claims(&registration).unwrap(), original);
    manager
        .stop_managed_create_chain_v2(
            app,
            returned.replacement_idempotency_key.as_deref().unwrap(),
            &target.session_id,
            &target.workspace_id,
        )
        .unwrap();
    for descriptor in [source, &standalone_descriptor, &target_descriptor] {
        assert_fixture_session_closed(&catalog, descriptor);
    }
    let remaining = read_git_checkout_claims(&registration).unwrap().len();
    let removal = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-closed-conversion-roundtrip").unwrap(),
    )
    .unwrap()
    .admit()
    .and_then(|permit| permit.abort())
    .map_err(|error| error.code);
    // Teardown follows the actual claim/removal observations, not vice versa.
    manager
        .stop_managed_create_chain_v2(app, source_key, &source.session_id, &source.workspace_id)
        .unwrap();
    assert_eq!((remaining, removal), (0, Ok(())));
}

pub(super) fn assert_source_close_preserves_target(
    manager: &HmuxManager,
    app: &AppHandle<tauri::test::MockRuntime>,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    source_key: &str,
) {
    let catalog = product_catalog().unwrap();
    let registration = capture_git_checkout_registration(Path::new(&request.cwd))
        .unwrap()
        .unwrap();
    let original = read_git_checkout_claims(&registration).unwrap();
    assert_eq!(original.len(), 1);
    let converted = manager.convert_session(app, request.clone()).unwrap();
    assert_eq!(converted.outcome, "converted", "{converted:?}");
    let target = converted.replacement_session.unwrap();
    let selector = SessionSelector::new(&target.session_id, Some(target.workspace_id.clone()));
    let before = catalog.find(&selector).unwrap();

    // Another observer closes the old logical source after the new pane is
    // already active. Its obsolete binding cannot release the retained claim.
    manager
        .stop_managed_create_chain_v2(app, source_key, &source.session_id, &source.workspace_id)
        .unwrap();
    let retained = read_git_checkout_claims(&registration).unwrap() == original;
    let current = catalog.find(&selector).unwrap();
    let unchanged = same_session_generation(&before, &current)
        && probe_local_session(&catalog, &selector) == SessionProbeStatus::Healthy;
    let removal_blocked = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-active-standalone-conversion").unwrap(),
    )
    .unwrap()
    .admit()
    .and_then(|permit| permit.abort())
    .is_err_and(|error| error.code == "checkout_use_in_use");

    // Observe before teardown. Target-close claim release has separate coverage;
    // the outer guardian retires this disposable root after process cleanup.
    manager
        .terminate_standalone_session(
            &target.session_id,
            &target.workspace_id,
            Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!((retained, unchanged, removal_blocked), (true, true, true));
}
