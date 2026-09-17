use super::*;
use crate::hmux::StandaloneUpgradeRequest;
use hmux_client::{LocalSessionObserver, ObserverAttachOptions};
use std::fs;

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_current_app_upgrade_replays_without_a_recipe_or_runtime_activation() {
    let mut fixture = Fixture::new();
    let created = fixture.create().unwrap();
    let name = created.session_name.clone().unwrap();
    let catalog = product_catalog().unwrap();
    let selector = SessionSelector::new(&created.session_id, Some(created.workspace_id.clone()));
    let source = catalog.find(&selector).unwrap();
    let observer = LocalSessionObserver::connect_resolved(
        catalog.open(&selector).unwrap(),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    // An ordinary app creation is request-bound; it must not need a general
    // resurrection recipe merely to acknowledge that its build is current.
    assert!(crate::hmux::verified_resurrection_recipe(catalog.discovery_root(), &name).is_none());
    let request = StandaloneUpgradeRequest {
        upgrade_id: "current-app-upgrade".into(),
        session_id: created.session_id.clone(),
        workspace_id: created.workspace_id.clone(),
        session_name: name,
        confirmed: false,
    };
    let first = fixture
        .manager
        .upgrade_standalone(fixture.app.handle(), request.clone())
        .unwrap();
    assert_eq!(first.outcome, "already_current");
    assert_eq!(
        first.replacement_session.as_ref().unwrap().session_id,
        source.session_id
    );

    drop(std::mem::take(&mut fixture.manager));
    let install = environment_path("HMUX_INSTALL_ROOT");
    assert!(install.starts_with(environment_path("HOME")));
    let current = install.join("current");
    let held = install.join("current-held-by-upgrade-fixture");
    assert!(
        fs::symlink_metadata(&current)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!held.exists());
    // Hide only this disposable install's selection link, not a mapped
    // executable. A completed replay must not reactivate a current build.
    fs::rename(&current, &held).unwrap();
    let replay = fixture
        .manager
        .upgrade_standalone(fixture.app.handle(), request);
    let reactivated = fs::symlink_metadata(&current).is_ok();
    if reactivated {
        assert!(
            fs::symlink_metadata(&current)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
    fs::rename(&held, &current).unwrap();
    let after = catalog.find(&selector).unwrap();
    let claims = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    drop(observer);
    fixture.close(&created);

    let replay = replay.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.outcome, "already_current");
    assert!(
        !reactivated,
        "completed upgrade replay must not resolve or install an executable"
    );
    assert!(after.same_generation(&source));
    assert_eq!(after.provider_process, source.provider_process);
    assert_eq!(claims, 1);
    assert!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_to_string(&fixture.marker).unwrap(), "started");
}

#[test]
#[ignore = "requires isolated native app roots and paired staged/source Hmux binaries"]
fn native_app_upgrade_transfers_checkout_ownership_until_the_replacement_closes() {
    let fixture = Fixture::new();
    let original = crate::session_checkout::create_standalone(
        environment_path("DURE_QA_SOURCE_HMUX_RUNTIME"), None,
        OperationIdV1::new("app-upgrade-checkout-source").unwrap(),
        StandaloneCreateRequest::new(
            &fixture.checkout, Some("checkout-upgrade".into()),
            vec!["/bin/sh".into()], 24, 80,
        ).unwrap(),
    ).unwrap();
    let request = StandaloneUpgradeRequest {
        upgrade_id: "app-upgrade-checkout".into(),
        session_id: original.receipt().session_id().into(),
        workspace_id: original.receipt().workspace_id().into(),
        session_name: "checkout-upgrade".into(), confirmed: true,
    };
    let upgraded = fixture.manager.upgrade_standalone(fixture.app.handle(), request.clone()).unwrap();
    let target = upgraded.replacement_session.unwrap();
    let replayed = fixture.manager.upgrade_standalone(fixture.app.handle(), request).unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap().len();
    let removal = fixture.removal("remove-upgraded-checkout").admit()
        .and_then(|permit| permit.abort()).map_err(|error| error.code);
    let source_process = hmux_client::probe_local_process_generation(
        &original.session().descriptor().provider_process,
    ).unwrap();
    fixture.close(&target);
    assert_eq!(upgraded.outcome, "rehosted");
    assert!(replayed.replayed);
    assert_eq!(replayed.replacement_session.as_ref(), Some(&target));
    assert_eq!(source_process, hmux_client::LocalProcessGenerationStatus::Absent);
    assert_eq!((claims, removal), (1, Err("checkout_use_in_use")));
    assert!(read_git_checkout_claims(&fixture.registration).unwrap().is_empty());
    fixture.removal("remove-after-upgrade-close").admit().unwrap().abort().unwrap();
}
