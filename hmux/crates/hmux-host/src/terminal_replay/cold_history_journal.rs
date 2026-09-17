use super::TerminalReplayError;
use super::cold_history::{
    ColdHistoryIdentity, DurablePageEnvelope, HistoryBoundary, HistoryTransferOffer, JournalRoot,
    LogicalCellAnchor, NativePageRecord,
};
use crate::local_discovery::ColdHistoryStorage;
use prost::Message;
use std::sync::{Arc, Mutex};

const ROOT_SCHEMA_VERSION: u32 = 2;
const CHUNK_SCHEMA_VERSION: u32 = 3;
const MAX_ROOT_BYTES: usize = 64 * 1024;
const CHUNK_ENVELOPE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(super) struct DurableColdHistoryJournal {
    storage: ColdHistoryStorage,
    cache: Arc<Mutex<Option<DurableJournalCache>>>,
}

#[derive(Clone)]
struct DurableJournalCache {
    root: JournalRoot,
    activated: bool,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
struct DurableRoot {
    #[prost(uint32, tag = "1")]
    schema_version: u32,
    #[prost(string, tag = "2")]
    history_namespace: String,
    #[prost(string, tag = "3")]
    store_id: String,
    #[prost(uint64, tag = "4")]
    generation: u64,
    #[prost(message, optional, tag = "5")]
    end_boundary: Option<DurableBoundaryMessage>,
    #[prost(bytes = "vec", tag = "6")]
    digest: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
struct DurableChunk {
    #[prost(uint32, tag = "1")]
    schema_version: u32,
    #[prost(message, optional, tag = "2")]
    offer: Option<DurableOffer>,
    #[prost(bytes = "vec", tag = "3")]
    digest: Vec<u8>,
    #[prost(uint64, tag = "4")]
    canonical_bytes: u64,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
struct DurableOffer {
    #[prost(string, tag = "1")]
    terminal_epoch: String,
    #[prost(uint64, tag = "2")]
    transfer_id: u64,
    #[prost(uint64, tag = "3")]
    previous_transfer_id: u64,
    #[prost(message, optional, tag = "4")]
    start_boundary: Option<DurableBoundaryMessage>,
    #[prost(message, optional, tag = "5")]
    end_boundary: Option<DurableBoundaryMessage>,
    #[prost(bytes = "vec", tag = "6")]
    native_archive: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
struct DurableBoundaryMessage {
    #[prost(bytes = "vec", tag = "1")]
    token: Vec<u8>,
    #[prost(message, optional, tag = "2")]
    adjacent_anchor: Option<DurableAnchorMessage>,
}

#[derive(Clone, Copy, PartialEq, Message)]
#[prost(skip_debug)]
struct DurableAnchorMessage {
    #[prost(uint64, tag = "1")]
    logical_line_id: u64,
    #[prost(uint32, tag = "2")]
    logical_cell_offset: u32,
}

impl DurableColdHistoryJournal {
    pub(super) fn new(storage: ColdHistoryStorage) -> Self {
        Self {
            storage,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) fn isolated_writer(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) fn reset(&self, root: &JournalRoot) -> Result<(), TerminalReplayError> {
        if let Some(bytes) = self
            .storage
            .read_root(MAX_ROOT_BYTES)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?
        {
            let existing = decode_root(&bytes)
                .map_err(|_| TerminalReplayError::ColdHistoryRecoveryRequired)?;
            if existing.generation > 0 || existing.committed_records > 0 {
                return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
            }
        }
        let bytes = encode_root(root)?;
        self.storage
            .publish_root(&bytes)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        *self
            .cache
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)? =
            Some(DurableJournalCache {
                root: root.clone(),
                activated: true,
            });
        Ok(())
    }

    pub(super) fn has_published_root(&self) -> Result<bool, TerminalReplayError> {
        self.storage
            .read_root(MAX_ROOT_BYTES)
            .map(|root| root.is_some())
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)
    }

    pub(super) fn open_root(
        &self,
        identity: &ColdHistoryIdentity,
        selected_root: Option<&JournalRoot>,
        maximum_records: usize,
    ) -> Result<JournalRoot, TerminalReplayError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if let Some(existing) = cache.as_ref() {
            let selected_matches = selected_root.is_none_or(|root| root == &existing.root);
            if existing.root.identity == *identity && selected_matches {
                return Ok(existing.root.clone());
            }
        }
        let root = match selected_root {
            Some(root) => root.clone(),
            None => {
                let bytes = self
                    .storage
                    .read_root(MAX_ROOT_BYTES)
                    .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?
                    .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?;
                decode_root(&bytes)?
            }
        };
        if root.identity != *identity {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        if root.committed_records > maximum_records {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        *cache = Some(DurableJournalCache {
            root: root.clone(),
            activated: selected_root.is_none(),
        });
        Ok(root)
    }

    pub(super) fn read_record(
        &self,
        transfer_id: u64,
        maximum_offer_bytes: usize,
        maximum_aggregate_bytes: usize,
    ) -> Result<Arc<NativePageRecord>, TerminalReplayError> {
        if transfer_id == 0 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let maximum_payload_bytes = maximum_offer_bytes.min(maximum_aggregate_bytes);
        let maximum_chunk_bytes = maximum_payload_bytes.saturating_add(CHUNK_ENVELOPE_BYTES);
        let bytes = self
            .storage
            .read_chunk(transfer_id, maximum_chunk_bytes)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?;
        Ok(Arc::new(decode_record(&bytes, maximum_payload_bytes)?))
    }

    pub(super) fn activate(&self, root: &JournalRoot) -> Result<(), TerminalReplayError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let current = cache
            .as_mut()
            .filter(|current| current.root == *root)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        if !current.activated {
            let bytes = encode_root(root)?;
            if self.storage.publish_root(&bytes).is_err() {
                *cache = None;
                return Err(TerminalReplayError::ColdHistoryJournalUnavailable);
            }
            current.activated = true;
        }
        Ok(())
    }

    pub(super) fn publish(
        &self,
        record: Arc<NativePageRecord>,
        root: JournalRoot,
        maximum_offer_bytes: usize,
    ) -> Result<JournalRoot, TerminalReplayError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let current = cache
            .as_mut()
            .filter(|current| current.activated)
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?;
        if current.root.committed_records.checked_add(1) != Some(root.committed_records)
            || record.offer().transfer_id != root.transfer_watermark
            || current.root.identity != root.identity
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let chunk = encode_record(&record)?;
        if chunk.len() > maximum_offer_bytes.saturating_add(CHUNK_ENVELOPE_BYTES) {
            return Err(TerminalReplayError::ColdHistoryRetentionRequired);
        }
        self.storage
            .write_chunk(record.offer().transfer_id, &chunk)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let root_bytes = encode_root(&root)?;
        if self.storage.publish_root(&root_bytes).is_err() {
            *cache = None;
            return Err(TerminalReplayError::ColdHistoryJournalUnavailable);
        }
        current.root = root.clone();
        Ok(root)
    }

    pub(super) fn publish_transaction(
        &self,
        base: &JournalRoot,
        records: &[Arc<NativePageRecord>],
        root: &JournalRoot,
        maximum_offer_bytes: usize,
    ) -> Result<(), TerminalReplayError> {
        if records.is_empty() {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let current = cache
            .as_ref()
            .filter(|current| current.root == *base)
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?;
        let published_root = self
            .storage
            .read_root(MAX_ROOT_BYTES)
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)
            .and_then(|bytes| decode_root(&bytes))?;
        if published_root != *base && published_root != *root {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        let mut expected = current.root.clone();
        for record in records {
            expected = expected.advance(record)?;
            let chunk = encode_record(record)?;
            if chunk.len() > maximum_offer_bytes.saturating_add(CHUNK_ENVELOPE_BYTES) {
                return Err(TerminalReplayError::ColdHistoryRetentionRequired);
            }
            match self
                .storage
                .read_chunk(record.offer().transfer_id, chunk.len())
                .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?
            {
                Some(existing) if existing == chunk => {}
                Some(_) => return Err(TerminalReplayError::ColdHistoryRecoveryRequired),
                None => self
                    .storage
                    .write_chunk(record.offer().transfer_id, &chunk)
                    .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?,
            }
        }
        if expected != *root {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        if published_root == *base {
            self.storage
                .publish_root(&encode_root(root)?)
                .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        }
        *cache = Some(DurableJournalCache {
            root: root.clone(),
            activated: true,
        });
        Ok(())
    }
}

fn encode_root(root: &JournalRoot) -> Result<Vec<u8>, TerminalReplayError> {
    let bytes = DurableRoot {
        schema_version: ROOT_SCHEMA_VERSION,
        history_namespace: root.identity.history_namespace.clone(),
        store_id: root.identity.store_id.clone(),
        generation: root.generation,
        end_boundary: root.end_boundary.as_ref().map(DurableBoundaryMessage::from),
        digest: root.digest.to_vec(),
    }
    .encode_to_vec();
    if bytes.len() > MAX_ROOT_BYTES {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(bytes)
}

fn decode_root(bytes: &[u8]) -> Result<JournalRoot, TerminalReplayError> {
    let root = DurableRoot::decode(bytes).map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    if root.schema_version != ROOT_SCHEMA_VERSION {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let digest = root
        .digest
        .try_into()
        .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    let committed_records =
        usize::try_from(root.generation).map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    Ok(JournalRoot {
        identity: ColdHistoryIdentity::new(root.history_namespace, root.store_id),
        generation: root.generation,
        transfer_watermark: root.generation,
        prune_generation: 0,
        committed_records,
        end_boundary: root
            .end_boundary
            .map(HistoryBoundary::try_from)
            .transpose()?,
        digest,
    })
}

fn encode_record(record: &NativePageRecord) -> Result<Vec<u8>, TerminalReplayError> {
    let canonical_bytes = u64::try_from(record.encoded_bytes())
        .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    Ok(DurableChunk {
        schema_version: CHUNK_SCHEMA_VERSION,
        offer: Some(DurableOffer::from(record.offer())),
        digest: record.digest().to_vec(),
        canonical_bytes,
    }
    .encode_to_vec())
}

fn decode_record(
    bytes: &[u8],
    maximum_offer_bytes: usize,
) -> Result<NativePageRecord, TerminalReplayError> {
    if bytes.len() > maximum_offer_bytes.saturating_add(CHUNK_ENVELOPE_BYTES) {
        return Err(TerminalReplayError::ColdHistoryRetentionRequired);
    }
    let chunk =
        DurableChunk::decode(bytes).map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    let digest: [u8; 32] = chunk
        .digest
        .try_into()
        .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    let encoded_bytes = usize::try_from(chunk.canonical_bytes)
        .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    if chunk.schema_version != CHUNK_SCHEMA_VERSION {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    if encoded_bytes > maximum_offer_bytes {
        return Err(TerminalReplayError::ColdHistoryRetentionRequired);
    }
    let offer = chunk
        .offer
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    NativePageRecord::from_durable_envelope(DurablePageEnvelope {
        terminal_epoch: offer.terminal_epoch,
        transfer_id: offer.transfer_id,
        previous_transfer_id: offer.previous_transfer_id,
        start_boundary: offer
            .start_boundary
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?
            .try_into()?,
        end_boundary: offer
            .end_boundary
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?
            .try_into()?,
        native_archive: offer.native_archive,
        digest,
        encoded_bytes,
    })
}

impl From<&HistoryTransferOffer> for DurableOffer {
    fn from(offer: &HistoryTransferOffer) -> Self {
        Self {
            terminal_epoch: offer.terminal_epoch.clone(),
            transfer_id: offer.transfer_id,
            previous_transfer_id: offer.previous_transfer_id,
            start_boundary: Some(DurableBoundaryMessage::from(&offer.start_boundary)),
            end_boundary: Some(DurableBoundaryMessage::from(&offer.end_boundary)),
            native_archive: offer.native_archive_bytes().to_vec(),
        }
    }
}

impl From<&HistoryBoundary> for DurableBoundaryMessage {
    fn from(boundary: &HistoryBoundary) -> Self {
        Self {
            token: boundary.token.to_vec(),
            adjacent_anchor: boundary.adjacent_anchor.map(|anchor| DurableAnchorMessage {
                logical_line_id: anchor.logical_line_id,
                logical_cell_offset: anchor.logical_cell_offset,
            }),
        }
    }
}

impl TryFrom<DurableBoundaryMessage> for HistoryBoundary {
    type Error = TerminalReplayError;

    fn try_from(boundary: DurableBoundaryMessage) -> Result<Self, Self::Error> {
        let token = boundary
            .token
            .try_into()
            .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
        Ok(Self::new(
            token,
            boundary.adjacent_anchor.map(|anchor| LogicalCellAnchor {
                logical_line_id: anchor.logical_line_id,
                logical_cell_offset: anchor.logical_cell_offset,
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary(line: u64) -> DurableBoundaryMessage {
        DurableBoundaryMessage {
            token: [line as u8; 16].to_vec(),
            adjacent_anchor: Some(DurableAnchorMessage {
                logical_line_id: line,
                logical_cell_offset: 0,
            }),
        }
    }

    fn encoded_chunk(native_archive: Vec<u8>) -> Vec<u8> {
        let offer = DurableOffer {
            terminal_epoch: "terminal-source".into(),
            transfer_id: 1,
            previous_transfer_id: 0,
            start_boundary: Some(boundary(1)),
            end_boundary: Some(boundary(2)),
            native_archive: native_archive.clone(),
        };
        let canonical_bytes = HistoryTransferOffer::native_archive(
            "terminal-source",
            1,
            0,
            (
                HistoryBoundary::new(
                    [1; 16],
                    Some(LogicalCellAnchor {
                        logical_line_id: 1,
                        logical_cell_offset: 0,
                    }),
                ),
                HistoryBoundary::new(
                    [2; 16],
                    Some(LogicalCellAnchor {
                        logical_line_id: 2,
                        logical_cell_offset: 0,
                    }),
                ),
            ),
            terminal_core_ghostty_proof::NativeHistoryArchiveChunk {
                bytes: native_archive,
                first_logical_line_id: 1,
                next_logical_line_id: 2,
                physical_rows: 1,
            },
        )
        .canonical_encoded_bytes()
        .unwrap() as u64;
        DurableChunk {
            schema_version: CHUNK_SCHEMA_VERSION,
            offer: Some(offer),
            digest: vec![0; 32],
            canonical_bytes,
        }
        .encode_to_vec()
    }

    #[test]
    fn durable_chunk_enforces_record_and_checksum_bounds_before_native_adoption() {
        let oversized_native = encoded_chunk(vec![0; 257]);
        assert!(
            decode_record(&oversized_native, 256).is_err(),
            "the declared PAGE size must stay within the durable record bound"
        );
        let oversized_record = vec![0; 256 + CHUNK_ENVELOPE_BYTES + 1];
        assert!(matches!(
            decode_record(&oversized_record, 256),
            Err(TerminalReplayError::ColdHistoryRetentionRequired)
        ));
        assert!(
            decode_record(&encoded_chunk(vec![1]), 256).is_err(),
            "a PAGE with an invalid checksum must not reach native adoption"
        );
    }
}
