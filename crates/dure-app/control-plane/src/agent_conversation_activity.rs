//! What each chat-runtime Agent on this backend is doing, for the app. A
//! terminal Agent's state comes from its Host; a chat Agent has no Host, so
//! its committed conversation plays that part. One subscription per backend
//! sends a snapshot of every chat Agent's state, then one update for each
//! Agent whose state changed. The conversation is read through the one
//! classifier (`agent_conversation_outcome`), so the app, schedules and
//! child-result delivery read a conversation the same way.
//!
//! A conversation is read again only after the conversation service
//! announced a change to it; streamed text alone is ignored, and changes that
//! arrive close together are read once. When announcements were dropped,
//! the next event is a fresh snapshot.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::Arc;

use dure_app::{
    AgentIdV1, AgentInteractionBindingV1, AgentInteractionSessionIdV1, AgentTimelineEpochV1,
    AgentTimelineStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{OwnedSemaphorePermit, broadcast};
use tokio::time::Duration;

use crate::agent_conversation::{
    AgentConversationNotificationKindV1, AgentConversationNotificationV1,
};
use crate::agent_conversation_api::{serve_subscription, write_subscription_event};
use crate::agent_conversation_outcome::{
    ChatRuntime, ConversationAttention, ConversationOutcome, chat_runtime, latest_turn_completed,
    read_tail,
};
use crate::{BackendDispatchError, BackendRequest, ServiceState};

pub const SUBSCRIBE_OPERATION: &str = "agent_conversation.activity.subscribe";
const TOPIC: &str = "agent_conversation.activity";
const SNAPSHOT_PAGE: usize = 256;
/// Bounds the snapshot frame. An Agent past it still appears with its next
/// change.
const MAX_SNAPSHOT_AGENTS: usize = 4096;
/// Changes announced within this window are read once.
const COALESCE: Duration = Duration::from_millis(250);

/// Whether the chat runtime is starting (a runtime change is in progress),
/// running, or closed.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActivityLifecycle {
    Starting,
    Running,
    Exited,
}

/// One chat Agent's state, in the shape of a Host's runtime state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivityV1 {
    pub(crate) agent_id: AgentIdV1,
    pub(crate) interaction_session_id: AgentInteractionSessionIdV1,
    pub(crate) lifecycle: ActivityLifecycle,
    /// `working` or `waiting`.
    pub(crate) activity: &'static str,
    pub(crate) attention: &'static str,
    /// What the attention waits on: the open request a person must answer,
    /// or the failed turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attention_id: Option<String>,
    pub(crate) timeline_epoch: AgentTimelineEpochV1,
    /// The row of the newest finished turn, as a decimal; `0` before the
    /// first. It grows exactly when a turn finishes.
    pub(crate) turn_completed_sequence: String,
}

/// What a subscriber is sent after its snapshot.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ActivityEvent {
    /// Announcements were dropped: every chat Agent's state again.
    Snapshot(Vec<AgentActivityV1>),
    /// The Agents whose state changed, and those no longer on the chat
    /// runtime.
    Changes {
        changes: Vec<AgentActivityV1>,
        removed: Vec<AgentIdV1>,
    },
}

/// One subscriber's view: what it was last sent, so an announcement that
/// changes nothing it shows sends nothing.
pub(crate) struct ActivityFeed {
    notifications: broadcast::Receiver<AgentConversationNotificationV1>,
    agents: BTreeMap<AgentInteractionSessionIdV1, AgentIdV1>,
    sent: BTreeMap<AgentIdV1, AgentActivityV1>,
    coalesce: Duration,
}

impl ActivityFeed {
    /// Subscribes before the first read, so no change between the snapshot
    /// and the first update is missed.
    pub(crate) async fn open(
        state: &ServiceState,
    ) -> Result<(Self, Vec<AgentActivityV1>), BackendDispatchError> {
        Self::open_with(state, state.agent_conversations.notifications(), COALESCE).await
    }

    pub(crate) async fn open_with(
        state: &ServiceState,
        notifications: broadcast::Receiver<AgentConversationNotificationV1>,
        coalesce: Duration,
    ) -> Result<(Self, Vec<AgentActivityV1>), BackendDispatchError> {
        let mut feed = Self {
            notifications,
            agents: BTreeMap::new(),
            sent: BTreeMap::new(),
            coalesce,
        };
        let snapshot = feed.snapshot(state).await?;
        Ok((feed, snapshot))
    }

    async fn snapshot(
        &mut self,
        state: &ServiceState,
    ) -> Result<Vec<AgentActivityV1>, BackendDispatchError> {
        self.agents.clear();
        self.sent.clear();
        let mut after = None;
        'pages: loop {
            let page = state
                .store
                .agent_interactions(after.as_ref(), SNAPSHOT_PAGE)
                .await
                .map_err(|_| BackendDispatchError::from("agent_activity_unavailable"))?;
            for binding in &page {
                if self.agents.len() >= MAX_SNAPSHOT_AGENTS {
                    break 'pages;
                }
                self.agents.insert(
                    binding.interaction_session_id.clone(),
                    binding.agent_id.clone(),
                );
                // An Agent that cannot be read now is left out, as if
                // unobserved, and read again at its next change.
                if let Ok(Some(activity)) = observe(state, &binding.agent_id).await {
                    self.sent.insert(binding.agent_id.clone(), activity);
                }
            }
            if page.len() < SNAPSHOT_PAGE {
                break;
            }
            after = page
                .last()
                .map(|binding| binding.interaction_session_id.clone());
        }
        Ok(self.sent.values().cloned().collect())
    }

    /// Waits for the next change a subscriber is shown. `Err` once the
    /// conversation service is gone or a snapshot cannot be read.
    pub(crate) async fn next(
        &mut self,
        state: &ServiceState,
    ) -> Result<ActivityEvent, BackendDispatchError> {
        loop {
            let mut changed = BTreeSet::new();
            let mut lagged = false;
            match self.notifications.recv().await {
                Ok(notification) => absorb(&mut changed, notification),
                Err(broadcast::error::RecvError::Lagged(_)) => lagged = true,
                Err(broadcast::error::RecvError::Closed) => {
                    return Err(BackendDispatchError::from("agent_activity_closed"));
                }
            }
            if !self.coalesce.is_zero() {
                tokio::time::sleep(self.coalesce).await;
            }
            loop {
                match self.notifications.try_recv() {
                    Ok(notification) => absorb(&mut changed, notification),
                    Err(broadcast::error::TryRecvError::Lagged(_)) => lagged = true,
                    Err(_) => break,
                }
            }
            if lagged {
                return Ok(ActivityEvent::Snapshot(self.snapshot(state).await?));
            }
            let mut changes = Vec::new();
            let mut removed = Vec::new();
            for interaction_session_id in changed {
                let Some(agent_id) = self.agent_of(state, &interaction_session_id).await else {
                    continue;
                };
                match observe(state, &agent_id).await {
                    Ok(Some(activity)) => {
                        if self.sent.get(&agent_id) != Some(&activity) {
                            self.sent.insert(agent_id, activity.clone());
                            changes.push(activity);
                        }
                    }
                    Ok(None) => {
                        if self.sent.remove(&agent_id).is_some() {
                            removed.push(agent_id);
                        }
                    }
                    // Read again at the next change.
                    Err(_) => {}
                }
            }
            if !changes.is_empty() || !removed.is_empty() {
                return Ok(ActivityEvent::Changes { changes, removed });
            }
        }
    }

    async fn agent_of(
        &mut self,
        state: &ServiceState,
        interaction_session_id: &AgentInteractionSessionIdV1,
    ) -> Option<AgentIdV1> {
        if let Some(agent_id) = self.agents.get(interaction_session_id) {
            return Some(agent_id.clone());
        }
        let binding = state
            .store
            .agent_interaction(interaction_session_id)
            .await
            .ok()??;
        self.agents
            .insert(interaction_session_id.clone(), binding.agent_id.clone());
        Some(binding.agent_id)
    }
}

/// Streamed text belongs to the running turn and changes no state.
fn absorb(
    changed: &mut BTreeSet<AgentInteractionSessionIdV1>,
    notification: AgentConversationNotificationV1,
) {
    if !notification
        .kinds
        .iter()
        .all(|kind| *kind == AgentConversationNotificationKindV1::LiveText)
    {
        changed.insert(notification.interaction_session_id);
    }
}

/// The Agent's state while it is on the chat runtime; `None` while it runs on
/// a terminal, whose Host reports it. The runtime projection says whether the
/// runtime runs, is changing or was stopped; the conversation says what it
/// is doing. Observation takes no Agent lock, so it never waits behind a
/// long operation: every runtime commit announces itself, and the next read
/// sees it.
async fn observe(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentActivityV1>, String> {
    let (lifecycle, binding) = match chat_runtime(state, agent_id).await? {
        Some(ChatRuntime::Running(binding)) => (ActivityLifecycle::Running, binding),
        Some(ChatRuntime::Changing(binding)) => (ActivityLifecycle::Starting, binding),
        Some(ChatRuntime::Stopped(binding)) => (ActivityLifecycle::Exited, binding),
        None => return Ok(None),
    };
    activity(state, lifecycle, binding).await.map(Some)
}

async fn activity(
    state: &ServiceState,
    lifecycle: ActivityLifecycle,
    binding: AgentInteractionBindingV1,
) -> Result<AgentActivityV1, String> {
    let unavailable = |_| "agent_activity_unavailable".to_string();
    let (working, attention, attention_id) = if lifecycle == ActivityLifecycle::Running {
        let page = read_tail(state, &binding, 1)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| "agent_activity_binding_changed".to_string())?;
        let outcome = ConversationOutcome::from_page(&page);
        let attention_id = match outcome.activity.attention {
            ConversationAttention::Error => outcome
                .latest_failure
                .map(|failure| failure.as_str().to_owned()),
            _ => outcome.attention_id.map(|id| id.as_str().to_owned()),
        };
        (
            outcome.activity.working,
            outcome.activity.attention,
            attention_id,
        )
    } else {
        (false, ConversationAttention::None, None)
    };
    // `0` before the first finished turn, as a Host's count starts.
    let completed = latest_turn_completed(state, &binding)
        .await
        .map_err(unavailable)?
        .unwrap_or(0);
    Ok(AgentActivityV1 {
        agent_id: binding.agent_id,
        interaction_session_id: binding.interaction_session_id,
        lifecycle,
        // A turn that waits on a person is waiting, as a Host reports it.
        activity: if working && attention == ConversationAttention::None {
            "working"
        } else {
            "waiting"
        },
        attention: attention.as_str(),
        attention_id,
        timeline_epoch: binding.timeline_epoch,
        turn_completed_sequence: completed.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscribeBodyV1 {
    schema_version: u16,
}

pub(super) async fn handle_subscription(
    state: Arc<ServiceState>,
    reader: BufReader<UnixStream>,
    request: BackendRequest,
) -> io::Result<()> {
    serve_subscription(
        state,
        reader,
        request,
        |state, body| async move {
            match serde_json::from_value::<SubscribeBodyV1>(body) {
                Ok(body) if body.schema_version == 1 => {}
                _ => {
                    return Err(BackendDispatchError::terminal(
                        "agent_activity_request_invalid",
                    ));
                }
            }
            let (feed, snapshot) = ActivityFeed::open(&state).await?;
            Ok((json!({ "schemaVersion": 1, "agents": snapshot }), feed))
        },
        stream,
    )
    .await
}

async fn stream(
    state: Arc<ServiceState>,
    stream: UnixStream,
    request_id: String,
    mut feed: ActivityFeed,
    _subscription_permit: OwnedSemaphorePermit,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    loop {
        let event = tokio::select! {
            read = reader.read_u8() => {
                let _ = read;
                return Ok(());
            }
            event = feed.next(&state) => event,
        };
        // The subscriber reconnects for a fresh snapshot.
        let Ok(event) = event else {
            return Ok(());
        };
        write_subscription_event(&mut writer, &state, event_body(&request_id, event)).await?;
    }
}

fn event_body(request_id: &str, event: ActivityEvent) -> Value {
    let mut body = json!({
        "schemaVersion": 1,
        "topic": TOPIC,
        "subscriptionRequestId": request_id,
    });
    match event {
        ActivityEvent::Snapshot(agents) => body["agents"] = json!(agents),
        ActivityEvent::Changes { changes, removed } => {
            body["changes"] = json!(changes);
            body["removed"] = json!(removed);
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_name_their_topic_and_carry_either_a_snapshot_or_changes() {
        let activity = AgentActivityV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            lifecycle: ActivityLifecycle::Running,
            activity: "waiting",
            attention: "approval_required",
            attention_id: Some("permission-1".into()),
            timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
            turn_completed_sequence: "0".into(),
        };
        assert_eq!(
            event_body("request-1", ActivityEvent::Snapshot(vec![activity.clone()])),
            json!({
                "schemaVersion": 1,
                "topic": "agent_conversation.activity",
                "subscriptionRequestId": "request-1",
                "agents": [{
                    "agentId": "agent-1",
                    "interactionSessionId": "interaction-1",
                    "lifecycle": "running",
                    "activity": "waiting",
                    "attention": "approval_required",
                    "attentionId": "permission-1",
                    "timelineEpoch": "timeline-1",
                    "turnCompletedSequence": "0",
                }],
            })
        );
        let changes = event_body(
            "request-1",
            ActivityEvent::Changes {
                changes: Vec::new(),
                removed: vec![AgentIdV1::new("agent-2").unwrap()],
            },
        );
        assert_eq!(changes["changes"], json!([]));
        assert_eq!(changes["removed"], json!(["agent-2"]));
        assert!(changes.get("agents").is_none());
    }

    #[test]
    fn only_committed_changes_are_read_again() {
        let mut changed = BTreeSet::new();
        let session = AgentInteractionSessionIdV1::new("interaction-1").unwrap();
        let notification = |kinds| AgentConversationNotificationV1 {
            interaction_session_id: session.clone(),
            timeline_cursor: dure_app::AgentTimelineCursorV1 {
                epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
                sequence: 1,
            },
            kinds,
        };
        absorb(
            &mut changed,
            notification(vec![AgentConversationNotificationKindV1::LiveText]),
        );
        assert!(changed.is_empty());
        absorb(
            &mut changed,
            notification(vec![
                AgentConversationNotificationKindV1::LiveText,
                AgentConversationNotificationKindV1::PendingRequests,
            ]),
        );
        assert_eq!(changed.into_iter().collect::<Vec<_>>(), vec![session]);
    }
}
