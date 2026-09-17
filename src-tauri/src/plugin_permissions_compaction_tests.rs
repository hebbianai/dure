use super::*;
use std::cell::Cell;
use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt;
use tempfile::TempDir;

fn fixture() -> (TempDir, PathBuf) {
    let temporary = tempfile::tempdir().expect("tempdir");
    let control_root = temporary.path().join("channel");
    DirBuilder::new()
        .mode(0o700)
        .create(&control_root)
        .expect("control root");
    (temporary, control_root)
}

fn request_id(value: &str) -> PluginPermissionDecisionRequestIdV2 {
    PluginPermissionDecisionRequestIdV2::new(value).unwrap()
}

fn target_and_plan(
    state: &DurePluginPermissionState,
    workspace: &Path,
) -> (ResolvedPluginPermissionTarget, PluginPermissionPlanV2) {
    let plugin_id = PluginIdV2::new("dure.beads").unwrap();
    let target = state.resolve_target(workspace, &plugin_id).unwrap();
    let plan = crate::plugin_catalog::bundled_permission_plan(
        &plugin_id,
        target.workspace().identity().clone(),
    )
    .unwrap();
    (target, plan)
}

fn compact_values(bytes: &[u8]) -> (serde_json::Value, serde_json::Value) {
    let mut lines = bytes.split(|byte| *byte == b'\n');
    let manifest = serde_json::from_slice(lines.next().unwrap()).unwrap();
    let payload = serde_json::from_slice(lines.next().unwrap()).unwrap();
    assert!(lines.next().unwrap().is_empty());
    assert!(lines.next().is_none());
    (manifest, payload)
}

fn encode_compact_values(
    mut manifest: serde_json::Value,
    payload: serde_json::Value,
    tail: &[u8],
) -> Vec<u8> {
    let payload = serde_json::to_vec(&payload).unwrap();
    manifest["payloadLen"] = serde_json::Value::from(payload.len() as u64);
    manifest["payloadSha256"] = serde_json::Value::String(journal_sha256(&payload));
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let mut bytes = Vec::with_capacity(manifest.len() + payload.len() + tail.len() + 2);
    bytes.extend(manifest);
    bytes.push(b'\n');
    bytes.extend(payload);
    bytes.push(b'\n');
    bytes.extend(tail);
    bytes
}

fn overwrite_canonical_journal(state: &DurePluginPermissionState, bytes: &[u8]) {
    let path = state.store.directory.join(JOURNAL_FILE);
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    sync_directory(&state.store.directory).unwrap();
}

#[test]
fn every_compaction_fault_recovers_to_the_exact_source_or_target_generation() {
    use compaction::CompactionFaultStage::{
        AnchorSync, AnchorWrite, IntentCleanup, IntentCleanupDirectorySync,
        IntentPublishDirectorySync, IntentPublishRename, IntentSync, IntentTargetDirectorySync,
        IntentWrite, PublishDirectorySync, PublishRename, SourceRevalidate, TargetDirectorySync,
        TargetSync, TargetWrite,
    };

    let stages = [
        TargetWrite,
        TargetSync,
        TargetDirectorySync,
        IntentWrite,
        IntentSync,
        IntentTargetDirectorySync,
        IntentPublishRename,
        IntentPublishDirectorySync,
        AnchorWrite,
        AnchorSync,
        SourceRevalidate,
        PublishRename,
        PublishDirectorySync,
        IntentCleanup,
        IntentCleanupDirectorySync,
    ];

    for stage in stages {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = target_and_plan(&state, &workspace);
        let review_request = request_id("review-before-compaction-fault");
        let authoritative = state
            .store
            .decide(
                &target,
                review_request.clone(),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();

        let mut journal = LockedJournal::open(&state.store.directory).unwrap();
        let source = journal.bytes.clone();
        let loaded = LoadedPermissionJournal::read(&journal).unwrap();
        let (compact_target, generation) = loaded.compacted_bytes(0).unwrap();
        compaction::fail_next_compaction_at(stage);
        let error = journal
            .publish_compacted_bytes(compact_target.clone(), generation)
            .unwrap_err();
        assert_eq!(
            error.code(),
            "plugin_permission_store_io",
            "stage {stage:?}"
        );
        drop(journal);

        let restarted = DurePluginPermissionState::open_at(&control_root).unwrap();
        assert_eq!(restarted.snapshot(&target).unwrap(), authoritative);
        let recovered_bytes = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
        let fails_before_intent = matches!(
            stage,
            TargetWrite
                | TargetSync
                | TargetDirectorySync
                | IntentWrite
                | IntentSync
                | IntentTargetDirectorySync
                | IntentPublishRename
        );
        if fails_before_intent {
            assert_eq!(recovered_bytes, source, "stage {stage:?}");
        } else {
            assert_eq!(recovered_bytes, compact_target, "stage {stage:?}");
        }
        let recovered = LoadedPermissionJournal::read_bytes(&recovered_bytes).unwrap();
        assert_eq!(recovered.event_count, 1);
        assert_eq!(
            recovered.format,
            if fails_before_intent {
                PermissionJournalFormat::Legacy
            } else {
                PermissionJournalFormat::Compact { generation: 1 }
            },
            "stage {stage:?}"
        );
        assert!(
            !compaction::recovery_required(&state.store.directory).unwrap(),
            "stage {stage:?}"
        );
        let (intent_path, target_path) = compaction::compaction_paths(&state.store.directory);
        assert!(!intent_path.exists(), "stage {stage:?}");
        assert!(!target_path.exists(), "stage {stage:?}");

        let replayed = restarted
            .store
            .decide(
                &target,
                review_request,
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        assert_eq!(replayed, authoritative, "stage {stage:?}");
        assert_eq!(
            std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
            recovered_bytes,
            "stage {stage:?}"
        );
    }
}

#[test]
fn authority_anchor_rejects_same_generation_receipt_and_compaction_rollbacks() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-same-generation-rollback"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let receipt_prefix = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let lock_bytes = std::fs::read(state.store.directory.join(LOCK_FILE)).unwrap();
    assert!(lock_bytes.len() > SECRET_BYTES);
    assert_ne!(
        lock_bytes.len(),
        SECRET_BYTES,
        "a frozen reader that requires exactly 32 commitment bytes must fail closed"
    );
    state
        .store
        .decide(
            &target,
            request_id("second-disabled-review-before-rollback"),
            approved.record_revision(),
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    overwrite_canonical_journal(&state, &receipt_prefix);
    let error = DurePluginPermissionState::open_at(&control_root).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_authority_invalid");
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        receipt_prefix
    );

    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-generation-rollback"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let enabled = state
        .enable(
            &target,
            request_id("enable-before-generation-rollback"),
            approved.record_revision(),
            plan.digest(),
            &plan,
        )
        .unwrap();
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (generation_one, generation) = loaded.compacted_bytes(0).unwrap();
    journal
        .publish_compacted_bytes(generation_one.clone(), generation)
        .unwrap();
    drop(journal);
    state
        .store
        .decide(
            &target,
            request_id("reject-before-generation-rollback"),
            enabled.record_revision(),
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Reject,
        )
        .unwrap();
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (generation_two, generation) = loaded.compacted_bytes(0).unwrap();
    assert_eq!(generation, 2);
    journal
        .publish_compacted_bytes(generation_two, generation)
        .unwrap();
    drop(journal);
    assert_eq!(
        state.snapshot(&target).unwrap().enablement(),
        PluginPermissionEnablementV2::Disabled
    );

    overwrite_canonical_journal(&state, &generation_one);
    let error = DurePluginPermissionState::open_at(&control_root).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_authority_invalid");
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        generation_one
    );
}

#[test]
fn first_current_reader_anchors_legacy_bytes_and_rejects_a_later_canonical_rollback() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("legacy-baseline-review"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let legacy = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let mut fixture_journal = LockedJournal::open(&state.store.directory).unwrap();
    fixture_journal
        .replace_bytes_for_fixture(legacy.clone())
        .unwrap();
    drop(fixture_journal);
    let lock_path = state.store.directory.join(LOCK_FILE);
    assert_eq!(
        std::fs::metadata(&lock_path).unwrap().len(),
        SECRET_BYTES as u64
    );

    let upgraded = DurePluginPermissionState::open_at(&control_root).unwrap();
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        legacy
    );
    assert!(std::fs::metadata(&lock_path).unwrap().len() > SECRET_BYTES as u64);

    upgraded
        .store
        .decide(
            &target,
            request_id("post-baseline-review"),
            approved.record_revision(),
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    overwrite_canonical_journal(&upgraded, &legacy);
    let error = DurePluginPermissionState::open_at(&control_root).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_authority_invalid");
}

#[test]
fn baseline_migration_faults_retry_to_byte_identical_anchored_authority() {
    let stages = [
        compaction::CompactionFaultStage::TargetWrite,
        compaction::CompactionFaultStage::AnchorWrite,
        compaction::CompactionFaultStage::PublishDirectorySync,
    ];

    for stage in stages {
        let (_temporary, control_root) = fixture();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let canonical = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
        let mut fixture_journal = LockedJournal::open(&state.store.directory).unwrap();
        fixture_journal
            .replace_bytes_for_fixture(canonical.clone())
            .unwrap();
        drop(fixture_journal);
        let lock_path = state.store.directory.join(LOCK_FILE);
        assert_eq!(
            std::fs::metadata(&lock_path).unwrap().len(),
            SECRET_BYTES as u64,
            "stage {stage:?}"
        );

        compaction::fail_next_authority_at(stage);
        let error = DurePluginPermissionState::open_at(&control_root).unwrap_err();
        assert_eq!(
            error.code(),
            "plugin_permission_store_io",
            "stage {stage:?}"
        );
        assert_eq!(
            std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
            canonical,
            "stage {stage:?}"
        );

        DurePluginPermissionState::open_at(&control_root).unwrap();
        assert_eq!(
            std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
            canonical,
            "stage {stage:?}"
        );
        assert!(
            std::fs::metadata(&lock_path).unwrap().len() > SECRET_BYTES as u64,
            "stage {stage:?}"
        );
        assert!(!compaction::recovery_required(&state.store.directory).unwrap());
    }
}

#[test]
fn callbacks_reject_same_thread_permission_state_reentry_before_locking() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-reentry-check"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    state
        .enable(
            &target,
            request_id("enable-before-reentry-check"),
            approved.record_revision(),
            plan.digest(),
            &plan,
        )
        .unwrap();
    let permission_kind = PermissionKindIdV2::new("dure.issue-tracker.read").unwrap();

    state
        .with_authorized_execution(
            &target,
            PluginPermissionExecutionRequest::new(&plan, &permission_kind, "operations", "list"),
            |_lease| {
                assert_eq!(
                    state.snapshot(&target).unwrap_err().code(),
                    "plugin_permission_callback_reentrant"
                );
                assert_eq!(
                    state
                        .disable_with_retirement(
                            &target,
                            request_id("nested-disable-must-not-run"),
                            |_disabled| Ok::<_, PluginPermissionStoreError>(()),
                        )
                        .unwrap_err()
                        .code(),
                    "plugin_permission_callback_reentrant"
                );
                Ok::<_, PluginPermissionStoreError>(())
            },
            |(), _lease| {
                assert_eq!(
                    DurePluginPermissionState::open_at(&control_root)
                        .unwrap_err()
                        .code(),
                    "plugin_permission_callback_reentrant"
                );
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();

    let receipt = state
        .disable_with_retirement(
            &target,
            request_id("disable-during-reentry-check"),
            |_disabled| {
                assert_eq!(
                    state.snapshot(&target).unwrap_err().code(),
                    "plugin_permission_callback_reentrant"
                );
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert!(matches!(
        receipt.into_parts().1,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
}

#[test]
fn compaction_publish_rejects_valid_but_noncanonical_targets_before_rename() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    state
        .store
        .decide(
            &target,
            request_id("source-review-for-hostile-target"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let source = journal.bytes.clone();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (canonical, generation) = loaded.compacted_bytes(0).unwrap();
    assert_eq!(generation, 1);
    let (mut skipped_manifest, skipped_payload) = compact_values(&canonical);
    skipped_manifest["generation"] = serde_json::Value::from(2);
    let skipped = encode_compact_values(skipped_manifest, skipped_payload, &[]);
    assert_eq!(
        LoadedPermissionJournal::read_bytes(&skipped)
            .unwrap()
            .format,
        PermissionJournalFormat::Compact { generation: 2 }
    );
    let error = journal.publish_compacted_bytes(skipped, 2).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_journal_invalid");
    assert_eq!(journal.bytes, source);
    drop(journal);

    let (_other_temporary, other_control_root) = fixture();
    let other_workspace = other_control_root.join("workspace");
    std::fs::create_dir(&other_workspace).unwrap();
    let other_state = DurePluginPermissionState::open_at(&other_control_root).unwrap();
    let (other_target, other_plan) = target_and_plan(&other_state, &other_workspace);
    other_state
        .store
        .decide(
            &other_target,
            request_id("different-valid-review"),
            0,
            other_plan.digest(),
            &other_plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let other_journal = LockedJournal::open(&other_state.store.directory).unwrap();
    let (different_valid_target, different_generation) =
        LoadedPermissionJournal::read(&other_journal)
            .unwrap()
            .compacted_bytes(0)
            .unwrap();
    drop(other_journal);

    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let error = journal
        .publish_compacted_bytes(different_valid_target, different_generation)
        .unwrap_err();
    assert_eq!(error.code(), "plugin_permission_journal_invalid");
    assert_eq!(journal.bytes, source);
    assert!(!compaction::recovery_required(&state.store.directory).unwrap());
}

#[test]
fn durable_intent_repairs_only_its_exact_partial_anchor_frame() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    state
        .store
        .decide(
            &target,
            request_id("review-before-partial-anchor-recovery"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (target_bytes, generation) = loaded.compacted_bytes(0).unwrap();
    compaction::fail_next_compaction_at(compaction::CompactionFaultStage::SourceRevalidate);
    assert_eq!(
        journal
            .publish_compacted_bytes(target_bytes.clone(), generation)
            .unwrap_err()
            .code(),
        "plugin_permission_store_io"
    );
    drop(journal);
    let lock_path = state.store.directory.join(LOCK_FILE);
    let lock = OpenOptions::new().write(true).open(&lock_path).unwrap();
    let complete_len = lock.metadata().unwrap().len();
    lock.set_len(complete_len - 17).unwrap();
    lock.sync_all().unwrap();
    drop(lock);

    let restarted = DurePluginPermissionState::open_at(&control_root).unwrap();
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        target_bytes
    );
    assert_eq!(std::fs::metadata(lock_path).unwrap().len(), complete_len);
    assert_eq!(
        restarted.snapshot(&target).unwrap().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(!compaction::recovery_required(&state.store.directory).unwrap());
}

#[test]
fn enable_compacts_before_runtime_retirement_and_faults_before_the_callback() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-enable-compaction"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let source_len = std::fs::metadata(state.store.directory.join(JOURNAL_FILE))
        .unwrap()
        .len();
    let _limits = test_journal_byte_limits(source_len, MAX_COMPACT_ACTIVE_JOURNAL_BYTES);
    let enable_request = request_id("enable-after-preflight-compaction");
    let retirement_calls = Cell::new(0);

    let enabled = state
        .enable_after_retirement(
            &target,
            enable_request.clone(),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                let bytes = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
                let compacted = LoadedPermissionJournal::read_bytes(&bytes).unwrap();
                assert_eq!(
                    compacted.format,
                    PermissionJournalFormat::Compact { generation: 1 }
                );
                assert_eq!(compacted.event_count, 1);
                assert_eq!(
                    compacted.state(&target.decision_key()).enablement(),
                    PluginPermissionEnablementV2::Disabled
                );
                assert!(compacted
                    .prior_request(&target.decision_key(), &enable_request)
                    .is_none());
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(retirement_calls.get(), 1);
    assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);
    let published = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let loaded = LoadedPermissionJournal::read_bytes(&published).unwrap();
    assert_eq!(loaded.event_count, 2);
    assert_eq!(
        loaded.format,
        PermissionJournalFormat::Compact { generation: 1 }
    );

    let replayed = state
        .enable_after_retirement(
            &target,
            enable_request,
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(replayed, enabled);
    assert_eq!(retirement_calls.get(), 1);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        published
    );
    drop(_limits);

    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-enable-compaction-fault"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let source = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let _limits = test_journal_byte_limits(source.len() as u64, MAX_COMPACT_ACTIVE_JOURNAL_BYTES);
    compaction::fail_next_compaction_at(compaction::CompactionFaultStage::TargetWrite);
    let retirement_calls = Cell::new(0);
    let error = state
        .enable_after_retirement(
            &target,
            request_id("enable-blocked-by-compaction-fault"),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), "plugin_permission_store_io");
    assert_eq!(retirement_calls.get(), 0);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        source
    );
    assert_eq!(
        DurePluginPermissionState::open_at(&control_root)
            .unwrap()
            .snapshot(&target)
            .unwrap()
            .enablement(),
        PluginPermissionEnablementV2::Disabled
    );
}

#[test]
fn successful_enable_preflight_compaction_survives_retirement_failure_and_retry() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("review-before-compacted-retirement-failure"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let source_len = std::fs::metadata(state.store.directory.join(JOURNAL_FILE))
        .unwrap()
        .len();
    let _limits = test_journal_byte_limits(source_len, MAX_COMPACT_ACTIVE_JOURNAL_BYTES);
    let enable_request = request_id("enable-after-compacted-retirement-failure");
    let retirement_calls = Cell::new(0);

    let error = state
        .enable_after_retirement(
            &target,
            enable_request.clone(),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Err::<(), _>(PluginPermissionStoreError::new(
                    "fixture_retirement_failed",
                    "injected retirement failure after compaction",
                ))
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), "fixture_retirement_failed");
    assert_eq!(retirement_calls.get(), 1);
    let compacted = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let loaded = LoadedPermissionJournal::read_bytes(&compacted).unwrap();
    assert_eq!(
        loaded.format,
        PermissionJournalFormat::Compact { generation: 1 }
    );
    assert_eq!(loaded.event_count, 1);
    assert_eq!(
        loaded.state(&target.decision_key()).enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(loaded
        .prior_request(&target.decision_key(), &enable_request)
        .is_none());

    let enabled = state
        .enable_after_retirement(
            &target,
            enable_request.clone(),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(retirement_calls.get(), 2);
    assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);
    let replayed = state
        .enable_after_retirement(
            &target,
            enable_request,
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(replayed, enabled);
    assert_eq!(retirement_calls.get(), 2);
}

#[test]
fn enable_reconciles_post_commit_io_and_retries_only_precommit_failure() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-enable-ambiguity"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let precommit_request = request_id("enable-precommit-failure");
    let retirement_calls = Cell::new(0);
    let error = state
        .enable_after_retirement(
            &target,
            precommit_request.clone(),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                compaction::fail_next_authority_at(compaction::CompactionFaultStage::TargetWrite);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), "plugin_permission_store_io");
    assert_eq!(retirement_calls.get(), 1);
    assert_eq!(
        state.snapshot(&target).unwrap().enablement(),
        PluginPermissionEnablementV2::Disabled
    );

    let enabled = state
        .enable_after_retirement(
            &target,
            precommit_request,
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                compaction::fail_next_authority_at(
                    compaction::CompactionFaultStage::PublishDirectorySync,
                );
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(retirement_calls.get(), 2);
    assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);
    assert!(!compaction::recovery_required(&state.store.directory).unwrap());

    let replay = state
        .enable_after_retirement(
            &target,
            request_id("enable-precommit-failure"),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(replay, enabled);
    assert_eq!(retirement_calls.get(), 2);
}

#[test]
fn revoking_decision_reconciles_post_commit_io_before_runtime_retirement() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-ambiguous-revoke"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let enabled = state
        .enable(
            &target,
            request_id("enable-before-ambiguous-revoke"),
            approved.record_revision(),
            plan.digest(),
            &plan,
        )
        .unwrap();
    let revoke_request = request_id("revoke-with-post-commit-error");
    let retirement_calls = Cell::new(0);
    compaction::fail_next_authority_at(compaction::CompactionFaultStage::PublishDirectorySync);
    let receipt = state
        .decide_with_retirement(
            &target,
            PluginPermissionDecisionCas::new(
                revoke_request.clone(),
                enabled.record_revision(),
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Reject,
            ),
            |current| {
                retirement_calls.set(retirement_calls.get() + 1);
                assert_eq!(current.enablement(), PluginPermissionEnablementV2::Disabled);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    let (revoked, retirement) = receipt.into_parts();
    assert_eq!(revoked.enablement(), PluginPermissionEnablementV2::Disabled);
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.get(), 1);
    assert!(!compaction::recovery_required(&state.store.directory).unwrap());
    let published = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();

    let replay = state
        .decide_with_retirement(
            &target,
            PluginPermissionDecisionCas::new(
                revoke_request,
                enabled.record_revision(),
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Reject,
            ),
            |_| {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    let (replayed, retirement) = replay.into_parts();
    assert_eq!(replayed, revoked);
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.get(), 2);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        published
    );
}

#[test]
fn emergency_disable_bypasses_an_armed_compactor() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-disable-bypass"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    state
        .enable(
            &target,
            request_id("enable-before-disable-bypass"),
            approved.record_revision(),
            plan.digest(),
            &plan,
        )
        .unwrap();
    let active_len = std::fs::metadata(state.store.directory.join(JOURNAL_FILE))
        .unwrap()
        .len();
    let _limits = test_journal_byte_limits(active_len, MAX_COMPACT_ACTIVE_JOURNAL_BYTES);
    compaction::fail_next_compaction_at(compaction::CompactionFaultStage::TargetWrite);
    let retirement_calls = Cell::new(0);

    let receipt = state
        .disable_with_retirement(
            &target,
            request_id("emergency-disable-bypasses-compactor"),
            |_| {
                retirement_calls.set(retirement_calls.get() + 1);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    let (transition, retirement) = receipt.into_parts();
    assert_eq!(
        transition.state().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.get(), 1);

    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    assert_eq!(loaded.event_count, 3);
    let (target_bytes, generation) = loaded.compacted_bytes(0).unwrap();
    let error = journal
        .publish_compacted_bytes(target_bytes, generation)
        .unwrap_err();
    assert_eq!(error.code(), "plugin_permission_store_io");
    drop(journal);
    assert_eq!(
        DurePluginPermissionState::open_at(&control_root)
            .unwrap()
            .snapshot(&target)
            .unwrap()
            .enablement(),
        PluginPermissionEnablementV2::Disabled
    );
}

#[test]
fn compact_manifest_payload_bijection_and_tail_are_strict() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    state
        .store
        .decide(
            &target,
            request_id("review-before-structural-tests"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (compact, generation) = loaded.compacted_bytes(0).unwrap();
    assert_eq!(generation, 1);
    let (manifest, payload) = compact_values(&compact);
    assert!(serde_json::to_vec(&manifest).unwrap().len() < MAX_JOURNAL_LINE_BYTES);
    assert_eq!(
        manifest["requiredReaderCapability"],
        COMPACT_JOURNAL_READER_CAPABILITY
    );
    assert_eq!(manifest["logicalEventCount"], 1);
    assert_eq!(payload["checkpoints"].as_array().unwrap().len(), 1);
    assert_eq!(payload["eventOrder"].as_array().unwrap().len(), 1);

    let mut cases = Vec::new();
    let mut changed = manifest.clone();
    changed["requiredReaderCapability"] = serde_json::Value::String("future-reader".into());
    cases.push((
        "reader capability",
        encode_compact_values(changed, payload.clone(), &[]),
    ));
    let mut changed = manifest.clone();
    changed["requiredWriterCapability"] = serde_json::Value::String("future-writer".into());
    cases.push((
        "writer capability",
        encode_compact_values(changed, payload.clone(), &[]),
    ));
    let mut changed = manifest.clone();
    changed["generation"] = serde_json::Value::from(0);
    cases.push((
        "zero generation",
        encode_compact_values(changed, payload.clone(), &[]),
    ));
    let mut changed = manifest.clone();
    changed["unknownAuthority"] = serde_json::Value::Bool(true);
    cases.push((
        "unknown manifest field",
        encode_compact_values(changed, payload.clone(), &[]),
    ));
    let mut changed = manifest.clone();
    changed["logicalEventCount"] = serde_json::Value::from(0);
    cases.push((
        "logical count",
        encode_compact_values(changed, payload.clone(), &[]),
    ));
    let mut changed = payload.clone();
    changed["unknownAuthority"] = serde_json::Value::Bool(true);
    cases.push((
        "unknown payload field",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));
    let mut changed = payload.clone();
    changed["eventOrder"] = serde_json::Value::Array(Vec::new());
    cases.push((
        "missing event ref",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));
    let mut changed = payload.clone();
    let duplicated = changed["eventOrder"][0].clone();
    changed["eventOrder"]
        .as_array_mut()
        .unwrap()
        .push(duplicated);
    cases.push((
        "duplicate event ref",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));
    let mut changed = payload.clone();
    changed["eventOrder"][0]["checkpointIndex"] = serde_json::Value::from(7);
    cases.push((
        "unknown checkpoint ref",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));
    let mut changed = payload.clone();
    changed["eventOrder"][0]["recordRevision"] = serde_json::Value::from(2);
    cases.push((
        "revision gap",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));
    let mut changed = payload.clone();
    changed["checkpoints"][0]["observed_event_count"] = serde_json::Value::String("2".into());
    cases.push((
        "observed count",
        encode_compact_values(manifest.clone(), changed, &[]),
    ));

    let store_invalid = cases[0].1.clone();
    for (label, bytes) in cases {
        let error = LoadedPermissionJournal::read_bytes(&bytes)
            .err()
            .expect("hostile compact bytes must be rejected");
        assert_eq!(error.code(), "plugin_permission_journal_invalid", "{label}");
    }

    let legacy_error = parse_journal::<PluginPermissionDecisionEventV2>(&compact).unwrap_err();
    assert_eq!(legacy_error.code(), "plugin_permission_journal_invalid");

    drop(journal);
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    journal
        .replace_bytes_for_fixture(store_invalid.clone())
        .unwrap();
    drop(journal);
    let error = PluginPermissionStore::open_at(&control_root).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_journal_invalid");
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        store_invalid
    );

    let mut compact_loaded = LoadedPermissionJournal::read_bytes(&compact).unwrap();
    let enable = apply_plugin_permission_decision_request(
        compact_loaded.fold_mut(&target.decision_key()).unwrap(),
        PluginPermissionDecisionRequestV2::enable(request_id("enable-in-compact-tail"), 1, &plan),
    )
    .unwrap()
    .into_event();
    let valid_tail = encode_envelope(1, &enable).unwrap();
    let valid = encode_compact_values(manifest.clone(), payload.clone(), &valid_tail);
    let loaded_tail = LoadedPermissionJournal::read_bytes(&valid).unwrap();
    assert_eq!(loaded_tail.event_count, 2);
    assert_eq!(
        loaded_tail.state(&target.decision_key()).enablement(),
        PluginPermissionEnablementV2::Enabled
    );

    let mut wrong_tail: serde_json::Value =
        serde_json::from_slice(&valid_tail[..valid_tail.len() - 1]).unwrap();
    wrong_tail["seq"] = serde_json::Value::from(3);
    let mut wrong_tail = serde_json::to_vec(&wrong_tail).unwrap();
    wrong_tail.push(b'\n');
    let wrong = encode_compact_values(manifest, payload, &wrong_tail);
    let error = LoadedPermissionJournal::read_bytes(&wrong)
        .err()
        .expect("tail sequence gap must be rejected");
    assert_eq!(error.code(), "plugin_permission_journal_invalid");

    let (recompacted, generation) = loaded_tail.compacted_bytes(0).unwrap();
    assert_eq!(generation, 2);
    let recompacted = LoadedPermissionJournal::read_bytes(&recompacted).unwrap();
    assert_eq!(
        recompacted.format,
        PermissionJournalFormat::Compact { generation: 2 }
    );
    assert_eq!(recompacted.event_count, 2);
}

#[test]
fn multi_key_checkpoint_order_and_length_preserving_reference_changes_are_strict() {
    let (_temporary, control_root) = fixture();
    let workspace_a = control_root.join("workspace-a");
    let workspace_b = control_root.join("workspace-b");
    std::fs::create_dir(&workspace_a).unwrap();
    std::fs::create_dir(&workspace_b).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target_a, plan_a) = target_and_plan(&state, &workspace_a);
    let (target_b, plan_b) = target_and_plan(&state, &workspace_b);
    state
        .store
        .decide(
            &target_a,
            request_id("multi-key-review-a"),
            0,
            plan_a.digest(),
            &plan_a,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    state
        .store
        .decide(
            &target_b,
            request_id("multi-key-review-b"),
            0,
            plan_b.digest(),
            &plan_b,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    let journal = LockedJournal::open(&state.store.directory).unwrap();
    let source = journal.bytes.clone();
    let (compact, generation) = LoadedPermissionJournal::read(&journal)
        .unwrap()
        .compacted_bytes(0)
        .unwrap();
    let (manifest, payload) = compact_values(&compact);
    assert_eq!(payload["checkpoints"].as_array().unwrap().len(), 2);
    assert_eq!(payload["eventOrder"].as_array().unwrap().len(), 2);

    let mut unsorted = payload.clone();
    unsorted["checkpoints"].as_array_mut().unwrap().reverse();
    assert_eq!(
        LoadedPermissionJournal::read_bytes(&encode_compact_values(
            manifest.clone(),
            unsorted,
            &[],
        ))
        .err()
        .expect("unsorted checkpoints must fail")
        .code(),
        "plugin_permission_journal_invalid"
    );

    let mut duplicate_checkpoint = payload.clone();
    duplicate_checkpoint["checkpoints"][1] = duplicate_checkpoint["checkpoints"][0].clone();
    assert_eq!(
        LoadedPermissionJournal::read_bytes(&encode_compact_values(
            manifest.clone(),
            duplicate_checkpoint,
            &[],
        ))
        .err()
        .expect("duplicate checkpoints must fail")
        .code(),
        "plugin_permission_journal_invalid"
    );

    let mut duplicate_reference = payload.clone();
    duplicate_reference["eventOrder"][1] = duplicate_reference["eventOrder"][0].clone();
    assert_eq!(
        LoadedPermissionJournal::read_bytes(&encode_compact_values(
            manifest.clone(),
            duplicate_reference,
            &[],
        ))
        .err()
        .expect("duplicate references must fail")
        .code(),
        "plugin_permission_journal_invalid"
    );

    let mut swapped = payload;
    swapped["eventOrder"].as_array_mut().unwrap().swap(0, 1);
    let swapped = encode_compact_values(manifest, swapped, &[]);
    LoadedPermissionJournal::read_bytes(&swapped).unwrap();
    assert_eq!(
        LoadedPermissionJournal::validate_compaction_transition(&source, &swapped, generation,)
            .unwrap_err()
            .code(),
        "plugin_permission_journal_invalid"
    );
}
