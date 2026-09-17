use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use terminal_state_protocol::{
    CellStyle, Grapheme, Hyperlink, RowTermination, TerminalCell, TerminalColorOverrides,
    TerminalRow, TerminalTables, UnderlineKind,
};

use super::TerminalReplayError;
use super::cold_history::{
    COLD_ROW_ID_MASK, ColdHistoryAnchor, ColdHistoryProjectionSource, HistoryBoundary,
    LogicalCellAnchor,
};
use super::viewport_source::{
    BoundedViewportRows, TerminalViewportAnchor, TerminalViewportMetrics, ViewportAnchorError,
    ViewportProjectionGeometry, ViewportProjectionWork, ViewportSource,
};

/// Cloneable bounded resolver at one captured Ghostty/cold-history boundary.
/// Logical anchors remain stable across acknowledged retirement and let one
/// existing ViewProjection cross the ownership seam without another parser.
///
/// Hot rows keep the high row-id bit clear. Composite cold rows reserve
/// that namespace so a merged frame can never contain a cross-owner id clash.
pub trait HotHistoryViewportSource: ViewportSource + Send + Sync {
    fn accounted_capture_bytes(&self) -> usize;

    fn hot_start_boundary(&self) -> Result<HistoryBoundary, TerminalReplayError>;

    fn resolve_hot_logical_anchor(
        &self,
        anchor: LogicalCellAnchor,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, ViewportAnchorError>;

    fn current_color_overrides(&self) -> Result<TerminalColorOverrides, TerminalReplayError>;
}

pub struct CompositeViewportSource {
    cold: Option<ColdHistoryProjectionSource>,
    hot: Arc<dyn HotHistoryViewportSource>,
}

impl CompositeViewportSource {
    pub(super) fn new(
        cold: Option<ColdHistoryProjectionSource>,
        hot: Arc<dyn HotHistoryViewportSource>,
    ) -> Self {
        Self { cold, hot }
    }

    pub(super) fn resolve_logical_anchor(
        &self,
        anchor: LogicalCellAnchor,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, ViewportAnchorError> {
        let include_cold = self.cold.is_some()
            && !self
                .hot
                .viewport_metrics()
                .map_err(ViewportAnchorError::unavailable)?
                .alternate_screen;
        let state = match self.hot.resolve_hot_logical_anchor(anchor, geometry) {
            Ok(resolved) => CompositeAnchorState::Hot {
                anchor: resolved,
                stable_anchor: Some(anchor),
            },
            Err(ViewportAnchorError::Pruned) if include_cold => CompositeAnchorState::Cold {
                anchor: self
                    .cold
                    .as_ref()
                    .ok_or(ViewportAnchorError::Pruned)?
                    .resolve_anchor(anchor)?,
            },
            Err(error) => return Err(error),
        };
        Ok(Box::new(CompositeViewportAnchor {
            cold: self.cold.clone(),
            hot: self.hot.clone(),
            include_cold,
            state: Mutex::new(state),
        }))
    }
}

impl ViewportSource for CompositeViewportSource {
    fn viewport_metrics(&self) -> Result<TerminalViewportMetrics, TerminalReplayError> {
        let hot = self.hot.viewport_metrics()?;
        Ok(TerminalViewportMetrics {
            // A width-neutral cold index cannot truthfully claim a physical
            // row extent before bounded on-demand wrapping at one geometry.
            total_rows: None,
            scrollback_rows: None,
            alternate_screen: hot.alternate_screen,
        })
    }

    fn track_tail_viewport_anchor(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, TerminalReplayError> {
        let include_cold = self.cold.is_some() && !self.hot.viewport_metrics()?.alternate_screen;
        let hot_anchor = self.hot.track_tail_viewport_anchor(geometry)?;
        Ok(Box::new(CompositeViewportAnchor {
            cold: self.cold.clone(),
            hot: self.hot.clone(),
            include_cold,
            state: Mutex::new(CompositeAnchorState::Hot {
                anchor: hot_anchor,
                stable_anchor: None,
            }),
        }))
    }
}

enum CompositeAnchorState {
    Hot {
        anchor: Box<dyn TerminalViewportAnchor>,
        stable_anchor: Option<LogicalCellAnchor>,
    },
    Cold {
        anchor: ColdHistoryAnchor,
    },
}

struct CompositeViewportAnchor {
    cold: Option<ColdHistoryProjectionSource>,
    hot: Arc<dyn HotHistoryViewportSource>,
    include_cold: bool,
    state: Mutex<CompositeAnchorState>,
}

impl CompositeViewportAnchor {
    fn cold(&self) -> Result<&ColdHistoryProjectionSource, ViewportAnchorError> {
        self.cold.as_ref().ok_or_else(|| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })
    }

    fn validate_seam(&self) -> Result<HistoryBoundary, ViewportAnchorError> {
        let cold = self
            .cold()?
            .visible_history_state()
            .end_boundary
            .clone()
            .ok_or_else(|| {
                ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
            })?;
        let hot = self
            .hot
            .hot_start_boundary()
            .map_err(ViewportAnchorError::unavailable)?;
        if cold != hot || cold.adjacent_anchor.is_none() {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            ));
        }
        Ok(cold)
    }

    fn hot_start_anchor(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<Box<dyn TerminalViewportAnchor>, ViewportAnchorError> {
        let boundary = self.validate_seam()?;
        match self.hot.resolve_hot_logical_anchor(
            boundary.adjacent_anchor.ok_or_else(|| {
                ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
            })?,
            geometry,
        ) {
            Err(ViewportAnchorError::Pruned) => Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            )),
            result => result,
        }
    }

    fn project_locked(
        &self,
        state: &mut CompositeAnchorState,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<BoundedViewportRows, ViewportAnchorError> {
        match state {
            CompositeAnchorState::Hot {
                anchor,
                stable_anchor,
            } => match anchor.project_rows(geometry) {
                Ok(mut rows) => {
                    validate_hot_row_ids(&rows)?;
                    *stable_anchor = Some(
                        rows.rows
                            .first()
                            .map(row_anchor)
                            .ok_or_else(invalid_projection)?,
                    );
                    let has_cold = if self.include_cold {
                        self.cold()?.visible_history_state().logical_line_count != 0
                    } else {
                        false
                    };
                    if has_cold {
                        let boundary = self.validate_seam()?;
                        if !rows.has_more_before {
                            validate_hot_boundary(&boundary, &rows)?;
                            rows.has_more_before = true;
                        }
                    }
                    Ok(rows)
                }
                Err(ViewportAnchorError::Pruned) => {
                    if !self.include_cold {
                        return Err(ViewportAnchorError::Pruned);
                    }
                    let stable = stable_anchor.ok_or(ViewportAnchorError::Pruned)?;
                    let cold = self.cold()?.resolve_anchor(stable)?;
                    *state = CompositeAnchorState::Cold { anchor: cold };
                    self.project_locked(state, geometry)
                }
                Err(error) => Err(error),
            },
            CompositeAnchorState::Cold { anchor } => {
                if !self.include_cold {
                    return Err(ViewportAnchorError::unavailable(
                        TerminalReplayError::ColdHistoryInvariant,
                    ));
                }
                let mut cold = anchor.project_rows(geometry)?;
                cold.color_overrides = self
                    .hot
                    .current_color_overrides()
                    .map_err(ViewportAnchorError::unavailable)?;
                if cold.rows.len() >= usize::from(geometry.viewport_rows) {
                    if !cold.has_more_after {
                        let boundary = self.validate_seam()?;
                        let hot = self.project_hot_start(geometry, 1, cold.visited_rows)?;
                        validate_hot_boundary(&boundary, &hot)?;
                        cold.has_more_after = true;
                        add_projection_work(&mut cold, &hot, geometry)?;
                    }
                    return Ok(cold);
                }
                if cold.has_more_after {
                    return Ok(cold);
                }
                let remaining = usize::from(geometry.viewport_rows) - cold.rows.len();
                let hot = self.project_hot_start(geometry, remaining, cold.visited_rows)?;
                validate_hot_boundary(&self.validate_seam()?, &hot)?;
                merge_viewport_rows(cold, hot, geometry)
            }
        }
    }

    fn project_hot_start(
        &self,
        geometry: &ViewportProjectionGeometry,
        viewport_rows: usize,
        already_visited: usize,
    ) -> Result<BoundedViewportRows, ViewportAnchorError> {
        let visit_budget = geometry
            .visit_budget
            .checked_sub(already_visited)
            .filter(|remaining| *remaining >= viewport_rows)
            .ok_or_else(|| {
                ViewportAnchorError::unavailable(
                    TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
                )
            })?;
        let rows =
            match self
                .hot_start_anchor(geometry)?
                .project_rows(&ViewportProjectionGeometry {
                    viewport_rows: u16::try_from(viewport_rows).map_err(|_| {
                        ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
                    })?,
                    visit_budget,
                    ..geometry.clone()
                }) {
                Err(ViewportAnchorError::Pruned) => {
                    return Err(ViewportAnchorError::unavailable(
                        TerminalReplayError::ColdHistoryInvariant,
                    ));
                }
                result => result?,
            };
        validate_hot_row_ids(&rows)?;
        Ok(rows)
    }
}

impl TerminalViewportAnchor for CompositeViewportAnchor {
    fn move_rows(
        &mut self,
        delta: i64,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<i64, ViewportAnchorError> {
        if delta == 0 {
            return Ok(0);
        }
        let mut state = self.state.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
        match &mut *state {
            CompositeAnchorState::Hot {
                anchor,
                stable_anchor,
            } => {
                let moved = match anchor.move_rows(delta, geometry) {
                    Ok(moved) => moved,
                    Err(ViewportAnchorError::Pruned) => {
                        if !self.include_cold {
                            return Err(ViewportAnchorError::Pruned);
                        }
                        let stable = stable_anchor.ok_or(ViewportAnchorError::Pruned)?;
                        let mut cold = self.cold()?.resolve_anchor(stable)?;
                        let moved = cold.move_rows(delta, geometry)?;
                        if delta > 0 && cold.logical_anchor().is_none() {
                            let mut hot = self.hot_start_anchor(geometry)?;
                            let remainder = delta.saturating_sub(moved);
                            let hot_moved = hot.move_rows(remainder, geometry)?;
                            let stable_anchor = projected_hot_anchor(hot.as_ref(), geometry)?;
                            *state = CompositeAnchorState::Hot {
                                anchor: hot,
                                stable_anchor: Some(stable_anchor),
                            };
                            return Ok(moved.saturating_add(hot_moved));
                        }
                        *state = CompositeAnchorState::Cold { anchor: cold };
                        return Ok(moved);
                    }
                    Err(error) => return Err(error),
                };
                if delta >= 0 || moved == delta {
                    *stable_anchor = Some(projected_hot_anchor(anchor.as_ref(), geometry)?);
                    return Ok(moved);
                }
                if !self.include_cold {
                    *stable_anchor = Some(projected_hot_anchor(anchor.as_ref(), geometry)?);
                    return Ok(moved);
                }
                if self.cold()?.visible_history_state().logical_line_count == 0 {
                    *stable_anchor = Some(projected_hot_anchor(anchor.as_ref(), geometry)?);
                    return Ok(moved);
                }
                self.validate_seam()?;
                let mut cold = self.cold()?.tail_anchor();
                let remainder = delta.saturating_sub(moved);
                let cold_moved = cold.move_rows(remainder, geometry)?;
                if cold_moved != 0 {
                    *state = CompositeAnchorState::Cold { anchor: cold };
                }
                Ok(moved.saturating_add(cold_moved))
            }
            CompositeAnchorState::Cold { anchor } => {
                let moved = anchor.move_rows(delta, geometry)?;
                if delta <= 0 || anchor.logical_anchor().is_some() {
                    return Ok(moved);
                }
                let mut hot = self.hot_start_anchor(geometry)?;
                let remainder = delta.saturating_sub(moved);
                let hot_moved = hot.move_rows(remainder, geometry)?;
                let stable_anchor = projected_hot_anchor(hot.as_ref(), geometry)?;
                *state = CompositeAnchorState::Hot {
                    anchor: hot,
                    stable_anchor: Some(stable_anchor),
                };
                Ok(moved.saturating_add(hot_moved))
            }
        }
    }

    fn project_rows(
        &self,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<BoundedViewportRows, ViewportAnchorError> {
        let mut state = self.state.lock().map_err(|_| {
            ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
        })?;
        self.project_locked(&mut state, geometry)
    }
}

fn projected_hot_anchor(
    anchor: &dyn TerminalViewportAnchor,
    geometry: &ViewportProjectionGeometry,
) -> Result<LogicalCellAnchor, ViewportAnchorError> {
    anchor
        .project_rows(geometry)?
        .rows
        .first()
        .map(row_anchor)
        .ok_or_else(invalid_projection)
}

fn row_anchor(row: &TerminalRow) -> LogicalCellAnchor {
    LogicalCellAnchor {
        logical_line_id: row.logical_line_id,
        logical_cell_offset: row.logical_cell_offset,
    }
}

fn validate_hot_boundary(
    boundary: &HistoryBoundary,
    hot: &BoundedViewportRows,
) -> Result<(), ViewportAnchorError> {
    if hot.rows.first().map(row_anchor) != boundary.adjacent_anchor {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(())
}

fn validate_hot_row_ids(hot: &BoundedViewportRows) -> Result<(), ViewportAnchorError> {
    if hot
        .rows
        .iter()
        .any(|row| row.row_id & COLD_ROW_ID_MASK != 0)
    {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(())
}

fn merge_viewport_rows(
    cold: BoundedViewportRows,
    hot: BoundedViewportRows,
    geometry: &ViewportProjectionGeometry,
) -> Result<BoundedViewportRows, ViewportAnchorError> {
    let mut tables = FrameTableMerger::new();
    let cold_count = cold.rows.len();
    let mut rows = tables.rows(&cold.rows, &cold.tables)?;
    rows.extend(tables.rows(&hot.rows, &hot.tables)?);
    if rows.is_empty() || rows.len() > usize::from(geometry.viewport_rows) {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    for pair in rows.windows(2) {
        validate_row_adjacency(&pair[0], &pair[1])?;
    }
    let cursor = hot.cursor.and_then(|(row, column)| {
        u16::try_from(cold_count)
            .ok()
            .and_then(|offset| row.checked_add(offset))
            .map(|row| (row, column))
    });
    let visited_rows = cold.visited_rows.saturating_add(hot.visited_rows);
    if visited_rows > geometry.visit_budget {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
        ));
    }
    Ok(BoundedViewportRows {
        visited_rows,
        has_more_before: cold.has_more_before,
        has_more_after: hot.has_more_after,
        color_overrides: hot.color_overrides,
        cursor,
        work: ViewportProjectionWork {
            index_nodes_visited: cold
                .work
                .index_nodes_visited
                .saturating_add(hot.work.index_nodes_visited),
            chunks_visited: cold
                .work
                .chunks_visited
                .saturating_add(hot.work.chunks_visited),
            cells_visited: cold
                .work
                .cells_visited
                .saturating_add(hot.work.cells_visited),
        },
        rows,
        tables: tables.finish(),
    })
}

fn add_projection_work(
    target: &mut BoundedViewportRows,
    additional: &BoundedViewportRows,
    geometry: &ViewportProjectionGeometry,
) -> Result<(), ViewportAnchorError> {
    target.visited_rows = target.visited_rows.saturating_add(additional.visited_rows);
    if target.visited_rows > geometry.visit_budget {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
        ));
    }
    target.work.index_nodes_visited = target
        .work
        .index_nodes_visited
        .saturating_add(additional.work.index_nodes_visited);
    target.work.chunks_visited = target
        .work
        .chunks_visited
        .saturating_add(additional.work.chunks_visited);
    target.work.cells_visited = target
        .work
        .cells_visited
        .saturating_add(additional.work.cells_visited);
    Ok(())
}

fn validate_row_adjacency(
    previous: &TerminalRow,
    next: &TerminalRow,
) -> Result<(), ViewportAnchorError> {
    if previous.logical_line_id == next.logical_line_id {
        let expected = previous
            .logical_cell_offset
            .checked_add(previous.logical_cell_span)
            .ok_or_else(|| {
                ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
            })?;
        if next.logical_cell_offset != expected
            || !next.continues_from_previous
            || previous.termination != RowTermination::SoftWrap as i32
        {
            return Err(ViewportAnchorError::unavailable(
                TerminalReplayError::ColdHistoryInvariant,
            ));
        }
    } else if next.logical_cell_offset != 0
        || next.continues_from_previous
        || previous.termination != RowTermination::HardBreak as i32
    {
        return Err(ViewportAnchorError::unavailable(
            TerminalReplayError::ColdHistoryInvariant,
        ));
    }
    Ok(())
}

struct FrameTableMerger {
    graphemes: Vec<Grapheme>,
    grapheme_indices: HashMap<Grapheme, u32>,
    styles: Vec<CellStyle>,
    style_indices: HashMap<CellStyle, u32>,
    hyperlinks: Vec<Hyperlink>,
    hyperlink_indices: HashMap<Hyperlink, u32>,
}

impl FrameTableMerger {
    fn new() -> Self {
        Self {
            graphemes: Vec::new(),
            grapheme_indices: HashMap::new(),
            styles: Vec::new(),
            style_indices: HashMap::new(),
            hyperlinks: Vec::new(),
            hyperlink_indices: HashMap::new(),
        }
    }

    fn rows(
        &mut self,
        rows: &[TerminalRow],
        source: &TerminalTables,
    ) -> Result<Vec<TerminalRow>, ViewportAnchorError> {
        rows.iter()
            .map(|row| {
                let mut row = row.clone();
                row.cells = row
                    .cells
                    .iter()
                    .map(|cell| self.cell(cell, source))
                    .collect::<Result<_, _>>()?;
                Ok(row)
            })
            .collect()
    }

    fn cell(
        &mut self,
        cell: &TerminalCell,
        source: &TerminalTables,
    ) -> Result<TerminalCell, ViewportAnchorError> {
        let grapheme = source
            .graphemes
            .get(cell.grapheme_index as usize)
            .ok_or_else(invalid_projection)?;
        let grapheme_index =
            table_index(&mut self.graphemes, &mut self.grapheme_indices, grapheme)?;
        let mut style = *source
            .styles
            .get(cell.style_index as usize)
            .ok_or_else(invalid_projection)?;
        style.hyperlink_index = if style.hyperlink_index == 0 {
            0
        } else {
            let hyperlink = source
                .hyperlinks
                .get(style.hyperlink_index as usize - 1)
                .ok_or_else(invalid_projection)?;
            table_index(&mut self.hyperlinks, &mut self.hyperlink_indices, hyperlink)?
                .checked_add(1)
                .ok_or_else(invalid_projection)?
        };
        let style_index = table_index(&mut self.styles, &mut self.style_indices, &style)?;
        Ok(TerminalCell {
            grapheme_index,
            style_index,
        })
    }

    fn finish(mut self) -> TerminalTables {
        if self.graphemes.is_empty() {
            self.graphemes.push(Grapheme {
                text: String::new(),
                display_width: 0,
            });
        }
        if self.styles.is_empty() {
            self.styles.push(CellStyle {
                underline: UnderlineKind::None as i32,
                ..CellStyle::default()
            });
        }
        TerminalTables {
            graphemes: self.graphemes,
            styles: self.styles,
            hyperlinks: self.hyperlinks,
        }
    }
}

fn table_index<T: Clone + Eq + Hash>(
    values: &mut Vec<T>,
    indices: &mut HashMap<T, u32>,
    value: &T,
) -> Result<u32, ViewportAnchorError> {
    if let Some(index) = indices.get(value) {
        return Ok(*index);
    }
    let index = u32::try_from(values.len()).map_err(|_| invalid_projection())?;
    values.push(value.clone());
    indices.insert(value.clone(), index);
    Ok(index)
}

fn invalid_projection() -> ViewportAnchorError {
    ViewportAnchorError::unavailable(TerminalReplayError::ColdHistoryInvariant)
}
