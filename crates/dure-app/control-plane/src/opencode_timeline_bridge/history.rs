//! The newest window of an OpenCode session's history, which a Chat timeline
//! seeds or continues when its runtime attaches.

use std::collections::BTreeSet;

use dure_app::PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1;

use super::*;
use crate::opencode_session_client::{Error as SessionError, MessagePages};

/// How far back a history window pages. [`Self::ATTACH`] holds the bounds
/// the whole history had while an attach read all of it, so a session that
/// opened in Chat opens with the same history, and a longer one with its
/// newest history instead of not at all.
#[derive(Clone, Copy, Debug)]
pub(super) struct HistoryWindowBounds {
    pub(super) messages: usize,
    pub(super) bytes: usize,
}

impl HistoryWindowBounds {
    pub(super) const ATTACH: Self = Self {
        messages: 10_000,
        bytes: 64 * 1024 * 1024,
    };
}

pub(super) struct HistoryWindow {
    /// The window's timeline items, oldest first. A history boundary row
    /// opens the window when older messages that the timeline does not hold
    /// precede it, and stands in for each message too large to read.
    pub(super) items: Vec<AgentTimelineItemDraftV1>,
    /// The user messages whose turns the window's messages completed.
    pub(super) completed_users: Vec<String>,
    /// When the window's oldest message was created. An older message is
    /// held already or behind a boundary, never one the window shows.
    pub(super) starts_at_ms: Option<i64>,
}

/// The session's newest messages, paged back from the newest until the
/// session's start, a page that reaches a message the timeline holds, or
/// `bounds`. Whole pages are kept, so one page past a bound is the most a
/// window holds beyond it. The newest message must be readable, because an
/// active turn and the live path depend on it; an older message too large to
/// read is left out behind a boundary row.
pub(super) async fn history_window(
    mut pages: MessagePages<'_>,
    turns: &mut BTreeMap<String, TurnContext>,
    held: &BTreeSet<AgentTimelineItemIdV1>,
    bounds: HistoryWindowBounds,
) -> Result<HistoryWindow, CommandError> {
    let mut newest_first = Vec::new();
    let mut completed_users = Vec::new();
    let mut oldest = None::<Value>;
    let (mut count, mut bytes) = (0_usize, 0_usize);
    let omits_older = loop {
        let Some(page) = pages.next().await.map_err(provider_error)? else {
            break false;
        };
        count = count.saturating_add(page.messages.len().max(1));
        bytes = bytes.saturating_add(page.bytes);
        let mut reached_held = false;
        let mut items = Vec::new();
        if page.unreadable {
            let newer = oldest
                .as_ref()
                .ok_or_else(|| provider_error(SessionError::Limit))?;
            items.push(history_boundary(newer)?);
        }
        for message in &page.messages {
            let (message_items, completed_user) = message_items(message, turns)?;
            reached_held |= message_items
                .iter()
                .any(|item| held.contains(&item.item_id));
            items.extend(message_items);
            completed_users.extend(completed_user);
        }
        if let Some(message) = page.messages.into_iter().next() {
            oldest = Some(message);
        }
        newest_first.push(items);
        if reached_held {
            break false;
        }
        if count >= bounds.messages || bytes >= bounds.bytes {
            break pages.has_older();
        }
    };
    if omits_older && let Some(oldest) = &oldest {
        newest_first.push(vec![history_boundary(oldest)?]);
    }
    Ok(HistoryWindow {
        items: newest_first.into_iter().rev().flatten().collect(),
        completed_users,
        starts_at_ms: oldest.as_ref().map(created_at_ms).transpose()?,
    })
}

fn created_at_ms(message: &Value) -> Result<i64, CommandError> {
    message
        .pointer("/info/time/created")
        .and_then(Value::as_i64)
        .ok_or_else(|| protocol_error("message timestamp missing"))
}

/// The existing boundary row before `newer`, which marks that older messages
/// precede it. OpenCode keeps no transcript a reader pages from, so the row
/// says only that they are left out, not where they are. The boundary that
/// opens a window and one that stands in for a message too large to read
/// right before it are the same row.
fn history_boundary(newer: &Value) -> Result<AgentTimelineItemDraftV1, CommandError> {
    let id = field(
        newer
            .get("info")
            .ok_or_else(|| protocol_error("message info missing"))?,
        "id",
    )?;
    item(
        &format!("history-boundary:{id}"),
        None,
        None,
        AgentTimelineItemBodyV1::HistoryBoundary {
            reason: PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1.into(),
            requested_after_provider_sequence: 0,
            dropped_through_provider_sequence: 1,
        },
        created_at_ms(newer)?,
    )
}
