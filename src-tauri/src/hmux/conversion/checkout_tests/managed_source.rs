use super::*;
use hmux_client::ManagedCreateAdvanceResolution;

// Fault injection stops the process without completing the outer conversion's
// creation closure. A replay must finish that missing lifecycle step itself.
pub(super) fn stop_source(
    catalog: &LocalSessionCatalog,
    runtime: &Path,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    checkpoint: &recovery::RecoveryResumeCheckpoint,
) -> Result<(), String> {
    match source.session_class {
        SessionClass::Standalone => retirement::stop_standalone_source(catalog, source, checkpoint),
        SessionClass::Managed => {
            let stop = managed_stop_request_for_descriptor(
                format!("{}_stop", request.conversion_id),
                source,
            )?;
            ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
                .with_discovery_root(catalog.discovery_root())
                .stop(stop)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
    }
}
#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_converted_source_cannot_reopen_its_managed_creation() {
    conversion_fixture(ConversionCase::ManagedSourceReopen);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_converted_successor_cannot_reopen_from_its_original_create() {
    conversion_fixture(ConversionCase::RehostedSourceReopen);
}

pub(super) fn assert_source_stays_closed(
    manager: &HmuxManager,
    app: &AppHandle<tauri::test::MockRuntime>,
    current: &runtime::InstalledBuild,
    request: &SessionConversionRequest,
    source_create: ManagedCreateRequest,
) {
    let catalog = product_catalog().unwrap();
    let registration = capture_git_checkout_registration(Path::new(&request.cwd))
        .unwrap()
        .unwrap();
    let claims = read_git_checkout_claims(&registration).unwrap();
    let converted = manager.convert_session(app, request.clone()).unwrap();
    assert_eq!(converted.outcome, "converted", "{converted:?}");
    let target = converted.replacement_session.as_ref().unwrap();
    let selector = SessionSelector::new(&target.session_id, Some(target.workspace_id.clone()));
    let before = catalog.find(&selector).unwrap();

    // A different observer still holds the original canonical create request.
    // Conversion must close that source lifetime, not merely stop its process.
    let late_source = ManagedSessionCreator::new(&current.runtime)
        .with_discovery_root(catalog.discovery_root())
        .create_or_reconcile_and_advance(source_create.clone());
    let source_closed = matches!(&late_source,
        Ok(ManagedCreateAdvanceResolution::AuthorityUnavailable(authority))
            if authority.code == "hmux_managed_create_advance_authority_unavailable");
    let target_unchanged = same_session_generation(&before, &catalog.find(&selector).unwrap());
    let claim_retained = read_git_checkout_claims(&registration).unwrap() == claims;

    // Capture observations before cleanup can close the old source on RED.
    manager
        .stop_managed_create_chain_v2(
            app,
            source_create.idempotency_key(),
            source_create.session_id(),
            source_create.workspace_id(),
        )
        .unwrap();
    manager
        .stop_managed_create_chain_v2(
            app,
            converted.replacement_idempotency_key.as_deref().unwrap(),
            &target.session_id,
            &target.workspace_id,
        )
        .unwrap();
    assert!(read_git_checkout_claims(&registration).unwrap().is_empty());
    assert_eq!(
        (source_closed, target_unchanged, claim_retained),
        (true, true, true),
        "converted source admitted a late observer: {late_source:?}",
    );
}
