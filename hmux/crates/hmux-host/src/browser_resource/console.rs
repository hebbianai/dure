//! One bounded console history, fed by the existing registered event sources.

use super::{BrowserActionPermit, BrowserAdmissionError, BrowserResourceHost};
use crate::browser_network::BrowserNetworkId;
use hmux_session_protocol::browser_console::*;
use hmux_session_protocol::browser_resource::*;
use std::collections::{BTreeSet, VecDeque};

const MAX_ENTRIES: usize = 1000;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

/// Raw text comes from engine event metadata, never another page evaluation.
pub struct BrowserConsoleMessage<'a> {
    pub kind: BrowserConsoleKind,
    pub level: &'a str,
    pub text: &'a str,
    pub timestamp: f64,
    pub url: Option<&'a str>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

struct Entry {
    page: BrowserPageId,
    sequence: u64,
    bytes: usize,
    value: BrowserConsoleEntry,
}

#[derive(Default)]
pub(super) struct ConsoleState {
    entries: VecDeque<Entry>,
    truncated: BTreeSet<BrowserPageId>,
    bytes: usize,
    sequence: u64,
}

fn bounded(value: &str, limit: usize, truncated: &mut bool) -> String {
    let mut end = value.len().min(limit);
    *truncated |= end < value.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}

impl ConsoleState {
    pub(super) fn remove_page(&mut self, page: &BrowserPageId) -> usize {
        self.remove_entries(page, None)
    }

    fn remove_entries(&mut self, page: &BrowserPageId, kind: Option<BrowserConsoleKind>) -> usize {
        let before = self.entries.len();
        self.entries.retain(|entry| {
            &entry.page != page || kind.is_some_and(|kind| entry.value.kind != kind)
        });
        self.bytes = self.entries.iter().map(|entry| entry.bytes).sum();
        // A selective clear cannot erase evidence that another kind was lost.
        if kind.is_none() {
            self.truncated.remove(page);
        }
        before - self.entries.len()
    }
}

impl BrowserResourceHost {
    pub fn console_observed(
        &mut self,
        source: &BrowserNetworkId,
        message: BrowserConsoleMessage<'_>,
    ) -> Result<(), &'static str> {
        if !message.timestamp.is_finite() || message.timestamp < 0.0 {
            return Err("browser_console_timestamp_invalid");
        }
        // A closed page's late event cannot create or select a new page.
        if !self.network.source_is_attached(source) {
            return Ok(());
        }
        let Some(target) = self.network.source_target(source) else {
            return Ok(());
        };
        let Some(page) = self.page_for_target(target) else {
            return Ok(());
        };
        let sequence = self
            .console
            .sequence
            .checked_add(1)
            .ok_or("browser_console_sequence_exhausted")?;
        let mut truncated = false;
        let value = BrowserConsoleEntry {
            sequence: sequence.to_string(),
            source: source.as_str().into(),
            kind: message.kind,
            level: bounded(message.level, 64, &mut truncated),
            text: bounded(message.text, 64 * 1024, &mut truncated),
            timestamp: message.timestamp,
            url: message.url.map(|url| bounded(url, 8192, &mut truncated)),
            line: message.line,
            column: message.column,
            metadata_truncated: truncated,
        };
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| "browser_console_encoding_invalid")?
            .len();
        self.console.sequence = sequence;
        self.console.bytes += bytes;
        self.console.entries.push_back(Entry {
            page: page.page_id,
            sequence,
            bytes,
            value,
        });
        while self.console.entries.len() > MAX_ENTRIES || self.console.bytes > MAX_HISTORY_BYTES {
            let entry = self
                .console
                .entries
                .pop_front()
                .expect("history exceeds its bound");
            self.console.bytes -= entry.bytes;
            self.console.truncated.insert(entry.page);
        }
        Ok(())
    }

    pub fn console_snapshot(
        &self,
        resource: &BrowserResourceIdentity,
        page_id: &BrowserPageId,
        query: BrowserConsoleQuery,
    ) -> Result<BrowserConsoleSnapshot, BrowserAdmissionError> {
        self.require_identity(resource)?;
        let page = self.page_identity(page_id)?;
        let mut entries = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for entry in self.console.entries.iter().rev().filter(|entry| {
            &entry.page == page_id
                && query.kind.is_none_or(|kind| entry.value.kind == kind)
                && query
                    .before
                    .is_none_or(|before| entry.sequence < before.get())
        }) {
            if entries.len() as u64 >= query.limit.get() || bytes + entry.bytes > MAX_RESPONSE_BYTES
            {
                more = true;
                break;
            }
            bytes += entry.bytes;
            entries.push(entry.value.clone());
        }
        entries.reverse();
        let history_truncated = self.console.truncated.contains(page_id);
        Ok(BrowserConsoleSnapshot {
            page,
            next_before: if more {
                entries.first().map(|entry| entry.sequence.clone())
            } else {
                None
            },
            entries,
            truncated: more || history_truncated,
            history_truncated,
        })
    }

    pub fn clear_console(
        &mut self,
        permit: &BrowserActionPermit,
        kind: Option<BrowserConsoleKind>,
    ) -> Result<usize, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?;
        let page = self
            .page_for_target(target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        Ok(self.console.remove_entries(&page.page_id, kind))
    }
}

#[cfg(test)]
mod tests;
