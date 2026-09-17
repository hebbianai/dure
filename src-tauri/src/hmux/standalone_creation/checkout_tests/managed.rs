use super::*;

mod advance;
mod exact_resume;
mod recovery;
mod replacement_recovery;
mod retirement_recovery;

fn with_stop_fault<T>(checkpoint: &str, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<std::ffi::OsString>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("HMUX_TEST_MANAGED_STOP_FAULT", value),
                None => std::env::remove_var("HMUX_TEST_MANAGED_STOP_FAULT"),
            }
        }
    }
    // Only the serial, disposable native fixture may set this broker fault.
    let _restore = Restore(std::env::var_os("HMUX_TEST_MANAGED_STOP_FAULT"));
    std::env::set_var("HMUX_TEST_MANAGED_STOP_FAULT", checkpoint);
    operation()
}

fn launch(fixture: &Fixture, identity: &str) -> crate::hmux::ManagedCreateLaunch {
    crate::hmux::ManagedCreateLaunch {
        replace_current: false,
        idempotency_key: format!("create-{identity}"),
        session_id: format!("session-{identity}"),
        workspace_id: "managed-checkout-workspace".into(),
        provider_id: "test-provider".into(),
        conversation_id: None,
        permission_mode: hmux_client::PermissionMode::Default,
        credential_id: None,
        credential_generation: None,
        provider_state_environment: Default::default(),
        cwd: fixture.checkout.to_string_lossy().into_owned(),
        command: format!(
            "/bin/sh -c {}",
            crate::ssh::shell_quote(&format!(
                "printf started >> {}; exec sleep 60",
                crate::ssh::shell_quote(fixture.marker.to_str().unwrap()),
            )),
        ),
        initial_prompt: None,
        rows: 24,
        columns: 80,
        terminal_environment: Default::default(),
        terminal_default_colors: Default::default(),
    }
}

fn close(fixture: &Fixture, created: &crate::hmux::ManagedCreateSummary) {
    fixture
        .manager
        .stop_managed_create_chain_v2(
            fixture.app.handle(),
            &created.idempotency_key,
            &created.session.session_id,
            &created.session.workspace_id,
        )
        .unwrap();
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_provider_create_retains_checkout_until_logical_close() {
    let fixture = Fixture::new();
    let created = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "owned"))
        .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let removal = fixture.removal("managed-provider-live");
    let admission = removal.admit().and_then(|permit| permit.abort());
    let catalog = product_catalog().unwrap();
    let descriptor = catalog
        .find(&SessionSelector::new(
            &created.session.session_id,
            Some(created.session.workspace_id.clone()),
        ))
        .unwrap();
    let health = probe_local_session_exact(&catalog, &descriptor);
    // Observe the missing protection without deleting a live provider's cwd.
    close(&fixture, &created);
    assert_eq!(
        claims.len(),
        1,
        "the desktop managed provider bypassed checkout ownership"
    );
    assert_eq!(admission.unwrap_err().code, "checkout_use_in_use");
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
    fixture
        .removal("managed-provider-finished")
        .admit()
        .unwrap()
        .remove()
        .unwrap();
    assert!(!fixture.checkout.exists());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_prior_removal_refuses_managed_provider_before_launch() {
    let fixture = Fixture::new();
    let permit = fixture.removal("before-managed-provider").admit().unwrap();
    let catalog = product_catalog().unwrap();
    let before = catalog.list().unwrap().len();
    let created = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "refused"));
    let after = catalog.list().unwrap().len();
    let started = fixture.marker.exists();
    if let Ok(created) = &created {
        close(&fixture, created);
    }
    permit.abort().unwrap();
    assert!(created
        .unwrap_err()
        .starts_with("checkout_use_phase_conflict:"));
    assert_eq!((before, started), (after, false));
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
    // Removal refusal did not consume the not-yet-launched create identity.
    let created = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "refused"))
        .unwrap();
    assert_eq!(
        read_git_checkout_claims(&fixture.registration)
            .unwrap()
            .len(),
        1
    );
    close(&fixture, &created);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_provider_replay_shares_one_claim_and_cannot_reopen_closed() {
    let mut fixture = Fixture::new();
    let created = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "replayed"))
        .unwrap();
    drop(std::mem::take(&mut fixture.manager));
    let replayed = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "replayed"))
        .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    close(&fixture, &replayed);
    let after_close = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "replayed"));
    assert_eq!(replayed.outcome, "reused");
    assert_eq!(replayed.session.stop_fence, created.session.stop_fence);
    assert_eq!(claims.len(), 1);
    assert!(
        after_close.is_err(),
        "logical close cannot be reopened by a create retry"
    );
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_provider_failed_request_preserves_the_live_owner() {
    let fixture = Fixture::new();
    let created = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "changed"))
        .unwrap();
    let before = read_git_checkout_claims(&fixture.registration).unwrap();
    let mut changed = launch(&fixture, "changed");
    changed.command = "sleep 60".into();
    let refused = fixture
        .manager
        .create_managed(fixture.app.handle(), changed);
    let after = read_git_checkout_claims(&fixture.registration).unwrap();
    let catalog = product_catalog().unwrap();
    let descriptor = catalog
        .find(&SessionSelector::new(
            &created.session.session_id,
            Some(created.session.workspace_id.clone()),
        ))
        .unwrap();
    let health = probe_local_session_exact(&catalog, &descriptor);
    close(&fixture, &created);
    assert!(refused.is_err());
    assert_eq!(before.len(), 1);
    assert_eq!(before, after);
    assert_eq!(health, SessionProbeStatus::Healthy);
}
