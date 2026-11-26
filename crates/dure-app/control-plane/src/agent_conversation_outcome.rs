//! What a chat-runtime Agent's committed conversation says it is doing. A chat
//! runtime has no terminal and no Host state, so its timeline is the one
//! authority for every reader: a schedule deciding whether the agent is idle,
//! and a parent told what its child did. The timeline is provider-neutral, so
//! one reading serves every chat provider.
//!
//! Only committed facts count: the running turn, queued input, open requests,
//! the goal and committed rows. Streamed text belongs to the active turn and is
//! never evidence on its own.
use dure_app::{
    AgentGoalStatusV1, AgentIdV1, AgentInteractionBindingV1, AgentInteractionRequestIdV1,
    AgentPendingRequestKindV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseStateV1,
    AgentTimelineItemBodyV1, AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1,
    AgentTimelineMessageRoleV1, AgentTimelinePageV1, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineStore, DomainStoreErrorV1,
};
use serde_json::{Value, json};

use crate::ServiceState;
use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};

/// How much of a conversation one outcome reading takes. A finished turn's
/// row is the newest; its answer is usually just before it.
pub(crate) const OUTCOME_TAIL_ROWS: usize = 64;

/// What a chat conversation is waiting on, if anything.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConversationAttention {
    None,
    ApprovalRequired,
    InputRequired,
    Error,
}

impl ConversationAttention {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ApprovalRequired => "approval_required",
            Self::InputRequired => "input_required",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConversationActivity {
    pub(crate) working: bool,
    pub(crate) attention: ConversationAttention,
    /// Nothing would continue the conversation on its own: no turn, queued
    /// input, open question or active goal.
    pub(crate) quiescent: bool,
    pub(crate) last_activity_ms: i64,
}

impl ConversationActivity {
    pub(crate) fn from_page(page: &AgentTimelinePageV1) -> Self {
        // Streamed text belongs to the active turn; a stray fragment after
        // the turn ended does not keep a finished agent awake.
        let working = page.active_turn.is_some() || !page.queued_inputs.inputs.is_empty();
        let attention = if page
            .pending_requests
            .iter()
            .any(|pending| pending.request.kind == AgentPendingRequestKindV1::Permission)
        {
            ConversationAttention::ApprovalRequired
        } else if !page.pending_requests.is_empty() {
            ConversationAttention::InputRequired
        } else if !working && page.latest_failure.is_some() {
            ConversationAttention::Error
        } else {
            ConversationAttention::None
        };
        let goal_active = page
            .goal
            .as_ref()
            .is_some_and(|goal| goal.status == AgentGoalStatusV1::Active);
        let last_activity_ms = page
            .rows
            .iter()
            .map(|row| row.item.created_at_ms)
            .chain(
                page.latest_failure
                    .iter()
                    .map(|failure| failure.created_at_ms),
            )
            .fold(page.binding.updated_at_ms, i64::max);
        Self {
            working,
            attention,
            quiescent: !working && page.pending_requests.is_empty() && !goal_active,
            last_activity_ms,
        }
    }

    /// The observation added to a chat occurrence's `runtime`. It rides next
    /// to the `schedule_runtime_not_native` code so a client that predates it
    /// keeps reading the occurrence as before.
    pub(crate) fn observation(&self) -> Value {
        json!({
            "activity": if self.working { "working" } else { "waiting" },
            "attention": self.attention.as_str(),
        })
    }
}

/// The newest finished turn a conversation tail holds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CompletedTurn {
    /// The turn's `TurnCompleted` row.
    pub(crate) item_id: AgentTimelineItemIdV1,
    /// That row's position in the conversation's timeline. It only grows
    /// within one timeline, so a later finished turn has a larger one.
    pub(crate) sequence: i64,
    /// The turn's last assistant message, when the tail holds it.
    pub(crate) final_response: Option<String>,
}

/// One reading of a chat conversation: its activity and the facts that name
/// each outcome exactly, so the same question, failure or finished turn is
/// recognized again however often it is read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConversationOutcome {
    pub(crate) activity: ConversationActivity,
    /// The open request behind the attention: the first permission request,
    /// otherwise the first question.
    pub(crate) attention_id: Option<AgentInteractionRequestIdV1>,
    pub(crate) turn_completed: Option<CompletedTurn>,
    /// The failed turn the conversation last ended on.
    pub(crate) latest_failure: Option<AgentTimelineItemIdV1>,
}

impl ConversationOutcome {
    pub(crate) fn from_page(page: &AgentTimelinePageV1) -> Self {
        let activity = ConversationActivity::from_page(page);
        let attention_id = page
            .pending_requests
            .iter()
            .find(|pending| pending.request.kind == AgentPendingRequestKindV1::Permission)
            .or_else(|| page.pending_requests.first())
            .map(|pending| pending.request.request_id.clone());
        Self {
            activity,
            attention_id,
            turn_completed: completed_turn(page),
            latest_failure: page
                .latest_failure
                .as_ref()
                .map(|failure| failure.item_id.clone()),
        }
    }

    /// What a client polling the conversation is told, such as `dure wait`.
    /// `turnCompletedSequence` is the newest finished turn's position, so a
    /// watcher that saw a smaller one in the same conversation and timeline
    /// knows a turn finished since. It is null when the tail holds no
    /// finished turn.
    pub(crate) fn observation(&self, binding: &AgentInteractionBindingV1) -> Value {
        let mut value = self.activity.observation();
        value["state"] = json!("observed");
        value["interactionSessionId"] = json!(binding.interaction_session_id.as_str());
        value["timelineEpoch"] = json!(binding.timeline_epoch.as_str());
        value["quiescent"] = json!(self.activity.quiescent);
        value["turnCompletedSequence"] = json!(
            self.turn_completed
                .as_ref()
                .map(|turn| turn.sequence.to_string())
        );
        value
    }
}

/// The conversation the Agent runs on now, for a client that polls it. `None`
/// while the Agent runs in a terminal, is between runtimes or has no managed
/// runtime; a stopped chat runtime is `stopped`. A read that failed is
/// `unavailable`, never a state of the agent.
pub(crate) async fn observe_agent(state: &ServiceState, agent_id: &AgentIdV1) -> Option<Value> {
    let observed = {
        let _guard = state.agent_operations.acquire(agent_id).await;
        read_locked(state, agent_id).await
    };
    let binding = match observed {
        Ok(AgentRuntimeObservedV1::Stable { authority, .. }) => match *authority {
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => binding,
            AgentRuntimeBindingAuthorityV1::NativeCli { .. } => return None,
        },
        Ok(AgentRuntimeObservedV1::Closed { close, .. })
            if close.state == AgentRuntimeCloseStateV1::Stopped
                && matches!(
                    close.intent.source_authority,
                    AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }
                ) =>
        {
            return Some(json!({ "state": "stopped" }));
        }
        Ok(_) => return None,
        Err(code) => return Some(json!({ "state": "unavailable", "errorCode": code })),
    };
    match read_tail(state, &binding, OUTCOME_TAIL_ROWS).await {
        Ok(Some(page)) => Some(ConversationOutcome::from_page(&page).observation(&page.binding)),
        // The conversation moved to another runtime since it was selected.
        Ok(None) => None,
        Err(_) => Some(json!({
            "state": "unavailable",
            "errorCode": "agent_conversation_observation_unavailable",
        })),
    }
}

fn completed_turn(page: &AgentTimelinePageV1) -> Option<CompletedTurn> {
    let index = page.rows.iter().rposition(|row| {
        matches!(
            row.item.body,
            AgentTimelineItemBodyV1::Lifecycle {
                state: AgentTimelineLifecycleStateV1::TurnCompleted,
                ..
            }
        )
    })?;
    let completed = &page.rows[index];
    // The answer is the turn's own: the search stops where the turn began,
    // so a turn that only ran tools never reports an earlier turn's text.
    let final_response = page.rows[..index]
        .iter()
        .rev()
        .take_while(|row| !starts_or_ends_turn(&row.item.body))
        .find_map(|row| match &row.item.body {
            AgentTimelineItemBodyV1::Message {
                role: AgentTimelineMessageRoleV1::Assistant,
                markdown,
            } => Some(markdown.clone()),
            _ => None,
        });
    Some(CompletedTurn {
        item_id: completed.item.item_id.clone(),
        sequence: completed.cursor.sequence,
        final_response,
    })
}

fn starts_or_ends_turn(body: &AgentTimelineItemBodyV1) -> bool {
    match body {
        AgentTimelineItemBodyV1::Message { role, .. } => *role == AgentTimelineMessageRoleV1::User,
        AgentTimelineItemBodyV1::Lifecycle { state, .. } => matches!(
            state,
            AgentTimelineLifecycleStateV1::TurnStarted
                | AgentTimelineLifecycleStateV1::TurnCompleted
                | AgentTimelineLifecycleStateV1::TurnFailed
                | AgentTimelineLifecycleStateV1::TurnCanceled
        ),
        _ => false,
    }
}

/// The newest `limit` rows of the binding's conversation, or `None` when the
/// conversation no longer belongs to this exact binding.
pub(crate) async fn read_tail(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
    limit: usize,
) -> Result<Option<AgentTimelinePageV1>, DomainStoreErrorV1> {
    let read = state
        .store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit,
        })
        .await?;
    Ok(match read {
        AgentTimelineReadV1::Page { page }
            if page.binding.interaction_session_id == binding.interaction_session_id
                && page.binding.runtime == binding.runtime =>
        {
            Some(*page)
        }
        _ => None,
    })
}

/// The row of the newest finished turn in the binding's timeline, or `0` when
/// no turn has finished there yet. It grows exactly when a turn finishes, the
/// way a Host's completed-turn count does, so a reader that compares two
/// values counts each finished turn once however long the turn ran. `None`
/// when the conversation has moved on to another timeline.
pub(crate) async fn turn_completed_sequence(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
) -> Result<Option<i64>, DomainStoreErrorV1> {
    Ok(
        match state
            .store
            .latest_agent_turn_completed(&binding.interaction_session_id)
            .await?
        {
            Some(cursor) if cursor.epoch == binding.timeline_epoch => Some(cursor.sequence),
            Some(_) => None,
            None => Some(0),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{
        AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1, AgentInteractionSessionIdV1,
        AgentPendingRequestDraftV1, AgentPendingRequestV1, AgentProviderRuntimeFenceV1,
        AgentQueuedInputPageV1, AgentTimelineActiveTurnV1, AgentTimelineCursorV1,
        AgentTimelineEpochV1, AgentTimelineFailureV1, AgentTimelineItemDraftV1, AgentTimelineRowV1,
        AgentTurnFailureReasonV1, AgentTurnIdV1, ProviderIdV1,
    };

    fn page(bodies: Vec<AgentTimelineItemBodyV1>) -> AgentTimelinePageV1 {
        let binding = AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("conversation-1".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-1".into(),
                provider_epoch: "provider-1".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 10,
            updated_at_ms: 10,
        };
        let rows: Vec<_> = bodies
            .into_iter()
            .enumerate()
            .map(|(index, body)| {
                let sequence = i64::try_from(index).unwrap() + 1;
                AgentTimelineRowV1 {
                    cursor: AgentTimelineCursorV1 {
                        epoch: binding.timeline_epoch.clone(),
                        sequence,
                    },
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new(format!("item-{sequence}")).unwrap(),
                        turn_id: None,
                        client_message_id: None,
                        provider_message_id: None,
                        body,
                        created_at_ms: 20 + sequence,
                    },
                }
            })
            .collect();
        AgentTimelinePageV1 {
            final_cursor: AgentTimelineCursorV1 {
                epoch: binding.timeline_epoch.clone(),
                sequence: i64::try_from(rows.len()).unwrap(),
            },
            rows,
            live_text: Vec::new(),
            pending_requests: Vec::new(),
            active_turn: None,
            latest_failure: None,
            recovery: None,
            goal: None,
            queued_inputs: AgentQueuedInputPageV1 {
                interaction_session_id: binding.interaction_session_id.clone(),
                inputs: Vec::new(),
                next_after: None,
            },
            has_more: false,
            binding,
        }
    }

    fn lifecycle(state: AgentTimelineLifecycleStateV1) -> AgentTimelineItemBodyV1 {
        AgentTimelineItemBodyV1::Lifecycle {
            state,
            detail: None,
        }
    }

    fn message(role: AgentTimelineMessageRoleV1, markdown: &str) -> AgentTimelineItemBodyV1 {
        AgentTimelineItemBodyV1::Message {
            role,
            markdown: markdown.into(),
        }
    }

    fn turn(answer: Option<&str>) -> Vec<AgentTimelineItemBodyV1> {
        let mut rows = vec![
            message(AgentTimelineMessageRoleV1::User, "Fix it"),
            lifecycle(AgentTimelineLifecycleStateV1::TurnStarted),
        ];
        if let Some(answer) = answer {
            rows.push(message(AgentTimelineMessageRoleV1::Assistant, "Looking"));
            rows.push(AgentTimelineItemBodyV1::Reasoning {
                text: "thinking".into(),
            });
            rows.push(message(AgentTimelineMessageRoleV1::Assistant, answer));
        }
        rows.push(lifecycle(AgentTimelineLifecycleStateV1::TurnCompleted));
        rows
    }

    fn pending(
        id: &str,
        kind: AgentPendingRequestKindV1,
        page: &AgentTimelinePageV1,
    ) -> AgentPendingRequestV1 {
        AgentPendingRequestV1 {
            interaction_session_id: page.binding.interaction_session_id.clone(),
            runtime: page.binding.runtime.clone(),
            request: AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new(id).unwrap(),
                kind,
                turn_id: None,
                client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
                payload: json!({}),
                created_at_ms: 40,
            },
        }
    }

    #[test]
    fn a_finished_turn_is_named_by_its_row_and_carries_its_last_answer() {
        let finished = page(turn(Some("Done: https://github.com/o/r/pull/1")));
        let outcome = ConversationOutcome::from_page(&finished);
        assert!(outcome.activity.quiescent);
        assert_eq!(outcome.activity.attention, ConversationAttention::None);
        assert_eq!(
            outcome.turn_completed,
            Some(CompletedTurn {
                item_id: AgentTimelineItemIdV1::new("item-6").unwrap(),
                sequence: 6,
                final_response: Some("Done: https://github.com/o/r/pull/1".into()),
            })
        );
        assert_eq!(outcome.attention_id, None);
        assert_eq!(outcome.latest_failure, None);
    }

    #[test]
    fn a_turn_without_an_answer_never_reports_an_earlier_turns_text() {
        let mut rows = turn(Some("First answer"));
        rows.extend(turn(None));
        let outcome = ConversationOutcome::from_page(&page(rows));
        let completed = outcome.turn_completed.unwrap();
        assert_eq!(completed.item_id.as_str(), "item-9");
        assert_eq!(completed.final_response, None);

        // A tail that starts inside the turn still finds the answer it holds.
        let tail = turn(Some("Answer"))[2..].to_vec();
        assert_eq!(
            ConversationOutcome::from_page(&page(tail))
                .turn_completed
                .unwrap()
                .final_response
                .as_deref(),
            Some("Answer")
        );
    }

    #[test]
    fn a_watcher_sees_the_newest_finished_turn_by_its_position() {
        let mut rows = turn(Some("First answer"));
        rows.extend(turn(Some("Second answer")));
        let finished = page(rows);
        assert_eq!(
            ConversationOutcome::from_page(&finished).observation(&finished.binding),
            json!({
                "state": "observed",
                "interactionSessionId": "interaction-1",
                "timelineEpoch": "timeline-1",
                "activity": "waiting",
                "attention": "none",
                "quiescent": true,
                "turnCompletedSequence": "12",
            })
        );

        // A running turn whose tail holds no finished turn has no position.
        let mut running = page(vec![
            message(AgentTimelineMessageRoleV1::User, "Fix it"),
            lifecycle(AgentTimelineLifecycleStateV1::TurnStarted),
        ]);
        running.active_turn = Some(AgentTimelineActiveTurnV1 {
            turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
        });
        let observed = ConversationOutcome::from_page(&running).observation(&running.binding);
        assert_eq!(observed["activity"], "working");
        assert_eq!(observed["quiescent"], false);
        assert_eq!(observed["turnCompletedSequence"], Value::Null);
    }

    #[test]
    fn an_active_turn_is_working_and_not_quiescent() {
        let mut running = page(turn(Some("Earlier answer")));
        running.active_turn = Some(AgentTimelineActiveTurnV1 {
            turn_id: AgentTurnIdV1::new("turn-2").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-2").unwrap(),
        });
        let outcome = ConversationOutcome::from_page(&running);
        assert!(outcome.activity.working);
        assert!(!outcome.activity.quiescent);
    }

    #[test]
    fn open_requests_name_the_one_a_person_must_answer() {
        let mut asking = page(Vec::new());
        asking.pending_requests = vec![
            pending("question-1", AgentPendingRequestKindV1::Question, &asking),
            pending(
                "permission-2",
                AgentPendingRequestKindV1::Permission,
                &asking,
            ),
        ];
        let outcome = ConversationOutcome::from_page(&asking);
        assert_eq!(
            outcome.activity.attention,
            ConversationAttention::ApprovalRequired
        );
        assert_eq!(outcome.attention_id.unwrap().as_str(), "permission-2");
        assert!(!outcome.activity.quiescent);

        asking.pending_requests.truncate(1);
        let outcome = ConversationOutcome::from_page(&asking);
        assert_eq!(
            outcome.activity.attention,
            ConversationAttention::InputRequired
        );
        assert_eq!(outcome.attention_id.unwrap().as_str(), "question-1");
    }

    #[test]
    fn a_failed_turn_is_named_by_its_failure() {
        let mut failed = page(vec![
            message(AgentTimelineMessageRoleV1::User, "Fix it"),
            lifecycle(AgentTimelineLifecycleStateV1::TurnStarted),
            lifecycle(AgentTimelineLifecycleStateV1::TurnFailed),
        ]);
        failed.latest_failure = Some(AgentTimelineFailureV1 {
            item_id: AgentTimelineItemIdV1::new("item-3").unwrap(),
            created_at_ms: 23,
            reason: AgentTurnFailureReasonV1::ProviderError,
            user_input: Some("Fix it".into()),
        });
        let outcome = ConversationOutcome::from_page(&failed);
        assert_eq!(outcome.activity.attention, ConversationAttention::Error);
        assert_eq!(outcome.latest_failure.unwrap().as_str(), "item-3");
        assert_eq!(outcome.turn_completed, None);
    }
}
