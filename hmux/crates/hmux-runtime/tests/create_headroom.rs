#![cfg(unix)]

use fs2::FileExt;
use hmux_client::recovery_journal::managed_create_ledger::{self, ManagedCreateLedgerState};
use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, LocalSessionCatalog, LocalStateGcPolicy,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopRequest, PermissionMode, StandaloneCreateRequest,
    StandaloneSessionCreator, collect_local_state, probe_local_process_generation,
};
use hmux_host::local_discovery::{
    DiscoveryGcMode, DiscoveryGcPolicy, DiscoveryGcSelection, DiscoveryKey, DiscoveryRoot,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(5);

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn isolated_runtime(state: &Path, home: &Path) -> PathBuf {
    let runtime = state.join("runtime");
    fs::write(
        &runtime,
        format!(
            "#!/bin/sh\nexport HOME={} DURE_HOME={} ZDOTDIR={}\nexport HMUX_RUNTIME_TEST_CAPACITY_STDERR={}\nexec {} \"$@\"\n",
            quote(home),
            quote(home),
            quote(home),
            quote(&state.join("maintenance.log")),
            quote(Path::new(env!("CARGO_BIN_EXE_hmux-runtime"))),
        ),
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    runtime
}

fn assert_create_does_not_wait_for_unrelated_maintenance(managed: bool, pressure: bool) {
    assert_create_during_maintenance(managed, pressure, false);
}

fn assert_create_during_maintenance(managed: bool, pressure: bool, full_gc: bool) {
    // The outer Hmux guardian owns this retained root if a scenario fails.
    let state = tempfile::tempdir().unwrap().keep();
    let home = state.join("home");
    fs::create_dir(&home).unwrap();
    let discovery = state.join("discovery");
    let root = DiscoveryRoot::create(&discovery).unwrap();
    if pressure {
        for index in 0..DiscoveryGcPolicy::default().max_session_entries {
            root.session(
                DiscoveryKey::new("debris", format!("old-{index}"), "fixture", 1).unwrap(),
            )
            .unwrap();
        }
    }
    let runtime = isolated_runtime(&state, &home);
    let unrelated =
        ManagedCreateReconcileRequest::new("unrelated", "blocker", "maintenance").unwrap();
    assert!(
        !managed_create_ledger::successor_session_shares_create_shard(&unrelated, "new-session")
            .unwrap(),
        "this fixture must not hold the requested session's own admission shard",
    );
    let ManagedCreateLedgerState::Prepared(reservation) = managed_create_ledger::reserve(
        &discovery,
        unrelated.workspace_id(),
        unrelated.session_id(),
        unrelated.idempotency_key(),
        &hmux_client::recovery_journal::request_fingerprint(&["unrelated-fixture"]),
    )
    .unwrap() else {
        panic!("unrelated create must hold its own prepared admission");
    };
    drop(reservation);
    let shard = fs::read_dir(discovery.join(".managed-create-v2"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("shard_")
                && path
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .expect("the unrelated admission published its shard");
    let maintenance_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(shard.with_extension("lock"))
        .unwrap();
    maintenance_lock.lock_exclusive().unwrap();
    assert!(root.registration_capacity().unwrap().remaining > 0);

    let garbage_path = full_gc.then(|| {
        let garbage = root
            .session(DiscoveryKey::new("full-gc", "debris", "fixture", 1).unwrap())
            .unwrap();
        garbage.path().to_path_buf()
    });
    let collector = full_gc.then(|| {
        // Physical root-lock contention proves the collector has entered its
        // fenced inspection, rather than assuming a sleep reached that phase.
        drop(root.acquire_maintenance_exclusive().unwrap());
        let gc_root = discovery.clone();
        let worker = std::thread::spawn(move || {
            let mut policy = LocalStateGcPolicy::default();
            policy.discovery.minimum_age_ms = 0;
            policy.discovery.selection = DiscoveryGcSelection::AllEligible;
            collect_local_state(&gc_root, DiscoveryGcMode::Apply, &policy)
        });
        let deadline = Instant::now() + WAIT;
        while root.acquire_maintenance_exclusive().is_ok() {
            assert!(
                Instant::now() < deadline,
                "full GC did not enter inspection"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        worker
    });

    let (sender, receiver) = mpsc::channel();
    let worker_runtime = runtime.clone();
    let worker_discovery = discovery.clone();
    let worker_home = home.clone();
    let worker = std::thread::spawn(move || {
        let started = Instant::now();
        let result = if managed {
            ManagedSessionCreator::new(worker_runtime)
                .with_discovery_root(worker_discovery)
                .create(
                    ManagedCreateRequest::new(
                        "headroom-create",
                        "new-session",
                        "maintenance",
                        "local-shell",
                        PermissionMode::Default,
                        worker_home,
                        vec!["/bin/cat".into()],
                        24,
                        80,
                    )
                    .unwrap(),
                )
                .map(|created| created.session().clone())
                .map_err(|error| error.to_string())
        } else {
            StandaloneSessionCreator::new(worker_runtime)
                .with_discovery_root(worker_discovery)
                .create(
                    StandaloneCreateRequest::new(
                        worker_home,
                        Some("headroom-shell".into()),
                        vec!["/bin/cat".into()],
                        24,
                        80,
                    )
                    .unwrap(),
                )
                .map(|created| created.session().clone())
                .map_err(|error| error.to_string())
        };
        sender.send((result, started.elapsed())).unwrap();
    });
    let early = receiver.recv_timeout(WAIT);
    let completed_before_unlock = early.is_ok();
    let coalesced_worker_owns_lease = pressure && completed_before_unlock && {
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(discovery.join(".registration-maintenance.lock"))
            .unwrap();
        lease.try_lock_exclusive().is_err()
    };
    let additional = if pressure && completed_before_unlock {
        // A second caller must reuse the in-flight cleanup lease, not launch
        // another global maintenance pass or wait for the first one to finish.
        Some(
            StandaloneSessionCreator::new(&runtime)
                .with_discovery_root(&discovery)
                .create(
                    StandaloneCreateRequest::new(
                        home.clone(),
                        Some("concurrent-cleanup-shell".into()),
                        vec!["/bin/cat".into()],
                        24,
                        80,
                    )
                    .unwrap(),
                ),
        )
    } else {
        None
    };
    // Release even on RED, allowing creation to finish and exact cleanup to run.
    drop(maintenance_lock);
    let (result, elapsed) = early.unwrap_or_else(|_| receiver.recv_timeout(WAIT).unwrap());
    worker.join().unwrap();
    let session = result.expect("creation must succeed independently of maintenance");
    let full_gc_finished = collector.map(|worker| worker.join().unwrap());
    eprintln!(
        "headroom managed={managed} create={elapsed:?} before_unrelated_unlock={completed_before_unlock} root={state:?} host={:?} provider={:?}",
        session.descriptor().host_process,
        session.descriptor().provider_process,
    );
    let maintenance_finished = if pressure && completed_before_unlock {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let capacity = root.registration_capacity().unwrap();
            if capacity.used <= 384 {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    } else {
        true
    };
    stop_fixture(&session, &runtime, &discovery, &home, managed);
    if let Some(created) = additional {
        let created = created.expect("an in-flight cleanup must not reject another create");
        stop_fixture(created.session(), &runtime, &discovery, &home, false);
    }
    if let Some(report) = full_gc_finished {
        let report = report.expect("full GC must complete after unrelated admission releases");
        assert!(report.discovery.unwrap().removed_sessions > 0);
        assert!(
            !garbage_path.expect("full GC fixture has garbage").exists(),
            "full GC must actually reclaim eligible state"
        );
    }
    assert!(
        maintenance_finished,
        "deferred worker failed: {:?}",
        fs::read_to_string(state.join("maintenance.log"))
    );
    if pressure && completed_before_unlock {
        assert!(
            coalesced_worker_owns_lease,
            "one inherited lease must own deferred cleanup"
        );
    }
    assert!(
        completed_before_unlock,
        "creation with headroom waited for an unrelated maintenance shard for {elapsed:?}",
    );
}

fn stop_fixture(
    session: &LocalSession,
    runtime: &Path,
    discovery: &Path,
    home: &Path,
    managed: bool,
) {
    let descriptor = session.descriptor();
    if managed {
        let request = ManagedStopRequest::new(
            "headroom-stop",
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
        ManagedSessionStopper::new(runtime, home)
            .with_discovery_root(discovery)
            .stop(request)
            .expect("exact fixture managed stop");
    } else {
        session
            .terminate_standalone(&LocalSessionCatalog::new(discovery), WAIT)
            .expect("exact fixture standalone stop");
    }
    let deadline = Instant::now() + WAIT;
    for process in [&descriptor.host_process, &descriptor.provider_process] {
        while probe_local_process_generation(process).unwrap()
            != LocalProcessGenerationStatus::Absent
        {
            assert!(
                Instant::now() < deadline,
                "owned process failed to exit: {process:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn managed_create_with_headroom_does_not_wait_for_an_unrelated_ledger_shard() {
    assert_create_does_not_wait_for_unrelated_maintenance(true, false);
}

#[test]
fn standalone_create_with_headroom_does_not_wait_for_an_unrelated_ledger_shard() {
    assert_create_does_not_wait_for_unrelated_maintenance(false, false);
}

#[test]
fn managed_create_at_soft_pressure_does_not_wait_for_maintenance() {
    assert_create_does_not_wait_for_unrelated_maintenance(true, true);
}

#[test]
fn standalone_create_at_soft_pressure_does_not_wait_for_maintenance() {
    assert_create_does_not_wait_for_unrelated_maintenance(false, true);
}

#[test]
fn managed_create_during_full_gc_does_not_wait_for_unrelated_admission() {
    assert_create_during_maintenance(true, false, true);
}

#[test]
fn standalone_create_during_full_gc_does_not_wait_for_unrelated_admission() {
    assert_create_during_maintenance(false, false, true);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn standalone_create_completes_before_prepared_cold_sweep() {
    use hmux_host::local_discovery::DiscoveryGcProcessStatus;
    use std::collections::BTreeSet;

    let state = tempfile::tempdir().unwrap().keep();
    let home = state.join("home");
    fs::create_dir(&home).unwrap();
    let discovery = state.join("discovery");
    let root = DiscoveryRoot::create(&discovery).unwrap();
    let runtime = isolated_runtime(&state, &home);
    let history = discovery.join(".terminal-history-v2");
    fs::create_dir(&history).unwrap();
    fs::set_permissions(&history, fs::Permissions::from_mode(0o700)).unwrap();
    let orphan = history.join(format!("h_{}", "a".repeat(64)));
    fs::create_dir(&orphan).unwrap();
    fs::set_permissions(&orphan, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(orphan.join("lease.lock"), []).unwrap();
    fs::set_permissions(orphan.join("lease.lock"), fs::Permissions::from_mode(0o600)).unwrap();
    let policy = DiscoveryGcPolicy {
        minimum_age_ms: 0,
        selection: DiscoveryGcSelection::AllEligible,
        ..DiscoveryGcPolicy::default()
    };
    let plan = root
        .plan_registration_garbage(&policy, |_| DiscoveryGcProcessStatus::Unknown)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let hygiene = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Unknown
        })
        .unwrap()
        .sweep_for_full_gc()
        .unwrap();
    let sweep = root
        .quarantine_hygiene_locked(&maintenance, hygiene)
        .unwrap();
    drop(maintenance);
    let quarantine = fs::read_dir(&history)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".gc-history_")
        })
        .expect("cold deletion must still be pending");
    let started = Instant::now();
    let created = StandaloneSessionCreator::new(&runtime)
        .with_discovery_root(&discovery)
        .create(
            StandaloneCreateRequest::new(
                home.clone(),
                Some("cold-gc-shell".into()),
                vec!["/bin/cat".into()],
                24,
                80,
            )
            .unwrap(),
        );
    let elapsed = started.elapsed();
    let pending_at_create_completion = quarantine.exists();
    // An interrupted caller leaves only a detached archive. Exercise the
    // public full-GC consumer's cold phase while the new Host is still live.
    drop(sweep);
    let report = collect_local_state(
        &discovery,
        DiscoveryGcMode::Apply,
        &LocalStateGcPolicy {
            discovery: policy,
            ..LocalStateGcPolicy::default()
        },
    );
    if let Ok(created) = &created {
        eprintln!(
            "cold-sweep create={elapsed:?} pending={pending_at_create_completion} root={state:?} host={:?} provider={:?}",
            created.session().descriptor().host_process,
            created.session().descriptor().provider_process
        );
        stop_fixture(created.session(), &runtime, &discovery, &home, false);
    }
    created.expect("standalone creation must complete while cold deletion is pending");
    assert!(pending_at_create_completion);
    assert_eq!(report.unwrap().discovery.unwrap().removed_cold_archives, 1);
    assert!(!orphan.exists());
    assert!(!quarantine.exists());
}
