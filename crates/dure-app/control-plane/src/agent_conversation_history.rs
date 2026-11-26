//! The provider history older than what a Chat session's timeline holds, read
//! by the backend that owns the session.
//!
//! A Chat timeline seeded from a provider conversation can start partway
//! through it, behind a history boundary placed at a transcript offset. The
//! records before it stay in the provider's transcript on this backend's
//! machine, which a client across a backend connection cannot read. So the
//! backend answers older pages itself: only for the session's own
//! conversation, from the session's own credential profile, through the
//! shared transcript reader the desktop's own views use.

use std::path::Path;

use dure_app::{AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentInteractionSessionIdV1};
use dure_provider_profile::transcript;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ServiceState;
use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::provider_credential_profile::provider_state_directory;

pub(super) const OPERATION: &str = "agent_conversation.read_provider_history";

/// Room the response envelope keeps beside the page.
const RESPONSE_ENVELOPE_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadProviderHistoryBodyV1 {
    schema_version: u16,
    interaction_session_id: AgentInteractionSessionIdV1,
    /// The conversation the client pages: the binding's own. A binding that
    /// moved to another conversation refuses the read, since the cursor
    /// belongs to the transcript the client paged.
    provider_conversation_ref: String,
    /// The transcript offset the page ends before: where the timeline's
    /// seeded history starts, or an earlier page's `olderCursor`.
    before: u64,
    /// The transcript offset the page starts no earlier than: where the rows
    /// above a gap in the timeline end. Without it, the transcript's start.
    /// Requires `agent_conversation.read_provider_history.after.v1`.
    #[serde(default)]
    after: Option<u64>,
}

pub(super) async fn read(
    state: &ServiceState,
    body: &Value,
) -> Result<Value, AgentConversationApiErrorV1> {
    let body: ReadProviderHistoryBodyV1 = serde_json::from_value(body.clone())
        .map_err(|_| AgentConversationApiErrorV1::RequestInvalid)?;
    let after = body.after.unwrap_or(0);
    if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 || after >= body.before {
        return Err(AgentConversationApiErrorV1::RequestInvalid);
    }
    let binding = state
        .agent_conversations
        .binding(&body.interaction_session_id)
        .await?
        .ok_or(AgentConversationApiErrorV1::NotFound)?;
    if binding.provider_conversation_ref.as_deref() != Some(body.provider_conversation_ref.as_str())
    {
        return Err(AgentConversationApiErrorV1::Conflict);
    }
    let resolved = state
        .credential_profiles
        .resolve(&binding.provider_id, &binding.execution_profile)
        .await
        .map_err(|_| AgentConversationApiErrorV1::HistoryUnavailable)?;
    let home = provider_state_directory(&binding.provider_id, resolved.as_ref())
        .ok_or(AgentConversationApiErrorV1::HistoryUnavailable)?;
    let provider = binding.provider_id.as_str().to_owned();
    let conversation = body.provider_conversation_ref;
    let before = body.before;
    let activity = tokio::task::spawn_blocking(move || {
        transcript::read_roots_activity_page(
            &home.join("projects"),
            &home.join("sessions"),
            &provider,
            &conversation,
            before,
            after,
        )
    })
    .await
    .map_err(|_| AgentConversationApiErrorV1::HistoryUnavailable)?
    .map_err(|_| AgentConversationApiErrorV1::HistoryUnavailable)?;
    let response = json!({ "schemaVersion": 1, "activity": activity });
    // The reader bounds a page's messages and calls, not how much escaping
    // their JSON needs; a page that would not fit one response is refused
    // whole rather than cut.
    let encoded = serde_json::to_vec(&response)
        .map_err(|_| AgentConversationApiErrorV1::HistoryUnavailable)?;
    if encoded.len() as u64 > crate::MAX_RESPONSE_BYTES - RESPONSE_ENVELOPE_BYTES {
        return Err(AgentConversationApiErrorV1::HistoryUnavailable);
    }
    Ok(response)
}

/// Where a Codex thread's history from turn `turn_id` on starts in the
/// thread's rollout under the provider `home`: the cursor [`read`] pages the
/// older history before, in the same rollout. `None` when the rollout or its
/// record of the turn cannot be found.
pub(crate) fn codex_turn_start_cursor(home: &Path, thread_id: &str, turn_id: &str) -> Option<u64> {
    transcript::codex_turn_start_cursor(&home.join("sessions"), thread_id, turn_id)
        .ok()
        .flatten()
        .filter(|cursor| *cursor > 0)
}
