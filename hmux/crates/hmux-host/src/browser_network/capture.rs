use super::*;
use hmux_session_protocol::browser_network_capture::*;

mod extra;

const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CAPTURE_ENTRIES: usize = 4096;

pub(super) struct Captured {
    entry: BrowserNetworkCaptureEntry,
    bytes: usize,
    wire: extra::Wire,
}

impl Captured {
    fn metadata_complete(&self) -> bool {
        self.wire.metadata_complete() && !self.entry.metadata_truncated()
    }
}

#[derive(Default)]
pub(super) struct Capture {
    entries: Vec<Captured>,
    extras: VecDeque<extra::Extra>,
    // Redirects reuse a request ID. Keep the entire already-in-flight request
    // outside this interval so its late headers cannot join a later hop.
    excluded: BTreeSet<BrowserNetworkId>,
    truncated: bool,
}

impl BrowserNetworkHost {
    pub fn capturing_source(&self, source: &BrowserNetworkId) -> bool {
        self.source_target(source)
            .is_some_and(|target| self.captures.contains_key(target))
    }

    fn reserve_capture(
        &mut self,
        target: &BrowserTargetId,
        mut captured: Captured,
    ) -> Option<Captured> {
        let bytes = serde_json::to_vec(&captured.entry).ok()?.len();
        if captured.entry.metadata_truncated() {
            if let Some(capture) = self.captures.get_mut(target) {
                capture.truncated = true;
            }
        }
        if self.capture_count >= MAX_CAPTURE_ENTRIES
            || bytes > MAX_CAPTURE_BYTES.saturating_sub(self.capture_bytes)
        {
            if let Some(capture) = self.captures.get_mut(target) {
                capture.truncated = true;
            }
            return None;
        }
        self.capture_count += 1;
        self.capture_bytes += bytes;
        captured.bytes = bytes;
        Some(captured)
    }

    fn release_capture(&mut self, mut captured: Captured) -> Captured {
        self.capture_count -= 1;
        self.capture_bytes -= captured.bytes;
        captured.bytes = 0;
        captured
    }

    /// Adds details to the request admitted by the existing lifetime ledger.
    pub fn capture_request_details(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        details: BrowserNetworkRequestDetails,
    ) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        if self
            .captures
            .get(&target)
            .is_none_or(|capture| capture.excluded.contains(request))
        {
            return;
        }
        let key = (target.clone(), request.clone());
        let Some(pending) = self.pending.get(&key) else {
            return;
        };
        if pending.capture.is_some() {
            return;
        }
        let entry = BrowserNetworkCaptureEntry {
            request: pending.value.clone(),
            source: source.as_str().into(),
            details,
            response: None,
            completed_timestamp: None,
            body_size: None,
            decoded_body_size: None,
            encoded_data_length: None,
        };
        let captured = self.reserve_capture(
            &target,
            Captured {
                entry,
                bytes: 0,
                wire: extra::Wire::new(request.clone()),
            },
        );
        self.pending
            .get_mut(&key)
            .expect("existing request")
            .capture = captured;
    }

    fn edit_capture(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        edit: impl FnOnce(&mut Captured),
    ) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        let key = (target.clone(), request.clone());
        let Some(captured) = self
            .pending
            .get_mut(&key)
            .and_then(|request| request.capture.take())
        else {
            return;
        };
        let mut entry = self.release_capture(captured);
        edit(&mut entry);
        let captured = self.reserve_capture(&target, entry);
        self.pending
            .get_mut(&key)
            .expect("existing request")
            .capture = captured;
    }

    pub fn capture_response_details(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        response: BrowserNetworkResponseDetails,
        has_extra: bool,
    ) {
        self.edit_capture(source, request, |captured| {
            captured.entry.response = Some(response);
            captured.wire.expected = Some(has_extra);
        });
        if let Some(target) = self.source_target(source).cloned() {
            self.reconcile_capture_extra(&target, false);
        }
    }

    pub fn capture_completion_details(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        timestamp: Option<f64>,
        encoded_data_length: Option<u64>,
    ) {
        self.edit_capture(source, request, |captured| {
            let entry = &mut captured.entry;
            entry.completed_timestamp = timestamp;
            entry.encoded_data_length = encoded_data_length;
        });
    }

    pub fn capture_body_received(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        encoded: u64,
        decoded: u64,
    ) {
        self.edit_capture(source, request, |captured| {
            let entry = &mut captured.entry;
            entry.body_size = entry.body_size.unwrap_or(0).checked_add(encoded);
            entry.decoded_body_size = entry.decoded_body_size.unwrap_or(0).checked_add(decoded);
            entry.details.truncated |=
                entry.body_size.is_none() || entry.decoded_body_size.is_none();
        });
    }

    pub(super) fn capture_finished(&mut self, request: &mut Request) {
        let Some(captured) = request.capture.take() else {
            return;
        };
        let mut entry = self.release_capture(captured);
        entry.entry.request = request.value.clone();
        entry.entry.source = request.source.as_str().into();
        if let Some(captured) = self.reserve_capture(&request.target, entry) {
            self.captures
                .get_mut(&request.target)
                .expect("recording owns details")
                .entries
                .push(captured);
        }
    }

    pub(super) fn drain_capture(
        &mut self,
        target: &BrowserTargetId,
    ) -> Vec<BrowserNetworkCaptureEntry> {
        let capture = self.captures.remove(target).unwrap_or_default();
        for extra in &capture.extras {
            self.capture_bytes -= extra.bytes;
            self.capture_extra_count -= 1;
        }
        let mut entries = capture.entries;
        for request in self
            .pending
            .values_mut()
            .filter(|request| &request.target == target)
        {
            if let Some(mut captured) = request.capture.take() {
                captured.entry.request = request.value.clone();
                entries.push(captured);
            }
        }
        let mut entries: Vec<_> = entries
            .into_iter()
            .map(|entry| {
                let mut captured = self.release_capture(entry);
                captured.wire.finish(&mut captured.entry);
                captured.entry
            })
            .collect();
        entries.sort_by(|a, b| {
            a.request
                .sequence
                .len()
                .cmp(&b.request.sequence.len())
                .then(a.request.sequence.cmp(&b.request.sequence))
        });
        entries
    }

    pub(crate) fn start_capture(&mut self, target: &BrowserTargetId) {
        self.drain_capture(target);
        let excluded = self
            .pending
            .keys()
            .filter(|(page, _)| page == target)
            .map(|(_, request)| request.clone())
            .collect();
        self.captures.insert(
            target.clone(),
            Capture {
                excluded,
                ..Capture::default()
            },
        );
    }

    pub(crate) fn capture_status(
        &self,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
    ) -> BrowserNetworkCaptureStatus {
        let capture = self.captures.get(target);
        let pending = self
            .pending
            .values()
            .filter(|entry| &entry.target == target && entry.capture.is_some())
            .count();
        BrowserNetworkCaptureStatus {
            page: page.clone(),
            recording: capture.is_some(),
            recorded: capture.map_or(0, |capture| capture.entries.len()) + pending,
            complete: self.coverage_complete(target)
                && !capture.is_some_and(|capture| {
                    capture.truncated
                        || !capture.extras.is_empty()
                        || capture
                            .entries
                            .iter()
                            .any(|entry| !entry.metadata_complete())
                })
                && self
                    .pending
                    .values()
                    .filter(|entry| &entry.target == target)
                    .all(|entry| {
                        entry
                            .capture
                            .as_ref()
                            .is_none_or(Captured::metadata_complete)
                    }),
        }
    }

    pub(crate) fn stop_capture(
        &mut self,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
    ) -> BrowserNetworkCapture {
        self.reconcile_capture_extra(target, true);
        let status = self.capture_status(page, target);
        let truncated = self
            .captures
            .get(target)
            .is_some_and(|capture| capture.truncated || !capture.extras.is_empty());
        let entries = self.drain_capture(target);
        let metadata_complete = entries.iter().all(|entry| !entry.metadata_truncated());
        BrowserNetworkCapture {
            page: page.clone(),
            complete: status.complete && metadata_complete,
            truncated: truncated || !metadata_complete,
            entries,
        }
    }
}

#[cfg(test)]
mod tests;
