use super::*;
use agent_orchestration::contract::DeliveryState;
use agent_orchestration::ports::state::StoreState;

fn fixture() -> (StoreState, ReadEventsRequest) {
    let request = create_run_request();
    let mut state = StoreState::seeded(Vec::new()).unwrap();
    let created = state
        .create_run(
            request.clone(),
            create_run_context(&request, "inspect"),
            "create-fingerprint".into(),
        )
        .unwrap();
    let context = created.context;
    let read = ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        target: Some(context.target),
        participant: context.participant,
        delivery_capability: context.delivery_capability,
        endpoint_fence: Some(context.endpoint_fence),
        after: EventCursor::BEGINNING,
        acknowledgement: None,
        limit: 1,
    };
    (state, read)
}

#[test]
fn inspection_preserves_every_canonical_record_and_reports_actual_delivery_state() {
    let (mut state, read) = fixture();
    let query = InspectEventsRequest::try_from(read.clone()).unwrap();
    let before = serde_json::to_value(&state).unwrap();
    let first = state.inspect_events(&query).unwrap();
    assert_eq!(first.events.len(), 1);
    assert_eq!(first.deliveries[0].state, DeliveryState::Queued);
    assert!(first.acknowledgement.is_none());
    assert_eq!(state.inspect_events(&query).unwrap(), first);
    assert_eq!(serde_json::to_value(&state).unwrap(), before);

    let (observed, changed) = state.read_events(read.clone(), None).unwrap();
    assert!(changed);
    assert_eq!(observed.deliveries[0].state, DeliveryState::Observed);
    assert_eq!(state.inspect_events(&query).unwrap(), observed);

    let ack = ReadEventsRequest {
        after: first.next_cursor,
        acknowledgement: Some(EventAcknowledgement {
            through: first.next_cursor,
            idempotency_key: "inspect-ack".into(),
            acknowledgement_capability: read
                .endpoint_fence
                .as_ref()
                .unwrap()
                .acknowledgement_capability
                .clone(),
        }),
        ..read.clone()
    };
    assert_eq!(
        InspectEventsRequest::try_from(ack.clone())
            .unwrap_err()
            .code,
        "inspection_cannot_acknowledge"
    );
    state
        .read_events(ack, Some("ack-fingerprint".into()))
        .unwrap();
    let after_ack = serde_json::to_value(&state).unwrap();
    assert_eq!(
        state.inspect_events(&query).unwrap().deliveries[0].state,
        DeliveryState::Acknowledged
    );
    let empty = InspectEventsRequest::try_from(ReadEventsRequest {
        after: first.next_cursor,
        ..read
    })
    .unwrap();
    let empty = state.inspect_events(&empty).unwrap();
    assert!(empty.events.is_empty());
    assert_eq!(empty.next_cursor, first.next_cursor);
    assert_eq!(serde_json::to_value(&state).unwrap(), after_ack);
}

#[test]
fn inspection_preserves_delivery_scope_capability_and_generation_checks() {
    let (state, read) = fixture();
    let before = serde_json::to_value(&state).unwrap();
    let mut stale = read.clone();
    stale.endpoint_fence.as_mut().unwrap().generation = Generation::new(99).unwrap();
    assert_eq!(
        state.inspect_events(&InspectEventsRequest::try_from(stale).unwrap()),
        Err(StoreError::CapabilityDenied)
    );
    let mut foreign = read.clone();
    foreign.endpoint_fence.as_mut().unwrap().session_identity =
        reference("foreign-session", SessionIdentityRef::new);
    assert_eq!(
        state.inspect_events(&InspectEventsRequest::try_from(foreign).unwrap()),
        Err(StoreError::CapabilityDenied)
    );
    let mut revoked = read.clone();
    revoked.delivery_capability = capability("revoked-capability");
    revoked.endpoint_fence.as_mut().unwrap().delivery_capability =
        revoked.delivery_capability.clone();
    assert_eq!(
        state.inspect_events(&InspectEventsRequest::try_from(revoked).unwrap()),
        Err(StoreError::CapabilityDenied)
    );
    let mut scope = read.clone();
    scope.authority.workspace_id = reference("other-workspace", WorkspaceId::new);
    assert_eq!(
        InspectEventsRequest::try_from(scope).unwrap_err().code,
        "scope_mismatch"
    );
    for limit in [0, 129] {
        assert_eq!(
            InspectEventsRequest::try_from(ReadEventsRequest {
                limit,
                ..read.clone()
            })
            .unwrap_err()
            .code,
            "size_out_of_bounds"
        );
    }
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
}

#[tokio::test]
async fn memory_adapter_does_not_acknowledge_an_inspected_queued_delivery() {
    let request = create_run_request();
    let service = InteractionService::new(in_memory_store(Vec::new()).unwrap());
    let context = service
        .create_run(
            request.clone(),
            create_run_context(&request, "memory-inspect"),
        )
        .await
        .unwrap()
        .context;
    let read = ReadEventsRequest {
        schema_version: 1,
        authority: context.target.authority.clone(),
        target: Some(context.target),
        participant: context.participant,
        delivery_capability: context.delivery_capability,
        endpoint_fence: Some(context.endpoint_fence),
        after: EventCursor::BEGINNING,
        acknowledgement: None,
        limit: 1,
    };
    let result = service
        .inspect_events(InspectEventsRequest::try_from(read.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(result.deliveries[0].state, DeliveryState::Queued);
    let ack = ReadEventsRequest {
        after: result.next_cursor,
        acknowledgement: Some(EventAcknowledgement {
            through: result.next_cursor,
            idempotency_key: "cannot-ack-inspection".into(),
            acknowledgement_capability: read
                .endpoint_fence
                .as_ref()
                .unwrap()
                .acknowledgement_capability
                .clone(),
        }),
        ..read
    };
    assert_eq!(
        service.read_events(ack).await,
        Err(ServiceError::StateConflict {
            code: "acknowledgement_cursor_unknown"
        })
    );
}
