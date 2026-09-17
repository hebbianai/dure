use super::*;
use dure_app::{AgentRuntimeRequestOutcomeV1, AgentRuntimeRequestReceiptV1};

#[tokio::test]
async fn unchanged_requests_bind_once_without_admitting_a_transition() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selection = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let authority = native_authority();
    let peer = SqliteDomainStore::open(database_path(&root)).await.unwrap();
    let (a, b) = tokio::join!(
        store.record_agent_runtime_unchanged_request(
            "unchanged",
            "fingerprint-1",
            &selection,
            &authority
        ),
        peer.record_agent_runtime_unchanged_request(
            "unchanged",
            "fingerprint-1",
            &selection,
            &authority
        ),
    );
    let receipt = a.unwrap();
    assert_eq!(receipt, b.unwrap());
    assert_eq!(
        store
            .agent_runtime_selection(&selection.agent_id)
            .await
            .unwrap(),
        Some(selection.clone())
    );
    assert!(
        store
            .active_agent_runtime_transition(&selection.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let reopened = SqliteDomainStore::open(database_path(&root)).await.unwrap();
    assert_eq!(
        reopened
            .agent_runtime_request_receipt("unchanged")
            .await
            .unwrap(),
        Some(receipt)
    );
    assert!(matches!(
        reopened
            .record_agent_runtime_unchanged_request(
                "unchanged",
                "different-body",
                &selection,
                &authority
            )
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(matches!(
        reopened
            .admit_agent_runtime_transition(&intent("cannot-reuse-unchanged", "unchanged"))
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn unchanged_request_cannot_claim_an_admitted_request_key() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selection = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("already-admitted", "already-admitted-key");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    assert!(matches!(
        store
            .record_agent_runtime_unchanged_request(
                &plan.idempotency_key,
                "fingerprint",
                &selection,
                &native_authority()
            )
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(
        store
            .record_agent_runtime_unchanged_request(
                "new-key",
                "fingerprint",
                &selection,
                &native_authority()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .agent_runtime_request_receipt("new-key")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn v39_resume_requests_migrate_without_changing_the_runtime_journal() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("legacy-transition", "legacy-transition-key");
    let original = store.admit_agent_runtime_transition(&plan).await.unwrap();
    sqlx::query("UPDATE agent_runtime_transitions SET record_json = json_set(record_json, '$.resumeRequests', json(?1)) WHERE operation_id = ?2")
        .bind(r#"{"legacy-resume-key":"legacy-fingerprint"}"#)
        .bind(plan.operation_id.as_str())
        .execute(&store.pool).await.unwrap();
    sqlx::query("DROP TABLE agent_runtime_transition_requests")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 39")
        .execute(&store.pool)
        .await
        .unwrap();
    store.pool.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .agent_runtime_request_receipt("legacy-resume-key")
            .await
            .unwrap(),
        Some(AgentRuntimeRequestReceiptV1 {
            fingerprint: "legacy-fingerprint".into(),
            outcome: AgentRuntimeRequestOutcomeV1::Transition {
                operation_id: plan.operation_id.clone()
            },
        })
    );
    assert_eq!(
        reopened
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        reopened
            .resume_agent_runtime_transition(
                &plan.operation_id,
                "legacy-resume-key",
                "legacy-fingerprint"
            )
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(original)
    );
    assert!(matches!(
        reopened
            .resume_agent_runtime_transition(
                &plan.operation_id,
                "legacy-resume-key",
                "different-body"
            )
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    reopened.pool.close().await;
    let twice = SqliteDomainStore::open(&path).await.unwrap();
    assert!(
        twice
            .agent_runtime_request_receipt("legacy-resume-key")
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn concurrent_resume_requests_bind_once_and_survive_source_retention() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-resume", "transition-resume-key");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    let peer = SqliteDomainStore::open(database_path(&root)).await.unwrap();
    let (a, b) = tokio::join!(
        store.resume_agent_runtime_transition(
            &plan.operation_id,
            "request-resume",
            "fingerprint-1"
        ),
        peer.resume_agent_runtime_transition(&plan.operation_id, "request-resume", "fingerprint-1"),
    );
    let outcomes = [a.unwrap(), b.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_)
            ))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                AgentRuntimeTransitionEffectAuthorizationV1::Replayed(_)
            ))
            .count(),
        1
    );
    let retained = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
            120,
        ))
        .await
        .unwrap();
    let reopened = SqliteDomainStore::open(database_path(&root)).await.unwrap();
    assert_eq!(
        reopened
            .agent_runtime_transition_by_idempotency_key("request-resume")
            .await
            .unwrap(),
        Some(retained.clone())
    );
    assert_eq!(
        reopened
            .resume_agent_runtime_transition(&plan.operation_id, "request-resume", "fingerprint-1")
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(retained)
    );
    assert!(matches!(
        reopened
            .resume_agent_runtime_transition(&plan.operation_id, "request-resume", "fingerprint-2")
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(
        reopened
            .resume_agent_runtime_transition(
                &plan.operation_id,
                "request-after-retention",
                "fingerprint-1"
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn resume_request_cannot_be_reassigned_to_a_new_transition() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-first", "transition-first-key");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .resume_agent_runtime_transition(&plan.operation_id, "request-resume", "fingerprint-1")
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
            120,
        ))
        .await
        .unwrap();
    let replacement = intent("transition-next", "transition-next-key");
    store
        .admit_agent_runtime_transition(&replacement)
        .await
        .unwrap();
    assert!(matches!(
        store
            .resume_agent_runtime_transition(
                &replacement.operation_id,
                "request-resume",
                "fingerprint-1"
            )
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    let mut conflicting = intent("transition-third", "request-resume");
    conflicting.requested_at_ms += 1;
    assert!(matches!(
        store.admit_agent_runtime_transition(&conflicting).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(matches!(
        store
            .resume_agent_runtime_transition(
                &replacement.operation_id,
                &plan.idempotency_key,
                "fingerprint-1"
            )
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    assert!(
        store
            .agent_runtime_request_receipt(&replacement.idempotency_key)
            .await
            .unwrap()
            .is_none()
    );
}
