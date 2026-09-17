use super::*;
use dure_app::{GitCheckoutRegistrationV1, SessionCheckoutAdmissionV1};
use dure_app_sqlite::SqliteDomainStore;

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_close_resumes_after_runtime_retirement_and_git_failure() {
    conversion_fixture(ConversionCase::StandaloneCloseRetry);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_removal_reconciles_the_exact_interrupted_standalone_close() {
    conversion_fixture(ConversionCase::StandaloneCloseReconcile);
}

pub(super) fn close_after_git_failure(
    manager: &HmuxManager,
    app_home: &Path,
    registration: &GitCheckoutRegistrationV1,
    target: &SessionSummary,
    case: ConversionCase,
) {
    let catalog = product_catalog().unwrap();
    let root = catalog.discovery_root().canonicalize().unwrap();
    let selector = SessionSelector::new(&target.session_id, Some(target.workspace_id.clone()));
    let mut command = Command::new("git");
    crate::gitx::scrub_git_environment(&mut command);
    let refs = command
        .current_dir(&registration.repository_path)
        .args([
            "for-each-ref",
            "--format=%(refname)",
            "refs/dure/checkout-use/v1/",
        ])
        .output()
        .unwrap();
    assert!(refs.status.success());
    let refs = String::from_utf8(refs.stdout).unwrap();
    let refs: Vec<_> = refs.lines().collect();
    assert_eq!(
        refs.len(),
        1,
        "the fixture owns exactly one checkout authority"
    );
    let lock =
        PathBuf::from(&registration.instance.git_common_dir).join(format!("{}.lock", refs[0]));
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(lock.starts_with(&guardian));
    let owned_lock = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .unwrap();

    // Fail the real Git CAS after runtime retirement, without altering a claim
    // or suppressing an error. The next call has no in-memory close request.
    let failed = manager.terminate_standalone_session(
        &target.session_id,
        &target.workspace_id,
        Duration::from_secs(3),
    );
    let retained = read_git_checkout_claims(registration).unwrap();
    drop(owned_lock);
    fs::remove_file(&lock).unwrap();
    assert!(failed.unwrap_err().contains("checkout_use_git_failed"));
    assert_eq!(retained.len(), 1);
    assert!(catalog.open(&selector).unwrap_err().is_session_absent());

    let identity = tauri::async_runtime::block_on(async {
        let store = SqliteDomainStore::open(app_home.join("backend/application-state.sqlite3"))
            .await
            .unwrap();
        let pending = store
            .session_checkout_close_targets(
                root.to_str().unwrap(),
                &target.workspace_id,
                &target.session_id,
            )
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].binding.claim_id, retained[0].claim_id);
        assert_eq!(
            pending[0].close_payload.as_ref().unwrap()["generation"]["fence"]["terminalEpoch"],
            target.terminal_epoch
        );
        let identity = pending[0].binding.identity.clone();
        store.close().await;
        identity
    });
    crate::session_checkout::close_standalone(
        catalog.clone(),
        &target.session_id,
        &target.workspace_id,
        Some("another-observer-epoch"),
        Duration::ZERO,
    )
    .unwrap();
    assert_eq!(read_git_checkout_claims(registration).unwrap(), retained);

    match case {
        ConversionCase::StandaloneCloseRetry => manager
            .terminate_standalone_session(
                &target.session_id,
                &target.workspace_id,
                Duration::from_secs(3),
            )
            .unwrap(),
        ConversionCase::StandaloneCloseReconcile => tauri::async_runtime::block_on(async {
            let store = SqliteDomainStore::open(app_home.join("backend/application-state.sqlite3"))
                .await
                .unwrap();
            dure_session_runtime::reconcile_checkout_users(
                store.clone(),
                PathBuf::from("/runtime-not-required-for-standalone-close"),
                root,
                registration.clone(),
            )
            .await
            .unwrap();
            store.close().await;
        }),
        _ => unreachable!("only interrupted-close cases use this fixture"),
    }
    tauri::async_runtime::block_on(async {
        let store = SqliteDomainStore::open(app_home.join("backend/application-state.sqlite3"))
            .await
            .unwrap();
        assert_eq!(
            store
                .session_checkout(&identity)
                .await
                .unwrap()
                .unwrap()
                .admission,
            SessionCheckoutAdmissionV1::Closed
        );
        store.close().await;
    });
    // The caller still observes the original final claim/removal assertions.
}
