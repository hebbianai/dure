use super::*;
#[cfg(feature = "ghostty-core-proof")]
use crate::local_discovery::PresentationCheckpointSource;
use crate::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryManifest, ExitedManifest, HostLifetimeIdentity,
    LocalEndpoint, LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass,
    StartingManifest,
};
use crate::local_protocol::{
    Exit, ProcessProof, ProtocolVersion, RuntimeContext, SessionFence, VersionRange,
};
use crate::provider_epoch::{ExitTombstone, ProviderExitKind};
#[cfg(feature = "ghostty-core-proof")]
use crate::terminal_replay::{
    TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION, TerminalCheckpoint,
    TerminalCheckpointEncoding, TerminalColdHistoryCheckpoint,
};
#[cfg(feature = "ghostty-core-proof")]
use fs2::FileExt;
use std::io::Write;
use tempfile::TempDir;

fn root(temp: &TempDir) -> DiscoveryRoot {
    DiscoveryRoot::create(temp.path().join("hmux")).unwrap()
}

fn create_empty_session(root: &DiscoveryRoot, session_id: &str) -> PathBuf {
    root.session(DiscoveryKey::new("workspace", session_id, "runner", 1).unwrap())
        .unwrap()
        .path()
        .to_path_buf()
}

fn publish_ready(root: &DiscoveryRoot, session_id: &str) -> PathBuf {
    publish_ready_with_processes(
        root,
        session_id,
        ProcessProof {
            process_id: 100,
            start_marker: "host-start".into(),
        },
        ProcessProof {
            process_id: 101,
            start_marker: "provider-start".into(),
        },
    )
}

fn publish_ready_with_processes(
    root: &DiscoveryRoot,
    session_id: &str,
    host_process: ProcessProof,
    provider_process: ProcessProof,
) -> PathBuf {
    let discovery = root
        .session(DiscoveryKey::new("workspace", session_id, "runner", 1).unwrap())
        .unwrap();
    let common = ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: Vec::new(),
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: session_id.into(),
            runner_principal: "runner".into(),
            runner_instance: "runner".into(),
            channel_epoch: 1,
        },
        host_instance_id: format!("host-{session_id}"),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        host_process,
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
    };
    let lock = discovery.acquire_lifetime_lock().unwrap();
    discovery
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    discovery
        .publish_ready(
            &lock,
            ReadyManifest {
                common,
                provider_process,
                terminal_epoch: "terminal-1".into(),
                ready_output_seq: 0,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "fixture.sock".into(),
                },
                capability_token: "token".into(),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
    drop(lock);
    discovery.path().to_path_buf()
}

fn publish_retired(root: &DiscoveryRoot, session_id: &str) -> PathBuf {
    publish_retired_with_processes(
        root,
        session_id,
        ProcessProof {
            process_id: 200,
            start_marker: "host-generation-marker".into(),
        },
        ProcessProof {
            process_id: 201,
            start_marker: "provider-generation-marker".into(),
        },
    )
}

fn publish_retired_with_processes(
    root: &DiscoveryRoot,
    session_id: &str,
    host_process: ProcessProof,
    provider_process: ProcessProof,
) -> PathBuf {
    let discovery = root
        .session(DiscoveryKey::new("workspace", session_id, "runner", 1).unwrap())
        .unwrap();
    let common = ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: Vec::new(),
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: session_id.into(),
            runner_principal: "runner".into(),
            runner_instance: "runner".into(),
            channel_epoch: 1,
        },
        host_instance_id: format!("host-{session_id}"),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: None,
        },
        host_process,
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
    };
    let exited = ExitedManifest {
        common: common.clone(),
        tombstone: Box::new(ExitTombstone {
            fence: SessionFence {
                workspace_id: "workspace".into(),
                session_id: session_id.into(),
                runner_principal: "runner".into(),
                runner_instance: "runner".into(),
                channel_epoch: 1,
                host_instance_id: common.host_instance_id.clone(),
                terminal_epoch: "terminal-1".into(),
            },
            provider_process,
            exit: Exit {
                final_output_seq: 1,
                exit_code: Some(0),
                platform_status: None,
                reason: "fixture".into(),
            },
            exit_kind: ProviderExitKind::Normal,
            created_unix_ms: 3,
            failure: None,
        }),
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::UnixSocket,
            address: "fixture.sock".into(),
        },
        capability_token: "token".into(),
        exited_unix_ms: 3,
    };
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    let lock = discovery.acquire_lifetime_lock().unwrap();
    discovery
        .publish_starting(
            &lock,
            StartingManifest {
                common,
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    discovery.publish_exited(&lock, exited).unwrap();
    discovery.retire_exited_current(&lock, &generation).unwrap();
    drop(lock);
    discovery.path().to_path_buf()
}

fn immediate_policy() -> DiscoveryGcPolicy {
    DiscoveryGcPolicy {
        selection: DiscoveryGcSelection::Retention,
        minimum_age_ms: 0,
        maximum_age_ms: 0,
        max_session_entries: 0,
        max_total_bytes: 0,
        max_scan_entries: 1_024,
        max_diagnostics: 32,
    }
}

#[test]
fn registration_plan_does_not_hold_maintenance_during_process_inspection() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    publish_ready(&root, "absent");
    let policy = DiscoveryGcPolicy {
        selection: DiscoveryGcSelection::AllEligible,
        ..immediate_policy()
    };
    let mut probed = false;
    let plan = root
        .plan_registration_garbage(&policy, |_| {
            probed = true;
            drop(root.acquire_maintenance_exclusive().unwrap());
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();
    assert!(probed);
    assert_eq!(plan.report.planned_sessions, 1);
}

#[test]
fn registration_quarantine_rechecks_new_protection_and_ready_generation() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let pending = create_empty_session(&root, "pending");
    let changed = create_empty_session(&root, "changed");
    let removable = create_empty_session(&root, "removable");
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    assert_eq!(plan.report.planned_sessions, 3);
    publish_ready(&root, "changed");
    let protected = BTreeSet::from([relative(root.path(), &pending).to_path_buf()]);
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &protected, |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();
    drop(maintenance);
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_sessions, 1);
    assert!(pending.exists());
    assert!(changed.join(MANIFEST_FILE_NAME).exists());
    assert!(!removable.exists());
}

#[test]
fn deferred_registration_sweep_does_not_block_or_delete_recreated_identity() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let old = create_empty_session(&root, "same-id");
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();
    assert!(!old.exists());
    assert_eq!(sweep.quarantines.len(), 1);
    drop(maintenance);
    // Holding the deferred sweep is equivalent to pausing recursive deletion.
    // A new generation of the same logical registration must remain writable.
    let current = publish_ready(&root, "same-id");
    assert_eq!(current, old);
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_sessions, 1);
    assert!(current.join(MANIFEST_FILE_NAME).exists());
    assert_eq!(root.registration_capacity().unwrap().used, 1);
}

#[test]
fn full_gc_sweep_and_hygiene_preserve_a_recreated_session_and_replaced_residue() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let old = create_empty_session(&root, "same-id");
    let residue_source = create_empty_session(&root, "crashed");
    let residue = residue_source
        .parent()
        .unwrap()
        .join(".gc-session_previous");
    fs::rename(&residue_source, &residue).unwrap();
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();
    drop(maintenance);
    let current = publish_ready(&root, "same-id");
    assert_eq!(current, old);
    let retained = temp.path().join("original-residue");
    fs::rename(&residue, &retained).unwrap();
    private_storage::create_directory(&residue).unwrap();
    // A held shared lease would deadlock any accidental exclusive acquisition
    // in recursive session deletion. The native guardian bounds this fixture.
    let shared = root.acquire_maintenance_shared().unwrap();
    let hygiene = sweep.sweep_for_full_gc().unwrap();
    drop(shared);
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_hygiene_locked(&maintenance, hygiene)
        .unwrap();
    drop(maintenance);
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_sessions, 1);
    assert_eq!(report.quarantine_residue_removed, 0);
    assert!(report.remaining_state_incomplete);
    assert!(current.join(MANIFEST_FILE_NAME).exists());
    assert!(residue.exists());
    assert!(retained.exists());
}

#[test]
fn full_gc_hygiene_rejects_a_different_root() {
    let left = TempDir::new().unwrap();
    let right = TempDir::new().unwrap();
    let left = root(&left);
    let right = root(&right);
    let plan = left
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    let maintenance = left.acquire_maintenance_exclusive().unwrap();
    let hygiene = left
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap()
        .sweep_for_full_gc()
        .unwrap();
    let wrong = right.acquire_maintenance_exclusive().unwrap();
    assert!(matches!(
        right.quarantine_hygiene_locked(&wrong, hygiene),
        Err(DiscoveryError::LockScopeMismatch)
    ));
}

#[test]
fn registration_quarantine_rejects_a_plan_from_another_root() {
    let left = TempDir::new().unwrap();
    let right = TempDir::new().unwrap();
    let left = root(&left);
    let right = root(&right);
    let candidate = create_empty_session(&left, "candidate");
    let plan = left
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    let maintenance = right.acquire_maintenance_exclusive().unwrap();
    assert!(matches!(
        right.quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        }),
        Err(DiscoveryError::LockScopeMismatch)
    ));
    assert!(candidate.exists());
}

#[test]
fn deferred_registration_sweep_preserves_a_replaced_quarantine_directory() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    create_empty_session(&root, "candidate");
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Absent)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();
    drop(maintenance);
    let quarantine = sweep.quarantines[0].0.path.clone();
    let retained = temp.path().join("retained-original");
    fs::rename(&quarantine, &retained).unwrap();
    private_storage::create_directory(&quarantine).unwrap();
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_sessions, 0);
    assert!(report.remaining_state_incomplete);
    assert!(quarantine.is_dir());
    assert!(retained.is_dir());
}

#[cfg(feature = "ghostty-core-proof")]
fn create_cold_history_directory(root: &DiscoveryRoot, namespace: &str, store_id: &str) -> PathBuf {
    let history_root = root.path().join(COLD_HISTORY_DIRECTORY_NAME);
    private_storage::create_directory(&history_root).unwrap();
    let path = history_root.join(super::super::cold_history_storage::history_directory_name(
        namespace, store_id,
    ));
    private_storage::create_directory(&path).unwrap();
    private_storage::open_lock_file(&path.join(COLD_HISTORY_LEASE_FILE_NAME)).unwrap();
    path
}

#[cfg(feature = "ghostty-core-proof")]
fn prepare_cold_sweep(root: &DiscoveryRoot) -> DiscoveryGcSweep {
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Unknown)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let hygiene = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Unknown
        })
        .unwrap()
        .sweep_for_full_gc()
        .unwrap();
    root.quarantine_hygiene_locked(&maintenance, hygiene)
        .unwrap()
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn cold_history_deletion_waits_for_unlocked_sweep() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let orphan = create_cold_history_directory(&root, "deferred", "orphan");
    let sweep = prepare_cold_sweep(&root);
    assert!(
        !orphan.exists(),
        "archive must be detached from its public identity"
    );
    let retained = fs::read_dir(root.path().join(COLD_HISTORY_DIRECTORY_NAME))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| has_component_prefix(path, QUARANTINE_COLD_HISTORY_PREFIX));
    assert!(
        retained.is_some(),
        "cold archive was recursively deleted inside the root fence instead of deferred"
    );
    let shared = root.acquire_maintenance_shared().unwrap();
    let recreated = create_cold_history_directory(&root, "deferred", "orphan");
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_cold_archives, 1);
    assert!(!retained.unwrap().exists());
    assert!(
        recreated.exists(),
        "new archive sharing the logical ID was deleted"
    );
    drop(shared);
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn pending_cold_sweep_retains_its_archive_lease_against_another_collector() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    create_cold_history_directory(&root, "deferred", "orphan");
    let sweep = prepare_cold_sweep(&root);
    let quarantine = sweep.quarantines[0].0.path.clone();
    let competing = prepare_cold_sweep(&root).sweep().unwrap();
    assert_eq!(competing.removed_cold_archives, 0);
    assert_eq!(competing.protected_cold_archives, 1);
    assert!(quarantine.exists());
    assert_eq!(sweep.sweep().unwrap().removed_cold_archives, 1);
    assert!(!quarantine.exists());
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn deferred_cold_sweep_preserves_a_replaced_quarantine_directory() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    create_cold_history_directory(&root, "deferred", "orphan");
    let sweep = prepare_cold_sweep(&root);
    let quarantine = sweep.quarantines[0].0.path.clone();
    let retained = temp.path().join("retained-original");
    fs::rename(&quarantine, &retained).unwrap();
    private_storage::create_directory(&quarantine).unwrap();
    let report = sweep.sweep().unwrap();
    assert_eq!(report.removed_cold_archives, 0);
    assert!(report.remaining_state_incomplete);
    assert!(quarantine.is_dir());
    assert!(retained.is_dir());
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn cold_residue_without_a_lease_is_read_only_in_preview_and_recoverable_in_apply() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let orphan = create_cold_history_directory(&root, "deferred", "orphan");
    let residue = orphan.with_file_name(format!("{QUARANTINE_COLD_HISTORY_PREFIX}crashed"));
    fs::rename(&orphan, &residue).unwrap();
    fs::remove_file(residue.join(COLD_HISTORY_LEASE_FILE_NAME)).unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let preview = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Preview,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(preview.removed_cold_archives, 0);
    assert!(residue.exists());
    assert!(!residue.join(COLD_HISTORY_LEASE_FILE_NAME).exists());
    drop(maintenance);
    let sweep = prepare_cold_sweep(&root);
    assert!(!residue.exists());
    let quarantine = sweep.quarantines[0].0.path.clone();
    assert!(quarantine.join(COLD_HISTORY_LEASE_FILE_NAME).exists());
    let competing = prepare_cold_sweep(&root).sweep().unwrap();
    assert_eq!(competing.protected_cold_archives, 1);
    assert_eq!(sweep.sweep().unwrap().removed_cold_archives, 1);
    assert!(!quarantine.exists());
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn cold_quarantine_requires_exact_identity_and_durable_rename_before_sweep() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let orphan = create_cold_history_directory(&root, "deferred", "orphan");
    let make_candidate = || {
        let lease = private_storage::open_existing_file(&orphan.join(COLD_HISTORY_LEASE_FILE_NAME))
            .unwrap();
        FileExt::lock_exclusive(&lease).unwrap();
        ColdHistoryGcCandidate {
            path: orphan.clone(),
            directory_name: orphan.file_name().unwrap().to_str().unwrap().into(),
            bytes: 0,
            lease,
            directory_identity: directory_identity(&orphan).unwrap(),
        }
    };
    let original = make_candidate();
    let retained = temp.path().join("retained-original");
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    fs::rename(&orphan, &retained).unwrap();
    create_cold_history_directory(&root, "deferred", "orphan");
    assert!(matches!(
        quarantine_cold_history_candidate(orphan.parent().unwrap(), original, |_| true),
        Err(DiscoveryError::GenerationMismatch)
    ));
    assert!(orphan.exists());
    assert!(retained.exists());
    let mut report = DiscoveryGcReport::default();
    let mut quarantines = Vec::new();
    quarantine_cold_history_garbage(
        &root,
        DiscoveryGcMode::Apply,
        &immediate_policy(),
        &mut report,
        &mut quarantines,
        |_| false,
    )
    .unwrap();
    assert!(
        quarantines.is_empty(),
        "non-durable rename must not be admitted to the sweep"
    );
    assert_eq!(report.removed_cold_archives, 0);
    assert!(report.remaining_state_incomplete);
    assert!(!orphan.exists());
    let quarantine_path = fs::read_dir(orphan.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| has_component_prefix(path, QUARANTINE_COLD_HISTORY_PREFIX))
        .expect("non-durable rename must remain recoverable");
    drop(maintenance);
    assert_eq!(
        prepare_cold_sweep(&root)
            .sweep()
            .unwrap()
            .removed_cold_archives,
        1
    );
    assert!(!quarantine_path.exists());
    assert!(retained.exists());
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn incomplete_cold_archive_census_does_not_detach_earlier_candidates() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let first = create_cold_history_directory(&root, "deferred", "first");
    let second = create_cold_history_directory(&root, "deferred", "second");
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let policy = DiscoveryGcPolicy {
        max_scan_entries: 2,
        ..immediate_policy()
    };
    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(report.removed_cold_archives, 0);
    assert!(report.remaining_state_incomplete);
    assert!(first.exists());
    assert!(second.exists());
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn cold_history_gc_gives_each_complete_census_its_own_scan_budget() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let orphan = create_cold_history_directory(&root, "history-a", "store-a");
    let policy = DiscoveryGcPolicy {
        // The discovery-root census, cold-history reference census, and cold
        // archive census each fit this bound. Their aggregate deliberately
        // does not: independent safety proofs must not consume one another's
        // budget and strand the state that only GC can remove.
        max_scan_entries: 2,
        ..immediate_policy()
    };
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
        )
        .unwrap();

    assert!(
        !orphan.exists(),
        "orphaned archive was stranded: {report:?}"
    );
    assert_eq!(report.removed_cold_archives, 1);
    assert!(!report.remaining_state_incomplete, "{report:?}");
    assert!(report.scanned_entries > policy.max_scan_entries);
}

#[cfg(feature = "ghostty-core-proof")]
#[test]
fn cold_history_gc_preserves_checkpoint_references_and_busy_leases() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    publish_ready(&root, "ready");
    let discovery = root
        .open_session(DiscoveryKey::new("workspace", "ready", "runner", 1).unwrap())
        .unwrap();
    let DiscoveryManifest::Ready(ready) = discovery.read_manifest().unwrap() else {
        panic!("fixture must remain ready");
    };
    let lifetime = discovery.acquire_lifetime_lock().unwrap();
    let referenced = create_cold_history_directory(&root, "history-a", "store-a");
    let handoff_referenced = create_cold_history_directory(&root, "history-d", "store-d");
    let orphan = create_cold_history_directory(&root, "history-b", "store-b");
    let busy = create_cold_history_directory(&root, "history-c", "store-c");
    let busy_lease =
        private_storage::open_existing_file(&busy.join(COLD_HISTORY_LEASE_FILE_NAME)).unwrap();
    FileExt::lock_exclusive(&busy_lease).unwrap();
    // Full GC must reread archive references after the unlocked session sweep;
    // the checkpoints below deliberately do not exist in its original plan.
    let plan = root
        .plan_registration_garbage(&immediate_policy(), |_| DiscoveryGcProcessStatus::Unknown)
        .unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_registration_garbage_locked(&maintenance, plan, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Unknown
        })
        .unwrap();
    drop(maintenance);
    let hygiene = sweep.sweep_for_full_gc().unwrap();
    let checkpoint = PresentationCheckpoint::capture_terminal(
        &TerminalCheckpoint {
            fence: PresentationCheckpointSource::from_ready(&ready).fence(),
            sequence_through: 1,
            state_revision: 1,
            rows: 4,
            columns: 80,
            encoding: TerminalCheckpointEncoding::EngineNativeV1 {
                engine_fingerprint: "libghostty-vt:test".into(),
            },
            payload: vec![1],
            alternate_screen: false,
            cursor_visible: true,
            cold_history: Some(TerminalColdHistoryCheckpoint {
                schema_version: TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION,
                history_namespace: "history-a".into(),
                store_id: "store-a".into(),
                root_generation: 1,
                end_boundary_token: [1; 16],
                end_logical_line_id: 2,
                root_digest: [2; 32],
            }),
        },
        1,
    )
    .unwrap();
    discovery
        .write_presentation_checkpoint(&lifetime, &checkpoint)
        .unwrap();
    let handoff_checkpoint = PresentationCheckpoint::capture_terminal(
        &TerminalCheckpoint {
            fence: PresentationCheckpointSource::from_ready(&ready).fence(),
            sequence_through: 2,
            state_revision: 2,
            rows: 4,
            columns: 80,
            encoding: TerminalCheckpointEncoding::EngineNativeV1 {
                engine_fingerprint: "libghostty-vt:test".into(),
            },
            payload: vec![2],
            alternate_screen: false,
            cursor_visible: true,
            cold_history: Some(TerminalColdHistoryCheckpoint {
                schema_version: TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION,
                history_namespace: "history-d".into(),
                store_id: "store-d".into(),
                root_generation: 1,
                end_boundary_token: [3; 16],
                end_logical_line_id: 2,
                root_digest: [4; 32],
            }),
        },
        2,
    )
    .unwrap();
    let handoff = discovery
        .write_presentation_handoff(
            &PresentationCheckpointSource::from_ready(&ready),
            &handoff_checkpoint,
        )
        .unwrap();

    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let sweep = root
        .quarantine_hygiene_locked(&maintenance, hygiene)
        .unwrap();
    drop(maintenance);
    let report = sweep.sweep().unwrap();

    assert!(
        referenced.exists(),
        "checkpoint-owned archive was collected"
    );
    assert!(
        handoff_referenced.exists(),
        "handoff-owned archive was collected"
    );
    assert!(busy.exists(), "live archive lease was collected");
    assert!(
        !orphan.exists(),
        "unreferenced unlocked archive leaked: {report:?}"
    );
    assert_eq!(report.removed_cold_archives, 1);
    assert_eq!(report.protected_cold_archives, 3);
    assert!(!report.remaining_state_incomplete, "{report:?}");

    let orphan_after_tamper = create_cold_history_directory(&root, "history-e", "store-e");
    let handoff_path = discovery.path().join(format!(
        "{}{}.json",
        super::super::manifest_store::PRESENTATION_HANDOFF_FILE_PREFIX,
        handoff.file_id()
    ));
    fs::write(&handoff_path, serde_json::to_vec(&checkpoint).unwrap()).unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let tampered = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert!(
        orphan_after_tamper.exists(),
        "a valid-JSON handoff with the wrong external digest must protect every archive"
    );
    assert_eq!(tampered.removed_cold_archives, 0);
    assert!(tampered.remaining_state_incomplete, "{tampered:?}");
    FileExt::unlock(&busy_lease).unwrap();
}

#[test]
fn preview_is_read_only_and_apply_quarantines_missing_manifest_debris() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let debris = create_empty_session(&root, "debris");
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let preview = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Preview,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(preview.planned_sessions, 1);
    assert!(preview.eligible_oldest_age_ms.is_some());
    assert_eq!(
        preview.planned_oldest_age_ms,
        preview.eligible_oldest_age_ms
    );
    assert!(debris.exists());
    assert!(!debris.join(LIFETIME_LOCK_FILE_NAME).exists());

    let applied = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(applied.quarantined_sessions, 1, "{applied:?}");
    assert_eq!(applied.removed_sessions, 1, "{applied:?}");
    assert!(!debris.exists());
}

#[test]
fn valid_manifest_pending_recovery_and_busy_lifetime_are_preserved() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let ready = publish_ready(&root, "ready");
    let protected = create_empty_session(&root, "protected");
    let locked = root
        .session(DiscoveryKey::new("workspace", "locked", "runner", 1).unwrap())
        .unwrap();
    let lifetime = locked.acquire_lifetime_lock().unwrap();
    let mut protected_paths = BTreeSet::new();
    protected_paths.insert(protected.strip_prefix(root.path()).unwrap().to_path_buf());
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &protected_paths,
        )
        .unwrap();

    assert_eq!(report.removed_sessions, 0);
    assert!(report.budget_unmet);
    assert!(ready.exists());
    assert!(protected.exists());
    assert!(locked.path().exists());
    drop(lifetime);
}

#[test]
fn count_budget_removes_oldest_eligible_debris_until_bounded() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    for session_id in ["one", "two", "three"] {
        create_empty_session(&root, session_id);
    }
    let policy = DiscoveryGcPolicy {
        selection: DiscoveryGcSelection::Retention,
        minimum_age_ms: 0,
        maximum_age_ms: u64::MAX,
        max_session_entries: 1,
        max_total_bytes: u64::MAX,
        max_scan_entries: 1_024,
        max_diagnostics: 32,
    };
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
        )
        .unwrap();

    assert_eq!(report.removed_sessions, 2);
    assert_eq!(report.remaining_sessions, 1);
    assert!(!report.budget_unmet);
}

#[test]
fn all_eligible_selection_removes_safe_debris_below_retention_budgets() {
    fn preserve_ready(proof: &ProcessProof) -> DiscoveryGcProcessStatus {
        if matches!(proof.start_marker.as_str(), "host-start" | "provider-start") {
            DiscoveryGcProcessStatus::Live
        } else {
            DiscoveryGcProcessStatus::Absent
        }
    }

    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let first = create_empty_session(&root, "first");
    let second = create_empty_session(&root, "second");
    let ready = publish_ready(&root, "ready");
    let mut policy = DiscoveryGcPolicy {
        selection: DiscoveryGcSelection::Retention,
        minimum_age_ms: 0,
        maximum_age_ms: u64::MAX,
        max_session_entries: usize::MAX,
        max_total_bytes: u64::MAX,
        max_scan_entries: 1_024,
        max_diagnostics: 32,
    };

    let retained = root
        .preview_garbage_with_process_probe(&policy, &BTreeSet::new(), preserve_ready)
        .unwrap();
    assert_eq!(retained.eligible_sessions, 2);
    assert_eq!(retained.planned_sessions, 0);
    assert!(first.exists());
    assert!(second.exists());
    assert!(ready.exists());

    policy.selection = DiscoveryGcSelection::AllEligible;
    let preview = root
        .preview_garbage_with_process_probe(&policy, &BTreeSet::new(), preserve_ready)
        .unwrap();
    assert_eq!(preview.eligible_sessions, 2);
    assert_eq!(preview.planned_sessions, preview.eligible_sessions);
    assert!(first.exists());
    assert!(second.exists());
    assert!(ready.exists());

    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let applied = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            preserve_ready,
        )
        .unwrap();
    assert_eq!(applied.removed_sessions, 2);
    assert!(!first.exists());
    assert!(!second.exists());
    assert!(ready.exists());

    let converged = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            preserve_ready,
        )
        .unwrap();
    assert_eq!(converged.eligible_sessions, 0);
    assert_eq!(converged.planned_sessions, 0);
    assert_eq!(converged.quarantined_sessions, 0);
    assert_eq!(converged.removed_sessions, 0);
}

#[test]
fn all_eligible_selection_keeps_the_default_minimum_age_floor() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let too_young = create_empty_session(&root, "too-young");
    let policy = DiscoveryGcPolicy {
        selection: DiscoveryGcSelection::AllEligible,
        ..DiscoveryGcPolicy::default()
    };

    let preview = root
        .preview_garbage_with_process_probe(&policy, &BTreeSet::new(), |_| {
            DiscoveryGcProcessStatus::Absent
        })
        .unwrap();

    assert_eq!(preview.eligible_sessions, 0);
    assert_eq!(preview.planned_sessions, 0);
    assert_eq!(preview.protected_sessions, 1);
    assert!(too_young.exists());
}

#[test]
fn retired_process_proof_is_fail_closed_and_exact_absence_allows_gc() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let retired = publish_retired(&root, "retired");
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let fail_closed = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(fail_closed.removed_sessions, 0);
    assert!(retired.exists());

    let mut observed = Vec::new();
    let removed = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
            |proof| {
                observed.push((proof.process_id, proof.start_marker.clone()));
                DiscoveryGcProcessStatus::Absent
            },
        )
        .unwrap();
    assert_eq!(removed.removed_sessions, 1);
    assert_eq!(
        observed,
        vec![
            (200, "host-generation-marker".into()),
            (201, "provider-generation-marker".into()),
            (200, "host-generation-marker".into()),
            (201, "provider-generation-marker".into()),
        ]
    );
    assert!(!retired.exists());
}

#[test]
fn abandoned_ready_gc_requires_an_unowned_lifetime_and_exact_process_absence() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let absent = publish_ready_with_processes(
        &root,
        "absent-ready",
        ProcessProof {
            process_id: 600,
            start_marker: "absent-ready-host".into(),
        },
        ProcessProof {
            process_id: 601,
            start_marker: "absent-ready-provider".into(),
        },
    );
    let live = publish_ready_with_processes(
        &root,
        "live-ready",
        ProcessProof {
            process_id: 700,
            start_marker: "live-ready-host".into(),
        },
        ProcessProof {
            process_id: 701,
            start_marker: "live-ready-provider".into(),
        },
    );
    let unknown = publish_ready_with_processes(
        &root,
        "unknown-ready",
        ProcessProof {
            process_id: 800,
            start_marker: "unknown-ready-host".into(),
        },
        ProcessProof {
            process_id: 801,
            start_marker: "unknown-ready-provider".into(),
        },
    );
    let reconnecting = publish_ready_with_processes(
        &root,
        "reconnecting-ready",
        ProcessProof {
            process_id: 900,
            start_marker: "absent-reconnecting-host".into(),
        },
        ProcessProof {
            process_id: 901,
            start_marker: "absent-reconnecting-provider".into(),
        },
    );
    let reconnecting_session = root
        .open_session(DiscoveryKey::new("workspace", "reconnecting-ready", "runner", 1).unwrap())
        .unwrap();
    let reconnecting_lifetime = reconnecting_session.acquire_lifetime_lock().unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let mut policy = immediate_policy();
    policy.selection = DiscoveryGcSelection::AllEligible;

    let report = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            |proof| match proof.start_marker.as_str() {
                marker if marker.starts_with("absent-") => DiscoveryGcProcessStatus::Absent,
                marker if marker.starts_with("live-") => DiscoveryGcProcessStatus::Live,
                _ => DiscoveryGcProcessStatus::Unknown,
            },
        )
        .unwrap();

    assert_eq!(report.eligible_sessions, 1);
    assert_eq!(report.planned_sessions, 1);
    assert_eq!(report.removed_sessions, 1);
    assert!(!absent.exists(), "the exact abandoned generation leaked");
    assert!(live.exists(), "a live generation was collected");
    assert!(
        unknown.exists(),
        "an ambiguous generation did not fail closed"
    );
    assert!(
        reconnecting.exists(),
        "a transport-reconnecting Host that still owns its lifetime was collected"
    );
    drop(reconnecting_lifetime);
}

#[test]
fn abandoned_ready_gc_rejects_a_generation_replaced_during_process_proof() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let session_path = publish_ready_with_processes(
        &root,
        "generation-race",
        ProcessProof {
            process_id: 1_000,
            start_marker: "old-host".into(),
        },
        ProcessProof {
            process_id: 1_001,
            start_marker: "old-provider".into(),
        },
    );
    let manifest_path = session_path.join("manifest.json");
    let mut replacement = match read_current_manifest_at(&manifest_path, root.limits()).unwrap() {
        DiscoveryManifest::Ready(ready) => ready,
        _ => panic!("fixture must be ready"),
    };
    replacement.common.host_instance_id = "replacement-host".into();
    replacement.terminal_epoch = "replacement-terminal".into();
    let replacement = DiscoveryManifest::Ready(replacement);
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let mut replaced = false;
    let mut policy = immediate_policy();
    policy.selection = DiscoveryGcSelection::AllEligible;

    let report = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            |_| {
                if !replaced {
                    fs::write(&manifest_path, serde_json::to_vec(&replacement).unwrap()).unwrap();
                    replaced = true;
                }
                DiscoveryGcProcessStatus::Absent
            },
        )
        .unwrap();

    assert!(replaced);
    assert_eq!(report.removed_sessions, 0);
    assert!(session_path.exists());
    assert_eq!(
        read_current_manifest_at(&manifest_path, root.limits())
            .unwrap()
            .generation(),
        replacement.generation()
    );
}

#[test]
fn mixed_health_faults_remove_only_the_exact_absent_generation() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let ready = publish_ready(&root, "ready");
    let pending = create_empty_session(&root, "pending-recovery");
    let live = publish_retired_with_processes(
        &root,
        "live-retired",
        ProcessProof {
            process_id: 300,
            start_marker: "live-host".into(),
        },
        ProcessProof {
            process_id: 301,
            start_marker: "live-provider".into(),
        },
    );
    let unknown = publish_retired_with_processes(
        &root,
        "unknown-retired",
        ProcessProof {
            process_id: 400,
            start_marker: "unknown-host".into(),
        },
        ProcessProof {
            process_id: 401,
            start_marker: "unknown-provider".into(),
        },
    );
    let absent = publish_retired_with_processes(
        &root,
        "absent-retired",
        ProcessProof {
            process_id: 500,
            start_marker: "absent-host".into(),
        },
        ProcessProof {
            process_id: 501,
            start_marker: "absent-provider".into(),
        },
    );
    let mut protected_paths = BTreeSet::new();
    protected_paths.insert(pending.strip_prefix(root.path()).unwrap().to_path_buf());
    let mut policy = immediate_policy();
    policy.selection = DiscoveryGcSelection::AllEligible;
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &protected_paths,
            |proof| match proof.start_marker.as_str() {
                marker if marker.starts_with("live-") => DiscoveryGcProcessStatus::Live,
                marker if marker.starts_with("absent-") => DiscoveryGcProcessStatus::Absent,
                _ => DiscoveryGcProcessStatus::Unknown,
            },
        )
        .unwrap();

    assert_eq!(report.eligible_sessions, 1);
    assert_eq!(report.planned_sessions, 1);
    assert_eq!(report.removed_sessions, 1);
    assert!(
        ready.exists(),
        "a valid ready manifest is never a GC candidate"
    );
    assert!(pending.exists(), "pending recovery remains authoritative");
    assert!(
        live.exists(),
        "a process-proven live generation is protected"
    );
    assert!(unknown.exists(), "an indeterminate generation fails closed");
    assert!(!absent.exists(), "only exact absence authorizes removal");
}

#[test]
fn same_length_tree_change_after_eligibility_snapshot_is_protected() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let retired = publish_retired(&root, "fingerprint-race");
    let presentation = retired.join("presentation.json");
    let mut file = private_storage::open_new_file(&presentation).unwrap();
    file.write_all(b"AAAA").unwrap();
    file.sync_all().unwrap();
    let original_modified = file.metadata().unwrap().modified().unwrap();
    drop(file);
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let mut mutated = false;
    let mut policy = immediate_policy();
    policy.selection = DiscoveryGcSelection::AllEligible;

    let report = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            |_| {
                if !mutated {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .truncate(true)
                        .open(&presentation)
                        .unwrap();
                    file.write_all(b"BBBB").unwrap();
                    file.sync_all().unwrap();
                    file.set_times(fs::FileTimes::new().set_modified(original_modified))
                        .unwrap();
                    mutated = true;
                }
                DiscoveryGcProcessStatus::Absent
            },
        )
        .unwrap();

    assert!(mutated);
    assert_eq!(report.removed_sessions, 0);
    assert_eq!(report.remaining_sessions, 1);
    assert!(report.remaining_bytes > 0);
    assert!(report.remaining_state_incomplete);
    assert_eq!(fs::read(&presentation).unwrap(), b"BBBB");
    assert!(retired.exists());

    let retried = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            |_| DiscoveryGcProcessStatus::Absent,
        )
        .unwrap();
    assert_eq!(retried.eligible_sessions, 1);
    assert_eq!(retried.planned_sessions, 1);
    assert_eq!(retried.removed_sessions, 1);
    assert!(!retired.exists());

    let converged = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
            |_| DiscoveryGcProcessStatus::Absent,
        )
        .unwrap();
    assert_eq!(converged.eligible_sessions, 0);
    assert_eq!(converged.planned_sessions, 0);
    assert_eq!(converged.removed_sessions, 0);
}

#[test]
fn next_apply_sweeps_crash_residue_without_removing_new_non_durable_quarantine() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let source = create_empty_session(&root, "crash-residue");
    let workspace = source
        .parent()
        .expect("session has a workspace")
        .to_path_buf();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let faulted = root
        .collect_garbage(
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
            &mut |_| DiscoveryGcProcessStatus::Unknown,
            &mut |_| false,
            Some(DiscoveryGcMutationAuthority::new(&root, &maintenance).unwrap()),
        )
        .unwrap();
    let quarantine = fs::read_dir(&workspace)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| has_component_prefix(path, QUARANTINE_SESSION_PREFIX))
        .expect("failed parent sync must retain the actual quarantined tree");
    assert_eq!(faulted.quarantined_sessions, 1);
    assert_eq!(faulted.removed_sessions, 0);
    assert_eq!(faulted.remaining_sessions, 1);
    assert_eq!(faulted.remaining_bytes, faulted.quarantine_residue_bytes);
    assert!(faulted.budget_unmet);
    assert!(!source.exists());
    assert!(quarantine.exists());

    let recovered = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();

    assert_eq!(recovered.quarantine_residue_removed, 1);
    assert!(!quarantine.exists());
}

#[test]
fn quarantine_scan_limit_retains_residue_instead_of_deleting_uninspected_state() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let source = create_empty_session(&root, "scan-limit");
    let workspace = source.parent().expect("session has a workspace");
    let quarantine = workspace.join(format!("{QUARANTINE_SESSION_PREFIX}scan_limit"));
    fs::rename(&source, &quarantine).unwrap();
    private_storage::sync_directory(workspace).unwrap();
    drop(private_storage::open_new_file(&quarantine.join("lifetime.lock")).unwrap());
    drop(private_storage::open_new_file(&quarantine.join(".manifest.tmp-crash")).unwrap());
    let policy = DiscoveryGcPolicy {
        max_scan_entries: 2,
        ..immediate_policy()
    };
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
        )
        .unwrap();

    assert_eq!(report.quarantine_residue_removed, 0);
    assert!(report.budget_unmet);
    assert!(quarantine.exists());
}

#[cfg(unix)]
#[test]
fn symlinked_state_is_fail_closed_and_external_target_is_untouched() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let session = create_empty_session(&root, "unsafe");
    let target = temp.path().join("external-target");
    fs::write(&target, b"must survive").unwrap();
    symlink(&target, session.join("presentation.json")).unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();

    assert_eq!(report.removed_sessions, 0);
    assert!(report.budget_unmet);
    assert_eq!(fs::read(&target).unwrap(), b"must survive");
    assert!(session.exists());
}

#[test]
fn shared_maintenance_lock_blocks_gc_exclusive_lock() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let shared = root.acquire_maintenance_shared().unwrap();
    assert!(matches!(
        root.acquire_maintenance_exclusive(),
        Err(DiscoveryError::AlreadyLocked { .. })
    ));
    drop(shared);
    root.acquire_maintenance_exclusive().unwrap();
}

#[test]
fn writer_shared_maintenance_waits_for_gc_instead_of_failing_session_work() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let path = root.path().to_path_buf();
    let exclusive = root.acquire_maintenance_exclusive().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let root = DiscoveryRoot::open(path).unwrap();
        let shared = root.acquire_maintenance_shared().unwrap();
        sender.send(()).unwrap();
        drop(shared);
    });

    assert!(
        receiver
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err()
    );
    drop(exclusive);
    receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    writer.join().unwrap();
}

#[test]
fn session_creation_holds_shared_maintenance_until_lifetime_lock() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let creating = root
        .session(DiscoveryKey::new("workspace", "creating", "runner", 1).unwrap())
        .unwrap();
    assert!(matches!(
        root.acquire_maintenance_exclusive(),
        Err(DiscoveryError::AlreadyLocked { .. })
    ));

    let lifetime = creating.acquire_lifetime_lock().unwrap();
    let maintenance = root.acquire_maintenance_exclusive().unwrap();
    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(report.removed_sessions, 0);
    assert!(creating.path().exists());
    drop(lifetime);
}

#[test]
fn malformed_retired_process_evidence_is_protected_not_treated_as_absent() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    let session = create_empty_session(&root, "corrupt-retired");
    let retired = session.join("retired");
    private_storage::create_directory(&retired).unwrap();
    let mut record = private_storage::open_new_file(&retired.join("g_corrupt.json")).unwrap();
    record.write_all(b"{not-json").unwrap();
    drop(record);
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked_with_process_probe(
            &maintenance,
            DiscoveryGcMode::Apply,
            &immediate_policy(),
            &BTreeSet::new(),
            |_| DiscoveryGcProcessStatus::Absent,
        )
        .unwrap();

    assert_eq!(report.removed_sessions, 0);
    assert!(report.budget_unmet);
    assert!(session.exists());
}

#[test]
fn non_session_root_flood_is_bounded_before_destructive_scan() {
    let temp = TempDir::new().unwrap();
    let root = root(&temp);
    for index in 0..4 {
        let path = root.path().join(format!("unknown-{index}"));
        private_storage::open_new_file(&path).unwrap();
    }
    let policy = DiscoveryGcPolicy {
        max_scan_entries: 2,
        ..immediate_policy()
    };
    let maintenance = root.acquire_maintenance_exclusive().unwrap();

    let report = root
        .collect_garbage_locked(
            &maintenance,
            DiscoveryGcMode::Apply,
            &policy,
            &BTreeSet::new(),
        )
        .unwrap();

    assert!(report.budget_unmet);
    assert_eq!(report.removed_sessions, 0);
    assert!(report.scanned_entries <= policy.max_scan_entries + 1);
}
