use super::cold_history::{
    ColdHistoryIdentity, HistoryBoundary, HistoryTransferAck, HistoryTransferOffer,
    LogicalCellAnchor, expected_append_acknowledgement, initial_root_digest,
};
use super::composite_viewport_source::HotHistoryViewportSource;
use super::terminal_core::{
    SnapshotRepaint, TerminalCore, TerminalCoreCheckpoint, TerminalCoreCheckpointFormat,
    TerminalCoreEvent, TerminalCoreWrite,
};
use super::terminal_history_transfer::TerminalHistoryTransferSource;
use super::viewport_source::{
    TerminalViewportAnchor, TerminalViewportMetrics, ViewportAnchorError,
    ViewportProjectionGeometry, ViewportSource,
};
use super::{
    TerminalColdHistoryCheckpoint, TerminalPresentationDegradation, TerminalReplayError,
    ViewportCaptureRequest,
};
use crate::local_protocol::ScreenSnapshotProfile;
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Condvar, Mutex, OnceLock};
use terminal_core_ghostty_proof::{
    Core, Format, HistoryPrefixOffer, IndexedScreenRow, Mutation, Observation,
    ProjectedColorOverrides, ProjectedRow, ProjectionKind,
};
use terminal_state_protocol::{BufferId, TerminalColorOverrides};

// The exact pin retains at most 4 KiB of one unfinished continuation. At one
// column that can span 4,096 physical rows, so one bounded offer must be able
// to reach the next hard boundary without rescanning the same prefix forever.
const HISTORY_OFFER_MAX_ROWS: usize = 8_192;
// Keep the native PAGE encoder under the same per-offer ceiling enforced by
// the durable cold store. This avoids an unbounded sizing pass before Rust can
// apply its canonical offer limit.
const HISTORY_OFFER_MAX_BYTES: usize = 4 * 1024 * 1024;
// The row-id encoding reserves 20 low bits for a logical cell offset and the
// high bit for cold rows. This leaves a disjoint, exactly encodable namespace
// for the bounded alternate screen without relying on hashes.
const ALTERNATE_LOGICAL_LINE_BASE: u64 = 1 << 40;
const MAIN_SCREEN: &[u8] = b"\x1b[?1049l";
const ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h";
const RESET_VISIBLE: &[u8] = b"\x1b[?25l\x1b[0m\x1b[?6l\x1b[?7h\x1b[H\x1b[2J";

#[cfg(test)]
#[derive(Default)]
struct ProjectionWorkGateState {
    entered: bool,
    released: bool,
}

#[cfg(test)]
pub(super) struct ProjectionWorkGate {
    state: Mutex<ProjectionWorkGateState>,
    changed: Condvar,
}

#[cfg(test)]
impl ProjectionWorkGate {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ProjectionWorkGateState::default()),
            changed: Condvar::new(),
        })
    }

    fn enter(&self) {
        let mut state = self.state.lock().expect("lock projection work gate");
        state.entered = true;
        self.changed.notify_all();
        while !state.released {
            state = self
                .changed
                .wait(state)
                .expect("wait on projection work gate");
        }
    }

    pub(super) fn wait_entered(&self, timeout: std::time::Duration) -> bool {
        let state = self.state.lock().expect("lock projection work gate");
        self.changed
            .wait_timeout_while(state, timeout, |state| !state.entered)
            .expect("wait for projection work")
            .0
            .entered
    }

    pub(super) fn release(&self) {
        let mut state = self.state.lock().expect("lock projection work gate");
        state.released = true;
        self.changed.notify_all();
    }
}

#[cfg(test)]
type InstalledProjectionWork = Option<(std::thread::ThreadId, Arc<ProjectionWorkGate>)>;

#[cfg(test)]
static PROJECTION_WORK_GATE: OnceLock<Mutex<InstalledProjectionWork>> = OnceLock::new();

#[cfg(test)]
pub(super) struct InstalledProjectionWorkGate;

#[cfg(test)]
impl Drop for InstalledProjectionWorkGate {
    fn drop(&mut self) {
        if let Some(slot) = PROJECTION_WORK_GATE.get() {
            if let Ok(mut slot) = slot.lock() {
                if let Some((_, gate)) = slot.take() {
                    gate.release();
                }
            }
        }
    }
}

#[cfg(test)]
pub(super) fn install_projection_work_gate(
    gate: Arc<ProjectionWorkGate>,
) -> InstalledProjectionWorkGate {
    let slot = PROJECTION_WORK_GATE.get_or_init(|| Mutex::new(None));
    let mut slot = slot.lock().expect("lock projection work gate installation");
    assert!(slot.is_none(), "projection work gate installed twice");
    *slot = Some((std::thread::current().id(), gate));
    InstalledProjectionWorkGate
}

#[cfg(test)]
fn wait_on_projection_work_gate() {
    let current = std::thread::current().id();
    let gate = PROJECTION_WORK_GATE.get().and_then(|slot| {
        let slot = slot.lock().ok()?;
        slot.as_ref()
            .filter(|(owner, _)| *owner == current)
            .map(|(_, gate)| Arc::clone(gate))
    });
    if let Some(gate) = gate {
        gate.enter();
    }
}

pub(super) struct GhosttyProofAdapter {
    core: Core,
    terminal_epoch: String,
    history_namespace: String,
    store_id: String,
    hot_reserve_rows: usize,
    next_logical_line_id: u64,
    next_transfer_id: u64,
    retired_transfer_watermark: u64,
    pending_history_offer: Option<PendingHistoryOffer>,
    last_history_ack: Option<HistoryTransferAck>,
    cold_root_generation: u64,
    cold_root_digest: [u8; 32],
    last_projection: Option<ProjectionObservation>,
}

struct PendingHistoryOffer {
    transfer: HistoryTransferOffer,
    native: HistoryPrefixOffer,
    next_logical_line_id: u64,
    canonical_bytes: usize,
    expected_acknowledgement: HistoryTransferAck,
}

struct GhosttyHotCapture {
    rows: Vec<HotHistoryRow>,
    windows: Vec<CapturedHotWindow>,
    accounted_bytes: usize,
    metrics: TerminalViewportMetrics,
    columns: u16,
    cursor: Option<(usize, u16)>,
    color_overrides: ProjectedColorOverrides,
}

#[derive(Clone)]
struct HotHistoryRow {
    anchor: LogicalCellAnchor,
    logical_cell_span: u32,
}

struct ImmutableGhosttyHotSource {
    capture: Arc<GhosttyHotCapture>,
}

struct CapturedHotWindow {
    start: usize,
    rows: Vec<ProjectedRow>,
}

impl GhosttyHotCapture {
    fn projected_rows(&self, start: usize, end: usize) -> Option<&[ProjectedRow]> {
        self.windows.iter().find_map(|window| {
            let window_end = window.start.checked_add(window.rows.len())?;
            (start >= window.start && end <= window_end)
                .then(|| &window.rows[start - window.start..end - window.start])
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProjectionObservation {
    kind: ProjectionKind,
    dirty_rows: usize,
    visited_rows: usize,
    history: HistoryProjection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HistoryProjection {
    Unchanged,
    FullRebuild,
}

struct GhosttyViewportAnchor {
    capture: Arc<GhosttyHotCapture>,
    row: usize,
}

impl TerminalViewportAnchor for GhosttyViewportAnchor {
    fn move_rows(
        &mut self,
        delta: i64,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<i64, ViewportAnchorError> {
        if geometry.columns != self.capture.columns || self.capture.rows.is_empty() {
            return Err(ViewportAnchorError::Pruned);
        }
        let last = self.capture.rows.len() - 1;
        let target = i128::try_from(self.row)
            .unwrap_or(i128::MAX)
            .saturating_add(i128::from(delta))
            .clamp(0, i128::try_from(last).unwrap_or(i128::MAX));
        let target = usize::try_from(target).map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
        let moved = i64::try_from(target)
            .unwrap_or(i64::MAX)
            .saturating_sub(i64::try_from(self.row).unwrap_or(i64::MAX));
        self.row = target;
        Ok(moved)
    }

    fn project_rows(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<super::viewport_source::BoundedViewportRows, ViewportAnchorError> {
        if geometry.columns != self.capture.columns || self.row >= self.capture.rows.len() {
            return Err(ViewportAnchorError::Pruned);
        }
        let end = self
            .row
            .saturating_add(usize::from(geometry.viewport_rows))
            .min(self.capture.rows.len());
        #[cfg(test)]
        wait_on_projection_work_gate();
        let rows = self.capture.projected_rows(self.row, end).ok_or_else(|| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
        let cursor = self.capture.cursor.and_then(|(row, column)| {
            (row >= self.row && row < end)
                .then(|| (u16::try_from(row - self.row).unwrap_or(u16::MAX), column))
        });
        super::ghostty_state_projection::structured_viewport_rows(
            rows,
            self.row != 0,
            end < self.capture.rows.len(),
            cursor,
            self.capture.rows[self.row].anchor,
            self.capture.color_overrides.clone(),
        )
        .map_err(ViewportAnchorError::unavailable)
    }
}

impl ViewportSource for ImmutableGhosttyHotSource {
    fn viewport_metrics(&self) -> Result<TerminalViewportMetrics, TerminalReplayError> {
        Ok(self.capture.metrics)
    }

    fn track_tail_viewport_anchor(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, TerminalReplayError> {
        if geometry.columns != self.capture.columns {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "hot source column count does not match its capture",
            });
        }
        if self.capture.rows.is_empty() {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "hot source capture has no rows",
            });
        }
        let row = self
            .capture
            .rows
            .len()
            .saturating_sub(usize::from(geometry.viewport_rows));
        Ok(Box::new(GhosttyViewportAnchor {
            capture: Arc::clone(&self.capture),
            row,
        }))
    }
}

impl HotHistoryViewportSource for ImmutableGhosttyHotSource {
    fn accounted_capture_bytes(&self) -> usize {
        self.capture.accounted_bytes
    }

    fn hot_start_boundary(&self) -> Result<HistoryBoundary, TerminalReplayError> {
        if self.capture.metrics.alternate_screen {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        self.capture
            .rows
            .first()
            .map(|row| history_boundary(row.anchor))
            .ok_or(TerminalReplayError::ColdHistoryInvariant)
    }

    fn resolve_hot_logical_anchor(
        &self,
        anchor: LogicalCellAnchor,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, ViewportAnchorError> {
        if geometry.columns != self.capture.columns {
            return Err(ViewportAnchorError::Pruned);
        }
        let row = self
            .capture
            .rows
            .iter()
            .position(|row| logical_anchor_contains(row, anchor))
            .ok_or(ViewportAnchorError::Pruned)?;
        Ok(Box::new(GhosttyViewportAnchor {
            capture: Arc::clone(&self.capture),
            row,
        }))
    }

    fn current_color_overrides(&self) -> Result<TerminalColorOverrides, TerminalReplayError> {
        Ok(super::ghostty_state_projection::terminal_color_overrides(
            self.capture.color_overrides.clone(),
        ))
    }
}

fn logical_anchor_contains(row: &HotHistoryRow, requested: LogicalCellAnchor) -> bool {
    row.anchor.logical_line_id == requested.logical_line_id
        && row.anchor.logical_cell_offset <= requested.logical_cell_offset
        && requested.logical_cell_offset
            < row
                .anchor
                .logical_cell_offset
                .saturating_add(row.logical_cell_span.max(1))
}

fn history_boundary(anchor: LogicalCellAnchor) -> HistoryBoundary {
    let mut token = [0_u8; 16];
    token[..8].copy_from_slice(&anchor.logical_line_id.to_le_bytes());
    token[8..12].copy_from_slice(&anchor.logical_cell_offset.to_le_bytes());
    token[12..].copy_from_slice(b"HMX1");
    HistoryBoundary::new(token, Some(anchor))
}

fn index_rows(
    first_logical_line_id: u64,
    columns: u16,
    rows: &[IndexedScreenRow],
) -> Result<Vec<HotHistoryRow>, TerminalReplayError> {
    if rows.is_empty() || first_logical_line_id == 0 || columns == 0 {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    let mut indexed = Vec::with_capacity(rows.len());
    let mut logical_line_id = first_logical_line_id;
    let mut logical_cell_offset = 0_u32;
    for (index, row) in rows.iter().enumerate() {
        if index > 0 && !(rows[index - 1].wraps && row.continues) {
            logical_line_id = logical_line_id
                .checked_add(1)
                .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
            logical_cell_offset = 0;
        }
        let span = u32::from(columns);
        indexed.push(HotHistoryRow {
            anchor: LogicalCellAnchor {
                logical_line_id,
                logical_cell_offset,
            },
            logical_cell_span: span,
        });
        logical_cell_offset = logical_cell_offset
            .checked_add(span)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
    }
    Ok(indexed)
}

#[cfg(test)]
#[test]
fn hot_index_derives_continuation_without_revalidating_native_row_flags() {
    let rows = [
        IndexedScreenRow {
            wraps: false,
            continues: true,
        },
        IndexedScreenRow {
            wraps: false,
            continues: true,
        },
        IndexedScreenRow {
            wraps: true,
            continues: false,
        },
        IndexedScreenRow {
            wraps: false,
            continues: true,
        },
    ];

    let indexed = index_rows(17, 80, &rows).unwrap();

    assert_eq!(indexed[0].anchor.logical_line_id, 17);
    assert_eq!(indexed[1].anchor.logical_line_id, 18);
    assert_eq!(indexed[2].anchor.logical_line_id, 19);
    assert_eq!(indexed[3].anchor.logical_line_id, 19);
}

#[cfg(test)]
#[test]
fn hot_capture_copies_only_requested_cell_windows() {
    let mut adapter = GhosttyProofAdapter::new_bounded_for_test(4, 80, 4_096).unwrap();
    let mut history = String::new();
    for row in 0..2_000 {
        history.push_str(&format!("row-{row:04}\r\n"));
    }
    adapter.process(history.as_bytes()).unwrap();

    let source = adapter
        .capture_hot_source(&[ViewportCaptureRequest::tail_for_test(3)], usize::MAX)
        .unwrap();
    let copied_rows = source
        .capture
        .windows
        .iter()
        .map(|window| window.rows.len())
        .sum::<usize>();

    assert!(source.capture.rows.len() > 1_000);
    assert_eq!(
        copied_rows, 6,
        "only the hot seam and requested tail cells are copied"
    );
}

#[test]
fn erase_in_line_background_survives_hot_viewport_projection() {
    const ROWS: u16 = 2;
    const COLUMNS: u16 = 12;
    const COMPOSER_BACKGROUND: u32 = 0x33_33_33;
    let mut adapter = GhosttyProofAdapter::new_bounded_for_test(ROWS, COLUMNS, 4_096).unwrap();
    adapter.process(b"\x1b[48;2;51;51;51m>\x1b[K").unwrap();

    let source = adapter
        .capture_hot_source(&[ViewportCaptureRequest::tail_for_test(ROWS)], usize::MAX)
        .unwrap();
    let geometry = ViewportProjectionGeometry::new(
        COLUMNS,
        ROWS,
        1,
        terminal_state_protocol::UnicodeWidthProfile {
            unicode_version: "ghostty-pin-47147324".to_string(),
            ambiguous_width: 1,
            emoji_width: 2,
        },
    );
    let anchor = source.track_tail_viewport_anchor(&geometry).unwrap();
    let projection = anchor
        .project_rows(&geometry)
        .unwrap_or_else(|_| panic!("project the captured composer row"));
    let row = &projection.rows[0];

    assert_eq!(row.cells.len(), usize::from(COLUMNS));
    for (column, cell) in row.cells.iter().enumerate() {
        let background = projection.tables.styles[cell.style_index as usize]
            .background
            .as_ref()
            .unwrap_or_else(|| panic!("column {column} lost the composer background"));
        assert_eq!(
            background.kind,
            terminal_state_protocol::ColorKind::Rgb as i32,
            "column {column} changed the composer background kind"
        );
        assert_eq!(
            background.value, COMPOSER_BACKGROUND,
            "column {column} changed the composer background value"
        );
    }
}

#[test]
fn staggered_attachment_union_stops_at_the_capture_byte_boundary() {
    const COLUMNS: usize = 128;
    const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
    let mut adapter = GhosttyProofAdapter::new_bounded_for_test(64, COLUMNS as u16, 4_096).unwrap();
    let line = format!("{}\r\n", "x".repeat(COLUMNS));
    adapter.process(line.repeat(4_096).as_bytes()).unwrap();
    let requests = (0..64)
        .map(|index| {
            let mut request = ViewportCaptureRequest::tail_for_test(64);
            request.pending_scroll_rows = i64::from(index * 64);
            request
        })
        .collect::<Vec<_>>();

    assert!(matches!(
        adapter.capture_hot_source(&requests, MAX_CAPTURE_BYTES),
        Err(TerminalReplayError::ViewportCaptureBudgetExceeded {
            maximum: MAX_CAPTURE_BYTES,
            ..
        })
    ));
}

#[test]
fn worst_legal_capture_does_not_stall_concurrent_pty_ingest() {
    const COLUMNS: usize = 1_024;
    const ROWS: u16 = 512;
    const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
    const MAX_INGEST_DELAY: std::time::Duration = std::time::Duration::from_millis(60);
    let mut adapter =
        GhosttyProofAdapter::new_bounded_for_test(ROWS, COLUMNS as u16, 4_096).unwrap();
    let line = format!("{}\r\n", "x".repeat(COLUMNS));
    adapter.process(line.repeat(4_096).as_bytes()).unwrap();
    let adapter = Arc::new(Mutex::new(adapter));
    let request = ViewportCaptureRequest::tail_for_test(ROWS);
    let mut delays = Vec::new();

    for _ in 0..10 {
        let capture_adapter = Arc::clone(&adapter);
        let request = request.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::sync_channel(1);
        let capture = std::thread::spawn(move || {
            let adapter = capture_adapter.lock().unwrap();
            locked_tx.send(()).unwrap();
            adapter.capture_hot_source(&[request], MAX_CAPTURE_BYTES)
        });
        locked_rx.recv().unwrap();
        let started = std::time::Instant::now();
        adapter.lock().unwrap().process(b"x").unwrap();
        delays.push(started.elapsed());
        assert!(matches!(
            capture.join().unwrap(),
            Err(TerminalReplayError::ViewportCaptureBudgetExceeded {
                maximum: MAX_CAPTURE_BYTES,
                ..
            })
        ));
    }

    delays.sort_unstable();
    let p95 = delays[9];
    eprintln!("worst legal capture PTY-ingest delays: p95={p95:?}, samples={delays:?}");
    assert!(
        p95 < MAX_INGEST_DELAY,
        "bounded source capture delayed PTY ingest for {p95:?}: {delays:?}"
    );
}

impl TerminalHistoryTransferSource for GhosttyProofAdapter {
    fn retired_history_transfer_watermark(&self) -> Result<u64, TerminalReplayError> {
        Ok(self.retired_transfer_watermark)
    }

    fn retained_pending_history_bytes(&self) -> Result<usize, TerminalReplayError> {
        let observation = self
            .core
            .observe()
            .map_err(|error| engine_error("measure retained history", error.0))?;
        if observation.alternate_screen {
            return Ok(self
                .pending_history_offer
                .as_ref()
                .map_or(0, |pending| pending.canonical_bytes));
        }
        let pending_rows = self
            .pending_history_offer
            .as_ref()
            .map_or(0, |pending| pending.native.physical_rows);
        let unoffered_rows = observation
            .scrollback_rows
            .saturating_sub(self.hot_reserve_rows)
            .saturating_sub(pending_rows);
        let estimated_unoffered = unoffered_rows
            .saturating_mul(usize::from(observation.columns))
            .saturating_mul(16);
        Ok(self
            .pending_history_offer
            .as_ref()
            .map_or(0, |pending| pending.canonical_bytes)
            .saturating_add(estimated_unoffered))
    }

    fn can_accept_history_growth(
        &self,
        maximum_pending_bytes: usize,
        incoming_bytes: usize,
    ) -> Result<bool, TerminalReplayError> {
        Ok(self
            .retained_pending_history_bytes()?
            .saturating_add(incoming_bytes.saturating_mul(64))
            <= maximum_pending_bytes)
    }

    fn next_history_transfer_offer(
        &mut self,
    ) -> Result<Option<HistoryTransferOffer>, TerminalReplayError> {
        if let Some(pending) = &self.pending_history_offer {
            return Ok(Some(pending.transfer.clone()));
        }
        if self
            .core
            .observe()
            .map_err(|error| engine_error("observe history offer", error.0))?
            .alternate_screen
        {
            return Ok(None);
        }
        let first_anchor = LogicalCellAnchor {
            logical_line_id: self.next_logical_line_id,
            logical_cell_offset: 0,
        };
        if first_anchor.logical_line_id == 0 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let (native, archive) = {
            let Some(native) = self
                .core
                .next_history_prefix_offer(self.hot_reserve_rows, HISTORY_OFFER_MAX_ROWS)
                .map_err(|error| engine_error("inspect history offer", error.0))?
            else {
                return Ok(None);
            };
            let archive = native
                .encode_native_archive(first_anchor.logical_line_id, HISTORY_OFFER_MAX_BYTES)
                .map_err(|error| engine_error("encode native history offer", error.0))?;
            (native, archive)
        };
        if archive.physical_rows != native.physical_rows
            || archive.first_logical_line_id != first_anchor.logical_line_id
            || archive.next_logical_line_id <= archive.first_logical_line_id
        {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let end_anchor = LogicalCellAnchor {
            logical_line_id: archive.next_logical_line_id,
            logical_cell_offset: 0,
        };
        let next_logical_line_id = archive.next_logical_line_id;
        let transfer = HistoryTransferOffer::native_archive(
            &self.terminal_epoch,
            self.next_transfer_id,
            self.retired_transfer_watermark,
            (history_boundary(first_anchor), history_boundary(end_anchor)),
            archive,
        );
        let canonical_bytes = transfer.canonical_encoded_bytes()?;
        let expected_acknowledgement = expected_append_acknowledgement(
            &ColdHistoryIdentity::new(&self.history_namespace, &self.store_id),
            self.cold_root_generation,
            self.cold_root_digest,
            self.retired_transfer_watermark,
            &transfer,
        )?;
        self.pending_history_offer = Some(PendingHistoryOffer {
            transfer: transfer.clone(),
            native,
            next_logical_line_id,
            canonical_bytes,
            expected_acknowledgement,
        });
        Ok(Some(transfer))
    }

    fn acknowledge_history_transfer(
        &mut self,
        acknowledgement: &HistoryTransferAck,
    ) -> Result<(), TerminalReplayError> {
        if self.last_history_ack.as_ref() == Some(acknowledgement)
            && acknowledgement.through_transfer_id == self.retired_transfer_watermark
        {
            return Ok(());
        }
        let pending = self
            .pending_history_offer
            .as_ref()
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        let transfer_id = pending.transfer.transfer_id;
        if acknowledgement != &pending.expected_acknowledgement {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        self.core
            .acknowledge_history_prefix(&pending.native)
            .map_err(|error| engine_error("retire history transfer", error.0))?;
        self.next_logical_line_id = pending.next_logical_line_id;
        self.next_transfer_id = transfer_id
            .checked_add(1)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        self.retired_transfer_watermark = transfer_id;
        self.cold_root_generation = acknowledgement.cold_root_generation;
        self.cold_root_digest = acknowledgement.root_digest;
        self.last_history_ack = Some(acknowledgement.clone());
        self.pending_history_offer = None;
        Ok(())
    }

    fn abandon_history_transfer(&mut self) {
        self.pending_history_offer = None;
    }
}

impl GhosttyProofAdapter {
    pub(super) fn new(
        rows: u16,
        columns: u16,
        hot_reserve_rows: usize,
        maximum_history_lines: usize,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, TerminalReplayError> {
        Self::from_core(
            Core::new_history_supplier(columns, rows, maximum_history_lines)
                .map_err(|error| engine_error("create", error.0))?,
            hot_reserve_rows,
            terminal_epoch.into(),
            None,
        )
    }

    pub(super) fn new_with_cold_history(
        rows: u16,
        columns: u16,
        hot_reserve_rows: usize,
        maximum_history_lines: usize,
        terminal_epoch: impl Into<String>,
        cold_history: Option<&TerminalColdHistoryCheckpoint>,
    ) -> Result<Self, TerminalReplayError> {
        Self::from_core(
            Core::new_history_supplier(columns, rows, maximum_history_lines)
                .map_err(|error| engine_error("create", error.0))?,
            hot_reserve_rows,
            terminal_epoch.into(),
            cold_history,
        )
    }

    pub(super) fn from_snapshot(
        snapshot: &[u8],
        hot_reserve_rows: usize,
        terminal_epoch: impl Into<String>,
        cold_history: Option<&TerminalColdHistoryCheckpoint>,
    ) -> Result<Self, TerminalReplayError> {
        Self::from_core(
            Core::restore(snapshot).map_err(|error| engine_error("restore", error.0))?,
            hot_reserve_rows,
            terminal_epoch.into(),
            cold_history,
        )
    }

    #[cfg(test)]
    fn new_bounded_for_test(
        rows: u16,
        columns: u16,
        history_lines: usize,
    ) -> Result<Self, TerminalReplayError> {
        Self::from_core(
            Core::new(columns, rows, history_lines)
                .map_err(|error| engine_error("create bounded test core", error.0))?,
            history_lines,
            "proof-terminal".to_string(),
            None,
        )
    }

    fn from_core(
        core: Core,
        hot_reserve_rows: usize,
        terminal_epoch: String,
        cold_history: Option<&TerminalColdHistoryCheckpoint>,
    ) -> Result<Self, TerminalReplayError> {
        let cold_identity = cold_history.map_or_else(
            || ColdHistoryIdentity::new(&terminal_epoch, "cold-v1"),
            |checkpoint| {
                ColdHistoryIdentity::new(&checkpoint.history_namespace, &checkpoint.store_id)
            },
        );
        let next_logical_line_id =
            cold_history.map_or(1, |checkpoint| checkpoint.end_logical_line_id);
        let next_transfer_id = match cold_history {
            Some(checkpoint) => checkpoint
                .root_generation
                .checked_add(1)
                .ok_or(TerminalReplayError::ColdHistoryInvariant)?,
            None => 1,
        };
        Ok(Self {
            core,
            store_id: cold_identity.store_id.clone(),
            history_namespace: cold_identity.history_namespace.clone(),
            terminal_epoch,
            hot_reserve_rows,
            next_logical_line_id,
            next_transfer_id,
            retired_transfer_watermark: cold_history
                .map_or(0, |checkpoint| checkpoint.root_generation),
            pending_history_offer: None,
            last_history_ack: None,
            cold_root_generation: cold_history.map_or(0, |checkpoint| checkpoint.root_generation),
            cold_root_digest: cold_history.map_or_else(
                || initial_root_digest(&cold_identity),
                |checkpoint| checkpoint.root_digest,
            ),
            last_projection: None,
        })
    }

    fn capture_hot_source(
        &self,
        requests: &[ViewportCaptureRequest],
        maximum_capture_bytes: usize,
    ) -> Result<Arc<ImmutableGhosttyHotSource>, TerminalReplayError> {
        let observation = self
            .core
            .observe()
            .map_err(|error| engine_error("observe hot history", error.0))?;
        if observation.total_rows == 0 || requests.is_empty() {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let first_logical_line_id = if observation.alternate_screen {
            ALTERNATE_LOGICAL_LINE_BASE
        } else {
            self.next_logical_line_id
        };
        let anchor = if observation.alternate_screen || observation.scrollback_rows == 0 {
            self.core.track_screen_row(0)
        } else {
            self.core.track_history_row(0)
        }
        .map_err(|error| engine_error("track hot history start", error.0))?;
        let row_index = anchor
            .index_rows(observation.total_rows)
            .map_err(|error| engine_error("index hot history", error.0))?;
        if row_index.rows.len() != observation.total_rows || row_index.has_more_after {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        let rows = index_rows(first_logical_line_id, observation.columns, &row_index.rows)?;
        let mut accounted_bytes = rows
            .len()
            .checked_mul(std::mem::size_of::<HotHistoryRow>())
            .ok_or(TerminalReplayError::ViewportCaptureBudgetExceeded {
                actual: usize::MAX,
                maximum: maximum_capture_bytes,
            })?;
        if accounted_bytes > maximum_capture_bytes {
            return Err(TerminalReplayError::ViewportCaptureBudgetExceeded {
                actual: accounted_bytes,
                maximum: maximum_capture_bytes,
            });
        }
        let color_overrides = anchor
            .color_overrides()
            .map_err(|error| engine_error("capture terminal color overrides", error.0))?;
        drop(anchor);
        let ranges = capture_ranges(requests, &rows, observation.alternate_screen);
        let mut windows = Vec::with_capacity(ranges.len());
        for (start, end) in ranges {
            let anchor = self
                .core
                .track_screen_row(start)
                .map_err(|error| engine_error("track requested hot viewport", error.0))?;
            let remaining = maximum_capture_bytes.saturating_sub(accounted_bytes);
            let projection = anchor
                .project_rows_with_budget(observation.columns, end.saturating_sub(start), remaining)
                .map_err(|error| {
                    if error.is_projection_capacity_exceeded() {
                        TerminalReplayError::ViewportCaptureBudgetExceeded {
                            actual: maximum_capture_bytes.saturating_add(1),
                            maximum: maximum_capture_bytes,
                        }
                    } else {
                        engine_error("copy requested hot viewport", error.0)
                    }
                })?;
            if projection.rows.len() != end.saturating_sub(start)
                || projection.visited_rows != projection.rows.len()
                || projection.has_more_before != (start != 0)
                || projection.has_more_after != (end < rows.len())
            {
                return Err(TerminalReplayError::ColdHistoryInvariant);
            }
            accounted_bytes = accounted_bytes
                .checked_add(projection.accounted_bytes)
                .ok_or(TerminalReplayError::ViewportCaptureBudgetExceeded {
                    actual: usize::MAX,
                    maximum: maximum_capture_bytes,
                })?;
            windows.push(CapturedHotWindow {
                start,
                rows: projection.rows,
            });
        }
        let cursor_row = observation
            .scrollback_rows
            .checked_add(usize::from(observation.cursor_row))
            .filter(|row| *row < observation.total_rows)
            .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        Ok(Arc::new(ImmutableGhosttyHotSource {
            capture: Arc::new(GhosttyHotCapture {
                rows,
                windows,
                accounted_bytes,
                metrics: TerminalViewportMetrics {
                    total_rows: Some(observation.total_rows),
                    scrollback_rows: Some(observation.scrollback_rows),
                    alternate_screen: observation.alternate_screen,
                },
                columns: observation.columns,
                cursor: Some((cursor_row, observation.cursor_column)),
                color_overrides,
            }),
        }))
    }

    fn apply_mutation(
        &mut self,
        before: Observation,
        mut mutation: Mutation,
    ) -> Result<TerminalCoreWrite, TerminalReplayError> {
        let after = match self
            .core
            .observe()
            .map_err(|error| engine_error("observe", error.0))
        {
            Ok(after) => after,
            Err(_) => {
                return Ok(TerminalCoreWrite {
                    pty_replies: std::mem::take(&mut mutation.replies),
                    pty_reply_overflow: mutation.reply_overflow,
                    events: mutation
                        .clipboard_writes
                        .into_iter()
                        .map(TerminalCoreEvent::ClipboardWrite)
                        .collect(),
                    event_overflow: mutation.clipboard_overflow,
                    projection_changed: true,
                    presentation_degradation: Some(
                        TerminalPresentationDegradation::MutationObservation,
                    ),
                });
            }
        };
        let history = history_projection(before, after, mutation.projection);
        let projection_changed = mutation.projection != ProjectionKind::Clean
            || mutation.projection_degraded
            || history != HistoryProjection::Unchanged
            || before != after;
        self.last_projection = Some(ProjectionObservation {
            kind: mutation.projection,
            dirty_rows: mutation.dirty_rows,
            visited_rows: mutation.visited_rows,
            history,
        });
        Ok(TerminalCoreWrite {
            pty_replies: std::mem::take(&mut mutation.replies),
            pty_reply_overflow: mutation.reply_overflow,
            events: mutation
                .clipboard_writes
                .into_iter()
                .map(TerminalCoreEvent::ClipboardWrite)
                .collect(),
            event_overflow: mutation.clipboard_overflow,
            projection_changed,
            presentation_degradation: mutation
                .projection_degraded
                .then_some(TerminalPresentationDegradation::MutationProjection),
        })
    }

    #[cfg(test)]
    fn snapshot(&self) -> Vec<u8> {
        self.core.snapshot().expect("snapshot Ghostty proof core")
    }

    fn styled_contents(&self) -> Vec<u8> {
        self.core
            .format(Format::StyledVt)
            .expect("format styled Ghostty proof core")
    }

    fn truncated_plain_repaint(
        &self,
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError> {
        let observation = self
            .core
            .observe()
            .map_err(|error| engine_error("observe", error.0))?;
        let selector = if observation.alternate_screen {
            ALTERNATE_SCREEN
        } else {
            MAIN_SCREEN
        };
        let suffix = repaint_suffix(observation);
        let required = selector.len() + RESET_VISIBLE.len() + suffix.len();
        if maximum < required {
            return Err(TerminalReplayError::SnapshotLimitTooSmall {
                minimum: required,
                actual: maximum,
            });
        }

        let contents = self.screen_contents();
        let available = maximum - required;
        let mut end = contents.len().min(available);
        while !contents.is_char_boundary(end) {
            end -= 1;
        }
        let mut bytes = Vec::with_capacity(required + end);
        bytes.extend_from_slice(selector);
        bytes.extend_from_slice(RESET_VISIBLE);
        bytes.extend_from_slice(&contents.as_bytes()[..end]);
        bytes.extend_from_slice(&suffix);
        Ok(SnapshotRepaint {
            bytes,
            truncated: true,
            actual_profile: None,
        })
    }
}

fn repaint_suffix(observation: Observation) -> Vec<u8> {
    let mut suffix = b"\x1b[0m".to_vec();
    suffix.extend_from_slice(if observation.application_cursor {
        b"\x1b[?1h"
    } else {
        b"\x1b[?1l"
    });
    suffix.extend_from_slice(if observation.bracketed_paste {
        b"\x1b[?2004h"
    } else {
        b"\x1b[?2004l"
    });
    suffix.extend_from_slice(
        format!(
            "\x1b[{};{}H",
            observation.cursor_row + 1,
            observation.cursor_column + 1
        )
        .as_bytes(),
    );
    suffix.extend_from_slice(if observation.cursor_visible {
        b"\x1b[?25h"
    } else {
        b"\x1b[?25l"
    });
    suffix
}

fn capture_ranges(
    requests: &[ViewportCaptureRequest],
    rows: &[HotHistoryRow],
    alternate_screen: bool,
) -> Vec<(usize, usize)> {
    let total_rows = rows.len();
    let last = total_rows.saturating_sub(1);
    let mut ranges = Vec::with_capacity(requests.len().saturating_mul(4));
    let mut add = |start: usize, count: usize| {
        // Reaching the end restores the full tail viewport. An overshoot must
        // retain that window, not only the shorter suffix used to reach it.
        let start = start.min(total_rows.saturating_sub(count));
        let end = start.saturating_add(count).min(total_rows);
        if start < end {
            ranges.push((start, end));
        }
    };
    let active_buffer = if alternate_screen {
        BufferId::Alternate
    } else {
        BufferId::Normal
    } as i32;
    for request in requests {
        let viewport_rows = usize::from(request.viewport_rows);
        let tail = total_rows.saturating_sub(viewport_rows);
        let delta = request.pending_scroll_rows.saturating_neg();
        let buffer_changed = request
            .anchor_buffer
            .is_some_and(|buffer| buffer != active_buffer);

        // A cold projection can reach the hot owner after capture, so every
        // immutable generation retains one viewport at that ownership seam.
        add(0, viewport_rows);
        if request.follow_tail || buffer_changed {
            add(moved_hot_row(tail, delta, last), viewport_rows);
        }

        if !request.follow_tail && !buffer_changed {
            match request.anchor_logical.and_then(|anchor| {
                rows.iter()
                    .position(|row| logical_anchor_contains(row, anchor))
            }) {
                Some(row) => add(moved_hot_row(row, delta, last), viewport_rows),
                None => {
                    // A cold anchor can cross the ownership seam. Its exact
                    // remaining delta depends on cold wrapping, so retain the
                    // bounded prefix containing every possible hot target and
                    // enough rows to validate or cross that seam.
                    let movement = usize::try_from(delta.max(0)).unwrap_or(total_rows);
                    add(0, movement.saturating_add(viewport_rows));
                }
            }
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some(previous) = merged.last_mut() {
            if start <= previous.1 {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

fn moved_hot_row(row: usize, delta: i64, last: usize) -> usize {
    let target = i128::try_from(row)
        .unwrap_or(i128::MAX)
        .saturating_add(i128::from(delta))
        .clamp(0, i128::try_from(last).unwrap_or(i128::MAX));
    usize::try_from(target).unwrap_or(last)
}

impl TerminalCore for GhosttyProofAdapter {
    fn process(&mut self, bytes: &[u8]) -> Result<TerminalCoreWrite, TerminalReplayError> {
        let before = self
            .core
            .observe()
            .map_err(|error| engine_error("observe", error.0))?;
        let mutation = self
            .core
            .write(bytes)
            .map_err(|error| engine_error("write", error.0))?;
        self.apply_mutation(before, mutation)
    }

    fn resize(
        &mut self,
        rows: u16,
        columns: u16,
    ) -> Result<TerminalCoreWrite, TerminalReplayError> {
        let before = self
            .core
            .observe()
            .map_err(|error| engine_error("observe", error.0))?;
        let mutation = self
            .core
            .resize(columns, rows)
            .map_err(|error| engine_error("resize", error.0))?;
        self.apply_mutation(before, mutation)
    }

    fn size(&self) -> (u16, u16) {
        let observation = self.core.observe().expect("observe Ghostty proof size");
        (observation.rows, observation.columns)
    }

    fn alternate_screen(&self) -> bool {
        self.core
            .observe()
            .expect("observe Ghostty proof screen")
            .alternate_screen
    }

    fn cursor_visible(&self) -> bool {
        self.core
            .observe()
            .expect("observe Ghostty proof cursor")
            .cursor_visible
    }

    fn screen_contents(&self) -> String {
        String::from_utf8(
            self.core
                .format(Format::Plain)
                .expect("format plain Ghostty proof core"),
        )
        .expect("Ghostty plain formatter returns UTF-8")
    }

    fn repaint(
        &self,
        profile: ScreenSnapshotProfile,
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError> {
        let omit_history = if profile == ScreenSnapshotProfile::ViewportOnly {
            let observation = self
                .core
                .observe()
                .map_err(|error| engine_error("observe", error.0))?;
            !observation.alternate_screen && observation.scrollback_rows > 0
        } else {
            false
        };
        let bytes = if omit_history {
            self.core
                .format(Format::StyledActiveVt)
                .map_err(|error| engine_error("format active screen", error.0))?
        } else {
            self.styled_contents()
        };
        if bytes.len() > maximum {
            return self.truncated_plain_repaint(maximum);
        }
        Ok(SnapshotRepaint {
            bytes,
            truncated: false,
            actual_profile: omit_history.then_some(ScreenSnapshotProfile::ViewportOnly),
        })
    }

    fn checkpoint(&self, maximum: usize) -> Result<TerminalCoreCheckpoint, TerminalReplayError> {
        let bytes = self
            .core
            .snapshot()
            .map_err(|error| engine_error("checkpoint", error.0))?;
        if bytes.len() > maximum {
            return Err(TerminalReplayError::SnapshotLimitTooSmall {
                minimum: bytes.len(),
                actual: maximum,
            });
        }
        let (rows, columns) = self.size();
        Ok(TerminalCoreCheckpoint {
            format: TerminalCoreCheckpointFormat::EngineNativeV1,
            engine_fingerprint: Some(
                "libghostty-vt:47147324cee9d12b537f0ea204bf16449d706b3a".to_string(),
            ),
            rows,
            columns,
            bytes,
        })
    }

    fn encode_input(
        &mut self,
        intent: &terminal_state_protocol::InputIntent,
    ) -> Result<Vec<u8>, TerminalReplayError> {
        use terminal_state_protocol::{InputIntent, input_intent};

        let InputIntent {
            intent: Some(input),
            ..
        } = intent
        else {
            return Err(TerminalReplayError::InvalidStructuredInput);
        };
        match input {
            input_intent::Intent::Text(text) => {
                std::str::from_utf8(&text.utf8)
                    .map_err(|_| TerminalReplayError::InvalidStructuredInput)?;
                Ok(text.utf8.clone())
            }
            input_intent::Intent::AgentPrompt(prompt) => {
                std::str::from_utf8(&prompt.utf8)
                    .map_err(|_| TerminalReplayError::InvalidStructuredInput)?;
                let mut bytes = self
                    .core
                    .encode_paste(&prompt.utf8)
                    .map_err(|error| engine_error("encode agent prompt", error.0))?;
                let submit = self
                    .core
                    .encode_key(key_text("Enter"), "Enter", 0, false)
                    .map_err(|error| engine_error("encode agent prompt submit", error.0))?;
                bytes.extend_from_slice(&submit);
                Ok(bytes)
            }
            input_intent::Intent::Key(key) => {
                let utf8 = key_text(&key.key);
                // A sender without a physical code (software keyboards) still
                // names the key; for named keys the DOM key value is the code.
                let code = if key.code.is_empty() {
                    key.key.as_str()
                } else {
                    key.code.as_str()
                };
                self.core
                    .encode_key(utf8, code, key.modifiers, key.repeat)
                    .map_err(|error| engine_error("encode key", error.0))
            }
            input_intent::Intent::Paste(paste) => {
                std::str::from_utf8(&paste.utf8)
                    .map_err(|_| TerminalReplayError::InvalidStructuredInput)?;
                self.core
                    .encode_paste(&paste.utf8)
                    .map_err(|error| engine_error("encode paste", error.0))
            }
            input_intent::Intent::Focus(focus) => self
                .core
                .encode_focus(focus.focused)
                .map_err(|error| engine_error("encode focus", error.0)),
            input_intent::Intent::Pointer(pointer) => self
                .core
                .encode_pointer(terminal_core_ghostty_proof::PointerInput {
                    kind: pointer.kind as u32,
                    button: pointer.button,
                    modifiers: pointer.modifiers,
                    wheel_delta_x: pointer.wheel_delta_x,
                    wheel_delta_y: pointer.wheel_delta_y,
                    pixel_x: pointer.pixel_x,
                    pixel_y: pointer.pixel_y,
                    surface_width: pointer.surface_width,
                    surface_height: pointer.surface_height,
                    cell_width: pointer.cell_width,
                    cell_height: pointer.cell_height,
                    padding_top: pointer.padding_top,
                    padding_bottom: pointer.padding_bottom,
                    padding_right: pointer.padding_right,
                    padding_left: pointer.padding_left,
                    pressed_buttons: pointer.pressed_buttons,
                })
                .map_err(|error| engine_error("encode pointer", error.0)),
            _ => Err(TerminalReplayError::InvalidStructuredInput),
        }
    }

    fn viewport_metadata(
        &self,
        through_event_id: u64,
    ) -> Result<terminal_state_protocol::StateSnapshot, TerminalReplayError> {
        super::ghostty_state_projection::viewport_metadata(&self.core, through_event_id)
    }

    fn capture_hot_viewport_source(
        &self,
        requests: &[ViewportCaptureRequest],
        maximum_capture_bytes: usize,
    ) -> Result<Arc<dyn HotHistoryViewportSource>, TerminalReplayError> {
        Ok(self.capture_hot_source(requests, maximum_capture_bytes)?)
    }

    fn history_transfer_source(&mut self) -> &mut dyn TerminalHistoryTransferSource {
        self
    }

    fn seal_primary_screen_as_history(&mut self) -> Result<(), TerminalReplayError> {
        self.core
            .seal_primary_screen_as_history()
            .map_err(|error| engine_error("seal recovered normal screen", error.0))
    }

    #[cfg(test)]
    fn application_cursor(&self) -> bool {
        self.core
            .observe()
            .expect("observe Ghostty proof mode")
            .application_cursor
    }

    #[cfg(test)]
    fn bracketed_paste(&self) -> bool {
        self.core
            .observe()
            .expect("observe Ghostty proof mode")
            .bracketed_paste
    }

    #[cfg(test)]
    fn cursor_position(&self) -> (u16, u16) {
        let observation = self
            .core
            .observe()
            .expect("observe Ghostty proof cursor position");
        (observation.cursor_row, observation.cursor_column)
    }

    #[cfg(test)]
    fn retained_physical_rows(&self) -> usize {
        self.core
            .observe()
            .expect("observe Ghostty proof history")
            .total_rows
    }
}

fn engine_error(operation: &'static str, code: i32) -> TerminalReplayError {
    TerminalReplayError::TerminalEngineFailure { operation, code }
}

fn key_text(key: &str) -> &[u8] {
    let mut characters = key.chars();
    match characters.next() {
        Some(character) if characters.next().is_none() && !character.is_control() => key.as_bytes(),
        Some(_) if !key.is_ascii() => key.as_bytes(),
        _ => &[],
    }
}

fn history_projection(
    before: Observation,
    after: Observation,
    projection: ProjectionKind,
) -> HistoryProjection {
    if before.alternate_screen == after.alternate_screen
        && before.columns == after.columns
        && before.total_rows == after.total_rows
        && before.scrollback_rows == after.scrollback_rows
        && projection != ProjectionKind::Full
    {
        return HistoryProjection::Unchanged;
    }
    // The pinned public API exposes bounded row counts but no retained-history
    // generation/head identity. A multi-row write can append and prune in one
    // call while still producing a net row-count increase, so arithmetic alone
    // cannot authorize an append journal. Full is the only sound history plan.
    HistoryProjection::FullRebuild
}

#[cfg(test)]
struct ProofActor {
    terminal: GhosttyProofAdapter,
    output_seq: u64,
    state_revision: u64,
}

#[cfg(test)]
impl ProofActor {
    fn new(rows: u16, columns: u16, history_lines: usize) -> Self {
        Self {
            terminal: GhosttyProofAdapter::new_bounded_for_test(rows, columns, history_lines)
                .expect("create exact-pin Ghostty proof"),
            output_seq: 0,
            state_revision: 1,
        }
    }

    fn from_snapshot(snapshot: &[u8]) -> Self {
        Self {
            terminal: GhosttyProofAdapter::from_snapshot(
                snapshot,
                super::DEFAULT_SCROLLBACK_ROWS,
                "proof-terminal",
                None,
            )
            .expect("restore exact-pin Ghostty proof"),
            output_seq: 0,
            state_revision: 1,
        }
    }

    fn ingest(&mut self, bytes: &[u8]) -> Vec<u8> {
        let output_seq = self
            .output_seq
            .checked_add(1)
            .expect("proof output sequence");
        let state_revision = self
            .state_revision
            .checked_add(1)
            .expect("proof state revision");
        let write = self.terminal.process(bytes).expect("process proof bytes");
        self.output_seq = output_seq;
        self.state_revision = state_revision;
        write.pty_replies
    }

    fn resize(&mut self, rows: u16, columns: u16) -> Vec<u8> {
        if self.terminal.size() == (rows, columns) {
            return Vec::new();
        }
        let state_revision = self
            .state_revision
            .checked_add(1)
            .expect("proof state revision");
        let write = self
            .terminal
            .resize(rows, columns)
            .expect("resize proof terminal");
        self.state_revision = state_revision;
        write.pty_replies
    }
}

#[test]
fn agent_prompt_encoding_is_one_mode_aware_body_plus_submit_payload() {
    use terminal_state_protocol::{
        AgentPromptInputIntent, FreshAgentPromptTarget, InputIntent, agent_prompt_input_intent,
        input_intent,
    };

    for (bracketed_paste, expected) in [
        (false, &b"ship it\r"[..]),
        (true, &b"\x1b[200~ship it\x1b[201~\r"[..]),
    ] {
        let mut actor = ProofActor::new(24, 80, 4096);
        if bracketed_paste {
            actor.ingest(b"\x1b[?2004h");
        }
        let encoded = actor
            .terminal
            .encode_input(&InputIntent {
                intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
                    utf8: b"ship it".to_vec(),
                    admission_wait_ms: 0,
                    target: Some(agent_prompt_input_intent::Target::FreshAgent(
                        FreshAgentPromptTarget {},
                    )),
                })),
            })
            .unwrap();
        assert_eq!(encoded, expected);
    }
}

#[test]
fn unmapped_named_keys_encode_as_nothing_instead_of_refusing_input() {
    use terminal_state_protocol::{InputIntent, KeyInputIntent, input_intent};

    // Red on 2026-09-11 (#711): a keydown whose physical code the shim table
    // does not know (media, Fn, an empty or "Unidentified" code) and whose key
    // carries no text failed the engine call, and the runtime surfaced that as
    // "terminal input refused: resource_limit" on a healthy session. Nothing
    // to encode is not an engine failure. A named key that arrives without a
    // physical code (software keyboards) still lands through its key name.
    let mut actor = ProofActor::new(24, 80, 4096);
    for (key, code, modifiers, expected) in [
        ("AudioVolumeUp", "AudioVolumeUp", 0, &b""[..]),
        ("Unidentified", "", 0, &b""[..]),
        ("Fn", "Fn", 0, &b""[..]),
        ("Enter", "", 0, &b"\r"[..]),
        ("Tab", "Tab", 1, &b"\x1b[Z"[..]),
    ] {
        let encoded = actor
            .terminal
            .encode_input(&InputIntent {
                intent: Some(input_intent::Intent::Key(KeyInputIntent {
                    key: key.to_string(),
                    code: code.to_string(),
                    modifiers,
                    repeat: false,
                })),
            })
            .unwrap_or_else(|error| panic!("{key}/{code:?} refused: {error}"));
        assert_eq!(encoded, expected, "{key}/{code:?}");
    }
}

#[test]
fn exact_da_dsr_replies_are_collected_once_by_the_terminal_actor() {
    let mut actor = ProofActor::new(24, 80, 4096);
    let before_revision = actor.state_revision;
    let replies = actor.ingest(b"\x1b[2J\x1b[H\x1b[c\x1b[5n\x1b[6n");

    assert_eq!(
        replies, b"\x1b[?62;22c\x1b[0n\x1b[1;1R",
        "exact pin 47147324 declares VT220 conformance plus ANSI color"
    );
    assert_eq!(actor.output_seq, 1);
    assert_eq!(actor.state_revision, before_revision + 1);
    assert!(
        actor.ingest(b"provider output without a query").is_empty(),
        "synchronous reply ownership must drain each write exactly once"
    );
}

#[test]
fn startup_color_probe_has_no_embedder_reply_and_keeps_cursor_queries_live() {
    let mut actor = ProofActor::new(24, 80, 4096);
    assert_eq!(
        actor.ingest(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n"),
        b"\x1b[1;1R",
        "only the cursor query is answered; no embedder colors are advertised"
    );
}

#[test]
fn terminal_origin_colors_survive_restore_and_reset_to_unavailable() {
    let mut actor = ProofActor::new(24, 80, 4096);
    assert!(
        actor
            .ingest(b"\x1b]10;#abcdef\x1b\\\x1b]11;#123456\x1b\\")
            .is_empty()
    );
    let checkpoint = actor.terminal.checkpoint(1024 * 1024).unwrap();
    let mut restored = ProofActor::from_snapshot(&checkpoint.bytes);
    assert_eq!(
        restored.ingest(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\"),
        b"\x1b]10;rgb:abab/cdcd/efef\x1b\\\x1b]11;rgb:1212/3434/5656\x1b\\"
    );
    assert!(restored.ingest(b"\x1b]110\x1b\\\x1b]111\x1b\\").is_empty());
    assert_eq!(
        restored.ingest(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n"),
        b"\x1b[1;1R"
    );
}

#[test]
fn osc_title_reaches_viewport_metadata_and_marks_the_presentation_changed() {
    // Claude Code and Codex both name their session through OSC 0/2, and the
    // pane header reads it back from the viewport frame (a0c651978). The core
    // owns the title Ghostty already tracks, and a title-only write is a
    // presentation change — subscribers must not wait for the next repaint.
    let mut actor = ProofActor::new(24, 80, 4096);
    let write = actor
        .terminal
        .process(b"\x1b]0;Ship auth flow\x07")
        .expect("process an OSC 0 title");
    assert!(
        write.projection_changed,
        "a title change must publish a frame without waiting for a repaint"
    );
    assert_eq!(
        actor.terminal.viewport_metadata(0).expect("metadata").title,
        "Ship auth flow"
    );

    // OSC 2 with an ST terminator replaces it.
    actor
        .terminal
        .process(b"\x1b]2;Review flow\x1b\\")
        .expect("process an OSC 2 title");
    assert_eq!(
        actor.terminal.viewport_metadata(0).expect("metadata").title,
        "Review flow"
    );

    // An empty title clears it, and that is a change too.
    let cleared = actor
        .terminal
        .process(b"\x1b]0;\x07")
        .expect("process a title reset");
    assert!(cleared.projection_changed);
    assert_eq!(
        actor.terminal.viewport_metadata(0).expect("metadata").title,
        ""
    );

    // Unrelated output leaves the title alone.
    actor.terminal.process(b"hello\r\n").expect("process text");
    assert_eq!(
        actor.terminal.viewport_metadata(0).expect("metadata").title,
        ""
    );
}

#[test]
fn a_terminal_that_never_set_a_title_reports_an_empty_one() {
    let actor = ProofActor::new(24, 80, 4096);
    assert_eq!(
        actor.terminal.viewport_metadata(0).expect("metadata").title,
        ""
    );
    assert!(actor.terminal.core.observe().is_ok());
}

#[test]
fn a_snapshot_restored_clone_observes_without_a_title() {
    // The history-transfer path observes snapshot-restored clones, so a clone
    // must observe cleanly and report the same empty title a fresh live
    // terminal does — the title getter is on every observation's path now.
    let mut actor = ProofActor::new(24, 80, 4096);
    actor.terminal.process(b"hello\r\n").expect("process text");
    let bytes = actor
        .terminal
        .core
        .snapshot()
        .expect("snapshot the live core");
    let clone = Core::restore(&bytes).expect("restore a clone");
    assert!(
        clone.observe().is_ok(),
        "a restored clone must still observe"
    );
    assert_eq!(clone.presentation().expect("presentation").title, "");
}

#[test]
fn proof_reply_overflow_is_bounded_typed_and_does_not_poison_the_actor() {
    let mut actor = ProofActor::new(24, 80, 4096);
    let queries = b"\x1b[c".repeat(10_000);
    let mutation = actor.terminal.core.write(&queries).unwrap();

    assert!(mutation.reply_overflow);
    assert!(mutation.replies.len() <= 64 * 1024);
    let next = actor.terminal.core.write(b"\x1b[5n").unwrap();
    assert!(!next.reply_overflow);
    assert_eq!(next.replies, b"\x1b[0n");
}

#[test]
fn history_offer_is_retained_until_the_exact_cold_root_ack() {
    let mut adapter = GhosttyProofAdapter::new(4, 80, 4_096, 20_000, "transfer-terminal").unwrap();
    for batch_start in (0..5_001).step_by(500) {
        let mut output = String::new();
        for index in batch_start..usize::min(batch_start + 500, 5_001) {
            output.push_str(&format!("T{index:06}{}\r\n", "x".repeat(73)));
        }
        adapter.process(output.as_bytes()).unwrap();
    }
    let retained_before = adapter.retained_physical_rows();
    let offer = adapter.next_history_transfer_offer().unwrap().unwrap();
    let retained_bytes = adapter.retained_pending_history_bytes().unwrap();
    assert!(retained_bytes >= offer.canonical_encoded_bytes().unwrap());
    assert!(adapter.next_history_transfer_offer().unwrap() == Some(offer.clone()));

    let store = super::cold_history::ColdHistoryStore::open(
        super::cold_history::ColdHistoryIdentity::new("transfer-terminal", "cold-v1"),
        "transfer-terminal",
        super::cold_history::ColdHistoryLimits::default(),
        super::cold_history::InMemoryColdHistoryJournal::default(),
    )
    .unwrap();
    let acknowledgement = store.commit_offer(&offer).unwrap();
    let mut wrong = acknowledgement.clone();
    wrong.root_digest[0] ^= 1;
    assert_eq!(
        adapter.acknowledge_history_transfer(&wrong),
        Err(TerminalReplayError::ColdHistoryInvariant)
    );
    assert_eq!(adapter.retired_history_transfer_watermark().unwrap(), 0);
    assert!(adapter.next_history_transfer_offer().unwrap() == Some(offer));

    adapter
        .acknowledge_history_transfer(&acknowledgement)
        .unwrap();
    assert_eq!(adapter.retired_history_transfer_watermark().unwrap(), 1);
    assert!(adapter.retained_physical_rows() < retained_before);
    adapter
        .acknowledge_history_transfer(&acknowledgement)
        .unwrap();
}

#[test]
fn history_offer_ack_survives_canonical_reflow_before_publication() {
    let terminal_epoch = "reflow-during-native-prefix-commit";
    let mut adapter = GhosttyProofAdapter::new(4, 80, 4_096, 20_000, terminal_epoch).unwrap();
    for index in 0..5_001 {
        adapter
            .process(format!("T{index:06}{}\r\n", "x".repeat(73)).as_bytes())
            .unwrap();
    }
    let offer = adapter
        .next_history_transfer_offer()
        .unwrap()
        .expect("the bounded native prefix must be offered");
    let store = super::cold_history::ColdHistoryStore::open(
        super::cold_history::ColdHistoryIdentity::new(terminal_epoch, "cold-v1"),
        terminal_epoch,
        super::cold_history::ColdHistoryLimits::default(),
        super::cold_history::InMemoryColdHistoryJournal::default(),
    )
    .unwrap();
    let acknowledgement = store.commit_offer(&offer).unwrap();

    adapter.resize(4, 60).unwrap();
    let retained_after_reflow = adapter.retained_physical_rows();
    adapter
        .acknowledge_history_transfer(&acknowledgement)
        .unwrap();

    assert_eq!(adapter.retired_history_transfer_watermark().unwrap(), 1);
    assert!(adapter.retained_physical_rows() < retained_after_reflow);
    adapter.process(b"OUTPUT_AFTER_REFLOW_ACK\r\n").unwrap();
    assert!(
        adapter
            .screen_contents()
            .contains("OUTPUT_AFTER_REFLOW_ACK")
    );
}

#[test]
fn claude_alt_snapshot_roundtrip_retains_the_inactive_normal_screen() {
    let mut predecessor = ProofActor::new(12, 80, 4096);
    predecessor.ingest(b"NORMAL_HISTORY_MARKER\r\n");
    predecessor.ingest(b"\x1b[?1049h\x1b[HCLAUDE_ALT_MARKER");
    assert!(predecessor.terminal.alternate_screen());
    assert!(
        predecessor
            .terminal
            .screen_contents()
            .contains("CLAUDE_ALT_MARKER")
    );

    let snapshot = predecessor.terminal.snapshot();
    let mut successor = ProofActor::from_snapshot(&snapshot);
    assert!(successor.terminal.alternate_screen());
    successor.ingest(b"\x1b[?1049l");
    assert!(
        successor
            .terminal
            .screen_contents()
            .contains("NORMAL_HISTORY_MARKER"),
        "engine-native state must retain both normal and alternate screens"
    );
}

#[test]
fn unicode_osc8_cursor_and_modes_survive_one_canonical_projection() {
    let mut actor = ProofActor::new(8, 80, 4096);
    actor.ingest(
        "\x1b[?1h\x1b[?2004h\x1b[3;5H\x1b[1;38;2;12;34;56m한글 中 e\u{301} 👩‍💻\x1b[0m \
         \x1b]8;id=hmux;https://example.invalid/terminal\x1b\\link\x1b]8;;\x1b\\"
            .as_bytes(),
    );

    let plain = actor.terminal.screen_contents();
    let styled = actor.terminal.styled_contents();
    assert!(plain.contains("한글 中 e\u{301} 👩‍💻"));
    assert!(plain.contains("link"));
    let hyperlink = (0..8)
        .flat_map(|row| (0..80).map(move |column| (column, row)))
        .map(|(column, row)| actor.terminal.core.cell_hyperlink(column, row).unwrap())
        .find(|uri| !uri.is_empty())
        .expect("OSC 8 corpus must create a hyperlink cell");
    assert_eq!(
        hyperlink,
        b"https://example.invalid/terminal",
        "OSC 8 hyperlink identity must survive in the canonical cell table: {:?}",
        String::from_utf8_lossy(&styled),
    );
    assert!(actor.terminal.application_cursor());
    assert!(actor.terminal.bracketed_paste());
    assert_eq!(actor.terminal.cursor_position().0, 2);
}

#[test]
fn render_state_projection_copies_cells_styles_links_cursor_palette_and_modes() {
    let mut actor = ProofActor::new(8, 40, 4096);
    actor.ingest(
        "\x1b[?1h\x1b[?2004h\x1b[3;5H\x1b[1;4:3;38;2;12;34;56m한e\u{301}👩‍💻\x1b[0m \
         \x1b]8;id=hmux;https://example.invalid/projected\x1b\\link\x1b]8;;\x1b\\"
            .as_bytes(),
    );

    let projection = actor.terminal.core.project_active().unwrap();
    assert_eq!((projection.rows, projection.columns), (8, 40));
    assert_eq!((projection.cursor_row, projection.cursor_column), (2, 14));
    assert!(projection.cursor_visible);
    assert!(projection.application_cursor);
    assert!(projection.bracketed_paste);
    assert_eq!(projection.palette_rgb.len(), 256);
    let cells: Vec<_> = projection
        .projected_rows
        .iter()
        .flat_map(|row| &row.cells)
        .collect();
    assert!(
        cells
            .iter()
            .any(|cell| cell.text == "한" && cell.width == 2)
    );
    assert!(cells.iter().any(|cell| cell.text == "e\u{301}"));
    assert!(
        cells.iter().any(|cell| cell.text == "👩‍💻"),
        "projected graphemes: {:?}",
        cells
            .iter()
            .filter(|cell| !cell.text.is_empty())
            .map(|cell| (&cell.text, cell.width))
            .collect::<Vec<_>>()
    );
    let linked = cells
        .iter()
        .find(|cell| cell.text == "l")
        .expect("projected OSC 8 cell");
    assert_eq!(linked.style.hyperlink, "https://example.invalid/projected");
    assert!(cells.iter().any(|cell| {
        cell.style.foreground == terminal_core_ghostty_proof::ProjectedColor::Rgb(0x0c_22_38)
            && cell.style.flags & 1 != 0
    }));
}

#[test]
fn output_free_resize_advances_only_state_revision() {
    let mut actor = ProofActor::new(6, 40, 4096);
    actor.ingest(b"resize-only-state");
    let before_output_seq = actor.output_seq;
    let before_revision = actor.state_revision;

    assert!(actor.resize(9, 72).is_empty());
    assert_eq!(actor.output_seq, before_output_seq);
    assert_eq!(actor.state_revision, before_revision + 1);
    assert_eq!(actor.terminal.size(), (9, 72));
}

#[test]
fn proof_viewport_request_omits_history_and_preserves_active_screen() {
    let mut adapter = GhosttyProofAdapter::new(3, 20, 256, 20_000, "proof-terminal").unwrap();
    adapter
        .process(
            "one\r\ntwo\r\n\x1b[31m한e\u{301}\x1b[0m\r\nfour\r\nfive\x1b[3g\x1b[6G\x1bH\x1b[3;5H\x1b[?1h\x1b[?2004h\x1b[?25l"
                .as_bytes(),
        )
        .unwrap();

    let full = adapter
        .repaint(ScreenSnapshotProfile::Full, 1024 * 1024)
        .unwrap();
    let viewport = adapter
        .repaint(ScreenSnapshotProfile::ViewportOnly, 1024 * 1024)
        .unwrap();
    assert_eq!(
        viewport.actual_profile,
        Some(ScreenSnapshotProfile::ViewportOnly)
    );
    assert!(!String::from_utf8_lossy(&viewport.bytes).contains("one"));
    let mut full_parser = vt100::Parser::new(3, 20, 256);
    let mut viewport_parser = vt100::Parser::new(3, 20, 256);
    full_parser.process(&full.bytes);
    viewport_parser.process(
        b"\x1b[1;32mold cells that must disappear\r\nstale second line\r\nstale third line",
    );
    viewport_parser.process(&viewport.bytes);
    assert_eq!(
        viewport_parser.screen().contents_formatted(),
        full_parser.screen().contents_formatted()
    );
    assert_eq!(
        viewport_parser.screen().cursor_position(),
        full_parser.screen().cursor_position()
    );
    full_parser.process(b"\x1b[H\tT");
    viewport_parser.process(b"\x1b[H\tT");
    assert_eq!(
        viewport_parser.screen().contents_formatted(),
        full_parser.screen().contents_formatted(),
        "custom tabstops must survive the active snapshot"
    );
    assert!(!viewport.truncated);
    assert_eq!(
        adapter
            .repaint(ScreenSnapshotProfile::Full, 1024 * 1024)
            .unwrap()
            .bytes,
        full.bytes
    );
}

#[test]
fn proof_viewport_matches_canonical_cells_after_soft_wrap_and_resize() {
    let mut adapter = GhosttyProofAdapter::new(3, 20, 256, 20_000, "proof-terminal").unwrap();
    adapter
        .process("wrapped 한e\u{301} text ".repeat(40).as_bytes())
        .unwrap();
    for (rows, columns) in [(3, 20), (4, 13)] {
        adapter.resize(rows, columns).unwrap();
        let viewport = adapter
            .repaint(ScreenSnapshotProfile::ViewportOnly, 1024 * 1024)
            .unwrap();
        assert_eq!(
            viewport.actual_profile,
            Some(ScreenSnapshotProfile::ViewportOnly)
        );
        let canonical = adapter.core.project_active().unwrap();
        let mut actual = vt100::Parser::new(rows, columns, 256);
        actual.process(&viewport.bytes);
        for (row, expected_row) in canonical.projected_rows.iter().enumerate() {
            for (column, expected_cell) in expected_row.cells.iter().enumerate() {
                assert_eq!(
                    actual
                        .screen()
                        .cell(row as u16, column as u16)
                        .unwrap()
                        .contents()
                        .trim_end(),
                    expected_cell.text.trim_end(),
                    "cell {row}:{column} at {rows}x{columns}",
                );
            }
        }
        assert_eq!(
            actual.screen().cursor_position(),
            (canonical.cursor_row, canonical.cursor_column)
        );
    }
}

#[test]
fn proof_viewport_request_preserves_full_profile_without_omitted_history() {
    let mut adapter = GhosttyProofAdapter::new(3, 20, 256, 20_000, "proof-terminal").unwrap();
    for input in [b"current".as_slice(), b"\r\n1\r\n2\r\n3\x1b[?1049halt"] {
        adapter.process(input).unwrap();
        let full = adapter
            .repaint(ScreenSnapshotProfile::Full, 1024 * 1024)
            .unwrap();
        let viewport = adapter
            .repaint(ScreenSnapshotProfile::ViewportOnly, 1024 * 1024)
            .unwrap();
        assert_eq!(viewport.actual_profile, None);
        assert_eq!(viewport.bytes, full.bytes);
    }
}

#[test]
fn oversized_styled_repaint_falls_back_to_a_bounded_plain_terminal_redraw() {
    const ROWS: u16 = 256;
    const COLUMNS: u16 = 256;
    const MAXIMUM: usize = 700 * 1024;

    let mut adapter =
        GhosttyProofAdapter::new(ROWS, COLUMNS, 256, 20_000, "proof-terminal").unwrap();
    let mut corpus = String::with_capacity(2 * 1024 * 1024);
    corpus.push_str("\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l");
    for row in 1..=ROWS {
        corpus.push_str(&format!("\x1b[{row};1H"));
        for column in 1..=COLUMNS {
            corpus.push_str(&format!(
                "\x1b[38;2;{};{};{}mX",
                row % 255,
                column % 255,
                (row + column) % 255
            ));
        }
    }
    corpus.push_str("\x1b[77;63H");
    adapter.process(corpus.as_bytes()).unwrap();

    assert!(adapter.styled_contents().len() > MAXIMUM);
    let repaint = adapter
        .repaint(ScreenSnapshotProfile::Full, MAXIMUM)
        .expect("an oversized styled screen must still produce a bounded legacy redraw");

    assert!(repaint.truncated);
    assert!(repaint.bytes.len() <= MAXIMUM);
    assert_eq!(repaint.actual_profile, None);

    let mut restored = vt100::Parser::new(ROWS, COLUMNS, 256);
    restored.process(&repaint.bytes);
    let screen = restored.screen();
    assert!(screen.alternate_screen());
    assert!(screen.hide_cursor());
    assert!(screen.application_cursor());
    assert!(screen.bracketed_paste());
    assert_eq!(screen.cursor_position(), (76, 62));
    assert!(screen.contents().contains("XXXXXXXXXXXXXXXX"));
}

#[test]
fn codex_normal_history_uses_changed_rows_then_bounded_fallback() {
    let mut actor = ProofActor::new(8, 80, 256);
    let mut initial_corpus = String::from("\x1b[?2026h\r\nCodex: inspecting workspace\r\n");
    for row in 0..12 {
        initial_corpus.push_str(&format!("\x1b[32mtool {row:02} complete\x1b[0m\r\n"));
    }
    initial_corpus.push_str("\x1b[?2026l");
    actor.ingest(initial_corpus.as_bytes());
    assert_eq!(
        actor.terminal.last_projection.as_ref().unwrap().history,
        HistoryProjection::FullRebuild,
        "first history plan: {:?}; observation: {:?}",
        actor.terminal.last_projection,
        actor.terminal.core.observe().unwrap()
    );

    actor.ingest(b"bounded visible update");
    let visible = actor.terminal.last_projection.as_ref().unwrap();
    assert_eq!(visible.kind, ProjectionKind::Partial);
    assert!(
        visible.dirty_rows < 8,
        "the projector must identify fewer dirty rows than the viewport"
    );
    assert!(
        visible.visited_rows <= 8,
        "the proof row iterator must stay bounded to the viewport, not retained history"
    );

    let mut saw_bounded_fallback = false;
    for batch in 0..80 {
        let before = actor.terminal.core.observe().unwrap();
        let mut corpus = String::new();
        for row in 0..100 {
            corpus.push_str(&format!("CODEX_HISTORY_{batch:03}_{row:03}\r\n"));
        }
        actor.ingest(corpus.as_bytes());
        let after = actor.terminal.core.observe().unwrap();
        assert_eq!(
            actor.terminal.last_projection.as_ref().unwrap().history,
            HistoryProjection::FullRebuild
        );
        if after.total_rows < before.total_rows {
            saw_bounded_fallback = true;
            break;
        }
    }
    assert!(
        saw_bounded_fallback,
        "history projection must explicitly fall back when bounded pruning makes append arithmetic ambiguous"
    );

    let contents = actor.terminal.screen_contents();
    assert!(contents.contains("CODEX_HISTORY_"));
    assert!(
        !contents.contains("Codex: inspecting workspace"),
        "bounded Ghostty history must eventually prune the oldest normal-screen row"
    );
}

#[cfg(test)]
fn assert_full_cap_history_scroll_is_not_unchanged(label: &str, trigger: &[u8]) {
    let mut actor = ProofActor::new(3, 5, 2);
    let mut previous = actor.terminal.core.observe().unwrap();
    let mut pruned = false;
    for batch in 0..200 {
        let mut corpus = String::new();
        for row in 0..100 {
            corpus.push_str(&format!("{:04}\r\n", (batch * 100 + row) % 10_000));
        }
        actor.ingest(corpus.as_bytes());
        let current = actor.terminal.core.observe().unwrap();
        if current.total_rows < previous.total_rows {
            pruned = true;
            break;
        }
        previous = current;
    }
    assert!(pruned, "{label}: fixture did not cross a bounded prune");
    let before = actor.terminal.core.observe().unwrap();

    actor.ingest(trigger);

    let after = actor.terminal.core.observe().unwrap();
    assert!(
        after.total_rows <= before.total_rows + 1,
        "{label}: one scrolling operation must stay bounded: {before:?} -> {after:?}"
    );
    assert_eq!(
        actor.terminal.last_projection.as_ref().unwrap().history,
        HistoryProjection::FullRebuild,
        "{label}: a full-cap head move must never be reported as unchanged"
    );
}

#[test]
fn full_cap_autowrap_without_lf_falls_back_to_full_history() {
    assert_full_cap_history_scroll_is_not_unchanged("autowrap", b"\x1b[3;5HXY");
}

#[test]
fn full_cap_ind_without_lf_falls_back_to_full_history() {
    assert_full_cap_history_scroll_is_not_unchanged("IND", b"\x1b[3;1H\x1bD");
}

#[test]
fn full_cap_nel_without_lf_falls_back_to_full_history() {
    assert_full_cap_history_scroll_is_not_unchanged("NEL", b"\x1b[3;1H\x1bE");
}

#[test]
fn full_cap_csi_scroll_without_lf_falls_back_to_full_history() {
    assert_full_cap_history_scroll_is_not_unchanged("CSI S", b"\x1b[S");
}
