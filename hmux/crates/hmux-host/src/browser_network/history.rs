use super::*;
use hmux_session_protocol::browser_network_capture::{
    BrowserNetworkRequestDetails, BrowserNetworkResponseDetails,
};
use serde::Serialize;

const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default, Serialize)]
pub(super) struct Metadata {
    request: Option<BrowserNetworkRequestDetails>,
    response: Option<BrowserNetworkResponseDetails>,
}

pub struct BrowserNetworkRead {
    pub detail: BrowserNetworkDetail,
    /// Issued only for the latest completed use of this native request ID.
    pub body_source: Option<(BrowserNetworkId, BrowserNetworkId)>,
    pub decoded_bytes: Option<u64>,
}

impl BrowserNetworkHost {
    pub(super) fn recount_metadata_bytes(&mut self) {
        self.metadata_bytes = self
            .pending
            .values()
            .chain(self.history.iter())
            .map(|entry| entry.metadata_bytes)
            .sum();
    }

    fn edit_metadata(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        edit: impl FnOnce(&mut Metadata),
    ) {
        let Some(target) = self.source_target(source).cloned() else {
            return;
        };
        let Some(entry) = self
            .pending
            .get_mut(&(target, request.clone()))
            .filter(|entry| entry.visible)
        else {
            return;
        };
        self.metadata_bytes -= entry.metadata_bytes;
        edit(&mut entry.metadata);
        let size = serde_json::to_vec(&entry.metadata).map(|bytes| bytes.len());
        match size {
            Ok(size) if size <= MAX_METADATA_BYTES.saturating_sub(self.metadata_bytes) => {
                entry.metadata_bytes = size;
                self.metadata_bytes += size;
            }
            _ => {
                entry.metadata = Metadata::default();
                entry.metadata_bytes = 0;
            }
        }
    }

    /// Both consumers receive metadata normalized once at the engine boundary.
    pub fn observed_request_details(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        details: BrowserNetworkRequestDetails,
    ) {
        if self.capturing_source(source) {
            self.capture_request_details(source, request, details.clone());
        }
        self.edit_metadata(source, request, |entry| entry.request = Some(details));
    }

    pub fn observed_response_details(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        response: BrowserNetworkResponseDetails,
        has_extra: bool,
    ) {
        if self.capturing_source(source) {
            self.capture_response_details(source, request, response.clone(), has_extra);
        }
        self.edit_metadata(source, request, |entry| entry.response = Some(response));
    }

    pub fn observed_body_received(
        &mut self,
        source: &BrowserNetworkId,
        request: &BrowserNetworkId,
        encoded: u64,
        decoded: u64,
    ) {
        if self.capturing_source(source) {
            self.capture_body_received(source, request, encoded, decoded);
        }
        if let Some(target) = self.source_target(source).cloned() {
            if let Some(entry) = self.pending.get_mut(&(target, request.clone())) {
                entry.decoded_bytes = entry
                    .decoded_bytes
                    .and_then(|size| size.checked_add(decoded));
            }
        }
    }
}

impl BrowserResourceHost {
    pub fn network_read(
        &self,
        page: &BrowserPageIdentity,
        sequence: BrowserNetworkSequence,
    ) -> Result<Option<BrowserNetworkRead>, BrowserAdmissionError> {
        let target = self.target_for(page)?;
        let sequence = sequence.0.to_string();
        let Some(entry) = self
            .network
            .pending
            .values()
            .chain(self.network.history.iter())
            .find(|entry| {
                &entry.target == target && entry.visible && entry.value.sequence == sequence
            })
        else {
            return Ok(None);
        };
        let latest = !self
            .network
            .pending
            .contains_key(&(target.clone(), entry.id.clone()))
            && self
                .network
                .history
                .iter()
                .rev()
                .find(|candidate| &candidate.target == target && candidate.id == entry.id)
                .is_some_and(|candidate| candidate.value.sequence == sequence);
        let available = entry.value.state == BrowserNetworkState::Finished
            && latest
            && self.network.source_is_attached(&entry.source);
        let metadata = &entry.metadata;
        Ok(Some(BrowserNetworkRead {
            detail: BrowserNetworkDetail {
                page: page.clone(),
                request: entry.value.clone(),
                details: metadata.request.clone(),
                response: metadata.response.clone(),
                metadata_truncated: (entry.value.status.is_some() && metadata.response.is_none())
                    || metadata
                        .request
                        .as_ref()
                        .is_none_or(|details| details.truncated)
                    || metadata
                        .response
                        .as_ref()
                        .is_some_and(|response| response.truncated),
                body: None,
                body_error: None,
            },
            body_source: available.then(|| (entry.source.clone(), entry.id.clone())),
            decoded_bytes: entry.decoded_bytes,
        }))
    }
}
