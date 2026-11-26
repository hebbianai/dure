//! The newest window of an OpenCode session's history, which a Chat timeline
//! seeds or continues when its runtime attaches, and the older pages of the
//! history before it, which the backend reads on request.
//!
//! OpenCode keeps no transcript file a reader pages. Its session API orders
//! a session's messages by when they were created, then by id, and pages
//! them back through opaque cursors. So a place in the history is the
//! creation time (in ms) of the oldest message after it: the window's
//! boundary is placed there, and an older page reads every message created
//! before it. The messages created at one time go into a window or a page
//! whole or not at all, so pages join exactly where they meet.

use std::collections::BTreeSet;
use std::sync::Mutex as StdMutex;

use dure_provider_profile::transcript::{
    BackendActivityPage, ConversationRecord, ConversationTurnRole, Prepended,
    ProviderConversationActivity, ProviderToolState, ProviderTranscriptEntry, ToolEvent,
    bounded_input,
};

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

/// The cursors of the places in an OpenCode session that a bridge has read
/// past, so that a page of the history before a place does not read the
/// whole newer history again. A cursor kept at a place is one that every
/// message created before the place comes after.
#[derive(Default)]
pub(super) struct HistoryPlaces {
    cursors: BTreeMap<i64, String>,
}

impl HistoryPlaces {
    /// The places one bridge keeps. The newest are left out first: reading
    /// back to them again costs the least.
    const MAX: usize = 1024;

    /// After a page whose oldest message was created at `oldest`, read before
    /// `next`: every message created earlier comes after `next`.
    fn record(&mut self, oldest: i64, next: &str) {
        self.cursors.insert(oldest, next.to_owned());
        while self.cursors.len() > Self::MAX {
            self.cursors.pop_last();
        }
    }

    /// Where a read of the history before `place` starts: the cursor of the
    /// nearest place at or after it, or the newest message without one.
    fn start(&self, place: i64) -> Option<String> {
        self.cursors
            .range(place..)
            .next()
            .map(|(_, cursor)| cursor.clone())
    }
}

/// One message of a window, or a stand-in for a message too large to read.
struct Shown {
    /// The message's id and when it was created; none for a stand-in.
    message: Option<(String, i64)>,
    items: Vec<AgentTimelineItemDraftV1>,
}

/// The session's newest messages, paged back from the newest until the
/// session's start, a page that reaches a message the timeline holds, or
/// `bounds`. Whole pages are kept, so one page past a bound is the most a
/// window holds beyond it. The newest message must be readable, because an
/// active turn and the live path depend on it; an older message too large to
/// read is left out behind a boundary row.
///
/// A window that leaves older messages out and opens the timeline opens at a
/// place, from which [`history_page`] reads them. After turns the timeline
/// `holds_turns` of, its boundary marks the gap between them and the window,
/// at no place: paging back from the window's start would show the held
/// turns again.
pub(super) async fn history_window(
    mut pages: MessagePages<'_>,
    turns: &mut BTreeMap<String, TurnContext>,
    held: &BTreeSet<AgentTimelineItemIdV1>,
    holds_turns: bool,
    bounds: HistoryWindowBounds,
    places: &StdMutex<HistoryPlaces>,
) -> Result<HistoryWindow, CommandError> {
    let mut newest_first = Vec::<Shown>::new();
    let mut completed_users = Vec::new();
    let mut oldest = None::<(String, i64)>;
    let mut cursors = Vec::new();
    let mut ordered = true;
    let (mut count, mut bytes) = (0_usize, 0_usize);
    let omits_older = loop {
        let Some(page) = pages.next().await.map_err(provider_error)? else {
            break false;
        };
        count = count.saturating_add(page.messages.len().max(1));
        bytes = bytes.saturating_add(page.bytes);
        if page.unreadable {
            let (id, created) = oldest
                .clone()
                .ok_or_else(|| provider_error(SessionError::Limit))?;
            newest_first.push(Shown {
                message: None,
                items: vec![history_boundary(&id, created, None)?],
            });
        }
        if let (Some(oldest), Some(cursor)) = (page.messages.first(), pages.next_cursor()) {
            cursors.push((created_at_ms(oldest)?, cursor.to_owned()));
        }
        let mut reached_held = false;
        let mut shown = Vec::with_capacity(page.messages.len());
        for message in &page.messages {
            let (items, completed_user) = message_items(message, turns)?;
            if !reached_held && items.iter().any(|item| held.contains(&item.item_id)) {
                // The page's older messages come before what the timeline
                // holds: behind its boundary, never rows to append after it.
                reached_held = true;
                shown.clear();
            }
            shown.push((
                Shown {
                    message: Some((message_id(message)?.to_owned(), created_at_ms(message)?)),
                    items,
                },
                completed_user,
            ));
        }
        for (message, completed_user) in shown.into_iter().rev() {
            completed_users.extend(completed_user);
            if let Some((_, created)) = &message.message {
                ordered &= oldest.as_ref().is_none_or(|(_, newer)| created <= newer);
                oldest.clone_from(&message.message);
            }
            newest_first.push(message);
        }
        if reached_held {
            break false;
        }
        if count >= bounds.messages || bytes >= bounds.bytes {
            break pages.has_older();
        }
    };
    if omits_older {
        // Placed only where OpenCode pages by creation time, as a read of the
        // history before the place assumes.
        let place = (ordered && !holds_turns)
            .then(|| open_at_place(&mut newest_first))
            .flatten();
        let newer = newest_first
            .iter()
            .rev()
            .find_map(|shown| shown.message.clone())
            .ok_or_else(|| protocol_error("history window holds no message"))?;
        newest_first.push(Shown {
            message: None,
            items: vec![history_boundary(&newer.0, newer.1, place)?],
        });
    }
    if ordered {
        let mut places = lock(places);
        for (oldest, cursor) in &cursors {
            places.record(*oldest, cursor);
        }
    }
    let starts_at_ms = newest_first
        .iter()
        .rev()
        .find_map(|shown| shown.message.as_ref().map(|(_, created)| *created));
    Ok(HistoryWindow {
        items: newest_first
            .into_iter()
            .rev()
            .flat_map(|shown| shown.items)
            .collect(),
        completed_users,
        starts_at_ms,
    })
}

/// Where a window that leaves older messages out opens: at the oldest time it
/// holds every message of. The messages created at the window's oldest time
/// can share it with messages on the page past the window, so they leave the
/// window for the history before it, and so does any stand-in older than
/// what stays. `None` when every message of the window was created at once.
fn open_at_place(newest_first: &mut Vec<Shown>) -> Option<i64> {
    let created = |shown: &Shown| shown.message.as_ref().map(|(_, created)| *created);
    let oldest = newest_first.iter().rev().find_map(created)?;
    let kept = newest_first
        .iter()
        .rposition(|shown| created(shown).is_some_and(|at| at > oldest))?;
    newest_first.truncate(kept + 1);
    created(&newest_first[kept])
}

/// The page of `provider`'s session history that ends before `place` and
/// starts no earlier than `floor`: the messages created in between, newest
/// first within the bounds of a backend page. Its older cursor is the oldest
/// time whose messages it holds, which the next older page reads before.
pub(super) async fn history_page(
    client: &OpenCodeSessionClient,
    provider: &str,
    session: &SessionId,
    places: &StdMutex<HistoryPlaces>,
    place: i64,
    floor: i64,
) -> Result<ProviderConversationActivity, CommandError> {
    let start = lock(places).start(place);
    let mut pages = client.message_pages_before(session, start);
    let mut page = BackendActivityPage::new(provider, session.as_str());
    // A history page shows each message as the provider recorded it, Dure's
    // own prompts too, so no turn the bridge tracks applies.
    let mut turns = BTreeMap::new();
    let mut at_place = None::<(i64, Vec<ConversationRecord>)>;
    let mut oldest_held = None::<i64>;
    let mut newer = None::<i64>;
    'pages: while let Some(read) = pages.next().await.map_err(provider_error)? {
        if read.unreadable {
            if newer.is_some_and(|newer| newer < place) {
                page.leave_out();
            }
            continue;
        }
        if let (Some(oldest), Some(cursor)) = (read.messages.first(), pages.next_cursor()) {
            lock(places).record(created_at_ms(oldest)?, cursor);
        }
        for message in read.messages.iter().rev() {
            let created = created_at_ms(message)?;
            if newer.is_some_and(|newer| created > newer) {
                *lock(places) = HistoryPlaces::default();
                return Err(protocol_error("session messages are not in creation order"));
            }
            newer = Some(created);
            if created >= place {
                continue;
            }
            if created < floor {
                break 'pages;
            }
            if let Some((at, records)) = at_place.take_if(|(at, _)| *at != created) {
                match page.prepend(records) {
                    Prepended::Added => oldest_held = Some(at),
                    Prepended::Full => return Ok(page.finish(cursor(oldest_held)?)),
                    Prepended::LeftOut => {}
                }
            }
            let Ok(records) = message_records(message, &mut turns) else {
                page.leave_out();
                continue;
            };
            // Within one place, records stay oldest first.
            let (_, records_then) = at_place.get_or_insert_with(|| (created, Vec::new()));
            let newer_records = std::mem::replace(records_then, records);
            records_then.extend(newer_records);
        }
    }
    if let Some((_, records)) = at_place
        && page.prepend(records) == Prepended::Full
    {
        return Ok(page.finish(cursor(oldest_held)?));
    }
    Ok(page.finish(None))
}

/// The place an older page reads before, as the history read names it.
fn cursor(place: Option<i64>) -> Result<Option<u64>, CommandError> {
    let place = place.ok_or_else(|| protocol_error("history page holds no place"))?;
    u64::try_from(place)
        .map(Some)
        .map_err(|_| protocol_error("message timestamp is negative"))
}

/// What one message says that a history page shows, from the same projection
/// that turns it into timeline rows: its text and its tool calls, in order.
fn message_records(
    message: &Value,
    turns: &mut BTreeMap<String, TurnContext>,
) -> Result<Vec<ConversationRecord>, CommandError> {
    let (items, _) = message_items(message, turns)?;
    Ok(items
        .into_iter()
        .filter_map(|item| match item.body {
            AgentTimelineItemBodyV1::Message { role, markdown } if !markdown.trim().is_empty() => {
                Some(ConversationRecord {
                    entry: Some(ProviderTranscriptEntry {
                        role: match role {
                            AgentTimelineMessageRoleV1::User => ConversationTurnRole::User,
                            AgentTimelineMessageRoleV1::Assistant => ConversationTurnRole::Agent,
                        },
                        text: markdown,
                    }),
                    tool_events: Vec::new(),
                })
            }
            AgentTimelineItemBodyV1::Tool {
                tool_call_id,
                name,
                state,
                input,
                ..
            } => Some(ConversationRecord {
                entry: None,
                tool_events: vec![ToolEvent::Call {
                    call_id: tool_call_id,
                    name,
                    state: match state {
                        AgentTimelineToolStateV1::Running => ProviderToolState::Running,
                        AgentTimelineToolStateV1::Completed => ProviderToolState::Completed,
                        AgentTimelineToolStateV1::Failed => ProviderToolState::Failed,
                        AgentTimelineToolStateV1::Canceled => ProviderToolState::Canceled,
                    },
                    input: input.as_ref().map_or(Value::Null, bounded_input),
                }],
            }),
            _ => None,
        })
        .collect())
}

fn lock(places: &StdMutex<HistoryPlaces>) -> std::sync::MutexGuard<'_, HistoryPlaces> {
    places
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn message_id(message: &Value) -> Result<&str, CommandError> {
    field(
        message
            .get("info")
            .ok_or_else(|| protocol_error("message info missing"))?,
        "id",
    )
}

fn created_at_ms(message: &Value) -> Result<i64, CommandError> {
    message
        .pointer("/info/time/created")
        .and_then(Value::as_i64)
        .ok_or_else(|| protocol_error("message timestamp missing"))
}

/// The existing boundary row before the message `newer_id`, created at
/// `newer_created`, which marks that older messages precede it. With the
/// `place` the history before it is read from, it is placed there; without
/// one, it says only that they are left out. The boundary that opens a window
/// and one that stands in for a message too large to read right before it
/// are the same row.
fn history_boundary(
    newer_id: &str,
    newer_created: i64,
    place: Option<i64>,
) -> Result<AgentTimelineItemDraftV1, CommandError> {
    item(
        &format!("history-boundary:{newer_id}"),
        None,
        None,
        AgentTimelineItemBodyV1::history_window(place),
        newer_created,
    )
}
