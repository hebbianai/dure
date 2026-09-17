use std::time::Duration;

mod launch_tests;

use agent_orchestration::contract::{
    CompleteDispatchRequest, DeliveryState, DispatchContextReceipt, ReadEventsBatchItemOutcome,
    ReadEventsBatchItemRequest, ReadEventsBatchRequest, ReadEventsRequest,
};
use agent_orchestration::domain::{
    Audience, AudienceGrant, AuthorityScope, CapabilityRef, DispatchId, DispatchState, EventCursor,
    Generation, IntegrationCapabilityReceipt, InteractionId, InteractionTarget, MembershipRef,
    ParticipantRef, Revision, RoleRef, RunId, TaskId, WorkerEndpointFence, WorkerEndpointRef,
    WorkspaceId,
};
use dure_app::{
    AgentIdV1, AgentRecordV1, CURRENT_STORE_SCHEMA_VERSION, ContributionIdV2,
    DELEGATE_ONCE_SCHEMA_VERSION_V1, DelegateOncePromptActivityRequestV1,
    DelegateOncePromptClaimRequestV1, DelegateOncePromptOutcomeRequestV1, DelegateOnceRequestV1,
    DelegateOnceSessionBindingRequestV1, DelegateOnceStartFailureRequestV1, DelegateOnceTaskSpecV1,
    DomainStore, DomainStoreErrorV1, ProjectIdV1, ProjectRecordV1, ProviderIdV1, RuntimeKindIdV1,
    WorkflowCoordinatorBindingV1, WorkflowDispatchStateV1, WorkflowPromptActivityReceiptV1,
    WorkflowPromptActivityStateV1, WorkflowPromptDeliveryEvidenceV1,
    WorkflowPromptDeliveryOutcomeV1, WorkflowPromptDeliveryStateV1, WorkflowSessionGenerationV1,
    WorkflowStore, WorkspaceIdV1, WorkspaceRecordV1, prepare_delegate_once,
    workflow_prepared_session_id,
};
use serde_json::json;
use sqlx::{Connection, Row, SqliteConnection};
use tempfile::tempdir;

use crate::schema::{
    V12_SCHEMA_STATEMENTS, V13_SCHEMA_STATEMENTS, V14_SCHEMA_STATEMENTS,
    downgrade_workflow_launch_fixture_to_v31, execute_statements, writable_connect_options,
};
use crate::{
    OrchestrationDispatchContextRequestV1, OrchestrationDispatchContextResolutionV1,
    SqliteDomainStore, orchestration_session_identity,
};

fn request() -> DelegateOnceRequestV1 {
    DelegateOnceRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        contribution_id: ContributionIdV2::new("dure.core.delegate-once").unwrap(),
        coordinator: WorkflowCoordinatorBindingV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            session_id: "session-1".into(),
            binding_generation: 3,
        },
        task: DelegateOnceTaskSpecV1 {
            summary: "Review the bounded change".into(),
            instructions: "Inspect the requested change and return findings.".into(),
        },
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        target_reference: "backend-profile:local".into(),
        idempotency_key: "delegate-once-1".into(),
        created_at_ms: 1_000,
    }
}

fn session() -> WorkflowSessionGenerationV1 {
    WorkflowSessionGenerationV1 {
        session_id: "workflow-session-1".into(),
        workspace_id: "workspace-1".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "runner-1".into(),
        runner_instance: "instance-1".into(),
        channel_epoch: "channel-1".into(),
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
    }
}

fn binding(receipt: &dure_app::DelegateOnceReceiptV1) -> DelegateOnceSessionBindingRequestV1 {
    DelegateOnceSessionBindingRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: receipt.task_id.clone(),
        dispatch_id: receipt.dispatch_id.clone(),
        generation: receipt.generation,
        launch_idempotency_key: receipt.launch_idempotency_key.clone(),
        effective_launch_idempotency_key: "workflow:effective-1".into(),
        session: session(),
        bound_at_ms: 1_500,
    }
}

async fn seed_orchestration_coordinator(store: &SqliteDomainStore) {
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project".into(),
            display_name: "Project".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project".into(),
            base_commit_sha: None,
            created_at_ms: 20,
            updated_at_ms: 20,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Coordinator".into(),
            created_at_ms: 30,
            updated_at_ms: 30,
        })
        .await
        .unwrap();
}

fn capability(value: &str) -> CapabilityRef {
    CapabilityRef::new(value).unwrap()
}

async fn bind_orchestration_context(
    store: &SqliteDomainStore,
    active: &dure_app::DelegateOnceReceiptV1,
    suffix: &str,
    resolved_at_ms: i64,
) -> DispatchContextReceipt {
    let session = active.session.as_ref().unwrap();
    let target = InteractionTarget {
        authority: AuthorityScope {
            workspace_id: WorkspaceId::new("workspace-1").unwrap(),
            tenant_ref: None,
        },
        run_id: RunId::new(active.run_id.as_str()).unwrap(),
        task_id: TaskId::new(active.task_id.as_str()).unwrap(),
        dispatch_id: DispatchId::new(active.dispatch_id.as_str()).unwrap(),
        generation: Generation::new(u64::try_from(active.generation).unwrap()).unwrap(),
    };
    let integration_receipt: IntegrationCapabilityReceipt = serde_json::from_value(json!({
        "installRootRef": "install-root-fixture",
        "version": "fixture-v1",
        "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "channel": "test",
        "capabilities": ["event_cursor_v1", "idempotent_delivery_receipt_v1"]
    }))
    .unwrap();
    let worker_delivery = capability(&format!("capability-worker-delivery-{suffix}"));
    let worker_acknowledgement = capability(&format!("capability-worker-ack-{suffix}"));
    let coordinator_delivery = capability(&format!("capability-coordinator-delivery-{suffix}"));
    let coordinator_reply = capability(&format!("capability-coordinator-reply-{suffix}"));
    let proposal = DispatchContextReceipt {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        target: target.clone(),
        dispatch_revision: Revision::INITIAL,
        dispatch_state: DispatchState::Active,
        successor_required: false,
        participant: ParticipantRef::new(format!("participant-worker-{suffix}")).unwrap(),
        interaction_capability: capability(&format!("capability-interaction-{suffix}")),
        completion_capability: capability(&format!("capability-completion-{suffix}")),
        delivery_capability: worker_delivery.clone(),
        acknowledgement_capability: worker_acknowledgement.clone(),
        wake_capability: Some(capability(&format!("capability-worker-wake-{suffix}"))),
        endpoint_fence: WorkerEndpointFence {
            endpoint_ref: WorkerEndpointRef::new(format!("endpoint-worker-{suffix}")).unwrap(),
            session_identity: orchestration_session_identity(session).unwrap(),
            generation: target.generation,
            delivery_capability: worker_delivery,
            acknowledgement_capability: worker_acknowledgement,
        },
        coordinator_grant: AudienceGrant {
            membership_ref: MembershipRef::new(format!("membership-coordinator-{suffix}")).unwrap(),
            participant: ParticipantRef::new("participant-coordinator").unwrap(),
            roles: vec![RoleRef::new("role.coordinator").unwrap()],
            capabilities: vec![coordinator_delivery.clone(), coordinator_reply.clone()],
            delivery_capability: coordinator_delivery,
        },
        coordinator_reply_capability: coordinator_reply,
        integration_receipt: integration_receipt.clone(),
    };
    proposal.validate().unwrap();
    store
        .negotiate_orchestration_dispatch_context(
            &OrchestrationDispatchContextRequestV1 {
                schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
                target,
                session: session.clone(),
                integration_receipt,
                idempotency_key: format!("bind-context-{suffix}"),
                resolved_at_ms,
            },
            &proposal,
        )
        .await
        .unwrap()
}

async fn complete_orchestration_context(
    store: &SqliteDomainStore,
    context: &DispatchContextReceipt,
    suffix: &str,
    completed_at_ms: i64,
) {
    store
        .interaction_service()
        .complete(CompleteDispatchRequest {
            schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
            idempotency_key: format!("complete-{suffix}"),
            message_id: InteractionId::new(format!("completion-{suffix}")).unwrap(),
            target: context.target.clone(),
            expected_dispatch_revision: context.dispatch_revision,
            completed_by: context.participant.clone(),
            endpoint_fence: context.endpoint_fence.clone(),
            audience: Audience {
                grants: vec![context.coordinator_grant.clone()],
            },
            completion_capability: context.completion_capability.clone(),
            title: "Completed".into(),
            result_markdown: "Done.".into(),
            completed_at_ms,
        })
        .await
        .unwrap();
}

async fn observe_coordinator_events(store: &SqliteDomainStore, context: &DispatchContextReceipt) {
    store
        .interaction_service()
        .read_events(coordinator_event_read(context, EventCursor::BEGINNING))
        .await
        .unwrap();
}

fn coordinator_event_read(
    context: &DispatchContextReceipt,
    after: EventCursor,
) -> ReadEventsRequest {
    ReadEventsRequest {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        target: Some(context.target.clone()),
        participant: context.coordinator_grant.participant.clone(),
        delivery_capability: context.coordinator_grant.delivery_capability.clone(),
        endpoint_fence: None,
        after,
        acknowledgement: None,
        limit: 10,
    }
}

fn coordinator_event_read_batch(
    context: &DispatchContextReceipt,
    after: EventCursor,
) -> ReadEventsBatchRequest {
    ReadEventsBatchRequest {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        requests: vec![ReadEventsBatchItemRequest {
            correlation_id: "coordinator-events".into(),
            request: coordinator_event_read(context, after),
        }],
    }
}

async fn prepare_orchestration_context(
    store: &SqliteDomainStore,
    suffix: &str,
) -> DispatchContextReceipt {
    seed_orchestration_coordinator(store).await;
    let created = store.create_delegate_once(&request()).await.unwrap();
    let bound = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    let active = record_prompt_written(store, &bound).await;
    bind_orchestration_context(store, &active, suffix, 1_800).await
}

async fn held_writer(path: &std::path::Path) -> SqliteConnection {
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(path))
        .await
        .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .unwrap();
    connection
}

async fn stored_coordinator_delivery_state(
    connection: &mut SqliteConnection,
    context: &DispatchContextReceipt,
) -> DeliveryState {
    let delivery: String = sqlx::query_scalar(
        r#"
        SELECT delivery.delivery_json
        FROM workflow_interaction_deliveries AS delivery
        JOIN workflow_interaction_authorities AS authority
          ON authority.authority_key = delivery.authority_key
        WHERE authority.dispatch_id = ?1
          AND json_extract(delivery.delivery_json, '$.receipt.participant') = ?2
        ORDER BY delivery.event_cursor
        LIMIT 1
        "#,
    )
    .bind(context.target.dispatch_id.as_str())
    .bind(context.coordinator_grant.participant.as_str())
    .fetch_one(connection)
    .await
    .unwrap();
    serde_json::from_str::<serde_json::Value>(&delivery).unwrap()["receipt"]["state"]
        .as_str()
        .and_then(|state| match state {
            "queued" => Some(DeliveryState::Queued),
            "observed" => Some(DeliveryState::Observed),
            "acknowledged" => Some(DeliveryState::Acknowledged),
            _ => None,
        })
        .unwrap()
}

fn prompt_claim(receipt: &dure_app::DelegateOnceReceiptV1) -> DelegateOncePromptClaimRequestV1 {
    DelegateOncePromptClaimRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: receipt.task_id.clone(),
        dispatch_id: receipt.dispatch_id.clone(),
        generation: receipt.generation,
        delivery_idempotency_key: receipt
            .prompt_delivery
            .as_ref()
            .unwrap()
            .idempotency_key
            .clone(),
        session: receipt.session.clone().unwrap(),
        claimed_at_ms: 1_600,
    }
}

fn prompt_outcome(receipt: &dure_app::DelegateOnceReceiptV1) -> DelegateOncePromptOutcomeRequestV1 {
    DelegateOncePromptOutcomeRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: receipt.task_id.clone(),
        dispatch_id: receipt.dispatch_id.clone(),
        generation: receipt.generation,
        delivery_idempotency_key: receipt
            .prompt_delivery
            .as_ref()
            .unwrap()
            .idempotency_key
            .clone(),
        session: receipt.session.clone().unwrap(),
        outcome: WorkflowPromptDeliveryOutcomeV1::WrittenToPty(
            WorkflowPromptDeliveryEvidenceV1::agent_prompt(
                receipt.session.as_ref().unwrap().terminal_epoch.clone(),
                "4",
                "8",
                Some("3".into()),
            ),
        ),
        recorded_at_ms: 1_700,
    }
}

fn prompt_activity(
    receipt: &dure_app::DelegateOnceReceiptV1,
    state: WorkflowPromptActivityStateV1,
    observed_output_seq: &str,
    error_code: Option<&str>,
    observed_at_ms: i64,
) -> DelegateOncePromptActivityRequestV1 {
    DelegateOncePromptActivityRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: receipt.task_id.clone(),
        dispatch_id: receipt.dispatch_id.clone(),
        generation: receipt.generation,
        delivery_idempotency_key: receipt
            .prompt_delivery
            .as_ref()
            .unwrap()
            .idempotency_key
            .clone(),
        session: receipt.session.clone().unwrap(),
        activity: WorkflowPromptActivityReceiptV1 {
            state,
            observed_output_seq: observed_output_seq.into(),
            error_code: error_code.map(str::to_owned),
        },
        observed_at_ms,
    }
}

async fn record_prompt_written(
    store: &SqliteDomainStore,
    active: &dure_app::DelegateOnceReceiptV1,
) -> dure_app::DelegateOnceReceiptV1 {
    record_prompt_written_at(store, active, 1_600, 1_700).await
}

async fn record_prompt_written_at(
    store: &SqliteDomainStore,
    active: &dure_app::DelegateOnceReceiptV1,
    claimed_at_ms: i64,
    recorded_at_ms: i64,
) -> dure_app::DelegateOnceReceiptV1 {
    let mut claim_request = prompt_claim(active);
    claim_request.claimed_at_ms = claimed_at_ms;
    let claim = store
        .claim_delegate_once_prompt(&claim_request)
        .await
        .unwrap();
    assert!(claim.claimed);
    let claimed = claim.receipt;
    let mut outcome_request = prompt_outcome(&claimed);
    outcome_request.recorded_at_ms = recorded_at_ms;
    store
        .record_delegate_once_prompt_outcome(&outcome_request)
        .await
        .unwrap()
}

#[tokio::test]
async fn event_read_batch_empty_snapshot_does_not_reserve_writer() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "empty-event-read").await;
    complete_orchestration_context(&store, &context, "empty-event-read", 1_900).await;
    let service = store.interaction_service();
    let observed = service
        .read_events(coordinator_event_read(&context, EventCursor::BEGINNING))
        .await
        .unwrap();
    assert!(!observed.events.is_empty());
    let cursor = observed.next_cursor;
    let mut writer = held_writer(&path).await;

    let batch_read = tokio::time::timeout(
        Duration::from_millis(250),
        service.read_events_batch(coordinator_event_read_batch(&context, cursor)),
    )
    .await;
    let scalar_read = tokio::time::timeout(
        Duration::from_millis(250),
        service.read_events(coordinator_event_read(&context, cursor)),
    )
    .await;
    sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();

    let receipt = batch_read
        .expect("an empty Event read must not wait for an unrelated writer")
        .unwrap();
    let ReadEventsBatchItemOutcome::Read(empty) = &receipt.results[0].outcome else {
        panic!("the empty Event read must succeed");
    };
    assert!(empty.events.is_empty());
    assert!(empty.deliveries.is_empty());
    assert_eq!(empty.next_cursor, cursor);
    let empty = scalar_read
        .expect("an empty scalar Event read must not wait for an unrelated writer")
        .unwrap();
    assert!(empty.events.is_empty());
    assert_eq!(empty.next_cursor, cursor);
}

#[tokio::test]
async fn event_read_batch_state_change_waits_for_writer_and_persists() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "changing-event-read").await;
    complete_orchestration_context(&store, &context, "changing-event-read", 1_900).await;
    let service = store.interaction_service();
    let mut writer = held_writer(&path).await;
    let mut read = Box::pin(service.read_events_batch(coordinator_event_read_batch(
        &context,
        EventCursor::BEGINNING,
    )));

    assert!(
        tokio::time::timeout(Duration::from_millis(250), read.as_mut())
            .await
            .is_err(),
        "an Event read that observes a delivery must wait until it can persist"
    );
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Queued
    );
    sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();

    let receipt = tokio::time::timeout(Duration::from_millis(250), read.as_mut())
        .await
        .expect("the state-changing Event read must resume after the writer releases")
        .unwrap();
    let ReadEventsBatchItemOutcome::Read(observed) = &receipt.results[0].outcome else {
        panic!("the state-changing Event read must succeed");
    };
    assert_eq!(observed.deliveries[0].state, DeliveryState::Observed);
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Observed
    );
}

#[tokio::test]
async fn exact_session_context_batch_is_ordered_isolated_and_matches_scalar_precedence() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let mut plan_connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    let plan = sqlx::query(
        r#"
        EXPLAIN QUERY PLAN
        WITH requested AS (
            SELECT
                json_extract(entry.value, '$.sessionId') AS session_id,
                json_extract(entry.value, '$.workspaceId') AS workspace_id,
                json_extract(entry.value, '$.providerId') AS provider_id,
                json_extract(entry.value, '$.runnerPrincipal') AS runner_principal,
                json_extract(entry.value, '$.runnerInstance') AS runner_instance,
                json_extract(entry.value, '$.channelEpoch') AS channel_epoch,
                json_extract(entry.value, '$.hostInstanceId') AS host_instance_id,
                json_extract(entry.value, '$.terminalEpoch') AS terminal_epoch
            FROM json_each(?1) AS entry
        )
        SELECT launch.dispatch_id
        FROM requested
        JOIN workflow_dispatch_launches AS launch
          ON launch.state = 'active'
         AND launch.session_id = requested.session_id
         AND launch.workspace_id = requested.workspace_id
         AND launch.provider_id = requested.provider_id
         AND launch.runner_principal = requested.runner_principal
         AND launch.runner_instance = requested.runner_instance
         AND launch.channel_epoch = requested.channel_epoch
         AND launch.host_instance_id = requested.host_instance_id
         AND launch.terminal_epoch = requested.terminal_epoch
        "#,
    )
    .bind(serde_json::to_string(&[session()]).unwrap())
    .fetch_all(&mut plan_connection)
    .await
    .unwrap()
    .into_iter()
    .map(|row| row.get::<String, _>("detail"))
    .collect::<Vec<_>>();
    assert!(
        plan.iter()
            .any(|detail| detail.contains("workflow_dispatch_launches_active_session_idx")),
        "exact Session batch must use its persistent launch index: {plan:?}"
    );
    assert!(matches!(
        store
            .orchestration_dispatch_contexts_for_exact_sessions(&[])
            .await,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "sessions",
            ..
        })
    ));
    assert!(matches!(
        store
            .orchestration_dispatch_contexts_for_exact_sessions(&[session(), session()])
            .await,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "sessions",
            ..
        })
    ));
    let oversized = (0..=crate::MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS)
        .map(|index| {
            let mut value = session();
            value.session_id = format!("workflow-session-{index}");
            value
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        store
            .orchestration_dispatch_contexts_for_exact_sessions(&oversized)
            .await,
        Err(DomainStoreErrorV1::InvalidRecord {
            field: "sessions",
            ..
        })
    ));
    seed_orchestration_coordinator(&store).await;

    let first_created = store.create_delegate_once(&request()).await.unwrap();
    let first_bound = store
        .bind_delegate_once_session(&binding(&first_created))
        .await
        .unwrap();
    let first = record_prompt_written(&store, &first_bound).await;
    let first_context = bind_orchestration_context(&store, &first, "first", 1_600).await;
    complete_orchestration_context(&store, &first_context, "first", 1_700).await;

    let mut successor_request = request();
    successor_request.idempotency_key = "delegate-once-2".into();
    successor_request.created_at_ms = 2_000;
    let successor_created = store
        .create_delegate_once(&successor_request)
        .await
        .unwrap();
    let mut successor_binding = binding(&successor_created);
    successor_binding.effective_launch_idempotency_key = "workflow:effective-2".into();
    successor_binding.bound_at_ms = 2_100;
    let successor_bound = store
        .bind_delegate_once_session(&successor_binding)
        .await
        .unwrap();
    let successor = record_prompt_written_at(&store, &successor_bound, 2_110, 2_120).await;
    let successor_context =
        bind_orchestration_context(&store, &successor, "successor", 2_200).await;

    let exact_session = session();
    let mut unassigned = exact_session.clone();
    unassigned.session_id = "workflow-session-unassigned".into();
    let mut invalid = exact_session.clone();
    invalid.session_id.clear();
    let first_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(&[
            unassigned.clone(),
            invalid.clone(),
            exact_session.clone(),
        ])
        .await
        .unwrap();
    assert_eq!(
        first_batch
            .iter()
            .map(|item| item.session.clone())
            .collect::<Vec<_>>(),
        vec![unassigned, invalid, exact_session.clone()]
    );
    assert!(matches!(
        first_batch[0].resolution,
        OrchestrationDispatchContextResolutionV1::NoDispatch
    ));
    assert!(matches!(
        &first_batch[1].resolution,
        OrchestrationDispatchContextResolutionV1::DomainError(DomainStoreErrorV1::InvalidRecord {
            field: "session.sessionId",
            ..
        })
    ));
    let OrchestrationDispatchContextResolutionV1::Found(drainable) = &first_batch[2].resolution
    else {
        panic!("completed coordinator delivery must drain before its active successor");
    };
    assert_eq!(
        drainable.target.dispatch_id,
        first_context.target.dispatch_id
    );
    assert_eq!(drainable.dispatch_state, DispatchState::Completed);
    assert_eq!(
        drainable.as_ref(),
        &store
            .orchestration_dispatch_context_for_exact_session(
                &first.task_id,
                &first.dispatch_id,
                first.generation,
                &exact_session,
            )
            .await
            .unwrap()
    );

    let corrupted_event = sqlx::query(
        r#"
        SELECT authority_key, cursor, event_json
        FROM workflow_interaction_events
        WHERE json_valid(event_json) = 1
          AND json_extract(event_json, '$.target.dispatchId') = ?1
        ORDER BY cursor
        LIMIT 1
        "#,
    )
    .bind(first_context.target.dispatch_id.as_str())
    .fetch_one(&mut plan_connection)
    .await
    .unwrap();
    let corrupted_authority = corrupted_event.get::<String, _>("authority_key");
    let corrupted_cursor = corrupted_event.get::<i64, _>("cursor");
    let original_event = corrupted_event.get::<String, _>("event_json");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut plan_connection)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM workflow_interaction_events WHERE authority_key = ?1 AND cursor = ?2",
    )
    .bind(&corrupted_authority)
    .bind(corrupted_cursor)
    .execute(&mut plan_connection)
    .await
    .unwrap();
    assert_eq!(
        store
            .orchestration_target_for_exact_session(&exact_session)
            .await
            .unwrap(),
        first_context.target,
        "a missing event cannot discard its pending delivery in favor of a successor",
    );
    let missing_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(std::slice::from_ref(&exact_session))
        .await
        .unwrap();
    assert_eq!(missing_batch[0].resolution, first_batch[2].resolution);
    assert!(
        store
            .interaction_service()
            .read_events(coordinator_event_read(&first_context, EventCursor::BEGINNING))
            .await
            .is_err(),
        "context lookup must not fabricate the missing payload or acknowledge its delivery",
    );
    sqlx::query(
        "INSERT INTO workflow_interaction_events (authority_key, cursor, event_json) VALUES (?1, ?2, ?3)",
    )
    .bind(&corrupted_authority)
    .bind(corrupted_cursor)
    .bind(&original_event)
    .execute(&mut plan_connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut plan_connection)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE workflow_interaction_events SET event_json = '{' WHERE authority_key = ?1 AND cursor = ?2",
    )
    .bind(&corrupted_authority)
    .bind(corrupted_cursor)
    .execute(&mut plan_connection)
    .await
    .unwrap();
    let corrupted_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(std::slice::from_ref(&exact_session))
        .await
        .unwrap();
    assert!(matches!(
        &corrupted_batch[0].resolution,
        OrchestrationDispatchContextResolutionV1::DomainError(DomainStoreErrorV1::Storage {
            code: "corrupt_orchestration_context",
            ..
        })
    ));
    sqlx::query(
        "UPDATE workflow_interaction_events SET event_json = ?1 WHERE authority_key = ?2 AND cursor = ?3",
    )
    .bind(original_event)
    .bind(corrupted_authority)
    .bind(corrupted_cursor)
    .execute(&mut plan_connection)
    .await
    .unwrap();

    observe_coordinator_events(&store, &first_context).await;
    let original_grant: String = sqlx::query_scalar(
        "SELECT coordinator_grant_json FROM workflow_interaction_authorities WHERE dispatch_id = ?1",
    )
    .bind(first_context.target.dispatch_id.as_str())
    .fetch_one(&mut plan_connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_interaction_authorities SET coordinator_grant_json = '{' WHERE dispatch_id = ?1",
    )
    .bind(first_context.target.dispatch_id.as_str())
    .execute(&mut plan_connection)
    .await
    .unwrap();
    let observed_corrupt_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(std::slice::from_ref(&exact_session))
        .await
        .unwrap();
    assert!(matches!(
        &observed_corrupt_batch[0].resolution,
        OrchestrationDispatchContextResolutionV1::Found(context)
            if context.as_ref() == &successor_context
    ));
    assert_eq!(
        store
            .orchestration_target_for_exact_session(&exact_session)
            .await
            .unwrap(),
        successor_context.target
    );
    sqlx::query(
        "UPDATE workflow_interaction_authorities SET coordinator_grant_json = ?1 WHERE dispatch_id = ?2",
    )
    .bind(original_grant)
    .bind(first_context.target.dispatch_id.as_str())
    .execute(&mut plan_connection)
    .await
    .unwrap();
    let active_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(std::slice::from_ref(&exact_session))
        .await
        .unwrap();
    let OrchestrationDispatchContextResolutionV1::Found(active) = &active_batch[0].resolution
    else {
        panic!("active successor must follow the drained completed Dispatch");
    };
    assert_eq!(
        active.target.dispatch_id,
        successor_context.target.dispatch_id
    );
    assert_eq!(active.dispatch_state, DispatchState::Active);
    assert_eq!(active.as_ref(), &successor_context);

    complete_orchestration_context(&store, &successor_context, "successor", 2_300).await;
    observe_coordinator_events(&store, &successor_context).await;
    let completed_batch = store
        .orchestration_dispatch_contexts_for_exact_sessions(std::slice::from_ref(&exact_session))
        .await
        .unwrap();
    let OrchestrationDispatchContextResolutionV1::Found(completed) = &completed_batch[0].resolution
    else {
        panic!("latest completed Dispatch must remain resolvable after deliveries drain");
    };
    assert_eq!(
        completed.target.dispatch_id,
        successor_context.target.dispatch_id
    );
    assert_eq!(completed.dispatch_state, DispatchState::Completed);
    assert!(completed.successor_required);
    assert_eq!(
        completed.as_ref(),
        &store
            .orchestration_dispatch_context_for_exact_session(
                &successor.task_id,
                &successor.dispatch_id,
                successor.generation,
                &exact_session,
            )
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn exact_session_context_batch_scopes_event_faults_to_their_dispatch() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    seed_orchestration_coordinator(&store).await;

    let first_created = store.create_delegate_once(&request()).await.unwrap();
    let first_bound = store
        .bind_delegate_once_session(&binding(&first_created))
        .await
        .unwrap();
    let first = record_prompt_written(&store, &first_bound).await;
    let first_context = bind_orchestration_context(&store, &first, "fault-first", 1_800).await;
    complete_orchestration_context(&store, &first_context, "fault-first", 1_900).await;
    observe_coordinator_events(&store, &first_context).await;

    let mut second_request = request();
    second_request.idempotency_key = "delegate-once-event-fault-second".into();
    second_request.created_at_ms = 2_000;
    let second_created = store.create_delegate_once(&second_request).await.unwrap();
    let mut second_binding = binding(&second_created);
    second_binding.effective_launch_idempotency_key =
        "workflow:effective-event-fault-second".into();
    second_binding.bound_at_ms = 2_100;
    second_binding.session.session_id = "workflow-session-event-fault-second".into();
    second_binding.session.runner_instance = "instance-event-fault-second".into();
    second_binding.session.host_instance_id = "host-event-fault-second".into();
    second_binding.session.terminal_epoch = "terminal-event-fault-second".into();
    let second_session = second_binding.session.clone();
    let second_bound = store
        .bind_delegate_once_session(&second_binding)
        .await
        .unwrap();
    let second = record_prompt_written_at(&store, &second_bound, 2_110, 2_120).await;
    let second_context = bind_orchestration_context(&store, &second, "fault-second", 2_200).await;
    complete_orchestration_context(&store, &second_context, "fault-second", 2_300).await;

    let first_session = session();
    let first_scalar = store
        .orchestration_dispatch_context_for_exact_session(
            &first.task_id,
            &first.dispatch_id,
            first.generation,
            &first_session,
        )
        .await
        .unwrap();
    let second_scalar = store
        .orchestration_dispatch_context_for_exact_session(
            &second.task_id,
            &second.dispatch_id,
            second.generation,
            &second_session,
        )
        .await
        .unwrap();
    assert!(first_scalar.successor_required);

    let mut fault = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut fault)
        .await
        .unwrap();
    let event_rows = sqlx::query(
        r#"
        SELECT authority_key, cursor
        FROM workflow_interaction_events
        WHERE json_valid(event_json) = 1
          AND json_extract(event_json, '$.target.dispatchId') = ?1
        ORDER BY cursor
        "#,
    )
    .bind(second.dispatch_id.as_str())
    .fetch_all(&mut fault)
    .await
    .unwrap()
    .into_iter()
    .map(|row| {
        (
            row.get::<String, _>("authority_key"),
            row.get::<i64, _>("cursor"),
        )
    })
    .collect::<Vec<_>>();
    assert!(!event_rows.is_empty());
    sqlx::query(
        "DELETE FROM workflow_interaction_events WHERE json_valid(event_json) = 1 AND json_extract(event_json, '$.target.dispatchId') = ?1",
    )
    .bind(second.dispatch_id.as_str())
    .execute(&mut fault)
    .await
    .unwrap();

    let missing = store
        .orchestration_dispatch_contexts_for_exact_sessions(&[
            first_session.clone(),
            second_session.clone(),
        ])
        .await
        .unwrap();
    assert!(matches!(
        &missing[0].resolution,
        OrchestrationDispatchContextResolutionV1::Found(context)
            if context.as_ref() == &first_scalar
    ));
    assert!(!second_scalar.successor_required);
    assert_eq!(
        missing[1].resolution,
        OrchestrationDispatchContextResolutionV1::Found(Box::new(second_scalar.clone())),
    );
    assert_eq!(
        store
            .orchestration_dispatch_context_for_exact_session(
                &second.task_id,
                &second.dispatch_id,
                second.generation,
                &second_session,
            )
            .await
            .unwrap(),
        second_scalar,
    );

    for (authority_key, cursor) in &event_rows {
        sqlx::query(
            "INSERT INTO workflow_interaction_events (authority_key, cursor, event_json) VALUES (?1, ?2, '{')",
        )
        .bind(authority_key)
        .bind(cursor)
        .execute(&mut fault)
        .await
        .unwrap();
    }
    let invalid = store
        .orchestration_dispatch_contexts_for_exact_sessions(&[
            first_session.clone(),
            second_session.clone(),
        ])
        .await
        .unwrap();
    assert!(matches!(
        &invalid[0].resolution,
        OrchestrationDispatchContextResolutionV1::Found(context)
            if context.as_ref() == &first_scalar
    ));
    assert!(matches!(
        &invalid[1].resolution,
        OrchestrationDispatchContextResolutionV1::DomainError(DomainStoreErrorV1::Storage {
            code: "corrupt_orchestration_context",
            ..
        })
    ));

    for (authority_key, cursor) in &event_rows {
        sqlx::query(
            "UPDATE workflow_interaction_deliveries SET delivery_json = '{' WHERE authority_key = ?1 AND event_cursor = ?2",
        )
        .bind(authority_key)
        .bind(cursor)
        .execute(&mut fault)
        .await
        .unwrap();
    }
    for candidate in [&first_session, &second_session] {
        assert!(matches!(
            store
                .orchestration_target_for_exact_session(candidate)
                .await,
            Err(DomainStoreErrorV1::Storage { .. })
        ));
    }
    let double_corrupt = store
        .orchestration_dispatch_contexts_for_exact_sessions(&[
            first_session.clone(),
            second_session.clone(),
        ])
        .await
        .unwrap();
    assert!(matches!(
        &double_corrupt[0].resolution,
        OrchestrationDispatchContextResolutionV1::DomainError(DomainStoreErrorV1::Storage {
            code: "corrupt_orchestration_context",
            ..
        })
    ));
    assert!(matches!(
        &double_corrupt[1].resolution,
        OrchestrationDispatchContextResolutionV1::DomainError(DomainStoreErrorV1::Storage {
            code: "corrupt_orchestration_context",
            ..
        })
    ));
    for (authority_key, cursor) in &event_rows {
        sqlx::query(
            "DELETE FROM workflow_interaction_events WHERE authority_key = ?1 AND cursor = ?2",
        )
        .bind(authority_key)
        .bind(cursor)
        .execute(&mut fault)
        .await
        .unwrap();
    }
    let missing_with_corrupt_delivery = store
        .orchestration_dispatch_contexts_for_exact_sessions(&[first_session, second_session])
        .await
        .unwrap();
    assert_eq!(missing_with_corrupt_delivery, double_corrupt);
}

#[tokio::test]
async fn schema_36_adds_the_active_exact_session_launch_index() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    sqlx::query("DROP INDEX workflow_dispatch_launches_active_session_idx")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 36, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    let index_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'workflow_dispatch_launches_active_session_idx'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(index_count, 1);
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn create_is_atomic_idempotent_and_survives_reopen() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let first = store.create_delegate_once(&request()).await.unwrap();
    assert_eq!(first.status, WorkflowDispatchStateV1::Starting);

    for table in [
        "workflow_runs",
        "workflow_tasks",
        "workflow_dispatches",
        "workflow_dispatch_launches",
        "workflow_delegate_once_receipts",
    ] {
        let query = format!("SELECT COUNT(*) FROM {table}");
        let count: i64 = sqlx::query_scalar(&query)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "{table}");
    }
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.create_delegate_once(&request()).await.unwrap(),
        first
    );
    assert_eq!(
        reopened
            .delegate_once_receipt("delegate-once-1")
            .await
            .unwrap(),
        Some(first)
    );

    let mut conflict = request();
    conflict.task.summary = "A different task".into();
    assert!(matches!(
        reopened.create_delegate_once(&conflict).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn exact_dispatch_receipt_reads_the_active_generation_without_mutation() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    assert_eq!(
        store
            .delegate_once_receipt_for_dispatch(
                &active.task_id,
                &active.dispatch_id,
                active.generation,
            )
            .await
            .unwrap(),
        active
    );

    let mismatched_task = dure_app::TaskIdV1::new("task.replacement").unwrap();
    assert!(matches!(
        store
            .delegate_once_receipt_for_dispatch(
                &mismatched_task,
                &active.dispatch_id,
                active.generation,
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_dispatch_fence",
            ..
        })
    ));
    assert!(matches!(
        store
            .delegate_once_receipt_for_dispatch(
                &active.task_id,
                &active.dispatch_id,
                active.generation + 1,
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_dispatch_fence",
            ..
        })
    ));
    let missing_dispatch = dure_app::DispatchIdV1::new("dispatch.missing").unwrap();
    assert!(matches!(
        store
            .delegate_once_receipt_for_dispatch(
                &active.task_id,
                &missing_dispatch,
                active.generation,
            )
            .await,
        Err(DomainStoreErrorV1::NotFound {
            entity: "workflow_dispatch",
            ..
        })
    ));
}

#[tokio::test]
async fn schema_32_backfills_only_prepared_pty_launches() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();

    let pty_created = store.create_delegate_once(&request()).await.unwrap();
    let mut durable_request = request();
    durable_request.idempotency_key = "delegate-once-durable-fixture".into();
    durable_request.task.summary = "Durable migration fixture".into();
    let durable_created = store.create_delegate_once(&durable_request).await.unwrap();
    for created in [&pty_created, &durable_created] {
        let mut prepared_session = session();
        prepared_session.session_id = workflow_prepared_session_id(&created.dispatch_id).unwrap();
        store
            .bind_delegate_once_session(&DelegateOnceSessionBindingRequestV1 {
                schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                task_id: created.task_id.clone(),
                dispatch_id: created.dispatch_id.clone(),
                generation: created.generation,
                launch_idempotency_key: created.launch_idempotency_key.clone(),
                effective_launch_idempotency_key: created.launch_idempotency_key.clone(),
                session: prepared_session,
                bound_at_ms: 1_500,
            })
            .await
            .unwrap();
    }
    sqlx::query(
        r#"
        UPDATE workflow_dispatch_launches
        SET delivery_mode = 'durable_inbox',
            prompt_delivery_idempotency_key = NULL,
            prompt_delivery_state = NULL,
            prompt_delivery_evidence_json = NULL,
            prompt_delivery_error_code = NULL
        WHERE dispatch_id = ?1
        "#,
    )
    .bind(durable_created.dispatch_id.as_str())
    .execute(&store.pool)
    .await
    .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 32, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT delivery_mode, effective_launch_idempotency_key FROM workflow_dispatch_launches ORDER BY delivery_mode",
    )
    .fetch_all(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("durable_inbox".into(), None),
            (
                "pty_prompt".into(),
                Some(pty_created.launch_idempotency_key)
            ),
        ]
    );
}

#[tokio::test]
async fn dispatch_stop_only_schema_33_converges_to_effective_launch_identity() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let mut prepared_binding = binding(&created);
    prepared_binding.session.session_id =
        workflow_prepared_session_id(&created.dispatch_id).unwrap();
    prepared_binding.effective_launch_idempotency_key = created.launch_idempotency_key.clone();
    store
        .bind_delegate_once_session(&prepared_binding)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::downgrade_dispatch_stop_fixture_to_v33(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 33, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
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
    let effective_launch_idempotency_key: Option<String> = sqlx::query_scalar(
        "SELECT effective_launch_idempotency_key FROM workflow_dispatch_launches WHERE dispatch_id = ?1",
    )
    .bind(created.dispatch_id.as_str())
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(
        effective_launch_idempotency_key,
        Some(created.launch_idempotency_key)
    );
}

#[tokio::test]
async fn schema_35_adds_effective_launch_identity_for_existing_store() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let mut prepared_binding = binding(&created);
    prepared_binding.session.session_id =
        workflow_prepared_session_id(&created.dispatch_id).unwrap();
    prepared_binding.effective_launch_idempotency_key = created.launch_idempotency_key.clone();
    store
        .bind_delegate_once_session(&prepared_binding)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 35, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION,
    );
    let receipt = migrated
        .delegate_once_receipt("delegate-once-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.effective_launch_idempotency_key,
        Some(created.launch_idempotency_key),
    );
}

#[tokio::test]
async fn dispatch_insert_failure_rolls_back_the_whole_creation() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_workflow_dispatch
        BEFORE INSERT ON workflow_dispatches
        BEGIN
            SELECT RAISE(ABORT, 'injected dispatch failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store.create_delegate_once(&request()).await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    for table in [
        "workflow_runs",
        "workflow_tasks",
        "workflow_dispatches",
        "workflow_dispatch_launches",
        "workflow_delegate_once_receipts",
    ] {
        let query = format!("SELECT COUNT(*) FROM {table}");
        let count: i64 = sqlx::query_scalar(&query)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}

#[tokio::test]
async fn prompt_delivery_claim_survives_restart_and_never_returns_to_pending() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    let claim = prompt_claim(&active);
    let (left, right) = tokio::join!(
        store.claim_delegate_once_prompt(&claim),
        store.claim_delegate_once_prompt(&claim)
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(usize::from(left.claimed) + usize::from(right.claimed), 1);
    assert_eq!(left.receipt, right.receipt);
    let uncertain = left.receipt;
    assert_eq!(
        uncertain.prompt_delivery.as_ref().unwrap().state,
        WorkflowPromptDeliveryStateV1::Uncertain
    );
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let replayed_claim = reopened.claim_delegate_once_prompt(&claim).await.unwrap();
    assert!(!replayed_claim.claimed);
    assert_eq!(replayed_claim.receipt, uncertain);
    let written = reopened
        .record_delegate_once_prompt_outcome(&prompt_outcome(&uncertain))
        .await
        .unwrap();
    assert_eq!(
        written.prompt_delivery.as_ref().unwrap().state,
        WorkflowPromptDeliveryStateV1::WrittenToPty
    );
    assert_eq!(
        reopened
            .record_delegate_once_prompt_outcome(&prompt_outcome(&written))
            .await
            .unwrap(),
        written
    );
    let terminal_claim = reopened.claim_delegate_once_prompt(&claim).await.unwrap();
    assert!(!terminal_claim.claimed);
    assert_eq!(terminal_claim.receipt, written);
}

#[tokio::test]
async fn prompt_activity_converges_to_positive_evidence_and_survives_restart() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    let written = record_prompt_written(&store, &active).await;
    let stalled = prompt_activity(
        &written,
        WorkflowPromptActivityStateV1::Stalled,
        "8",
        Some("workflow_prompt_stalled"),
        1_800,
    );
    let observed = prompt_activity(
        &written,
        WorkflowPromptActivityStateV1::Observed,
        "9",
        None,
        1_800,
    );
    let (left, right) = tokio::join!(
        store.record_delegate_once_prompt_activity(&stalled),
        store.record_delegate_once_prompt_activity(&observed)
    );
    left.unwrap();
    right.unwrap();
    let converged = store
        .delegate_once_receipt("delegate-once-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        converged
            .prompt_delivery
            .as_ref()
            .unwrap()
            .evidence
            .as_ref()
            .unwrap()
            .activity()
            .unwrap(),
        &observed.activity
    );
    assert_eq!(
        store
            .record_delegate_once_prompt_outcome(&prompt_outcome(&converged))
            .await
            .unwrap(),
        converged
    );
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .delegate_once_receipt("delegate-once-1")
            .await
            .unwrap()
            .unwrap(),
        converged
    );
    let older_failure = prompt_activity(
        &converged,
        WorkflowPromptActivityStateV1::Failed,
        "9",
        Some("workflow_prompt_provider_exited"),
        1_700,
    );
    assert_eq!(
        reopened
            .record_delegate_once_prompt_activity(&older_failure)
            .await
            .unwrap(),
        converged
    );

    let mut stale = observed;
    stale.session.terminal_epoch = "replacement-terminal".into();
    assert!(matches!(
        reopened.record_delegate_once_prompt_activity(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_prompt_delivery_fence",
            ..
        })
    ));
}

#[tokio::test]
async fn v15_prompt_receipt_migrates_before_activity_is_added() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    let mut written = record_prompt_written(&store, &active).await;
    let legacy_evidence =
        WorkflowPromptDeliveryEvidenceV1::legacy_controller("4", "8", "body-1", "submit-1", "3");
    sqlx::query(
        "UPDATE workflow_dispatch_launches SET prompt_delivery_evidence_json = ?1 WHERE dispatch_id = ?2",
    )
    .bind(serde_json::to_string(&legacy_evidence).unwrap())
    .bind(written.dispatch_id.as_str())
    .execute(&store.pool)
    .await
    .unwrap();
    written.prompt_delivery.as_mut().unwrap().evidence = Some(legacy_evidence);
    store.close().await;

    let mut previous = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    sqlx::query("ALTER TABLE workflow_dispatches DROP COLUMN completion_result")
        .execute(&mut previous)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&mut previous)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut previous).await;
    sqlx::query("UPDATE store_metadata SET schema_version = 15 WHERE singleton = 1")
        .execute(&mut previous)
        .await
        .unwrap();
    previous.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let mut migrated_written = written.clone();
    migrated_written.effective_launch_idempotency_key = None;
    assert_eq!(
        migrated
            .delegate_once_receipt("delegate-once-1")
            .await
            .unwrap()
            .unwrap(),
        migrated_written
    );
    let observed = migrated
        .record_delegate_once_prompt_activity(&prompt_activity(
            &migrated_written,
            WorkflowPromptActivityStateV1::Observed,
            "9",
            None,
            1_800,
        ))
        .await
        .unwrap();
    assert_eq!(
        observed
            .prompt_delivery
            .unwrap()
            .evidence
            .unwrap()
            .activity()
            .unwrap()
            .state,
        WorkflowPromptActivityStateV1::Observed
    );
}

#[tokio::test]
async fn schema_seventeen_migrates_additively_to_durable_orchestration_store() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store.close().await;

    let mut previous = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    for table in [
        "workflow_interaction_deliveries",
        "workflow_interaction_events",
        "workflow_interaction_idempotency",
        "workflow_interaction_acknowledgements",
        "workflow_interaction_cursors",
        "workflow_interactions",
        "workflow_interaction_authorities",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut previous)
            .await
            .unwrap();
    }
    downgrade_workflow_launch_fixture_to_v31(&mut previous)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut previous).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 17, min_reader_version = 17, min_writer_version = 17 WHERE singleton = 1",
    )
    .execute(&mut previous)
    .await
    .unwrap();
    previous.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    for table in [
        "workflow_interaction_authorities",
        "workflow_interactions",
        "workflow_interaction_events",
        "workflow_interaction_deliveries",
        "workflow_interaction_idempotency",
        "workflow_interaction_acknowledgements",
        "workflow_interaction_cursors",
    ] {
        let definition: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
                .bind(table)
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert!(
            definition.contains("WITHOUT ROWID"),
            "{table} must not expose an implicit SQLite row identity"
        );
    }
    let interactions_definition: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_interactions'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert!(
        interactions_definition.contains("FOREIGN KEY (authority_key, dispatch_id)")
            && interactions_definition.contains(
                "REFERENCES workflow_interaction_authorities(authority_key, dispatch_id)",
            ),
        "interaction rows must remain inside their canonical Workspace/Tenant authority"
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn prompt_outcome_requires_exact_session_and_valid_evidence() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&created))
        .await
        .unwrap();
    let uncertain = store
        .claim_delegate_once_prompt(&prompt_claim(&active))
        .await
        .unwrap()
        .receipt;
    let mut stale = prompt_outcome(&uncertain);
    stale.session.terminal_epoch = "replacement-terminal".into();
    assert!(matches!(
        store.record_delegate_once_prompt_outcome(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_prompt_delivery_fence",
            ..
        })
    ));

    sqlx::query(
        "UPDATE workflow_dispatch_launches SET prompt_delivery_state = 'written_to_pty', prompt_delivery_evidence_json = '{}' WHERE dispatch_id = ?1",
    )
    .bind(created.dispatch_id.as_str())
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.delegate_once_receipt("delegate-once-1").await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_workflow_prompt_evidence",
            ..
        })
    ));
}

#[tokio::test]
async fn terminal_start_failure_is_typed_idempotent_and_cannot_bind() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let failure = DelegateOnceStartFailureRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: created.task_id.clone(),
        dispatch_id: created.dispatch_id.clone(),
        generation: created.generation,
        launch_idempotency_key: created.launch_idempotency_key.clone(),
        error_code: "hmux_managed_create_refused".into(),
        failed_at_ms: 1_400,
    };
    let failed = store.fail_delegate_once_start(&failure).await.unwrap();
    assert_eq!(failed.status, WorkflowDispatchStateV1::StartFailed);
    assert_eq!(
        failed.start_error_code.as_deref(),
        Some("hmux_managed_create_refused")
    );
    assert_eq!(
        store.fail_delegate_once_start(&failure).await.unwrap(),
        failed
    );

    let mut different = failure.clone();
    different.error_code = "provider_unavailable".into();
    assert!(matches!(
        store.fail_delegate_once_start(&different).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_start_failure",
            ..
        })
    ));
    assert!(matches!(
        store.bind_delegate_once_session(&binding(&created)).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_dispatch_launch",
            ..
        })
    ));
}

#[tokio::test]
async fn binding_storage_failure_leaves_the_launch_starting() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_workflow_binding
        BEFORE UPDATE ON workflow_dispatch_launches
        WHEN NEW.state = 'active'
        BEGIN
            SELECT RAISE(ABORT, 'injected binding failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store.bind_delegate_once_session(&binding(&created)).await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    assert_eq!(
        store
            .delegate_once_receipt("delegate-once-1")
            .await
            .unwrap()
            .unwrap()
            .status,
        WorkflowDispatchStateV1::Starting
    );
}

#[tokio::test]
async fn missing_linked_records_fail_closed() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    let mut connection = store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM workflow_dispatches WHERE dispatch_id = ?1")
        .bind(created.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert!(matches!(
        store.delegate_once_receipt("delegate-once-1").await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_workflow_link",
            ..
        })
    ));
}

#[tokio::test]
async fn missing_launch_receipt_fails_closed() {
    let root = tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let created = store.create_delegate_once(&request()).await.unwrap();
    sqlx::query("DELETE FROM workflow_dispatch_launches WHERE dispatch_id = ?1")
        .bind(created.dispatch_id.as_str())
        .execute(&store.pool)
        .await
        .unwrap();

    assert!(matches!(
        store.delegate_once_receipt("delegate-once-1").await,
        Err(DomainStoreErrorV1::Storage {
            code: "corrupt_workflow_link",
            ..
        })
    ));
}

#[tokio::test]
async fn previous_schema_migrates_before_workflow_records_are_visible() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    execute_statements(&mut connection, V12_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO store_metadata (singleton, schema_version, min_reader_version, min_writer_version) VALUES (1, 12, 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        store.create_delegate_once(&request()).await.unwrap().status,
        WorkflowDispatchStateV1::Starting
    );
}

#[tokio::test]
async fn v13_workflow_records_gain_a_deterministic_launch_receipt() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    execute_statements(&mut connection, V13_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO store_metadata (singleton, schema_version, min_reader_version, min_writer_version) VALUES (1, 13, 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    let input = request();
    let prepared = prepare_delegate_once(&input).unwrap();
    sqlx::query(
        "INSERT INTO workflow_runs (run_id, contribution_id, coordinator_agent_id, coordinator_session_id, coordinator_binding_generation, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(prepared.receipt.run_id.as_str())
    .bind(input.contribution_id.as_str())
    .bind(input.coordinator.agent_id.as_str())
    .bind(&input.coordinator.session_id)
    .bind(input.coordinator.binding_generation)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_tasks (task_id, run_id, schema_version, summary, instructions, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, 1, ?3, ?4, 'dispatched', ?5, ?5)",
    )
    .bind(prepared.receipt.task_id.as_str())
    .bind(prepared.receipt.run_id.as_str())
    .bind(&input.task.summary)
    .bind(&input.task.instructions)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_dispatches (dispatch_id, task_id, provider_id, runtime_kind_id, target_reference, generation, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'starting', ?6, ?6)",
    )
    .bind(prepared.receipt.dispatch_id.as_str())
    .bind(prepared.receipt.task_id.as_str())
    .bind(input.provider_id.as_str())
    .bind(input.runtime_kind_id.as_str())
    .bind(&input.target_reference)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_delegate_once_receipts (idempotency_key, request_digest, run_id, task_id, dispatch_id) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&input.idempotency_key)
    .bind(&prepared.request_digest)
    .bind(prepared.receipt.run_id.as_str())
    .bind(prepared.receipt.task_id.as_str())
    .bind(prepared.receipt.dispatch_id.as_str())
    .execute(&mut connection)
    .await
    .unwrap();
    for statement in [
        "INSERT INTO workflow_runs (run_id, contribution_id, coordinator_agent_id, coordinator_session_id, coordinator_binding_generation, created_at_ms) VALUES ('run.legacy-completed', 'dure.core.delegate-once', 'agent-legacy', 'session-legacy', 1, 1000)",
        "INSERT INTO workflow_tasks (task_id, run_id, schema_version, summary, instructions, state, created_at_ms, updated_at_ms) VALUES ('task.legacy-completed', 'run.legacy-completed', 1, 'Legacy task', 'Legacy instructions', 'completed', 1000, 2000)",
        "INSERT INTO workflow_dispatches (dispatch_id, task_id, provider_id, runtime_kind_id, target_reference, generation, state, created_at_ms, updated_at_ms) VALUES ('dispatch.legacy-completed', 'task.legacy-completed', 'codex', 'runtime.hmux', 'backend-profile:local', 1, 'completed', 1000, 2000)",
        "INSERT INTO workflow_delegate_once_receipts (idempotency_key, request_digest, run_id, task_id, dispatch_id) VALUES ('legacy-completed', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'run.legacy-completed', 'task.legacy-completed', 'dispatch.legacy-completed')",
    ] {
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .unwrap();
    }
    connection.close().await.unwrap();

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let migrated = store
        .delegate_once_receipt(&input.idempotency_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(migrated.status, WorkflowDispatchStateV1::Starting);
    assert_eq!(
        migrated.launch_idempotency_key,
        format!("workflow:{}", prepared.receipt.dispatch_id)
    );
    let legacy = store
        .delegate_once_receipt("legacy-completed")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(legacy.status, WorkflowDispatchStateV1::StartFailed);
    assert_eq!(
        legacy.start_error_code.as_deref(),
        Some("legacy_session_generation_unavailable")
    );
}

#[tokio::test]
async fn v14_active_launches_migrate_to_uncertain_without_prompt_replay() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    execute_statements(&mut connection, V14_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO store_metadata (singleton, schema_version, min_reader_version, min_writer_version) VALUES (1, 14, 1, 1)",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    let input = request();
    let prepared = prepare_delegate_once(&input).unwrap();
    sqlx::query(
        "INSERT INTO workflow_runs (run_id, contribution_id, coordinator_agent_id, coordinator_session_id, coordinator_binding_generation, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(prepared.receipt.run_id.as_str())
    .bind(input.contribution_id.as_str())
    .bind(input.coordinator.agent_id.as_str())
    .bind(&input.coordinator.session_id)
    .bind(input.coordinator.binding_generation)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_tasks (task_id, run_id, schema_version, summary, instructions, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, 1, ?3, ?4, 'dispatched', ?5, 1500)",
    )
    .bind(prepared.receipt.task_id.as_str())
    .bind(prepared.receipt.run_id.as_str())
    .bind(&input.task.summary)
    .bind(&input.task.instructions)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_dispatches (dispatch_id, task_id, provider_id, runtime_kind_id, target_reference, generation, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'starting', ?6, 1500)",
    )
    .bind(prepared.receipt.dispatch_id.as_str())
    .bind(prepared.receipt.task_id.as_str())
    .bind(input.provider_id.as_str())
    .bind(input.runtime_kind_id.as_str())
    .bind(&input.target_reference)
    .bind(input.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_delegate_once_receipts (idempotency_key, request_digest, run_id, task_id, dispatch_id) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&input.idempotency_key)
    .bind(&prepared.request_digest)
    .bind(prepared.receipt.run_id.as_str())
    .bind(prepared.receipt.task_id.as_str())
    .bind(prepared.receipt.dispatch_id.as_str())
    .execute(&mut connection)
    .await
    .unwrap();
    let exact = session();
    sqlx::query(
        "INSERT INTO workflow_dispatch_launches (dispatch_id, launch_idempotency_key, state, session_id, workspace_id, provider_id, runner_principal, runner_instance, channel_epoch, host_instance_id, terminal_epoch, updated_at_ms) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1500)",
    )
    .bind(prepared.receipt.dispatch_id.as_str())
    .bind(&prepared.receipt.launch_idempotency_key)
    .bind(&exact.session_id)
    .bind(&exact.workspace_id)
    .bind(exact.provider_id.as_str())
    .bind(&exact.runner_principal)
    .bind(&exact.runner_instance)
    .bind(&exact.channel_epoch)
    .bind(&exact.host_instance_id)
    .bind(&exact.terminal_epoch)
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let migrated = store
        .delegate_once_receipt(&input.idempotency_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(migrated.status, WorkflowDispatchStateV1::Active);
    assert_eq!(migrated.session, Some(exact));
    assert_eq!(
        migrated.prompt_delivery.as_ref().unwrap().state,
        WorkflowPromptDeliveryStateV1::Uncertain
    );
    let delivery_mode: String = sqlx::query_scalar(
        "SELECT delivery_mode FROM workflow_dispatch_launches WHERE dispatch_id = ?1",
    )
    .bind(prepared.receipt.dispatch_id.as_str())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(delivery_mode, "pty_prompt");
    assert_eq!(store.create_delegate_once(&input).await.unwrap(), migrated);
}
