//! Canonical append/cursor handling for providers that expose durable snapshots.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::agent_conversation::{AgentConversationService, AgentProviderCommandErrorV1 as Error};

struct Position {
    sequence: i64,
    rows: BTreeSet<AgentTimelineItemIdV1>,
}

pub(crate) struct HydratedTimeline {
    pub(crate) rows: Vec<AgentTimelineRowV1>,
    pub(crate) active_turn: Option<AgentTimelineActiveTurnV1>,
}

pub(crate) struct ProviderTimelineJournal<S> {
    service: Arc<AgentConversationService<S>>,
    binding: AgentInteractionBindingV1,
    position: Mutex<Position>,
}

impl<S: AgentTimelineStore + 'static> ProviderTimelineJournal<S> {
    pub(crate) async fn new(
        service: Arc<AgentConversationService<S>>,
        binding: &AgentInteractionBindingV1,
    ) -> Result<Self, Error> {
        let cursor = service
            .provider_cursor(&binding.interaction_session_id, &binding.runtime)
            .await
            .map_err(store_error)?;
        Ok(Self {
            service,
            binding: binding.clone(),
            position: Mutex::new(Position {
                sequence: cursor.committed_through_sequence,
                rows: BTreeSet::new(),
            }),
        })
    }

    pub(crate) async fn existing_rows(&self) -> Result<HydratedTimeline, Error> {
        let mut position = self.position.lock().await;
        let mut cursor = None;
        let mut direction = AgentTimelineReadDirectionV1::Tail;
        let mut rows = Vec::new();
        let mut active_turn = None;
        loop {
            let read = self
                .service
                .read(&AgentTimelineReadRequestV1 {
                    schema_version: 1,
                    interaction_session_id: self.binding.interaction_session_id.clone(),
                    direction: direction.clone(),
                    cursor,
                    limit: MAX_AGENT_TIMELINE_PAGE_ITEMS_V1,
                })
                .await
                .map_err(store_error)?;
            let AgentTimelineReadV1::Page { page } = read else {
                return Err(protocol_error("timeline reset during snapshot attachment"));
            };
            if direction == AgentTimelineReadDirectionV1::Tail {
                active_turn = page.active_turn;
            }
            position
                .rows
                .extend(page.rows.iter().map(|row| row.item.item_id.clone()));
            cursor = page.rows.first().map(|row| row.cursor.clone());
            if page.has_more && cursor.is_none() {
                return Err(protocol_error("empty timeline page has a successor"));
            }
            rows.extend(page.rows);
            if !page.has_more {
                break;
            }
            direction = AgentTimelineReadDirectionV1::Before;
        }
        Ok(HydratedTimeline { rows, active_turn })
    }

    pub(crate) async fn sequence(&self) -> i64 {
        self.position.lock().await.sequence
    }

    pub(crate) async fn append_once(
        &self,
        items: Vec<AgentTimelineItemDraftV1>,
    ) -> Result<(), Error> {
        let mut position = self.position.lock().await;
        let mut seen = BTreeSet::new();
        let items = items
            .into_iter()
            .filter(|item| {
                !position.rows.contains(&item.item_id) && seen.insert(item.item_id.clone())
            })
            .collect::<Vec<_>>();
        for chunk in items.chunks(MAX_AGENT_TIMELINE_EVENT_MUTATIONS_V1) {
            self.commit_at(
                &mut position,
                chunk
                    .iter()
                    .cloned()
                    .map(|item| AgentTimelineMutationV1::Append { item })
                    .collect(),
            )
            .await?;
            position
                .rows
                .extend(chunk.iter().map(|item| item.item_id.clone()));
        }
        Ok(())
    }

    pub(crate) async fn commit(
        &self,
        mutations: Vec<AgentTimelineMutationV1>,
    ) -> Result<(), Error> {
        self.commit_at(&mut *self.position.lock().await, mutations)
            .await
    }

    async fn commit_at(
        &self,
        position: &mut Position,
        mutations: Vec<AgentTimelineMutationV1>,
    ) -> Result<(), Error> {
        if mutations.is_empty() {
            return Ok(());
        }
        let sequence = position
            .sequence
            .checked_add(1)
            .ok_or_else(|| protocol_error("provider sequence exhausted"))?;
        self.service
            .commit_provider_event(&AgentProviderEventCommitV1 {
                schema_version: 1,
                interaction_session_id: self.binding.interaction_session_id.clone(),
                event: AgentProviderEventIdentityV1 {
                    runtime: self.binding.runtime.clone(),
                    sequence,
                },
                source_fingerprint: digest(
                    &serde_json::to_string(&mutations).map_err(store_error)?,
                ),
                mutations,
                recorded_at_ms: now_ms()?,
            })
            .await
            .map_err(store_error)?;
        position.sequence = sequence;
        Ok(())
    }
}

pub(crate) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(crate) fn now_ms() -> Result<i64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| i64::try_from(time.as_millis()).ok())
        .ok_or_else(|| protocol_error("clock unavailable"))
}
pub(crate) fn store_error(error: impl std::fmt::Display) -> Error {
    Error::new("provider_timeline_unavailable", error.to_string())
}
pub(crate) fn protocol_error(detail: impl Into<String>) -> Error {
    Error::new("provider_protocol_invalid", detail)
}

pub(crate) fn evidence_value(
    row: &AgentTimelineRowV1,
    namespace: &str,
    kind: &str,
) -> Option<Value> {
    match &row.item.body {
        AgentTimelineItemBodyV1::ProviderEvidence {
            namespace: actual,
            kind: actual_kind,
            value,
        } if actual == namespace && actual_kind == kind => Some(value.clone()),
        _ => None,
    }
}
