use super::*;
use hmux_client::LocalSessionCatalog;

fn with_discovery_alias<T>(fixture: &Fixture, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<std::ffi::OsString>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("HMUX_DISCOVERY_ROOT", value),
                None => std::env::remove_var("HMUX_DISCOVERY_ROOT"),
            }
        }
    }
    // Fixture::new proves the serial runner owns all roots before mutation.
    let actual = environment_path("HMUX_DISCOVERY_ROOT");
    let alias = fixture.checkout.parent().unwrap().join("discovery-alias");
    std::os::unix::fs::symlink(&actual, &alias).unwrap();
    let spelling = format!("{}//", alias.display());
    assert_ne!(Path::new(&spelling), actual);
    assert_eq!(Path::new(&spelling).canonicalize().unwrap(), actual);
    let _restore = Restore(std::env::var_os("HMUX_DISCOVERY_ROOT"));
    std::env::set_var("HMUX_DISCOVERY_ROOT", spelling);
    operation()
}

fn reconcile(fixture: &Fixture) {
    reconcile_in(fixture, product_catalog().unwrap()).unwrap();
}

fn reconcile_in(
    fixture: &Fixture,
    catalog: LocalSessionCatalog,
) -> Result<(), dure_session_runtime::SessionCheckoutError> {
    tauri::async_runtime::block_on(async {
        let store = dure_app_sqlite::SqliteDomainStore::open(
            environment_path("DURE_HOME").join("backend/application-state.sqlite3"),
        )
        .await
        .unwrap();
        let result = dure_session_runtime::reconcile_catalog_checkout_users(
            store.clone(),
            || panic!("a retired standalone must not need a runtime executable"),
            catalog,
            fixture.registration.clone(),
        )
        .await;
        store.close().await;
        result
    })
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_alias_create_replay_and_close_share_one_namespace() {
    let mut fixture = Fixture::new();
    let catalog = LocalSessionCatalog::new(environment_path("HMUX_DISCOVERY_ROOT"));
    let before = catalog.list().unwrap();
    let operation = OperationIdV1::new("alias-native-create").unwrap();
    let (created, alias_replay) = with_discovery_alias(&fixture, || {
        let created = fixture.create_with_operation(Some(operation.clone()));
        let replay = fixture.create_with_operation(Some(operation.clone()));
        (created, replay)
    });
    let new_sessions: Vec<_> = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|session| {
            !before.iter().any(|old| {
                old.session_id == session.session_id && old.workspace_id == session.workspace_id
            })
        })
        .collect();
    let health: Vec<_> = new_sessions
        .iter()
        .map(|session| probe_local_session_exact(&catalog, session))
        .collect();
    drop(std::mem::take(&mut fixture.manager));
    // The same operation must reconnect through the physical path as well.
    let canonical_replay = fixture.create_with_operation(Some(operation));
    let claimed = read_git_checkout_claims(&fixture.registration).unwrap();
    if let Ok(created) = &canonical_replay {
        fixture.close(created);
    } else {
        for session in &new_sessions {
            fixture
                .manager
                .terminate_standalone_session(
                    &session.session_id,
                    &session.workspace_id,
                    Duration::from_secs(3),
                )
                .unwrap();
        }
    }
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    let launches = std::fs::read_to_string(&fixture.marker).unwrap();
    assert_eq!(health, [SessionProbeStatus::Healthy]);
    let created = created.expect("an alias must not turn a successful spawn into an error");
    let alias_replay = alias_replay.expect("the alias must replay the completed operation");
    let canonical_replay =
        canonical_replay.expect("the physical namespace must replay the same operation");
    assert_eq!(alias_replay.session_id, created.session_id);
    assert_eq!(canonical_replay.session_id, created.session_id);
    assert_eq!(canonical_replay.terminal_epoch, created.terminal_epoch);
    assert_eq!(new_sessions[0].terminal_epoch, created.terminal_epoch);
    assert_eq!(claimed.len(), 1);
    assert!(
        remaining.is_empty(),
        "exact close retained claims: {remaining:?}"
    );
    assert_eq!(launches, "started");
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_alias_passive_recovery_releases_the_canonical_checkout_claim() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    fixture.abandon_and_wait_for_retirement(created);
    let remaining = with_discovery_alias(&fixture, || {
        reconcile(&fixture);
        reconcile(&fixture);
        read_git_checkout_claims(&fixture.registration).unwrap()
    });
    // Canonical cleanup also keeps the RED fixture fully disposable.
    reconcile(&fixture);
    assert!(
        remaining.is_empty(),
        "an alias hid the retired claim: {remaining:?}"
    );
    assert!(read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "requires isolated native app roots, serial tests and staged Hmux binaries"]
fn native_unresolved_lookup_root_neither_authorizes_nor_blocks_other_cleanup() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    fixture.abandon_and_wait_for_retirement(created);
    let directory = fixture.checkout.parent().unwrap();
    let dangling = directory.join("unresolved-root");
    std::os::unix::fs::symlink(directory.join("absent-root"), &dangling).unwrap();
    let unknown = reconcile_in(&fixture, LocalSessionCatalog::new(&dangling));
    let retained = read_git_checkout_claims(&fixture.registration).unwrap();
    let configured = LocalSessionCatalog::with_read_only_discovery_roots(
        product_catalog().unwrap().discovery_root(),
        vec![dangling],
    )
    .unwrap();
    let known = reconcile_in(&fixture, configured);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    reconcile(&fixture);
    assert!(
        unknown.is_ok(),
        "an unrelated unresolved scope became an error: {unknown:?}"
    );
    assert_eq!(retained.len(), 1, "an unresolved scope authorized cleanup");
    assert!(
        known.is_ok(),
        "an unused old root blocked the known namespace: {known:?}"
    );
    assert!(
        remaining.is_empty(),
        "the known retired claim survived: {remaining:?}"
    );
}
