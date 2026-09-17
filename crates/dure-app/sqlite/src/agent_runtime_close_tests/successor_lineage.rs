use super::*;
use dure_app::{AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1};

async fn failed_successor(store: &SqliteDomainStore) -> AgentRuntimeTransitionRecordV1 {
    let close = store
        .admit_agent_runtime_close(&close_intent())
        .await
        .unwrap();
    store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: close.intent.operation_id.clone(),
            expected_journal_revision: close.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    let mut intent = transition_intent();
    intent.target_interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    intent.requested_at_ms = 130;
    let resumed = store.admit_agent_runtime_transition(&intent).await.unwrap();
    assert_eq!(resumed.state, AgentRuntimeTransitionStateV1::SourceStopped);
    assert_eq!(
        resumed.predecessor_operation_id,
        Some(close.intent.operation_id)
    );
    park(store, &resumed, 140).await
}

async fn park(
    store: &SqliteDomainStore,
    transition: &AgentRuntimeTransitionRecordV1,
    at_ms: i64,
) -> AgentRuntimeTransitionRecordV1 {
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: transition.intent.operation_id.clone(),
            expected_journal_revision: transition.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
                    "fixture_target_unavailable",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            advanced_at_ms: at_ms,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn stopped_close_allows_exact_repair_of_its_failed_successor() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let parked = failed_successor(&store).await;
    let request = AgentRuntimeTransitionRepairRequestV1 {
        schema_version: 1,
        operation_id: parked.intent.operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        repair_operation_id: OperationIdV1::new("repair-stopped-close-successor").unwrap(),
        repaired_at_ms: 150,
    };
    let result = store
        .authorize_agent_runtime_transition_repair(&request)
        .await;
    assert!(
        matches!(
            result,
            Ok(AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_))
        ),
        "the stopped close must not veto its own successor repair: {result:?}"
    );
    assert!(matches!(
        store
            .authorize_agent_runtime_transition_repair(&request)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(_)
    ));
}

#[tokio::test]
async fn stopped_close_successor_can_publish_its_replacement_binding() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let parked = failed_successor(&store).await;
    let source = binding();
    let replacement = AgentRuntimeReplacementV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: source.interaction_session_id.clone(),
        expected_binding_revision: source.binding_revision,
        source: source.runtime.clone(),
        source_execution_profile: source.execution_profile.clone(),
        target: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-successor".into(),
            provider_epoch: "provider-successor".into(),
        },
        target_execution_profile: parked.intent.target_execution_profile.clone(),
        provider_conversation_ref: source.provider_conversation_ref.clone(),
        replaced_at_ms: 160,
    };
    assert!(
        matches!(
            store.replace_agent_interaction_runtime(&replacement).await,
            Err(DomainStoreErrorV1::IdentityConflict { .. })
        ),
        "a parked failure must not publish without an explicit next attempt"
    );
    store
        .authorize_agent_runtime_transition_repair(&AgentRuntimeTransitionRepairRequestV1 {
            schema_version: 1,
            operation_id: parked.intent.operation_id.clone(),
            expected_journal_revision: parked.journal_revision,
            repair_operation_id: OperationIdV1::new("repair-binding-after-close").unwrap(),
            repaired_at_ms: 150,
        })
        .await
        .unwrap();
    let result = store.replace_agent_interaction_runtime(&replacement).await;
    assert!(
        result.is_ok(),
        "the admitted successor must publish its binding: {result:?}"
    );
    assert_eq!(
        store
            .replace_agent_interaction_runtime(&replacement)
            .await
            .unwrap(),
        result.unwrap()
    );
    for runtime in [source.runtime, replacement.target] {
        assert!(matches!(
            store
                .record_agent_turn_intent(&AgentStartTurnIntentV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: source.interaction_session_id.clone(),
                    runtime,
                    turn_id: AgentTurnIdV1::new("closed-source-turn").unwrap(),
                    client_message_id: AgentClientMessageIdV1::new("closed-source-message")
                        .unwrap(),
                    input: "input remains fenced until selection commit".into(),
                    requested_at_ms: 170,
                })
                .await,
            Err(DomainStoreErrorV1::IdentityConflict {
                entity: "agent runtime close",
                ..
            })
        ));
    }
}

#[tokio::test]
async fn stopped_close_allows_unchanged_and_corrected_successor_chains() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let mut parked = failed_successor(&store).await;
    for step in 0..2 {
        let mut successor = parked.intent.clone();
        successor.operation_id = OperationIdV1::new(format!("replacement-{step}")).unwrap();
        successor.idempotency_key = format!("replacement-{step}");
        successor.requested_at_ms = 150 + step * 20;
        if step == 1 {
            successor.target_execution_profile = AgentExecutionProfileV1::CredentialReference {
                reference_id: "account-corrected".into(),
                credential_generation: Some("credential-corrected-1".into()),
            };
        }
        let request = AgentRuntimeTransitionSupersedeRequestV1 {
            schema_version: 1,
            operation_id: parked.intent.operation_id.clone(),
            expected_journal_revision: parked.journal_revision,
            superseded_at_ms: successor.requested_at_ms,
            successor_intent: successor,
        };
        let result = store.supersede_agent_runtime_transition(&request).await;
        assert!(
            result.is_ok(),
            "a stopped close must admit its successor chain: {result:?}"
        );
        let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(next) = result.unwrap() else {
            panic!("a new replacement must be admitted once");
        };
        assert_eq!(
            next.predecessor_operation_id.as_ref(),
            Some(&parked.intent.operation_id)
        );
        assert_eq!(next.intent.source, parked.intent.source);
        assert_eq!(
            next.intent.provider_conversation_ref,
            parked.intent.provider_conversation_ref
        );
        assert!(matches!(
            store
                .supersede_agent_runtime_transition(&request)
                .await
                .unwrap(),
            AgentRuntimeTransitionEffectAuthorizationV1::Replayed(_)
        ));
        parked = park(&store, &next, 160 + step * 20).await;
    }
    assert!(
        store
            .effective_agent_runtime_close(&parked.intent.source.agent_id)
            .await
            .unwrap()
            .is_some(),
        "ordinary input into the old closed generation must remain fenced"
    );
    let reopened = SqliteDomainStore::open(&root.path().join("domain.sqlite"))
        .await
        .unwrap();
    assert!(
        reopened
            .agent_runtime_transition_follows_close(
                &parked.intent.operation_id,
                &close_intent().operation_id,
            )
            .await
            .unwrap()
    );
    assert!(
        !reopened
            .agent_runtime_transition_follows_close(
                &parked.intent.operation_id,
                &OperationIdV1::new("unrelated-close").unwrap(),
            )
            .await
            .unwrap()
    );
}
