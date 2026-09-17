use super::advance::{descriptor, receipt};
use super::*;
use hmux_client::ManagedCreateReconcileRequest;

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_completed_exact_resume_reconnect_keeps_its_original_target() {
    let mut fixture = Fixture::new();
    let id = "completed-resume-reconnect";
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("completed-resume-conversation".into());
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), request)
        .unwrap();
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("completed-resume-conversation".into());
    request.replace_current = true;
    let result = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), request);
    let target = receipt(&result).expect("replacement must complete before reconnect");
    let original = read_git_checkout_claims(&fixture.registration).unwrap();
    let target_descriptor = descriptor(target);
    // An obsolete source pane cannot close the independently owned target.
    close(&fixture, &source);
    let health = probe_local_session_exact(&product_catalog().unwrap(), &target_descriptor);
    drop(std::mem::take(&mut fixture.manager));
    let retry_cwd = fixture.checkout.join("reconnected-client-directory");
    std::fs::create_dir(&retry_cwd).unwrap();
    let mut request = launch(&fixture, id);
    request.replace_current = true;
    request.cwd = retry_cwd.to_string_lossy().into_owned();
    request.permission_mode = hmux_client::PermissionMode::BypassApprovals;
    request.command = request.command.replace("sleep 60", "sleep 61");
    let retried = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), request);
    let replayed = receipt(&retried);
    let same_target = replayed.is_some_and(|replayed| {
        replayed.session.session_id == target.session.session_id
            && replayed.session.stop_fence == target.session.stop_fence
    });
    let after = read_git_checkout_claims(&fixture.registration).unwrap();
    let starts = std::fs::read_to_string(&fixture.marker).unwrap();
    if let Some(replayed) = replayed {
        close(&fixture, replayed);
    }
    close(&fixture, target);
    close(&fixture, &source);
    let mut closed_request = launch(&fixture, id);
    closed_request.replace_current = true;
    let closed_retry = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), closed_request);
    if let Some(reopened) = receipt(&closed_retry) {
        close(&fixture, reopened);
    }
    assert!(
        receipt(&closed_retry).is_none(),
        "closed target reopened: {closed_retry:?}"
    );
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert_eq!(original.len(), 1);
    assert!(
        same_target,
        "completed reconnect chose a different target: {retried:?}"
    );
    assert_eq!(
        after, original,
        "reconnect created an independent checkout owner"
    );
    assert_eq!(
        starts, "startedstarted",
        "reconnect launched another provider"
    );
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_exact_resume_reconnect_retains_the_prepared_target_checkout() {
    let mut fixture = Fixture::new();
    let id = "resume-interrupted-writer";
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("interrupted-checkout-conversation".into());
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), request)
        .unwrap();
    let mut request = launch(&fixture, id);
    request.conversation_id = Some("interrupted-checkout-conversation".into());
    request.replace_current = true;

    // The disposable, serial native runner owns this environment. The fault
    // exits only the child broker, after exact final retirement and before reply.
    let cut = with_stop_fault("after_create_ledger_retirement", || {
        fixture
            .manager
            .advance_managed_create(fixture.app.handle(), request)
    });
    let at_cut = read_git_checkout_claims(&fixture.registration).unwrap();
    let catalog = product_catalog().unwrap();
    let closed = hmux_client::recovery_journal::managed_create_ledger::closed_retired_chain(
        catalog.discovery_root(),
        &ManagedCreateReconcileRequest::new(
            &source.idempotency_key,
            &source.session.session_id,
            &source.session.workspace_id,
        )
        .unwrap(),
    )
    .unwrap();
    drop(std::mem::take(&mut fixture.manager));
    let retry_cwd = fixture.checkout.join("new-client-directory");
    std::fs::create_dir(&retry_cwd).unwrap();
    let mut request = launch(&fixture, id);
    request.replace_current = true;
    request.cwd = retry_cwd.to_string_lossy().into_owned();
    request.conversation_id = None;
    request.permission_mode = hmux_client::PermissionMode::BypassApprovals;
    let retry = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), request);
    let target = receipt(&retry);
    let after = read_git_checkout_claims(&fixture.registration).unwrap();
    let health = target.map(|target| probe_local_session_exact(&catalog, &descriptor(target)));
    if let Some(target) = target {
        close(&fixture, target);
    }
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    close(&fixture, &source);
    assert!(
        receipt(&cut).is_none(),
        "fault did not interrupt the broker: {cut:?}"
    );
    assert!(
        closed.is_some(),
        "the exact source was not finalized and logically closed"
    );
    assert_eq!(
        at_cut.len(),
        2,
        "both resource claims must survive the lost response"
    );
    assert_eq!(
        health,
        Some(SessionProbeStatus::Healthy),
        "retry failed: {retry:?}"
    );
    assert_eq!(
        after.len(),
        1,
        "retry claimed a client-derived orphan target: {after:?}"
    );
    assert!(
        remaining.is_empty(),
        "target close left claims: {remaining:?}"
    );
}
