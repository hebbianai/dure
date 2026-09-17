use super::*;
use dure_app::{
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionWakeRequestV1,
};

#[tokio::test]
async fn hibernated_dispatch_stop_preserves_the_journal_and_fences_wake() {
    for (deferred, wake_first) in [(true, false), (true, true), (false, false)] {
        let root = TempDir::new().unwrap();
        let path = root.path().join("domain.sqlite");
        let fixture = fixture(&path).await;
        let store = &fixture.store;
        let intent = AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("hibernate-stop-source").unwrap(),
            idempotency_key: "hibernate-stop-source".into(),
            source: fixture.plan.runtime_selection().clone(),
            source_authority: fixture.plan.runtime_authority().clone(),
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume("thread-1").unwrap(),
            target_interaction_profile: if deferred {
                fixture.plan.runtime_selection().interaction_profile
            } else {
                AgentInteractionProfileV1::NativeCli
            },
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 201,
        };
        if deferred {
            store
                .admit_deferred_agent_runtime_transition(&intent)
                .await
                .unwrap();
        } else {
            store.admit_agent_runtime_transition(&intent).await.unwrap();
        }
        let stopped = store
            .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 210,
            })
            .await
            .unwrap();
        let plan = preserve_plan_with_fence(
            &fixture,
            "stop-hibernated-dispatch",
            220,
            AgentDispatchStopRuntimeFenceV1::Transition {
                record: Box::new(stopped.clone()),
            },
        );
        store.plan_agent_dispatch_stop(&plan).await.unwrap();
        let mut request = authorize_request_for(&plan, "close-hibernated-dispatch", 230);
        request.runtime_close_intent.stopped_transition = plan.stopped_transition_for_close();
        let wake = AgentRuntimeTransitionWakeRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: stopped.journal_revision,
            wake_operation_id: OperationIdV1::new("wake-hibernated-dispatch").unwrap(),
            woken_at_ms: 250,
        };
        if wake_first {
            store
                .authorize_agent_runtime_transition_wake(&wake)
                .await
                .unwrap();
            assert!(store.authorize_agent_dispatch_stop(&request).await.is_err());
            assert!(
                store
                    .agent_runtime_close(&request.runtime_close_intent.operation_id)
                    .await
                    .unwrap()
                    .is_none(),
                "a stale close cannot consume a newly authorized wake"
            );
            continue;
        }
        let authorized = store.authorize_agent_dispatch_stop(&request).await;
        assert!(
            authorized.is_ok(),
            "the exact stopped source must be closable: {authorized:?}"
        );
        let authorized = authorized.unwrap();
        let current = store
            .agent_runtime_transition(&intent.operation_id)
            .await
            .unwrap()
            .unwrap();
        if deferred {
            assert_eq!(
                current, stopped,
                "closing must neither wake nor corrupt the dormant journal"
            );
            assert_eq!(
                authorized
                    .1
                    .intent
                    .stopped_transition
                    .as_ref()
                    .unwrap()
                    .journal_revision,
                stopped.journal_revision
            );
        } else {
            assert_eq!(current.state, AgentRuntimeTransitionStateV1::RepairRequired);
            assert_eq!(current.journal_revision, stopped.journal_revision + 1);
        }
        assert!(
            store
                .authorize_agent_runtime_transition_wake(&wake)
                .await
                .is_err()
        );
        drop(fixture);
        let reopened = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .authorize_agent_dispatch_stop(&request)
                .await
                .unwrap(),
            authorized
        );
        assert!(
            reopened
                .authorize_agent_runtime_transition_wake(&wake)
                .await
                .is_err()
        );
        assert_eq!(
            reopened
                .agent_runtime_transition(&intent.operation_id)
                .await
                .unwrap(),
            Some(current)
        );
    }
}
