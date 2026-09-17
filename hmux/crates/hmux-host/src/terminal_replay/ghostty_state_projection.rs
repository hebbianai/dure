use super::TerminalReplayError;
use super::cold_history::{LogicalCellAnchor, cold_row_id};
use super::viewport_source::{BoundedViewportRows, ViewportProjectionWork};
use std::collections::HashMap;
use terminal_core_ghostty_proof::{
    Core, NativeHistoryProjection, Presentation, ProjectedColor, ProjectedColorOverrides,
    ProjectedRow, ProjectedStyle,
};
use terminal_state_protocol::{
    BufferId, BufferState, CellStyle, ColorKind, CursorShape, CursorState, Grapheme, HistoryAnchor,
    Hyperlink, IndexedColorOverride, InputModes, MouseEncoding, MouseTrackingMode, RowTermination,
    StateSnapshot, TerminalCell, TerminalColor, TerminalColorOverrides, TerminalMediaSupport,
    TerminalPalette, TerminalRow, TerminalTables, UnderlineKind, UnicodeWidthProfile,
};

pub(super) fn viewport_metadata(
    core: &Core,
    through_event_id: u64,
) -> Result<StateSnapshot, TerminalReplayError> {
    let presentation = core
        .presentation()
        .map_err(|error| engine_error("capture viewport metadata", error.0))?;
    let active_buffer = if presentation.alternate_screen {
        BufferId::Alternate
    } else {
        BufferId::Normal
    };
    let buffer = |active: bool| BufferState {
        rows: Vec::new(),
        cursor: Some(CursorState {
            row: u32::from(
                presentation
                    .cursor_row
                    .min(presentation.rows.saturating_sub(1)),
            ),
            column: u32::from(
                presentation
                    .cursor_column
                    .min(presentation.columns.saturating_sub(1)),
            ),
            style_index: 0,
            visible: active && presentation.cursor_visible,
            shape: cursor_shape(presentation.cursor_shape),
            blinking: presentation.cursor_blinking,
            wrap_pending: presentation.cursor_wrap_pending,
        }),
        scroll_top: 0,
        scroll_bottom: u32::from(presentation.rows.saturating_sub(1)),
    };
    Ok(StateSnapshot {
        columns: u32::from(presentation.columns),
        rows: u32::from(presentation.rows),
        active_buffer: active_buffer as i32,
        normal_buffer: Some(buffer(active_buffer == BufferId::Normal)),
        alternate_buffer: Some(buffer(active_buffer == BufferId::Alternate)),
        history: Some(HistoryAnchor::default()),
        tables: Some(TerminalTables::default()),
        history_truncated: true,
        palette: Some(TerminalPalette {
            indexed_rgb: presentation.palette_rgb.clone(),
            default_foreground_rgb: presentation.foreground_rgb,
            default_background_rgb: presentation.background_rgb,
            cursor_rgb: presentation.cursor_rgb,
            selection_background_rgb: presentation.background_rgb,
        }),
        title: presentation.title.clone(),
        input_modes: Some(presentation_input_modes(&presentation)),
        unicode_width: Some(UnicodeWidthProfile {
            unicode_version: "ghostty-pin-47147324".to_string(),
            ambiguous_width: 1,
            emoji_width: 2,
        }),
        through_event_id,
        working_directory_uri: String::new(),
        media_support: TerminalMediaSupport::Unsupported as i32,
    })
}

pub(super) fn structured_viewport_rows(
    rows: &[ProjectedRow],
    has_more_before: bool,
    has_more_after: bool,
    cursor: Option<(u16, u16)>,
    logical_anchor: LogicalCellAnchor,
    color_overrides: ProjectedColorOverrides,
) -> Result<BoundedViewportRows, TerminalReplayError> {
    let mut tables = TableBuilder::new();
    let visited_rows = rows.len();
    let rows = tables.anchored_rows(rows, logical_anchor)?;
    let cells_visited = rows.iter().map(|row| row.cells.len()).sum();
    let chunks_visited = usize::from(!rows.is_empty());
    Ok(BoundedViewportRows {
        rows,
        tables: tables.finish(),
        visited_rows,
        has_more_before,
        has_more_after,
        color_overrides: terminal_color_overrides(color_overrides),
        cursor,
        work: ViewportProjectionWork {
            index_nodes_visited: visited_rows,
            chunks_visited,
            cells_visited,
        },
    })
}

pub(super) fn terminal_color_overrides(
    color_overrides: ProjectedColorOverrides,
) -> TerminalColorOverrides {
    TerminalColorOverrides {
        indexed: color_overrides
            .indexed
            .into_iter()
            .map(|entry| IndexedColorOverride {
                index: u32::from(entry.index),
                rgb: entry.rgb,
            })
            .collect(),
        default_foreground_rgb: color_overrides.default_foreground_rgb,
        default_background_rgb: color_overrides.default_background_rgb,
        cursor_rgb: color_overrides.cursor_rgb,
    }
}

pub(super) fn native_history_viewport_rows(
    projection: NativeHistoryProjection,
) -> Result<BoundedViewportRows, TerminalReplayError> {
    let mut tables = TableBuilder::new();
    let mut rows = Vec::with_capacity(projection.rows.len());
    for native in projection.rows {
        let mut row = native.row;
        if !row.wraps {
            while row.cells.last().is_some_and(is_default_blank) {
                row.cells.pop();
            }
        }
        let (cells, span) = tables.cells(&row)?;
        let anchor = LogicalCellAnchor {
            logical_line_id: native.anchor.logical_line_id,
            logical_cell_offset: native.anchor.logical_cell_offset,
        };
        if anchor.logical_line_id == 0 {
            return Err(TerminalReplayError::ColdHistoryInvariant);
        }
        rows.push(TerminalRow {
            row_id: cold_row_id(anchor, span, projection.columns),
            continues_from_previous: anchor.logical_cell_offset > 0,
            cells,
            termination: if row.wraps {
                RowTermination::SoftWrap
            } else {
                RowTermination::HardBreak
            } as i32,
            logical_line_id: anchor.logical_line_id,
            logical_cell_offset: anchor.logical_cell_offset,
            logical_cell_span: span,
        });
    }
    let visited_rows = rows.len();
    Ok(BoundedViewportRows {
        rows,
        tables: tables.finish(),
        visited_rows,
        has_more_before: projection.has_more_before,
        has_more_after: projection.has_more_after,
        color_overrides: TerminalColorOverrides::default(),
        cursor: None,
        work: ViewportProjectionWork {
            index_nodes_visited: projection.work.index_nodes_visited,
            chunks_visited: projection.work.chunks_visited,
            cells_visited: projection.work.cells_visited,
        },
    })
}

fn is_default_blank(cell: &terminal_core_ghostty_proof::ProjectedCell) -> bool {
    is_canonical_blank_grapheme(cell) && is_default_style(&cell.style)
}

fn is_canonical_blank_grapheme(cell: &terminal_core_ghostty_proof::ProjectedCell) -> bool {
    (cell.text.is_empty() || cell.text == " ") && cell.width == 1
}

fn is_default_style(style: &ProjectedStyle) -> bool {
    style.foreground == ProjectedColor::Default
        && style.background == ProjectedColor::Default
        && style.underline_color == ProjectedColor::Default
        && style.flags == 0
        && style.underline == 0
        && style.hyperlink.is_empty()
}

struct TableBuilder {
    graphemes: Vec<Grapheme>,
    grapheme_indices: HashMap<(String, u8), u32>,
    styles: Vec<CellStyle>,
    style_indices: HashMap<ProjectedStyle, u32>,
    hyperlinks: Vec<Hyperlink>,
    hyperlink_indices: HashMap<String, u32>,
    #[cfg(test)]
    grapheme_hash_lookups: usize,
    #[cfg(test)]
    style_hash_lookups: usize,
}

impl TableBuilder {
    fn new() -> Self {
        let default_style = ProjectedStyle {
            foreground: ProjectedColor::Default,
            background: ProjectedColor::Default,
            underline_color: ProjectedColor::Default,
            flags: 0,
            underline: 0,
            hyperlink: String::new(),
        };
        Self {
            graphemes: vec![Grapheme {
                text: " ".to_string(),
                display_width: 1,
            }],
            grapheme_indices: HashMap::from([((" ".to_string(), 1), 0)]),
            styles: vec![cell_style(&default_style, 0)],
            style_indices: HashMap::from([(default_style, 0)]),
            hyperlinks: Vec::new(),
            hyperlink_indices: HashMap::new(),
            #[cfg(test)]
            grapheme_hash_lookups: 0,
            #[cfg(test)]
            style_hash_lookups: 0,
        }
    }

    fn anchored_rows(
        &mut self,
        rows: &[ProjectedRow],
        first_anchor: LogicalCellAnchor,
    ) -> Result<Vec<TerminalRow>, TerminalReplayError> {
        let mut projected = Vec::with_capacity(rows.len());
        let mut line_id = first_anchor.logical_line_id;
        let mut logical_offset = first_anchor.logical_cell_offset;
        for (index, row) in rows.iter().enumerate() {
            if index > 0 && !row_continues(rows, index) {
                line_id = line_id
                    .checked_add(1)
                    .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
                logical_offset = 0;
            }
            let (cells, span) = self.cells(row)?;
            projected.push(TerminalRow {
                row_id: stable_hot_row_id(line_id, logical_offset)?,
                continues_from_previous: logical_offset > 0,
                cells,
                termination: row_termination(rows, index) as i32,
                logical_line_id: line_id,
                logical_cell_offset: logical_offset,
                logical_cell_span: span,
            });
            logical_offset = logical_offset
                .checked_add(span)
                .ok_or(TerminalReplayError::ColdHistoryInvariant)?;
        }
        Ok(projected)
    }

    fn cells(
        &mut self,
        row: &ProjectedRow,
    ) -> Result<(Vec<TerminalCell>, u32), TerminalReplayError> {
        let mut cells = Vec::with_capacity(row.cells.len());
        let mut span = 0_u32;
        let mut previous_style: Option<(&ProjectedStyle, u32)> = None;
        for cell in &row.cells {
            let grapheme_index = if is_canonical_blank_grapheme(cell) {
                0
            } else {
                let text = cell.text.clone();
                let key = (text.clone(), cell.width);
                #[cfg(test)]
                {
                    self.grapheme_hash_lookups += 1;
                }
                if let Some(index) = self.grapheme_indices.get(&key) {
                    *index
                } else {
                    let index = u32::try_from(self.graphemes.len())
                        .map_err(|_| engine_error("allocate grapheme table", -100))?;
                    self.graphemes.push(Grapheme {
                        text,
                        display_width: u32::from(cell.width),
                    });
                    self.grapheme_indices.insert(key, index);
                    index
                }
            };
            let style_index = match previous_style {
                Some((style, index)) if style == &cell.style => index,
                _ => self.style(&cell.style)?,
            };
            previous_style = Some((&cell.style, style_index));
            cells.push(TerminalCell {
                grapheme_index,
                style_index,
            });
            span = span
                .checked_add(u32::from(cell.width))
                .ok_or_else(|| engine_error("measure projected row", -100))?;
        }
        Ok((cells, span))
    }

    fn style(&mut self, style: &ProjectedStyle) -> Result<u32, TerminalReplayError> {
        if is_default_style(style) {
            return Ok(0);
        }
        #[cfg(test)]
        {
            self.style_hash_lookups += 1;
        }
        if let Some(index) = self.style_indices.get(style) {
            return Ok(*index);
        }
        let hyperlink_index = if style.hyperlink.is_empty() {
            0
        } else if let Some(index) = self.hyperlink_indices.get(&style.hyperlink) {
            *index
        } else {
            let index = u32::try_from(self.hyperlinks.len() + 1)
                .map_err(|_| engine_error("allocate hyperlink table", -100))?;
            self.hyperlinks.push(Hyperlink {
                uri: style.hyperlink.clone(),
                params: String::new(),
            });
            self.hyperlink_indices
                .insert(style.hyperlink.clone(), index);
            index
        };
        let index = u32::try_from(self.styles.len())
            .map_err(|_| engine_error("allocate style table", -100))?;
        self.styles.push(cell_style(style, hyperlink_index));
        self.style_indices.insert(style.clone(), index);
        Ok(index)
    }

    fn finish(self) -> TerminalTables {
        TerminalTables {
            graphemes: self.graphemes,
            styles: self.styles,
            hyperlinks: self.hyperlinks,
        }
    }
}

fn stable_hot_row_id(
    logical_line_id: u64,
    logical_cell_offset: u32,
) -> Result<u64, TerminalReplayError> {
    const LOGICAL_CELL_OFFSET_LIMIT: u32 = 1 << 20;

    if logical_cell_offset >= LOGICAL_CELL_OFFSET_LIMIT {
        return Err(TerminalReplayError::ColdHistoryInvariant);
    }
    logical_line_id
        .checked_mul(1 << 20)
        .and_then(|base| base.checked_add(u64::from(logical_cell_offset)))
        .and_then(|value| value.checked_add(1))
        .filter(|value| value & (1 << 63) == 0)
        .ok_or(TerminalReplayError::ColdHistoryInvariant)
}

pub(super) fn row_continues(rows: &[ProjectedRow], index: usize) -> bool {
    let row = &rows[index];
    index == 0 && row.continues || index > 0 && rows[index - 1].wraps && row.continues
}

fn row_termination(rows: &[ProjectedRow], index: usize) -> RowTermination {
    let row = &rows[index];
    if row.wraps && rows.get(index + 1).is_none_or(|next| next.continues) {
        RowTermination::SoftWrap
    } else {
        RowTermination::HardBreak
    }
}

fn cell_style(style: &ProjectedStyle, hyperlink_index: u32) -> CellStyle {
    CellStyle {
        foreground: terminal_color(&style.foreground),
        background: terminal_color(&style.background),
        underline_color: terminal_color(&style.underline_color),
        flags: u64::from(style.flags),
        underline: match style.underline {
            1 => UnderlineKind::Single,
            2 => UnderlineKind::Double,
            3 => UnderlineKind::Curly,
            4 => UnderlineKind::Dotted,
            5 => UnderlineKind::Dashed,
            _ => UnderlineKind::None,
        } as i32,
        hyperlink_index,
    }
}

fn terminal_color(color: &ProjectedColor) -> Option<TerminalColor> {
    match color {
        ProjectedColor::Default => None,
        ProjectedColor::Palette(value) => Some(TerminalColor {
            kind: ColorKind::Palette as i32,
            value: u32::from(*value),
        }),
        ProjectedColor::Rgb(value) => Some(TerminalColor {
            kind: ColorKind::Rgb as i32,
            value: *value,
        }),
    }
}

fn cursor_shape(shape: u8) -> i32 {
    (match shape {
        0 => CursorShape::Bar,
        2 => CursorShape::Underline,
        _ => CursorShape::Block,
    }) as i32
}

fn presentation_input_modes(presentation: &Presentation) -> InputModes {
    InputModes {
        application_cursor_keys: presentation.application_cursor,
        application_keypad: presentation.application_keypad,
        bracketed_paste: presentation.bracketed_paste,
        focus_reporting: presentation.focus_reporting,
        mouse_tracking: (match presentation.mouse_tracking {
            1 => MouseTrackingMode::X10,
            2 => MouseTrackingMode::Button,
            3 => MouseTrackingMode::Any,
            _ => MouseTrackingMode::None,
        }) as i32,
        mouse_encoding: (match presentation.mouse_encoding {
            2 => MouseEncoding::Utf8,
            3 => MouseEncoding::Sgr,
            4 => MouseEncoding::Urxvt,
            5 => MouseEncoding::PixelSgr,
            _ => MouseEncoding::Default,
        }) as i32,
        insert: presentation.insert_mode,
        origin: presentation.origin_mode,
        auto_wrap: presentation.auto_wrap,
        newline: presentation.newline_mode,
        reverse_wraparound: presentation.reverse_wrap,
        synchronized_output: presentation.synchronized_output,
    }
}

fn engine_error(operation: &'static str, code: i32) -> TerminalReplayError {
    TerminalReplayError::TerminalEngineFailure { operation, code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_core_ghostty_proof::{ProjectedCell, ProjectedRow};

    fn row(text: &str, wraps: bool, continues: bool) -> ProjectedRow {
        ProjectedRow {
            wraps,
            continues,
            cells: vec![ProjectedCell {
                text: text.to_string(),
                width: 1,
                style: ProjectedStyle {
                    foreground: ProjectedColor::Default,
                    background: ProjectedColor::Default,
                    underline_color: ProjectedColor::Default,
                    flags: 0,
                    underline: 0,
                    hyperlink: String::new(),
                },
            }],
        }
    }

    #[test]
    fn projects_live_wrap_flags_by_the_following_row_boundary() {
        let rows = vec![
            row("a", true, false),
            row("b", true, true),
            row("c", false, false),
        ];
        let mut tables = TableBuilder::new();
        let projected = tables
            .anchored_rows(
                &rows,
                LogicalCellAnchor {
                    logical_line_id: 10,
                    logical_cell_offset: 0,
                },
            )
            .unwrap();

        assert_eq!(projected[0].termination, RowTermination::SoftWrap as i32);
        assert_eq!(projected[1].termination, RowTermination::HardBreak as i32);
        assert_eq!(projected[0].logical_line_id, projected[1].logical_line_id);
        assert_ne!(projected[1].logical_line_id, projected[2].logical_line_id);
    }

    #[test]
    fn canonical_default_cells_skip_table_hash_lookups() {
        const ROWS: usize = 80;
        const COLUMNS: usize = 160;

        let default_style = ProjectedStyle {
            foreground: ProjectedColor::Default,
            background: ProjectedColor::Default,
            underline_color: ProjectedColor::Default,
            flags: 0,
            underline: 0,
            hyperlink: String::new(),
        };
        let rows = (0..ROWS)
            .map(|_| ProjectedRow {
                wraps: false,
                continues: false,
                cells: (0..COLUMNS)
                    .map(|column| ProjectedCell {
                        text: if column % 2 == 0 {
                            String::new()
                        } else {
                            " ".to_string()
                        },
                        width: 1,
                        style: default_style.clone(),
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let mut tables = TableBuilder::new();

        let projected = tables
            .anchored_rows(
                &rows,
                LogicalCellAnchor {
                    logical_line_id: 1,
                    logical_cell_offset: 0,
                },
            )
            .unwrap();

        assert_eq!(projected.len(), ROWS);
        assert!(projected.iter().all(|row| row.cells.len() == COLUMNS));
        assert!(
            projected
                .iter()
                .flat_map(|row| &row.cells)
                .all(|cell| { cell.grapheme_index == 0 && cell.style_index == 0 })
        );
        assert_eq!(tables.graphemes.len(), 1);
        assert_eq!(tables.styles.len(), 1);
        assert_eq!(
            (tables.grapheme_hash_lookups, tables.style_hash_lookups),
            (0, 0)
        );
    }

    #[test]
    fn adjacent_non_default_style_runs_hash_once_per_row() {
        const ROWS: usize = 80;
        const COLUMNS: usize = 160;

        let emphasized_style = ProjectedStyle {
            foreground: ProjectedColor::Palette(4),
            background: ProjectedColor::Default,
            underline_color: ProjectedColor::Default,
            flags: 1,
            underline: 0,
            hyperlink: String::new(),
        };
        let rows = (0..ROWS)
            .map(|_| ProjectedRow {
                wraps: false,
                continues: false,
                cells: (0..COLUMNS)
                    .map(|_| ProjectedCell {
                        text: " ".to_string(),
                        width: 1,
                        style: emphasized_style.clone(),
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let mut tables = TableBuilder::new();

        let projected = tables
            .anchored_rows(
                &rows,
                LogicalCellAnchor {
                    logical_line_id: 1,
                    logical_cell_offset: 0,
                },
            )
            .unwrap();

        assert_eq!(projected.len(), ROWS);
        assert!(projected.iter().all(|row| row.cells.len() == COLUMNS));
        assert!(
            projected
                .iter()
                .flat_map(|row| &row.cells)
                .all(|cell| cell.grapheme_index == 0 && cell.style_index == 1)
        );
        assert_eq!(tables.graphemes.len(), 1);
        assert_eq!(tables.styles.len(), 2);
        assert_eq!(tables.style_hash_lookups, ROWS);
    }

    #[test]
    fn adjacent_style_reuse_preserves_run_boundaries_and_hyperlinks() {
        let default_style = ProjectedStyle {
            foreground: ProjectedColor::Default,
            background: ProjectedColor::Default,
            underline_color: ProjectedColor::Default,
            flags: 0,
            underline: 0,
            hyperlink: String::new(),
        };
        let emphasized_style = ProjectedStyle {
            foreground: ProjectedColor::Palette(4),
            flags: 1,
            ..default_style.clone()
        };
        let first_link_style = ProjectedStyle {
            hyperlink: "https://example.invalid/first".to_string(),
            ..emphasized_style.clone()
        };
        let second_link_style = ProjectedStyle {
            hyperlink: "https://example.invalid/second".to_string(),
            ..emphasized_style.clone()
        };
        let cells = |styles: Vec<ProjectedStyle>| {
            styles
                .into_iter()
                .map(|style| ProjectedCell {
                    text: " ".to_string(),
                    width: 1,
                    style,
                })
                .collect()
        };
        let rows = vec![
            ProjectedRow {
                wraps: false,
                continues: false,
                cells: cells(vec![
                    default_style.clone(),
                    default_style.clone(),
                    emphasized_style.clone(),
                    emphasized_style.clone(),
                    first_link_style.clone(),
                    first_link_style.clone(),
                    emphasized_style.clone(),
                    default_style.clone(),
                ]),
            },
            ProjectedRow {
                wraps: false,
                continues: false,
                cells: cells(vec![
                    first_link_style.clone(),
                    first_link_style,
                    second_link_style.clone(),
                    second_link_style,
                ]),
            },
        ];
        let mut tables = TableBuilder::new();

        let projected = tables
            .anchored_rows(
                &rows,
                LogicalCellAnchor {
                    logical_line_id: 1,
                    logical_cell_offset: 0,
                },
            )
            .unwrap();

        assert_eq!(
            projected
                .iter()
                .map(|row| row
                    .cells
                    .iter()
                    .map(|cell| cell.style_index)
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            vec![vec![0, 0, 1, 1, 2, 2, 1, 0], vec![2, 2, 3, 3]]
        );
        assert_eq!(tables.styles.len(), 4);
        assert_eq!(tables.styles[1].hyperlink_index, 0);
        assert_eq!(tables.styles[2].hyperlink_index, 1);
        assert_eq!(tables.styles[3].hyperlink_index, 2);
        assert_eq!(
            tables
                .hyperlinks
                .iter()
                .map(|link| link.uri.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://example.invalid/first",
                "https://example.invalid/second"
            ]
        );
        assert_eq!(tables.style_hash_lookups, 5);
    }
}
