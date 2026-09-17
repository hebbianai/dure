use super::*;

impl<S> AgentProviderCommands for CodexTimelineBridge<S>
where
    S: AgentTimelineStore + 'static,
{
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            {
                let mut active = self.active_turn.lock().await;
                if !self.accepting_turns.load(Ordering::SeqCst) {
                    return Err(AgentProviderCommandErrorV1::new(
                        "runtime_draining",
                        "Codex app-server is switching runtimes",
                    ));
                }
                if active.is_some() {
                    return Err(AgentProviderCommandErrorV1::new(
                        "turn_busy",
                        "Codex already has an active turn",
                    ));
                }
                *active = Some(ActiveTurn {
                    turn_id: intent.turn_id.clone(),
                    client_message_id: intent.client_message_id.clone(),
                    provider_turn_id: None,
                });
            }
            let response = self
                .client
                .request(
                    "turn/start",
                    self.settings.turn_start_params(&self.thread_id, intent),
                )
                .await;
            match response {
                Ok(response) => {
                    if let Some(provider_turn_id) =
                        response.pointer("/turn/id").and_then(Value::as_str)
                        && let Some(turn) = self.active_turn.lock().await.as_mut()
                    {
                        turn.provider_turn_id = Some(provider_turn_id.into());
                    }
                    self.establish_thread(now_ms()?).await?;
                    Ok(response)
                }
                Err(error) => {
                    self.active_turn.lock().await.take();
                    Err(provider_client_error(error))
                }
            }
        })
    }

    fn steer_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let active = self.active_turn.lock().await.clone().ok_or_else(|| {
                AgentProviderCommandErrorV1::new("turn_not_active", "Codex has no active turn")
            })?;
            if active.turn_id != intent.turn_id {
                return Err(AgentProviderCommandErrorV1::new(
                    "stale_turn",
                    "Codex active turn does not match the steering request",
                ));
            }
            let provider_turn_id = active.provider_turn_id.ok_or_else(|| {
                AgentProviderCommandErrorV1::new("turn_not_ready", "Codex turn has no provider id")
            })?;
            self.client
                .request(
                    "turn/steer",
                    json!({
                        "threadId": self.thread_id,
                        "expectedTurnId": provider_turn_id,
                        "clientUserMessageId": intent.client_message_id,
                        "input": [{ "type": "text", "text": intent.input, "text_elements": [] }],
                    }),
                )
                .await
                .map_err(provider_client_error)
        })
    }

    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let route = request
                .request
                .payload
                .get("providerRequest")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    AgentProviderCommandErrorV1::new("answer_invalid", "missing Codex route")
                })?;
            let id = route.get("id").cloned().ok_or_else(|| {
                AgentProviderCommandErrorV1::new("answer_invalid", "missing Codex request id")
            })?;
            let method = route.get("method").and_then(Value::as_str).ok_or_else(|| {
                AgentProviderCommandErrorV1::new("answer_invalid", "missing Codex method")
            })?;
            let params = route.get("params").cloned().unwrap_or_else(|| json!({}));
            let result = pending_response(method, &params, &intent.answer)?;
            let provider_key = provider_request_key(&id);
            let (delivered, delivered_receipt) = watch::channel(false);
            let (confirmed, confirmation) = oneshot::channel();
            {
                let mut routes = self.pending_routes.lock().await;
                let live = routes.get_mut(&provider_key).ok_or_else(|| {
                    AgentProviderCommandErrorV1::new(
                        "answer_stale",
                        "Codex request is not live on this connection",
                    )
                })?;
                if live.request_id != intent.request_id
                    || request.request.request_id != intent.request_id
                    || live.answer.is_some()
                {
                    return Err(AgentProviderCommandErrorV1::new(
                        "answer_stale",
                        "Codex request route does not match this answer",
                    ));
                }
                live.answer = Some(PendingAnswerFlight {
                    delivered: delivered_receipt,
                    confirmed,
                    idempotency_key: intent.idempotency_key.clone(),
                    provider_receipt: result.clone(),
                });
            }
            let mut confirmation_guard = PendingConfirmationGuard::new(&self.client);
            if let Err(error) = self
                .client
                .respond_with_delivery(id.clone(), Ok(result.clone()), Some(delivered))
                .await
            {
                let mut routes = self.pending_routes.lock().await;
                if routes.get(&provider_key).is_some_and(|route| {
                    route
                        .answer
                        .as_ref()
                        .is_some_and(|answer| answer.idempotency_key == intent.idempotency_key)
                }) {
                    routes.remove(&provider_key);
                }
                return Err(provider_client_error(error));
            }
            let mut confirmation = confirmation;
            match timeout(PENDING_RESOLUTION_TIMEOUT, &mut confirmation).await {
                Ok(Ok(())) => {
                    confirmation_guard.disarm();
                    Ok(result)
                }
                Ok(Err(_)) => Err(AgentProviderCommandErrorV1::new(
                    "answer_unconfirmed",
                    "Codex request confirmation was interrupted",
                )),
                Err(_) => {
                    let claimed = {
                        let mut routes = self.pending_routes.lock().await;
                        if routes.get(&provider_key).is_some_and(|route| {
                            route.answer.as_ref().is_some_and(|answer| {
                                answer.idempotency_key == intent.idempotency_key
                            })
                        }) {
                            routes.remove(&provider_key);
                            true
                        } else {
                            false
                        }
                    };
                    if claimed {
                        self.client.disconnect();
                        Err(AgentProviderCommandErrorV1::new(
                            "answer_unconfirmed",
                            "Codex did not confirm that the request is no longer pending",
                        ))
                    } else {
                        confirmation_guard.disarm();
                        confirmation.await.map(|()| result).map_err(|_| {
                            AgentProviderCommandErrorV1::new(
                                "answer_unconfirmed",
                                "Codex request confirmation was interrupted",
                            )
                        })
                    }
                }
            }
        })
    }

    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.exact_binding(binding)?;
            let active = self.active_turn.lock().await.clone().ok_or_else(|| {
                AgentProviderCommandErrorV1::new("turn_not_active", "Codex has no active turn")
            })?;
            if active.turn_id != request.turn_id
                || active.client_message_id != request.client_message_id
            {
                return Err(AgentProviderCommandErrorV1::new(
                    "stale_turn",
                    "Codex active turn does not match the interrupt",
                ));
            }
            let provider_turn_id = active.provider_turn_id.ok_or_else(|| {
                AgentProviderCommandErrorV1::new("turn_not_ready", "Codex turn has no provider id")
            })?;
            self.client
                .request(
                    "turn/interrupt",
                    json!({ "threadId": self.thread_id, "turnId": provider_turn_id }),
                )
                .await
                .map_err(provider_client_error)
        })
    }
}
