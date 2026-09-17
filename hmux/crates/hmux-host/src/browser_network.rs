//! One bounded request lifetime ledger per browser resource.

use crate::browser_resource::{BrowserAdmissionError, BrowserResourceHost};
use hmux_session_protocol::browser_network::*;
use hmux_session_protocol::browser_resource::{BrowserPageIdentity, BrowserTargetId};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Instant;

mod capture;
mod history;
pub use history::BrowserNetworkRead;

const MAX_PENDING: usize = 512;
const MAX_HISTORY: usize = 256;
const MAX_SOURCES: usize = 1024;

/// Parsed once at the engine boundary; never truncate an identity.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct BrowserNetworkId(String);

impl BrowserNetworkId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn new(value: &str) -> Result<Self, &'static str> {
        if value.is_empty()
            || value.len() > 160
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err("browser_network_identity_invalid");
        }
        Ok(Self(value.into()))
    }
}

struct PageNetwork {
    complete: bool,
    last_activity: Instant,
    history_truncated: bool,
}

struct Request {
    id: BrowserNetworkId,
    target: BrowserTargetId,
    source: BrowserNetworkId,
    value: BrowserNetworkRequest,
    capture: Option<capture::Captured>,
    visible: bool,
    metadata: history::Metadata,
    metadata_bytes: usize,
    decoded_bytes: Option<u64>,
}

struct Source {
    page: BrowserTargetId,
    engine_target: BrowserTargetId,
    detached: bool,
}

#[derive(Default)]
pub struct BrowserNetworkHost {
    captures: BTreeMap<BrowserTargetId, capture::Capture>,
    capture_bytes: usize,
    capture_count: usize,
    capture_extra_count: usize,
    sources: BTreeMap<BrowserNetworkId, Source>,
    pages: BTreeMap<BrowserTargetId, PageNetwork>,
    // A request can start in a parent source and finish in its child. Its
    // lifetime belongs to the page, independent of the reporting process.
    pending: BTreeMap<(BrowserTargetId, BrowserNetworkId), Request>,
    history: VecDeque<Request>,
    next_sequence: u64,
    lost: bool,
    metadata_bytes: usize,
}

fn bounded(value: &str, limit: usize, truncated: &mut bool) -> String {
    if value.len() <= limit {
        return value.into();
    }
    *truncated = true;
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}

impl BrowserNetworkHost {
    pub fn sources(&self) -> Vec<BrowserNetworkId> {
        self.sources
            .iter()
            .filter(|(_, source)| !source.detached)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn source_is_attached(&self, source: &BrowserNetworkId) -> bool {
        self.sources
            .get(source)
            .is_some_and(|source| !source.detached)
    }

    pub fn page_source(&self, target: &BrowserTargetId) -> Option<BrowserNetworkId> {
        self.sources
            .iter()
            .find(|(_, source)| {
                !source.detached && &source.page == target && source.engine_target == source.page
            })
            .map(|(id, _)| id.clone())
    }

    pub fn source_engine_target(&self, source: &BrowserNetworkId) -> Option<&BrowserTargetId> {
        self.sources.get(source).map(|source| &source.engine_target)
    }

    pub fn source_target(&self, source: &BrowserNetworkId) -> Option<&BrowserTargetId> {
        self.sources.get(source).map(|source| &source.page)
    }

    pub fn attach(
        &mut self,
        source: BrowserNetworkId,
        engine_target: BrowserTargetId,
        target: BrowserTargetId,
        from_start: bool,
        now: Instant,
    ) -> Result<(), &'static str> {
        if self.sources.len() >= MAX_SOURCES
            || self.pages.len() >= 128 && !self.pages.contains_key(&target)
        {
            self.lost = true;
            return Err("browser_network_source_limit");
        }
        if self.sources.contains_key(&source) {
            self.lost = true;
            return Err("browser_network_source_duplicate");
        }
        let page = self.pages.entry(target.clone()).or_insert(PageNetwork {
            complete: true,
            last_activity: now,
            history_truncated: false,
        });
        page.complete &= from_start;
        page.last_activity = now;
        self.sources.insert(
            source,
            Source {
                page: target,
                engine_target,
                detached: false,
            },
        );
        Ok(())
    }

    /// An unaccounted disconnect cannot turn outstanding work into idle.
    pub fn detach(&mut self, source: &BrowserNetworkId, now: Instant) {
        if let Some(source) = self.sources.get_mut(source) {
            source.detached = true;
            if let Some(page) = self.pages.get_mut(&source.page) {
                page.last_activity = now;
            }
        }
    }

    /// An attached source can precede its target's appearance in a census.
    /// Detachment plus absence releases drained sources; closure alone cannot
    /// finish requests that can migrate between processes.
    pub fn reconcile_sources(
        &mut self,
        pages: &BTreeSet<BrowserTargetId>,
        live_targets: &BTreeSet<BrowserTargetId>,
        now: Instant,
    ) {
        let closed: Vec<_> = self
            .sources
            .iter()
            .filter(|(_, source)| {
                pages.contains(&source.page)
                    && source.detached
                    && !live_targets.contains(&source.engine_target)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for source in closed {
            if self.pending.values().any(|entry| entry.source == source) {
                self.detach(&source, now);
                continue;
            }
            if let Some(source) = self.sources.remove(&source) {
                if let Some(page) = self.pages.get_mut(&source.page) {
                    page.last_activity = now;
                }
            }
        }
    }

    /// The observed request owns its precise renderer resource type. Fetch can
    /// report the coarser loader category (XHR also covers fetch/EventSource).
    pub fn request_resource_type(
        &self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
    ) -> Option<&str> {
        let target = self.source_target(source)?;
        self.pending
            .get(&(target.clone(), request.clone()))
            .or_else(|| {
                self.history
                    .iter()
                    .rev()
                    .find(|entry| &entry.target == target && &entry.id == request)
            })
            .map(|request| request.value.resource_type.as_str())
    }

    pub fn observation_lost(&mut self, targets: &BTreeSet<BrowserTargetId>) {
        for (target, page) in &mut self.pages {
            if targets.contains(target) {
                page.complete = false;
            }
        }
        for source in self.sources.values_mut() {
            if targets.contains(&source.page) {
                source.detached = true;
            }
        }
    }

    pub fn started(
        &mut self,
        source: &BrowserNetworkId,
        request: BrowserNetworkId,
        metadata: (&str, &str, &str),
        now: Instant,
    ) -> Result<(), &'static str> {
        let target = self
            .sources
            .get(source)
            .map(|source| &source.page)
            .cloned()
            .ok_or("browser_network_source_missing")?;
        // Redirects reuse the page's request ID. Retain each completed hop.
        self.finish(source, &request, BrowserNetworkState::Redirected, None, now);
        if self.pending.len() >= MAX_PENDING {
            self.lost = true;
            return Err("browser_network_pending_limit");
        }
        self.next_sequence = match self.next_sequence.checked_add(1) {
            Some(next) => next,
            None => {
                self.lost = true;
                return Err("browser_network_sequence_exhausted");
            }
        };
        let mut truncated = false;
        let value = BrowserNetworkRequest {
            sequence: self.next_sequence.to_string(),
            url: bounded(metadata.0, 1024, &mut truncated),
            method: bounded(metadata.1, 32, &mut truncated),
            resource_type: bounded(metadata.2, 64, &mut truncated),
            status: None,
            state: BrowserNetworkState::Pending,
            error: None,
            metadata_truncated: truncated,
        };
        self.pages
            .get_mut(&target)
            .expect("attached source owns a page")
            .last_activity = now;
        self.pending.insert(
            (target.clone(), request.clone()),
            Request {
                id: request,
                target,
                source: source.clone(),
                value,
                capture: None,
                visible: true,
                metadata: history::Metadata::default(),
                metadata_bytes: 0,
                decoded_bytes: Some(0),
            },
        );
        Ok(())
    }

    /// Response headers alone do not finish a streaming response body.
    pub fn response(&mut self, source: &BrowserNetworkId, request: &BrowserNetworkId, status: u16) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        if let Some(entry) = self.pending.get_mut(&(target.clone(), request.clone())) {
            entry.value.status = Some(status);
            entry.source = source.clone();
        }
    }

    pub fn completed(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        result: Result<(), &str>,
        now: Instant,
    ) {
        let state = if result.is_ok() {
            BrowserNetworkState::Finished
        } else {
            BrowserNetworkState::Failed
        };
        self.finish(source, request, state, result.err(), now);
    }

    fn finish(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        state: BrowserNetworkState,
        error: Option<&str>,
        now: Instant,
    ) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        if let Some(mut entry) = self.pending.remove(&(target.clone(), request.clone())) {
            entry.value.state = state;
            entry.value.error =
                error.map(|error| bounded(error, 256, &mut entry.value.metadata_truncated));
            self.pages
                .get_mut(&entry.target)
                .expect("pending request owns a page")
                .last_activity = now;
            self.capture_finished(&mut entry);
            if entry.visible {
                self.history.push_back(entry);
            } else {
                self.metadata_bytes -= entry.metadata_bytes;
            }
            if self.history.len() > MAX_HISTORY {
                if let Some(evicted) = self.history.pop_front() {
                    self.metadata_bytes -= evicted.metadata_bytes;
                    if let Some(page) = self.pages.get_mut(&evicted.target) {
                        page.history_truncated = true;
                    }
                }
            }
        }
    }

    pub(super) fn remove_page(&mut self, target: &BrowserTargetId) {
        self.drain_capture(target);
        self.sources.retain(|_, source| &source.page != target);
        self.pending.retain(|_, entry| &entry.target != target);
        self.history.retain(|entry| &entry.target != target);
        self.pages.remove(target);
        self.recount_metadata_bytes();
    }

    fn coverage_complete(&self, target: &BrowserTargetId) -> bool {
        !self.lost
            && self.pages.get(target).is_some_and(|state| state.complete)
            && !self
                .sources
                .values()
                .any(|source| &source.page == target && source.detached)
    }

    fn snapshot(
        &self,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
        now: Instant,
    ) -> BrowserNetworkSnapshot {
        let state = self.pages.get(target);
        let complete = self.coverage_complete(target);
        let pending = self
            .pending
            .values()
            .filter(|entry| &entry.target == target)
            .count();
        let quiet_ms = state.filter(|_| complete && pending == 0).map(|state| {
            now.saturating_duration_since(state.last_activity)
                .as_millis()
                .min(u64::MAX as u128) as u64
        });
        let mut requests: Vec<_> = self
            .history
            .iter()
            .chain(self.pending.values())
            .filter(|entry| &entry.target == target && entry.visible)
            .map(|entry| entry.value.clone())
            .collect();
        // Numeric order without interpreting the public decimal as a JS number.
        requests.sort_by(|a, b| {
            a.sequence
                .len()
                .cmp(&b.sequence.len())
                .then(a.sequence.cmp(&b.sequence))
        });
        BrowserNetworkSnapshot {
            page: page.clone(),
            complete,
            pending,
            idle: quiet_ms.is_some_and(|ms| ms >= 500),
            quiet_ms,
            history_truncated: self
                .pages
                .get(target)
                .is_some_and(|page| page.history_truncated),
            requests,
        }
    }
}

impl BrowserResourceHost {
    pub fn network_state(
        &self,
        resource: &hmux_session_protocol::browser_resource::BrowserResourceIdentity,
        page: &hmux_session_protocol::browser_resource::BrowserPageId,
        now: Instant,
    ) -> Result<BrowserNetworkSnapshot, BrowserAdmissionError> {
        let mut identity = self.page_identity(page)?;
        identity.resource = resource.clone();
        self.network_snapshot(&identity, now)
    }

    pub fn clear_network(
        &mut self,
        permit: &crate::browser_resource::BrowserActionPermit,
    ) -> Result<usize, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        let before = self.network.history.len();
        self.network.history.retain(|entry| entry.target != target);
        let mut removed = before - self.network.history.len();
        for request in self
            .network
            .pending
            .values_mut()
            .filter(|request| request.target == target)
        {
            removed += usize::from(request.visible);
            request.visible = false;
            request.metadata = history::Metadata::default();
            request.metadata_bytes = 0;
        }
        if let Some(page) = self.network.pages.get_mut(&target) {
            page.history_truncated = false;
        }
        self.network.recount_metadata_bytes();
        Ok(removed)
    }

    pub fn network(&mut self) -> &mut BrowserNetworkHost {
        &mut self.network
    }

    pub fn network_snapshot(
        &self,
        page: &BrowserPageIdentity,
        now: Instant,
    ) -> Result<BrowserNetworkSnapshot, BrowserAdmissionError> {
        let target = self.target_for(page)?;
        Ok(self.network.snapshot(page, target, now))
    }
}

#[cfg(test)]
mod tests;
