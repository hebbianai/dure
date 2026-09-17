use super::*;
use crate::recovery_journal::{
    self as journal, PreparedRecoveryIdentity, RecoveryCompletion, RecoveryJournalGcPolicy,
    RecoveryReservationState, garbage_collect_completed, request_fingerprint, reserve_prepared,
};
use crate::{StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity};

mod admission;
mod cancellation;
mod compatibility;
mod located;
mod operation_identity;
mod reconciliation;

fn checkpoint(context: serde_json::Value) -> RecoveryOperationCheckpoint {
    let source: StandaloneReplacementSource = serde_json::from_value(serde_json::json!({
        "discoveryRoot": "/fixture-discovery",
        "generation": {
            "fence": {
                "workspaceId": "workspace", "sessionId": "source",
                "runnerPrincipal": "principal", "runnerInstance": "runner", "channelEpoch": "1",
                "hostInstanceId": "host", "terminalEpoch": "terminal",
            },
            "hostProcess": { "processId": 21, "startMarker": "exact-host" },
        },
        "providerProcess": { "process_id": 22, "start_marker": "exact-provider" },
    }))
    .unwrap();
    let identity = StandaloneRecoveryCreateIdentity::new("standalone_replacement", "private-proof")
        .unwrap()
        .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
        .with_source_predecessor(source.presentation_predecessor().unwrap())
        .unwrap();
    let create = StandaloneCreateRequest::new(
        "/fixture-workspace",
        Some("fixture".into()),
        vec!["/bin/sh".into()],
        37,
        119,
    )
    .unwrap()
    .with_recovery_identity(identity)
    .unwrap();
    let mut replacement = context.as_object().unwrap().clone();
    replacement.insert("create".into(), serde_json::to_value(create).unwrap());
    RecoveryOperationCheckpoint {
        canonical_payload: serde_json::json!({
            "source": source, "sourceBuildId": "old", "targetBuildId": "new",
            "replacement": replacement,
        })
        .to_string(),
        source_stop_receipt: None,
        replacement_receipt: None,
    }
}

#[test]
fn runtime_projection_reads_both_contexts_without_interpreting_or_duplicating_them() {
    for (action, context) in [
        (
            CURRENT_BUILD_ACTION,
            serde_json::json!({"checkout": {"claim": "adapter-owned"}}),
        ),
        (
            SELECTED_BUILD_ACTION,
            serde_json::json!({"runtime": "/selected/runtime"}),
        ),
    ] {
        let checkpoint = checkpoint(context);
        let observed = read_upgrade(action, &checkpoint).unwrap().unwrap();
        let replacement = observed.replacement.unwrap();
        assert_eq!(replacement.create.initial_rows(), 37);
        assert_eq!(replacement.create.initial_columns(), 119);
        assert_eq!(
            replacement
                .create
                .recovery_identity()
                .unwrap()
                .recipe_requirement(),
            StandaloneRecipeRequirement::RequestBound
        );
        let retained: PreparedStandaloneUpgrade<
            std::collections::BTreeMap<String, serde_json::Value>,
        > = PreparedStandaloneUpgrade::read(&checkpoint).unwrap();
        assert_eq!(
            serde_json::to_value(retained).unwrap(),
            serde_json::from_str::<serde_json::Value>(&checkpoint.canonical_payload).unwrap()
        );
    }
}

#[test]
fn a_launch_bound_to_another_source_cannot_transfer_resource_ownership() {
    let mut checkpoint = checkpoint(serde_json::json!({"runtime": "/selected/runtime"}));
    let mut payload: serde_json::Value =
        serde_json::from_str(&checkpoint.canonical_payload).unwrap();
    payload["source"]["generation"]["fence"]["terminalEpoch"] = "another-epoch".into();
    checkpoint.canonical_payload = payload.to_string();
    assert!(read_upgrade(SELECTED_BUILD_ACTION, &checkpoint).is_err());
}

#[test]
fn current_build_observation_has_no_replacement_or_new_lineage() {
    let mut checkpoint = checkpoint(serde_json::json!({"checkout": null}));
    let mut payload: serde_json::Value =
        serde_json::from_str(&checkpoint.canonical_payload).unwrap();
    payload["replacement"] = serde_json::Value::Null;
    checkpoint.canonical_payload = payload.to_string();
    assert!(
        read_upgrade(CURRENT_BUILD_ACTION, &checkpoint)
            .unwrap()
            .unwrap()
            .replacement
            .is_none()
    );
    assert!(
        read_upgrade("unrelated-operation", &checkpoint)
            .unwrap()
            .is_none()
    );
}

#[test]
fn completed_upgrade_keeps_its_successor_after_journal_compaction() {
    assert_successor_survives_compaction(SELECTED_BUILD_ACTION);
}

#[test]
fn completed_current_build_upgrade_keeps_its_successor_after_journal_compaction() {
    assert_successor_survives_compaction(CURRENT_BUILD_ACTION);
}

#[test]
fn pending_upgrade_does_not_consume_a_partial_completion_index() {
    let UpgradeFixture {
        root,
        source,
        operation,
        completion,
        ..
    } = pending_fixture(SELECTED_BUILD_ACTION);
    let directory = root.path().join(".recovery");
    let completed = journal::completed_record(&operation.record, completion).unwrap();
    {
        let _admission = journal::acquire_admission_lock(&directory).unwrap();
        compacted::publish(&directory, &completed).unwrap();
    }
    // Model the power-loss cut after a locator shard but before the primary
    // completion shard is durable. The original operation is still Reserved.
    let key = request_fingerprint(&["standalone-upgrade-completion-v1", &completed.recovery_id]);
    let shard = root
        .path()
        .join(".standalone-upgrade-completions-v1")
        .join(format!("shard_{}.json", &key[..2]));
    let held = shard.with_extension("held");
    std::fs::rename(&shard, &held).unwrap();
    let completed_observation = read_completed(
        &crate::LocalSessionCatalog::new(root.path()),
        &completed.recovery_id,
        SELECTED_BUILD_ACTION,
    );
    let observed = read_successor(
        &crate::LocalSessionCatalog::new(root.path()),
        source.generation(),
        source.provider_process(),
    );
    std::fs::rename(&held, &shard).unwrap();
    assert!(matches!(completed_observation, Ok(None)));
    assert!(matches!(
        observed,
        Ok(Some(StandaloneUpgradeProgress::Pending(_)))
    ));
}

#[test]
fn retired_launch_inputs_are_not_restored_by_later_journal_compaction() {
    let UpgradeFixture {
        root,
        source,
        target,
        mut operation,
        completion,
        ..
    } = pending_fixture(CURRENT_BUILD_ACTION);
    operation.complete(completion).unwrap();
    drop(operation);
    let catalog = crate::LocalSessionCatalog::new(root.path());
    retire_launch_inputs(&catalog, target.generation(), target.provider_process()).unwrap();
    assert!(
        read_compacted_launch(
            &root.path().join(".recovery"),
            target.generation(),
            target.provider_process()
        )
        .unwrap()
        .is_none()
    );
    let report = garbage_collect_completed(
        root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    assert!(
        read_compacted_launch(
            &root.path().join(".recovery"),
            target.generation(),
            target.provider_process()
        )
        .unwrap()
        .is_none()
    );
    let Some(StandaloneUpgradeProgress::Completed(saved)) =
        read_successor(&catalog, source.generation(), source.provider_process()).unwrap()
    else {
        panic!("retired target must retain the exact edge for a delayed owner")
    };
    assert_eq!(saved.target, target);
}

struct UpgradeFixture {
    root: tempfile::TempDir,
    source: StandaloneReplacementSource,
    create: StandaloneCreateRequest,
    target: crate::CompletedStandaloneTarget,
    operation: journal::RecoveryReservation,
    completion: RecoveryCompletion,
}

#[test]
fn compacted_upgrade_id_cannot_be_rebound_to_another_operation() {
    let UpgradeFixture {
        root,
        mut operation,
        completion,
        ..
    } = pending_fixture(SELECTED_BUILD_ACTION);
    let recovery_id = operation.record.recovery_id.clone();
    operation.complete(completion).unwrap();
    drop(operation);
    let report = garbage_collect_completed(
        root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    let rebound = reserve_prepared(
        root.path(),
        PreparedRecoveryIdentity {
            recovery_id: recovery_id.clone(),
            source_session_id: "another-source".into(),
            source_workspace_id: "another-workspace".into(),
            action: "another_operation_v1",
            legacy_request_fingerprint: None,
        },
        Some("{}".into()),
    );
    assert!(
        rebound
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_idempotency_conflict:")),
        "compaction must not make a completed operation id available for a new launch"
    );
    assert!(
        read_completed(
            &crate::LocalSessionCatalog::new(root.path()),
            &recovery_id,
            SELECTED_BUILD_ACTION
        )
        .unwrap()
        .is_some()
    );
}

fn pending_fixture(action: &'static str) -> UpgradeFixture {
    let mut fixture = prepared_fixture(action);
    fixture
        .operation
        .checkpoint_replacement_receipt(serde_json::to_string(&fixture.target).unwrap())
        .unwrap();
    fixture
}

fn prepared_fixture(action: &'static str) -> UpgradeFixture {
    prepared_fixture_with_binding(action, false)
}

fn prepared_fixture_with_binding(action: &'static str, operation_bound: bool) -> UpgradeFixture {
    prepared_fixture_with_destination(action, operation_bound, None)
}

fn prepared_fixture_with_destination(
    action: &'static str,
    operation_bound: bool,
    destination: Option<&std::path::Path>,
) -> UpgradeFixture {
    prepared_fixture_named(action, operation_bound, destination, None)
}

fn prepared_fixture_named(
    action: &'static str,
    operation_bound: bool,
    destination: Option<&std::path::Path>,
    name: Option<&str>,
) -> UpgradeFixture {
    let root = tempfile::tempdir().unwrap();
    let catalog = crate::LocalSessionCatalog::new(root.path());
    let context = if action == SELECTED_BUILD_ACTION {
        serde_json::json!({"runtime": "/selected/runtime"})
    } else {
        serde_json::json!({"checkout": null})
    };
    let mut checkpoint = checkpoint(context);
    let mut payload: serde_json::Value =
        serde_json::from_str(&checkpoint.canonical_payload).unwrap();
    payload["source"]["discoveryRoot"] = serde_json::to_value(catalog.discovery_root()).unwrap();
    if let Some(name) = name {
        payload["source"]["generation"]["fence"]["sessionId"] = format!("source_{name}").into();
        payload["source"]["generation"]["fence"]["hostInstanceId"] = format!("host-{name}").into();
        payload["source"]["providerProcess"]["start_marker"] = format!("provider-{name}").into();
        let source: StandaloneReplacementSource =
            serde_json::from_value(payload["source"].clone()).unwrap();
        let request: StandaloneCreateRequest =
            serde_json::from_value(payload["replacement"]["create"].clone()).unwrap();
        let request = request
            .without_recovery_identity()
            .with_recovery_identity(
                StandaloneRecoveryCreateIdentity::new(
                    format!("standalone_{name}"),
                    format!("proof-{name}"),
                )
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                .with_source_predecessor(source.presentation_predecessor().unwrap())
                .unwrap(),
            )
            .unwrap();
        payload["replacement"]["create"] = serde_json::to_value(request).unwrap();
    }
    let recovery_id = request_fingerprint(&[action, "successor-compaction"]);
    if let Some(root) = destination {
        payload["replacement"]["discoveryRoot"] = serde_json::to_value(root).unwrap();
    }
    if operation_bound {
        let request: StandaloneCreateRequest =
            serde_json::from_value(payload["replacement"]["create"].clone()).unwrap();
        let request = if destination.is_some() {
            request
                .with_recovery_operation_at(&recovery_id, root.path())
                .unwrap()
        } else {
            request.with_recovery_operation_id(&recovery_id).unwrap()
        };
        payload["replacement"]["create"] = serde_json::to_value(request).unwrap();
    }
    checkpoint.canonical_payload = payload.to_string();
    let prepared = read_upgrade(action, &checkpoint).unwrap().unwrap();
    let source = prepared.source;
    let create = prepared.replacement.unwrap().create;
    let identity = create.recovery_identity().unwrap();
    let workspace = hmux_host::local_discovery::workspace_id_for_path(create.provider_cwd());
    let receipt = crate::StandaloneCreateReceipt::new(
        identity.target_session_id(),
        &workspace,
        create.session_name().unwrap(),
        destination.unwrap_or(catalog.discovery_root()),
        identity.launch_owner_proof(),
    )
    .unwrap();
    // A saved exact target is enough to resolve lineage. No live descriptor,
    // process probe or provider launch may be needed after caller loss.
    let target: crate::CompletedStandaloneTarget = serde_json::from_value(serde_json::json!({
        "schema": crate::COMPLETED_STANDALONE_TARGET_SCHEMA,
        "schemaVersion": 1,
        "receipt": receipt,
        "generation": {
            "fence": {
                "workspaceId": workspace, "sessionId": identity.target_session_id(),
                "runnerPrincipal": "principal", "runnerInstance": "runner", "channelEpoch": "2",
                "hostInstanceId": "replacement-host", "terminalEpoch": "replacement-terminal",
            },
            "hostProcess": {"processId": 31, "startMarker": "exact-replacement-host"},
        },
        "providerProcess": {"process_id": 32, "start_marker": "exact-replacement-provider"},
        "hostBuildVersion": "new",
    }))
    .unwrap();
    let RecoveryReservationState::Pending(operation) = reserve_prepared(
        // Storage fixtures address the original operation directly. Native CLI
        // fixtures also exercise routing from the independent caller root.
        root.path(),
        PreparedRecoveryIdentity {
            recovery_id,
            source_session_id: source.generation().fence.session_id.clone(),
            source_workspace_id: source.generation().fence.workspace_id.clone(),
            action,
            legacy_request_fingerprint: None,
        },
        Some(checkpoint.canonical_payload),
    )
    .unwrap() else {
        panic!("a fresh fixture must own its pending upgrade")
    };
    let completion = RecoveryCompletion {
        target_session_id: target.receipt().session_id().into(),
        target_workspace_id: target.receipt().workspace_id().into(),
        target_build_id: "new".into(),
        action: action.into(),
        outcome: "rehosted".into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    };
    UpgradeFixture {
        root,
        source,
        create,
        target,
        operation,
        completion,
    }
}

fn assert_successor_survives_compaction(action: &'static str) {
    let UpgradeFixture {
        root,
        source,
        create,
        target,
        mut operation,
        completion,
    } = pending_fixture(action);
    let catalog = crate::LocalSessionCatalog::new(root.path());
    let recovery_id = operation.record.recovery_id.clone();
    assert!(
        read_completed(&catalog, &recovery_id, action)
            .unwrap()
            .is_none()
    );
    operation.complete(completion).unwrap();
    drop(operation);

    let assert_successor = |stage: &str| {
        let completed = read_completed(&catalog, &recovery_id, action)
            .unwrap()
            .expect("completion must not require the old launch context");
        assert_eq!(completed.source, source);
        assert_eq!(completed.source_build_id, "old");
        assert_eq!(completed.successor.target, target);
        assert!(
            read_completed(&catalog, &recovery_id, "unrelated-operation")
                .err()
                .is_some_and(|error| error.starts_with("hmux_recovery_idempotency_conflict:"))
        );
        let observed =
            read_successor(&catalog, source.generation(), source.provider_process()).unwrap();
        let Some(StandaloneUpgradeProgress::Completed(observed)) = observed else {
            panic!("{action}: unacknowledged successor unavailable {stage}")
        };
        assert_eq!(observed.target, target);
        assert_eq!(
            observed.creation_key,
            crate::standalone_create_idempotency_key(create.recovery_identity().unwrap())
        );
        assert_eq!(
            serde_json::to_value(
                read_compacted_launch(
                    &root.path().join(".recovery"),
                    target.generation(),
                    target.provider_process(),
                )
                .unwrap()
                .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&create).unwrap()
        );
    };
    assert_successor("before compaction");
    let collected = garbage_collect_completed(
        root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(collected.removed_completed_records, 1);
    assert_successor("after compaction");
}
