use super::cold_history::{ColdHistoryStore, HistoryTransferAck, HistoryTransferOffer};
use super::{TerminalColdHistoryCheckpoint, TerminalReplayError};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
#[cfg(test)]
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

/// Move-only supplier side of the hot-to-cold history transaction.
///
/// The supplier retains every offered chunk until an exact acknowledgement is
/// reflected in `retired_history_transfer_watermark`. Implementations
/// must make acknowledgement retry idempotent and never expose a newer offer
/// across an unretired transfer gap. Pending-byte accounting must include at
/// least each retained offer's canonical encoding. ACK application must verify
/// terminal/store/root identity and retire exactly the contiguous receipt
/// range before advancing the reported watermark.
pub trait TerminalHistoryTransferSource {
    fn retired_history_transfer_watermark(&self) -> Result<u64, TerminalReplayError>;

    /// Returns canonical retained bytes across every unretired offer,
    /// including an incomplete logical line that cannot be offered yet.
    fn retained_pending_history_bytes(&self) -> Result<usize, TerminalReplayError>;

    /// Proves whether applying one more output batch can stay within the
    /// supplier's retained-history capacity. This never authorizes blocking
    /// the PTY read itself; the supplier owns the conservative byte-to-history
    /// conversion used to decide whether persistence remains available.
    fn can_accept_history_growth(
        &self,
        maximum_pending_bytes: usize,
        incoming_bytes: usize,
    ) -> Result<bool, TerminalReplayError>;

    fn next_history_transfer_offer(
        &mut self,
    ) -> Result<Option<HistoryTransferOffer>, TerminalReplayError>;

    fn acknowledge_history_transfer(
        &mut self,
        acknowledgement: &HistoryTransferAck,
    ) -> Result<(), TerminalReplayError>;

    /// Releases any uncommitted native offer when cold-history persistence is
    /// no longer available. The hot terminal remains the canonical live
    /// authority and applies its own bounded retention policy afterward.
    fn abandon_history_transfer(&mut self);
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryTransferProgress {
    Idle,
    Committed(HistoryTransferAck),
    Backpressured {
        pending_transfer_id: Option<u64>,
        pending_bytes: usize,
        maximum_pending_bytes: usize,
    },
    Degraded(TerminalReplayError),
}

pub struct TerminalHistoryTransfer {
    store: ColdHistoryStore,
    commit_worker: Option<ColdHistoryCommitWorker>,
    maximum_pending_bytes: usize,
    in_flight_transfer_id: Option<u64>,
    pending_acknowledgement: Option<HistoryTransferAck>,
    backpressured: Option<(Option<u64>, usize)>,
}

impl TerminalHistoryTransfer {
    pub fn new(
        store: ColdHistoryStore,
        maximum_pending_bytes: usize,
    ) -> Result<Self, TerminalReplayError> {
        let commit_worker = ColdHistoryCommitWorker::new(store.clone())?;
        Ok(Self {
            store,
            commit_worker: Some(commit_worker),
            maximum_pending_bytes,
            in_flight_transfer_id: None,
            pending_acknowledgement: None,
            backpressured: None,
        })
    }

    #[cfg(test)]
    fn new_with_commit_gate(
        store: ColdHistoryStore,
        maximum_pending_bytes: usize,
        commit_gate: CommitGate,
    ) -> Result<Self, TerminalReplayError> {
        let commit_worker =
            ColdHistoryCommitWorker::new_with_commit_gate(store.clone(), commit_gate)?;
        Ok(Self {
            store,
            commit_worker: Some(commit_worker),
            maximum_pending_bytes,
            in_flight_transfer_id: None,
            pending_acknowledgement: None,
            backpressured: None,
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.commit_worker.is_some()
    }

    pub fn abandon(&mut self, source: &mut dyn TerminalHistoryTransferSource) {
        source.abandon_history_transfer();
        if let Some(worker) = self.commit_worker.take() {
            worker.abandon();
        }
        self.in_flight_transfer_id = None;
        self.pending_acknowledgement = None;
        self.backpressured = None;
    }

    pub fn store(&self) -> &ColdHistoryStore {
        &self.store
    }

    pub(super) fn with_store(&self, store: ColdHistoryStore) -> Result<Self, TerminalReplayError> {
        Self::new(store, self.maximum_pending_bytes)
    }

    pub fn checkpoint_receipt(
        &self,
    ) -> Result<Option<TerminalColdHistoryCheckpoint>, TerminalReplayError> {
        if !self.is_enabled() {
            return Ok(None);
        }
        if self.in_flight_transfer_id.is_some() || self.pending_acknowledgement.is_some() {
            return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
        }
        self.store.checkpoint()
    }

    pub fn activate_selected_root(&self) -> Result<(), TerminalReplayError> {
        if self.is_enabled() {
            self.store.activate_selected_root()
        } else {
            Ok(())
        }
    }

    fn ensure_available(&self) -> Result<(), TerminalReplayError> {
        if let Some((_, pending_bytes)) = self.backpressured {
            Err(TerminalReplayError::HistoryStorageBackpressure {
                pending_bytes,
                maximum_pending_bytes: self.maximum_pending_bytes,
            })
        } else {
            Ok(())
        }
    }

    pub fn ensure_history_capacity(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
        incoming_bytes: usize,
    ) -> Result<(), TerminalReplayError> {
        if !self.is_enabled() {
            return Ok(());
        }
        if self.in_flight_transfer_id.is_some()
            || self.pending_acknowledgement.is_some()
            || self.backpressured.is_some()
        {
            self.drive(source)?;
        }
        // Native prefix offers retain immutable logical-boundary references,
        // so later output and canonical reflow may proceed while storage
        // commits them. Admission here is capacity authority, not transaction
        // serialization.
        self.ensure_available()?;
        let can_accept =
            source.can_accept_history_growth(self.maximum_pending_bytes, incoming_bytes)?;
        if can_accept {
            return Ok(());
        }
        let pending_bytes = source.retained_pending_history_bytes()?;
        self.backpressured = Some((None, pending_bytes));
        Err(TerminalReplayError::HistoryStorageBackpressure {
            pending_bytes,
            maximum_pending_bytes: self.maximum_pending_bytes,
        })
    }

    pub fn drive(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
    ) -> Result<HistoryTransferProgress, TerminalReplayError> {
        if !self.is_enabled() {
            return Ok(HistoryTransferProgress::Idle);
        }
        self.drive_once(source)
    }

    /// Reconciles history ownership after terminal bytes have already mutated
    /// the hot VT. A late supplier error is returned as degradation rather than
    /// a failed PTY batch, because retrying that batch would apply bytes twice.
    pub fn drive_after_mutation(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
    ) -> HistoryTransferProgress {
        match self.drive(source) {
            Ok(progress) => progress,
            Err(error) => HistoryTransferProgress::Degraded(error),
        }
    }

    fn drive_once(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
    ) -> Result<HistoryTransferProgress, TerminalReplayError> {
        if let Some(acknowledgement) = self.pending_acknowledgement.clone() {
            return self.retire_committed(source, acknowledgement);
        }
        if let Some(progress) = self.poll_commit_completion(source)? {
            return Ok(progress);
        }
        let pending_bytes = source.retained_pending_history_bytes()?;
        if let Some(transfer_id) = self.in_flight_transfer_id {
            if pending_bytes > self.maximum_pending_bytes {
                return Ok(self.mark_backpressured(Some(transfer_id), pending_bytes));
            }
            self.backpressured = None;
            return Ok(HistoryTransferProgress::Idle);
        }
        let offer = source.next_history_transfer_offer()?;
        let Some(offer) = offer else {
            if pending_bytes > self.maximum_pending_bytes {
                return Ok(self.mark_backpressured(None, pending_bytes));
            }
            self.backpressured = None;
            return Ok(HistoryTransferProgress::Idle);
        };
        let canonical_bytes = offer.canonical_encoded_bytes()?;
        if pending_bytes < canonical_bytes || pending_bytes == 0 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let transfer_id = offer.transfer_id;
        self.commit_worker
            .as_ref()
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?
            .try_schedule(offer)?;
        self.in_flight_transfer_id = Some(transfer_id);
        if pending_bytes > self.maximum_pending_bytes {
            Ok(self.mark_backpressured(Some(transfer_id), pending_bytes))
        } else {
            self.backpressured = None;
            Ok(HistoryTransferProgress::Idle)
        }
    }

    fn poll_commit_completion(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
    ) -> Result<Option<HistoryTransferProgress>, TerminalReplayError> {
        let completion = match self
            .commit_worker
            .as_ref()
            .ok_or(TerminalReplayError::ColdHistoryRecoveryRequired)?
            .try_complete()
        {
            Ok(completion) => completion,
            Err(TryRecvError::Empty) => return Ok(None),
            Err(TryRecvError::Disconnected) => {
                return Err(TerminalReplayError::ColdHistoryRecoveryRequired);
            }
        };
        self.apply_commit_completion(source, completion).map(Some)
    }

    fn apply_commit_completion(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
        completion: ColdHistoryCommitCompletion,
    ) -> Result<HistoryTransferProgress, TerminalReplayError> {
        if self.in_flight_transfer_id != Some(completion.transfer_id) {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        self.in_flight_transfer_id = None;
        let acknowledgement = completion.result?;
        if acknowledgement.through_transfer_id != completion.transfer_id
            || acknowledgement.committed_transfer_watermark != completion.transfer_id
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        self.pending_acknowledgement = Some(acknowledgement.clone());
        self.retire_committed(source, acknowledgement)
    }

    pub fn reconcile_pending(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
    ) -> Result<bool, TerminalReplayError> {
        loop {
            if let Some(acknowledgement) = self.pending_acknowledgement.clone() {
                self.retire_committed(source, acknowledgement)?;
                continue;
            }
            if self.in_flight_transfer_id.is_some() {
                if self.poll_commit_completion(source)?.is_none() {
                    return Ok(false);
                }
                continue;
            }
            self.drive(source)?;
            if self.in_flight_transfer_id.is_some()
                || self.pending_acknowledgement.is_some()
                || matches!(self.backpressured, Some((Some(_), _)))
            {
                return Ok(false);
            }
            return Ok(true);
        }
    }

    fn retire_committed(
        &mut self,
        source: &mut dyn TerminalHistoryTransferSource,
        acknowledgement: HistoryTransferAck,
    ) -> Result<HistoryTransferProgress, TerminalReplayError> {
        let retired_transfer_watermark = source.retired_history_transfer_watermark()?;
        if retired_transfer_watermark != acknowledgement.through_transfer_id {
            if retired_transfer_watermark.checked_add(1) != Some(acknowledgement.first_transfer_id)
            {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            source.acknowledge_history_transfer(&acknowledgement)?;
            if source.retired_history_transfer_watermark()? != acknowledgement.through_transfer_id {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
        }
        self.store.publish_committed(&acknowledgement)?;
        self.finish_retirement(source, acknowledgement)
    }

    fn finish_retirement(
        &mut self,
        source: &dyn TerminalHistoryTransferSource,
        acknowledgement: HistoryTransferAck,
    ) -> Result<HistoryTransferProgress, TerminalReplayError> {
        let remaining_pending_bytes = source.retained_pending_history_bytes()?;
        self.pending_acknowledgement = None;
        self.backpressured = None;
        if remaining_pending_bytes > self.maximum_pending_bytes {
            Ok(self.mark_backpressured(None, remaining_pending_bytes))
        } else {
            Ok(HistoryTransferProgress::Committed(acknowledgement))
        }
    }

    fn mark_backpressured(
        &mut self,
        pending_transfer_id: Option<u64>,
        pending_bytes: usize,
    ) -> HistoryTransferProgress {
        self.backpressured = Some((pending_transfer_id, pending_bytes));
        HistoryTransferProgress::Backpressured {
            pending_transfer_id,
            pending_bytes,
            maximum_pending_bytes: self.maximum_pending_bytes,
        }
    }
}

struct ColdHistoryCommitCompletion {
    transfer_id: u64,
    result: Result<HistoryTransferAck, TerminalReplayError>,
}

struct ColdHistoryCommitWorker {
    requests: Option<SyncSender<HistoryTransferOffer>>,
    completions: Receiver<ColdHistoryCommitCompletion>,
    thread: Option<JoinHandle<()>>,
}

impl ColdHistoryCommitWorker {
    fn new(store: ColdHistoryStore) -> Result<Self, TerminalReplayError> {
        Self::spawn(store, None)
    }

    #[cfg(test)]
    fn new_with_commit_gate(
        store: ColdHistoryStore,
        commit_gate: CommitGate,
    ) -> Result<Self, TerminalReplayError> {
        Self::spawn(store, Some(commit_gate))
    }

    fn spawn(
        store: ColdHistoryStore,
        #[cfg(test)] commit_gate: Option<CommitGate>,
        #[cfg(not(test))] _commit_gate: Option<()>,
    ) -> Result<Self, TerminalReplayError> {
        let (request_tx, request_rx) = mpsc::sync_channel::<HistoryTransferOffer>(1);
        let (completion_tx, completion_rx) = mpsc::sync_channel::<ColdHistoryCommitCompletion>(1);
        let worker = thread::Builder::new()
            .name("hmux-cold-history".to_owned())
            .spawn(move || {
                while let Ok(offer) = request_rx.recv() {
                    let transfer_id = offer.transfer_id;
                    #[cfg(test)]
                    if let Some(commit_gate) = &commit_gate {
                        commit_gate.wait();
                    }
                    let result = store.commit_offer(&offer);
                    if completion_tx
                        .send(ColdHistoryCommitCompletion {
                            transfer_id,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|_| TerminalReplayError::ColdHistoryJournalUnavailable)?;
        Ok(Self {
            requests: Some(request_tx),
            completions: completion_rx,
            thread: Some(worker),
        })
    }

    fn try_schedule(&self, offer: HistoryTransferOffer) -> Result<(), TerminalReplayError> {
        match &self.requests {
            Some(requests) => requests.try_send(offer).map_err(|error| match error {
                TrySendError::Full(_) => TerminalReplayError::ColdHistoryInvariant,
                TrySendError::Disconnected(_) => TerminalReplayError::ColdHistoryRecoveryRequired,
            }),
            None => Err(TerminalReplayError::ColdHistoryRecoveryRequired),
        }
    }

    fn try_complete(&self) -> Result<ColdHistoryCommitCompletion, TryRecvError> {
        self.completions.try_recv()
    }

    fn abandon(mut self) {
        self.requests.take();
        // A storage syscall must not regain authority over the provider by
        // blocking the terminal actor during degradation. Dropping a join
        // handle detaches this already-isolated worker; closing `requests`
        // makes it exit after the current bounded commit attempt returns.
        self.thread.take();
    }
}

impl Drop for ColdHistoryCommitWorker {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(worker) = self.thread.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
struct CommitGate {
    state: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
impl CommitGate {
    fn closed() -> Self {
        Self {
            state: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    fn wait(&self) {
        let (lock, changed) = self.state.as_ref();
        let mut open = lock.lock().expect("commit gate lock");
        while !*open {
            open = changed.wait(open).expect("commit gate wait");
        }
    }

    fn open(&self) {
        let (lock, changed) = self.state.as_ref();
        *lock.lock().expect("commit gate lock") = true;
        changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_replay::cold_history::{
        ColdHistoryIdentity, ColdHistoryLimits, HistoryBoundary, InMemoryColdHistoryJournal,
        LogicalCellAnchor,
    };
    use crate::terminal_replay::composite_viewport_source::CompositeViewportSource;
    use crate::terminal_replay::ghostty_core_proof::GhosttyProofAdapter;
    use crate::terminal_replay::terminal_core::TerminalCore;
    use crate::terminal_replay::viewport_source::ViewportProjectionGeometry;
    use std::sync::mpsc;
    use std::time::Duration;
    use terminal_core_ghostty_proof::NativeHistoryArchiveChunk;

    struct RetainedOffer {
        offer: HistoryTransferOffer,
    }

    impl TerminalHistoryTransferSource for RetainedOffer {
        fn retired_history_transfer_watermark(&self) -> Result<u64, TerminalReplayError> {
            Ok(0)
        }

        fn retained_pending_history_bytes(&self) -> Result<usize, TerminalReplayError> {
            Ok(1_024)
        }

        fn can_accept_history_growth(
            &self,
            _maximum_pending_bytes: usize,
            _incoming_bytes: usize,
        ) -> Result<bool, TerminalReplayError> {
            Ok(true)
        }

        fn next_history_transfer_offer(
            &mut self,
        ) -> Result<Option<HistoryTransferOffer>, TerminalReplayError> {
            Ok(Some(self.offer.clone()))
        }

        fn acknowledge_history_transfer(
            &mut self,
            _acknowledgement: &HistoryTransferAck,
        ) -> Result<(), TerminalReplayError> {
            Err(TerminalReplayError::ColdHistoryInvariant)
        }

        fn abandon_history_transfer(&mut self) {}
    }

    fn retained_offer(terminal_epoch: &str) -> RetainedOffer {
        let boundary = |logical_line_id| {
            HistoryBoundary::new(
                [u8::try_from(logical_line_id).unwrap_or(0); 16],
                Some(LogicalCellAnchor {
                    logical_line_id,
                    logical_cell_offset: 0,
                }),
            )
        };
        RetainedOffer {
            offer: HistoryTransferOffer::native_archive(
                terminal_epoch,
                1,
                0,
                (boundary(0), boundary(1)),
                NativeHistoryArchiveChunk {
                    bytes: vec![1],
                    first_logical_line_id: 0,
                    next_logical_line_id: 1,
                    physical_rows: 1,
                },
            ),
        }
    }

    fn cold_store(terminal_epoch: &str) -> ColdHistoryStore {
        ColdHistoryStore::open(
            ColdHistoryIdentity::new(terminal_epoch, "cold-v1"),
            terminal_epoch,
            ColdHistoryLimits::default(),
            InMemoryColdHistoryJournal::default(),
        )
        .unwrap()
    }

    #[test]
    fn dropped_generation_append_keeps_the_selected_cold_root_and_retry_commits_once() {
        let terminal_epoch = "generation-append-transaction";
        let store = cold_store(terminal_epoch);
        let source = || {
            let mut source = GhosttyProofAdapter::new(2, 80, 1, 20_000, terminal_epoch).unwrap();
            source
                .process(b"line-1\r\nline-2\r\nline-3\r\nline-4\r\n")
                .unwrap();
            source
        };

        let mut abandoned_source = source();
        let mut abandoned = store
            .begin_append_transaction(terminal_epoch, None)
            .unwrap();
        let offer = abandoned_source
            .next_history_transfer_offer()
            .unwrap()
            .unwrap();
        let acknowledgement = abandoned.stage(offer).unwrap();
        abandoned_source
            .acknowledge_history_transfer(&acknowledgement)
            .unwrap();
        drop(abandoned);

        assert!(store.checkpoint().unwrap().is_none());
        assert_eq!(
            store
                .capture_projection_source()
                .unwrap()
                .visible_history_state()
                .logical_line_count,
            0
        );

        let mut retry_source = source();
        let mut retry = store
            .begin_append_transaction(terminal_epoch, None)
            .unwrap();
        while let Some(offer) = retry_source.next_history_transfer_offer().unwrap() {
            let acknowledgement = retry.stage(offer).unwrap();
            retry_source
                .acknowledge_history_transfer(&acknowledgement)
                .unwrap();
        }
        let committed = retry.commit().unwrap();
        let committed_checkpoint = committed.checkpoint().unwrap().unwrap();

        assert_eq!(committed_checkpoint.root_generation, 1);
        assert!(
            committed
                .capture_projection_source()
                .unwrap()
                .visible_history_state()
                .logical_line_count
                > 0
        );

        let mut replayed_source = source();
        let mut replayed = store
            .begin_append_transaction(terminal_epoch, None)
            .unwrap();
        while let Some(offer) = replayed_source.next_history_transfer_offer().unwrap() {
            let acknowledgement = replayed.stage(offer).unwrap();
            replayed_source
                .acknowledge_history_transfer(&acknowledgement)
                .unwrap();
        }
        assert_eq!(
            replayed.commit().unwrap().checkpoint().unwrap().unwrap(),
            committed_checkpoint,
            "an uncertain exact retry must select the same published root"
        );
    }

    #[test]
    fn scheduling_a_cold_commit_never_waits_for_storage() {
        let source = retained_offer("nonblocking-terminal");
        let store = cold_store("nonblocking-terminal");
        let gate = CommitGate::closed();
        let transfer =
            TerminalHistoryTransfer::new_with_commit_gate(store, 8 * 1024 * 1024, gate.clone())
                .unwrap();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut transfer = transfer;
            let mut source = source;
            let result = transfer.drive(&mut source);
            result_tx.send(result).unwrap();
        });

        let observed = result_rx.recv_timeout(Duration::from_secs(2));
        gate.open();
        worker.join().unwrap();

        assert_eq!(observed, Ok(Ok(HistoryTransferProgress::Idle)));
    }

    #[test]
    fn in_flight_cold_commit_reports_only_real_capacity_exhaustion() {
        let mut source = retained_offer("mutation-fenced-terminal");
        let store = cold_store("mutation-fenced-terminal");
        let gate = CommitGate::closed();
        let mut transfer =
            TerminalHistoryTransfer::new_with_commit_gate(store, 8 * 1024 * 1024, gate.clone())
                .unwrap();
        assert_eq!(
            transfer.drive(&mut source),
            Ok(HistoryTransferProgress::Idle)
        );

        let capacity = transfer.ensure_history_capacity(&mut source, 64 * 1024);
        gate.open();

        assert_eq!(capacity, Ok(()));
    }

    #[test]
    fn native_prefix_ack_remains_exact_after_admitted_later_output() {
        let terminal_epoch = "append-during-native-prefix-commit";
        let mut source = GhosttyProofAdapter::new(2, 80, 2, 20_000, terminal_epoch).unwrap();
        source
            .process(b"line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\n")
            .unwrap();
        let store = cold_store(terminal_epoch);
        let gate = CommitGate::closed();
        let mut transfer =
            TerminalHistoryTransfer::new_with_commit_gate(store, 8 * 1024 * 1024, gate.clone())
                .unwrap();
        assert_eq!(
            transfer.drive(&mut source),
            Ok(HistoryTransferProgress::Idle)
        );
        assert_eq!(
            transfer.ensure_history_capacity(&mut source, 64 * 1024),
            Ok(())
        );
        source.process(b"later-output\r\n").unwrap();
        gate.open();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match transfer.drive(&mut source).unwrap() {
                HistoryTransferProgress::Committed(_) => break,
                HistoryTransferProgress::Idle => {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::yield_now();
                }
                progress => panic!("unexpected transfer progress: {progress:?}"),
            }
        }
        assert!(source.screen_contents().contains("later-output"));
        assert!(
            transfer
                .store()
                .capture_projection_source()
                .unwrap()
                .visible_history_state()
                .logical_line_count
                > 0
        );
    }

    #[test]
    fn in_flight_native_prefix_commit_retires_after_canonical_reflow() {
        let terminal_epoch = "reflow-during-native-prefix-commit";
        let mut source = GhosttyProofAdapter::new(2, 80, 2, 20_000, terminal_epoch).unwrap();
        source
            .process(b"line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\n")
            .unwrap();
        let store = cold_store(terminal_epoch);
        let gate = CommitGate::closed();
        let mut transfer =
            TerminalHistoryTransfer::new_with_commit_gate(store, 8 * 1024 * 1024, gate.clone())
                .unwrap();
        assert_eq!(
            transfer.drive(&mut source),
            Ok(HistoryTransferProgress::Idle)
        );

        source.resize(2, 60).unwrap();
        gate.open();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match transfer.drive(&mut source).unwrap() {
                HistoryTransferProgress::Committed(_) => break,
                HistoryTransferProgress::Idle => {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::yield_now();
                }
                progress => panic!("unexpected transfer progress: {progress:?}"),
            }
        }
        source.process(b"OUTPUT_AFTER_REFLOW_ACK\r\n").unwrap();
        assert!(source.screen_contents().contains("OUTPUT_AFTER_REFLOW_ACK"));
    }

    #[test]
    fn captured_viewport_keeps_the_cold_generation_from_before_ack_publication() {
        let terminal_epoch = "captured-cold-generation";
        let mut source = GhosttyProofAdapter::new(2, 80, 2, 20_000, terminal_epoch).unwrap();
        source
            .process(b"line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\n")
            .unwrap();
        let store = cold_store(terminal_epoch);
        let first_offer = source
            .next_history_transfer_offer()
            .unwrap()
            .expect("the first bounded prefix must be offered");
        let first_acknowledgement = store.commit_offer(&first_offer).unwrap();
        source
            .acknowledge_history_transfer(&first_acknowledgement)
            .unwrap();
        store.publish_committed(&first_acknowledgement).unwrap();
        source
            .process(b"line-6\r\nline-7\r\nline-8\r\nline-9\r\nline-10\r\n")
            .unwrap();

        let gate = CommitGate::closed();
        let mut transfer = TerminalHistoryTransfer::new_with_commit_gate(
            store.clone(),
            8 * 1024 * 1024,
            gate.clone(),
        )
        .unwrap();
        assert_eq!(
            transfer.drive(&mut source),
            Ok(HistoryTransferProgress::Idle)
        );

        let captured_hot = source
            .capture_hot_viewport_source(
                &[crate::terminal_replay::ViewportCaptureRequest::tail_for_test(2)],
                usize::MAX,
            )
            .unwrap();
        let captured_start = captured_hot
            .hot_start_boundary()
            .unwrap()
            .adjacent_anchor
            .expect("the retained hot generation has a stable start");
        let captured_cold = store.capture_projection_source().unwrap();
        assert!(captured_cold.visible_history_state().logical_line_count > 0);
        let mut current_cold_tail = captured_cold.tail_anchor();
        let mut captured_cold_tail = captured_cold.tail_anchor();
        let captured = CompositeViewportSource::new(Some(captured_cold), captured_hot);
        let geometry = ViewportProjectionGeometry {
            visit_budget: 64,
            ..ViewportProjectionGeometry::new(
                80,
                2,
                0,
                terminal_state_protocol::UnicodeWidthProfile {
                    unicode_version: "ghostty-pin-47147324".to_string(),
                    ambiguous_width: 1,
                    emoji_width: 2,
                },
            )
        };
        assert_eq!(
            current_cold_tail
                .move_rows(-1, &geometry)
                .unwrap_or_else(|_| panic!("the current cold tail must move natively")),
            -1
        );
        let current_cold = current_cold_tail
            .project_rows(&geometry)
            .unwrap_or_else(|_| panic!("the current cold tail must project"));
        assert!(!current_cold.has_more_after);
        assert!(
            current_cold
                .rows
                .iter()
                .all(|row| row.logical_line_id < captured_start.logical_line_id)
        );
        let anchor = captured
            .resolve_logical_anchor(captured_start, &geometry)
            .unwrap_or_else(|_| panic!("the captured hot start must resolve"));

        gate.open();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match transfer.drive(&mut source).unwrap() {
                HistoryTransferProgress::Committed(_) => break,
                HistoryTransferProgress::Idle => {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::yield_now();
                }
                progress => panic!("unexpected transfer progress: {progress:?}"),
            }
        }

        let projected = anchor.project_rows(&geometry).unwrap_or_else(|_| {
            panic!("a captured source must remain one immutable terminal generation")
        });
        assert_eq!(
            projected.rows.first().map(|row| LogicalCellAnchor {
                logical_line_id: row.logical_line_id,
                logical_cell_offset: row.logical_cell_offset,
            }),
            Some(captured_start)
        );
        assert!(projected.has_more_before);

        assert_eq!(
            captured_cold_tail
                .move_rows(-1, &geometry)
                .unwrap_or_else(|_| panic!("the captured cold tail must move")),
            -1
        );
        let cold_tail = captured_cold_tail
            .project_rows(&geometry)
            .unwrap_or_else(|_| panic!("the captured cold tail must project"));
        assert!(!cold_tail.has_more_after);
        assert!(
            cold_tail
                .rows
                .iter()
                .all(|row| row.logical_line_id < captured_start.logical_line_id),
            "the later acknowledged PAGE must stay outside the captured cold generation"
        );
        assert_eq!(
            captured_cold_tail
                .move_rows(1, &geometry)
                .unwrap_or_else(|_| panic!("the captured cold tail must stop at its own end")),
            1
        );
        assert_eq!(captured_cold_tail.logical_anchor(), None);
    }

    #[test]
    fn committed_cold_page_is_invisible_until_the_hot_source_retires_it() {
        let terminal_epoch = "atomic-history-visibility";
        let mut source = GhosttyProofAdapter::new(2, 80, 2, 20_000, terminal_epoch).unwrap();
        source
            .process(b"line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\n")
            .unwrap();
        let offer = source
            .next_history_transfer_offer()
            .unwrap()
            .expect("bounded hot history must offer one complete prefix");
        let store = ColdHistoryStore::open(
            ColdHistoryIdentity::new(terminal_epoch, "cold-v1"),
            terminal_epoch,
            ColdHistoryLimits::default(),
            InMemoryColdHistoryJournal::default(),
        )
        .unwrap();

        let acknowledgement = store.commit_offer(&offer).unwrap();

        let before_retirement = store.capture_projection_source().unwrap();
        let before_retirement = before_retirement.visible_history_state();
        assert_eq!(before_retirement.logical_line_count, 0);
        assert_eq!(before_retirement.end_boundary, None);

        source
            .acknowledge_history_transfer(&acknowledgement)
            .unwrap();
        store.publish_committed(&acknowledgement).unwrap();

        let after_retirement = store.capture_projection_source().unwrap();
        let after_retirement = after_retirement.visible_history_state();
        assert!(after_retirement.logical_line_count > 0);
        assert_eq!(after_retirement.end_boundary, Some(offer.end_boundary));
        assert_eq!(
            source.retired_history_transfer_watermark().unwrap(),
            acknowledgement.through_transfer_id,
        );
    }
}
