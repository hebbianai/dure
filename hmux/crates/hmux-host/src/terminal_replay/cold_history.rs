use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::local_discovery::ColdHistoryStorage;
use sha2::{Digest, Sha256};
use terminal_core_ghostty_proof::{
    NativeHistoryAnchor, NativeHistoryArchive, NativeHistoryArchiveBounds,
    NativeHistoryArchiveChunk, NativeHistoryProjection, NativeHistoryProjectionWork,
};

use super::cold_history_journal::DurableColdHistoryJournal;
use super::viewport_source::{
    BoundedViewportRows, TerminalViewportAnchor, ViewportAnchorError, ViewportProjectionGeometry,
    ViewportProjectionWork,
};
use super::{TerminalColdHistoryCheckpoint, TerminalReplayError};

pub(super) const COLD_ROW_ID_MASK: u64 = 1 << 63;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColdHistoryLimits {
    pub maximum_logical_lines: usize,
    pub maximum_bytes: usize,
    pub maximum_offer_bytes: usize,
}

impl Default for ColdHistoryLimits {
    fn default() -> Self {
        Self {
            maximum_logical_lines: 1_000_000,
            maximum_bytes: 512 * 1024 * 1024,
            maximum_offer_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColdHistoryIdentity {
    pub history_namespace: String,
    pub store_id: String,
}

impl ColdHistoryIdentity {
    pub fn new(history_namespace: impl Into<String>, store_id: impl Into<String>) -> Self {
        Self {
            history_namespace: history_namespace.into(),
            store_id: store_id.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LogicalCellAnchor {
    pub logical_line_id: u64,
    pub logical_cell_offset: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryBoundary {
    pub token: [u8; 16],
    pub adjacent_anchor: Option<LogicalCellAnchor>,
}

impl HistoryBoundary {
    pub fn new(token: [u8; 16], adjacent_anchor: Option<LogicalCellAnchor>) -> Self {
        Self {
            token,
            adjacent_anchor,
        }
    }
}

#[derive(Clone, PartialEq)]
struct NativeHistoryPage {
    bytes: Arc<[u8]>,
    bounds: NativeHistoryArchiveBounds,
}

impl NativeHistoryPage {
    fn from_engine(archive: NativeHistoryArchiveChunk) -> Self {
        Self {
            bytes: archive.bytes.into(),
            bounds: NativeHistoryArchiveBounds {
                first_logical_line_id: archive.first_logical_line_id,
                next_logical_line_id: archive.next_logical_line_id,
                physical_rows: archive.physical_rows,
            },
        }
    }

    fn from_disk(bytes: Vec<u8>) -> Result<Self, TerminalReplayError> {
        let bounds = inspect_native_payload(&bytes)?;
        Ok(Self {
            bytes: bytes.into(),
            bounds,
        })
    }

    fn logical_lines(&self) -> Result<usize, TerminalReplayError> {
        logical_line_count(self.bounds)
    }
}

#[derive(Clone, PartialEq)]
/// One immutable logical-history ownership offer retained by the hot source
/// until SessionHost publishes the corresponding cold root and returns an
/// exact ACK.
pub struct HistoryTransferOffer {
    pub terminal_epoch: String,
    pub transfer_id: u64,
    pub previous_transfer_id: u64,
    pub start_boundary: HistoryBoundary,
    pub end_boundary: HistoryBoundary,
    page: NativeHistoryPage,
}

impl HistoryTransferOffer {
    pub fn native_archive(
        terminal_epoch: impl Into<String>,
        transfer_id: u64,
        previous_transfer_id: u64,
        boundaries: (HistoryBoundary, HistoryBoundary),
        archive: NativeHistoryArchiveChunk,
    ) -> Self {
        Self {
            terminal_epoch: terminal_epoch.into(),
            transfer_id,
            previous_transfer_id,
            start_boundary: boundaries.0,
            end_boundary: boundaries.1,
            page: NativeHistoryPage::from_engine(archive),
        }
    }

    pub fn canonical_encoded_bytes(&self) -> Result<usize, TerminalReplayError> {
        offer_digest_and_size(self).map(|(_, bytes)| bytes)
    }

    pub(super) fn native_archive_bytes(&self) -> &[u8] {
        &self.page.bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
/// Durable cold-root receipt authorizing the source to retire one contiguous
/// transfer range. Projection visibility advances only after that retirement.
pub struct HistoryTransferAck {
    pub terminal_epoch: String,
    pub store_id: String,
    pub first_transfer_id: u64,
    pub through_transfer_id: u64,
    pub cold_root_generation: u64,
    pub root_digest: [u8; 32],
    pub committed_transfer_watermark: u64,
    pub prune_generation: u64,
}

#[derive(Clone, PartialEq)]
pub(super) struct NativePageRecord {
    offer: Arc<HistoryTransferOffer>,
    digest: [u8; 32],
    encoded_bytes: usize,
}

pub(super) struct DurablePageEnvelope {
    pub(super) terminal_epoch: String,
    pub(super) transfer_id: u64,
    pub(super) previous_transfer_id: u64,
    pub(super) start_boundary: HistoryBoundary,
    pub(super) end_boundary: HistoryBoundary,
    pub(super) native_archive: Vec<u8>,
    pub(super) digest: [u8; 32],
    pub(super) encoded_bytes: usize,
}

impl NativePageRecord {
    fn from_live_offer(offer: HistoryTransferOffer) -> Result<Self, TerminalReplayError> {
        let (digest, encoded_bytes) = offer_digest_and_size(&offer)?;
        Ok(Self {
            offer: Arc::new(offer),
            digest,
            encoded_bytes,
        })
    }

    pub(super) fn from_durable_envelope(
        envelope: DurablePageEnvelope,
    ) -> Result<Self, TerminalReplayError> {
        let DurablePageEnvelope {
            terminal_epoch,
            transfer_id,
            previous_transfer_id,
            start_boundary,
            end_boundary,
            native_archive,
            digest: expected_digest,
            encoded_bytes: expected_encoded_bytes,
        } = envelope;
        if terminal_epoch.is_empty() || terminal_epoch.len() > 256 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let (digest, encoded_bytes) = offer_digest_and_size_parts(
            &terminal_epoch,
            transfer_id,
            previous_transfer_id,
            &start_boundary,
            &end_boundary,
            &native_archive,
        );
        if digest != expected_digest || encoded_bytes != expected_encoded_bytes {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let page = NativeHistoryPage::from_disk(native_archive)?;
        let start = start_boundary
            .adjacent_anchor
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        let end = end_boundary
            .adjacent_anchor
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        if start
            != (LogicalCellAnchor {
                logical_line_id: page.bounds.first_logical_line_id,
                logical_cell_offset: 0,
            })
            || end
                != (LogicalCellAnchor {
                    logical_line_id: page.bounds.next_logical_line_id,
                    logical_cell_offset: 0,
                })
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        Ok(Self {
            offer: Arc::new(HistoryTransferOffer {
                terminal_epoch,
                transfer_id,
                previous_transfer_id,
                start_boundary,
                end_boundary,
                page,
            }),
            digest,
            encoded_bytes,
        })
    }

    pub(super) fn offer(&self) -> &HistoryTransferOffer {
        &self.offer
    }

    pub(super) fn digest(&self) -> [u8; 32] {
        self.digest
    }

    pub(super) fn encoded_bytes(&self) -> usize {
        self.encoded_bytes
    }
}

pub(super) type SharedJournalRecords = Arc<Vec<Arc<NativePageRecord>>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct JournalRoot {
    pub(super) identity: ColdHistoryIdentity,
    pub(super) generation: u64,
    pub(super) transfer_watermark: u64,
    pub(super) prune_generation: u64,
    pub(super) committed_records: usize,
    pub(super) end_boundary: Option<HistoryBoundary>,
    pub(super) digest: [u8; 32],
}

impl JournalRoot {
    pub(super) fn advance(&self, record: &NativePageRecord) -> Result<Self, TerminalReplayError> {
        let offer = record.offer();
        if offer.previous_transfer_id != self.transfer_watermark
            || offer.transfer_id != self.transfer_watermark.saturating_add(1)
            || (self.end_boundary.is_some()
                && self.end_boundary.as_ref() != Some(&offer.start_boundary))
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        Ok(Self {
            identity: self.identity.clone(),
            generation,
            transfer_watermark: offer.transfer_id,
            prune_generation: self.prune_generation,
            committed_records: self
                .committed_records
                .checked_add(1)
                .ok_or(TerminalReplayError::ColdHistoryInvariant)?,
            end_boundary: Some(offer.end_boundary.clone()),
            digest: next_root_digest(
                self.digest,
                record.digest(),
                generation,
                offer.transfer_id,
                self.prune_generation,
                &offer.end_boundary,
            ),
        })
    }
}

#[derive(Default)]
struct InMemoryJournalState {
    identity: Option<ColdHistoryIdentity>,
    records: SharedJournalRecords,
    root: Option<JournalRoot>,
}

#[derive(Clone, Default)]
/// Cloneable in-process journal model. A process-durable backend must preserve
/// the same append, root-publication, and reopen semantics before cold history
/// can survive a Host restart.
pub struct InMemoryColdHistoryJournal {
    state: Arc<Mutex<InMemoryJournalState>>,
}

#[derive(Clone)]
enum ColdHistoryJournal {
    InMemory(InMemoryColdHistoryJournal),
    Durable(DurableColdHistoryJournal),
}

struct ColdHistoryState {
    identity: ColdHistoryIdentity,
    writer_terminal_epoch: String,
    limits: ColdHistoryLimits,
    root_generation: u64,
    transfer_watermark: u64,
    prune_generation: u64,
    root_digest: [u8; 32],
    applied_records: usize,
    end_boundary: Option<HistoryBoundary>,
    archive: NativeHistoryArchive,
    logical_line_count: usize,
    resident_encoded_bytes: usize,
    poisoned: bool,
}

#[derive(Clone)]
/// Canonical cold history owned by the native Ghostty PAGE archive.
pub struct ColdHistoryStore {
    state: Arc<Mutex<ColdHistoryState>>,
    journal: ColdHistoryJournal,
}

pub(super) struct ColdHistoryAppendTransaction {
    store: ColdHistoryStore,
    base: JournalRoot,
    root: JournalRoot,
    records: Vec<Arc<NativePageRecord>>,
    logical_line_count: usize,
    resident_encoded_bytes: usize,
}

#[derive(Clone)]
pub struct ColdHistoryVisibleState {
    pub logical_line_count: usize,
    pub end_boundary: Option<HistoryBoundary>,
}

#[derive(Clone)]
/// Immutable projection view of one published cold-history generation.
///
/// The native archive is append-only and shared with the owning Host, while
/// `bounds` and `visible` permanently fence every read to the prefix that was
/// published when this source was captured. A later ACK may append to the
/// archive without changing what an already-captured viewport can observe.
pub(super) struct ColdHistoryProjectionSource {
    store: ColdHistoryStore,
    bounds: NativeHistoryArchiveBounds,
    root_generation: u64,
    prune_generation: u64,
    visible: ColdHistoryVisibleState,
}

impl ColdHistoryStore {
    pub fn open(
        identity: ColdHistoryIdentity,
        writer_terminal_epoch: impl Into<String>,
        limits: ColdHistoryLimits,
        journal: InMemoryColdHistoryJournal,
    ) -> Result<Self, TerminalReplayError> {
        Self::open_with_journal(
            identity,
            writer_terminal_epoch.into(),
            limits,
            ColdHistoryJournal::InMemory(journal),
            None,
        )
    }

    pub(super) fn open_durable(
        identity: ColdHistoryIdentity,
        writer_terminal_epoch: impl Into<String>,
        limits: ColdHistoryLimits,
        journal: DurableColdHistoryJournal,
        selected: Option<&TerminalColdHistoryCheckpoint>,
    ) -> Result<Self, TerminalReplayError> {
        let selected_root = selected.map(journal_root_from_checkpoint).transpose()?;
        Self::open_with_journal(
            identity,
            writer_terminal_epoch.into(),
            limits,
            ColdHistoryJournal::Durable(journal),
            selected_root.as_ref(),
        )
    }

    fn open_with_journal(
        identity: ColdHistoryIdentity,
        writer_terminal_epoch: String,
        limits: ColdHistoryLimits,
        journal: ColdHistoryJournal,
        selected_root: Option<&JournalRoot>,
    ) -> Result<Self, TerminalReplayError> {
        validate_identity_and_limits(&identity, &limits)?;
        if writer_terminal_epoch.is_empty() || writer_terminal_epoch.len() > 256 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let initial_root = empty_journal_root(&identity);
        if selected_root.is_none() {
            if let ColdHistoryJournal::Durable(durable) = &journal {
                durable.reset(&initial_root)?;
            }
        }
        let mut state = ColdHistoryState {
            identity: identity.clone(),
            writer_terminal_epoch,
            limits,
            root_generation: 0,
            transfer_watermark: 0,
            prune_generation: 0,
            root_digest: initial_root_digest(&identity),
            applied_records: 0,
            end_boundary: None,
            archive: NativeHistoryArchive::new()
                .map_err(|error| native_archive_error("create cold archive", error.0))?,
            logical_line_count: 0,
            resident_encoded_bytes: 0,
            poisoned: false,
        };
        match &journal {
            ColdHistoryJournal::InMemory(journal) => {
                let (root, records) = open_in_memory_journal(&identity, journal, selected_root)?;
                apply_committed_root(&mut state, &root, &records)?;
            }
            ColdHistoryJournal::Durable(journal) => {
                let root = journal.open_root(
                    &identity,
                    selected_root,
                    state.limits.maximum_logical_lines,
                )?;
                apply_durable_root(&mut state, journal, &root)?;
            }
        }
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            journal,
        })
    }

    /// Begins an isolated append at one exact published prefix.
    ///
    /// Generation sealing validates a successor root without mutating the
    /// selected source view. A failed seal leaves that view unchanged;
    /// append-only durable chunks remain unreachable until an exact retry
    /// publishes their root.
    pub(super) fn begin_append_transaction(
        &self,
        writer_terminal_epoch: impl Into<String>,
        selected: Option<&TerminalColdHistoryCheckpoint>,
    ) -> Result<ColdHistoryAppendTransaction, TerminalReplayError> {
        let state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let identity = state.identity.clone();
        let limits = state.limits.clone();
        drop(state);
        let selected_root = match selected {
            Some(checkpoint) => {
                checkpoint.validate()?;
                let root = journal_root_from_checkpoint(checkpoint)?;
                if root.identity != identity {
                    return Err(TerminalReplayError::ColdHistoryInvariant);
                }
                root
            }
            None => empty_journal_root(&identity),
        };
        let journal = match &self.journal {
            ColdHistoryJournal::InMemory(journal) => ColdHistoryJournal::InMemory(journal.clone()),
            ColdHistoryJournal::Durable(journal) => {
                ColdHistoryJournal::Durable(journal.isolated_writer())
            }
        };
        let store = Self::open_with_journal(
            identity,
            writer_terminal_epoch.into(),
            limits,
            journal,
            Some(&selected_root),
        )?;
        let state = store
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        let base = journal_root_from_state(&state);
        let transaction = ColdHistoryAppendTransaction {
            store: store.clone(),
            root: base.clone(),
            base,
            records: Vec::new(),
            logical_line_count: state.logical_line_count,
            resident_encoded_bytes: state.resident_encoded_bytes,
        };
        drop(state);
        Ok(transaction)
    }

    pub(super) fn checkpoint(
        &self,
    ) -> Result<Option<TerminalColdHistoryCheckpoint>, TerminalReplayError> {
        let state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if state.poisoned {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        if state.transfer_watermark == 0 {
            return Ok(None);
        }
        Ok(Some(checkpoint_from_root(&journal_root_from_state(
            &state,
        ))?))
    }

    pub(super) fn activate_selected_root(&self) -> Result<(), TerminalReplayError> {
        let state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if state.poisoned {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        if let ColdHistoryJournal::Durable(durable) = &self.journal {
            durable.activate(&journal_root_from_state(&state))?;
        }
        Ok(())
    }

    pub fn commit_offer(
        &self,
        offer: &HistoryTransferOffer,
    ) -> Result<HistoryTransferAck, TerminalReplayError> {
        let state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if state.poisoned {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        if offer.transfer_id < state.transfer_watermark {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        if offer.transfer_id == state.transfer_watermark {
            return self.acknowledgement_for_committed(&state, offer);
        }
        validate_writer_authority(&state, offer)?;
        let record = Arc::new(NativePageRecord::from_live_offer(offer.clone())?);
        validate_residency_capacity(
            &state.limits,
            state.logical_line_count,
            state.resident_encoded_bytes,
            &record,
        )?;

        let publication = publish_record(&self.journal, &state, record)?;
        let (root, record) = match &publication {
            JournalPublication::Buffered { root, records } => (
                root,
                records
                    .get(state.applied_records)
                    .ok_or(TerminalReplayError::ColdHistoryInvariant)?,
            ),
            JournalPublication::Durable { root, record } => (root, record),
        };
        acknowledgement_for_published_root(&state, root, record, offer)
    }

    fn acknowledgement_for_committed(
        &self,
        state: &ColdHistoryState,
        offer: &HistoryTransferOffer,
    ) -> Result<HistoryTransferAck, TerminalReplayError> {
        let record = match &self.journal {
            ColdHistoryJournal::InMemory(journal) => {
                let (_, records) = open_in_memory_journal(&state.identity, journal, None)?;
                state
                    .applied_records
                    .checked_sub(1)
                    .and_then(|index| records.get(index).cloned())
                    .ok_or(TerminalReplayError::ColdHistoryInvariant)?
            }
            ColdHistoryJournal::Durable(journal) => journal.read_record(
                state.transfer_watermark,
                state.limits.maximum_offer_bytes,
                state.limits.maximum_bytes,
            )?,
        };
        if record.offer().transfer_id != state.transfer_watermark || record.offer() != offer {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        Ok(HistoryTransferAck {
            terminal_epoch: offer.terminal_epoch.clone(),
            store_id: state.identity.store_id.clone(),
            first_transfer_id: offer.transfer_id,
            through_transfer_id: offer.transfer_id,
            cold_root_generation: state.root_generation,
            root_digest: state.root_digest,
            committed_transfer_watermark: state.transfer_watermark,
            prune_generation: state.prune_generation,
        })
    }

    /// Advances projection-visible cold history only after the hot supplier
    /// has retired the same acknowledged PAGE. The caller holds the terminal
    /// actor lock across hot retirement and this publication, so viewport
    /// readers can observe neither overlapping ownership nor a gap.
    pub(super) fn publish_committed(
        &self,
        acknowledgement: &HistoryTransferAck,
    ) -> Result<(), TerminalReplayError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if state.poisoned {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        let current = journal_root_from_state(&state);
        if acknowledgement.through_transfer_id == current.transfer_watermark {
            return validate_acknowledged_root(&state, &current, acknowledgement);
        }
        if acknowledgement.first_transfer_id != acknowledgement.through_transfer_id
            || acknowledgement.first_transfer_id != current.transfer_watermark.saturating_add(1)
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let result = match &self.journal {
            ColdHistoryJournal::InMemory(journal) => {
                let (root, records) = open_in_memory_journal(&state.identity, journal, None)?;
                validate_acknowledged_root(&state, &root, acknowledgement)?;
                apply_committed_root(&mut state, &root, &records)
            }
            ColdHistoryJournal::Durable(journal) => {
                let root =
                    journal.open_root(&state.identity, None, state.limits.maximum_logical_lines)?;
                validate_acknowledged_root(&state, &root, acknowledgement)?;
                apply_durable_root(&mut state, journal, &root)
            }
        };
        if result.is_err()
            || validate_acknowledged_root(&state, &journal_root_from_state(&state), acknowledgement)
                .is_err()
        {
            state.poisoned = true;
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn committed_transfer_watermark(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.transfer_watermark)
            .unwrap_or(0)
    }

    pub(super) fn capture_projection_source(
        &self,
    ) -> Result<ColdHistoryProjectionSource, TerminalReplayError> {
        let state = self
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        if state.poisoned {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        let bounds = state
            .archive
            .bounds()
            .map_err(|error| native_archive_error("capture cold archive generation", error.0))?;
        validate_visible_archive_bounds(&state, bounds)?;
        Ok(ColdHistoryProjectionSource {
            store: self.clone(),
            bounds,
            root_generation: state.root_generation,
            prune_generation: state.prune_generation,
            visible: ColdHistoryVisibleState {
                logical_line_count: state.logical_line_count,
                end_boundary: state.end_boundary.clone(),
            },
        })
    }
}

impl ColdHistoryAppendTransaction {
    pub(super) fn stage(
        &mut self,
        offer: HistoryTransferOffer,
    ) -> Result<HistoryTransferAck, TerminalReplayError> {
        let state = self
            .store
            .state
            .lock()
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        validate_writer_authority(&state, &offer)?;
        let record = Arc::new(NativePageRecord::from_live_offer(offer.clone())?);
        validate_residency_capacity(
            &state.limits,
            self.logical_line_count,
            self.resident_encoded_bytes,
            &record,
        )?;
        let root = self.root.advance(&record)?;
        let logical_lines = record.offer().page.logical_lines()?;
        self.logical_line_count = self
            .logical_line_count
            .checked_add(logical_lines)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        self.resident_encoded_bytes = self
            .resident_encoded_bytes
            .checked_add(record.encoded_bytes())
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        let acknowledgement = HistoryTransferAck {
            terminal_epoch: offer.terminal_epoch,
            store_id: state.identity.store_id.clone(),
            first_transfer_id: offer.transfer_id,
            through_transfer_id: offer.transfer_id,
            cold_root_generation: root.generation,
            root_digest: root.digest,
            committed_transfer_watermark: root.transfer_watermark,
            prune_generation: root.prune_generation,
        };
        drop(state);
        self.root = root;
        self.records.push(record);
        Ok(acknowledgement)
    }

    pub(super) fn commit(self) -> Result<ColdHistoryStore, TerminalReplayError> {
        if self.records.is_empty() {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let maximum_offer_bytes = {
            let mut state = self
                .store
                .state
                .lock()
                .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
            if journal_root_from_state(&state) != self.base {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            for record in &self.records {
                apply_next_record(&mut state, record)?;
            }
            if journal_root_from_state(&state) != self.root {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            state.limits.maximum_offer_bytes
        };
        match &self.store.journal {
            ColdHistoryJournal::InMemory(journal) => {
                let mut journal_state = journal
                    .state
                    .lock()
                    .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
                let published_root = journal_state
                    .root
                    .clone()
                    .unwrap_or_else(|| empty_journal_root(&self.root.identity));
                if (published_root != self.base && published_root != self.root)
                    || journal_state.identity.as_ref() != Some(&self.root.identity)
                    || journal_state.records.len() < self.base.committed_records
                {
                    return Err(TerminalReplayError::ColdHistoryInvariant);
                }
                for (offset, record) in self.records.iter().enumerate() {
                    let index = self
                        .base
                        .committed_records
                        .checked_add(offset)
                        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
                    if let Some(existing) = journal_state.records.get(index) {
                        if existing.as_ref() != record.as_ref() {
                            return Err(TerminalReplayError::ColdHistoryInvariant);
                        }
                    } else if index == journal_state.records.len() {
                        Arc::make_mut(&mut journal_state.records).push(Arc::clone(record));
                    } else {
                        return Err(TerminalReplayError::ColdHistoryInvariant);
                    }
                }
                journal_state.root = Some(self.root.clone());
            }
            ColdHistoryJournal::Durable(journal) => journal.publish_transaction(
                &self.base,
                &self.records,
                &self.root,
                maximum_offer_bytes,
            )?,
        }
        Ok(self.store)
    }
}

impl ColdHistoryProjectionSource {
    pub(super) fn visible_history_state(&self) -> &ColdHistoryVisibleState {
        &self.visible
    }

    pub(super) fn tail_anchor(&self) -> ColdHistoryAnchor {
        ColdHistoryAnchor {
            source: self.clone(),
            position: ColdAnchorPosition::AfterTail,
            pending_work: Mutex::new(ViewportProjectionWork::default()),
        }
    }

    pub(super) fn resolve_anchor(
        &self,
        anchor: LogicalCellAnchor,
    ) -> Result<ColdHistoryAnchor, ViewportAnchorError> {
        if anchor.logical_line_id < self.bounds.first_logical_line_id
            || anchor.logical_line_id >= self.bounds.next_logical_line_id
        {
            return Err(ViewportAnchorError::Pruned);
        }
        Ok(ColdHistoryAnchor {
            source: self.clone(),
            position: ColdAnchorPosition::At(anchor),
            pending_work: Mutex::new(ViewportProjectionWork::default()),
        })
    }
}

pub(super) struct DurableColdHistoryAdoption {
    checkpoint: TerminalColdHistoryCheckpoint,
    // Retain the exact target archive lease and the shared maintenance lock
    // through immutable handoff publication. Adoption deliberately does not
    // retain a decoded native archive: the successor Host is the only actor
    // that materializes the selected PAGE prefix.
    _journal: DurableColdHistoryJournal,
}

impl DurableColdHistoryAdoption {
    pub(super) fn checkpoint(&self) -> &TerminalColdHistoryCheckpoint {
        &self.checkpoint
    }
}

pub(super) fn adopt_durable_history(
    discovery_root: &Path,
    source: &TerminalColdHistoryCheckpoint,
    target_store_id: &str,
    limits: ColdHistoryLimits,
) -> Result<DurableColdHistoryAdoption, TerminalReplayError> {
    source.validate()?;
    if target_store_id.is_empty()
        || target_store_id.len() > 256
        || target_store_id == source.store_id
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let source_identity = ColdHistoryIdentity::new(&source.history_namespace, &source.store_id);
    let source_storage = ColdHistoryStorage::inspect(
        discovery_root.to_path_buf(),
        &source.history_namespace,
        &source.store_id,
    )
    .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
    let source_journal = DurableColdHistoryJournal::new(source_storage);
    let source_root = journal_root_from_checkpoint(source)?;
    source_journal.open_root(
        &source_identity,
        Some(&source_root),
        limits.maximum_logical_lines,
    )?;

    let target_identity = ColdHistoryIdentity::new(&source.history_namespace, target_store_id);
    let target_storage = ColdHistoryStorage::open_adoption(discovery_root.to_path_buf())
        .and_then(|storage| {
            storage.bind_adoption(
                &target_identity.history_namespace,
                &target_identity.store_id,
            )
        })
        .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
    let target_journal = DurableColdHistoryJournal::new(target_storage);
    let target_root = if target_journal.has_published_root()? {
        target_journal.open_root(&target_identity, None, limits.maximum_logical_lines)?
    } else {
        let root = empty_journal_root(&target_identity);
        target_journal.reset(&root)?;
        root
    };
    if target_root.transfer_watermark > source_root.transfer_watermark {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }

    // Validate and copy exactly one canonical record at a time. Neither the
    // source nor the target PAGE archive is cloned into an aggregate native
    // database in the broker; only the successor Host materializes the final
    // selected root after it owns the target lease.
    let mut source_validation = ColdHistoryResidencyCursor::new(source_identity, limits.clone())?;
    let mut target_validation =
        ColdHistoryResidencyCursor::new(target_identity.clone(), limits.clone())?;
    if target_root.transfer_watermark == 0 {
        target_validation.validate_root(&target_root)?;
    }
    for transfer_id in 1..=source_root.transfer_watermark {
        let remaining = limits
            .maximum_bytes
            .saturating_sub(source_validation.resident_encoded_bytes);
        let source_record =
            source_journal.read_record(transfer_id, limits.maximum_offer_bytes, remaining)?;
        source_validation.apply(&source_record)?;
        if transfer_id <= target_root.transfer_watermark {
            let target_record = target_journal.read_record(
                transfer_id,
                limits.maximum_offer_bytes,
                limits
                    .maximum_bytes
                    .saturating_sub(target_validation.resident_encoded_bytes),
            )?;
            if target_record != source_record {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            target_validation.apply(&target_record)?;
            if transfer_id == target_root.transfer_watermark {
                target_validation.validate_root(&target_root)?;
            }
        } else {
            target_validation.apply(&source_record)?;
            target_journal.publish(
                Arc::clone(&source_record),
                target_validation.root.clone(),
                limits.maximum_offer_bytes,
            )?;
        }
    }
    source_validation.validate_root(&source_root)?;
    target_validation.validate_shape_against(&source_root)?;
    let checkpoint = checkpoint_from_root(&target_validation.root)?;
    Ok(DurableColdHistoryAdoption {
        checkpoint,
        _journal: target_journal,
    })
}

struct ColdHistoryResidencyCursor {
    root: JournalRoot,
    limits: ColdHistoryLimits,
    logical_line_count: usize,
    resident_encoded_bytes: usize,
}

impl ColdHistoryResidencyCursor {
    fn new(
        identity: ColdHistoryIdentity,
        limits: ColdHistoryLimits,
    ) -> Result<Self, TerminalReplayError> {
        validate_identity_and_limits(&identity, &limits)?;
        Ok(Self {
            root: empty_journal_root(&identity),
            limits,
            logical_line_count: 0,
            resident_encoded_bytes: 0,
        })
    }

    fn apply(&mut self, record: &NativePageRecord) -> Result<(), TerminalReplayError> {
        validate_residency_capacity(
            &self.limits,
            self.logical_line_count,
            self.resident_encoded_bytes,
            record,
        )?;
        self.root = self.root.advance(record)?;
        self.logical_line_count = self
            .logical_line_count
            .checked_add(record.offer().page.logical_lines()?)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        self.resident_encoded_bytes = self
            .resident_encoded_bytes
            .checked_add(record.encoded_bytes())
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        Ok(())
    }

    fn validate_root(&self, root: &JournalRoot) -> Result<(), TerminalReplayError> {
        if self.root != *root {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        Ok(())
    }

    fn validate_shape_against(&self, source: &JournalRoot) -> Result<(), TerminalReplayError> {
        if self.root.generation != source.generation
            || self.root.transfer_watermark != source.transfer_watermark
            || self.root.prune_generation != source.prune_generation
            || self.root.committed_records != source.committed_records
            || self.root.end_boundary != source.end_boundary
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        Ok(())
    }
}

fn checkpoint_from_root(
    root: &JournalRoot,
) -> Result<TerminalColdHistoryCheckpoint, TerminalReplayError> {
    let end_boundary = root
        .end_boundary
        .as_ref()
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    let end_anchor = end_boundary
        .adjacent_anchor
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    if end_anchor.logical_cell_offset != 0 {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let checkpoint = TerminalColdHistoryCheckpoint {
        schema_version: super::TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION,
        history_namespace: root.identity.history_namespace.clone(),
        store_id: root.identity.store_id.clone(),
        root_generation: root.generation,
        end_boundary_token: end_boundary.token,
        end_logical_line_id: end_anchor.logical_line_id,
        root_digest: root.digest,
    };
    checkpoint.validate()?;
    Ok(checkpoint)
}

enum JournalPublication {
    Buffered {
        root: JournalRoot,
        records: SharedJournalRecords,
    },
    Durable {
        root: JournalRoot,
        record: Arc<NativePageRecord>,
    },
}

fn publish_record(
    journal: &ColdHistoryJournal,
    state: &ColdHistoryState,
    record: Arc<NativePageRecord>,
) -> Result<JournalPublication, TerminalReplayError> {
    let root = journal_root_from_state(state).advance(&record)?;
    match journal {
        ColdHistoryJournal::InMemory(journal) => {
            let mut journal_state = journal
                .state
                .lock()
                .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
            let record_index = if let Some((index, existing)) = journal_state
                .records
                .iter()
                .enumerate()
                .skip(state.applied_records)
                .find(|(_, existing)| existing.offer().transfer_id == record.offer().transfer_id)
            {
                if existing.as_ref() != record.as_ref() {
                    return Err(TerminalReplayError::ColdHistoryInvariant);
                }
                index
            } else {
                Arc::make_mut(&mut journal_state.records).push(record);
                journal_state.records.len() - 1
            };
            if record_index != state.applied_records {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            journal_state.root = Some(root.clone());
            Ok(JournalPublication::Buffered {
                root,
                records: journal_state.records.clone(),
            })
        }
        ColdHistoryJournal::Durable(journal) => {
            let published =
                journal.publish(Arc::clone(&record), root, state.limits.maximum_offer_bytes)?;
            Ok(JournalPublication::Durable {
                root: published,
                record,
            })
        }
    }
}

fn open_in_memory_journal(
    identity: &ColdHistoryIdentity,
    journal: &InMemoryColdHistoryJournal,
    selected_root: Option<&JournalRoot>,
) -> Result<(JournalRoot, SharedJournalRecords), TerminalReplayError> {
    let mut state = journal
        .state
        .lock()
        .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
    if let Some(existing) = &state.identity {
        if existing != identity {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
    } else {
        state.identity = Some(identity.clone());
    }
    let root = selected_root.cloned().unwrap_or_else(|| {
        state
            .root
            .clone()
            .unwrap_or_else(|| empty_journal_root(identity))
    });
    if &root.identity != identity || root.committed_records > state.records.len() {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok((root, state.records.clone()))
}

fn empty_journal_root(identity: &ColdHistoryIdentity) -> JournalRoot {
    JournalRoot {
        identity: identity.clone(),
        generation: 0,
        transfer_watermark: 0,
        prune_generation: 0,
        committed_records: 0,
        end_boundary: None,
        digest: initial_root_digest(identity),
    }
}

fn journal_root_from_state(state: &ColdHistoryState) -> JournalRoot {
    JournalRoot {
        identity: state.identity.clone(),
        generation: state.root_generation,
        transfer_watermark: state.transfer_watermark,
        prune_generation: state.prune_generation,
        committed_records: state.applied_records,
        end_boundary: state.end_boundary.clone(),
        digest: state.root_digest,
    }
}

fn acknowledgement_for_published_root(
    state: &ColdHistoryState,
    root: &JournalRoot,
    record: &NativePageRecord,
    offer: &HistoryTransferOffer,
) -> Result<HistoryTransferAck, TerminalReplayError> {
    if record.offer() != offer || journal_root_from_state(state).advance(record)? != *root {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let acknowledgement = HistoryTransferAck {
        terminal_epoch: offer.terminal_epoch.clone(),
        store_id: state.identity.store_id.clone(),
        first_transfer_id: offer.transfer_id,
        through_transfer_id: offer.transfer_id,
        cold_root_generation: root.generation,
        root_digest: root.digest,
        committed_transfer_watermark: root.transfer_watermark,
        prune_generation: root.prune_generation,
    };
    validate_acknowledged_root(state, root, &acknowledgement)?;
    Ok(acknowledgement)
}

fn validate_acknowledged_root(
    state: &ColdHistoryState,
    root: &JournalRoot,
    acknowledgement: &HistoryTransferAck,
) -> Result<(), TerminalReplayError> {
    if root.identity != state.identity
        || acknowledgement.terminal_epoch != state.writer_terminal_epoch
        || acknowledgement.store_id != state.identity.store_id
        || acknowledgement.first_transfer_id != acknowledgement.through_transfer_id
        || acknowledgement.through_transfer_id != root.transfer_watermark
        || acknowledgement.committed_transfer_watermark != root.transfer_watermark
        || acknowledgement.cold_root_generation != root.generation
        || acknowledgement.root_digest != root.digest
        || acknowledgement.prune_generation != root.prune_generation
        || usize::try_from(root.transfer_watermark).ok() != Some(root.committed_records)
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn journal_root_from_checkpoint(
    checkpoint: &TerminalColdHistoryCheckpoint,
) -> Result<JournalRoot, TerminalReplayError> {
    checkpoint.validate()?;
    let committed_records = usize::try_from(checkpoint.root_generation)
        .map_err(|_| TerminalReplayError::InvalidRecoveredPresentation)?;
    Ok(JournalRoot {
        identity: ColdHistoryIdentity::new(&checkpoint.history_namespace, &checkpoint.store_id),
        generation: checkpoint.root_generation,
        transfer_watermark: checkpoint.root_generation,
        prune_generation: 0,
        committed_records,
        end_boundary: Some(HistoryBoundary::new(
            checkpoint.end_boundary_token,
            Some(LogicalCellAnchor {
                logical_line_id: checkpoint.end_logical_line_id,
                logical_cell_offset: 0,
            }),
        )),
        digest: checkpoint.root_digest,
    })
}

fn apply_committed_root(
    state: &mut ColdHistoryState,
    root: &JournalRoot,
    records: &[Arc<NativePageRecord>],
) -> Result<(), TerminalReplayError> {
    if root.generation < state.root_generation
        || root.committed_records < state.applied_records
        || root.committed_records > records.len()
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let records = records
        .get(state.applied_records..root.committed_records)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    for record in records {
        apply_next_record(state, record)?;
    }
    if journal_root_from_state(state) != *root {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn apply_durable_root(
    state: &mut ColdHistoryState,
    journal: &DurableColdHistoryJournal,
    root: &JournalRoot,
) -> Result<(), TerminalReplayError> {
    validate_durable_root_shape(state, root)?;
    let first_transfer_id = u64::try_from(state.applied_records)
        .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?
        .checked_add(1)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    for transfer_id in first_transfer_id..=root.transfer_watermark {
        // Durable replay owns only this one decoded offer at a time. Capacity
        // is checked before the native archive adopts it, so malformed roots
        // cannot force an aggregate Vec of every PAGE payload into Rust.
        let record = journal.read_record(
            transfer_id,
            state.limits.maximum_offer_bytes,
            state
                .limits
                .maximum_bytes
                .saturating_sub(state.resident_encoded_bytes),
        )?;
        apply_next_record(state, &record)?;
    }
    if journal_root_from_state(state) != *root {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn validate_durable_root_shape(
    state: &ColdHistoryState,
    root: &JournalRoot,
) -> Result<(), TerminalReplayError> {
    if root.identity != state.identity
        || root.generation < state.root_generation
        || root.transfer_watermark < state.transfer_watermark
        || root.committed_records < state.applied_records
        || root.committed_records > state.limits.maximum_logical_lines
        || u64::try_from(root.committed_records).ok() != Some(root.transfer_watermark)
        || root.generation != root.transfer_watermark
        || root.prune_generation != state.prune_generation
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn apply_next_record(
    state: &mut ColdHistoryState,
    record: &NativePageRecord,
) -> Result<(), TerminalReplayError> {
    validate_residency_capacity(
        &state.limits,
        state.logical_line_count,
        state.resident_encoded_bytes,
        record,
    )?;
    let root = journal_root_from_state(state).advance(record)?;
    apply_page(state, record)?;
    state.applied_records = root.committed_records;
    state.root_generation = root.generation;
    state.transfer_watermark = root.transfer_watermark;
    state.prune_generation = root.prune_generation;
    state.root_digest = root.digest;
    state.end_boundary = root.end_boundary;
    Ok(())
}

fn apply_page(
    state: &mut ColdHistoryState,
    record: &NativePageRecord,
) -> Result<(), TerminalReplayError> {
    let page = &record.offer().page;
    state
        .archive
        .append(&page.bytes)
        .map_err(|error| native_archive_error("append cold archive", error.0))?;
    state.logical_line_count = state
        .logical_line_count
        .checked_add(page.logical_lines()?)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    state.resident_encoded_bytes = state
        .resident_encoded_bytes
        .checked_add(record.encoded_bytes())
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    Ok(())
}

fn validate_identity_and_limits(
    identity: &ColdHistoryIdentity,
    limits: &ColdHistoryLimits,
) -> Result<(), TerminalReplayError> {
    if identity.history_namespace.is_empty()
        || identity.store_id.is_empty()
        || identity.history_namespace.len() > 256
        || identity.store_id.len() > 256
        || limits.maximum_logical_lines == 0
        || limits.maximum_bytes == 0
        || limits.maximum_offer_bytes == 0
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn validate_writer_authority(
    state: &ColdHistoryState,
    offer: &HistoryTransferOffer,
) -> Result<(), TerminalReplayError> {
    if offer.terminal_epoch != state.writer_terminal_epoch
        || offer.terminal_epoch.is_empty()
        || offer.terminal_epoch.len() > 256
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn validate_residency_capacity(
    limits: &ColdHistoryLimits,
    logical_line_count: usize,
    resident_encoded_bytes: usize,
    record: &NativePageRecord,
) -> Result<(), TerminalReplayError> {
    if record.encoded_bytes() > limits.maximum_offer_bytes {
        return Err(TerminalReplayError::ColdHistoryRetentionRequired);
    }
    if resident_encoded_bytes
        .checked_add(record.encoded_bytes())
        .is_none_or(|bytes| bytes > limits.maximum_bytes)
    {
        return Err(TerminalReplayError::ColdHistoryRetentionRequired);
    }
    if logical_line_count
        .checked_add(record.offer().page.logical_lines()?)
        .is_none_or(|lines| lines > limits.maximum_logical_lines)
    {
        return Err(TerminalReplayError::ColdHistoryRetentionRequired);
    }
    Ok(())
}

pub(super) fn initial_root_digest(identity: &ColdHistoryIdentity) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"terminal-cold-root-v1");
    hash_string(&mut hasher, &identity.history_namespace);
    hash_string(&mut hasher, &identity.store_id);
    hasher.finalize().into()
}

pub(super) fn expected_append_acknowledgement(
    identity: &ColdHistoryIdentity,
    previous_root_generation: u64,
    previous_root_digest: [u8; 32],
    previous_transfer_watermark: u64,
    offer: &HistoryTransferOffer,
) -> Result<HistoryTransferAck, TerminalReplayError> {
    if offer.terminal_epoch.is_empty()
        || offer.previous_transfer_id != previous_transfer_watermark
        || offer.transfer_id != previous_transfer_watermark.saturating_add(1)
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let generation = previous_root_generation
        .checked_add(1)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    let (record_digest, _) = offer_digest_and_size(offer)?;
    Ok(HistoryTransferAck {
        terminal_epoch: offer.terminal_epoch.clone(),
        store_id: identity.store_id.clone(),
        first_transfer_id: offer.transfer_id,
        through_transfer_id: offer.transfer_id,
        cold_root_generation: generation,
        root_digest: next_root_digest(
            previous_root_digest,
            record_digest,
            generation,
            offer.transfer_id,
            0,
            &offer.end_boundary,
        ),
        committed_transfer_watermark: offer.transfer_id,
        prune_generation: 0,
    })
}

fn next_root_digest(
    previous: [u8; 32],
    record: [u8; 32],
    generation: u64,
    watermark: u64,
    prune_generation: u64,
    boundary: &HistoryBoundary,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"terminal-cold-root-link-v1");
    hasher.update(previous);
    hasher.update(record);
    hasher.update(generation.to_le_bytes());
    hasher.update(watermark.to_le_bytes());
    hasher.update(prune_generation.to_le_bytes());
    hash_boundary(&mut hasher, boundary);
    hasher.finalize().into()
}

struct CanonicalOfferHasher {
    hasher: Sha256,
    bytes: usize,
}

impl CanonicalOfferHasher {
    fn new() -> Self {
        let mut value = Self {
            hasher: Sha256::new(),
            bytes: 0,
        };
        value.write(b"terminal-cold-page-v3");
        value
    }

    fn write(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
        self.bytes = self.bytes.saturating_add(bytes.len());
    }

    fn string(&mut self, value: &str) {
        self.write(&(value.len() as u64).to_le_bytes());
        self.write(value.as_bytes());
    }

    fn boundary(&mut self, boundary: &HistoryBoundary) {
        self.write(&boundary.token);
        match boundary.adjacent_anchor {
            Some(anchor) => {
                self.write(&[1]);
                self.write(&anchor.logical_line_id.to_le_bytes());
                self.write(&anchor.logical_cell_offset.to_le_bytes());
            }
            None => self.write(&[0]),
        }
    }

    fn finish(self) -> ([u8; 32], usize) {
        (self.hasher.finalize().into(), self.bytes)
    }
}

fn offer_digest_and_size(
    offer: &HistoryTransferOffer,
) -> Result<([u8; 32], usize), TerminalReplayError> {
    Ok(offer_digest_and_size_parts(
        &offer.terminal_epoch,
        offer.transfer_id,
        offer.previous_transfer_id,
        &offer.start_boundary,
        &offer.end_boundary,
        &offer.page.bytes,
    ))
}

fn offer_digest_and_size_parts(
    terminal_epoch: &str,
    transfer_id: u64,
    previous_transfer_id: u64,
    start_boundary: &HistoryBoundary,
    end_boundary: &HistoryBoundary,
    native_archive: &[u8],
) -> ([u8; 32], usize) {
    let mut output = CanonicalOfferHasher::new();
    output.string(terminal_epoch);
    output.write(&transfer_id.to_le_bytes());
    output.write(&previous_transfer_id.to_le_bytes());
    output.boundary(start_boundary);
    output.boundary(end_boundary);
    output.write(&(native_archive.len() as u64).to_le_bytes());
    output.write(native_archive);
    output.finish()
}

fn hash_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn hash_boundary(hasher: &mut Sha256, boundary: &HistoryBoundary) {
    hasher.update(boundary.token);
    if let Some(anchor) = boundary.adjacent_anchor {
        hasher.update([1]);
        hasher.update(anchor.logical_line_id.to_le_bytes());
        hasher.update(anchor.logical_cell_offset.to_le_bytes());
    } else {
        hasher.update([0]);
    }
}

#[derive(Clone, Copy)]
enum ColdAnchorPosition {
    At(LogicalCellAnchor),
    AfterTail,
}

pub struct ColdHistoryAnchor {
    source: ColdHistoryProjectionSource,
    position: ColdAnchorPosition,
    pending_work: Mutex<ViewportProjectionWork>,
}

impl ColdHistoryAnchor {
    pub fn logical_anchor(&self) -> Option<LogicalCellAnchor> {
        match self.position {
            ColdAnchorPosition::At(anchor) => Some(anchor),
            ColdAnchorPosition::AfterTail => None,
        }
    }

    pub fn move_rows(
        &mut self,
        delta: i64,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<i64, ViewportAnchorError> {
        let state = self.source.store.state.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryJournalUnavailable)
        })?;
        if state.poisoned {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryRecoveryRequired,
            ));
        }
        let generation_is_current = validate_projection_generation(&state, &self.source)?;
        validate_projection_geometry(&state, geometry)?;
        let (moved, movement_work) = if generation_is_current {
            let native_anchor = match self.position {
                ColdAnchorPosition::At(anchor) => Some(NativeHistoryAnchor {
                    logical_line_id: anchor.logical_line_id,
                    logical_cell_offset: anchor.logical_cell_offset,
                }),
                ColdAnchorPosition::AfterTail => None,
            };
            let movement = state
                .archive
                .move_rows(
                    native_anchor,
                    geometry.columns,
                    delta,
                    geometry.visit_budget,
                )
                .map_err(|error| {
                    if error.0 == -4 {
                        ViewportAnchorError::Pruned
                    } else {
                        ViewportAnchorError::unavailable(native_archive_error(
                            "move cold archive anchor",
                            error.0,
                        ))
                    }
                })?;
            self.position = movement
                .anchor
                .map_or(ColdAnchorPosition::AfterTail, |anchor| {
                    ColdAnchorPosition::At(logical_anchor(anchor))
                });
            let mut moved = movement.moved_rows;
            let mut movement_work = projection_work(movement.work);
            if movement.requires_projection {
                let remaining = delta.checked_sub(moved).ok_or_else(|| {
                    ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
                })?;
                let (fallback_moved, fallback_work) = move_anchor_by_projection(
                    &state,
                    self.source.bounds,
                    &mut self.position,
                    remaining,
                    geometry,
                )?;
                moved = moved.checked_add(fallback_moved).ok_or_else(|| {
                    ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
                })?;
                add_projection_work(&mut movement_work, fallback_work);
            }
            (moved, movement_work)
        } else {
            move_anchor_by_projection(
                &state,
                self.source.bounds,
                &mut self.position,
                delta,
                geometry,
            )?
        };
        let mut pending_work = self.pending_work.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryJournalUnavailable)
        })?;
        add_projection_work(&mut pending_work, movement_work);
        Ok(moved)
    }

    pub fn project_rows(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<BoundedViewportRows, ViewportAnchorError> {
        let state = self.source.store.state.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryJournalUnavailable)
        })?;
        if state.poisoned {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryRecoveryRequired,
            ));
        }
        validate_projection_generation(&state, &self.source)?;
        validate_projection_geometry(&state, geometry)?;
        let mut projected = project_cold_rows(&state, self.source.bounds, self.position, geometry)?;
        let mut pending = self.pending_work.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryJournalUnavailable)
        })?;
        add_projection_work(&mut projected.work, std::mem::take(&mut *pending));
        Ok(projected)
    }
}

fn move_anchor_by_projection(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
    position: &mut ColdAnchorPosition,
    delta: i64,
    geometry: &ViewportProjectionGeometry,
) -> Result<(i64, ViewportProjectionWork), ViewportAnchorError> {
    let maximum_rows = delta
        .unsigned_abs()
        .min(u64::try_from(geometry.visit_budget).unwrap_or(u64::MAX));
    let mut moved = 0_i64;
    let mut work = ViewportProjectionWork::default();
    for _ in 0..maximum_rows {
        if delta < 0 {
            let Some((previous, additional)) =
                previous_row_anchor(state, bounds, *position, geometry)?
            else {
                break;
            };
            add_projection_work(&mut work, additional);
            *position = ColdAnchorPosition::At(previous);
            moved -= 1;
        } else {
            let Some((next, additional)) = next_row_anchor(state, bounds, *position, geometry)?
            else {
                break;
            };
            add_projection_work(&mut work, additional);
            *position = next;
            moved += 1;
        }
    }
    Ok((moved, work))
}

impl TerminalViewportAnchor for ColdHistoryAnchor {
    fn move_rows(
        &mut self,
        delta: i64,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<i64, ViewportAnchorError> {
        ColdHistoryAnchor::move_rows(self, delta, geometry)
    }

    fn project_rows(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<BoundedViewportRows, ViewportAnchorError> {
        ColdHistoryAnchor::project_rows(self, geometry)
    }
}

fn validate_projection_geometry(
    _state: &ColdHistoryState,
    geometry: &ViewportProjectionGeometry,
) -> Result<(), ViewportAnchorError> {
    if geometry.columns == 0
        || geometry.viewport_rows == 0
        || geometry.visit_budget < usize::from(geometry.viewport_rows)
        || geometry.visit_budget > usize::from(u16::MAX)
    {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(())
}

fn validate_visible_archive_bounds(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
) -> Result<(), TerminalReplayError> {
    if state.logical_line_count == 0 {
        if state.end_boundary.is_some()
            || bounds.first_logical_line_id != 0
            || bounds.next_logical_line_id != 0
            || bounds.physical_rows != 0
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        return Ok(());
    }
    let end = state
        .end_boundary
        .as_ref()
        .and_then(|boundary| boundary.adjacent_anchor)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    let logical_line_count = usize::try_from(
        bounds
            .next_logical_line_id
            .checked_sub(bounds.first_logical_line_id)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?,
    )
    .map_err(|_| TerminalReplayError::ColdHistoryInvariant)?;
    if bounds.first_logical_line_id == 0
        || bounds.physical_rows == 0
        || end.logical_cell_offset != 0
        || end.logical_line_id != bounds.next_logical_line_id
        || logical_line_count != state.logical_line_count
    {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    Ok(())
}

fn validate_projection_generation(
    state: &ColdHistoryState,
    captured: &ColdHistoryProjectionSource,
) -> Result<bool, ViewportAnchorError> {
    if state.root_generation < captured.root_generation
        || state.prune_generation != captured.prune_generation
    {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    let current_end = state.end_boundary.as_ref();
    let captured_end = captured.visible.end_boundary.as_ref();
    if state.root_generation == captured.root_generation {
        if current_end != captured_end {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            ));
        }
        return Ok(true);
    }
    let current_end = current_end
        .and_then(|boundary| boundary.adjacent_anchor)
        .ok_or_else(|| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
    if current_end.logical_cell_offset != 0
        || current_end.logical_line_id <= captured.bounds.next_logical_line_id
    {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(false)
}

fn project_cold_rows(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
    position: ColdAnchorPosition,
    geometry: &ViewportProjectionGeometry,
) -> Result<BoundedViewportRows, ViewportAnchorError> {
    let ColdAnchorPosition::At(anchor) = position else {
        return Err(ViewportAnchorError::Pruned);
    };
    let projection = project_native(
        state,
        bounds,
        anchor,
        geometry.columns,
        usize::from(geometry.viewport_rows),
    )?;
    super::ghostty_state_projection::native_history_viewport_rows(projection)
        .map_err(ViewportAnchorError::unavailable)
}

fn next_row_anchor(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
    position: ColdAnchorPosition,
    geometry: &ViewportProjectionGeometry,
) -> Result<Option<(ColdAnchorPosition, ViewportProjectionWork)>, ViewportAnchorError> {
    let ColdAnchorPosition::At(anchor) = position else {
        return Ok(None);
    };
    let projection = project_native(state, bounds, anchor, geometry.columns, 2)?;
    let work = projection_work(projection.work);
    let first = projection.rows.first().ok_or(ViewportAnchorError::Pruned)?;
    if logical_anchor(first.anchor) != anchor {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    if let Some(next) = projection.rows.get(1) {
        return Ok(Some((
            ColdAnchorPosition::At(logical_anchor(next.anchor)),
            work,
        )));
    }
    if projection.has_more_after {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(Some((ColdAnchorPosition::AfterTail, work)))
}

fn previous_row_anchor(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
    position: ColdAnchorPosition,
    geometry: &ViewportProjectionGeometry,
) -> Result<Option<(LogicalCellAnchor, ViewportProjectionWork)>, ViewportAnchorError> {
    let anchor = match position {
        ColdAnchorPosition::AfterTail => {
            if bounds.next_logical_line_id <= bounds.first_logical_line_id {
                return Ok(None);
            }
            let start = LogicalCellAnchor {
                logical_line_id: bounds.next_logical_line_id - 1,
                logical_cell_offset: 0,
            };
            let projection = project_native(
                state,
                bounds,
                start,
                geometry.columns,
                geometry.visit_budget,
            )?;
            if projection.has_more_after {
                return Err(ViewportAnchorError::unavailable(
                    TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
                ));
            }
            let work = projection_work(projection.work);
            return Ok(projection
                .rows
                .last()
                .map(|row| (logical_anchor(row.anchor), work)));
        }
        ColdAnchorPosition::At(anchor) => anchor,
    };

    let mut attempted_work = ViewportProjectionWork::default();
    if anchor.logical_cell_offset > 0 {
        let columns = u32::from(geometry.columns);
        let candidates = [
            columns,
            columns.saturating_sub(1),
            columns.saturating_add(1),
            2,
        ];
        for distance in candidates {
            if distance == 0 || distance > anchor.logical_cell_offset {
                continue;
            }
            let candidate = LogicalCellAnchor {
                logical_line_id: anchor.logical_line_id,
                logical_cell_offset: anchor.logical_cell_offset - distance,
            };
            let projection = match project_native(state, bounds, candidate, geometry.columns, 3) {
                Ok(projection) => projection,
                Err(ViewportAnchorError::Pruned) => continue,
                Err(error) => return Err(error),
            };
            add_projection_work(&mut attempted_work, projection_work(projection.work));
            if let Some(index) = projection
                .rows
                .iter()
                .position(|row| logical_anchor(row.anchor) == anchor)
            {
                if index > 0 {
                    return Ok(Some((
                        logical_anchor(projection.rows[index - 1].anchor),
                        attempted_work,
                    )));
                }
            }
        }
    }

    if anchor.logical_line_id <= bounds.first_logical_line_id {
        return Ok(None);
    }
    let previous_start = LogicalCellAnchor {
        logical_line_id: anchor.logical_line_id - 1,
        logical_cell_offset: 0,
    };
    let mut maximum_rows = usize::min(2, geometry.visit_budget);
    loop {
        let projection = project_native(
            state,
            bounds,
            previous_start,
            geometry.columns,
            maximum_rows,
        )?;
        add_projection_work(&mut attempted_work, projection_work(projection.work));
        if let Some(index) = projection
            .rows
            .iter()
            .position(|row| logical_anchor(row.anchor) == anchor)
        {
            return Ok(index
                .checked_sub(1)
                .and_then(|previous| projection.rows.get(previous))
                .map(|row| (logical_anchor(row.anchor), attempted_work)));
        }
        if maximum_rows == geometry.visit_budget {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
            ));
        }
        maximum_rows = maximum_rows.saturating_mul(2).min(geometry.visit_budget);
    }
}

fn project_native(
    state: &ColdHistoryState,
    bounds: NativeHistoryArchiveBounds,
    anchor: LogicalCellAnchor,
    columns: u16,
    maximum_rows: usize,
) -> Result<NativeHistoryProjection, ViewportAnchorError> {
    if anchor.logical_line_id < bounds.first_logical_line_id
        || anchor.logical_line_id >= bounds.next_logical_line_id
    {
        return Err(ViewportAnchorError::Pruned);
    }
    let mut projection = state
        .archive
        .project(
            NativeHistoryAnchor {
                logical_line_id: anchor.logical_line_id,
                logical_cell_offset: anchor.logical_cell_offset,
            },
            columns,
            maximum_rows,
        )
        .map_err(|error| {
            if error.0 == -4 {
                ViewportAnchorError::Pruned
            } else {
                ViewportAnchorError::unavailable(native_archive_error(
                    "project cold archive",
                    error.0,
                ))
            }
        })?;
    let current_end = state
        .end_boundary
        .as_ref()
        .and_then(|boundary| boundary.adjacent_anchor)
        .map_or(0, |anchor| anchor.logical_line_id);
    if current_end == bounds.next_logical_line_id {
        return Ok(projection);
    }
    if current_end < bounds.next_logical_line_id {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }

    let first_outside = projection
        .rows
        .iter()
        .position(|row| row.anchor.logical_line_id >= bounds.next_logical_line_id);
    let removed_newer_rows = first_outside.is_some();
    if let Some(first_outside) = first_outside {
        if projection.rows[first_outside..]
            .iter()
            .any(|row| row.anchor.logical_line_id < bounds.next_logical_line_id)
        {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            ));
        }
        projection.rows.truncate(first_outside);
    }
    let last = projection
        .rows
        .last()
        .map(|row| row.anchor)
        .ok_or_else(|| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
    projection.has_more_after = if projection.has_more_after || removed_newer_rows {
        let probe = state.archive.project(last, columns, 2).map_err(|error| {
            if error.0 == -4 {
                ViewportAnchorError::Pruned
            } else {
                ViewportAnchorError::unavailable(native_archive_error(
                    "bound captured cold archive",
                    error.0,
                ))
            }
        })?;
        if probe.rows.first().map(|row| row.anchor) != Some(last) {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            ));
        }
        add_native_projection_work(&mut projection.work, probe.work);
        probe
            .rows
            .get(1)
            .is_some_and(|row| row.anchor.logical_line_id < bounds.next_logical_line_id)
    } else {
        false
    };
    Ok(projection)
}

fn add_native_projection_work(
    target: &mut NativeHistoryProjectionWork,
    additional: NativeHistoryProjectionWork,
) {
    target.index_nodes_visited = target
        .index_nodes_visited
        .saturating_add(additional.index_nodes_visited);
    target.chunks_visited = target
        .chunks_visited
        .saturating_add(additional.chunks_visited);
    target.cells_visited = target
        .cells_visited
        .saturating_add(additional.cells_visited);
}

fn projection_work(work: NativeHistoryProjectionWork) -> ViewportProjectionWork {
    ViewportProjectionWork {
        index_nodes_visited: work.index_nodes_visited,
        chunks_visited: work.chunks_visited,
        cells_visited: work.cells_visited,
    }
}

fn add_projection_work(target: &mut ViewportProjectionWork, work: ViewportProjectionWork) {
    target.index_nodes_visited = target
        .index_nodes_visited
        .saturating_add(work.index_nodes_visited);
    target.chunks_visited = target.chunks_visited.saturating_add(work.chunks_visited);
    target.cells_visited = target.cells_visited.saturating_add(work.cells_visited);
}

fn logical_anchor(anchor: NativeHistoryAnchor) -> LogicalCellAnchor {
    LogicalCellAnchor {
        logical_line_id: anchor.logical_line_id,
        logical_cell_offset: anchor.logical_cell_offset,
    }
}

fn inspect_native_payload(bytes: &[u8]) -> Result<NativeHistoryArchiveBounds, TerminalReplayError> {
    NativeHistoryArchive::inspect_chunk(bytes)
        .map_err(|error| native_archive_error("inspect archive payload", error.0))
}

fn logical_line_count(bounds: NativeHistoryArchiveBounds) -> Result<usize, TerminalReplayError> {
    usize::try_from(
        bounds
            .next_logical_line_id
            .checked_sub(bounds.first_logical_line_id)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?,
    )
    .map_err(|_| TerminalReplayError::ColdHistoryInvariant)
}

fn native_archive_error(operation: &'static str, code: i32) -> TerminalReplayError {
    TerminalReplayError::TerminalEngineFailure { operation, code }
}
pub(super) fn cold_row_id(anchor: LogicalCellAnchor, span: u32, columns: u16) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(b"terminal-cold-row-v1");
    hasher.update(anchor.logical_line_id.to_le_bytes());
    hasher.update(anchor.logical_cell_offset.to_le_bytes());
    hasher.update(span.to_le_bytes());
    hasher.update(columns.to_le_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_le_bytes(bytes) | COLD_ROW_ID_MASK
}
