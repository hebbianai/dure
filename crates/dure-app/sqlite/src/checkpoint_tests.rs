use std::path::Path;
use std::sync::Arc;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentCheckpointIdentityV1, AgentCheckpointWriteRequestV1, AgentIdV1, AgentRecordV1,
    CURRENT_STORE_SCHEMA_VERSION, DomainStore, DomainStoreErrorV1, ProjectIdV1, ProjectRecordV1,
    ProviderIdV1, RuntimeKindIdV1, SessionBindingRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::{
    V7_SCHEMA_STATEMENTS, V9_SCHEMA_STATEMENTS, execute_statements, writable_connect_options,
};

fn project() -> ProjectRecordV1 {
    ProjectRecordV1 {
        project_id: ProjectIdV1::new("project-1").unwrap(),
        root_path: "/workspace/project".into(),
        display_name: "Project".into(),
        created_at_ms: 10,
        updated_at_ms: 10,
    }
}

fn workspace() -> WorkspaceRecordV1 {
    WorkspaceRecordV1 {
        workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
        project_id: ProjectIdV1::new("project-1").unwrap(),
        root_path: "/workspace/project/.worktrees/agent-1".into(),
        base_commit_sha: Some("0123456789abcdef".into()),
        created_at_ms: 20,
        updated_at_ms: 20,
    }
}

fn agent() -> AgentRecordV1 {
    AgentRecordV1 {
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
        provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        display_name: "Codex".into(),
        created_at_ms: 30,
        updated_at_ms: 30,
    }
}

fn binding(generation: i64) -> SessionBindingRecordV1 {
    SessionBindingRecordV1 {
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        session_id: format!("session-{generation}"),
        provider_conversation_id: None,
        credential_reference_id: None,
        binding_generation: generation,
        bound_at_ms: 30 + generation,
    }
}

fn identity(generation: i64) -> AgentCheckpointIdentityV1 {
    AgentCheckpointIdentityV1 {
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        session_id: format!("session-{generation}"),
        binding_generation: generation,
    }
}

fn authority(generation: i64) -> AgentCheckpointBindingAuthorityV1 {
    AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: binding(generation),
        runtime_workspace_id: "hmux-workspace-1".into(),
        runner_principal: "runner".into(),
        runner_instance: "instance".into(),
        channel_epoch: "channel".into(),
        host_instance_id: "host".into(),
        terminal_epoch: format!("terminal-{generation}"),
        updated_at_ms: 40 + generation,
    }
}

fn request(
    idempotency_key: &str,
    generation: i64,
    expected_revision: i64,
    checkpoint: &str,
) -> AgentCheckpointWriteRequestV1 {
    AgentCheckpointWriteRequestV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        identity: identity(generation),
        idempotency_key: idempotency_key.into(),
        expected_revision,
        checkpoint: checkpoint.into(),
    }
}

async fn seed(store: &SqliteDomainStore) {
    store.upsert_project(&project()).await.unwrap();
    store.upsert_workspace(&workspace()).await.unwrap();
    store.upsert_agent(&agent()).await.unwrap();
    store.upsert_session_binding(&binding(1)).await.unwrap();
}

#[tokio::test]
async fn exact_binding_round_trips_and_replays_a_stable_receipt() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    assert_eq!(store.agent_checkpoint(&identity(1)).await.unwrap(), None);

    let first_request = request("checkpoint-request-1", 1, 0, "authority audit complete");
    let first = store.write_agent_checkpoint(&first_request).await.unwrap();
    let replay = store.write_agent_checkpoint(&first_request).await.unwrap();
    assert_eq!(replay, first);
    assert_eq!(first.record.revision, 1);
    assert_eq!(
        store.agent_checkpoint(&identity(1)).await.unwrap(),
        Some(first.record.clone())
    );

    store.upsert_session_binding(&binding(2)).await.unwrap();
    assert!(matches!(
        store.agent_checkpoint(&identity(1)).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent_checkpoint_binding",
            ..
        })
    ));
    assert_eq!(
        store.write_agent_checkpoint(&first_request).await.unwrap(),
        first
    );
    assert_eq!(
        store.agent_checkpoint(&identity(2)).await.unwrap(),
        Some(first.record)
    );
}

#[tokio::test]
async fn stale_revision_and_changed_idempotency_request_fail_closed() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    let first = request("checkpoint-request-1", 1, 0, "first");
    store.write_agent_checkpoint(&first).await.unwrap();

    let changed_replay = request("checkpoint-request-1", 1, 1, "changed");
    assert!(matches!(
        store.write_agent_checkpoint(&changed_replay).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(matches!(
        store
            .write_agent_checkpoint(&request("checkpoint-request-2", 1, 0, "stale"))
            .await,
        Err(DomainStoreErrorV1::RevisionConflict {
            expected_revision: 0,
            actual_revision: Some(1),
            ..
        })
    ));
    assert_eq!(
        store
            .agent_checkpoint(&identity(1))
            .await
            .unwrap()
            .unwrap()
            .checkpoint,
        "first"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_cannot_lose_an_update() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let seed_store = SqliteDomainStore::open(&path).await.unwrap();
    seed(&seed_store).await;
    seed_store.close().await;

    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .write_agent_checkpoint(&request("writer-a", 1, 0, "writer a"))
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .write_agent_checkpoint(&request("writer-b", 1, 0, "writer b"))
            .await
    });

    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(DomainStoreErrorV1::RevisionConflict {
                    expected_revision: 0,
                    actual_revision: Some(1),
                    ..
                })
            ))
            .count(),
        1
    );

    let verifier = SqliteDomainStore::open(&path).await.unwrap();
    let record = verifier
        .agent_checkpoint(&identity(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.revision, 1);
    assert!(matches!(
        record.checkpoint.as_str(),
        "writer a" | "writer b"
    ));
}

#[tokio::test]
async fn malformed_stored_checkpoint_is_typed_and_never_returned() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .write_agent_checkpoint(&request("checkpoint-request-1", 1, 0, "valid"))
        .await
        .unwrap();

    let mut connection = store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints = ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_checkpoints SET schema_version = 99")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA ignore_check_constraints = OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert!(matches!(
        store.agent_checkpoint(&identity(1)).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_agent_checkpoint",
            ..
        })
    ));
}

#[tokio::test]
async fn malformed_stored_receipt_is_not_misreported_as_a_client_conflict() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    let first_request = request("checkpoint-request-1", 1, 0, "valid");
    store.write_agent_checkpoint(&first_request).await.unwrap();

    let mut connection = store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints = ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_checkpoint_receipts SET result_revision = 0")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA ignore_check_constraints = OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert!(matches!(
        store.write_agent_checkpoint(&first_request).await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_agent_checkpoint_receipt",
            ..
        })
    ));
}

#[tokio::test]
async fn binding_and_exact_fence_rollback_together_after_injected_crash_boundary() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_checkpoint_authority_update
        BEFORE UPDATE ON agent_checkpoint_binding_authorities
        BEGIN
            SELECT RAISE(ABORT, 'injected fence commit failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(
        store
            .upsert_agent_checkpoint_binding_authority(&authority(2))
            .await
            .is_err()
    );
    assert_eq!(
        store
            .session_binding(&AgentIdV1::new("agent-1").unwrap())
            .await
            .unwrap(),
        Some(binding(1))
    );
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&AgentIdV1::new("agent-1").unwrap())
            .await
            .unwrap(),
        Some(authority(1))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_exact_runtime_generation_has_one_agent_owner() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let seed_store = SqliteDomainStore::open(&path).await.unwrap();
    seed_store.upsert_project(&project()).await.unwrap();
    seed_store.upsert_workspace(&workspace()).await.unwrap();
    seed_store.upsert_agent(&agent()).await.unwrap();
    let second_agent_id = AgentIdV1::new("agent-2").unwrap();
    let mut second_agent = agent();
    second_agent.agent_id = second_agent_id.clone();
    second_agent.display_name = "Second pane".into();
    seed_store.upsert_agent(&second_agent).await.unwrap();
    seed_store.close().await;

    let first_authority = authority(1);
    let mut second_authority = first_authority.clone();
    second_authority.binding.agent_id = second_agent_id.clone();
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .upsert_agent_checkpoint_binding_authority(&first_authority)
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .upsert_agent_checkpoint_binding_authority(&second_authority)
            .await
    });

    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "agent_checkpoint_binding_authority",
                    ..
                })
            ))
            .count(),
        1
    );

    let verifier = SqliteDomainStore::open(&path).await.unwrap();
    let mut binding_owners = 0;
    let mut authority_owners = 0;
    for agent_id in [AgentIdV1::new("agent-1").unwrap(), second_agent_id] {
        binding_owners += usize::from(verifier.session_binding(&agent_id).await.unwrap().is_some());
        authority_owners += usize::from(
            verifier
                .agent_checkpoint_binding_authority(&agent_id)
                .await
                .unwrap()
                .is_some(),
        );
    }
    assert_eq!(binding_owners, 1);
    assert_eq!(authority_owners, 1);
}

#[tokio::test]
async fn exact_generation_ownership_is_scoped_by_runtime_kind() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();

    let second_agent_id = AgentIdV1::new("agent-2").unwrap();
    let mut second_agent = agent();
    second_agent.agent_id = second_agent_id.clone();
    second_agent.display_name = "Other runtime pane".into();
    store.upsert_agent(&second_agent).await.unwrap();
    let mut other_runtime = authority(1);
    other_runtime.binding.agent_id = second_agent_id.clone();
    other_runtime.binding.runtime_kind_id = RuntimeKindIdV1::new("runtime.other").unwrap();

    store
        .upsert_agent_checkpoint_binding_authority(&other_runtime)
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&second_agent_id)
            .await
            .unwrap(),
        Some(other_runtime)
    );
}

#[tokio::test]
async fn legacy_duplicate_generation_fails_closed_on_exact_replay() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();
    let second_agent_id = AgentIdV1::new("agent-2").unwrap();
    let mut second_agent = agent();
    second_agent.agent_id = second_agent_id.clone();
    second_agent.display_name = "Legacy duplicate pane".into();
    store.upsert_agent(&second_agent).await.unwrap();
    let mut duplicate = authority(1);
    duplicate.binding.agent_id = second_agent_id;

    sqlx::query(
        r#"
        INSERT INTO session_bindings (
            agent_id, runtime_kind_id, session_id, provider_conversation_id,
            credential_reference_id, binding_generation, bound_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(duplicate.binding.agent_id.as_str())
    .bind(duplicate.binding.runtime_kind_id.as_str())
    .bind(&duplicate.binding.session_id)
    .bind(&duplicate.binding.provider_conversation_id)
    .bind(&duplicate.binding.credential_reference_id)
    .bind(duplicate.binding.binding_generation)
    .bind(duplicate.binding.bound_at_ms)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_checkpoint_binding_authorities (
            agent_id, schema_version, session_id, runtime_workspace_id,
            runner_principal, runner_instance, channel_epoch, host_instance_id,
            terminal_epoch, binding_generation, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
    )
    .bind(duplicate.binding.agent_id.as_str())
    .bind(i64::from(duplicate.schema_version))
    .bind(&duplicate.binding.session_id)
    .bind(&duplicate.runtime_workspace_id)
    .bind(&duplicate.runner_principal)
    .bind(&duplicate.runner_instance)
    .bind(&duplicate.channel_epoch)
    .bind(&duplicate.host_instance_id)
    .bind(&duplicate.terminal_epoch)
    .bind(duplicate.binding.binding_generation)
    .bind(duplicate.updated_at_ms)
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .upsert_agent_checkpoint_binding_authority(&duplicate)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent_checkpoint_binding_authority",
            ..
        })
    ));
}

#[tokio::test]
async fn provider_conversation_converges_only_for_the_exact_current_authority() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    store.upsert_project(&project()).await.unwrap();
    store.upsert_workspace(&workspace()).await.unwrap();
    store.upsert_agent(&agent()).await.unwrap();
    let mut expected = authority(7);
    expected.binding.credential_reference_id = Some("credential-hebbian98".into());
    store
        .upsert_agent_checkpoint_binding_authority(&expected)
        .await
        .unwrap();

    let mut wrong_session = expected.clone();
    wrong_session.binding.session_id = "session-other".into();
    let mut wrong_workspace = expected.clone();
    wrong_workspace.runtime_workspace_id = "hmux-workspace-other".into();
    let mut wrong_generation = expected.clone();
    wrong_generation.binding.binding_generation += 1;
    for stale in [wrong_session, wrong_workspace, wrong_generation] {
        assert!(matches!(
            store
                .converge_agent_checkpoint_provider_conversation(&stale, "conversation-codex")
                .await,
            Err(DomainStoreErrorV1::IdentityConflict { .. })
        ));
    }
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&expected.binding.agent_id)
            .await
            .unwrap(),
        Some(expected.clone())
    );

    let mut converged = expected.clone();
    converged.binding.provider_conversation_id = Some("conversation-codex".into());
    assert_eq!(
        store
            .converge_agent_checkpoint_provider_conversation(&expected, "conversation-codex")
            .await
            .unwrap(),
        converged
    );
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&expected.binding.agent_id)
            .await
            .unwrap(),
        Some(converged.clone()),
        "conversation discovery must preserve the credential and exact backend fence"
    );
    assert!(matches!(
        store
            .converge_agent_checkpoint_provider_conversation(&expected, "conversation-other")
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&expected.binding.agent_id)
            .await
            .unwrap(),
        Some(converged),
        "a present conversation must never be replaced"
    );
}

#[tokio::test]
async fn bulk_observation_returns_checkpoint_and_exact_binding_from_one_snapshot() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();
    let receipt = store
        .write_agent_checkpoint(&request("bulk-observe-1", 1, 0, "bulk snapshot"))
        .await
        .unwrap();

    let observations = store
        .agent_checkpoint_observations(&[
            AgentIdV1::new("agent-1").unwrap(),
            AgentIdV1::new("agent-missing").unwrap(),
        ])
        .await
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].authority, authority(1));
    assert_eq!(observations[0].checkpoint, Some(receipt.record));
}

// Live defect (2026-08-13): after a rehost advanced the binding authority
// without a new checkpoint write, the generation-scoped LEFT JOIN stopped
// serving the agent's last checkpoint entirely — the sidebar froze on old
// text while the backend held a newer durable revision. Observation is a
// durable-state read; write/ensure own the authorization fence.
#[tokio::test]
async fn bulk_observation_serves_the_last_checkpoint_across_a_generation_advance() {
    let root = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();
    let receipt = store
        .write_agent_checkpoint(&request("pre-rehost-1", 1, 0, "written before rehost"))
        .await
        .unwrap();
    // The authority upsert advances the session binding and the fence in one
    // transaction — exactly what ensure_binding does after a rehost.
    store
        .upsert_agent_checkpoint_binding_authority(&authority(2))
        .await
        .unwrap();

    let observations = store
        .agent_checkpoint_observations(&[AgentIdV1::new("agent-1").unwrap()])
        .await
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].authority, authority(2));
    assert_eq!(observations[0].checkpoint, Some(receipt.record));
}

#[tokio::test]
async fn schema_seven_migrates_additively_to_checkpoint_authority() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    create_v7_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    seed(&store).await;
    assert_eq!(
        store
            .write_agent_checkpoint(&request("checkpoint-request-1", 1, 0, "migrated"))
            .await
            .unwrap()
            .record
            .revision,
        1
    );
}

#[tokio::test]
async fn schema_nine_migrates_additively_to_exact_binding_authority() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    execute_statements(&mut connection, V9_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 9, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    seed(&store).await;
    store
        .upsert_agent_checkpoint_binding_authority(&authority(1))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&AgentIdV1::new("agent-1").unwrap())
            .await
            .unwrap(),
        Some(authority(1))
    );
}

async fn create_v7_fixture(path: &Path) {
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(path))
        .await
        .unwrap();
    execute_statements(&mut connection, V7_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 7, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
}
