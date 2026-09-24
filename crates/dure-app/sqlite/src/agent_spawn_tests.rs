use std::path::Path;
use std::sync::Arc;

use dure_app::{
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentIdV1, AgentSpawnAuthorityV1,
    AgentSpawnCommittedWorkspaceV1, AgentSpawnJournalEventBodyV1, AgentSpawnJournalEventV1,
    AgentSpawnJournalStateV1, AgentSpawnJournalStore, AgentSpawnLaunchPlanV1,
    AgentSpawnPermissionModeV1, AgentSpawnPlanDraftV1, AgentSpawnPlanV1,
    AgentSpawnPreviewRequestV1, AgentSpawnPromptDigestV1, AgentSpawnRuntimePlanV1,
    AgentSpawnStageDispositionV1, AgentSpawnStageEvidenceV1, AgentSpawnStageInputsV1,
    AgentSpawnWorkspaceLeaseV1, AgentSpawnWorktreePolicyV1, CURRENT_STORE_SCHEMA_VERSION,
    CapabilityIdV1, DomainStoreErrorV1, OperationEventIdV1, OperationIdV1, ProjectIdV1,
    ProviderIdV1, RuntimeKindIdV1, WorkflowSessionGenerationV1, WorkspaceIdV1,
    create_agent_spawn_plan_v1,
};
use sqlx::Connection;
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::{
    V11_SCHEMA_STATEMENTS, downgrade_workflow_launch_fixture_to_v31, execute_statements,
    writable_connect_options,
};

fn database_path(temp_dir: &TempDir) -> std::path::PathBuf {
    temp_dir.path().join("domain.sqlite")
}

fn spawn_plan(operation: &str, idempotency_key: &str, prompt: bool) -> AgentSpawnPlanV1 {
    spawn_plan_for(
        operation,
        idempotency_key,
        prompt,
        &format!("agent-{operation}"),
        AgentSpawnWorktreePolicyV1::ProjectRoot,
    )
}

fn spawn_plan_for(
    operation: &str,
    idempotency_key: &str,
    prompt: bool,
    agent_id: &str,
    worktree: AgentSpawnWorktreePolicyV1,
) -> AgentSpawnPlanV1 {
    create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new(operation).unwrap(),
        authority: AgentSpawnAuthorityV1 {
            backend_id: "dure-backend-a".into(),
            backend_generation: "generation-1".into(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_id: "root_0123456789abcdef0123456789abcdef".into(),
            repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
        },
        request: AgentSpawnPreviewRequestV1 {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            idempotency_key: idempotency_key.into(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            provider_id: ProviderIdV1::new("provider.codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: "codex-agent".into(),
            worktree,
            provider_conversation_ref: Default::default(),
            permission_mode: AgentSpawnPermissionModeV1::Default,
            prompt_digest: prompt.then(|| AgentSpawnPromptDigestV1::sha256("super-secret-prompt")),
            setup_command: None,
            model: None,
            effort: None,
            interaction_preference: None,
        },
        agent_id: AgentIdV1::new(agent_id).unwrap(),
        workspace_id: WorkspaceIdV1::new(format!("workspace-{operation}")).unwrap(),
        launch: AgentSpawnLaunchPlanV1::NativeCli {
            session_id: format!("session-{operation}"),
            runtime: AgentSpawnRuntimePlanV1 {
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                required_capabilities: vec![CapabilityIdV1::new("session.create").unwrap()],
            },
        },
        provider_launch_defaults: None,
    })
    .unwrap()
}

fn native_launch(plan: &AgentSpawnPlanV1) -> (&str, &AgentSpawnRuntimePlanV1) {
    match &plan.launch {
        AgentSpawnLaunchPlanV1::NativeCli {
            session_id,
            runtime,
        } => (session_id, runtime),
        AgentSpawnLaunchPlanV1::StructuredProtocol => panic!("expected native test plan"),
    }
}

fn event(
    plan: &AgentSpawnPlanV1,
    sequence: u32,
    body: AgentSpawnJournalEventBodyV1,
) -> AgentSpawnJournalEventV1 {
    AgentSpawnJournalEventV1 {
        event_id: OperationEventIdV1::new(format!(
            "event-{}-{sequence}",
            plan.operation_id.as_str()
        ))
        .unwrap(),
        operation_id: plan.operation_id.clone(),
        sequence,
        plan_token: plan.plan_token.clone(),
        body,
        recorded_at_ms: 100 + i64::from(sequence),
    }
}

fn planned(plan: &AgentSpawnPlanV1) -> AgentSpawnJournalEventV1 {
    event(
        plan,
        1,
        AgentSpawnJournalEventBodyV1::Planned {
            plan: Box::new(plan.clone()),
        },
    )
}

fn successful_events(plan: &AgentSpawnPlanV1) -> Vec<AgentSpawnJournalEventV1> {
    assert!(plan.request.prompt_digest.is_none());
    vec![
        planned(plan),
        event(
            plan,
            2,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: AgentSpawnStageInputsV1::Worktree {
                    workspace_id: plan.workspace_id.clone(),
                    project_root_id: plan.authority.root_id.clone(),
                    repository_id: plan.authority.repository_id.clone(),
                    policy: plan.request.worktree.clone(),
                },
            },
        ),
        event(
            plan,
            3,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id: plan.workspace_id.clone(),
                    disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
                    lease: None,
                },
            },
        ),
        event(
            plan,
            4,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: AgentSpawnStageInputsV1::RuntimeLaunch {
                    agent_id: plan.agent_id.clone(),
                    workspace_id: plan.workspace_id.clone(),
                    session_id: native_launch(plan).0.into(),
                    runtime_kind_id: native_launch(plan).1.runtime_kind_id.clone(),
                    provider_id: plan.request.provider_id.clone(),
                    provider_conversation_ref: plan.request.provider_conversation_ref.clone(),
                    permission_mode: plan.request.permission_mode.clone(),
                    setup_command: plan.request.setup_command.clone(),
                    model: plan.request.model.clone(),
                    effort: plan.request.effort.clone(),
                },
            },
        ),
        event(
            plan,
            5,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::RuntimeLaunch {
                    launch_idempotency_key: Some(format!(
                        "spawn-runtime:{}",
                        plan.operation_id.as_str()
                    )),
                    session: WorkflowSessionGenerationV1 {
                        session_id: native_launch(plan).0.into(),
                        workspace_id: plan.workspace_id.as_str().into(),
                        provider_id: plan.request.provider_id.clone(),
                        runner_principal: "runner-principal-1".into(),
                        runner_instance: "runner-instance-1".into(),
                        channel_epoch: "1".into(),
                        host_instance_id: "host-instance-1".into(),
                        terminal_epoch: "terminal-epoch-1".into(),
                    },
                    initial_prompt_accepted: false,
                },
            },
        ),
        event(plan, 6, AgentSpawnJournalEventBodyV1::Succeeded),
    ]
}

async fn create_v11_fixture(path: &Path) {
    let mut connection = sqlx::SqliteConnection::connect_with(&writable_connect_options(path))
        .await
        .unwrap();
    execute_statements(&mut connection, V11_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 11, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
}

#[tokio::test]
async fn append_replay_and_both_receipt_queries_preserve_one_authoritative_stream() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", true);
    let planned = planned(&plan);

    let first = store.append_agent_spawn_event(&planned).await.unwrap();
    assert_eq!(first.state, AgentSpawnJournalStateV1::Applying);
    assert_eq!(
        store.append_agent_spawn_event(&planned).await.unwrap(),
        first
    );
    assert_eq!(
        store.agent_spawn_receipt(&plan.operation_id).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        store
            .agent_spawn_receipt_by_idempotency_key("spawn-request-1")
            .await
            .unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        store
            .agent_spawn_receipt_by_agent_id(&plan.agent_id)
            .await
            .unwrap(),
        Some(first)
    );
    assert_eq!(
        store
            .agent_spawn_receipt_by_agent_id(&AgentIdV1::new("agent-unknown").unwrap())
            .await
            .unwrap(),
        None
    );

    let stored: String = sqlx::query_scalar(
        "SELECT body_json || receipt_json FROM agent_spawn_events JOIN agent_spawn_receipts USING (operation_id)",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    for forbidden in [
        "super-secret-prompt",
        "credential",
        "pane",
        "layout",
        "focus",
    ] {
        assert!(!stored.contains(forbidden));
    }
}

#[tokio::test]
async fn conflicting_replay_and_wrong_plan_token_roll_back_without_new_events() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", false);
    let planned = planned(&plan);
    store.append_agent_spawn_event(&planned).await.unwrap();

    let mut conflicting_replay = planned.clone();
    conflicting_replay.recorded_at_ms += 1;
    assert!(matches!(
        store.append_agent_spawn_event(&conflicting_replay).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    let other = spawn_plan("spawn-2", "spawn-request-2", false);
    let mut wrong_token = event(
        &plan,
        2,
        AgentSpawnJournalEventBodyV1::StagePrepared {
            attempt: 1,
            inputs: AgentSpawnStageInputsV1::Worktree {
                workspace_id: plan.workspace_id.clone(),
                project_root_id: plan.authority.root_id.clone(),
                repository_id: plan.authority.repository_id.clone(),
                policy: plan.request.worktree.clone(),
            },
        },
    );
    wrong_token.plan_token = other.plan_token;
    assert!(matches!(
        store.append_agent_spawn_event(&wrong_token).await,
        Err(DomainStoreErrorV1::InvalidEventStream { .. })
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_spawn_events")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_serialize_idempotency_key_ownership() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let first = planned(&spawn_plan("spawn-a", "shared-request", false));
    let second = planned(&spawn_plan("spawn-b", "shared-request", false));
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first_task = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store.append_agent_spawn_event(&first).await
    });
    let second_barrier = Arc::clone(&barrier);
    let second_task = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store.append_agent_spawn_event(&second).await
    });
    barrier.wait().await;
    let results = [first_task.await.unwrap(), second_task.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(DomainStoreErrorV1::IdempotencyConflict { .. })))
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_serialize_agent_identity_ownership() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let first = planned(&spawn_plan_for(
        "spawn-a",
        "request-a",
        false,
        "agent-shared",
        AgentSpawnWorktreePolicyV1::ProjectRoot,
    ));
    let second = planned(&spawn_plan_for(
        "spawn-b",
        "request-b",
        false,
        "agent-shared",
        AgentSpawnWorktreePolicyV1::ProjectRoot,
    ));
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first_task = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store.append_agent_spawn_event(&first).await
    });
    let second_barrier = Arc::clone(&barrier);
    let second_task = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store.append_agent_spawn_event(&second).await
    });
    barrier.wait().await;
    let results = [first_task.await.unwrap(), second_task.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "agent_spawn_agent",
                    ..
                })
            ))
            .count(),
        1
    );

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_spawn_events WHERE agent_id = ?1")
            .bind("agent-shared")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn receipt_write_failure_rolls_back_the_event_in_the_same_transaction() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_agent_spawn_receipt
        BEFORE INSERT ON agent_spawn_receipts
        BEGIN
            SELECT RAISE(ABORT, 'injected receipt failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    let planned = planned(&spawn_plan("spawn-1", "spawn-request-1", false));
    assert!(matches!(
        store.append_agent_spawn_event(&planned).await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_spawn_events")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    sqlx::query("DROP TRIGGER fail_agent_spawn_receipt")
        .execute(&store.pool)
        .await
        .unwrap();
    store.append_agent_spawn_event(&planned).await.unwrap();
}

#[tokio::test]
async fn deleted_projection_rebuilds_deterministically_from_the_event_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", false);
    let expected = store
        .append_agent_spawn_event(&planned(&plan))
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_spawn_receipts")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.agent_spawn_receipt(&plan.operation_id).await,
        Err(DomainStoreErrorV1::Storage {
            code: "missing_agent_spawn_receipt",
            ..
        })
    ));
    assert!(matches!(
        store.agent_spawn_receipt_by_agent_id(&plan.agent_id).await,
        Err(DomainStoreErrorV1::Storage {
            code: "missing_agent_spawn_receipt",
            ..
        })
    ));
    assert_eq!(store.rebuild_agent_spawn_receipts().await.unwrap(), 1);
    assert_eq!(
        store.agent_spawn_receipt(&plan.operation_id).await.unwrap(),
        Some(expected.clone())
    );
    assert_eq!(
        store
            .agent_spawn_receipt_by_agent_id(&plan.agent_id)
            .await
            .unwrap(),
        Some(expected)
    );
}

#[tokio::test]
async fn agent_index_body_mismatch_fails_closed_on_lookup_and_reopen() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", false);
    store
        .append_agent_spawn_event(&planned(&plan))
        .await
        .unwrap();
    let tampered = AgentIdV1::new("agent-index-tampered").unwrap();
    sqlx::query("UPDATE agent_spawn_events SET agent_id = ?1")
        .bind(tampered.as_str())
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.agent_spawn_receipt_by_agent_id(&tampered).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_agent_spawn_event",
            ..
        })
    ));
    store.close().await;
    assert!(matches!(
        SqliteDomainStore::open(&path).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_agent_spawn_event",
            ..
        })
    ));
}

#[tokio::test]
async fn agent_lookup_preserves_committed_workspace_ownership() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let branch = "agent/dedicated";
    let dedicated = spawn_plan_for(
        "dedicated",
        "request-dedicated",
        false,
        "agent-dedicated",
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha: "a".repeat(40),
            branch: branch.into(),
            branch_mode: Default::default(),
            checkout_path: None,
        },
    );
    let prepared = event(
        &dedicated,
        2,
        AgentSpawnJournalEventBodyV1::StagePrepared {
            attempt: 1,
            inputs: AgentSpawnStageInputsV1::Worktree {
                workspace_id: dedicated.workspace_id.clone(),
                project_root_id: dedicated.authority.root_id.clone(),
                repository_id: dedicated.authority.repository_id.clone(),
                policy: dedicated.request.worktree.clone(),
            },
        },
    );
    store
        .append_agent_spawn_event(&planned(&dedicated))
        .await
        .unwrap();
    store.append_agent_spawn_event(&prepared).await.unwrap();
    let receipt = store
        .agent_spawn_receipt_by_agent_id(&dedicated.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.committed_workspace_ownership(), None);

    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&dedicated.workspace_id, branch).unwrap();
    store
        .append_agent_spawn_event(&event(
            &dedicated,
            3,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id: dedicated.workspace_id.clone(),
                    disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
                    lease: Some(lease.clone()),
                },
            },
        ))
        .await
        .unwrap();
    let receipt = store
        .agent_spawn_receipt_by_agent_id(&dedicated.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.committed_workspace_ownership(),
        Some(AgentSpawnCommittedWorkspaceV1::DureOwned {
            workspace_id: &dedicated.workspace_id,
            lease: &lease,
        })
    );

    let project_root = spawn_plan("project-root", "request-project-root", false);
    for next in successful_events(&project_root).into_iter().take(3) {
        store.append_agent_spawn_event(&next).await.unwrap();
    }
    let receipt = store
        .agent_spawn_receipt_by_agent_id(&project_root.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.committed_workspace_ownership(),
        Some(AgentSpawnCommittedWorkspaceV1::AdoptedProjectRoot {
            workspace_id: &project_root.workspace_id,
        })
    );
}

#[tokio::test]
async fn corrupt_event_authority_fails_closed_on_read_and_reopen() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", false);
    store
        .append_agent_spawn_event(&planned(&plan))
        .await
        .unwrap();
    sqlx::query("UPDATE agent_spawn_events SET body_json = '{}'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.agent_spawn_receipt(&plan.operation_id).await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    store.close().await;
    assert!(matches!(
        SqliteDomainStore::open(&path).await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
}

#[tokio::test]
async fn terminal_closure_rejects_and_rolls_back_a_late_event() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-1", "spawn-request-1", false);
    for next in successful_events(&plan) {
        store.append_agent_spawn_event(&next).await.unwrap();
    }
    let receipt = store
        .agent_spawn_receipt(&plan.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, AgentSpawnJournalStateV1::Succeeded);

    let late = event(&plan, 7, AgentSpawnJournalEventBodyV1::Succeeded);
    assert!(matches!(
        store.append_agent_spawn_event(&late).await,
        Err(DomainStoreErrorV1::InvalidEventStream { .. })
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_spawn_events WHERE operation_id = ?1")
            .bind(plan.operation_id.as_str())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(count, 6);
}

#[tokio::test]
async fn schema_eleven_migrates_additively_to_agent_spawn_journal_tables() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v11_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('agent_spawn_events', 'agent_spawn_receipts')
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 2);
}

#[tokio::test]
async fn schema_thirty_one_migrates_agent_identity_index_from_planned_events() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let plan = spawn_plan("spawn-before-migration", "request-before-migration", false);
    let expected = store
        .append_agent_spawn_event(&planned(&plan))
        .await
        .unwrap();

    sqlx::query("ALTER TABLE agent_spawn_events RENAME TO agent_spawn_events_v32_fixture")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TABLE agent_spawn_events (
            event_id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            plan_token TEXT NOT NULL,
            idempotency_key TEXT UNIQUE,
            body_json TEXT NOT NULL,
            recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
            UNIQUE (operation_id, sequence),
            CHECK (
                (sequence = 1 AND idempotency_key IS NOT NULL)
                OR (sequence > 1 AND idempotency_key IS NULL)
            )
        )
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_spawn_events (
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            body_json,
            recorded_at_ms
        )
        SELECT
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            body_json,
            recorded_at_ms
        FROM agent_spawn_events_v32_fixture
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("DROP TABLE agent_spawn_events_v32_fixture")
        .execute(&store.pool)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 31, min_reader_version = 31, min_writer_version = 31 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated
            .agent_spawn_receipt_by_agent_id(&plan.agent_id)
            .await
            .unwrap(),
        Some(expected)
    );
    let indexed_agent: String = sqlx::query_scalar(
        "SELECT agent_id FROM agent_spawn_events WHERE operation_id = ?1 AND sequence = 1",
    )
    .bind(plan.operation_id.as_str())
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(indexed_agent, plan.agent_id.as_str());
    let receipt_agent_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('agent_spawn_receipts') WHERE name = 'agent_id'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(receipt_agent_columns, 0);
}

#[tokio::test]
async fn durable_run_catalog_survives_reopen_and_pages_without_client_or_runtime() {
    let root = tempfile::tempdir().unwrap();
    let path = database_path(&root);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    for index in 0..66 {
        let id = format!("catalog-{index:03}");
        let plan = spawn_plan(&id, &id, false);
        for event in successful_events(&plan) {
            store.append_agent_spawn_event(&event).await.unwrap();
        }
    }
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let first = store.list_agent_spawn_receipts(None, None).await.unwrap();
    assert_eq!(first.len(), 65); // the service consumes one lookahead row
    let second = store
        .list_agent_spawn_receipts(Some(&first[63].operation_id), None)
        .await
        .unwrap();
    assert_eq!(second.len(), 2);
    assert_eq!(second[0], first[64]);
    assert!(
        first
            .iter()
            .all(|r| r.state == AgentSpawnJournalStateV1::Succeeded)
    );
    let selected = store
        .list_agent_spawn_receipts(None, Some("agent-catalog-003"))
        .await
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0], first[3]);
    assert_eq!(
        store
            .list_agent_spawn_receipts(None, Some("catalog-003"))
            .await
            .unwrap(),
        selected
    );
    assert_eq!(
        store
            .list_agent_spawn_receipts(None, Some("codex-agent"))
            .await
            .unwrap()
            .len(),
        65
    );
    assert!(
        store
            .list_agent_spawn_receipts(None, Some("missing"))
            .await
            .unwrap()
            .is_empty()
    );
    // Corrupt projections must not become recovery authority through the catalog.
    sqlx::query(
        "UPDATE agent_spawn_receipts SET state = 'failed' WHERE operation_id = 'catalog-003'",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(
        store
            .list_agent_spawn_receipts(None, Some("catalog-003"))
            .await
            .is_err()
    );
}
