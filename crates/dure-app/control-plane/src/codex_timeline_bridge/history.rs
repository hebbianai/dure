use super::*;

use crate::codex_app_server_protocol::{thread_turns_page_params, thread_turns_paged};

/// The turn data a resumed thread's history window holds before it stops
/// paging back: the bound one `thread/resume` reply had while it carried the
/// whole thread. A thread that opened in Chat then opens with the same
/// history, and a longer one with its newest history instead of not at all.
pub(crate) const MAX_HISTORY_WINDOW_BYTES: usize = 64 * 1024 * 1024;

/// The turns a resumed thread's history seeds, oldest first.
pub(crate) struct CodexHistoryWindow {
    turns: Vec<Value>,
    /// Older turns precede the window that the timeline does not hold.
    omits_older: bool,
}

impl CodexHistoryWindow {
    pub(crate) fn newest_turn(&self) -> Option<&Value> {
        self.turns.last()
    }
}

impl<S> CodexTimelineBridge<S>
where
    S: AgentTimelineStore + 'static,
{
    /// Seeds the timeline from a `thread/resume` reply (or the driver's
    /// refresh of one) and returns the turns it seeded.
    pub(crate) async fn reconcile_history(
        &self,
        response: Value,
    ) -> Result<CodexHistoryWindow, AgentProviderCommandErrorV1> {
        self.reconcile_history_within(response, MAX_HISTORY_WINDOW_BYTES)
            .await
    }

    pub(super) async fn reconcile_history_within(
        &self,
        mut response: Value,
        max_window_bytes: usize,
    ) -> Result<CodexHistoryWindow, AgentProviderCommandErrorV1> {
        let mut projection = self.read_timeline_projection().await?;
        let paged = thread_turns_paged(&response);
        // The reply's own turns move into the window rather than being copied.
        let whole_thread = match response.pointer_mut("/thread/turns").map(Value::take) {
            Some(Value::Array(turns)) => turns,
            _ => Vec::new(),
        };
        let thread = response.get("thread").unwrap_or(&Value::Null);
        if let Some(title) = thread.get("name").and_then(Value::as_str).map(str::trim)
            && projection.adopt_conversation_title(title)
        {
            let mutation = AgentTimelineMutationV1::Append {
                item: conversation_title_draft(&self.thread_id, title, now_ms()?)?,
            };
            self.commit("thread/history/title", thread, vec![mutation])
                .await?;
        }
        let window = if paged {
            self.paged_history_window(&projection, max_window_bytes)
                .await?
        } else {
            CodexHistoryWindow {
                turns: whole_thread,
                omits_older: false,
            }
        };
        if window.omits_older
            && let Some(oldest) = window.turns.first()
        {
            let start = self.transcript_start(oldest).await?;
            let boundary = if projection.holds_turns() {
                // A window that does not reach the turns the timeline holds
                // follows them behind the gap between them. A view pages the
                // gap only between its two ends, never from the window's
                // start back over the held turns.
                AgentTimelineItemBodyV1::history_gap(
                    self.held_history_gap(&projection, start).await?,
                )
            } else {
                AgentTimelineItemBodyV1::history_window(start)
            };
            self.commit_history_boundary(oldest, boundary).await?;
        }
        for turn in &window.turns {
            let provider_turn_id = field_string(turn, "id")?;
            let provider_turn = provider_turn_identity(provider_turn_id);
            let (client_message_id, turn_id) = projection.history_turn_identity(turn)?;
            let started_at_ms = provider_timestamp_ms(turn, "startedAt")?.unwrap_or(now_ms()?);
            let terminal_state = terminal_turn_state(turn);
            let completed_at_ms =
                provider_timestamp_ms(turn, "completedAt")?.unwrap_or(started_at_ms);
            let turn_context = CodexTurnContext {
                turn_id: turn_id.clone(),
                client_message_id: client_message_id.clone(),
                observed_at_ms: started_at_ms,
            };
            let mut mutations = Vec::new();
            if projection.turn_state(&turn_id).is_none() {
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item_for_turn(
                        provider_turn_id,
                        "history-turn-started",
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: AgentTimelineLifecycleStateV1::TurnStarted,
                            detail: None,
                        },
                        TimelineItemContext {
                            turn_id: Some(turn_id.clone()),
                            client_message_id: Some(client_message_id.clone()),
                            provider_message_id: provider_turn.clone(),
                            created_at_ms: started_at_ms,
                        },
                    )?,
                });
                projection.observe_turn_lifecycle(
                    &turn_id,
                    AgentTimelineLifecycleStateV1::TurnStarted,
                    provider_turn.as_ref(),
                );
            }
            projection
                .turn_by_client_message
                .insert(client_message_id.as_str().into(), turn_id.clone());
            let mut assistant_ordinal = 0;
            let mut reasoning_ordinal = 0;
            for item in turn
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let kind_and_ordinal = match item_type {
                    "agentMessage" => {
                        let ordinal = assistant_ordinal;
                        assistant_ordinal += 1;
                        Some((AgentTimelineTextKindV1::Assistant, ordinal))
                    }
                    "reasoning" => {
                        let ordinal = reasoning_ordinal;
                        reasoning_ordinal += 1;
                        Some((AgentTimelineTextKindV1::Reasoning, ordinal))
                    }
                    _ => None,
                };
                if let Some((kind, ordinal)) = kind_and_ordinal {
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("history-item");
                    let observed_provider = provider_message_id(item_id)?;
                    let canonical_provider = projection.provider_for_history_text(
                        &turn_id,
                        &kind,
                        ordinal,
                        &observed_provider,
                    );
                    mutations.extend(self.reconcile_text_snapshot_with_identity(
                        CodexTextIdentity {
                            item_id,
                            kind,
                            provider_message_id: canonical_provider,
                        },
                        completed_text(item).unwrap_or_default(),
                        &turn_context,
                        terminal_state.is_some(),
                        &mut projection,
                    )?);
                } else {
                    mutations.extend(self.reconcile_history_item(
                        item,
                        &turn_context,
                        terminal_state.is_some(),
                        &mut projection,
                    )?);
                }
            }
            if let Some(state) = terminal_state
                && projection.turn_state(&turn_id) != Some(&state)
            {
                mutations.push(AgentTimelineMutationV1::Append {
                    item: self.item_for_turn(
                        provider_turn_id,
                        "history-turn-completed",
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: state.clone(),
                            // Replay derives the reason from the same turn.error
                            // the live path read, so both rows agree.
                            detail: turn_failure_reason(turn)
                                .map(|reason| reason.as_token().into()),
                        },
                        TimelineItemContext {
                            turn_id: Some(turn_id.clone()),
                            client_message_id: Some(client_message_id.clone()),
                            provider_message_id: provider_turn.clone(),
                            created_at_ms: completed_at_ms,
                        },
                    )?,
                });
                projection.observe_turn_lifecycle(&turn_id, state, provider_turn.as_ref());
            }
            if !mutations.is_empty() {
                self.commit_history_turn(provider_turn_id, turn, mutations)
                    .await?;
            }
        }
        *self.timeline_projection.lock().await = projection;
        self.commit(
            "thread/history/settled",
            &json!({ "threadId": self.thread_id }),
            vec![AgentTimelineMutationV1::SettleHistory {
                settled_at_ms: now_ms()?,
            }],
        )
        .await?;
        Ok(window)
    }

    /// The newest turns of a thread whose reply left them to pages, paged
    /// back from its newest turn until the thread's start, a turn the
    /// timeline already holds, or `max_window_bytes` of turn data. Whole pages
    /// are kept, so one page past the bound is the most a window holds beyond
    /// it.
    async fn paged_history_window(
        &self,
        projection: &CodexTimelineProjection,
        max_window_bytes: usize,
    ) -> Result<CodexHistoryWindow, AgentProviderCommandErrorV1> {
        let mut newest_first = Vec::new();
        let mut window_bytes = 0_usize;
        let mut cursor = None::<String>;
        let mut reached_held_history = false;
        loop {
            let mut page = self
                .client
                .request(
                    "thread/turns/list",
                    thread_turns_page_params(&self.thread_id, cursor.as_deref()),
                )
                .await
                .map_err(provider_client_error)?;
            let Some(Value::Array(turns)) = page.get_mut("data").map(Value::take) else {
                return Err(AgentProviderCommandErrorV1::new(
                    "event_invalid",
                    "missing turns page",
                ));
            };
            for turn in &turns {
                reached_held_history |= projection.holds_turn(turn)?;
                window_bytes = window_bytes.saturating_add(encoded_len(turn));
            }
            newest_first.extend(turns);
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() || reached_held_history || window_bytes >= max_window_bytes {
                break;
            }
        }
        newest_first.reverse();
        Ok(CodexHistoryWindow {
            turns: newest_first,
            omits_older: cursor.is_some() && !reached_held_history,
        })
    }

    /// Where `turn` starts in the thread's rollout, which the backend pages
    /// the history before it from. `None` when this backend cannot find it.
    async fn transcript_start(
        &self,
        turn: &Value,
    ) -> Result<Option<i64>, AgentProviderCommandErrorV1> {
        let Some(home) = self.provider_home.clone() else {
            return Ok(None);
        };
        let thread_id = self.thread_id.clone();
        let turn_id = field_string(turn, "id")?.to_owned();
        let start = tokio::task::spawn_blocking(move || {
            crate::agent_conversation_history::codex_turn_start_cursor(&home, &thread_id, &turn_id)
        })
        .await
        .ok()
        .flatten();
        Ok(start.and_then(|start| i64::try_from(start).ok()))
    }

    /// Where the turns a window leaves out after the ones the timeline holds
    /// lie in the rollout: from where the records of the newest held turn end
    /// to `resumed_at`, where the window starts. `None` when this backend
    /// cannot find either end, or the newest held turn's rows do not name its
    /// provider turn.
    async fn held_history_gap(
        &self,
        projection: &CodexTimelineProjection,
        resumed_at: Option<i64>,
    ) -> Result<Option<(i64, i64)>, AgentProviderCommandErrorV1> {
        let (Some(home), Some(held_turn), Some(resumed_at)) = (
            self.provider_home.clone(),
            projection.newest_provider_turn().map(str::to_owned),
            resumed_at,
        ) else {
            return Ok(None);
        };
        let thread_id = self.thread_id.clone();
        let held_end = tokio::task::spawn_blocking(move || {
            crate::agent_conversation_history::codex_turn_end_cursor(
                &home,
                &thread_id,
                &held_turn,
                u64::try_from(resumed_at).ok()?,
            )
        })
        .await
        .ok()
        .flatten();
        Ok(held_end.and_then(|end| Some((i64::try_from(end).ok()?, resumed_at))))
    }

    /// Marks where a window that left older turns out starts: the existing
    /// boundary row, before the window's oldest turn.
    async fn commit_history_boundary(
        &self,
        oldest: &Value,
        boundary: AgentTimelineItemBodyV1,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let provider_turn_id = field_string(oldest, "id")?;
        let created_at_ms = provider_timestamp_ms(oldest, "startedAt")?.unwrap_or(now_ms()?);
        let item = self.item_for_turn(
            provider_turn_id,
            "history-boundary",
            boundary,
            TimelineItemContext {
                turn_id: None,
                client_message_id: None,
                provider_message_id: None,
                created_at_ms,
            },
        )?;
        self.commit(
            "thread/history/boundary",
            &json!({ "threadId": self.thread_id, "turnId": provider_turn_id }),
            vec![AgentTimelineMutationV1::Append { item }],
        )
        .await
    }

    async fn commit_history_turn(
        &self,
        provider_turn_id: &str,
        turn: &Value,
        mutations: Vec<AgentTimelineMutationV1>,
    ) -> Result<(), AgentProviderCommandErrorV1> {
        let turn_fingerprint = source_fingerprint("thread/history/turn", turn);
        let mut remaining = mutations.into_iter();
        for chunk_index in 0_u64.. {
            let chunk = remaining
                .by_ref()
                .take(MAX_AGENT_TIMELINE_EVENT_MUTATIONS_V1)
                .collect::<Vec<_>>();
            if chunk.is_empty() {
                return Ok(());
            }
            self.commit(
                "thread/history/turn",
                &json!({
                    "threadId": self.thread_id,
                    "turnId": provider_turn_id,
                    "turnFingerprint": turn_fingerprint,
                    "chunkIndex": chunk_index,
                }),
                chunk,
            )
            .await?;
        }
        unreachable!("history chunk index exhausted")
    }

    async fn read_timeline_projection(
        &self,
    ) -> Result<CodexTimelineProjection, AgentProviderCommandErrorV1> {
        let mut rows = Vec::<AgentTimelineRowV1>::new();
        let mut live_text = Vec::<AgentTimelineLiveTextV1>::new();
        let mut direction = AgentTimelineReadDirectionV1::Tail;
        let mut cursor = None;
        loop {
            let read = self
                .service
                .read(&AgentTimelineReadRequestV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: self.binding.interaction_session_id.clone(),
                    direction,
                    cursor,
                    limit: MAX_AGENT_TIMELINE_PAGE_ITEMS_V1,
                })
                .await
                .map_err(conversation_error)?;
            let AgentTimelineReadV1::Page { page } = read else {
                return Err(AgentProviderCommandErrorV1::new(
                    "codex_timeline_store",
                    "timeline epoch changed during history reconciliation",
                ));
            };
            live_text.extend(page.live_text);
            rows.extend(page.rows.iter().cloned());
            if !page.has_more || page.rows.is_empty() {
                break;
            }
            direction = AgentTimelineReadDirectionV1::Before;
            cursor = page.rows.first().map(|row| row.cursor.clone());
        }
        rows.sort_by_key(|row| row.cursor.sequence);
        let mut projection = CodexTimelineProjection::default();
        for row in &rows {
            projection.absorb_row(row);
        }
        for live in &live_text {
            projection.absorb_live_text(live);
        }
        Ok(projection)
    }

    pub(super) fn reconcile_history_item(
        &self,
        item: &Value,
        context: &CodexTurnContext,
        terminal_turn: bool,
        projection: &mut CodexTimelineProjection,
    ) -> Result<Vec<AgentTimelineMutationV1>, AgentProviderCommandErrorV1> {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("history-item");
        let provider_message_id = provider_message_id(item_id)?;
        let provider_key = provider_message_id.as_str().to_owned();
        match item_type {
            "userMessage" => {
                let markdown = item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|input| input.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if markdown.is_empty() {
                    return Ok(Vec::new());
                }
                let item_client_message_id = item
                    .get("clientId")
                    .and_then(Value::as_str)
                    .and_then(|id| AgentClientMessageIdV1::new(id.to_owned()).ok())
                    .unwrap_or_else(|| context.client_message_id.clone());
                if projection
                    .client_messages
                    .contains(item_client_message_id.as_str())
                    || projection.provider_items.contains(&provider_key)
                {
                    return Ok(Vec::new());
                }
                projection
                    .client_messages
                    .insert(item_client_message_id.as_str().into());
                projection.provider_items.insert(provider_key);
                Ok(vec![AgentTimelineMutationV1::Append {
                    item: self.item_for_turn(
                        item_id,
                        "history-user-message",
                        AgentTimelineItemBodyV1::Message {
                            role: AgentTimelineMessageRoleV1::User,
                            markdown,
                        },
                        TimelineItemContext {
                            turn_id: Some(context.turn_id.clone()),
                            client_message_id: Some(item_client_message_id),
                            provider_message_id: Some(provider_message_id),
                            created_at_ms: context.observed_at_ms,
                        },
                    )?,
                }])
            }
            "agentMessage" | "reasoning" => self.reconcile_text_snapshot(
                item_id,
                item_type,
                completed_text(item).unwrap_or_default(),
                context,
                terminal_turn,
                projection,
            ),
            "plan" if !projection.provider_items.contains(&provider_key) => {
                projection.provider_items.insert(provider_key);
                Ok(vec![AgentTimelineMutationV1::Append {
                    item: self.item_for_turn(
                        item_id,
                        "history-plan",
                        AgentTimelineItemBodyV1::Plan {
                            value: compact_value(item, 32 * 1024),
                        },
                        TimelineItemContext {
                            turn_id: Some(context.turn_id.clone()),
                            client_message_id: Some(context.client_message_id.clone()),
                            provider_message_id: Some(provider_message_id),
                            created_at_ms: context.observed_at_ms,
                        },
                    )?,
                }])
            }
            _ if is_tool_item(item) => {
                let desired = snapshot_tool_state(item, terminal_turn)?;
                let candidate = self.tool_item(
                    item,
                    desired,
                    Some(context.turn_id.clone()),
                    Some(context.client_message_id.clone()),
                    context.observed_at_ms,
                )?;
                if !should_append_tool_snapshot(
                    projection.tools.get(&provider_key),
                    &candidate.body,
                )? {
                    return Ok(Vec::new());
                }
                projection.provider_items.insert(provider_key.clone());
                projection
                    .tools
                    .insert(provider_key, candidate.body.clone());
                Ok(vec![AgentTimelineMutationV1::Append { item: candidate }])
            }
            _ => Ok(Vec::new()),
        }
    }

    pub(super) fn reconcile_text_snapshot(
        &self,
        item_id: &str,
        item_type: &str,
        snapshot_text: String,
        context: &CodexTurnContext,
        terminal: bool,
        projection: &mut CodexTimelineProjection,
    ) -> Result<Vec<AgentTimelineMutationV1>, AgentProviderCommandErrorV1> {
        let kind = if item_type == "agentMessage" {
            AgentTimelineTextKindV1::Assistant
        } else {
            AgentTimelineTextKindV1::Reasoning
        };
        let provider_message_id = provider_message_id(item_id)?;
        self.reconcile_text_snapshot_with_identity(
            CodexTextIdentity {
                item_id,
                kind,
                provider_message_id,
            },
            snapshot_text,
            context,
            terminal,
            projection,
        )
    }

    fn reconcile_text_snapshot_with_identity(
        &self,
        identity: CodexTextIdentity<'_>,
        snapshot_text: String,
        context: &CodexTurnContext,
        terminal: bool,
        projection: &mut CodexTimelineProjection,
    ) -> Result<Vec<AgentTimelineMutationV1>, AgentProviderCommandErrorV1> {
        let CodexTextIdentity {
            item_id,
            kind,
            provider_message_id,
        } = identity;
        let provider_key = provider_message_id.as_str().to_owned();
        projection.provider_items.insert(provider_key.clone());
        projection.remember_text_provider(Some(&context.turn_id), &provider_message_id);
        let existing = projection.text.remove(&provider_key);
        let mut mutations = Vec::new();
        match existing {
            Some(ProjectedText::Completed {
                kind: existing_kind,
                text: existing_text,
            }) => {
                if kind == AgentTimelineTextKindV1::Assistant
                    && (existing_kind != kind || existing_text != snapshot_text)
                {
                    return Err(history_conflict(
                        "completed assistant text differs from the Codex thread snapshot",
                    ));
                }
                projection.text.insert(
                    provider_key,
                    ProjectedText::Completed {
                        kind: existing_kind,
                        text: existing_text,
                    },
                );
            }
            Some(ProjectedText::Live(mut streams)) => {
                if kind == AgentTimelineTextKindV1::Reasoning {
                    if terminal {
                        let text = streams
                            .values()
                            .filter(|stream| stream.kind == kind)
                            .map(|stream| stream.text.as_str())
                            .filter(|text| !text.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        mutations.push(AgentTimelineMutationV1::FinishTextForProviderMessage {
                            provider_message_id,
                            finished_at_ms: context.observed_at_ms,
                        });
                        projection
                            .text
                            .insert(provider_key, ProjectedText::Completed { kind, text });
                    } else {
                        projection
                            .text
                            .insert(provider_key, ProjectedText::Live(streams));
                    }
                    return Ok(mutations);
                }
                let matching = streams
                    .iter()
                    .filter(|(_, stream)| stream.kind == kind)
                    .map(|(key, stream)| (key.clone(), stream.clone()))
                    .collect::<Vec<_>>();
                if matching.len() != 1 {
                    return Err(history_conflict(
                        "assistant snapshot does not have one canonical live stream",
                    ));
                }
                let (stream_key, mut live) = matching
                    .into_iter()
                    .next()
                    .expect("one matching stream was proven");
                let plan = assistant_text_plan(&live.text, &snapshot_text, terminal)?;
                if !plan.suffix.is_empty() {
                    mutations.push(AgentTimelineMutationV1::AppendText {
                        fragment: AgentTimelineTextFragmentV1 {
                            stream_id: live.stream_id.clone(),
                            item_id: live.item_id.clone(),
                            kind: live.kind.clone(),
                            fragment: plan.suffix.clone(),
                            turn_id: live.turn_id.clone(),
                            client_message_id: live.client_message_id.clone(),
                            provider_message_id: live.provider_message_id.clone(),
                            observed_at_ms: context.observed_at_ms,
                        },
                    });
                    live.text.push_str(&plan.suffix);
                    live.updated_at_ms = live.updated_at_ms.max(context.observed_at_ms);
                    streams.insert(stream_key, live.clone());
                }
                if plan.finish {
                    mutations.push(AgentTimelineMutationV1::FinishTextForProviderMessage {
                        provider_message_id,
                        finished_at_ms: context.observed_at_ms,
                    });
                    projection.text.insert(
                        provider_key,
                        ProjectedText::Completed {
                            kind,
                            text: plan.final_text,
                        },
                    );
                } else {
                    projection
                        .text
                        .insert(provider_key, ProjectedText::Live(streams));
                }
            }
            None if snapshot_text.is_empty() => {}
            None => {
                let method = text_delta_method(&kind);
                let fragment = AgentTimelineTextFragmentV1 {
                    stream_id: timeline_stream_id(item_id, method)?,
                    item_id: timeline_item_id(item_id, method)?,
                    kind: kind.clone(),
                    fragment: snapshot_text.clone(),
                    turn_id: Some(context.turn_id.clone()),
                    client_message_id: Some(context.client_message_id.clone()),
                    provider_message_id: provider_message_id.clone(),
                    observed_at_ms: context.observed_at_ms,
                };
                mutations.push(AgentTimelineMutationV1::AppendText {
                    fragment: fragment.clone(),
                });
                if terminal {
                    mutations.push(AgentTimelineMutationV1::FinishTextForProviderMessage {
                        provider_message_id,
                        finished_at_ms: context.observed_at_ms,
                    });
                    projection.text.insert(
                        provider_key,
                        ProjectedText::Completed {
                            kind,
                            text: snapshot_text,
                        },
                    );
                } else {
                    projection.text.insert(
                        provider_key,
                        ProjectedText::Live(BTreeMap::from([(
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
                        )])),
                    );
                }
            }
        }
        Ok(mutations)
    }
}
