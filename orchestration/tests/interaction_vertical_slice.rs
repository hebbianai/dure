#[path = "interaction_vertical_slice/interaction_progress.rs"]
mod interaction_progress;

#[path = "interaction_vertical_slice/event_inspection.rs"]
mod event_inspection;

use agent_orchestration::contract::{
    AnswerDecisionRequest, CompleteDispatchRequest, CreateRunRequest, DeliveryWakeState,
    DeliveryWakeTransition, DispatchContextReceipt, EventAcknowledgement, GetInteractionRequest,
    InspectEventsRequest, InteractionDraft, InteractionDraftCommon, OpenInteractionRequest,
    ReadEventsBatchItemOutcome, ReadEventsBatchItemRequest, ReadEventsBatchRequest,
    ReadEventsRequest, ServiceError, TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use agent_orchestration::domain::{
    Audience, AudienceGrant, AuthorityScope, CapabilityRef, ChannelEpochRef, DecisionAnswer,
    DecisionState, DispatchId, DispatchRecord, DispatchState, EventCursor, Generation,
    HostInstanceRef, INTERACTION_SCHEMA_VERSION, InstallRootRef, IntegrationCapabilityReceipt,
    IntegrationChannel, IntegrationVersion, InteractionId, InteractionRecord, InteractionTarget,
    MembershipRef, MessagePurpose, OptionId, ParticipantRef, ProviderRef, ResponseSpec, Revision,
    RoleRef, RunId, RunTaskSpec, RunnerInstanceRef, RunnerPrincipalRef, RuntimeRef,
    SessionIdentityRef, SessionRef, Sha256Digest, TargetReferenceRef, TaskId, TerminalEpochRef,
    WakeEffectRef, WorkerEndpoint, WorkerEndpointFence, WorkerEndpointRef, WorkerSessionGeneration,
    WorkflowKindRef, WorkspaceId,
};
use agent_orchestration::ports::{
    ReadEventsStoreRequest, ReadEventsStoreResult, Store, StoreError, StoreFuture, StoreHandle,
    in_memory_store,
};
use agent_orchestration::service::{
    InteractionService, create_run_target, worker_session_identity,
};

fn reference<T, E: std::fmt::Debug>(
    value: &str,
    constructor: impl FnOnce(String) -> Result<T, E>,
) -> T {
    constructor(value.to_owned()).unwrap()
}

fn participant(value: &str) -> ParticipantRef {
    reference(value, ParticipantRef::new)
}

fn capability(value: &str) -> CapabilityRef {
    reference(value, CapabilityRef::new)
}

fn target() -> InteractionTarget {
    InteractionTarget {
        authority: AuthorityScope {
            workspace_id: reference("workspace-1", WorkspaceId::new),
            tenant_ref: None,
        },
        run_id: reference("run-1", RunId::new),
        task_id: reference("task-1", TaskId::new),
        dispatch_id: reference("dispatch-1", DispatchId::new),
        generation: Generation::new(7).unwrap(),
    }
}

fn endpoint(target: &InteractionTarget) -> WorkerEndpoint {
    WorkerEndpoint {
        endpoint_ref: reference("endpoint-worker-1", WorkerEndpointRef::new),
        participant: participant("participant.worker.reviewer"),
        session_identity: reference("session-worker-1", SessionIdentityRef::new),
        generation: target.generation,
        delivery_capability: capability("capability.inbox.worker"),
        acknowledgement_capability: capability("capability.ack.worker"),
        wake_capability: None,
        integration_receipt: IntegrationCapabilityReceipt {
            install_root_ref: reference("install-root-worker-1", InstallRootRef::new),
            version: reference("0.1.4+test", IntegrationVersion::new),
            digest: Sha256Digest::new("a".repeat(64)).unwrap(),
            channel: reference("dev-pane", IntegrationChannel::new),
            capabilities: vec![
                capability("event_cursor_v1"),
                capability("idempotent_delivery_receipt_v1"),
            ],
        },
    }
}

fn endpoint_fence(target: &InteractionTarget) -> WorkerEndpointFence {
    let endpoint = endpoint(target);
    WorkerEndpointFence {
        endpoint_ref: endpoint.endpoint_ref,
        session_identity: endpoint.session_identity,
        generation: endpoint.generation,
        delivery_capability: endpoint.delivery_capability,
        acknowledgement_capability: endpoint.acknowledgement_capability,
    }
}

fn dispatch(target: &InteractionTarget) -> DispatchRecord {
    DispatchRecord {
        target: target.clone(),
        revision: Revision::INITIAL,
        state: DispatchState::Active,
        blocked_by: None,
        interaction_capability: capability("capability.open.interaction"),
        completion_capability: capability("capability.complete.dispatch"),
        worker_endpoint: endpoint(target),
    }
}

fn audience(grants: Vec<(&str, &str, Vec<&str>)>) -> Audience {
    Audience {
        grants: grants
            .into_iter()
            .map(
                |(participant_ref, delivery_capability, capabilities)| AudienceGrant {
                    membership_ref: reference(
                        &format!("membership-{participant_ref}"),
                        MembershipRef::new,
                    ),
                    participant: participant(participant_ref),
                    roles: vec![reference("role.member", RoleRef::new)],
                    capabilities: capabilities.into_iter().map(capability).collect(),
                    delivery_capability: capability(delivery_capability),
                },
            )
            .collect(),
    }
}

fn decision_request(target: &InteractionTarget) -> OpenInteractionRequest {
    OpenInteractionRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        idempotency_key: "open-decision-1".into(),
        write_capability: capability("capability.open.interaction"),
        expected_dispatch_revision: Revision::INITIAL,
        opened_at_ms: 1_000,
        interaction: InteractionDraft::Decision {
            common: InteractionDraftCommon {
                id: reference("decision-1", InteractionId::new),
                target: target.clone(),
                author: participant("participant.worker.reviewer"),
                audience: audience(vec![(
                    "participant.human.coordinator",
                    "capability.inbox.coordinator",
                    vec![
                        "capability.inbox.coordinator",
                        "capability.reply.decision-1",
                    ],
                )]),
                title: "배포 범위를 선택하세요".into(),
                description_markdown: "현재 세대에만 적용됩니다.".into(),
            },
            response: ResponseSpec::Select {
                options: vec![
                    agent_orchestration::domain::SelectOption {
                        id: reference("local", OptionId::new),
                        label: "로컬".into(),
                        description_markdown: None,
                    },
                    agent_orchestration::domain::SelectOption {
                        id: reference("remote", OptionId::new),
                        label: "원격".into(),
                        description_markdown: None,
                    },
                ],
                min_selections: 0,
                max_selections: 2,
            },
            reply_capability: capability("capability.reply.decision-1"),
        },
    }
}

fn create_run_request() -> CreateRunRequest {
    CreateRunRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: AuthorityScope {
            workspace_id: reference("workspace-1", WorkspaceId::new),
            tenant_ref: None,
        },
        workflow_kind_ref: reference("workflow.existing-session-reporting", WorkflowKindRef::new),
        task: RunTaskSpec {
            summary: "Report the current managed session".into(),
            instructions: "Publish durable Markdown updates and decisions.".into(),
        },
        session: WorkerSessionGeneration {
            session_id: reference("session-1", SessionRef::new),
            workspace_id: reference("runtime-workspace-1", WorkspaceId::new),
            provider_id: reference("codex", ProviderRef::new),
            runner_principal: reference("runner-1", RunnerPrincipalRef::new),
            runner_instance: reference("instance-1", RunnerInstanceRef::new),
            channel_epoch: reference("channel-1", ChannelEpochRef::new),
            host_instance_id: reference("host-1", HostInstanceRef::new),
            terminal_epoch: reference("terminal-1", TerminalEpochRef::new),
        },
        integration_receipt: endpoint(&target()).integration_receipt,
        runtime_ref: reference("runtime.hmux", RuntimeRef::new),
        target_reference: reference("orchestration.current-session", TargetReferenceRef::new),
        idempotency_key: "run-create-1".into(),
        created_at_ms: 500,
    }
}

fn create_run_context(request: &CreateRunRequest, suffix: &str) -> DispatchContextReceipt {
    let target = create_run_target(request).unwrap();
    let worker_delivery = capability(&format!("capability.worker.delivery.{suffix}"));
    let worker_acknowledgement = capability(&format!("capability.worker.ack.{suffix}"));
    let coordinator_delivery = capability(&format!("capability.coordinator.delivery.{suffix}"));
    let coordinator_reply = capability(&format!("capability.coordinator.reply.{suffix}"));
    DispatchContextReceipt {
        schema_version: INTERACTION_SCHEMA_VERSION,
        target: target.clone(),
        dispatch_revision: Revision::INITIAL,
        dispatch_state: DispatchState::Active,
        successor_required: false,
        participant: participant(&format!("participant.worker.{suffix}")),
        interaction_capability: capability(&format!("capability.interaction.{suffix}")),
        completion_capability: capability(&format!("capability.completion.{suffix}")),
        delivery_capability: worker_delivery.clone(),
        acknowledgement_capability: worker_acknowledgement.clone(),
        wake_capability: None,
        endpoint_fence: WorkerEndpointFence {
            endpoint_ref: reference(&format!("endpoint-worker-{suffix}"), WorkerEndpointRef::new),
            session_identity: worker_session_identity(&request.session).unwrap(),
            generation: target.generation,
            delivery_capability: worker_delivery,
            acknowledgement_capability: worker_acknowledgement,
        },
        coordinator_grant: AudienceGrant {
            membership_ref: reference(
                &format!("membership-coordinator-{suffix}"),
                MembershipRef::new,
            ),
            participant: participant(&format!("participant.coordinator.{suffix}")),
            roles: vec![reference("role.coordinator", RoleRef::new)],
            capabilities: vec![coordinator_delivery.clone(), coordinator_reply.clone()],
            delivery_capability: coordinator_delivery,
        },
        coordinator_reply_capability: coordinator_reply,
        integration_receipt: request.integration_receipt.clone(),
    }
}

fn coordinator_event_read(
    context: &DispatchContextReceipt,
    after: EventCursor,
    limit: usize,
) -> ReadEventsRequest {
    ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        target: Some(context.target.clone()),
        participant: context.coordinator_grant.participant.clone(),
        delivery_capability: context.coordinator_grant.delivery_capability.clone(),
        endpoint_fence: None,
        after,
        acknowledgement: None,
        limit,
    }
}

fn worker_event_read(context: &DispatchContextReceipt, after: EventCursor) -> ReadEventsRequest {
    ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        target: Some(context.target.clone()),
        participant: context.participant.clone(),
        delivery_capability: context.delivery_capability.clone(),
        endpoint_fence: Some(context.endpoint_fence.clone()),
        after,
        acknowledgement: None,
        limit: 10,
    }
}

fn unused_store_call<'a, T>() -> StoreFuture<'a, T> {
    Box::pin(async { panic!("the batch-error Store supports only event batch reads") })
}

#[derive(Clone)]
struct BatchErrorStore {
    error: StoreError,
}

impl Store for BatchErrorStore {
    fn create_run<'a>(
        &'a self,
        _request: CreateRunRequest,
        _context: DispatchContextReceipt,
        _fingerprint: String,
    ) -> StoreFuture<'a, agent_orchestration::contract::CreateRunReceipt> {
        unused_store_call()
    }

    fn open_interaction<'a>(
        &'a self,
        _request: OpenInteractionRequest,
        _fingerprint: String,
    ) -> StoreFuture<'a, agent_orchestration::contract::OpenInteractionReceipt> {
        unused_store_call()
    }

    fn interaction<'a>(
        &'a self,
        _request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<InteractionRecord>> {
        unused_store_call()
    }

    fn interaction_progress<'a>(
        &'a self,
        _request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<agent_orchestration::contract::InteractionProgressReceipt>> {
        unused_store_call()
    }

    fn answer_decision<'a>(
        &'a self,
        _request: AnswerDecisionRequest,
        _fingerprint: String,
    ) -> StoreFuture<'a, agent_orchestration::contract::AnswerDecisionReceipt> {
        unused_store_call()
    }

    fn complete_dispatch<'a>(
        &'a self,
        _request: CompleteDispatchRequest,
        _fingerprint: String,
    ) -> StoreFuture<'a, agent_orchestration::contract::CompleteDispatchReceipt> {
        unused_store_call()
    }

    fn inspect_events<'a>(
        &'a self,
        _request: InspectEventsRequest,
    ) -> StoreFuture<'a, agent_orchestration::contract::ReadEventsReceipt> {
        unused_store_call()
    }

    fn read_events<'a>(
        &'a self,
        _request: ReadEventsRequest,
        _acknowledgement_fingerprint: Option<String>,
    ) -> StoreFuture<'a, agent_orchestration::contract::ReadEventsReceipt> {
        unused_store_call()
    }

    fn read_events_batch<'a>(
        &'a self,
        _authority: AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> StoreFuture<'a, Vec<ReadEventsStoreResult>> {
        let error = self.error.clone();
        Box::pin(async move { Ok(requests.into_iter().map(|_| Err(error.clone())).collect()) })
    }

    fn transition_delivery_wake<'a>(
        &'a self,
        _request: TransitionDeliveryWakeRequest,
    ) -> StoreFuture<'a, TransitionDeliveryWakeReceipt> {
        unused_store_call()
    }
}

#[test]
fn legacy_context_receipt_without_dispatch_state_defaults_to_active() {
    let request = create_run_request();
    let mut encoded = serde_json::to_value(create_run_context(&request, "legacy")).unwrap();
    let object = encoded.as_object_mut().unwrap();
    object.remove("dispatchState");
    object.remove("successorRequired");

    let decoded: DispatchContextReceipt = serde_json::from_value(encoded).unwrap();

    assert_eq!(decoded.dispatch_state, DispatchState::Active);
    assert!(!decoded.successor_required);
}

#[tokio::test]
async fn run_creation_is_a_store_conformance_transition_with_durable_cursor_delivery() {
    let request = create_run_request();
    let service = InteractionService::new(in_memory_store(Vec::new()).unwrap());
    let first = service
        .create_run(request.clone(), create_run_context(&request, "first"))
        .await
        .unwrap();
    assert!(!first.idempotent);
    assert_eq!(first.deliveries.len(), 2);
    assert!(matches!(
        first.event.kind,
        agent_orchestration::contract::EventKind::RunCreated { .. }
    ));

    let mut retried_request = request.clone();
    retried_request.created_at_ms = 750;
    let replay = service
        .create_run(
            retried_request.clone(),
            create_run_context(&retried_request, "replacement"),
        )
        .await
        .unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.context, first.context);
    assert_eq!(replay.event, first.event);

    let coordinator_events = service
        .read_events(ReadEventsRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: first.context.target.authority.clone(),
            target: Some(first.context.target.clone()),
            participant: first.context.coordinator_grant.participant.clone(),
            delivery_capability: first.context.coordinator_grant.delivery_capability.clone(),
            endpoint_fence: None,
            after: EventCursor::BEGINNING,
            acknowledgement: None,
            limit: 10,
        })
        .await
        .unwrap();
    assert_eq!(coordinator_events.events, vec![first.event.clone()]);
    assert!(coordinator_events.deliveries[0].endpoint.is_none());

    let worker_read = ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: first.context.target.authority.clone(),
        target: Some(first.context.target.clone()),
        participant: first.context.participant.clone(),
        delivery_capability: first.context.delivery_capability.clone(),
        endpoint_fence: Some(first.context.endpoint_fence.clone()),
        after: EventCursor::BEGINNING,
        acknowledgement: None,
        limit: 10,
    };
    let first_worker_delivery = service.read_events(worker_read.clone()).await.unwrap();
    let retried_worker_delivery = service.read_events(worker_read.clone()).await.unwrap();
    assert_eq!(retried_worker_delivery, first_worker_delivery);
    assert_eq!(first_worker_delivery.events, vec![first.event.clone()]);
    assert_eq!(
        first_worker_delivery.deliveries[0].endpoint,
        first.deliveries[1].endpoint
    );

    let mut stale_generation = worker_read.clone();
    stale_generation.endpoint_fence.as_mut().unwrap().generation = Generation::new(2).unwrap();
    assert_eq!(
        service.read_events(stale_generation).await,
        Err(ServiceError::CapabilityDenied)
    );
    let mut stale_session = worker_read.clone();
    stale_session
        .endpoint_fence
        .as_mut()
        .unwrap()
        .session_identity = reference("session-replaced", SessionIdentityRef::new);
    assert_eq!(
        service.read_events(stale_session).await,
        Err(ServiceError::CapabilityDenied)
    );
    let mut stale_capability = worker_read.clone();
    stale_capability.delivery_capability = capability("capability.worker.delivery.replaced");
    stale_capability
        .endpoint_fence
        .as_mut()
        .unwrap()
        .delivery_capability = stale_capability.delivery_capability.clone();
    assert_eq!(
        service.read_events(stale_capability).await,
        Err(ServiceError::CapabilityDenied)
    );

    let acknowledgement = ReadEventsRequest {
        after: first_worker_delivery.next_cursor,
        acknowledgement: Some(EventAcknowledgement {
            through: first_worker_delivery.next_cursor,
            idempotency_key: "ack-run-created-worker-1".into(),
            acknowledgement_capability: first.context.acknowledgement_capability.clone(),
        }),
        ..worker_read
    };
    let first_acknowledgement = service
        .read_events(acknowledgement.clone())
        .await
        .unwrap()
        .acknowledgement
        .unwrap();
    let retried_acknowledgement = service
        .read_events(acknowledgement)
        .await
        .unwrap()
        .acknowledgement
        .unwrap();
    assert!(!first_acknowledgement.idempotent);
    assert!(retried_acknowledgement.idempotent);
    assert_eq!(
        retried_acknowledgement.delivery.receipt_id,
        first_acknowledgement.delivery.receipt_id
    );
}

#[tokio::test]
async fn event_read_batch_keeps_logical_store_errors_correlated_and_elevates_fatal_errors() {
    let run_request = create_run_request();
    let context = create_run_context(&run_request, "batch-store-errors");
    let batch_request = || ReadEventsBatchRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: context.target.authority.clone(),
        requests: vec![ReadEventsBatchItemRequest {
            correlation_id: "store-outcome".into(),
            request: coordinator_event_read(&context, EventCursor::BEGINNING, 10),
        }],
    };

    let logical = InteractionService::new(StoreHandle::new(BatchErrorStore {
        error: StoreError::CapabilityDenied,
    }))
    .read_events_batch(batch_request())
    .await
    .unwrap();
    assert_eq!(
        logical.results[0].outcome,
        ReadEventsBatchItemOutcome::Failed(ServiceError::CapabilityDenied)
    );

    for (store_error, service_error) in [
        (
            StoreError::Unavailable {
                code: "batch_store_unavailable",
            },
            ServiceError::StorageUnavailable {
                code: "batch_store_unavailable",
            },
        ),
        (
            StoreError::Corrupt {
                code: "batch_store_corrupt",
            },
            ServiceError::StorageCorrupt {
                code: "batch_store_corrupt",
            },
        ),
    ] {
        let service =
            InteractionService::new(StoreHandle::new(BatchErrorStore { error: store_error }));
        assert_eq!(
            service.read_events_batch(batch_request()).await,
            Err(service_error)
        );
    }
}

#[tokio::test]
async fn event_read_batch_is_ordered_isolated_paged_and_acknowledges_cumulatively() {
    let service = InteractionService::new(in_memory_store(Vec::new()).unwrap());
    let first_request = create_run_request();
    let first = service
        .create_run(
            first_request.clone(),
            create_run_context(&first_request, "batch-first"),
        )
        .await
        .unwrap();
    let mut second_request = create_run_request();
    second_request.session.session_id = reference("session-2", SessionRef::new);
    second_request.session.workspace_id = reference("runtime-workspace-2", WorkspaceId::new);
    second_request.session.runner_instance = reference("instance-2", RunnerInstanceRef::new);
    second_request.session.host_instance_id = reference("host-2", HostInstanceRef::new);
    second_request.session.terminal_epoch = reference("terminal-2", TerminalEpochRef::new);
    second_request.idempotency_key = "run-create-2".into();
    second_request.created_at_ms = 600;
    let second = service
        .create_run(
            second_request.clone(),
            create_run_context(&second_request, "batch-second"),
        )
        .await
        .unwrap();
    let message = service
        .open(OpenInteractionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "open-batch-message".into(),
            write_capability: first.context.interaction_capability.clone(),
            expected_dispatch_revision: first.context.dispatch_revision,
            opened_at_ms: 700,
            interaction: InteractionDraft::Message {
                common: InteractionDraftCommon {
                    id: reference("batch-message-1", InteractionId::new),
                    target: first.context.target.clone(),
                    author: first.context.participant.clone(),
                    audience: Audience {
                        grants: vec![first.context.coordinator_grant.clone()],
                    },
                    title: "Batch paging".into(),
                    description_markdown: "The second page stays ordered.".into(),
                },
                purpose: MessagePurpose::Update,
            },
        })
        .await
        .unwrap();
    let message_cursor = message.events[0].cursor;

    let mut wrong_endpoint = worker_event_read(&second.context, EventCursor::BEGINNING);
    wrong_endpoint
        .endpoint_fence
        .as_mut()
        .unwrap()
        .session_identity = reference("session-replaced", SessionIdentityRef::new);
    let mut wrong_capability = worker_event_read(&second.context, EventCursor::BEGINNING);
    wrong_capability.delivery_capability = capability("capability.worker.delivery.replaced");
    wrong_capability
        .endpoint_fence
        .as_mut()
        .unwrap()
        .delivery_capability = wrong_capability.delivery_capability.clone();
    let mut wrong_authority = coordinator_event_read(&second.context, EventCursor::BEGINNING, 1);
    wrong_authority.authority.workspace_id = reference("workspace-foreign", WorkspaceId::new);

    let receipt = service
        .read_events_batch(ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: first.context.target.authority.clone(),
            requests: vec![
                ReadEventsBatchItemRequest {
                    correlation_id: "first-page-1".into(),
                    request: coordinator_event_read(&first.context, EventCursor::BEGINNING, 1),
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "wrong-endpoint".into(),
                    request: wrong_endpoint,
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "second-target".into(),
                    request: coordinator_event_read(&second.context, EventCursor::BEGINNING, 1),
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "wrong-capability".into(),
                    request: wrong_capability,
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "wrong-authority".into(),
                    request: wrong_authority,
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "first-page-2".into(),
                    request: coordinator_event_read(&first.context, first.event.cursor, 1),
                },
            ],
        })
        .await
        .unwrap();
    assert_eq!(
        receipt
            .results
            .iter()
            .map(|item| item.correlation_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "first-page-1",
            "wrong-endpoint",
            "second-target",
            "wrong-capability",
            "wrong-authority",
            "first-page-2",
        ]
    );
    let ReadEventsBatchItemOutcome::Read(first_page) = &receipt.results[0].outcome else {
        panic!("the first target page must succeed");
    };
    assert_eq!(first_page.events, vec![first.event.clone()]);
    assert_eq!(first_page.next_cursor, first.event.cursor);
    assert_eq!(
        first_page.deliveries[0].state,
        agent_orchestration::contract::DeliveryState::Observed
    );
    assert_eq!(
        receipt.results[1].outcome,
        ReadEventsBatchItemOutcome::Failed(ServiceError::CapabilityDenied)
    );
    let ReadEventsBatchItemOutcome::Read(second_target) = &receipt.results[2].outcome else {
        panic!("the second target must succeed after a failed item");
    };
    assert_eq!(second_target.events, vec![second.event.clone()]);
    assert_eq!(
        receipt.results[3].outcome,
        ReadEventsBatchItemOutcome::Failed(ServiceError::CapabilityDenied)
    );
    assert_eq!(
        receipt.results[4].outcome,
        ReadEventsBatchItemOutcome::Failed(ServiceError::Invalid {
            field: "request.authority",
            code: "scope_mismatch",
        })
    );
    let ReadEventsBatchItemOutcome::Read(second_page) = &receipt.results[5].outcome else {
        panic!("the later page must survive earlier item failures");
    };
    assert_eq!(second_page.events, message.events);
    assert_eq!(second_page.next_cursor, message_cursor);

    let worker_read = worker_event_read(&first.context, EventCursor::BEGINNING);
    let acknowledgement = ReadEventsRequest {
        after: first.event.cursor,
        acknowledgement: Some(EventAcknowledgement {
            through: first.event.cursor,
            idempotency_key: "ack-batch-first".into(),
            acknowledgement_capability: first.context.acknowledgement_capability.clone(),
        }),
        ..worker_read.clone()
    };
    let acknowledgement_batch = service
        .read_events_batch(ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: first.context.target.authority.clone(),
            requests: vec![
                ReadEventsBatchItemRequest {
                    correlation_id: "worker-observe".into(),
                    request: worker_read,
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "worker-ack".into(),
                    request: acknowledgement.clone(),
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "worker-ack-replay".into(),
                    request: acknowledgement,
                },
                ReadEventsBatchItemRequest {
                    correlation_id: "empty-tail".into(),
                    request: coordinator_event_read(&first.context, message_cursor, 1),
                },
            ],
        })
        .await
        .unwrap();
    let ReadEventsBatchItemOutcome::Read(observed) = &acknowledgement_batch.results[0].outcome
    else {
        panic!("the worker delivery must be observed before acknowledgement");
    };
    assert_eq!(observed.events, vec![first.event]);
    assert_eq!(
        observed.deliveries[0].state,
        agent_orchestration::contract::DeliveryState::Observed
    );
    let ReadEventsBatchItemOutcome::Read(acknowledged) = &acknowledgement_batch.results[1].outcome
    else {
        panic!("the worker delivery must acknowledge in the same batch");
    };
    assert!(!acknowledged.acknowledgement.as_ref().unwrap().idempotent);
    let ReadEventsBatchItemOutcome::Read(replayed) = &acknowledgement_batch.results[2].outcome
    else {
        panic!("the exact acknowledgement replay must succeed");
    };
    assert!(replayed.acknowledgement.as_ref().unwrap().idempotent);
    let ReadEventsBatchItemOutcome::Read(empty) = &acknowledgement_batch.results[3].outcome else {
        panic!("the empty tail must succeed");
    };
    assert!(empty.events.is_empty());
    assert_eq!(empty.next_cursor, message_cursor);
}

#[tokio::test]
async fn event_read_batch_rejects_invalid_bounds_and_correlations_before_items() {
    let request = create_run_request();
    let service = InteractionService::new(in_memory_store(Vec::new()).unwrap());
    let created = service
        .create_run(
            request.clone(),
            create_run_context(&request, "batch-bounds"),
        )
        .await
        .unwrap();
    let item = ReadEventsBatchItemRequest {
        correlation_id: "subscription-1".into(),
        request: coordinator_event_read(&created.context, EventCursor::BEGINNING, 10),
    };
    let invalid = vec![
        ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: created.context.target.authority.clone(),
            requests: Vec::new(),
        },
        ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: created.context.target.authority.clone(),
            requests: (0..33)
                .map(|index| ReadEventsBatchItemRequest {
                    correlation_id: format!("subscription-{index}"),
                    request: item.request.clone(),
                })
                .collect(),
        },
        ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: created.context.target.authority.clone(),
            requests: vec![item.clone(), item.clone()],
        },
        ReadEventsBatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: created.context.target.authority.clone(),
            requests: vec![ReadEventsBatchItemRequest {
                correlation_id: "subscription/invalid".into(),
                request: item.request,
            }],
        },
    ];

    for request in invalid {
        assert!(matches!(
            service.read_events_batch(request).await,
            Err(ServiceError::Invalid { .. })
        ));
    }
}

#[tokio::test]
async fn a_completed_dispatch_releases_its_session_identity_for_a_successor_run() {
    let first_request = create_run_request();
    let service = InteractionService::new(in_memory_store(Vec::new()).unwrap());
    let first = service
        .create_run(
            first_request.clone(),
            create_run_context(&first_request, "first"),
        )
        .await
        .unwrap();

    let mut concurrent_request = first_request.clone();
    concurrent_request.idempotency_key = "run-create-concurrent".into();
    let concurrent_context = create_run_context(&concurrent_request, "concurrent");
    assert_eq!(
        service
            .create_run(concurrent_request, concurrent_context)
            .await,
        Err(ServiceError::GenerationConflict)
    );

    let completed = service
        .complete(CompleteDispatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "complete-first-reporting-run".into(),
            message_id: reference("completion-first-reporting-run", InteractionId::new),
            target: first.context.target.clone(),
            expected_dispatch_revision: Revision::INITIAL,
            completed_by: first.context.participant.clone(),
            endpoint_fence: first.context.endpoint_fence.clone(),
            audience: Audience {
                grants: vec![first.context.coordinator_grant.clone()],
            },
            completion_capability: first.context.completion_capability.clone(),
            title: "Reporting cycle complete".into(),
            result_markdown: "The first reporting cycle is complete.".into(),
            completed_at_ms: 750,
        })
        .await
        .unwrap();
    assert_eq!(completed.dispatch_state, DispatchState::Completed);

    let replay = service
        .create_run(
            first_request.clone(),
            create_run_context(&first_request, "completed-replay"),
        )
        .await
        .unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.context.dispatch_state, DispatchState::Completed);
    assert!(!replay.context.successor_required);
    assert_eq!(replay.context.dispatch_revision, Revision::new(2).unwrap());

    let mut successor_request = first_request;
    successor_request.idempotency_key = "run-create-successor".into();
    successor_request.integration_receipt.version =
        reference("0.1.4+successor", IntegrationVersion::new);
    successor_request.created_at_ms = 1_000;
    let successor = service
        .create_run(
            successor_request.clone(),
            create_run_context(&successor_request, "successor"),
        )
        .await
        .unwrap();
    assert_ne!(successor.context.target, first.context.target);
    assert_eq!(
        successor.context.endpoint_fence.session_identity,
        first.context.endpoint_fence.session_identity
    );
    let historical_completion = service
        .get(GetInteractionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: first.context.target.authority.clone(),
            interaction_id: reference("completion-first-reporting-run", InteractionId::new),
            participant: first.context.coordinator_grant.participant.clone(),
            read_capability: first.context.coordinator_grant.delivery_capability.clone(),
            endpoint_fence: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        historical_completion,
        InteractionRecord::Message { .. }
    ));
}

#[tokio::test]
async fn opening_a_decision_atomically_blocks_the_exact_generation() {
    let target = target();
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    let request = decision_request(&target);
    let encoded = serde_json::to_value(&request).unwrap();
    assert_eq!(
        encoded["interaction"]["replyCapability"],
        "capability.reply.decision-1"
    );
    assert!(encoded["interaction"].get("reply_capability").is_none());
    assert_eq!(
        serde_json::from_value::<OpenInteractionRequest>(encoded).unwrap(),
        request
    );

    let receipt = service.open(request.clone()).await.unwrap();
    assert_eq!(receipt.dispatch_state, DispatchState::Blocked);
    assert_eq!(receipt.events.len(), 2);
    let replay = service.open(request).await.unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.events, receipt.events);

    let mut stale_target = target.clone();
    stale_target.generation = Generation::new(8).unwrap();
    let mut stale = decision_request(&stale_target);
    stale.idempotency_key = "open-stale-decision".into();
    assert_eq!(
        service.open(stale).await,
        Err(ServiceError::GenerationConflict)
    );
}

#[tokio::test]
async fn stale_and_concurrent_decision_answers_fail_closed() {
    let target = target();
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    service.open(decision_request(&target)).await.unwrap();
    let first = AnswerDecisionRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        idempotency_key: "answer-first".into(),
        interaction_id: reference("decision-1", InteractionId::new),
        target: target.clone(),
        expected_revision: Revision::INITIAL,
        expected_dispatch_revision: Revision::new(2).unwrap(),
        answered_by: participant("participant.human.coordinator"),
        reply_capability: capability("capability.reply.decision-1"),
        answer: DecisionAnswer::Select {
            option_ids: vec![reference("local", OptionId::new)],
        },
        answered_at_ms: 1_500,
    };
    service.answer(first.clone()).await.unwrap();

    let mut replay_with_replacement_payload = first.clone();
    replay_with_replacement_payload.answer = DecisionAnswer::Select {
        option_ids: vec![reference("remote", OptionId::new)],
    };
    assert_eq!(
        service.answer(replay_with_replacement_payload).await,
        Err(ServiceError::IdempotencyConflict)
    );

    let mut concurrent = first;
    concurrent.idempotency_key = "answer-concurrent".into();
    assert_eq!(
        service.answer(concurrent).await,
        Err(ServiceError::RevisionConflict)
    );
}

#[tokio::test]
async fn answer_and_completion_each_commit_canonical_state_and_events_together() {
    let target = target();
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    service.open(decision_request(&target)).await.unwrap();

    let answer = service
        .answer(AnswerDecisionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "answer-decision-1".into(),
            interaction_id: reference("decision-1", InteractionId::new),
            target: target.clone(),
            expected_revision: Revision::INITIAL,
            expected_dispatch_revision: Revision::new(2).unwrap(),
            answered_by: participant("participant.human.coordinator"),
            reply_capability: capability("capability.reply.decision-1"),
            answer: DecisionAnswer::Select { option_ids: vec![] },
            answered_at_ms: 2_000,
        })
        .await
        .unwrap();
    assert_eq!(answer.dispatch_state, DispatchState::Active);
    assert_eq!(answer.events.len(), 2);
    assert_eq!(answer.deliveries.len(), 2);
    assert!(matches!(
        answer.interaction,
        InteractionRecord::Decision {
            state: DecisionState::Answered { .. },
            ..
        }
    ));

    let worker_wakeup = service
        .read_events(ReadEventsRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            target: Some(target.clone()),
            participant: participant("participant.worker.reviewer"),
            delivery_capability: capability("capability.inbox.worker"),
            endpoint_fence: Some(endpoint_fence(&target)),
            after: EventCursor::BEGINNING,
            acknowledgement: None,
            limit: 10,
        })
        .await
        .unwrap();
    assert_eq!(worker_wakeup.events.len(), 1);
    assert!(
        worker_wakeup
            .deliveries
            .iter()
            .all(|delivery| delivery.endpoint.is_some())
    );
    let worker_decision = service
        .get(GetInteractionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            interaction_id: reference("decision-1", InteractionId::new),
            participant: participant("participant.worker.reviewer"),
            read_capability: capability("capability.inbox.worker"),
            endpoint_fence: Some(endpoint_fence(&target)),
        })
        .await
        .unwrap();
    assert!(matches!(
        worker_decision,
        InteractionRecord::Decision {
            state: DecisionState::Answered { .. },
            ..
        }
    ));

    let completion = service
        .complete(CompleteDispatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "complete-dispatch-1".into(),
            message_id: reference("completion-message-1", InteractionId::new),
            target: target.clone(),
            expected_dispatch_revision: Revision::new(3).unwrap(),
            completed_by: participant("participant.worker.reviewer"),
            endpoint_fence: endpoint_fence(&target),
            audience: audience(vec![(
                "participant.human.coordinator",
                "capability.inbox.coordinator",
                vec!["capability.inbox.coordinator"],
            )]),
            completion_capability: capability("capability.complete.dispatch"),
            title: "작업 완료".into(),
            result_markdown: "결과는 **완료**입니다.".into(),
            completed_at_ms: 3_000,
        })
        .await
        .unwrap();
    assert_eq!(completion.dispatch_state, DispatchState::Completed);
    assert_eq!(completion.events.len(), 1);
    assert!(matches!(
        completion.message,
        InteractionRecord::Message {
            purpose: MessagePurpose::CompletionReport,
            ..
        }
    ));
}

#[tokio::test]
async fn completed_dispatch_accepts_only_informational_updates_without_changing_its_state() {
    let target = target();
    let mut completed = dispatch(&target);
    completed.state = DispatchState::Completed;
    completed.revision = Revision::new(2).unwrap();
    let service = InteractionService::new(in_memory_store(vec![completed]).unwrap());
    let mut decision = decision_request(&target);
    decision.expected_dispatch_revision = Revision::new(2).unwrap();
    assert_eq!(
        service.open(decision.clone()).await,
        Err(ServiceError::StateConflict {
            code: "dispatch_not_active"
        })
    );
    let mut update = decision;
    update.idempotency_key = "follow-up-update".into();
    update.interaction = InteractionDraft::Message {
        common: update.interaction.common().clone(),
        purpose: MessagePurpose::Update,
    };
    let mut forged_completion = update.clone();
    if let InteractionDraft::Message { purpose, .. } = &mut forged_completion.interaction {
        *purpose = MessagePurpose::CompletionReport;
    }
    assert_eq!(
        service.open(forged_completion).await,
        Err(ServiceError::StateConflict {
            code: "completion_message_requires_complete"
        })
    );
    let mut stale = update.clone();
    stale.expected_dispatch_revision = Revision::INITIAL;
    assert_eq!(
        service.open(stale).await,
        Err(ServiceError::RevisionConflict)
    );
    let mut unauthorized = update.clone();
    unauthorized.write_capability = capability("capability.other");
    assert_eq!(
        service.open(unauthorized).await,
        Err(ServiceError::CapabilityDenied)
    );

    let opened = service.open(update.clone()).await.unwrap();
    assert_eq!(opened.dispatch_state, DispatchState::Completed);
    assert_eq!(opened.events.len(), 1);
    assert!(matches!(
        opened.events[0].kind,
        agent_orchestration::contract::EventKind::InteractionOpened { .. }
    ));
    let replay = service.open(update.clone()).await.unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.interaction, opened.interaction);
    assert_eq!(replay.deliveries, opened.deliveries);
    if let InteractionDraft::Message { common, .. } = &mut update.interaction {
        common.description_markdown = "Changed retry body".into();
    }
    assert_eq!(
        service.open(update).await,
        Err(ServiceError::IdempotencyConflict)
    );
}

#[tokio::test]
async fn completion_rejects_a_replaced_endpoint_session_before_any_state_change() {
    let target = target();
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    let mut wrong_fence = endpoint_fence(&target);
    wrong_fence.session_identity = reference("session-replaced", SessionIdentityRef::new);
    assert_eq!(
        service
            .complete(CompleteDispatchRequest {
                schema_version: INTERACTION_SCHEMA_VERSION,
                idempotency_key: "complete-stale-session".into(),
                message_id: reference("completion-stale-session", InteractionId::new),
                target: target.clone(),
                expected_dispatch_revision: Revision::INITIAL,
                completed_by: participant("participant.worker.reviewer"),
                endpoint_fence: wrong_fence,
                audience: audience(vec![(
                    "participant.human.coordinator",
                    "capability.inbox.coordinator",
                    vec!["capability.inbox.coordinator"],
                )]),
                completion_capability: capability("capability.complete.dispatch"),
                title: "완료".into(),
                result_markdown: "stale session".into(),
                completed_at_ms: 4_000,
            })
            .await,
        Err(ServiceError::CapabilityDenied)
    );
    let completed = service
        .complete(CompleteDispatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "complete-current-session".into(),
            message_id: reference("completion-current-session", InteractionId::new),
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
            title: "완료".into(),
            result_markdown: "current session".into(),
            completed_at_ms: 4_001,
        })
        .await
        .unwrap();
    assert_eq!(completed.dispatch_state, DispatchState::Completed);
}

#[tokio::test]
async fn endpoint_delivery_retries_after_disconnect_and_fences_session_generation_and_capability() {
    let target = target();
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    let mut request = decision_request(&target);
    request.idempotency_key = "open-worker-message".into();
    request.interaction = InteractionDraft::Message {
        common: InteractionDraftCommon {
            id: reference("worker-message-1", InteractionId::new),
            target: target.clone(),
            author: participant("participant.human.coordinator"),
            audience: audience(vec![(
                "participant.worker.reviewer",
                "capability.inbox.worker",
                vec!["capability.inbox.worker"],
            )]),
            title: "검토 요청".into(),
            description_markdown: "Event cursor에서 읽으세요.".into(),
        },
        purpose: MessagePurpose::Update,
    };
    service.open(request).await.unwrap();

    let fence = endpoint_fence(&target);
    let message = service
        .get(GetInteractionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            interaction_id: reference("worker-message-1", InteractionId::new),
            participant: participant("participant.worker.reviewer"),
            read_capability: capability("capability.inbox.worker"),
            endpoint_fence: Some(fence.clone()),
        })
        .await
        .unwrap();
    assert!(matches!(message, InteractionRecord::Message { .. }));
    let read = ReadEventsRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: target.authority.clone(),
        target: Some(target.clone()),
        participant: participant("participant.worker.reviewer"),
        delivery_capability: capability("capability.inbox.worker"),
        endpoint_fence: Some(fence.clone()),
        after: EventCursor::BEGINNING,
        acknowledgement: None,
        limit: 10,
    };
    assert_eq!(
        service
            .read_events(ReadEventsRequest {
                after: EventCursor::new(1),
                acknowledgement: Some(EventAcknowledgement {
                    through: EventCursor::new(1),
                    idempotency_key: "ack-before-observation".into(),
                    acknowledgement_capability: capability("capability.ack.worker"),
                }),
                ..read.clone()
            })
            .await,
        Err(ServiceError::StateConflict {
            code: "acknowledgement_cursor_unknown"
        })
    );
    let first = service.read_events(read.clone()).await.unwrap();
    let retried = service.read_events(read.clone()).await.unwrap();
    assert_eq!(retried.events, first.events);
    assert_eq!(retried.deliveries, first.deliveries);

    let cursor = first.next_cursor;
    let acknowledged = service
        .read_events(ReadEventsRequest {
            after: cursor,
            acknowledgement: Some(EventAcknowledgement {
                through: cursor,
                idempotency_key: "ack-worker-message-1".into(),
                acknowledgement_capability: capability("capability.ack.worker"),
            }),
            ..read.clone()
        })
        .await
        .unwrap();
    assert!(acknowledged.events.is_empty());
    let acknowledgement = acknowledged.acknowledgement.unwrap();
    assert_eq!(acknowledgement.through, cursor);
    assert_eq!(
        acknowledgement.delivery.receipt_id.as_str(),
        first.deliveries[0].receipt_id.as_str()
    );
    assert_eq!(
        acknowledgement.delivery.state,
        agent_orchestration::contract::DeliveryState::Acknowledged
    );
    assert!(!acknowledgement.idempotent);
    let replayed_ack = service
        .read_events(ReadEventsRequest {
            after: cursor,
            acknowledgement: Some(EventAcknowledgement {
                through: cursor,
                idempotency_key: "ack-worker-message-1".into(),
                acknowledgement_capability: capability("capability.ack.worker"),
            }),
            ..read.clone()
        })
        .await
        .unwrap();
    assert_eq!(replayed_ack.next_cursor, cursor);
    assert!(replayed_ack.acknowledgement.unwrap().idempotent);

    let mut wrong_fence = fence;
    wrong_fence.session_identity = reference("session-replaced", SessionIdentityRef::new);
    assert_eq!(
        service
            .read_events(ReadEventsRequest {
                endpoint_fence: Some(wrong_fence),
                ..read
            })
            .await,
        Err(ServiceError::CapabilityDenied)
    );
}

#[tokio::test]
async fn provider_wake_is_a_separate_fenced_and_idempotent_delivery_transition() {
    let target = target();
    let wake_capability = capability("capability.wake.worker");
    let mut request = decision_request(&target);
    request.idempotency_key = "open-wake-message".into();
    request.interaction = InteractionDraft::Message {
        common: InteractionDraftCommon {
            id: reference("wake-message-1", InteractionId::new),
            target: target.clone(),
            author: participant("participant.human.coordinator"),
            audience: audience(vec![(
                "participant.worker.reviewer",
                "capability.inbox.worker",
                vec!["capability.inbox.worker"],
            )]),
            title: "Wake the exact worker".into(),
            description_markdown: "The Event remains the content authority.".into(),
        },
        purpose: MessagePurpose::Update,
    };

    let unsupported = InteractionService::new(in_memory_store(vec![dispatch(&target)]).unwrap());
    let unsupported_open = unsupported.open(request.clone()).await.unwrap();
    let queued = unsupported
        .transition_delivery_wake(TransitionDeliveryWakeRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            receipt_id: unsupported_open.deliveries[0].receipt_id.clone(),
            endpoint_fence: endpoint_fence(&target),
            wake_capability: None,
            transition: DeliveryWakeTransition::Request,
            transitioned_at_ms: 1_100,
        })
        .await
        .unwrap();
    assert_eq!(
        queued.delivery.wake.unwrap().state,
        DeliveryWakeState::QueuedUntilNextTurn
    );

    let mut dispatch = dispatch(&target);
    dispatch.worker_endpoint.wake_capability = Some(wake_capability.clone());
    let endpoint_fence = endpoint_fence(&target);
    let service = InteractionService::new(in_memory_store(vec![dispatch]).unwrap());
    let opened = service.open(request.clone()).await.unwrap();
    let receipt_id = opened.deliveries[0].receipt_id.clone();
    let transition = |transition, transitioned_at_ms| TransitionDeliveryWakeRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        authority: target.authority.clone(),
        receipt_id: receipt_id.clone(),
        endpoint_fence: endpoint_fence.clone(),
        wake_capability: Some(wake_capability.clone()),
        transition,
        transitioned_at_ms,
    };

    let pending = service
        .transition_delivery_wake(transition(DeliveryWakeTransition::Request, 1_100))
        .await
        .unwrap();
    assert!(pending.applied);
    assert_eq!(
        pending.delivery.wake.unwrap().state,
        DeliveryWakeState::Pending
    );
    assert!(
        !service
            .transition_delivery_wake(transition(DeliveryWakeTransition::Request, 1_101))
            .await
            .unwrap()
            .applied
    );

    let mut stale = transition(DeliveryWakeTransition::Claim, 1_200);
    stale.endpoint_fence.generation = Generation::new(8).unwrap();
    assert_eq!(
        service.transition_delivery_wake(stale).await,
        Err(ServiceError::CapabilityDenied)
    );

    let uncertain = service
        .transition_delivery_wake(transition(DeliveryWakeTransition::Claim, 1_200))
        .await
        .unwrap();
    assert!(uncertain.applied);
    assert_eq!(
        uncertain.delivery.wake.unwrap().state,
        DeliveryWakeState::Uncertain
    );
    let effect_ref = reference("wake-effect-1", WakeEffectRef::new);
    let triggered = service
        .transition_delivery_wake(transition(
            DeliveryWakeTransition::Triggered {
                effect_ref: effect_ref.clone(),
            },
            1_300,
        ))
        .await
        .unwrap();
    assert!(triggered.applied);
    assert_eq!(
        triggered.delivery.wake.unwrap().state,
        DeliveryWakeState::Triggered
    );
    assert!(
        !service
            .transition_delivery_wake(transition(
                DeliveryWakeTransition::Triggered { effect_ref },
                1_301,
            ))
            .await
            .unwrap()
            .applied
    );

    let replay = service.open(request).await.unwrap();
    assert!(replay.idempotent);
    assert_eq!(
        replay.deliveries[0].wake.as_ref().unwrap().state,
        DeliveryWakeState::Triggered
    );
}

#[tokio::test]
async fn in_memory_reference_store_conforms_to_the_interaction_contract() {
    let target = target();
    run_conformance(in_memory_store(vec![dispatch(&target)]).unwrap()).await;
}

#[test]
fn core_endpoint_and_install_identifiers_reject_filesystem_locations() {
    assert!(InstallRootRef::new("/home/worker/.dure").is_err());
    assert!(WorkerEndpointRef::new("../ssh/control.sock").is_err());
    assert!(SessionIdentityRef::new("C:\\sessions\\worker").is_err());
}

async fn run_conformance(
    store: StoreHandle,
) -> (
    agent_orchestration::contract::OpenInteractionReceipt,
    agent_orchestration::contract::AnswerDecisionReceipt,
    agent_orchestration::contract::ReadEventsReceipt,
    agent_orchestration::contract::CompleteDispatchReceipt,
) {
    let target = target();
    let service = InteractionService::new(store);
    let opened = service.open(decision_request(&target)).await.unwrap();
    assert_eq!(opened.dispatch_state, DispatchState::Blocked);
    let get = service
        .get(GetInteractionRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            interaction_id: reference("decision-1", InteractionId::new),
            participant: participant("participant.human.coordinator"),
            read_capability: capability("capability.inbox.coordinator"),
            endpoint_fence: None,
        })
        .await
        .unwrap();
    assert_eq!(get, opened.interaction);
    assert_eq!(opened.events[0].cursor, EventCursor::new(1));
    assert!(
        opened
            .deliveries
            .iter()
            .all(|receipt| !receipt.receipt_id.as_str().is_empty())
    );
    assert!(
        opened.deliveries.iter().all(|receipt| {
            receipt.state == agent_orchestration::contract::DeliveryState::Queued
        })
    );

    let answer_request = AnswerDecisionRequest {
        schema_version: INTERACTION_SCHEMA_VERSION,
        idempotency_key: "answer-conformance".into(),
        interaction_id: reference("decision-1", InteractionId::new),
        target: target.clone(),
        expected_revision: Revision::INITIAL,
        expected_dispatch_revision: Revision::new(2).unwrap(),
        answered_by: participant("participant.human.coordinator"),
        reply_capability: capability("capability.reply.decision-1"),
        answer: DecisionAnswer::Select { option_ids: vec![] },
        answered_at_ms: 2_000,
    };
    let answered = service.answer(answer_request.clone()).await.unwrap();
    assert_eq!(answered.dispatch_state, DispatchState::Active);
    assert!(service.answer(answer_request).await.unwrap().idempotent);

    let observed = service
        .read_events(ReadEventsRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            target: Some(target.clone()),
            participant: participant("participant.worker.reviewer"),
            delivery_capability: capability("capability.inbox.worker"),
            endpoint_fence: Some(endpoint_fence(&target)),
            after: EventCursor::BEGINNING,
            acknowledgement: None,
            limit: 10,
        })
        .await
        .unwrap();
    assert_eq!(observed.events.len(), 1);
    let worker_cursor = observed.next_cursor;
    let acknowledged = service
        .read_events(ReadEventsRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            authority: target.authority.clone(),
            target: Some(target.clone()),
            participant: participant("participant.worker.reviewer"),
            delivery_capability: capability("capability.inbox.worker"),
            endpoint_fence: Some(endpoint_fence(&target)),
            after: worker_cursor,
            acknowledgement: Some(EventAcknowledgement {
                through: worker_cursor,
                idempotency_key: "ack-conformance".into(),
                acknowledgement_capability: capability("capability.ack.worker"),
            }),
            limit: 10,
        })
        .await
        .unwrap();
    assert!(acknowledged.events.is_empty());

    let completed = service
        .complete(CompleteDispatchRequest {
            schema_version: INTERACTION_SCHEMA_VERSION,
            idempotency_key: "complete-conformance".into(),
            message_id: reference("completion-conformance", InteractionId::new),
            target: target.clone(),
            expected_dispatch_revision: Revision::new(3).unwrap(),
            completed_by: participant("participant.worker.reviewer"),
            endpoint_fence: endpoint_fence(&target),
            audience: audience(vec![(
                "participant.human.coordinator",
                "capability.inbox.coordinator",
                vec!["capability.inbox.coordinator"],
            )]),
            completion_capability: capability("capability.complete.dispatch"),
            title: "conformance complete".into(),
            result_markdown: "Store adapters commit the same canonical result.".into(),
            completed_at_ms: 3_000,
        })
        .await
        .unwrap();
    assert_eq!(completed.dispatch_state, DispatchState::Completed);

    (opened, answered, observed, completed)
}
