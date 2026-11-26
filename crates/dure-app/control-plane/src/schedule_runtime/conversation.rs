//! A schedule-started agent on the chat runtime has no Host clock and no
//! terminal state. Its committed conversation timeline is the activity
//! authority instead: a running or queued turn or an open question keeps it
//! awake, and idle time is measured from the newest committed fact, so a
//! backend restart does not reset it. Every stop still goes through the
//! fenced hibernation that preserves active work.
use dure_app::{
    AgentIdV1, AgentInteractionBindingV1, AgentRuntimeBindingAuthorityV1, AgentTimelinePageV1,
};

use super::*;
use crate::agent_conversation_outcome::{ConversationActivity, read_tail};
use crate::agent_runtime_transition_apply::deferred::idle::lock_stable_source;
use crate::agent_runtime_transition_apply::deferred::{HibernateBodyV1, hibernate};

/// The conversation's newest row and its activity facts, which are all a
/// schedule needs.
pub(crate) async fn read(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
) -> Result<AgentTimelinePageV1, &'static str> {
    read_tail(state, binding, 1)
        .await
        .map_err(|_| "schedule_runtime_unavailable")?
        .ok_or("schedule_runtime_conversation_changed")
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
