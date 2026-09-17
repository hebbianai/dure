use super::{
    BufferId, BufferState, CursorShape, HistoryAnchor, MAX_COLUMNS, MAX_CURSOR_BYTES,
    MAX_GRID_ROWS, MAX_TABLE_ENTRIES, ProtocolError, validate_rows,
};

pub(crate) fn validate_history_anchor(history: &HistoryAnchor) -> Result<(), ProtocolError> {
    validate_bytes(
        &history.before_cursor,
        0,
        MAX_CURSOR_BYTES,
        "history before cursor is oversized",
    )?;
    validate_bytes(
        &history.after_cursor,
        0,
        MAX_CURSOR_BYTES,
        "history after cursor is oversized",
    )?;
    validate_history_availability(history.has_more_before, &history.before_cursor)?;
    validate_history_availability(history.has_more_after, &history.after_cursor)
}

pub(crate) fn validate_history_availability(
    has_more: bool,
    cursor: &[u8],
) -> Result<(), ProtocolError> {
    if has_more && cursor.is_empty() {
        return Err(ProtocolError::InvalidRecord(
            "history availability requires its cursor",
        ));
    }
    Ok(())
}

pub(crate) fn validate_buffer_bounds(
    buffer: &BufferState,
    columns: u32,
    rows: u32,
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
    if cursor.row >= rows
        || cursor.column >= columns
        || cursor.style_index as usize >= MAX_TABLE_ENTRIES
        || CursorShape::try_from(cursor.shape).is_err()
        || cursor.shape == CursorShape::Unspecified as i32
    {
        return Err(ProtocolError::InvalidRecord(
            "replacement buffer cursor is invalid",
        ));
    }
    validate_rows(&buffer.rows, columns as usize, None, schema_minor)
}

pub(crate) fn validate_geometry(columns: u32, rows: u32) -> Result<(), ProtocolError> {
    if columns == 0 || columns as usize > MAX_COLUMNS || rows == 0 || rows as usize > MAX_GRID_ROWS
    {
        return Err(ProtocolError::InvalidRecord(
            "terminal geometry is outside caps",
        ));
    }
    Ok(())
}

pub(crate) fn validate_buffer_id(value: i32) -> Result<(), ProtocolError> {
    if value != BufferId::Normal as i32 && value != BufferId::Alternate as i32 {
        return Err(ProtocolError::InvalidRecord("buffer id is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_text(
    value: &str,
    minimum: usize,
    maximum: usize,
    reason: &'static str,
) -> Result<(), ProtocolError> {
    if value.len() < minimum || value.len() > maximum {
        return Err(ProtocolError::InvalidRecord(reason));
    }
    Ok(())
}

pub(crate) fn validate_bytes(
    value: &[u8],
    minimum: usize,
    maximum: usize,
    reason: &'static str,
) -> Result<(), ProtocolError> {
    if value.len() < minimum || value.len() > maximum {
        return Err(ProtocolError::InvalidRecord(reason));
    }
    Ok(())
}
