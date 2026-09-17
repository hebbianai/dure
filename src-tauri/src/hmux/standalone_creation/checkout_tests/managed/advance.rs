use super::*;
use crate::hmux::ManagedCreateSummary;
use crate::managed_create_resolution::ManagedCreateAdvanceCommandResolution;

pub(super) type Resolution =
    Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String>;

pub(super) fn receipt(result: &Resolution) -> Option<&ManagedCreateSummary> {
    match result {
        Ok(ManagedCreateAdvanceCommandResolution::Current { receipt })
        | Ok(ManagedCreateAdvanceCommandResolution::Advanced { receipt }) => Some(receipt),
        _ => None,
    }
}

pub(super) fn advance(fixture: &Fixture, identity: &str, replace_current: bool) -> Resolution {
    let mut request = launch(fixture, identity);
    request.replace_current = replace_current;
    fixture
        .manager
        .advance_managed_create(fixture.app.handle(), request)
}

pub(super) fn descriptor(created: &ManagedCreateSummary) -> hmux_client::SessionDescriptor {
    product_catalog()
        .unwrap()
        .find(&SessionSelector::new(
            &created.session.session_id,
            Some(created.session.workspace_id.clone()),
        ))
        .unwrap()
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_initial_advance_owns_its_checkout_until_close() {
    let fixture = Fixture::new();
    let result = advance(&fixture, "initial-advance", false);
    let created = receipt(&result).expect("initial advance must create a provider");
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let health = probe_local_session_exact(&product_catalog().unwrap(), &descriptor(created));
    close(&fixture, created);
    let closed = advance(&fixture, "initial-advance", false);
    let reopened = receipt(&closed);
    if let Some(created) = reopened {
        close(&fixture, created);
    }
    assert_eq!((claims.len(), health), (1, SessionProbeStatus::Healthy));
    assert!(reopened.is_none(), "logical close was reopened: {closed:?}");
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_initial_advance_cannot_launch_during_checkout_removal() {
    initial_removal("plain-removal", false);
}

pub(super) fn initial_removal(identity: &str, replace: bool) {
    let fixture = Fixture::new();
    let permit = fixture.removal(identity).admit().unwrap();
    let before = product_catalog().unwrap().list().unwrap().len();
    let result = advance(&fixture, identity, replace);
    let after = product_catalog().unwrap().list().unwrap().len();
    let launched = receipt(&result);
    if let Some(created) = launched {
        close(&fixture, created);
    }
    permit.abort().unwrap();
    assert_eq!(
        (launched.is_some(), after),
        (false, before),
        "removal must precede launch: {result:?}"
    );
    let retry = advance(&fixture, identity, replace);
    let created = receipt(&retry).expect("aborted removal must allow the same create to retry");
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    close(&fixture, created);
    assert_eq!(claims.len(), 1);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_advanced_successor_close_releases_the_existing_root_claim() {
    let fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "successor"))
        .unwrap();
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    fixture
        .manager
        .stop_managed_session(
            fixture.app.handle(),
            "retire-generation-for-advance",
            &source.session.session_id,
            &source.session.workspace_id,
            source.session.stop_fence.clone().unwrap(),
        )
        .unwrap();
    let result = advance(&fixture, "successor", false);
    let target = receipt(&result).expect("an exited generation must advance");
    let inherited = read_git_checkout_claims(&fixture.registration).unwrap();
    close(&fixture, target);
    assert_ne!(target.session.session_id, source.session.session_id);
    assert_eq!(original, inherited);
    assert_eq!(original.len(), 1);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_changed_source_policy_advances_without_replacing_its_checkout_claim() {
    let fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "advance-policy"))
        .unwrap();
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    let mut changed = launch(&fixture, "advance-policy");
    changed.command = changed.command.replace("sleep 60", "sleep 61");
    let result = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), changed);
    let target = receipt(&result);
    let current = read_git_checkout_claims(&fixture.registration).unwrap();
    if let Some(target) = target {
        close(&fixture, target);
    }
    close(&fixture, &source);
    let target =
        target.unwrap_or_else(|| panic!("a changed source policy must advance: {result:?}"));
    assert_ne!(target.session.session_id, source.session.session_id);
    assert_eq!(original.len(), 1);
    assert_eq!(original, current);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}
