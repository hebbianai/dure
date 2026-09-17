use std::collections::BTreeMap;
use std::sync::Arc;

use dure_app::{
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentIdV1, AgentSpawnAuthorityV1,
    AgentSpawnJournalStore, AgentSpawnLaunchPlanV1, AgentSpawnPermissionModeV1,
    AgentSpawnPlanIntentDraftV1, AgentSpawnPreviewIntentV1, AgentSpawnRuntimePlanV1,
    AgentSpawnWorktreePolicyV1, CURRENT_STORE_SCHEMA_VERSION, CapabilityIdV1, DomainStore,
    DomainStoreErrorV1, OperationEventIdV1, OperationIdV1,
    PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProjectIdV1, ProviderIdV1, ProviderLaunchDefaultV1,
    ProviderLaunchDefaultsPutDispositionV1, ProviderLaunchDefaultsPutRequestV1,
    ProviderLaunchDefaultsV1, ProviderLaunchPermissionModeV1, RuntimeKindIdV1, WorkspaceIdV1,
};
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::downgrade_workflow_launch_fixture_to_v31;

fn defaults(
    permission_mode: ProviderLaunchPermissionModeV1,
) -> BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1> {
    BTreeMap::from([(
        ProviderIdV1::new("codex").unwrap(),
        ProviderLaunchDefaultV1 { permission_mode },
    )])
}

fn put_request(
    idempotency_key: &str,
    expected_revision: u64,
    permission_mode: ProviderLaunchPermissionModeV1,
) -> ProviderLaunchDefaultsPutRequestV1 {
    ProviderLaunchDefaultsPutRequestV1 {
        schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
        idempotency_key: idempotency_key.into(),
        expected_revision,
        defaults: defaults(permission_mode),
    }
}

fn spawn_draft(idempotency_key: &str) -> AgentSpawnPlanIntentDraftV1 {
    AgentSpawnPlanIntentDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new(format!("spawn-{idempotency_key}")).unwrap(),
        authority: AgentSpawnAuthorityV1 {
            backend_id: "dure-local".into(),
            backend_generation: "generation-1".into(),
            project_id: ProjectIdV1::new("dure").unwrap(),
            root_id: "root_0123456789abcdef0123456789abcdef".into(),
            repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
        },
        request: AgentSpawnPreviewIntentV1 {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            idempotency_key: idempotency_key.into(),
            project_id: ProjectIdV1::new("dure").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: format!("codex-{idempotency_key}"),
            worktree: AgentSpawnWorktreePolicyV1::ProjectRoot,
            provider_conversation_ref: Default::default(),
            permission_override: None,
            prompt_digest: None,
            setup_command: None,
            model: None,
            effort: None,
            interaction_preference: None,
        },
        agent_id: AgentIdV1::new(format!("agent-{idempotency_key}")).unwrap(),
        workspace_id: WorkspaceIdV1::new(format!("workspace-{idempotency_key}")).unwrap(),
        launch: AgentSpawnLaunchPlanV1::NativeCli {
            session_id: format!("session-{idempotency_key}"),
            runtime: AgentSpawnRuntimePlanV1 {
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                required_capabilities: vec![CapabilityIdV1::new("provider-launch").unwrap()],
            },
        },
    }
}

#[tokio::test]
async fn cas_put_if_absent_converges_across_windows_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("application-state.sqlite3");
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first_task = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .put_provider_launch_defaults(
                &put_request(
                    "legacy-window-a",
                    0,
                    ProviderLaunchPermissionModeV1::BypassApprovals,
                ),
                10,
            )
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second_task = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .put_provider_launch_defaults(
                &put_request(
                    "legacy-window-b",
                    0,
                    ProviderLaunchPermissionModeV1::RequireApprovals,
                ),
                11,
            )
            .await
    });
    barrier.wait().await;
    let receipts = [
        first_task.await.unwrap().unwrap(),
        second_task.await.unwrap().unwrap(),
    ];
    assert_eq!(
        receipts
            .iter()
            .filter(|receipt| receipt.disposition == ProviderLaunchDefaultsPutDispositionV1::Created)
            .count(),
        1
    );
    assert_eq!(
        receipts
            .iter()
            .filter(|receipt| {
                receipt.disposition == ProviderLaunchDefaultsPutDispositionV1::PreservedExisting
            })
            .count(),
        1
    );
    assert_eq!(receipts[0].document, receipts[1].document);

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.provider_launch_defaults().await.unwrap(),
        receipts[0].document
    );
}

#[tokio::test]
async fn strict_updates_replay_exact_receipts_and_report_typed_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let request = put_request(
        "defaults-create",
        0,
        ProviderLaunchPermissionModeV1::BypassApprovals,
    );
    let created = store
        .put_provider_launch_defaults(&request, 10)
        .await
        .unwrap();
    assert_eq!(
        store
            .put_provider_launch_defaults(&request, 999)
            .await
            .unwrap(),
        created
    );
    assert!(matches!(
        store
            .put_provider_launch_defaults(
                &put_request(
                    "stale-update",
                    9,
                    ProviderLaunchPermissionModeV1::RequireApprovals,
                ),
                20,
            )
            .await,
        Err(DomainStoreErrorV1::ProviderLaunchDefaultsRevisionConflict {
            expected_revision: 9,
            actual_revision: 1,
        })
    ));
    let mut divergent = request.clone();
    divergent.defaults = defaults(ProviderLaunchPermissionModeV1::RequireApprovals);
    assert!(matches!(
        store.put_provider_launch_defaults(&divergent, 20).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    let mut forged = created.clone();
    forged.document = ProviderLaunchDefaultsV1::new(
        created.document.revision,
        defaults(ProviderLaunchPermissionModeV1::RequireApprovals),
    )
    .unwrap();
    sqlx::query(
        "UPDATE provider_launch_defaults_put_receipts SET receipt_json = ?1 WHERE idempotency_key = ?2",
    )
    .bind(serde_json::to_string(&forged).unwrap())
    .bind(&request.idempotency_key)
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.put_provider_launch_defaults(&request, 30).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_provider_launch_defaults",
            ..
        })
    ));
}

#[tokio::test]
async fn omitted_permission_is_resolved_and_frozen_in_the_atomic_spawn_plan() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let bypass = store
        .put_provider_launch_defaults(
            &put_request(
                "defaults-bypass",
                0,
                ProviderLaunchPermissionModeV1::BypassApprovals,
            ),
            10,
        )
        .await
        .unwrap();
    let first = store
        .append_agent_spawn_plan_resolving_provider_defaults(
            spawn_draft("inherit-a"),
            OperationEventIdV1::new("event-inherit-a").unwrap(),
            11,
            Ok,
        )
        .await
        .unwrap();
    assert_eq!(
        first.plan.request.permission_mode,
        AgentSpawnPermissionModeV1::SkipPermissions
    );
    let proof = first.plan.provider_launch_defaults.as_ref().unwrap();
    assert_eq!(proof.revision, bypass.document.revision);
    assert_eq!(proof.fingerprint, bypass.document.fingerprint);
    assert_eq!(proof.permission_override, None);

    store
        .put_provider_launch_defaults(
            &put_request(
                "defaults-require",
                bypass.document.revision,
                ProviderLaunchPermissionModeV1::RequireApprovals,
            ),
            12,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_spawn_receipt(&first.operation_id)
            .await
            .unwrap()
            .unwrap(),
        first
    );
    let second = store
        .append_agent_spawn_plan_resolving_provider_defaults(
            spawn_draft("inherit-b"),
            OperationEventIdV1::new("event-inherit-b").unwrap(),
            13,
            Ok,
        )
        .await
        .unwrap();
    assert_eq!(
        second.plan.request.permission_mode,
        AgentSpawnPermissionModeV1::Default
    );
    assert_eq!(
        second.plan.provider_launch_defaults.unwrap().revision,
        bypass.document.revision + 1
    );
}

#[tokio::test]
async fn provider_admission_failure_rolls_back_the_atomic_spawn_plan() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();

    let error = store
        .append_agent_spawn_plan_resolving_provider_defaults(
            spawn_draft("rejected"),
            OperationEventIdV1::new("event-rejected").unwrap(),
            10,
            |_| {
                Err(DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected {
                    code: "agent_spawn_provider_unavailable",
                })
            },
        )
        .await
        .unwrap_err();

    assert_eq!(
        error,
        DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected {
            code: "agent_spawn_provider_unavailable",
        }
    );
    assert!(
        store
            .agent_spawn_receipt_by_idempotency_key("rejected")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn malformed_authority_and_schema_nineteen_migration_fail_or_recover_typed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("application-state.sqlite3");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store
        .put_provider_launch_defaults(
            &put_request(
                "defaults-create",
                0,
                ProviderLaunchPermissionModeV1::BypassApprovals,
            ),
            10,
        )
        .await
        .unwrap();
    sqlx::query("UPDATE provider_launch_defaults SET fingerprint = 'sha256:bad'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.provider_launch_defaults().await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_provider_launch_defaults",
            ..
        })
    ));

    sqlx::query("DELETE FROM provider_launch_defaults")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE provider_launch_defaults_put_receipts")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE provider_launch_defaults")
        .execute(&store.pool)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 19, min_reader_version = 19, min_writer_version = 19 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated.provider_launch_defaults().await.unwrap().revision,
        0
    );
}
