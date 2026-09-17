//! Engine-neutral structured terminal state records.
//!
//! This leaf crate owns only the bounded binary schema and codec. Transport
//! negotiation, PTY ownership, parsing, and product presentation stay with
//! their respective consumers.

mod codec;
mod generated;
mod interaction;
mod types;
mod validation_primitives;
mod viewport;
mod viewport_frame_parts;

pub use codec::*;
pub use generated::*;
pub use interaction::{
    InputIngressAuthority, MAX_AGENT_PROMPT_ADMISSION_WAIT_MS, encode_input_at_writer,
    validate_input_ingress, validate_input_intent, validate_input_receipt, validate_resize_receipt,
};
pub use types::*;
pub use viewport::{
    ViewportIngressAuthority, validate_viewport_frame, validate_viewport_ingress,
    validate_viewport_intent, validate_wheel_receipt,
};
pub use viewport_frame_parts::*;

use interaction::validate_event;
use validation_primitives::{
    validate_buffer_bounds, validate_buffer_id, validate_bytes, validate_geometry,
    validate_history_anchor, validate_history_availability, validate_text,
};

pub const ENVELOPE_MAGIC: [u8; 4] = *b"TSPB";
pub const PROTOCOL_MAJOR: u8 = 1;
pub const PROTOCOL_MINOR: u8 = 6;
pub const ENVELOPE_HEADER_BYTES: usize = 20;
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_ENVELOPE_BYTES: usize = ENVELOPE_HEADER_BYTES + MAX_PAYLOAD_BYTES;
/// Leaf-level cap for one atomically installed snapshot batch. History is paged
/// separately; exact snapshots are rejected, never truncated. Future Host
/// fanout integration must reserve this batch before advertising the capability.
pub const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
// Future Host wiring must project this leaf's FrameTooLarge through the
// existing Hmux protocol Error/resource-limit path, not a semantic state record.
pub const MAX_SNAPSHOT_PARTS: usize = 32;
/// Maximum encoded size of one complete viewport replacement. The frame is
/// rejected rather than truncated when it cannot fit this atomic bound.
pub const MAX_VIEWPORT_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_VIEWPORT_FRAME_PARTS: usize = 32;
/// The all-ones revision is reserved as the explicit epoch-rollover boundary,
/// so no implementation can wrap an adjacent mutation back to zero.
pub const MAX_STATE_REVISION: u64 = u64::MAX - 1;

const MAX_TERMINAL_EPOCH_BYTES: usize = 128;
const MAX_BATCH_ID_BYTES: usize = 64;
const MAX_COLUMNS: usize = 1024;
const MAX_GRID_ROWS: usize = 512;
const MAX_HISTORY_ROWS: usize = 8192;
const MAX_PAGE_ROWS: usize = 2048;
const MAX_TABLE_ENTRIES: usize = 65_536;
const MAX_OPERATIONS: usize = 4096;
const MAX_CURSOR_BYTES: usize = 512;
const MAX_GRAPHEME_BYTES: usize = 1024;
const MAX_URI_BYTES: usize = 4096;
const MAX_EVENT_TEXT_BYTES: usize = 4096;
const MAX_INPUT_BYTES: usize = 64 * 1024;

pub fn validate_record(record: &TerminalStateRecord) -> Result<(), ProtocolError> {
    if record.schema_minor > u32::from(PROTOCOL_MINOR) {
        return Err(ProtocolError::InvalidRecord("unsupported schema minor"));
    }
    validate_text(
        &record.terminal_epoch,
        1,
        MAX_TERMINAL_EPOCH_BYTES,
        "terminal epoch is empty or oversized",
    )?;
    if record.state_revision == 0 {
        return Err(ProtocolError::InvalidRecord(
            "state revision must be nonzero",
        ));
    }
    if record.state_revision > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "state revision is exhausted; roll terminal epoch",
        ));
    }

    match record.body.as_ref() {
        Some(terminal_state_record::Body::Snapshot(snapshot)) => {
            validate_snapshot(snapshot, record.schema_minor)
        }
        Some(terminal_state_record::Body::Mutation(mutation)) => {
            validate_mutation(record.schema_minor, record.state_revision, mutation)
        }
        Some(terminal_state_record::Body::HistoryPage(page)) => {
            validate_history_page(record.schema_minor, page)
        }
        Some(terminal_state_record::Body::Event(event)) => validate_event(event),
        Some(terminal_state_record::Body::InputIntent(intent)) => validate_input_intent(intent),
        Some(terminal_state_record::Body::SnapshotPart(part)) => validate_snapshot_part(part),
        Some(terminal_state_record::Body::HistoryRequest(request)) => {
            validate_history_request(request)
        }
        Some(terminal_state_record::Body::ViewportFrame(frame)) => {
            validate_viewport_frame(record.schema_minor, frame)?;
            if frame
                .input_output_timing
                .as_ref()
                .is_some_and(|timing| timing.first_output_sequence > record.through_output_seq)
            {
                return Err(ProtocolError::InvalidRecord(
                    "viewport input/output timing exceeds its output high-water",
                ));
            }
            Ok(())
        }
        Some(terminal_state_record::Body::ViewportIntent(intent)) => {
            viewport::validate_viewport_intent_for_minor(record.schema_minor, intent)
        }
        Some(terminal_state_record::Body::InputReceipt(receipt)) => {
            validate_input_receipt(receipt)?;
            if matches!(
                receipt.outcome.as_ref(),
                Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                    input_baseline_output_sequence: Some(baseline),
                    ..
                })) if *baseline > record.through_output_seq
            ) {
                return Err(ProtocolError::InvalidRecord(
                    "input receipt write baseline exceeds its output high-water",
                ));
            }
            Ok(())
        }
        Some(terminal_state_record::Body::ResizeReceipt(receipt)) => {
            validate_resize_receipt(receipt)
        }
        Some(terminal_state_record::Body::ViewportFramePart(part)) => {
            validate_viewport_frame_part(record.schema_minor, part)
        }
        Some(terminal_state_record::Body::WheelReceipt(receipt)) => {
            if record.schema_minor < 5 {
                return Err(ProtocolError::InvalidRecord(
                    "wheel receipt requires schema minor 5",
                ));
            }
            validate_wheel_receipt(receipt)
        }
        None => Err(ProtocolError::InvalidRecord("record body is required")),
    }
}

pub fn validate_history_request(request: &HistoryRequest) -> Result<(), ProtocolError> {
    if HistoryDirection::try_from(request.direction).is_err()
        || request.direction == HistoryDirection::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord("history direction is invalid"));
    }
    validate_bytes(
        &request.cursor,
        1,
        MAX_CURSOR_BYTES,
        "history request cursor is empty or oversized",
    )?;
    if request.maximum_rows == 0 || request.maximum_rows as usize > MAX_PAGE_ROWS {
        return Err(ProtocolError::InvalidRecord(
            "history request row limit is invalid",
        ));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &StateSnapshot, schema_minor: u32) -> Result<(), ProtocolError> {
    validate_geometry(snapshot.columns, snapshot.rows)?;
    validate_buffer_id(snapshot.active_buffer)?;
    let tables = snapshot
        .tables
        .as_ref()
        .ok_or(ProtocolError::InvalidRecord("snapshot tables are required"))?;
    validate_tables(tables)?;
    let normal = snapshot
        .normal_buffer
        .as_ref()
        .ok_or(ProtocolError::InvalidRecord("normal buffer is required"))?;
    let alternate = snapshot
        .alternate_buffer
        .as_ref()
        .ok_or(ProtocolError::InvalidRecord("alternate buffer is required"))?;
    validate_buffer(
        normal,
        snapshot.columns,
        snapshot.rows,
        tables,
        schema_minor,
    )?;
    validate_buffer(
        alternate,
        snapshot.columns,
        snapshot.rows,
        tables,
        schema_minor,
    )?;
    validate_global_logical_anchors([normal.rows.as_slice(), alternate.rows.as_slice()])?;
    validate_history_anchor(
        snapshot
            .history
            .as_ref()
            .ok_or(ProtocolError::InvalidRecord("history window is required"))?,
    )?;
    validate_text(
        &snapshot.title,
        0,
        MAX_EVENT_TEXT_BYTES,
        "terminal title is oversized",
    )?;
    validate_text(
        &snapshot.working_directory_uri,
        0,
        MAX_URI_BYTES,
        "working directory URI is oversized",
    )?;
    if schema_minor >= 1 {
        validate_palette(
            snapshot
                .palette
                .as_ref()
                .ok_or(ProtocolError::InvalidRecord("snapshot palette is required"))?,
        )?;
        validate_input_modes(snapshot.input_modes.as_ref().ok_or(
            ProtocolError::InvalidRecord("snapshot input modes are required"),
        )?)?;
        validate_unicode_width(snapshot.unicode_width.as_ref().ok_or(
            ProtocolError::InvalidRecord("snapshot Unicode width profile is required"),
        )?)?;
        if snapshot.media_support != TerminalMediaSupport::Unsupported as i32 {
            return Err(ProtocolError::InvalidRecord(
                "terminal media support must be explicitly unsupported",
            ));
        }
    }
    Ok(())
}

fn validate_mutation(
    schema_minor: u32,
    state_revision: u64,
    mutation: &StateMutation,
) -> Result<(), ProtocolError> {
    if mutation.base_state_revision.checked_add(1) != Some(state_revision) {
        return Err(ProtocolError::InvalidRecord(
            "mutation revisions must be adjacent",
        ));
    }
    if mutation.operations.len() > MAX_OPERATIONS {
        return Err(ProtocolError::InvalidRecord("too many mutation operations"));
    }
    if mutation.operations.is_empty()
        && mutation.tables.as_ref().is_none_or(|tables| {
            tables.graphemes.is_empty() && tables.styles.is_empty() && tables.hyperlinks.is_empty()
        })
    {
        return Err(ProtocolError::InvalidRecord(
            "mutation must contain a state change",
        ));
    }
    if let Some(tables) = mutation.tables.as_ref() {
        validate_table_append(tables)?;
    }
    for operation in &mutation.operations {
        validate_operation(schema_minor, operation)?;
    }
    Ok(())
}

fn validate_history_page(schema_minor: u32, page: &HistoryPage) -> Result<(), ProtocolError> {
    if HistoryDirection::try_from(page.direction).is_err()
        || page.direction == HistoryDirection::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord("history direction is invalid"));
    }
    validate_bytes(
        &page.request_cursor,
        1,
        MAX_CURSOR_BYTES,
        "history request cursor is empty or oversized",
    )?;
    validate_bytes(
        &page.before_cursor,
        0,
        MAX_CURSOR_BYTES,
        "history before cursor is oversized",
    )?;
    validate_bytes(
        &page.after_cursor,
        0,
        MAX_CURSOR_BYTES,
        "history after cursor is oversized",
    )?;
    validate_history_availability(page.has_more_before, &page.before_cursor)?;
    validate_history_availability(page.has_more_after, &page.after_cursor)?;
    if page.rows.len() > MAX_PAGE_ROWS {
        return Err(ProtocolError::InvalidRecord(
            "history page has too many rows",
        ));
    }
    if page.table_append.is_some() {
        return Err(ProtocolError::InvalidRecord(
            "history page global table append is unsupported",
        ));
    }
    let tables = page.tables.as_ref().ok_or(ProtocolError::InvalidRecord(
        "history page-local tables are required",
    ))?;
    validate_tables(tables)?;
    validate_rows(&page.rows, MAX_COLUMNS, Some(tables), schema_minor)?;
    Ok(())
}

/// Validates a page against the exact installed projections before a client
/// commits it. Ghostty remains canonical; these slices are only the bounded
/// client projection participating in one atomic transaction.
pub fn validate_history_page_transaction(
    schema_minor: u32,
    page: &HistoryPage,
    normal_rows: &[TerminalRow],
    alternate_rows: &[TerminalRow],
    history_rows: &[TerminalRow],
) -> Result<(), ProtocolError> {
    validate_history_page(schema_minor, page)?;
    validate_global_logical_anchors([
        normal_rows,
        alternate_rows,
        history_rows,
        page.rows.as_slice(),
    ])?;
    let mut physical_ids = std::collections::HashSet::with_capacity(
        history_rows.len().saturating_add(page.rows.len()),
    );
    for row in history_rows.iter().chain(&page.rows) {
        if !physical_ids.insert(row.row_id) {
            return Err(ProtocolError::InvalidRecord(
                "history page repeats a known physical row id",
            ));
        }
    }
    let combined: Vec<_> = if page.direction == HistoryDirection::Before as i32 {
        page.rows.iter().chain(history_rows).cloned().collect()
    } else {
        history_rows.iter().chain(&page.rows).cloned().collect()
    };
    validate_rows(&combined, MAX_COLUMNS, None, schema_minor)
}

fn validate_buffer(
    buffer: &BufferState,
    columns: u32,
    rows: u32,
    tables: &TerminalTables,
    schema_minor: u32,
) -> Result<(), ProtocolError> {
    if buffer.rows.len() != rows as usize || buffer.rows.len() > MAX_GRID_ROWS {
        return Err(ProtocolError::InvalidRecord(
            "grid buffer must contain every row",
        ));
    }
    if buffer.scroll_top > buffer.scroll_bottom || buffer.scroll_bottom >= rows {
        return Err(ProtocolError::InvalidRecord("invalid scroll region"));
    }
    let cursor = buffer
        .cursor
        .as_ref()
        .ok_or(ProtocolError::InvalidRecord("buffer cursor is required"))?;
    if cursor.row >= rows || cursor.column >= columns {
        return Err(ProtocolError::InvalidRecord("cursor is outside the grid"));
    }
    if cursor.style_index as usize >= tables.styles.len() {
        return Err(ProtocolError::InvalidRecord(
            "cursor style index is invalid",
        ));
    }
    if CursorShape::try_from(cursor.shape).is_err()
        || cursor.shape == CursorShape::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord("cursor shape is invalid"));
    }
    validate_rows(&buffer.rows, columns as usize, Some(tables), schema_minor)
}

fn validate_tables(tables: &TerminalTables) -> Result<(), ProtocolError> {
    if tables.graphemes.is_empty() || tables.styles.is_empty() {
        return Err(ProtocolError::InvalidRecord(
            "grapheme and style tables must be nonempty",
        ));
    }
    validate_table_lengths(
        tables.graphemes.len(),
        tables.styles.len(),
        tables.hyperlinks.len(),
    )?;
    for grapheme in &tables.graphemes {
        validate_grapheme(grapheme)?;
    }
    for style in &tables.styles {
        validate_style(style, tables.hyperlinks.len())?;
    }
    for hyperlink in &tables.hyperlinks {
        validate_hyperlink(hyperlink)?;
    }
    Ok(())
}

/// Validates a complete table set for an engine-neutral history owner.
pub fn validate_terminal_tables(tables: &TerminalTables) -> Result<(), ProtocolError> {
    validate_tables(tables)
}

fn validate_table_append(tables: &TableAppend) -> Result<(), ProtocolError> {
    validate_table_lengths(
        tables.graphemes.len(),
        tables.styles.len(),
        tables.hyperlinks.len(),
    )?;
    if tables.grapheme_base as usize + tables.graphemes.len() > MAX_TABLE_ENTRIES
        || tables.style_base as usize + tables.styles.len() > MAX_TABLE_ENTRIES
        || tables.hyperlink_base as usize + tables.hyperlinks.len() > MAX_TABLE_ENTRIES
    {
        return Err(ProtocolError::InvalidRecord(
            "table append exceeds table cap",
        ));
    }
    for grapheme in &tables.graphemes {
        validate_grapheme(grapheme)?;
    }
    let resulting_hyperlink_count = tables.hyperlink_base as usize + tables.hyperlinks.len();
    for style in &tables.styles {
        validate_style(style, resulting_hyperlink_count)?;
    }
    for hyperlink in &tables.hyperlinks {
        validate_hyperlink(hyperlink)?;
    }
    Ok(())
}

fn validate_table_lengths(
    graphemes: usize,
    styles: usize,
    hyperlinks: usize,
) -> Result<(), ProtocolError> {
    if graphemes > MAX_TABLE_ENTRIES || styles > MAX_TABLE_ENTRIES || hyperlinks > MAX_TABLE_ENTRIES
    {
        return Err(ProtocolError::InvalidRecord(
            "terminal table exceeds entry cap",
        ));
    }
    Ok(())
}

fn validate_grapheme(grapheme: &Grapheme) -> Result<(), ProtocolError> {
    validate_text(
        &grapheme.text,
        0,
        MAX_GRAPHEME_BYTES,
        "grapheme is oversized",
    )?;
    if grapheme.display_width > 2 {
        return Err(ProtocolError::InvalidRecord(
            "grapheme width exceeds two cells",
        ));
    }
    Ok(())
}

fn validate_style(style: &CellStyle, hyperlink_count: usize) -> Result<(), ProtocolError> {
    if style.hyperlink_index as usize > hyperlink_count {
        return Err(ProtocolError::InvalidRecord(
            "style hyperlink index is invalid",
        ));
    }
    if style.flags > 0x1ff {
        return Err(ProtocolError::InvalidRecord(
            "style decoration flags contain unknown bits",
        ));
    }
    if UnderlineKind::try_from(style.underline).is_err()
        || style.underline == UnderlineKind::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord("underline kind is invalid"));
    }
    for color in [
        style.foreground.as_ref(),
        style.background.as_ref(),
        style.underline_color.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if color.kind == ColorKind::Rgb as i32 && color.value > 0x00ff_ffff {
            return Err(ProtocolError::InvalidRecord("RGB color exceeds 24 bits"));
        }
        if color.kind == ColorKind::Palette as i32 && color.value > 255 {
            return Err(ProtocolError::InvalidRecord(
                "palette color index exceeds 255",
            ));
        }
        if ColorKind::try_from(color.kind).is_err() || color.kind == ColorKind::Unspecified as i32 {
            return Err(ProtocolError::InvalidRecord("unknown color kind"));
        }
    }
    Ok(())
}

fn validate_hyperlink(hyperlink: &Hyperlink) -> Result<(), ProtocolError> {
    validate_text(
        &hyperlink.uri,
        1,
        MAX_URI_BYTES,
        "hyperlink URI is empty or oversized",
    )?;
    validate_text(
        &hyperlink.params,
        0,
        MAX_EVENT_TEXT_BYTES,
        "hyperlink params are oversized",
    )
}

fn validate_palette(palette: &TerminalPalette) -> Result<(), ProtocolError> {
    if palette.indexed_rgb.len() != 256 {
        return Err(ProtocolError::InvalidRecord(
            "resolved terminal palette must contain 256 entries",
        ));
    }
    if palette
        .indexed_rgb
        .iter()
        .copied()
        .any(|rgb| rgb > 0x00ff_ffff)
        || palette.default_foreground_rgb > 0x00ff_ffff
        || palette.default_background_rgb > 0x00ff_ffff
        || palette.cursor_rgb > 0x00ff_ffff
        || palette.selection_background_rgb > 0x00ff_ffff
    {
        return Err(ProtocolError::InvalidRecord(
            "terminal palette RGB exceeds 24 bits",
        ));
    }
    Ok(())
}

fn validate_input_modes(modes: &InputModes) -> Result<(), ProtocolError> {
    if MouseTrackingMode::try_from(modes.mouse_tracking).is_err()
        || modes.mouse_tracking == MouseTrackingMode::Unspecified as i32
        || MouseEncoding::try_from(modes.mouse_encoding).is_err()
        || modes.mouse_encoding == MouseEncoding::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord(
            "terminal input modes contain an invalid enum",
        ));
    }
    Ok(())
}

fn validate_unicode_width(profile: &UnicodeWidthProfile) -> Result<(), ProtocolError> {
    validate_text(
        &profile.unicode_version,
        1,
        32,
        "Unicode width version is empty or oversized",
    )?;
    if !(1..=2).contains(&profile.ambiguous_width) || !(1..=2).contains(&profile.emoji_width) {
        return Err(ProtocolError::InvalidRecord(
            "Unicode width values must be one or two cells",
        ));
    }
    Ok(())
}

/// Validates the width profile required to reproduce terminal wrapping.
pub fn validate_unicode_width_profile(profile: &UnicodeWidthProfile) -> Result<(), ProtocolError> {
    validate_unicode_width(profile)
}

fn validate_row(
    row: &TerminalRow,
    columns: usize,
    tables: &TerminalTables,
    schema_minor: u32,
) -> Result<(), ProtocolError> {
    validate_row_bounds(row, columns, schema_minor)?;
    let mut display_columns = 0usize;
    for cell in &row.cells {
        let grapheme = tables.graphemes.get(cell.grapheme_index as usize).ok_or(
            ProtocolError::InvalidRecord("cell grapheme index is invalid"),
        )?;
        if cell.style_index as usize >= tables.styles.len() {
            return Err(ProtocolError::InvalidRecord("cell style index is invalid"));
        }
        display_columns += grapheme.display_width as usize;
    }
    if display_columns > columns {
        return Err(ProtocolError::InvalidRecord(
            "row display width exceeds grid",
        ));
    }
    if schema_minor >= 2 && display_columns != row.logical_cell_span as usize {
        return Err(ProtocolError::InvalidRecord(
            "logical cell span does not match row cells",
        ));
    }
    Ok(())
}

fn validate_row_bounds(
    row: &TerminalRow,
    columns: usize,
    schema_minor: u32,
) -> Result<(), ProtocolError> {
    if row.row_id == 0 {
        return Err(ProtocolError::InvalidRecord("row id must be nonzero"));
    }
    if row.cells.len() > columns {
        return Err(ProtocolError::InvalidRecord("row has too many cells"));
    }
    if schema_minor >= 2 && row.logical_cell_span as usize > columns {
        return Err(ProtocolError::InvalidRecord(
            "logical cell span exceeds the grid",
        ));
    }
    if row.logical_line_id == 0 {
        return Err(ProtocolError::InvalidRecord(
            "logical line id must be nonzero",
        ));
    }
    if row.continues_from_previous != (row.logical_cell_offset > 0) {
        return Err(ProtocolError::InvalidRecord(
            "logical continuation and cell offset disagree",
        ));
    }
    if RowTermination::try_from(row.termination).is_err()
        || row.termination == RowTermination::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord("row termination is invalid"));
    }
    if row.cells.iter().any(|cell| {
        cell.grapheme_index as usize >= MAX_TABLE_ENTRIES
            || cell.style_index as usize >= MAX_TABLE_ENTRIES
    }) {
        return Err(ProtocolError::InvalidRecord(
            "row table index exceeds entry cap",
        ));
    }
    Ok(())
}

fn validate_rows(
    rows: &[TerminalRow],
    columns: usize,
    tables: Option<&TerminalTables>,
    schema_minor: u32,
) -> Result<(), ProtocolError> {
    let mut physical_ids = std::collections::HashSet::with_capacity(rows.len());
    let mut previous: Option<&TerminalRow> = None;
    for row in rows {
        if !physical_ids.insert(row.row_id) {
            return Err(ProtocolError::InvalidRecord("duplicate physical row id"));
        }
        if let Some(tables) = tables {
            validate_row(row, columns, tables, schema_minor)?;
        } else {
            validate_row_bounds(row, columns, schema_minor)?;
        }
        if let Some(previous) = previous {
            if row.logical_line_id < previous.logical_line_id {
                return Err(ProtocolError::InvalidRecord(
                    "logical line ids are out of order",
                ));
            }
            if row.logical_line_id == previous.logical_line_id {
                if previous.termination != RowTermination::SoftWrap as i32 {
                    return Err(ProtocolError::InvalidRecord(
                        "logical line segments are duplicated or discontinuous",
                    ));
                }
                if schema_minor >= 2 {
                    if previous
                        .logical_cell_offset
                        .checked_add(previous.logical_cell_span)
                        != Some(row.logical_cell_offset)
                    {
                        return Err(ProtocolError::InvalidRecord(
                            "logical line segments are not contiguous",
                        ));
                    }
                } else if row.logical_cell_offset <= previous.logical_cell_offset {
                    return Err(ProtocolError::InvalidRecord(
                        "logical line segments are duplicated or discontinuous",
                    ));
                }
            } else if previous.termination == RowTermination::SoftWrap as i32
                || row.logical_cell_offset != 0
                || row.continues_from_previous
            {
                return Err(ProtocolError::InvalidRecord(
                    "logical line boundary is inconsistent",
                ));
            }
        }
        previous = Some(row);
    }
    Ok(())
}

pub fn validate_global_logical_anchors<'a>(
    row_groups: impl IntoIterator<Item = &'a [TerminalRow]>,
) -> Result<(), ProtocolError> {
    let mut anchors = std::collections::HashSet::new();
    for rows in row_groups {
        for row in rows {
            if !anchors.insert((row.logical_line_id, row.logical_cell_offset)) {
                return Err(ProtocolError::InvalidRecord(
                    "logical row anchor is duplicated across terminal projections",
                ));
            }
        }
    }
    Ok(())
}

fn validate_operation(schema_minor: u32, operation: &StateOperation) -> Result<(), ProtocolError> {
    match operation.operation.as_ref() {
        Some(state_operation::Operation::ReplaceBuffers(replace)) => {
            validate_geometry(replace.columns, replace.rows)?;
            let normal = replace
                .normal_buffer
                .as_ref()
                .ok_or(ProtocolError::InvalidRecord(
                    "normal replacement buffer is required",
                ))?;
            let alternate =
                replace
                    .alternate_buffer
                    .as_ref()
                    .ok_or(ProtocolError::InvalidRecord(
                        "alternate replacement buffer is required",
                    ))?;
            validate_buffer_bounds(normal, replace.columns, replace.rows, schema_minor)?;
            validate_buffer_bounds(alternate, replace.columns, replace.rows, schema_minor)?;
            validate_global_logical_anchors([normal.rows.as_slice(), alternate.rows.as_slice()])?;
            validate_history_anchor(replace.history.as_ref().ok_or(
                ProtocolError::InvalidRecord("buffer replacement history anchor is required"),
            )?)
        }
        Some(state_operation::Operation::ReplaceRow(replace)) => {
            validate_buffer_id(replace.buffer)?;
            if replace.row_index as usize >= MAX_GRID_ROWS {
                return Err(ProtocolError::InvalidRecord(
                    "replacement row index exceeds grid cap",
                ));
            }
            validate_row_bounds(
                replace
                    .row
                    .as_ref()
                    .ok_or(ProtocolError::InvalidRecord("replacement row is required"))?,
                MAX_COLUMNS,
                schema_minor,
            )
        }
        Some(state_operation::Operation::Scroll(scroll)) => {
            validate_buffer_id(scroll.buffer)?;
            if scroll.top > scroll.bottom || scroll.bottom as usize >= MAX_GRID_ROWS {
                return Err(ProtocolError::InvalidRecord(
                    "invalid scroll operation region",
                ));
            }
            let distance = scroll.lines.unsigned_abs() as usize;
            if distance == 0
                || distance > scroll.bottom.saturating_sub(scroll.top) as usize + 1
                || scroll.exposed_rows.len() != distance
            {
                return Err(ProtocolError::InvalidRecord(
                    "scroll exposed rows do not match distance",
                ));
            }
            validate_rows(&scroll.exposed_rows, MAX_COLUMNS, None, schema_minor)
        }
        Some(state_operation::Operation::SetActiveBuffer(active)) => {
            validate_buffer_id(active.buffer)
        }
        Some(state_operation::Operation::SetCursor(cursor)) => {
            validate_buffer_id(cursor.buffer)?;
            let cursor = cursor
                .cursor
                .as_ref()
                .ok_or(ProtocolError::InvalidRecord("cursor state is required"))?;
            if cursor.column as usize >= MAX_COLUMNS
                || cursor.row as usize >= MAX_GRID_ROWS
                || cursor.style_index as usize >= MAX_TABLE_ENTRIES
                || CursorShape::try_from(cursor.shape).is_err()
                || cursor.shape == CursorShape::Unspecified as i32
            {
                return Err(ProtocolError::InvalidRecord(
                    "cursor state exceeds terminal caps",
                ));
            }
            Ok(())
        }
        Some(state_operation::Operation::AppendHistory(append)) => {
            if append.rows.len() > MAX_HISTORY_ROWS {
                return Err(ProtocolError::InvalidRecord(
                    "history append has too many rows",
                ));
            }
            validate_bytes(
                &append.after_cursor,
                0,
                MAX_CURSOR_BYTES,
                "history after cursor is oversized",
            )?;
            validate_history_availability(append.has_more_after, &append.after_cursor)?;
            validate_rows(&append.rows, MAX_COLUMNS, None, schema_minor)
        }
        Some(state_operation::Operation::TrimHistory(trim)) => {
            if trim.rows_from_start as usize > MAX_HISTORY_ROWS {
                return Err(ProtocolError::InvalidRecord("history trim exceeds row cap"));
            }
            validate_bytes(
                &trim.before_cursor,
                0,
                MAX_CURSOR_BYTES,
                "history before cursor is oversized",
            )?;
            validate_history_availability(trim.has_more_before, &trim.before_cursor)
        }
        Some(state_operation::Operation::InvalidateHistoryProjection(invalidate)) => {
            validate_history_anchor(invalidate.history.as_ref().ok_or(
                ProtocolError::InvalidRecord("history invalidation anchor is required"),
            )?)
        }
        Some(state_operation::Operation::SetInputModes(operation)) => {
            validate_input_modes(operation.input_modes.as_ref().ok_or(
                ProtocolError::InvalidRecord("input modes payload is required"),
            )?)
        }
        Some(state_operation::Operation::SetPalette(operation)) => validate_palette(
            operation
                .palette
                .as_ref()
                .ok_or(ProtocolError::InvalidRecord(
                    "terminal palette payload is required",
                ))?,
        ),
        Some(state_operation::Operation::SetTitle(operation)) => validate_text(
            &operation.title,
            0,
            MAX_EVENT_TEXT_BYTES,
            "terminal title is oversized",
        ),
        Some(state_operation::Operation::SetWorkingDirectory(operation)) => validate_text(
            &operation.uri,
            0,
            MAX_URI_BYTES,
            "working directory URI is oversized",
        ),
        None => Err(ProtocolError::InvalidRecord("state operation is required")),
    }
}

fn validate_snapshot_part(part: &SnapshotPart) -> Result<(), ProtocolError> {
    validate_bytes(
        &part.batch_id,
        1,
        MAX_BATCH_ID_BYTES,
        "snapshot batch id is empty or oversized",
    )?;
    if part.part_count == 0
        || part.part_count as usize > MAX_SNAPSHOT_PARTS
        || part.part_index >= part.part_count
    {
        return Err(ProtocolError::InvalidRecord(
            "snapshot part index or count is invalid",
        ));
    }
    if part.total_snapshot_bytes == 0 || part.total_snapshot_bytes as usize > MAX_SNAPSHOT_BYTES {
        return Err(ProtocolError::InvalidRecord(
            "snapshot batch total is outside caps",
        ));
    }
    validate_bytes(
        &part.snapshot_chunk,
        1,
        MAX_PAYLOAD_BYTES,
        "snapshot chunk is empty or oversized",
    )
}

fn validate_viewport_frame_part(
    schema_minor: u32,
    part: &ViewportFramePart,
) -> Result<(), ProtocolError> {
    if schema_minor < 5 {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame parts require schema minor 5",
        ));
    }
    validate_bytes(
        &part.batch_id,
        1,
        MAX_BATCH_ID_BYTES,
        "viewport frame batch id is empty or oversized",
    )?;
    if part.part_count == 0
        || part.part_count as usize > MAX_VIEWPORT_FRAME_PARTS
        || part.part_index >= part.part_count
    {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame part index or count is invalid",
        ));
    }
    if part.total_frame_bytes == 0 || part.total_frame_bytes as usize > MAX_VIEWPORT_FRAME_BYTES {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame batch total is outside caps",
        ));
    }
    validate_bytes(
        &part.frame_chunk,
        1,
        MAX_PAYLOAD_BYTES,
        "viewport frame chunk is empty or oversized",
    )?;
    if part.frame_chunk.len() > part.total_frame_bytes as usize {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame chunk exceeds its declared total",
        ));
    }
    if part.projection_revision == 0 || part.projection_revision > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame part projection revision is invalid",
        ));
    }
    if part.applied_intent_seq > MAX_STATE_REVISION {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame part intent sequence is invalid",
        ));
    }
    Ok(())
}
