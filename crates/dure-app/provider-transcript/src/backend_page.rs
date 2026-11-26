//! An older page of a conversation that a backend reads through the
//! provider's own API instead of from a transcript file, in the shape and
//! within the bounds of a page [`crate::read_roots_activity_page`] answers.
//!
//! The backend reads the provider's records back from the newest. A record
//! sits at a place in the conversation, which the provider names, and an
//! older page starts at a place: so the records of one place go into a page
//! whole or not at all, and pages join exactly where they meet.

use crate::tools::{ToolEvent, ToolWindow, event_bytes};
use crate::{
    Limits, ProviderConversationActivity, ProviderConversationTranscript, ProviderTranscriptEntry,
};

/// What one record of a conversation says that a reader shows: its message,
/// and then the tool calls it makes.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationRecord {
    pub entry: Option<ProviderTranscriptEntry>,
    pub tool_events: Vec<ToolEvent>,
}

/// What [`BackendActivityPage::prepend`] did with the records of a place.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Prepended {
    /// The page holds them.
    Added,
    /// They do not fit beside the newer records, so the page ends before
    /// them and the next older page starts with them.
    Full,
    /// They are larger than a whole page, so no page can show them: they are
    /// left out, and the page goes on with the records before them.
    LeftOut,
}

/// One older page assembled from a provider's records, newest place first.
pub struct BackendActivityPage {
    provider: String,
    conversation_id: String,
    /// The records of each place added, newest place first.
    places: Vec<Vec<ConversationRecord>>,
    used: Usage,
    lossless: bool,
}

/// What a page's records use of its bounds.
#[derive(Clone, Copy, Default)]
struct Usage {
    output: usize,
    entries: usize,
    tool_bytes: usize,
    tool_calls: usize,
}

impl Usage {
    fn of(records: &[ConversationRecord]) -> Self {
        let mut usage = Self::default();
        for record in records {
            if let Some(entry) = &record.entry {
                usage.output += entry.text.len();
                usage.entries += 1;
            }
            for event in &record.tool_events {
                usage.tool_bytes += event_bytes(event);
                usage.tool_calls += usize::from(matches!(event, ToolEvent::Call { .. }));
            }
        }
        usage
    }

    fn plus(self, other: Self) -> Self {
        Self {
            output: self.output + other.output,
            entries: self.entries + other.entries,
            tool_bytes: self.tool_bytes + other.tool_bytes,
            tool_calls: self.tool_calls + other.tool_calls,
        }
    }

    fn within(self, limits: Limits) -> bool {
        self.output <= limits.output
            && self.entries <= limits.entries
            && self.tool_bytes <= limits.tool_bytes
            && self.tool_calls <= limits.tool_calls
    }
}

impl BackendActivityPage {
    #[must_use]
    pub fn new(provider: &str, conversation_id: &str) -> Self {
        Self {
            provider: provider.to_owned(),
            conversation_id: conversation_id.to_owned(),
            places: Vec::new(),
            used: Usage::default(),
            lossless: true,
        }
    }

    /// Adds the records of one place, older than every place added so far.
    pub fn prepend(&mut self, records: Vec<ConversationRecord>) -> Prepended {
        let used = self.used.plus(Usage::of(&records));
        if !used.within(Limits::BACKEND_PAGE) {
            if self.places.is_empty() {
                self.lossless = false;
                return Prepended::LeftOut;
            }
            return Prepended::Full;
        }
        self.used = used;
        self.places.push(records);
        Prepended::Added
    }

    /// Notes a record the backend could not read, which the page leaves out.
    pub fn leave_out(&mut self) {
        self.lossless = false;
    }

    /// The page, oldest first. `older_cursor` names the place the next older
    /// page starts at; without one, the page reaches the conversation's start
    /// or the floor it was read down to.
    #[must_use]
    pub fn finish(self, older_cursor: Option<u64>) -> ProviderConversationActivity {
        let mut entries = Vec::with_capacity(self.used.entries);
        let mut window = ToolWindow::default();
        let mut lossless = self.lossless;
        for record in self.places.into_iter().rev().flatten() {
            if let Some(entry) = record.entry {
                entries.push(entry);
            }
            // A record's own text comes before the calls it makes.
            lossless &= window.apply(record.tool_events, entries.len());
        }
        ProviderConversationActivity {
            transcript: ProviderConversationTranscript {
                schema_version: 1,
                provider: self.provider,
                conversation_id: self.conversation_id,
                history_complete: older_cursor.is_none() && lossless,
                final_response: None,
                entries,
            },
            tools: window.finish(0),
            older_cursor,
        }
    }
}

#[cfg(test)]
#[path = "backend_page_tests.rs"]
mod tests;
