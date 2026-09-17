use terminal_state_protocol::{
    TerminalColorOverrides, TerminalRow, TerminalTables, UnicodeWidthProfile,
};

use super::TerminalReplayError;

const VIEWPORT_VISIT_GUARD_ROWS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TerminalViewportMetrics {
    pub total_rows: Option<usize>,
    pub scrollback_rows: Option<usize>,
    pub alternate_screen: bool,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct ViewportProjectionGeometry {
    pub columns: u16,
    pub viewport_rows: u16,
    pub terminal_revision: u64,
    pub unicode_width: UnicodeWidthProfile,
    pub visit_budget: usize,
}

impl ViewportProjectionGeometry {
    pub(super) fn new(
        columns: u16,
        viewport_rows: u16,
        terminal_revision: u64,
        unicode_width: UnicodeWidthProfile,
    ) -> Self {
        Self {
            columns,
            viewport_rows,
            terminal_revision,
            unicode_width,
            visit_budget: usize::from(viewport_rows).saturating_add(VIEWPORT_VISIT_GUARD_ROWS),
        }
    }
}

pub(super) enum ViewportAnchorError {
    Pruned,
    Unavailable(TerminalReplayError),
}

impl ViewportAnchorError {
    pub(super) fn unavailable(error: TerminalReplayError) -> Self {
        Self::Unavailable(error)
    }

    pub(super) fn into_terminal_error(self) -> TerminalReplayError {
        match self {
            Self::Pruned => TerminalReplayError::InvalidStructuredProjection {
                // Shared by every anchor operation, so it must not name one of
                // them: pruning is what happened, whatever was being attempted.
                reason: "viewport source rows were pruned out from under the projection",
            },
            Self::Unavailable(error) => error,
        }
    }
}

pub(super) trait TerminalViewportAnchor: Send {
    fn move_rows(
        &mut self,
        delta: i64,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<i64, ViewportAnchorError>;

    fn project_rows(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<BoundedViewportRows, ViewportAnchorError>;
}

/// Canonical source for one attachment's bounded viewport.
///
/// The initial implementation delegates to the terminal core. A composite
/// cold/hot owner implements this trait without changing `ViewProjection`.
pub(super) trait ViewportSource: Send {
    fn viewport_metrics(&self) -> Result<TerminalViewportMetrics, TerminalReplayError>;

    fn track_tail_viewport_anchor(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, TerminalReplayError>;
}

/// One complete, bounded viewport extracted from a canonical row source.
///
/// The source may span multiple disjoint backing stores. In particular, a
/// future cold-history store and a bounded hot terminal can implement one
/// tracked anchor without moving canonical ownership into the projection.
/// Callers must never infer total-history size from this bounded result.
pub(super) struct BoundedViewportRows {
    pub rows: Vec<TerminalRow>,
    pub tables: TerminalTables,
    pub visited_rows: usize,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub color_overrides: TerminalColorOverrides,
    pub cursor: Option<(u16, u16)>,
    pub work: ViewportProjectionWork,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct ViewportProjectionWork {
    pub index_nodes_visited: usize,
    pub chunks_visited: usize,
    pub cells_visited: usize,
}
