use super::*;
use agent_orchestration::contract::{DeliveryProgressGuidance, DeliveryState};
use agent_orchestration::ports::state::StoreState;

#[tokio::test]
async fn progress_is_authorized_read_only_and_keeps_acknowledgement_separate_from_completion() {
    let target = target();
    let mut state = StoreState::seeded(vec![dispatch(&target)]).unwrap();
    let mut open = decision_request(&target);
    open.interaction = InteractionDraft::Message {
        common: open.interaction.common().clone(),
        purpose: MessagePurpose::Update,
    };
    state.open(open, "a".repeat(64)).unwrap();
    let query = GetInteractionRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: target.authority.clone(),
        interaction_id: reference("decision-1", InteractionId::new),
        participant: participant("participant.human.coordinator"),
        read_capability: capability("capability.inbox.coordinator"),
        endpoint_fence: None,
    };
    let before = serde_json::to_value(&state).unwrap();
    let progress = state.interaction_progress(&query).unwrap();
    assert_eq!(progress.accepted_at_ms, 1_000);
    assert_eq!(progress.deliveries.len(), 1);
    assert_eq!(progress.deliveries[0].delivery.state, DeliveryState::Queued);
    assert_eq!(progress.deliveries[0].observed_at_ms, None);
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
    let mut denied = query.clone();
    denied.read_capability = capability("wrong-capability");
    assert!(state.interaction_progress(&denied).is_none());
    denied = query.clone();
    denied.authority.workspace_id = reference("other-workspace", WorkspaceId::new);
    assert!(state.interaction_progress(&denied).is_none());
    let read = ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: target.authority.clone(),
        target: Some(target.clone()),
        participant: query.participant.clone(),
        delivery_capability: query.read_capability.clone(),
        endpoint_fence: None,
        after: EventCursor::BEGINNING,
        acknowledgement: None,
        limit: 128,
    };
    let (observed, _) = state.read_events(read.clone(), None).unwrap();
    let observed_progress = state.interaction_progress(&query).unwrap();
    assert!(observed_progress.deliveries[0].observed_at_ms.is_some());
    state.read_events(read.clone(), None).unwrap();
    assert_eq!(
        state.interaction_progress(&query).unwrap(),
        observed_progress
    );
    let mut acknowledge = read;
    acknowledge.after = observed.next_cursor;
    acknowledge.acknowledgement = Some(EventAcknowledgement {
        through: observed.next_cursor,
        idempotency_key: "ack-progress".into(),
        acknowledgement_capability: query.read_capability.clone(),
    });
    state
        .read_events(acknowledge.clone(), Some("b".repeat(64)))
        .unwrap();
    let acknowledged = state.interaction_progress(&query).unwrap();
    assert_eq!(acknowledged.dispatch_state, DispatchState::Active);
    assert_eq!(acknowledged.completed_at_ms, None);
    assert_eq!(
        acknowledged.deliveries[0].guidance,
        DeliveryProgressGuidance::AwaitCompletion
    );
    assert!(
        acknowledged.deliveries[0].acknowledged_at_ms >= acknowledged.deliveries[0].observed_at_ms
    );
    state
        .read_events(acknowledge, Some("b".repeat(64)))
        .unwrap();
    assert_eq!(state.interaction_progress(&query).unwrap(), acknowledged);
    let serialized = serde_json::to_string(&acknowledged).unwrap();
    assert!(!serialized.contains("capability"));

    // Old persisted records retain known states without invented timestamps.
    let mut legacy = serde_json::to_value(&state).unwrap();
    for entry in legacy["deliveries"].as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove("observed_at_ms");
        entry.as_object_mut().unwrap().remove("acknowledged_at_ms");
    }
    let restored: StoreState = serde_json::from_value(legacy).unwrap();
    restored.validate().unwrap();
    let legacy_progress = restored.interaction_progress(&query).unwrap();
    assert_eq!(
        legacy_progress.deliveries[0].delivery.state,
        DeliveryState::Acknowledged
    );
    assert_eq!(legacy_progress.deliveries[0].observed_at_ms, None);
    assert_eq!(legacy_progress.deliveries[0].acknowledged_at_ms, None);

    state
        .complete(
            CompleteDispatchRequest {
                schema_version: INTERACTION_SCHEMA_VERSION,
                idempotency_key: "complete-progress".into(),
                message_id: reference("completion-progress", InteractionId::new),
                target: target.clone(),
                expected_dispatch_revision: Revision::INITIAL,
                completed_by: participant("participant.worker.reviewer"),
                endpoint_fence: endpoint_fence(&target),
                audience: audience(vec![(
                    "participant.human.coordinator",
                    "capability.inbox.coordinator",
                    vec!["capability.inbox.coordinator"],
                )]),
                completion_capability: capability("capability.complete.dispatch"),
                title: "Completed".into(),
                result_markdown: "Verified".into(),
                completed_at_ms: 2_000,
            },
            "c".repeat(64),
        )
        .unwrap();
    assert_eq!(
        state.interaction_progress(&query).unwrap().completed_at_ms,
        Some(2_000)
    );
    let mut late = decision_request(&target);
    let mut common = late.interaction.common().clone();
    common.id = reference("late-update", InteractionId::new);
    late.interaction = InteractionDraft::Message {
        common,
        purpose: MessagePurpose::Update,
    };
    late.idempotency_key = "late-update".into();
    late.expected_dispatch_revision = Revision::new(2).unwrap();
    // Caller clocks can disagree: canonical cursor order determines whether
    // this update arrived after the completion, not its submitted timestamp.
    late.opened_at_ms = 500;
    state.open(late, "d".repeat(64)).unwrap();
    let mut late_query = query;
    late_query.interaction_id = reference("late-update", InteractionId::new);
    let progress = state.interaction_progress(&late_query).unwrap();
    assert_eq!(progress.dispatch_state, DispatchState::Completed);
    assert_eq!(
        progress.deliveries[0].guidance,
        DeliveryProgressGuidance::AwaitInboxRead
    );
}
