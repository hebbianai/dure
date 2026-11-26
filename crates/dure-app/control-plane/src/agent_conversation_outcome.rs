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
    AgentGoalStatusV1, AgentInteractionBindingV1, AgentInteractionRequestIdV1,
    AgentPendingRequestKindV1, AgentTimelineItemBodyV1, AgentTimelineItemIdV1,
    AgentTimelineLifecycleStateV1, AgentTimelineMessageRoleV1, AgentTimelinePageV1,
    AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1, AgentTimelineReadV1,
    AgentTimelineStore, DomainStoreErrorV1,
};
use serde_json::{Value, json};

use crate::ServiceState;

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
