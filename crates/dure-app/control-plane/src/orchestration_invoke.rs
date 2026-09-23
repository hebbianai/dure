use super::*;

pub(crate) async fn invoke_orchestration(
    state: &ServiceState,
    envelope: OrchestrationInvokeBody,
) -> Result<Value, BackendDispatchError> {
    if envelope.api_version != ORCHESTRATION_API_VERSION || !valid_token(&envelope.method) {
        return Err("orchestration_request_invalid".into());
    }
    let method = envelope.method;
    let receipt = match method.as_str() {
        "agent_goal.get" | "agent_goal.put" => {
            crate::agent_goal::invoke(state, &method, &envelope.body).await?
        }
        method if method.starts_with("workflow.graph.") => {
            workflow_graph::invoke(state, method, envelope.body).await?
        }
        "run.create" => {
            let body: RunCreateBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(create_existing_session_run(state, body).await?)
                .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.context.get" => {
            let body: OrchestrationContextGetBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
            if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
                return Err(BackendDispatchError::terminal(
                    "orchestration_request_invalid",
                ));
            }
            serde_json::to_value(resolve_dispatch_context(state, &body.session).await?)
                .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.context.get.batch" => {
            orchestration_context_batch::invoke(state, envelope.body).await?
        }
        "dispatch.session.inspect" => {
            let body: OrchestrationContextGetBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
                return Err("orchestration_request_invalid".into());
            }
            serde_json::to_value(
                state
                    .store
                    .inspect_orchestration_dispatch_session(&body.session)
                    .await
                    .map_err(orchestration_store_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.session.rebind" => {
            let body: OrchestrationDispatchSessionRebindRequestV1 =
                serde_json::from_value(envelope.body)
                    .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            verify_exact_orchestration_session(state, &body.target).await?;
            let target_launch_idempotency_key = if state
                .store
                .orchestration_dispatch_uses_managed_create_key(&body.source)
                .await
                .map_err(orchestration_store_error)?
            {
                Some(exact_managed_create_key(state, &body.target)?)
            } else {
                None
            };
            serde_json::to_value(
                state
                    .store
                    .rebind_orchestration_dispatch_session(
                        &body,
                        target_launch_idempotency_key.as_deref(),
                    )
                    .await
                    .map_err(orchestration_store_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.session.reconcile-rehost" => {
            let body: OrchestrationDispatchSessionReconcileBody =
                serde_json::from_value(envelope.body)
                    .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            reconcile_orchestration_dispatch_session(state, body).await?
        }
        "dispatch.context.get.exact-session" => {
            let body: OrchestrationContextGetBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
            if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
                return Err(BackendDispatchError::terminal(
                    "orchestration_request_invalid",
                ));
            }
            serde_json::to_value(
                exact_orchestration_context(state, &body.session)
                    .await
                    .map_err(BackendDispatchError::stale_as_terminal)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.context" => {
            let body: OrchestrationContextBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            let target = match body.target {
                Some(target) => target,
                None => state
                    .store
                    .orchestration_target_for_exact_session(&body.session)
                    .await
                    .map_err(orchestration_store_error)?,
            };
            let request = OrchestrationDispatchContextRequestV1 {
                schema_version: body.schema_version,
                target,
                session: body.session,
                integration_receipt: body.integration_receipt,
                idempotency_key: body.idempotency_key,
                resolved_at_ms: body.resolved_at_ms,
            };
            let proposal = orchestration_context_proposal(
                &request.target,
                orchestration_session_identity(&request.session)
                    .map_err(orchestration_store_error)?,
                &request.integration_receipt,
            )?;
            serde_json::to_value(
                state
                    .store
                    .negotiate_orchestration_dispatch_context(&request, &proposal)
                    .await
                    .map_err(orchestration_store_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.open" => {
            let request: OpenInteractionRequest = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(
                state
                    .store
                    .interaction_service()
                    .open(request)
                    .await
                    .map_err(orchestration_service_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.message.open.exact-session" => {
            let body: ExactSessionMessageOpenBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(open_exact_session_message(state, body).await?)
                .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.get" => {
            let request: GetInteractionRequest = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(
                state
                    .store
                    .interaction_service()
                    .get(request)
                    .await
                    .map_err(orchestration_service_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.progress" => {
            let request: GetInteractionRequest = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(
                state
                    .store
                    .interaction_service()
                    .progress(request)
                    .await
                    .map_err(orchestration_service_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.answer" => {
            let request: AnswerDecisionRequest = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(
                state
                    .store
                    .interaction_service()
                    .answer(request)
                    .await
                    .map_err(orchestration_service_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "interaction.decision.answer.exact-session" => {
            let body: ExactSessionDecisionAnswerBody = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(answer_exact_session_decision(state, body).await?)
                .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "dispatch.complete" => {
            let request: CompleteDispatchRequest = serde_json::from_value(envelope.body)
                .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
            serde_json::to_value(
                state
                    .store
                    .interaction_service()
                    .complete(request)
                    .await
                    .map_err(orchestration_service_error)?,
            )
            .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?
        }
        "events.read" => orchestration_event_inspection::read(state, envelope.body).await?,
        "events.inspect.exact-session" => {
            orchestration_event_inspection::inspect_exact_session(state, envelope.body).await?
        }
        "events.read.batch" => orchestration_event_batch::invoke(state, envelope.body).await?,
        "events.read.route.batch" => {
            orchestration_event_batch::invoke_route(state, envelope.body).await?
        }
        _ => return Err("orchestration_method_unsupported".into()),
    };
    Ok(json!({
        "schemaVersion": 1,
        "apiVersion": ORCHESTRATION_API_VERSION,
        "method": method,
        "receipt": receipt,
    }))
}
