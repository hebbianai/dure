//! Header fragments can precede their base event or follow completion. This
//! bounded queue only joins metadata; the existing request ledger owns lifetime.
use super::*;

pub(super) struct Wire {
    request: BrowserNetworkId,
    pub(super) expected: Option<bool>,
    request_received: bool,
    response_received: bool,
    status: Option<u16>,
}

impl Wire {
    pub(super) fn new(request: BrowserNetworkId) -> Self {
        Self {
            request,
            expected: None,
            request_received: false,
            response_received: false,
            status: None,
        }
    }
    fn accepts(&self, extra: &Extra, unfinished: bool) -> bool {
        self.request == extra.request
            && (self.expected == Some(true) || unfinished && self.expected.is_none())
            && if extra.status.is_some() {
                !self.response_received
            } else {
                !self.request_received
            }
    }
    pub(super) fn metadata_complete(&self) -> bool {
        self.expected != Some(true) || self.request_received && self.response_received
    }
    pub(super) fn finish(&self, entry: &mut BrowserNetworkCaptureEntry) {
        if let Some(status) = self.status {
            entry.request.status = Some(status);
        }
        if !self.metadata_complete() {
            entry.details.truncated = true;
        }
    }
}

pub(super) struct Extra {
    request: BrowserNetworkId,
    headers: Vec<BrowserNetworkHeader>,
    status: Option<u16>,
    truncated: bool,
    pub(super) bytes: usize,
}

enum Location {
    Completed(usize),
    Pending(BrowserNetworkId),
}

impl BrowserNetworkHost {
    pub fn capture_extra_headers(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        headers: Vec<BrowserNetworkHeader>,
        status: Option<u16>,
        truncated: bool,
    ) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        let Some(capture) = self.captures.get_mut(&target) else {
            return;
        };
        if capture.excluded.contains(request) {
            return;
        }
        let bytes = headers
            .iter()
            .map(|header| header.name.len() + header.value.len())
            .sum::<usize>()
            + request.as_str().len();
        if self.capture_extra_count >= 1024
            || bytes > MAX_CAPTURE_BYTES.saturating_sub(self.capture_bytes)
        {
            capture.truncated = true;
            return;
        }
        self.capture_extra_count += 1;
        self.capture_bytes += bytes;
        capture.extras.push_back(Extra {
            request: request.clone(),
            headers,
            status,
            truncated,
            bytes,
        });
        self.reconcile_capture_extra(&target, false);
    }

    fn extra_location(
        &self,
        target: &BrowserTargetId,
        extra: &Extra,
        unfinished: bool,
    ) -> Option<Location> {
        if let Some(index) = self
            .captures
            .get(target)?
            .entries
            .iter()
            .position(|entry| entry.wire.accepts(extra, unfinished))
        {
            return Some(Location::Completed(index));
        }
        self.pending.iter().find_map(|((page, request), entry)| {
            (page == target
                && entry
                    .capture
                    .as_ref()
                    .is_some_and(|entry| entry.wire.accepts(extra, unfinished)))
            .then(|| Location::Pending(request.clone()))
        })
    }

    pub(super) fn reconcile_capture_extra(&mut self, target: &BrowserTargetId, unfinished: bool) {
        let mut index = 0;
        while let Some(extra) = self
            .captures
            .get(target)
            .and_then(|capture| capture.extras.get(index))
        {
            let Some(location) = self.extra_location(target, extra, unfinished) else {
                index += 1;
                continue;
            };
            let extra = self
                .captures
                .get_mut(target)
                .unwrap()
                .extras
                .remove(index)
                .unwrap();
            self.capture_extra_count -= 1;
            self.capture_bytes -= extra.bytes;
            let captured = match &location {
                Location::Completed(index) => self
                    .captures
                    .get_mut(target)
                    .unwrap()
                    .entries
                    .remove(*index),
                Location::Pending(request) => self
                    .pending
                    .get_mut(&(target.clone(), request.clone()))
                    .unwrap()
                    .capture
                    .take()
                    .unwrap(),
            };
            let mut captured = self.release_capture(captured);
            captured.entry.details.truncated |= extra.truncated;
            if let Some(status) = extra.status {
                captured.wire.response_received = true;
                captured.wire.status = Some(status);
                let response =
                    captured
                        .entry
                        .response
                        .get_or_insert_with(|| BrowserNetworkResponseDetails {
                            status_text: String::new(),
                            protocol: String::new(),
                            headers: vec![],
                            mime_type: String::new(),
                            encoded_data_length: None,
                            timing: None,
                            truncated: false,
                        });
                response.headers = extra.headers;
            } else {
                captured.wire.request_received = true;
                captured.entry.details.headers = extra.headers;
            }
            let captured = self.reserve_capture(target, captured);
            match location {
                Location::Completed(index) => {
                    if let Some(captured) = captured {
                        self.captures
                            .get_mut(target)
                            .unwrap()
                            .entries
                            .insert(index, captured);
                    }
                }
                Location::Pending(request) => {
                    self.pending
                        .get_mut(&(target.clone(), request))
                        .unwrap()
                        .capture = captured
                }
            }
        }
    }
}
