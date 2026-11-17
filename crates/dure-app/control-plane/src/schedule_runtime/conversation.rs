//! A schedule-started agent on the chat runtime has no Host clock and no
//! terminal state. Its committed conversation timeline is the activity
//! authority instead: a running or queued turn or an open question keeps it
//! awake, and idle time is measured from the newest committed fact, so a
//! backend restart does not reset it. Every stop still goes through the
//! fenced hibernation that preserves active work.
use dure_app::{
    AgentGoalStatusV1, AgentIdV1, AgentInteractionBindingV1, AgentPendingRequestKindV1,
    AgentRuntimeBindingAuthorityV1, AgentTimelinePageV1, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineStore,
};

use super::*;
use crate::agent_runtime_transition_apply::deferred::idle::lock_stable_source;
use crate::agent_runtime_transition_apply::deferred::{HibernateBodyV1, hibernate};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConversationActivity {
    pub(crate) working: bool,
    pub(crate) attention: &'static str,
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
            "approval_required"
        } else if !page.pending_requests.is_empty() {
            "input_required"
        } else if !working && page.latest_failure.is_some() {
            "error"
        } else {
            "none"
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
            "attention": self.attention,
        })
    }
}

pub(crate) async fn read(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
) -> Result<AgentTimelinePageV1, &'static str> {
    let read = state
        .store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 1,
        })
        .await
        .map_err(|_| "schedule_runtime_unavailable")?;
    match read {
        AgentTimelineReadV1::Page { page }
            if page.binding.interaction_session_id == binding.interaction_session_id
                && page.binding.runtime == binding.runtime =>
        {
            Ok(*page)
        }
        _ => Err("schedule_runtime_conversation_changed"),
    }
}

/// Hibernate a chat-runtime agent whose conversation has been quiescent for
/// `idle_after`. The attempt is bound to the exact source, conversation
/// position and idle interval, so a lost response never authorizes a second
/// stop, and a refused stop is retried once per interval like a native one.
pub(crate) async fn hibernate_if_idle(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    idle_after: Duration,
) -> Result<(), String> {
    let (selection, binding, page) = {
        let (_guard, selection, authority) = lock_stable_source(state, agent_id).await?;
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = *authority else {
            return Err("runtime_idle_source_unsupported".into());
        };
        let page = read(state, &binding).await.map_err(str::to_owned)?;
        (selection, binding, page)
    };
    let activity = ConversationActivity::from_page(&page);
    if !activity.quiescent {
        return Ok(());
    }
    if binding.provider_conversation_ref.is_none() {
        return Err("agent_runtime_provider_conversation_unavailable".into());
    }
    let now = now_ms().map_err(|_| "runtime_idle_clock_unavailable".to_owned())?;
    let Some(attempt) = idle_attempt(
        &selection,
        &binding,
        &page,
        idle_after,
        now.saturating_sub(activity.last_activity_ms.max(selection.updated_at_ms)),
    ) else {
        return Ok(());
    };
    // The structured stop refuses a source that became busy after this read.
    hibernate(
        state,
        &attempt,
        HibernateBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            expected_source_revision: selection.revision,
            expected_idle: None,
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| error.code)
}

fn idle_attempt(
    selection: &dure_app::AgentRuntimeSelectionV1,
    binding: &AgentInteractionBindingV1,
    page: &AgentTimelinePageV1,
    idle_after: Duration,
    elapsed_ms: i64,
) -> Option<String> {
    let after_ms = i64::try_from(idle_after.as_millis())
        .ok()
        .filter(|ms| *ms > 0)?;
    let interval = elapsed_ms / after_ms;
    if interval < 1 {
        return None;
    }
    let mut digest = Sha256::new();
    for field in [
        b"dure-schedule-conversation-idle/v1".as_slice(),
        selection.agent_id.as_str().as_bytes(),
        &selection.revision.to_be_bytes(),
        binding.interaction_session_id.as_str().as_bytes(),
        binding.runtime.runtime_generation.as_bytes(),
        page.final_cursor.epoch.as_str().as_bytes(),
        &page.final_cursor.sequence.to_be_bytes(),
        &after_ms.to_be_bytes(),
        &interval.to_be_bytes(),
    ] {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    Some(format!(
        "schedule-conversation-idle-{:x}",
        digest.finalize()
    ))
}
