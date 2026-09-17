#![cfg(windows)]

use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedCreateLedgerState, ManagedCreateLineageAdmission,
    ManagedCreateSuccessorChainResolution,
};
use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, ManagedCreateAdvanceResolution,
    ManagedCreateIdentityResolution, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest,
    PermissionMode, ProviderStateEnvironment, probe_local_process_generation,
};
use hmux_host::local_discovery::DiscoveryRoot;
use hmux_runtime_contract::{
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, read_json_frame,
    write_json_frame,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE_ROOT: &str = "FIXTURE_STATE_DIR";
const FIXTURE_MODE: &str = "HMUX_WINDOWS_ADVANCE_FIXTURE_MODE";

#[test]
fn retired_windows_create_persists_one_successor_across_crash_and_concurrency() {
    run_isolated_parent("retired");
}

#[test]
fn abandoned_windows_create_persists_one_successor_across_crash_and_concurrency() {
    run_isolated_parent("abandoned");
}

fn run_isolated_parent(mode: &str) {
    let state = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT")
        .expect("run native QA through hmux-native-windows-smoke.mjs");
    let state = Path::new(&state).canonicalize().unwrap();
    let root = tempfile::Builder::new()
        .prefix("windows-managed-advance-")
        .tempdir_in(state)
        .unwrap()
        .keep();
    let home = root.join("home");
    let temporary = root.join("tmp");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&temporary).unwrap();
    fs::create_dir(root.join("original")).unwrap();
    fs::create_dir(root.join("changed")).unwrap();
    let system = std::env::var_os("SystemRoot").expect("native Windows SystemRoot");
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "advance_fixture_parent",
            "--nocapture",
        ])
        .current_dir(&root)
        .env_clear()
        .env("SystemRoot", &system)
        .env("WINDIR", &system)
        .env("PATH", Path::new(&system).join("System32"))
        .env("ComSpec", Path::new(&system).join("System32/cmd.exe"))
        .env("USERPROFILE", &home)
        .env("HOME", &home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("DURE_HOME", root.join("dure"))
        .env("TEMP", &temporary)
        .env("TMP", &temporary)
        .env("HMUX_DISCOVERY_ROOT", root.join("discovery"))
        .env(FIXTURE_ROOT, &root)
        .env(FIXTURE_MODE, mode)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "native Windows advance case {mode} failed"
    );
}

#[test]
#[ignore = "launched as a real provider inside the owned Windows Job"]
fn advance_fixture_provider() {
    let root = std::env::var_os(FIXTURE_ROOT).expect("owned fixture root");
    assert_eq!(
        std::env::var_os("FIXTURE_CONFIG_DIR").unwrap(),
        Path::new(&root).join("original").as_os_str(),
    );
    let pending = Path::new(&root).join(format!("provider-{}.pending", std::process::id()));
    let ready = Path::new(&root).join(format!("provider-{}.ready", std::process::id()));
    fs::write(&pending, b"ready").unwrap();
    fs::rename(pending, ready).unwrap();
    println!("advance-ready");
    let mut line = String::new();
    while std::io::stdin().read_line(&mut line).unwrap() != 0 {
        line.clear();
    }
}

#[test]
#[ignore = "executed with an empty isolated parent environment"]
fn advance_fixture_parent() {
    let root = std::env::var_os(FIXTURE_ROOT).expect("owned fixture root");
    let root = Path::new(&root).canonicalize().unwrap();
    let mode = std::env::var(FIXTURE_MODE).unwrap();
    assert!(matches!(mode.as_str(), "retired" | "abandoned"));
    let discovery = root.join("discovery");
    DiscoveryRoot::create(&discovery).unwrap();
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery);
    let environment = |policy: &str| {
        ProviderStateEnvironment::new(BTreeMap::from([
            (FIXTURE_ROOT.into(), root.to_string_lossy().into_owned()),
            (
                "FIXTURE_CONFIG_DIR".into(),
                root.join(policy).to_string_lossy().into_owned(),
            ),
        ]))
        .unwrap()
    };
    let request = ManagedCreateRequest::new(
        "advance-create",
        "advance-session",
        "advance-workspace",
        "fixture",
        PermissionMode::Default,
        &root,
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            "advance_fixture_provider".into(),
            "--nocapture".into(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(environment("original"))
    .unwrap();
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let source_spawns = if mode == "retired" {
        let ManagedCreateAdvanceResolution::Current(source) = creator
            .create_or_reconcile_and_advance(request.clone())
            .unwrap()
        else {
            panic!("initial advance must project the current identity")
        };
        wait_for_provider(&root, source.session());
        let ManagedCreateAdvanceResolution::Current(replayed) = creator
            .create_or_reconcile_and_advance(request.clone())
            .unwrap()
        else {
            panic!("live source replay must remain current")
        };
        assert!(
            source
                .session()
                .descriptor()
                .same_generation(replayed.session().descriptor())
        );
        assert_eq!(provider_spawns(&root), 1);
        stop_exact(runtime, &root, &discovery, source.session());
        assert!(matches!(
            creator.reconcile_identity(identity.clone()).unwrap(),
            ManagedCreateIdentityResolution::Retired
        ));
        1
    } else {
        // Seed a proven never-launched source through the same ledger API. The
        // actual process crash below is at successor publication, not this seed.
        let ManagedCreateLedgerState::Prepared(mut reservation) =
            managed_create_ledger::reserve_request(
                &discovery,
                &request,
                ManagedCreateLineageAdmission::Root,
            )
            .unwrap()
        else {
            panic!("fresh fixture identity must reserve")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation.abandon_before_completion().unwrap();
        drop(reservation);
        assert!(matches!(
            creator.reconcile_identity(identity.clone()).unwrap(),
            ManagedCreateIdentityResolution::AbandonedBeforeCompletion
        ));
        0
    };

    let mut broker = Command::new(runtime)
        .args(["--no-autostart", MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND])
        .current_dir(&root)
        .env("HMUX_DISCOVERY_ROOT", &discovery)
        .env(
            "HMUX_TEST_MANAGED_CREATE_ADVANCE_FAULT",
            "after_successor_persist_before_target_create",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(
        broker.stdin.as_mut().unwrap(),
        &ManagedCreateAdvanceRequest::new(request.clone()).unwrap(),
    )
    .unwrap();
    drop(broker.stdin.take());
    let response =
        read_json_frame::<ManagedCreateAdvanceBrokerResponse>(broker.stdout.as_mut().unwrap());
    assert_eq!(broker.wait().unwrap().code(), Some(86));
    assert!(response.is_err(), "crashed broker must not report success");
    assert_eq!(provider_spawns(&root), source_spawns);
    let persisted = managed_create_ledger::resolve_successor_chain(&discovery, &identity).unwrap();
    let chain = match persisted {
        ManagedCreateSuccessorChainResolution::UnbornSuccessor { chain, expected } => {
            assert_eq!(expected.session_id(), chain.effective().session_id());
            chain
        }
        // The canonical policy publication can also reserve the target create
        // record before launch. Its pending identity must still be the sole
        // durable successor; a pending source alone fails the length check.
        ManagedCreateSuccessorChainResolution::Pending { chain } => chain,
        other => panic!("expected a durable unlaunched successor, got {other:?}"),
    };
    assert_eq!(chain.identities().len(), 2);
    let persisted_identity = chain.effective().clone();
    assert_ne!(persisted_identity.session_id(), request.session_id());

    let changed = request
        .clone()
        .with_provider_state_environment(environment("changed"))
        .unwrap();
    let refused = creator
        .create_or_reconcile_and_advance(changed)
        .unwrap_err();
    assert_eq!(
        refused.code(),
        MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
    );
    assert_eq!(provider_spawns(&root), source_spawns);

    let barrier = Arc::new(Barrier::new(8));
    let callers = (0..8)
        .map(|_| {
            let creator = creator.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                creator
                    .create_or_reconcile_and_advance(request)
                    .map_err(|error| format!("{}: {error}", error.code()))
            })
        })
        .collect::<Vec<_>>();
    let outcomes = callers
        .into_iter()
        .map(|caller| caller.join().unwrap())
        .collect::<Vec<_>>();
    let ManagedCreateAdvanceResolution::Advanced(successor) = creator
        .create_or_reconcile_and_advance(request.clone())
        .unwrap()
    else {
        panic!("settled concurrent calls must replay one successor")
    };
    let observations = std::panic::catch_unwind(|| {
        wait_for_provider(&root, successor.session());
        assert_eq!(
            successor.receipt().session_id(),
            persisted_identity.session_id()
        );
        assert_eq!(
            successor.receipt().idempotency_key(),
            persisted_identity.idempotency_key()
        );
        let mut advanced = 0;
        let mut pending = 0;
        let mut authority_unavailable = 0;
        for outcome in outcomes {
            match outcome.unwrap() {
                ManagedCreateAdvanceResolution::Advanced(result) => {
                    advanced += 1;
                    assert!(
                        result
                            .session()
                            .descriptor()
                            .same_generation(successor.session().descriptor())
                    );
                }
                ManagedCreateAdvanceResolution::Pending => pending += 1,
                ManagedCreateAdvanceResolution::AuthorityUnavailable(refusal) => {
                    assert_eq!(
                        refusal.code,
                        "hmux_managed_create_advance_authority_unavailable"
                    );
                    authority_unavailable += 1;
                }
                other => panic!("unexpected concurrent result: {other:?}"),
            }
        }
        assert!(advanced > 0);
        let ManagedCreateAdvanceResolution::Advanced(replay) =
            creator.create_or_reconcile_and_advance(request).unwrap()
        else {
            panic!("subsequent broker must replay the same live successor")
        };
        assert!(
            successor
                .session()
                .descriptor()
                .same_generation(replay.session().descriptor())
        );
        assert_eq!(provider_spawns(&root), source_spawns + 1);
        let ManagedCreateSuccessorChainResolution::Completed { chain, receipt } =
            managed_create_ledger::resolve_successor_chain(&discovery, &identity).unwrap()
        else {
            panic!("completed successor must remain durably readable")
        };
        assert_eq!(chain.identities().len(), 2);
        assert_eq!(chain.effective(), &persisted_identity);
        assert_eq!(
            receipt.generation_fence(),
            successor.receipt().generation_fence()
        );
        println!(
            "native-windows-advance mode={mode} callers=8 advanced={advanced} pending={pending} authority_unavailable={authority_unavailable} successor_count=1 crash_exit=86 source_spawns={source_spawns} total_spawns={}",
            provider_spawns(&root)
        );
    });
    stop_exact(runtime, &root, &discovery, successor.session());
    observations.unwrap();
}

fn provider_spawns(root: &Path) -> usize {
    fs::read_dir(root)
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("provider-") && name.ends_with(".ready")
        })
        .count()
}

fn wait_for_provider(root: &Path, session: &LocalSession) {
    let marker = root.join(format!(
        "provider-{}.ready",
        session.descriptor().provider_process.process_id
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read(marker).unwrap(), b"ready");
    session.read_screen(None).unwrap();
}

fn stop_exact(runtime: &str, root: &Path, discovery: &Path, session: &LocalSession) {
    let descriptor = session.descriptor();
    let stop = ManagedStopRequest::new(
        format!("advance-stop-{}", descriptor.session_id),
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    )
    .unwrap();
    let receipt = ManagedSessionStopper::new(runtime, root)
        .with_discovery_root(discovery)
        .stop(stop)
        .unwrap();
    assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
    for process in [&descriptor.host_process, &descriptor.provider_process] {
        let deadline = Instant::now() + Duration::from_secs(5);
        while probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Live
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }
}
