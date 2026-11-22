use super::*;
use agent_orchestration::ports::state::StoreState;

fn fingerprint(seed: char) -> String {
    seed.to_string().repeat(64)
}

fn worker_update(context: &DispatchContextReceipt, id: &str) -> OpenInteractionRequest {
    OpenInteractionRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        idempotency_key: format!("open-{id}"),
        write_capability: context.interaction_capability.clone(),
        expected_dispatch_revision: context.dispatch_revision,
        opened_at_ms: 1_000,
        interaction: InteractionDraft::Message {
            common: InteractionDraftCommon {
                id: reference(id, InteractionId::new),
                target: context.target.clone(),
                author: context.participant.clone(),
                audience: Audience {
                    grants: vec![context.coordinator_grant.clone()],
                },
                title: "Progress".into(),
                description_markdown: "A durable progress update.".into(),
            },
            purpose: MessagePurpose::Update,
        },
    }
}

/// Two reporting runs in one authority, each with worker Messages to its
/// coordinator, so every record refers to one of two Dispatches.
fn two_run_history() -> (StoreState, Vec<DispatchContextReceipt>) {
    let mut state = StoreState::seeded(Vec::new()).unwrap();
    let mut contexts = Vec::new();
    for suffix in ["first", "second"] {
        let mut request = create_run_request();
        request.idempotency_key = format!("run-create-{suffix}");
        request.session.session_id = reference(&format!("session-{suffix}"), SessionRef::new);
        let context = create_run_context(&request, suffix);
        contexts.push(
            state
                .create_run(request, context, fingerprint('a'))
                .unwrap()
                .context,
        );
    }
    for context in &contexts {
        for message in 0..2 {
            let id = format!("update-{}-{message}", context.participant);
            state
                .open(worker_update(context, &id), fingerprint('b'))
                .unwrap();
        }
    }
    state.validate().unwrap();
    (state, contexts)
}

fn corruption(state: &StoreState) -> &'static str {
    match state.validate() {
        Err(StoreError::Corrupt { code }) => code,
        other => panic!("expected a corrupt state, got {other:?}"),
    }
}

#[test]
fn validation_resolves_each_record_against_its_own_dispatch_and_event() {
    let (state, contexts) = two_run_history();
    let other_generation = Generation::new(99).unwrap();

    let mut orphan = state.clone();
    let InteractionRecord::Message { common, .. } = &mut orphan.interactions[0] else {
        panic!("the history opens Messages");
    };
    common.target.generation = other_generation;
    assert_eq!(corruption(&orphan), "interaction_dispatch_missing");

    let mut orphan = state.clone();
    orphan.events.last_mut().unwrap().target.generation = other_generation;
    assert_eq!(corruption(&orphan), "event_dispatch_missing");

    let mut orphan = state.clone();
    orphan.deliveries[0].receipt.event_cursor = EventCursor::new(state.next_cursor);
    assert_eq!(corruption(&orphan), "delivery_event_missing");

    // A worker delivery is checked against the endpoint of its own Event's
    // Dispatch, not the first Dispatch in the authority.
    let mut replaced = state.clone();
    replaced
        .dispatches
        .iter_mut()
        .find(|dispatch| dispatch.target == contexts[1].target)
        .unwrap()
        .worker_endpoint
        .endpoint_ref = reference("endpoint-worker-replaced", WorkerEndpointRef::new);
    assert_eq!(corruption(&replaced), "delivery_endpoint_invalid");

    // Deliveries find their Event by cursor whatever the order, and the
    // cursor order is still checked.
    let mut reordered = state.clone();
    reordered.events.swap(0, 1);
    assert_eq!(corruption(&reordered), "event_cursor_invalid");
}
