use super::*;
use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
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

fn request_id(value: impl Into<String>) -> PluginPermissionDecisionRequestIdV2 {
    PluginPermissionDecisionRequestIdV2::new(value.into()).unwrap()
}

fn maximum_request_id(label: &str, sequence: usize) -> PluginPermissionDecisionRequestIdV2 {
    let prefix = format!("{label}-{sequence}-");
    assert!(prefix.len() <= 160);
    request_id(format!("{prefix}{}", "x".repeat(160 - prefix.len())))
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

fn encode_event(event: &PluginPermissionDecisionEventV2, sequence: usize) -> Vec<u8> {
    let envelope = JournalEnvelope {
        schema_version: JOURNAL_SCHEMA_VERSION,
        seq: u64::try_from(sequence).unwrap(),
        event,
    };
    let mut encoded = serde_json::to_vec(&envelope).unwrap();
    encoded.push(b'\n');
    assert!(encoded.len() <= MAX_JOURNAL_LINE_BYTES);
    encoded
}

fn replace_journal(state: &DurePluginPermissionState, bytes: Vec<u8>) {
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    journal.replace_bytes_for_fixture(bytes).unwrap();
}

fn alternating_key_events(
    plan: &PluginPermissionPlanV2,
    label: &str,
    count: usize,
) -> Vec<PluginPermissionDecisionEventV2> {
    let key = PluginPermissionDecisionKeyV2::from_plan(plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
    (0..count)
        .map(|index| {
            let request = if index == 0 {
                PluginPermissionDecisionRequestV2::decide(
                    request_id(format!("{label}-decision")),
                    0,
                    plan,
                    PluginPermissionDecisionV2::Approve,
                )
            } else if index % 2 == 1 {
                PluginPermissionDecisionRequestV2::enable(
                    request_id(format!("{label}-enable-{index}")),
                    index as u64,
                    plan,
                )
            } else {
                PluginPermissionDecisionRequestV2::disable(
                    request_id(format!("{label}-disable-{index}")),
                    index as u64,
                    key.clone(),
                )
            };
            apply_plugin_permission_decision_request(&mut fold, request)
                .unwrap()
                .into_event()
        })
        .collect()
}

#[test]
fn maximum_review_projection_has_an_exact_active_byte_boundary() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    // A manifest-backed plugin needs room for a namespaced contribution ID,
    // so 126 bytes is the longest plugin ID reachable by a valid plan.
    let plugin_id = PluginIdV2::new(format!("dure.{}", "x".repeat(121))).unwrap();
    assert_eq!(plugin_id.as_str().len(), 126);
    let target = state.resolve_target(&workspace, &plugin_id).unwrap();
    let plan = crate::plugin_catalog::bundled_permission_plan_with_exact_review_bytes(
        target.workspace().identity().clone(),
        &plugin_id,
        dure_app::MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_vec(plan.review_projection()).unwrap().len(),
        dure_app::MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2
    );

    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
    let mut bytes = Vec::new();
    let mut accepted_events = 0usize;
    let overflow_line = loop {
        let sequence = accepted_events + 1;
        let event = apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::decide(
                maximum_request_id("max-review", sequence),
                accepted_events as u64,
                &plan,
                PluginPermissionDecisionV2::Approve,
            ),
        )
        .unwrap()
        .into_event();
        let encoded = encode_event(&event, sequence);
        if bytes.len() + encoded.len() > MAX_ACTIVE_JOURNAL_BYTES as usize {
            break encoded;
        }
        bytes.extend_from_slice(&encoded);
        accepted_events += 1;
    };
    assert_eq!(accepted_events, 904);
    assert_eq!(bytes.len(), 8_379_538);
    assert_eq!(overflow_line.len(), 9_270);
    assert!(bytes.len() <= MAX_ACTIVE_JOURNAL_BYTES as usize);
    assert!(bytes.len() + overflow_line.len() > MAX_ACTIVE_JOURNAL_BYTES as usize);
    assert!(accepted_events < MAX_ACTIVE_JOURNAL_EVENTS);
    replace_journal(&state, bytes.clone());

    let compacted_request = maximum_request_id("max-review", accepted_events + 1);
    let compacted_state = state
        .store
        .decide(
            &target,
            compacted_request.clone(),
            accepted_events as u64,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    assert_eq!(
        compacted_state.record_revision(),
        accepted_events as u64 + 1
    );
    let compacted_bytes = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    assert_ne!(compacted_bytes, bytes);
    assert!(compacted_bytes.len() as u64 <= MAX_COMPACT_ACTIVE_JOURNAL_BYTES);
    let compacted = LoadedPermissionJournal::read_bytes(&compacted_bytes).unwrap();
    assert_eq!(
        compacted.format,
        PermissionJournalFormat::Compact { generation: 1 }
    );
    assert_eq!(compacted.event_count, accepted_events + 1);
    assert_eq!(compacted.key_event_count(&target.decision_key()), accepted_events + 1);
    let restarted = DurePluginPermissionState::open_at(&control_root).unwrap();
    assert_eq!(
        restarted.snapshot(&target).unwrap().record_revision(),
        accepted_events as u64 + 1
    );
    let checkpoint_replay = state
        .store
        .decide(
            &target,
            maximum_request_id("max-review", 1),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    assert_eq!(checkpoint_replay, compacted_state);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        compacted_bytes
    );
    let replayed = state
        .store
        .decide(
            &target,
            compacted_request.clone(),
            accepted_events as u64,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    assert_eq!(replayed, compacted_state);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        compacted_bytes
    );
    let conflict = state
        .store
        .decide(
            &target,
            compacted_request,
            accepted_events as u64,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Reject,
        )
        .unwrap_err();
    assert_eq!(conflict.code(), "plugin_permission_decision_invalid");

    let parsed = parse_journal::<PluginPermissionDecisionEventV2>(&bytes).unwrap();
    let events = parsed
        .into_iter()
        .map(|parsed| parsed.envelope.event)
        .collect::<Vec<_>>();
    let mut enabled_fold = PluginPermissionDecisionFoldV2::from_events(key, &events).unwrap();
    let enabled_event = apply_plugin_permission_decision_request(
        &mut enabled_fold,
        PluginPermissionDecisionRequestV2::enable(
            maximum_request_id("max-review-enable", accepted_events + 1),
            accepted_events as u64,
            &plan,
        ),
    )
    .unwrap()
    .into_event();
    let mut enabled_line = encode_event(&enabled_event, accepted_events + 1);
    let padding = MAX_ACTIVE_JOURNAL_BYTES as usize - bytes.len() - enabled_line.len();
    enabled_line.splice(
        enabled_line.len() - 1..enabled_line.len() - 1,
        std::iter::repeat_n(b' ', padding),
    );
    assert!(enabled_line.len() <= MAX_JOURNAL_LINE_BYTES);
    let mut enabled_at_byte_limit = bytes;
    enabled_at_byte_limit.extend(enabled_line);
    assert_eq!(enabled_at_byte_limit.len() as u64, MAX_ACTIVE_JOURNAL_BYTES);
    replace_journal(&state, enabled_at_byte_limit);
    assert_eq!(
        state.snapshot(&target).unwrap().enablement(),
        PluginPermissionEnablementV2::Enabled
    );

    let receipt = state
        .disable_with_retirement(
            &target,
            maximum_request_id("max-review-disable", accepted_events + 2),
            |_| Ok::<_, PluginPermissionStoreError>(()),
        )
        .unwrap();
    let (transition, retirement) = receipt.into_parts();
    let (disabled, persistence) = transition.into_parts();
    assert_eq!(persistence, PluginPermissionDisablePersistence::Recorded);
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(
        disabled.enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(
        std::fs::metadata(state.store.directory.join(JOURNAL_FILE))
            .unwrap()
            .len()
            > MAX_ACTIVE_JOURNAL_BYTES
    );
    assert_eq!(
        DurePluginPermissionState::open_at(&control_root)
            .unwrap()
            .snapshot(&target)
            .unwrap()
            .enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    // Byte-reserve provenance is physical, not a second logical lifetime
    // counter. Compaction may place this proven Enabled→Disabled transition
    // back inside the active byte prefix without changing any event count.
    let journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    assert_eq!(loaded.event_count, accepted_events + 2);
    let (compacted, _) = loaded.compacted_bytes(0).unwrap();
    let compacted = LoadedPermissionJournal::read_bytes(&compacted).unwrap();
    assert_eq!(compacted.event_count, accepted_events + 2);
    assert_eq!(
        compacted.state(&target.decision_key()).enablement(),
        PluginPermissionEnablementV2::Disabled
    );
}

#[test]
fn full_legacy_global_capacity_preserves_one_emergency_disable_per_enabled_key() {
    let (_temporary, control_root) = fixture();
    let workspace_a = control_root.join("workspace-a");
    let workspace_b = control_root.join("workspace-b");
    let workspace_c = control_root.join("workspace-c");
    for workspace in [&workspace_a, &workspace_b, &workspace_c] {
        std::fs::create_dir(workspace).unwrap();
    }
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target_a, plan_a) = target_and_plan(&state, &workspace_a);
    let (_target_b, plan_b) = target_and_plan(&state, &workspace_b);
    let (target_c, plan_c) = target_and_plan(&state, &workspace_c);
    let mut events = alternating_key_events(
        &plan_a,
        "global-a",
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
    );
    events.extend(alternating_key_events(
        &plan_b,
        "global-b",
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
    ));
    assert_eq!(events.len(), MAX_ACTIVE_JOURNAL_EVENTS);
    let mut active_bytes = Vec::new();
    for (index, event) in events.iter().enumerate() {
        active_bytes.extend(encode_event(event, index + 1));
    }
    assert!(active_bytes.len() as u64 <= MAX_ACTIVE_JOURNAL_BYTES);
    replace_journal(&state, active_bytes.clone());

    let regular_error = state
        .store
        .decide(
            &target_c,
            request_id("global-regular-overflow"),
            0,
            plan_c.digest(),
            &plan_c,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap_err();
    assert_eq!(
        regular_error.code(),
        "plugin_permission_journal_active_capacity_exhausted"
    );
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        active_bytes
    );

    let retirement_calls = AtomicUsize::new(0);
    let first = state
        .disable_with_retirement(&target_a, request_id("global-emergency-disable"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(PluginPermissionStoreError::new(
                "fixture_retirement_failed",
                "fixture emergency retirement failure",
            ))
        })
        .unwrap();
    let (first, first_retirement) = first.into_parts();
    let (first, first_persistence) = first.into_parts();
    assert_eq!(
        first_persistence,
        PluginPermissionDisablePersistence::Recorded
    );
    assert_eq!(first.enablement(), PluginPermissionEnablementV2::Disabled);
    let PluginPermissionRetirementOutcome::Attempted(first_retirement) = first_retirement else {
        panic!("emergency disable must attempt retirement");
    };
    assert_eq!(
        first_retirement.unwrap_err().code(),
        "fixture_retirement_failed"
    );
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 1);
    let reserve_bytes = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    assert!(reserve_bytes.len() > active_bytes.len());
    assert_eq!(
        parse_journal::<PluginPermissionDecisionEventV2>(&reserve_bytes)
            .unwrap()
            .len(),
        MAX_ACTIVE_JOURNAL_EVENTS + 1
    );

    let replay = state
        .disable_with_retirement(&target_a, request_id("global-emergency-disable"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (replay, replay_retirement) = replay.into_parts();
    let (_, replay_persistence) = replay.into_parts();
    assert_eq!(
        replay_persistence,
        PluginPermissionDisablePersistence::Recorded
    );
    assert!(matches!(
        replay_retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        reserve_bytes
    );

    let repair = state
        .disable_with_retirement(&target_a, request_id("global-retirement-repair"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (repair, repair_retirement) = repair.into_parts();
    let (_, repair_persistence) = repair.into_parts();
    assert_eq!(
        repair_persistence,
        PluginPermissionDisablePersistence::RetirementRepairNoTransition
    );
    assert!(matches!(
        repair_retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        reserve_bytes
    );

    let initial_target_calls = AtomicUsize::new(0);
    let initial_target = state
        .disable_with_retirement(&target_c, request_id("global-initial-disable"), |_| {
            initial_target_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (initial_target, _) = initial_target.into_parts();
    let (initial_target, initial_persistence) = initial_target.into_parts();
    assert_eq!(
        initial_persistence,
        PluginPermissionDisablePersistence::RetirementRepairNoTransition
    );
    assert_eq!(initial_target.record_revision(), 0);
    assert_eq!(initial_target_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        reserve_bytes
    );
    let journal = LockedJournal::open_shared(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    assert!(loaded
        .prior_request(
            &target_a.decision_key(),
            &request_id("global-retirement-repair")
        )
        .is_none());
    drop(journal);

    let enable_error = state
        .enable(
            &target_a,
            request_id("global-reserve-reenable"),
            first.record_revision(),
            plan_a.digest(),
            &plan_a,
        )
        .unwrap_err();
    assert_eq!(
        enable_error.code(),
        "plugin_permission_journal_active_capacity_exhausted"
    );
    let restarted = DurePluginPermissionState::open_at(&control_root).unwrap();
    assert_eq!(
        restarted.snapshot(&target_a).unwrap().enablement(),
        PluginPermissionEnablementV2::Disabled
    );

    let mut invalid_reserve = active_bytes;
    let invalid_event = alternating_key_events(&plan_c, "invalid-reserve", 1)
        .pop()
        .unwrap();
    invalid_reserve.extend(encode_event(&invalid_event, MAX_ACTIVE_JOURNAL_EVENTS + 1));
    replace_journal(&state, invalid_reserve.clone());
    let error = DurePluginPermissionState::open_at(&control_root).unwrap_err();
    assert_eq!(error.code(), "plugin_permission_journal_invalid");
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        invalid_reserve
    );
}

#[test]
fn per_key_legacy_capacity_preserves_stale_replay_and_fresh_disable_semantics() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let events = alternating_key_events(&plan, "per-key", MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2);
    let mut bytes = Vec::new();
    for (index, event) in events.iter().enumerate() {
        bytes.extend(encode_event(event, index + 1));
    }
    assert!(bytes.len() as u64 <= MAX_ACTIVE_JOURNAL_BYTES);
    replace_journal(&state, bytes.clone());

    let stale = state
        .store
        .disable_unconditionally(&target, request_id("per-key-disable-2"))
        .unwrap_err();
    assert_eq!(stale.code(), "plugin_permission_disable_replay_stale");
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        bytes
    );

    let retirement_calls = AtomicUsize::new(0);
    compaction::fail_next_authority_at(compaction::CompactionFaultStage::PublishDirectorySync);
    let fresh = state
        .disable_with_retirement(&target, request_id("per-key-fresh-disable"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (fresh, retirement) = fresh.into_parts();
    let (fresh, persistence) = fresh.into_parts();
    assert_eq!(persistence, PluginPermissionDisablePersistence::Recorded);
    assert_eq!(fresh.enablement(), PluginPermissionEnablementV2::Disabled);
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 1);
    let reserved = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    assert!(reserved.len() > bytes.len());

    let replay = state
        .disable_with_retirement(&target, request_id("per-key-fresh-disable"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (replay, retirement) = replay.into_parts();
    let (_, replay_persistence) = replay.into_parts();
    assert_eq!(
        replay_persistence,
        PluginPermissionDisablePersistence::Recorded
    );
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        reserved
    );
    assert_eq!(
        parse_journal::<PluginPermissionDecisionEventV2>(&reserved)
            .unwrap()
            .len(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 + 1
    );

    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    assert_eq!(
        loaded.key_event_count(&target.decision_key()),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    );
    let (compacted, generation) = loaded.compacted_bytes(0).unwrap();
    journal
        .publish_compacted_bytes(compacted.clone(), generation)
        .unwrap();
    drop(journal);
    let replay_after_compaction = state
        .disable_with_retirement(&target, request_id("per-key-fresh-disable"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (_, retirement) = replay_after_compaction.into_parts();
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        compacted
    );
    let mut journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    let (recompacted, generation) = loaded.compacted_bytes(0).unwrap();
    assert_eq!(generation, 2);
    journal
        .publish_compacted_bytes(recompacted, generation)
        .unwrap();
    drop(journal);
    let journal = LockedJournal::open(&state.store.directory).unwrap();
    let loaded = LoadedPermissionJournal::read(&journal).unwrap();
    assert_eq!(
        loaded.key_event_count(&target.decision_key()),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    );
    drop(journal);

    let enable_error = state
        .enable(
            &target,
            request_id("per-key-reenable"),
            fresh.record_revision(),
            plan.digest(),
            &plan,
        )
        .unwrap_err();
    assert_eq!(
        enable_error.code(),
        "plugin_permission_journal_active_capacity_exhausted"
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
fn enable_retires_runtime_before_publishing_and_replay_is_side_effect_free() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let approved = state
        .store
        .decide(
            &target,
            request_id("approve-before-enable-retirement"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    assert_eq!(
        approved.enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    let bytes_before_enable = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    let retirement_calls = AtomicUsize::new(0);

    let retirement_error = state
        .enable_after_retirement(
            &target,
            request_id("enable-after-retirement-failure"),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(PluginPermissionStoreError::new(
                    "test_runtime_retirement_failed",
                    "injected runtime retirement failure",
                ))
            },
        )
        .unwrap_err();
    assert_eq!(retirement_error.code(), "test_runtime_retirement_failed");
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        state.snapshot(&target).unwrap().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        bytes_before_enable
    );

    let enable_request_id = request_id("enable-after-runtime-retirement");
    let enabled = state
        .enable_after_retirement(
            &target,
            enable_request_id.clone(),
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 2);
    assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);
    let enabled_bytes = std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap();
    assert!(enabled_bytes.len() > bytes_before_enable.len());

    let replayed = state
        .enable_after_retirement(
            &target,
            enable_request_id,
            approved.record_revision(),
            plan.digest(),
            &plan,
            || {
                retirement_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(replayed, enabled);
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        enabled_bytes
    );
}

#[test]
fn cross_state_enable_serializes_retirement_and_exact_or_conflicting_requests() {
    for same_request in [true, false] {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let first_state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let second_state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (first_target, first_plan) = target_and_plan(&first_state, &workspace);
        let (second_target, second_plan) = target_and_plan(&second_state, &workspace);
        assert_eq!(first_plan, second_plan);
        let approved = first_state
            .store
            .decide(
                &first_target,
                request_id("approve-before-cross-state-enable"),
                0,
                first_plan.digest(),
                &first_plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        let first_request = request_id("cross-state-enable");
        let second_request = if same_request {
            first_request.clone()
        } else {
            request_id("cross-state-enable-conflict")
        };
        let first_retirements = AtomicUsize::new(0);
        let second_retirements = AtomicUsize::new(0);
        let snapshot_target = first_target.clone();
        let approved_revision = approved.record_revision();

        std::thread::scope(|scope| {
            let (retirement_entered_tx, retirement_entered_rx) = mpsc::sync_channel(0);
            let (release_retirement_tx, release_retirement_rx) = mpsc::sync_channel(0);
            let (second_started_tx, second_started_rx) = mpsc::sync_channel(0);
            let (second_finished_tx, second_finished_rx) = mpsc::channel();
            let first_retirements = &first_retirements;
            let first = scope.spawn(move || {
                first_state.enable_after_retirement(
                    &first_target,
                    first_request,
                    approved_revision,
                    first_plan.digest(),
                    &first_plan,
                    || {
                        first_retirements.fetch_add(1, Ordering::SeqCst);
                        retirement_entered_tx.send(()).unwrap();
                        release_retirement_rx.recv().unwrap();
                        Ok::<_, PluginPermissionStoreError>(())
                    },
                )
            });
            retirement_entered_rx.recv().unwrap();
            let second_retirements = &second_retirements;
            let second = scope.spawn(move || {
                second_started_tx.send(()).unwrap();
                let result = second_state.enable_after_retirement(
                    &second_target,
                    second_request,
                    approved_revision,
                    second_plan.digest(),
                    &second_plan,
                    || {
                        second_retirements.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, PluginPermissionStoreError>(())
                    },
                );
                second_finished_tx.send(()).unwrap();
                result
            });
            second_started_rx.recv().unwrap();
            assert_eq!(
                second_finished_rx.recv_timeout(Duration::from_millis(150)),
                Err(RecvTimeoutError::Timeout),
                "a sibling state must wait for the retirement fence"
            );
            release_retirement_tx.send(()).unwrap();
            let first_result = first.join().unwrap().unwrap();
            let second_result = second.join().unwrap();
            assert_eq!(first_result.enablement(), PluginPermissionEnablementV2::Enabled);
            if same_request {
                assert_eq!(second_result.unwrap(), first_result);
            } else {
                assert_eq!(
                    second_result.unwrap_err().code(),
                    "plugin_permission_decision_invalid"
                );
            }
        });

        assert_eq!(first_retirements.load(Ordering::SeqCst), 1);
        assert_eq!(second_retirements.load(Ordering::SeqCst), 0);
        assert_eq!(
            DurePluginPermissionState::open_at(&control_root)
                .unwrap()
                .snapshot(&snapshot_target)
                .unwrap()
                .enablement(),
            PluginPermissionEnablementV2::Enabled
        );
    }
}

#[test]
fn legacy_enable_publishes_the_old_writer_fence_before_retirement() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    let event = alternating_key_events(&plan, "legacy-enable-fence", 1)
        .pop()
        .unwrap();
    replace_journal(&state, encode_event(&event, 1));
    let lock_path = state.store.directory.join(LOCK_FILE);
    assert_eq!(std::fs::metadata(&lock_path).unwrap().len(), SECRET_BYTES as u64);
    let retirement_calls = AtomicUsize::new(0);

    let enabled = state
        .enable_after_retirement(
            &target,
            request_id("enable-after-legacy-fence"),
            1,
            plan.digest(),
            &plan,
            || {
                retirement_calls.fetch_add(1, Ordering::SeqCst);
                assert!(std::fs::metadata(&lock_path).unwrap().len() > SECRET_BYTES as u64);
                Ok::<_, PluginPermissionStoreError>(())
            },
        )
        .unwrap();
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 1);
    assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);
}

#[test]
fn recovery_never_reclassifies_an_old_disable_after_later_transitions() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, plan) = target_and_plan(&state, &workspace);
    state
        .store
        .decide(
            &target,
            request_id("approve-before-stale-recovery"),
            0,
            plan.digest(),
            &plan,
            PluginPermissionDecisionV2::Approve,
        )
        .unwrap();
    state
        .enable(
            &target,
            request_id("enable-before-stale-recovery"),
            1,
            plan.digest(),
            &plan,
        )
        .unwrap();
    let old_disable_request = request_id("old-disable-before-reenable");
    state
        .store
        .disable_unconditionally(&target, old_disable_request.clone())
        .unwrap();
    state
        .enable(
            &target,
            request_id("reenable-before-fresh-disable"),
            3,
            plan.digest(),
            &plan,
        )
        .unwrap();
    state
        .store
        .disable_unconditionally(&target, request_id("fresh-disable-after-reenable"))
        .unwrap();

    assert!(state
        .store
        .recover_disable_transition(&target, &old_disable_request)
        .unwrap()
        .is_none());
}

#[test]
fn full_key_capacity_repairs_retirement_without_admitting_an_initial_key() {
    let (_temporary, control_root) = fixture();
    let workspace = control_root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let state = DurePluginPermissionState::open_at(&control_root).unwrap();
    let (target, _) = target_and_plan(&state, &workspace);
    let mut bytes = Vec::new();
    for index in 0..MAX_PERMISSION_KEYS {
        let workspace_identity = format!("sha256:{index:064x}");
        let key = serde_json::json!({
            "schema_version": 2,
            "workspace_identity": workspace_identity.clone(),
            "plugin_id": "dure.capacity-fixture",
        });
        let event = serde_json::from_value::<PluginPermissionDecisionEventV2>(serde_json::json!({
            "schema_version": 2,
            "key": key,
            "request_id": format!("key-capacity-{index}"),
            "expected_record_revision": "0",
            "record_revision": "1",
            "decision_revision": "1",
            "enablement_epoch": "1",
            "body": {
                "kind": "decision_recorded",
                "binding": {
                    "schema_version": 2,
                    "key": {
                        "schema_version": 2,
                        "workspace_identity": workspace_identity,
                        "plugin_id": "dure.capacity-fixture",
                    },
                    "plan_digest": format!("sha256:{}", "a".repeat(64)),
                },
                "decision": "approve",
            },
        }))
        .unwrap();
        bytes.extend(encode_event(&event, index + 1));
    }
    assert!(bytes.len() as u64 <= MAX_ACTIVE_JOURNAL_BYTES);
    replace_journal(&state, bytes.clone());

    let retirement_calls = AtomicUsize::new(0);
    let receipt = state
        .disable_with_retirement(&target, request_id("initial-at-key-capacity"), |_| {
            retirement_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, PluginPermissionStoreError>(())
        })
        .unwrap();
    let (transition, retirement) = receipt.into_parts();
    let (current, persistence) = transition.into_parts();

    assert_eq!(
        persistence,
        PluginPermissionDisablePersistence::RetirementRepairNoTransition
    );
    assert_eq!(current.record_revision(), 0);
    assert!(matches!(
        retirement,
        PluginPermissionRetirementOutcome::Attempted(Ok(()))
    ));
    assert_eq!(retirement_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(state.store.directory.join(JOURNAL_FILE)).unwrap(),
        bytes
    );
}

#[test]
fn reserve_arithmetic_covers_one_maximum_line_for_every_admitted_key() {
    assert_eq!(
        MAX_COMPACT_ACTIVE_JOURNAL_BYTES - MAX_ACTIVE_JOURNAL_BYTES,
        MAX_PERMISSION_KEYS as u64 * MAX_JOURNAL_LINE_BYTES as u64
    );
    assert_eq!(
        MAX_JOURNAL_BYTES - MAX_COMPACT_ACTIVE_JOURNAL_BYTES,
        MAX_PERMISSION_KEYS as u64 * MAX_JOURNAL_LINE_BYTES as u64
    );
    assert_eq!(
        MAX_JOURNAL_EVENTS - MAX_ACTIVE_JOURNAL_EVENTS,
        MAX_PERMISSION_KEYS
    );
    assert_eq!(
        serde_json::to_value(PluginPermissionDisablePersistence::RetirementRepairNoTransition)
            .unwrap(),
        serde_json::Value::String("retirement_repair_no_transition".to_owned())
    );
    let mut oversized_legacy = br#"{"schemaVersion":1}
"#
    .to_vec();
    oversized_legacy.resize((MAX_LEGACY_JOURNAL_BYTES + 1) as usize, b'\n');
    assert_eq!(
        LoadedPermissionJournal::read_bytes(&oversized_legacy)
            .err()
            .expect("oversized legacy journal must fail")
            .code(),
        "plugin_permission_journal_too_large"
    );
}

#[test]
fn compact_bound_covers_maximum_keys_receipts_request_ids_and_current_projections() {
    let plugin_id = PluginIdV2::new(format!("dure.{}", "x".repeat(121))).unwrap();
    let mut folds = Vec::with_capacity(MAX_PERMISSION_KEYS);
    let mut key_event_counts = Vec::with_capacity(MAX_PERMISSION_KEYS);
    let mut representative_plan = None;

    for key_index in 0..MAX_PERMISSION_KEYS {
        let workspace_identity = PluginWorkspaceIdentityV2::from_host_hmac(format!(
            "sha256:{key_index:064x}"
        ))
        .unwrap();
        let plan = crate::plugin_catalog::bundled_permission_plan_with_exact_review_bytes(
            workspace_identity,
            &plugin_id,
            dure_app::MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2,
        )
        .unwrap();
        if key_index == 0 {
            representative_plan = Some(plan.clone());
        }
        let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
        let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
        for revision in 0..9usize {
            let label = format!("compact-bound-{key_index}-{revision}");
            let request = if revision < 7 {
                PluginPermissionDecisionRequestV2::decide(
                    maximum_request_id(&label, revision),
                    revision as u64,
                    &plan,
                    PluginPermissionDecisionV2::Approve,
                )
            } else if revision == 7 {
                PluginPermissionDecisionRequestV2::enable(
                    maximum_request_id(&label, revision),
                    revision as u64,
                    &plan,
                )
            } else {
                PluginPermissionDecisionRequestV2::disable(
                    maximum_request_id(&label, revision),
                    revision as u64,
                    key.clone(),
                )
            };
            apply_plugin_permission_decision_request(&mut fold, request).unwrap();
        }
        assert_eq!(
            fold.state().enablement(),
            PluginPermissionEnablementV2::Disabled
        );
        folds.push(fold);
        key_event_counts.push(9);
    }

    let mut event_order = Vec::with_capacity(MAX_JOURNAL_EVENTS);
    for fold_index in 0..MAX_PERMISSION_KEYS {
        for record_revision in 1..=8_u64 {
            event_order.push(CompactJournalEventReference {
                checkpoint_index: u16::try_from(fold_index).unwrap(),
                record_revision,
            });
        }
    }
    for fold_index in 0..MAX_PERMISSION_KEYS {
        event_order.push(CompactJournalEventReference {
            checkpoint_index: u16::try_from(fold_index).unwrap(),
            record_revision: 9,
        });
    }
    assert_eq!(event_order.len(), MAX_JOURNAL_EVENTS);
    let loaded = LoadedPermissionJournal {
        format: PermissionJournalFormat::Legacy,
        event_count: MAX_JOURNAL_EVENTS,
        folds,
        key_event_counts,
        event_order,
    };
    let (encoded, generation) = loaded
        .compacted_bytes(MAX_JOURNAL_LINE_BYTES)
        .unwrap();
    assert_eq!(generation, 1);
    assert!(
        encoded.len() + MAX_JOURNAL_LINE_BYTES <= MAX_COMPACT_ACTIVE_JOURNAL_BYTES as usize
    );
    let restored = LoadedPermissionJournal::read_bytes(&encoded).unwrap();
    assert_eq!(restored.event_count, MAX_JOURNAL_EVENTS);
    assert_eq!(restored.folds.len(), MAX_PERMISSION_KEYS);
    let (recompacted, generation) = restored.compacted_bytes(0).unwrap();
    assert_eq!(generation, 2);
    let mut restored_again = LoadedPermissionJournal::read_bytes(&recompacted).unwrap();
    assert_eq!(restored_again.event_count, MAX_JOURNAL_EVENTS);
    assert_eq!(restored_again.folds.len(), MAX_PERMISSION_KEYS);
    assert_eq!(restored_again.key_event_counts, restored.key_event_counts);
    assert_eq!(restored_again.event_order, restored.event_order);

    let plan = representative_plan.unwrap();
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let oldest_review = PluginPermissionDecisionRequestV2::decide(
        maximum_request_id("compact-bound-0-0", 0),
        0,
        &plan,
        PluginPermissionDecisionV2::Approve,
    );
    let replay = apply_plugin_permission_decision_request(
        restored_again.fold_mut(&key).unwrap(),
        oldest_review,
    )
    .unwrap();
    assert_eq!(
        replay.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert!(replay.event_to_append().is_none());
    assert_eq!(replay.state().record_revision(), 9);
    assert_eq!(
        replay.state().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(apply_plugin_permission_decision_request(
        restored_again.fold_mut(&key).unwrap(),
        PluginPermissionDecisionRequestV2::decide(
            maximum_request_id("compact-bound-0-0", 0),
            0,
            &plan,
            PluginPermissionDecisionV2::Reject,
        ),
    )
    .is_err());

    let final_disable = apply_plugin_permission_decision_request(
        restored_again.fold_mut(&key).unwrap(),
        PluginPermissionDecisionRequestV2::disable(
            maximum_request_id("compact-bound-0-8", 8),
            8,
            key.clone(),
        ),
    )
    .unwrap();
    assert_eq!(
        final_disable.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert!(final_disable.event_to_append().is_none());
    assert!(apply_plugin_permission_decision_request(
        restored_again.fold_mut(&key).unwrap(),
        PluginPermissionDecisionRequestV2::disable(
            maximum_request_id("compact-bound-0-8", 8),
            7,
            key,
        ),
    )
    .is_err());
}
