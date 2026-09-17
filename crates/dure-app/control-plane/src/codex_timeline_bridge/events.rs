use super::*;

impl<S> CodexTimelineBridge<S>
where
    S: AgentTimelineStore + 'static,
{
    pub(super) async fn handle_incoming(
        &self,
        event: JsonRpcSocketIncomingV1,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        if event.id.is_some() {
            return self.handle_server_request(event).await;
        }
        self.handle_notification(&event.method, &event.params).await
    }

    async fn handle_server_request(
        &self,
        event: JsonRpcSocketIncomingV1,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let Some(id) = event.id.clone() else {
            return Ok(());
        };
        let kind = match event.method.as_str() {
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => AgentPendingRequestKindV1::Permission,
            "item/tool/requestUserInput" => AgentPendingRequestKindV1::Question,
            "mcpServer/elicitation/request" if is_mcp_tool_approval(&event.params) => {
                AgentPendingRequestKindV1::Permission
            }
            _ => {
                self.client
                    .respond(
                        id,
                        Err(JsonRpcSocketClientError {
                            code: "unsupported_server_request".into(),
                            detail: format!("unsupported app-server request: {}", event.method),
                        }),
                    )
                    .await
                    .map_err(provider_client_error)?;
                return Ok(());
            }
        };
        let Some(active) = self.active_turn.lock().await.clone() else {
            self.client
                .respond(
                    id,
                    Err(JsonRpcSocketClientError {
                        code: "turn_unavailable".into(),
                        detail: "app-server request has no active turn".into(),
                    }),
                )
                .await
                .map_err(provider_client_error)?;
            return Ok(());
        };
        let Some(request_thread_id) = event.params.get("threadId").and_then(Value::as_str) else {
            self.client
                .respond(
                    id,
                    Err(JsonRpcSocketClientError {
                        code: "thread_unavailable".into(),
                        detail: "app-server request has no thread identity".into(),
                    }),
                )
                .await
                .map_err(provider_client_error)?;
            return Ok(());
        };
        if request_thread_id == self.thread_id
            && !provider_turn_matches(&active, event.params.get("turnId").and_then(Value::as_str))
        {
            self.client
                .respond(
                    id,
                    Err(JsonRpcSocketClientError {
                        code: "turn_unavailable".into(),
                        detail: "app-server request belongs to a stale turn".into(),
                    }),
                )
                .await
                .map_err(provider_client_error)?;
            return Ok(());
        }
        // Child agents share the root app-server connection. Their supported
        // approvals are surfaced through the root pending-request UI, but
        // their notifications never mutate the root turn or transcript.
        let request_id =
            match interaction_request_id(&self.connection_generation, &event.method, &id) {
                Ok(request_id) => request_id,
                Err(error) => {
                    self.client
                        .respond(
                            id,
                            Err(JsonRpcSocketClientError {
                                code: error.code,
                                detail: error.detail,
                            }),
                        )
                        .await
                        .map_err(provider_client_error)?;
                    return Ok(());
                }
            };
        let mut payload = normalized_pending_payload(&event.method, &id, &event.params);
        if let Some(input) = self.timeline_projection.lock().await.file_approval_input(
            &self.thread_id,
            &event.method,
            &event.params,
        ) {
            payload["input"] = input.clone();
        }
        let created_at_ms = event
            .params
            .get("startedAtMs")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| now_ms().unwrap_or(0));
        let mutation = AgentTimelineMutationV1::PutPending {
            request: AgentPendingRequestDraftV1 {
                request_id: request_id.clone(),
                kind,
                turn_id: Some(active.turn_id),
                client_message_id: active.client_message_id,
                payload,
                created_at_ms,
            },
        };
        let provider_key = provider_request_key(&id);
        {
            let mut routes = self.pending_routes.lock().await;
            if routes.contains_key(&provider_key) {
                return Err(AgentProviderCommandErrorV1::new(
                    "request_conflict",
                    "Codex reused a live server request ID",
                ));
            }
            routes.insert(
                provider_key.clone(),
                PendingRoute {
                    request_id: request_id.clone(),
                    answer: None,
                },
            );
        }
        if let Err(error) = self
            .commit(&event.method, &event.params, vec![mutation])
            .await
        {
            self.pending_routes.lock().await.remove(&provider_key);
            let _ = self
                .client
                .respond(
                    id,
                    Err(JsonRpcSocketClientError {
                        code: error.code.clone(),
                        detail: error.detail.clone(),
                    }),
                )
                .await;
            return Err(error);
        }
        Ok(())
    }

    async fn handle_notification(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let observed_at_ms = now_ms()?;
        let active = self.active_turn.lock().await.clone();
        if method != "serverRequest/resolved"
            && !notification_belongs_to_thread(method, params, &self.thread_id)
        {
            return Ok(());
        }
        if notification_turn_id(method, params).is_some()
            && active.as_ref().is_none_or(|turn| {
                !provider_turn_matches(turn, notification_turn_id(method, params))
            })
        {
            return Ok(());
        }
        let (turn_id, client_message_id) = active
            .as_ref()
            .map(|turn| {
                (
                    Some(turn.turn_id.clone()),
                    Some(turn.client_message_id.clone()),
                )
            })
            .unwrap_or((None, None));
        if method == "turn/started" {
            self.establish_thread(observed_at_ms).await?;
        }
        let mut projection = self.timeline_projection.lock().await;
        let mut mutations = Vec::new();
        match method {
            "thread/started" | "thread/status/changed" | "thread/tokenUsage/updated" => {
                return Ok(());
            }
            "thread/name/updated" => {
                if let Some(title) = params
                    .get("threadName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    && projection.adopt_conversation_title(title)
                {
                    mutations.push(AgentTimelineMutationV1::Append {
                        item: conversation_title_draft(&self.thread_id, title, observed_at_ms)?,
                    });
                }
            }
            "serverRequest/resolved" => {
                let Some(provider_request_id) = params.get("requestId") else {
                    return Ok(());
                };
                let Some(route) = self
                    .pending_routes
                    .lock()
                    .await
                    .remove(&provider_request_key(provider_request_id))
                else {
                    return Ok(());
                };
                if let Some(answer) = route.answer {
                    if *answer.delivered.borrow() {
                        self.service
                            .complete_pending_answer_success(
                                &answer.idempotency_key,
                                &self.binding.interaction_session_id,
                                answer.provider_receipt,
                            )
                            .await
                            .map_err(conversation_error)?;
                        let _ = answer.confirmed.send(());
                        return Ok(());
                    }
                    self.client.disconnect();
                }
                mutations.push(AgentTimelineMutationV1::CancelPending {
                    request_id: route.request_id,
                    reason: "provider_cleared".into(),
                    canceled_at_ms: observed_at_ms,
                });
            }
            "turn/started" => {
                if let Some(provider_turn_id) = params.pointer("/turn/id").and_then(Value::as_str)
                    && let Some(turn) = self.active_turn.lock().await.as_mut()
                {
                    turn.provider_turn_id = Some(provider_turn_id.to_owned());
                }
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item(
                        "turn-started",
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: AgentTimelineLifecycleStateV1::TurnStarted,
                            detail: None,
                        },
                        turn_id.clone(),
                        client_message_id.clone(),
                        None,
                        observed_at_ms,
                    )?,
                });
                if let (Some(turn_id), Some(client_message_id)) =
                    (turn_id.as_ref(), client_message_id.as_ref())
                {
                    projection
                        .turn_by_client_message
                        .insert(client_message_id.as_str().into(), turn_id.clone());
                    projection.turn_lifecycle.insert(
                        turn_id.as_str().into(),
                        AgentTimelineLifecycleStateV1::TurnStarted,
                    );
                }
            }
            "turn/completed" => {
                if let (Some(turn), Some(turn_id), Some(client_message_id)) = (
                    params.get("turn"),
                    turn_id.as_ref(),
                    client_message_id.as_ref(),
                ) {
                    let completed_at_ms =
                        provider_timestamp_ms(turn, "completedAt")?.unwrap_or(observed_at_ms);
                    let context = CodexTurnContext {
                        turn_id: turn_id.clone(),
                        client_message_id: client_message_id.clone(),
                        observed_at_ms: completed_at_ms,
                    };
                    for item in turn
                        .get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        mutations.extend(self.reconcile_history_item(
                            item,
                            &context,
                            true,
                            &mut projection,
                        )?);
                    }
                }
                let state = match params.pointer("/turn/status").and_then(Value::as_str) {
                    Some("completed") => AgentTimelineLifecycleStateV1::TurnCompleted,
                    Some("interrupted") => AgentTimelineLifecycleStateV1::TurnCanceled,
                    _ => AgentTimelineLifecycleStateV1::TurnFailed,
                };
                // A failed turn keeps why it failed as the shared reason token;
                // the composer keys its recovery on this, never on prose.
                let failure_reason = params.get("turn").and_then(turn_failure_reason);
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item(
                        "turn-completed",
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: state.clone(),
                            detail: failure_reason.map(|reason| reason.as_token().into()),
                        },
                        turn_id.clone(),
                        client_message_id,
                        None,
                        observed_at_ms,
                    )?,
                });
                if let Some(turn_id) = turn_id.as_ref() {
                    projection
                        .turn_lifecycle
                        .insert(turn_id.as_str().into(), state);
                }
            }
            "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta" => {
                let item_id = field_string(params, "itemId")?;
                let provider_message_id = provider_message_id(item_id)?;
                let provider_key = provider_message_id.as_str().to_owned();
                let kind = if method == "item/agentMessage/delta" {
                    AgentTimelineTextKindV1::Assistant
                } else {
                    AgentTimelineTextKindV1::Reasoning
                };
                projection.remember_text_provider(turn_id.as_ref(), &provider_message_id);
                if matches!(
                    projection.text.get(&provider_key),
                    Some(ProjectedText::Completed { .. })
                ) {
                    return Ok(());
                }
                let fragment = AgentTimelineTextFragmentV1 {
                    stream_id: timeline_stream_id(item_id, method)?,
                    item_id: timeline_item_id(item_id, method)?,
                    kind,
                    fragment: field_string(params, "delta")?.into(),
                    turn_id,
                    client_message_id,
                    provider_message_id,
                    observed_at_ms,
                };
                mutations.push(AgentTimelineMutationV1::AppendText {
                    fragment: fragment.clone(),
                });
                let streams = match projection.text.entry(provider_key.clone()) {
                    std::collections::btree_map::Entry::Occupied(entry) => match entry.into_mut() {
                        ProjectedText::Live(streams) => streams,
                        ProjectedText::Completed { .. } => unreachable!("handled above"),
                    },
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        let ProjectedText::Live(streams) =
                            entry.insert(ProjectedText::Live(BTreeMap::new()))
                        else {
                            unreachable!("inserted a live projection")
                        };
                        streams
                    }
                };
                if let Some(live) = streams.get_mut(fragment.stream_id.as_str()) {
                    if live.item_id != fragment.item_id
                        || live.kind != fragment.kind
                        || live.turn_id != fragment.turn_id
                        || live.client_message_id != fragment.client_message_id
                        || live.provider_message_id != fragment.provider_message_id
                    {
                        return Err(history_conflict(
                            "Codex text stream metadata changed after hydration",
                        ));
                    }
                    live.text.push_str(&fragment.fragment);
                    live.updated_at_ms = live.updated_at_ms.max(observed_at_ms);
                } else {
                    streams.insert(
                        fragment.stream_id.as_str().into(),
                        AgentTimelineLiveTextV1 {
                            stream_id: fragment.stream_id,
                            item_id: fragment.item_id,
                            kind: fragment.kind,
                            text: fragment.fragment,
                            turn_id: fragment.turn_id,
                            client_message_id: fragment.client_message_id,
                            provider_message_id: fragment.provider_message_id,
                            updated_at_ms: fragment.observed_at_ms,
                        },
                    );
                }
                projection.provider_items.insert(provider_key);
            }
            "turn/plan/updated" => {
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item(
                        "plan-updated",
                        AgentTimelineItemBodyV1::Plan {
                            value: json!({
                                "explanation": params.get("explanation"),
                                "steps": params.get("plan"),
                            }),
                        },
                        turn_id,
                        client_message_id,
                        None,
                        observed_at_ms,
                    )?,
                });
            }
            "item/started" => {
                if let Some(item) = params.get("item")
                    && is_tool_item(item)
                {
                    let provider_key = provider_message_id(field_string(item, "id")?)?
                        .as_str()
                        .to_owned();
                    let candidate = self.tool_item(
                        item,
                        AgentTimelineToolStateV1::Running,
                        turn_id,
                        client_message_id,
                        observed_at_ms,
                    )?;
                    if should_append_tool_snapshot(
                        projection.tools.get(&provider_key),
                        &candidate.body,
                    )? {
                        projection.provider_items.insert(provider_key.clone());
                        projection
                            .tools
                            .insert(provider_key, candidate.body.clone());
                        mutations.push(AgentTimelineMutationV1::Append { item: candidate });
                    }
                }
            }
            "item/completed" => {
                if let Some(item) = params.get("item") {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                    match item_type {
                        "agentMessage" | "reasoning" => {
                            if let (Some(turn_id), Some(client_message_id)) =
                                (turn_id.as_ref(), client_message_id.as_ref())
                            {
                                let context = CodexTurnContext {
                                    turn_id: turn_id.clone(),
                                    client_message_id: client_message_id.clone(),
                                    observed_at_ms,
                                };
                                mutations.extend(self.reconcile_text_snapshot(
                                    item_id,
                                    item_type,
                                    completed_text(item).unwrap_or_default(),
                                    &context,
                                    true,
                                    &mut projection,
                                )?);
                            }
                        }
                        "plan" => {
                            mutations.push(AgentTimelineMutationV1::Append {
                                item: self.item(
                                    item_id,
                                    AgentTimelineItemBodyV1::Plan {
                                        value: item.clone(),
                                    },
                                    turn_id,
                                    client_message_id,
                                    None,
                                    observed_at_ms,
                                )?,
                            });
                        }
                        _ if is_tool_item(item) => {
                            let provider_key = provider_message_id(field_string(item, "id")?)?
                                .as_str()
                                .to_owned();
                            let candidate = self.tool_item(
                                item,
                                snapshot_tool_state(item, true)?,
                                turn_id,
                                client_message_id,
                                observed_at_ms,
                            )?;
                            if should_append_tool_snapshot(
                                projection.tools.get(&provider_key),
                                &candidate.body,
                            )? {
                                projection.provider_items.insert(provider_key.clone());
                                projection
                                    .tools
                                    .insert(provider_key, candidate.body.clone());
                                mutations.push(AgentTimelineMutationV1::Append { item: candidate });
                            }
                        }
                        _ => {}
                    }
                }
            }
            "error" => {
                let message = params
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server error");
                // The row's code is the classified reason when the app-server
                // provided one, so the transcript and the turn footer agree.
                let code = params
                    .get("error")
                    .and_then(codex_error_reason)
                    .map_or("codex_app_server_error", |reason| reason.as_token());
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item(
                        "error",
                        AgentTimelineItemBodyV1::Error {
                            code: code.into(),
                            message: message.into(),
                        },
                        turn_id,
                        client_message_id,
                        None,
                        observed_at_ms,
                    )?,
                });
            }
            _ => return Ok(()),
        }
        if mutations.is_empty() {
            return Ok(());
        }
        self.commit(method, params, mutations).await?;
        if method == "turn/completed" {
            self.active_turn.lock().await.take();
        }
        Ok(())
    }
}
