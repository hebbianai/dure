use super::*;

const FIXTURE_ROOT: &str = "DURE_HMUX_EXACT_CLOSE_FIXTURE_ROOT";

#[test]
fn compatibility_close_replays_from_the_source_ledger() {
    let root = isolated_root();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "exact_close::namespaces::compatibility_close_fixture",
            "--nocapture",
        ])
        .env_remove(hmux_client::DISCOVERY_ROOT_ENV)
        .env(FIXTURE_ROOT, &root)
        .env("DURE_HOME", root.join("primary"))
        .env("HEBBIAN_HOME", root.join("legacy"))
        .env("HOME", root.join("home"))
        .env("XDG_STATE_HOME", root.join("xdg-state"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
#[ignore = "runs in its own process with a disposable discovery environment"]
fn compatibility_close_fixture() {
    let root = PathBuf::from(std::env::var_os(FIXTURE_ROOT).unwrap())
        .canonicalize()
        .unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(&guardian) && root != guardian);
    let catalog = LocalSessionCatalog::from_environment().unwrap();
    assert!(
        catalog
            .discovery_paths()
            .all(|path| path.starts_with(&root))
    );
    DiscoveryRoot::create(catalog.discovery_root()).unwrap();
    let legacy = root.join("legacy/state/hebbian-agent/hmux-hosts");
    assert!(catalog.discovery_paths().any(|path| path == legacy));
    let fixture = Fixture::at("compatibility-close", &root, &legacy);
    let created = fixture.create();
    let source = created.session().descriptor().clone();
    drop(created);
    let runtime = Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap());
    let request = stop_request("compatibility-close-stop", &source);
    let first = stopper.stop_and_close_creation(request.clone());
    let replay = first.as_ref().ok().map(|_| {
        let collected = hmux_client::recovery_journal::garbage_collect_completed(
            &legacy,
            hmux_client::recovery_journal::RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(collected.removed_completed_records >= 1);
        stopper.stop_and_close_creation(request.clone())
    });
    let source_process = probe_local_process_generation(&source.provider_process).unwrap();
    let closed = first.as_ref().ok().map(|_| {
        matches!(
            fixture
                .creator
                .create_or_reconcile_and_advance(fixture.request.clone())
                .unwrap(),
            ManagedCreateAdvanceResolution::AuthorityUnavailable(_)
        )
    });
    // Capture product observations before exact cleanup, including the RED path.
    fixture
        .stopper
        .stop_create_chain(
            ManagedCreateReconcileRequest::new(
                fixture.request.idempotency_key(),
                fixture.request.session_id(),
                fixture.request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    let first = first.unwrap();
    assert_eq!(replay.unwrap().unwrap(), first);
    assert_eq!(source_process, LocalProcessGenerationStatus::Absent);
    assert_eq!(closed, Some(true));
}
