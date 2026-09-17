const std = @import("std");
const vt = @import("ghostty_vt");

const PageList = vt.PageList;
const tracked = vt.hmux_c_api.grid_ref_tracked;
const terminal_module = vt.hmux_terminal;
const SnapshotPage = terminal_module.snapshot.page;
const SnapshotRecord = terminal_module.snapshot.record;
const TerminalPage = terminal_module.Page;
const TerminalRow = terminal_module.page.Row;

const GridRef = extern struct {
    size: usize,
    node: ?*anyopaque,
    x: u16,
    y: u16,
};

const RowCallback = *const fn (
    userdata: ?*anyopaque,
    row_index: u16,
    wraps: u8,
    continues: u8,
    reference: *const GridRef,
    columns: u16,
) callconv(.c) c_int;

const ArchiveRowCallback = *const fn (
    userdata: ?*anyopaque,
    row_index: u16,
    wraps: u8,
    continues: u8,
    logical_line_id: u64,
    logical_cell_offset: u32,
    reference: *const GridRef,
    columns: u16,
) callconv(.c) c_int;

const ArchiveProjectionWork = extern struct {
    index_nodes_visited: usize,
    chunks_visited: usize,
    cells_visited: usize,
};

const HistoryPrefix = extern struct {
    first_serial: u64,
    last_serial: u64,
    successor_serial: u64,
    physical_rows: usize,
    history_rows: usize,
    last_y: u16,
    successor_y: u16,
};

const archive_magic = "GHPAGE01";
const archive_version: u16 = 2;
const archive_header_len: usize = 48;
const archive_page_len: usize = 32;
const archive_row_len: usize = 32;
const archive_page_target_cells: usize = 4 * 1024;

const ArchivePage = struct {
    record_offset: u64,
    record_len: u64,
    first_row: u64,
    columns: u16,
    rows: u16,
};

const ArchiveRow = struct {
    logical_line_id: u64,
    logical_cell_offset: u32,
    logical_cell_span: u32,
    page_index: u32,
    page_row: u16,
    columns: u16,
    wraps: bool,
    continues: bool,
    line_simple_narrow: bool,
};

/// Encodes the retained prefix as an Hmux envelope around complete native
/// Ghostty snapshot PAGE records. The envelope carries only stable row/anchor
/// indexes; all cells, styles, hyperlinks, graphemes, and row flags remain in
/// Ghostty's engine-owned PAGE representation.
pub export fn hmux_ghostty_history_prefix_archive(
    reference: tracked.CTrackedGridRef,
    expected: HistoryPrefix,
    first_logical_line_id: u64,
    output: ?[*]u8,
    capacity: usize,
    written: ?*usize,
    next_logical_line_id: ?*u64,
) c_int {
    const output_len = written orelse return -100;
    const next_line = next_logical_line_id orelse return -100;
    output_len.* = 0;
    next_line.* = 0;
    if (first_logical_line_id == 0) return -100;
    if (output == null or capacity == 0) return -3;

    var archive = encodeHistoryPrefixArchive(
        reference,
        expected,
        first_logical_line_id,
        capacity,
    ) catch |err| return switch (err) {
        error.ArchiveTooLarge => -3,
        else => -100,
    };
    defer archive.bytes.deinit(std.heap.c_allocator);
    output_len.* = archive.bytes.items.len;
    next_line.* = archive.next_logical_line_id;
    if (capacity < archive.bytes.items.len or output == null) return -3;
    @memcpy(output.?[0..archive.bytes.items.len], archive.bytes.items);
    return 0;
}

const EncodedArchive = struct {
    bytes: std.ArrayList(u8),
    next_logical_line_id: u64,
};

/// Moves the complete primary viewport into normal scrollback on an isolated
/// generation-sealing clone. The live terminal never calls this operation:
/// Hmux uses the clone only to transfer the predecessor's remaining hot rows
/// into its existing cold-history namespace before a successor becomes live.
pub export fn hmux_ghostty_seal_primary_screen_as_history(
    reference: tracked.CTrackedGridRef,
) c_int {
    const tracked_reference = reference orelse return -100;
    _ = pageList(tracked_reference) orelse return -4;
    const wrapper = tracked_reference.terminal orelse return -4;
    const terminal = wrapper.terminal;
    if (terminal.rows == 0 or terminal.cols == 0) return -100;

    // This clone exists only to supply normal history. Leaving primary active
    // also lets the ordinary prefix API work when the checkpoint was captured
    // from an alternate-screen TUI.
    terminal.screens.switchTo(.primary);
    terminal.scrolling_region = .{
        .top = 0,
        .bottom = terminal.rows - 1,
        .left = 0,
        .right = terminal.cols - 1,
    };
    terminal.scrollUp(terminal.rows) catch return -3;
    // Keep one blank hard-boundary row hot so the ordinary prefix supplier
    // can retire every meaningful predecessor row without a special offer.
    terminal.scrollUp(1) catch return -3;
    return 0;
}

fn encodeHistoryPrefixArchive(
    reference: tracked.CTrackedGridRef,
    expected: HistoryPrefix,
    first_logical_line_id: u64,
    maximum_bytes: usize,
) !EncodedArchive {
    const alloc = std.heap.c_allocator;
    const tracked_reference = reference orelse return error.InvalidReference;
    const list = pageList(tracked_reference) orelse return error.InvalidReference;
    if (tracked_reference.pin.garbage or expected.physical_rows == 0) {
        return error.InvalidReference;
    }
    const minimum_metadata_len = try std.math.add(
        usize,
        archive_header_len + archive_page_len,
        try std.math.mul(usize, expected.physical_rows, archive_row_len),
    );
    if (minimum_metadata_len > maximum_bytes) return error.ArchiveTooLarge;
    try validateHistoryPrefix(list, tracked_reference, expected);

    var pages: std.ArrayList(ArchivePage) = .empty;
    defer pages.deinit(alloc);
    var rows: std.ArrayList(ArchiveRow) = .empty;
    defer rows.deinit(alloc);
    var page_records: std.Io.Writer.Allocating = .init(alloc);
    defer page_records.deinit();
    var record_writer: SnapshotRecord.Writer = .init(alloc, &page_records.writer);
    defer record_writer.deinit();

    var iterator = tracked_reference.pin.*.rowIterator(.right_down, null);
    var current = iterator.next() orelse return error.InvalidReference;
    var remaining = expected.physical_rows;
    var logical_line_id = first_logical_line_id;
    var logical_cell_offset: u32 = 0;
    var previous_wraps = false;
    var first_row = true;

    while (remaining > 0) {
        const node = current.node;
        const page_index: u32 = @intCast(pages.items.len);
        const page_first_row: u64 = @intCast(rows.items.len);
        const y_start = current.y;
        var y_end = y_start;
        const source_columns = current.cells(.all).len;
        const maximum_page_rows = @max(
            @as(usize, 1),
            archive_page_target_cells / source_columns,
        );
        var page_rows: usize = 0;

        while (remaining > 0 and current.node == node and page_rows < maximum_page_rows) {
            const row = current.rowAndCell().row;
            if ((first_row and row.wrap_continuation) or
                (!first_row and row.wrap_continuation != previous_wraps))
            {
                return error.InvalidContinuation;
            }
            const metrics = logicalRowMetrics(current);
            try rows.append(alloc, .{
                .logical_line_id = logical_line_id,
                .logical_cell_offset = logical_cell_offset,
                .logical_cell_span = metrics.span,
                .page_index = page_index,
                .page_row = current.y - y_start,
                .columns = @intCast(current.cells(.all).len),
                .wraps = row.wrap,
                .continues = row.wrap_continuation,
                .line_simple_narrow = metrics.simple_narrow,
            });
            y_end = current.y + 1;
            previous_wraps = row.wrap;
            first_row = false;
            page_rows += 1;
            if (row.wrap) {
                logical_cell_offset = try std.math.add(
                    u32,
                    logical_cell_offset,
                    metrics.span,
                );
            } else {
                logical_line_id = try std.math.add(u64, logical_line_id, 1);
                logical_cell_offset = 0;
            }
            remaining -= 1;
            if (remaining > 0) {
                current = iterator.next() orelse return error.InvalidReference;
            }
        }

        var preserved = try node.pagePreservingState(alloc);
        defer preserved.deinit();
        const source_page = preserved.page();
        const page_capacity = source_page.exactRowCapacity(y_start, y_end);
        var native_page = try TerminalPage.init(page_capacity);
        defer native_page.deinit();
        native_page.size.rows = y_end - y_start;
        try native_page.cloneFrom(source_page, y_start, y_end);

        const record_offset: u64 = @intCast(page_records.written().len);
        try SnapshotPage.encode(&native_page, &record_writer);
        const record_end: u64 = @intCast(page_records.written().len);
        try pages.append(alloc, .{
            .record_offset = record_offset,
            .record_len = record_end - record_offset,
            .first_row = page_first_row,
            .columns = source_page.size.cols,
            .rows = y_end - y_start,
        });
        const bounded_metadata_len = try std.math.add(
            usize,
            archive_header_len,
            try std.math.add(
                usize,
                try std.math.mul(usize, pages.items.len, archive_page_len),
                try std.math.mul(usize, expected.physical_rows, archive_row_len),
            ),
        );
        if (try std.math.add(usize, bounded_metadata_len, page_records.written().len) > maximum_bytes) {
            return error.ArchiveTooLarge;
        }
    }
    if (previous_wraps or rows.items.len != expected.physical_rows) {
        return error.InvalidContinuation;
    }
    markSimpleNarrowLines(rows.items);

    const metadata_len = try std.math.add(
        usize,
        archive_header_len,
        try std.math.add(
            usize,
            try std.math.mul(usize, pages.items.len, archive_page_len),
            try std.math.mul(usize, rows.items.len, archive_row_len),
        ),
    );
    if (try std.math.add(usize, metadata_len, page_records.written().len) > maximum_bytes) {
        return error.ArchiveTooLarge;
    }
    var destination: std.Io.Writer.Allocating = try .initCapacity(
        alloc,
        metadata_len + page_records.written().len,
    );
    errdefer destination.deinit();
    try destination.writer.writeAll(archive_magic);
    try destination.writer.writeInt(u16, archive_version, .little);
    try destination.writer.writeInt(u16, archive_header_len, .little);
    try destination.writer.writeInt(u32, @intCast(pages.items.len), .little);
    try destination.writer.writeInt(u64, @intCast(rows.items.len), .little);
    try destination.writer.writeInt(u64, first_logical_line_id, .little);
    try destination.writer.writeInt(u64, logical_line_id, .little);
    try destination.writer.writeInt(u64, expected.physical_rows, .little);
    for (pages.items) |page| {
        try destination.writer.writeInt(
            u64,
            @as(u64, @intCast(metadata_len)) + page.record_offset,
            .little,
        );
        try destination.writer.writeInt(u64, page.record_len, .little);
        try destination.writer.writeInt(u64, page.first_row, .little);
        try destination.writer.writeInt(u16, page.columns, .little);
        try destination.writer.writeInt(u16, page.rows, .little);
        try destination.writer.writeInt(u32, 0, .little);
    }
    for (rows.items) |row| {
        try destination.writer.writeInt(u64, row.logical_line_id, .little);
        try destination.writer.writeInt(u32, row.logical_cell_offset, .little);
        try destination.writer.writeInt(u32, row.logical_cell_span, .little);
        try destination.writer.writeInt(u32, row.page_index, .little);
        try destination.writer.writeInt(u16, row.page_row, .little);
        try destination.writer.writeInt(u16, row.columns, .little);
        const flags: u8 = @intFromBool(row.wraps) |
            (@as(u8, @intFromBool(row.continues)) << 1) |
            (@as(u8, @intFromBool(row.line_simple_narrow)) << 2);
        try destination.writer.writeByte(flags);
        try destination.writer.writeAll(&.{ 0, 0, 0, 0, 0, 0, 0 });
    }
    try destination.writer.writeAll(page_records.written());
    return .{
        .bytes = destination.toArrayList(),
        .next_logical_line_id = logical_line_id,
    };
}

const LogicalRowMetrics = struct {
    span: u32,
    simple_narrow: bool,
};

fn logicalRowMetrics(pin: PageList.Pin) LogicalRowMetrics {
    const row_and_cell = pin.rowAndCell();
    const row = row_and_cell.row;
    const cells = pin.cells(.all);
    var end = cells.len;
    if (!row.wrap) {
        while (end > 0 and cells[end - 1].isEmpty()) end -= 1;
        if (end == 0 and row.semantic_prompt != .none) end = 1;
    }
    var span: u32 = 0;
    var simple_narrow = true;
    var x: usize = 0;
    while (x < end) {
        const cell = cells[x];
        switch (cell.wide) {
            .narrow => {
                span += 1;
                x += 1;
            },
            .wide => {
                simple_narrow = false;
                span += 2;
                x += @min(@as(usize, 2), end - x);
            },
            .spacer_tail, .spacer_head => {
                simple_narrow = false;
                x += 1;
            },
        }
    }
    return .{ .span = span, .simple_narrow = simple_narrow };
}

fn logicalRowSpan(pin: PageList.Pin) u32 {
    return logicalRowMetrics(pin).span;
}

fn markSimpleNarrowLines(rows: []ArchiveRow) void {
    var line_start: usize = 0;
    while (line_start < rows.len) {
        const logical_line_id = rows[line_start].logical_line_id;
        var line_end = line_start;
        var simple_narrow = true;
        while (line_end < rows.len and rows[line_end].logical_line_id == logical_line_id) : (line_end += 1) {
            simple_narrow = simple_narrow and rows[line_end].line_simple_narrow;
        }
        for (rows[line_start..line_end]) |*row| row.line_simple_narrow = simple_narrow;
        line_start = line_end;
    }
}

fn validateHistoryPrefix(
    list: *PageList,
    tracked_reference: *tracked.TrackedGridRef,
    expected: HistoryPrefix,
) !void {
    const active = list.getTopLeft(.active);
    const first = list.getTopLeft(.screen).node;
    if (first.serial != expected.first_serial) return error.StalePrefix;
    var iterator = tracked_reference.pin.*.rowIterator(.right_down, null);
    var last_pin = iterator.next() orelse return error.StalePrefix;
    for (1..expected.physical_rows) |_| {
        last_pin = iterator.next() orelse return error.StalePrefix;
    }
    const last_row = last_pin.rowAndCell().row;
    const successor = iterator.next() orelse return error.StalePrefix;
    if (last_pin.node.serial != expected.last_serial or
        last_pin.y != expected.last_y or
        last_row.wrap or
        successor.node.serial != expected.successor_serial or
        successor.y != expected.successor_y or
        expected.history_rows < expected.physical_rows)
    {
        return error.StalePrefix;
    }
    var history_rows: usize = active.y;
    var node = first;
    while (node != active.node) : (node = node.next orelse return error.StalePrefix) {
        history_rows += node.rows();
    }
    if (history_rows != expected.history_rows) return error.StalePrefix;
}

const StoredArchivePage = struct {
    chunk_index: u32,
    record_offset: usize,
    record_len: usize,
    first_row: usize,
    columns: u16,
    rows: u16,
};

const StoredArchiveRow = struct {
    logical_line_id: u64,
    logical_cell_offset: u32,
    logical_cell_span: u32,
    page_index: u32,
    page_row: u16,
    columns: u16,
    wraps: bool,
    continues: bool,
    line_simple_narrow: bool,
};

const HistoryArchive = struct {
    chunks: std.ArrayList([]u8) = .empty,
    pages: std.ArrayList(StoredArchivePage) = .empty,
    rows: std.ArrayList(StoredArchiveRow) = .empty,
    first_logical_line_id: u64 = 0,
    next_logical_line_id: u64 = 0,
    uniform_columns: ?u16 = null,
    all_simple_narrow: bool = true,

    fn deinit(self: *HistoryArchive) void {
        const alloc = std.heap.c_allocator;
        for (self.chunks.items) |bytes| alloc.free(bytes);
        self.chunks.deinit(alloc);
        self.pages.deinit(alloc);
        self.rows.deinit(alloc);
        self.* = undefined;
    }
};

pub export fn hmux_ghostty_history_archive_new(output: ?*?*anyopaque) c_int {
    const destination = output orelse return -100;
    destination.* = null;
    const archive = std.heap.c_allocator.create(HistoryArchive) catch return -2;
    archive.* = .{};
    destination.* = @ptrCast(archive);
    return 0;
}

pub export fn hmux_ghostty_history_archive_free(raw: ?*anyopaque) void {
    const raw_value = raw orelse return;
    const archive: *HistoryArchive = @ptrCast(@alignCast(raw_value));
    archive.deinit();
    std.heap.c_allocator.destroy(archive);
}

pub export fn hmux_ghostty_history_archive_append(
    raw: ?*anyopaque,
    bytes_ptr: ?[*]const u8,
    bytes_len: usize,
) c_int {
    const raw_value = raw orelse return -100;
    const input = bytes_ptr orelse return -100;
    if (bytes_len == 0) return -100;
    const archive: *HistoryArchive = @ptrCast(@alignCast(raw_value));
    appendArchiveChunk(archive, input[0..bytes_len]) catch return -100;
    return 0;
}

pub export fn hmux_ghostty_history_archive_bounds(
    raw: ?*anyopaque,
    first_logical_line_id: ?*u64,
    next_logical_line_id: ?*u64,
    physical_rows: ?*usize,
) c_int {
    const raw_value = raw orelse return -100;
    const first = first_logical_line_id orelse return -100;
    const next = next_logical_line_id orelse return -100;
    const rows = physical_rows orelse return -100;
    const archive: *HistoryArchive = @ptrCast(@alignCast(raw_value));
    first.* = archive.first_logical_line_id;
    next.* = archive.next_logical_line_id;
    rows.* = archive.rows.items.len;
    return 0;
}

/// Validates one encoded PAGE chunk and returns only its bounded metadata.
/// Unlike archive adoption this never clones or retains the payload.
pub export fn hmux_ghostty_history_archive_inspect(
    input: ?[*]const u8,
    bytes_len: usize,
    first_logical_line_id: ?*u64,
    next_logical_line_id: ?*u64,
    physical_rows: ?*usize,
) c_int {
    const bytes = input orelse return -100;
    const first = first_logical_line_id orelse return -100;
    const next = next_logical_line_id orelse return -100;
    const rows = physical_rows orelse return -100;
    var parsed = parseArchiveChunk(bytes[0..bytes_len], false) catch |err| return switch (err) {
        error.OutOfMemory => -2,
        else => -100,
    };
    defer parsed.deinit();
    first.* = parsed.first_logical_line_id;
    next.* = parsed.next_logical_line_id;
    rows.* = parsed.rows.items.len;
    return 0;
}

/// Moves a stable logical anchor through simple native lines by consulting
/// only the archive's engine-produced row index. Complex-width lines stay on
/// the exact PageList projection path instead of accepting an approximate
/// arithmetic anchor.
pub export fn hmux_ghostty_history_archive_move_rows(
    raw: ?*anyopaque,
    anchor_present: u8,
    logical_line_id: u64,
    logical_cell_offset: u32,
    columns: u16,
    delta: i64,
    maximum_line_visits: usize,
    output_anchor_present: ?*u8,
    output_logical_line_id: ?*u64,
    output_logical_cell_offset: ?*u32,
    output_moved_rows: ?*i64,
    output_requires_projection: ?*u8,
    output_budget_exhausted: ?*u8,
    work_output: ?*ArchiveProjectionWork,
) c_int {
    const raw_value = raw orelse return -100;
    const output_present = output_anchor_present orelse return -100;
    const output_line = output_logical_line_id orelse return -100;
    const output_offset = output_logical_cell_offset orelse return -100;
    const output_moved = output_moved_rows orelse return -100;
    const requires_projection = output_requires_projection orelse return -100;
    const budget_exhausted = output_budget_exhausted orelse return -100;
    const work = work_output orelse return -100;
    output_present.* = anchor_present;
    output_line.* = logical_line_id;
    output_offset.* = logical_cell_offset;
    output_moved.* = 0;
    requires_projection.* = 0;
    budget_exhausted.* = 0;
    work.* = std.mem.zeroes(ArchiveProjectionWork);
    if (anchor_present > 1 or columns == 0 or maximum_line_visits == 0 or
        delta == std.math.minInt(i64) or
        (anchor_present == 0 and (logical_line_id != 0 or logical_cell_offset != 0)) or
        (anchor_present == 1 and logical_line_id == 0))
    {
        return -100;
    }
    if (delta == 0) return 0;

    const archive: *HistoryArchive = @ptrCast(@alignCast(raw_value));
    var position: ArchiveMovePosition = if (anchor_present == 0)
        .after_tail
    else
        .{ .anchor = .{
            .logical_line_id = logical_line_id,
            .logical_cell_offset = logical_cell_offset,
        } };
    const magnitude: u64 = if (delta < 0)
        @intCast(-delta)
    else
        @intCast(delta);
    const movement = moveArchiveRows(
        archive,
        &position,
        columns,
        magnitude,
        delta < 0,
        maximum_line_visits,
        work,
    ) catch |err| return switch (err) {
        error.AnchorUnavailable => -4,
        else => -100,
    };
    switch (position) {
        .after_tail => {
            output_present.* = 0;
            output_line.* = 0;
            output_offset.* = 0;
        },
        .anchor => |anchor| {
            output_present.* = 1;
            output_line.* = anchor.logical_line_id;
            output_offset.* = anchor.logical_cell_offset;
        },
    }
    output_moved.* = if (delta < 0)
        -@as(i64, @intCast(movement.moved))
    else
        @intCast(movement.moved);
    requires_projection.* = @intFromBool(movement.requires_projection);
    budget_exhausted.* = @intFromBool(movement.budget_exhausted);
    return 0;
}

/// Materializes only the native PAGE window needed for one viewport, then
/// delegates wrapping and wide-cell behavior to Ghostty's PageList reflow.
pub export fn hmux_ghostty_history_archive_project_grid(
    raw: ?*anyopaque,
    logical_line_id: u64,
    logical_cell_offset: u32,
    columns: u16,
    maximum_rows: usize,
    callback: ?ArchiveRowCallback,
    userdata: ?*anyopaque,
    work_output: ?*ArchiveProjectionWork,
    has_more_before: ?*u8,
    has_more_after: ?*u8,
) c_int {
    const raw_value = raw orelse return -100;
    const visit = callback orelse return -100;
    const work = work_output orelse return -100;
    const before = has_more_before orelse return -100;
    const after = has_more_after orelse return -100;
    work.* = std.mem.zeroes(ArchiveProjectionWork);
    before.* = 0;
    after.* = 0;
    if (columns == 0 or maximum_rows == 0 or maximum_rows > std.math.maxInt(u16)) {
        return -100;
    }
    const archive: *HistoryArchive = @ptrCast(@alignCast(raw_value));
    projectArchiveWindow(
        archive,
        logical_line_id,
        logical_cell_offset,
        columns,
        maximum_rows,
        visit,
        userdata,
        work,
        before,
        after,
    ) catch |err| return switch (err) {
        error.AnchorUnavailable => -4,
        error.OutOfMemory => -2,
        else => -100,
    };
    return 0;
}

const ParsedArchiveChunk = struct {
    bytes: []u8,
    pages: std.ArrayList(StoredArchivePage),
    rows: std.ArrayList(StoredArchiveRow),
    first_logical_line_id: u64,
    next_logical_line_id: u64,

    fn deinit(self: *ParsedArchiveChunk) void {
        const alloc = std.heap.c_allocator;
        if (self.bytes.len > 0) alloc.free(self.bytes);
        self.pages.deinit(alloc);
        self.rows.deinit(alloc);
        self.* = undefined;
    }
};

fn appendArchiveChunk(archive: *HistoryArchive, encoded: []const u8) !void {
    const alloc = std.heap.c_allocator;
    var parsed = try parseArchiveChunk(encoded, true);
    defer parsed.deinit();
    if (archive.rows.items.len > 0) {
        if (parsed.first_logical_line_id != archive.next_logical_line_id) {
            return error.NonContiguousArchive;
        }
    } else if (parsed.first_logical_line_id == 0) {
        return error.InvalidArchive;
    }

    const parsed_columns = parsed.rows.items[0].columns;
    var parsed_uniform_columns: ?u16 = parsed_columns;
    var parsed_all_simple_narrow = true;
    for (parsed.rows.items) |row| {
        if (row.columns != parsed_columns) parsed_uniform_columns = null;
        parsed_all_simple_narrow = parsed_all_simple_narrow and row.line_simple_narrow;
    }
    const archive_was_empty = archive.rows.items.len == 0;

    try archive.chunks.ensureUnusedCapacity(alloc, 1);
    try archive.pages.ensureUnusedCapacity(alloc, parsed.pages.items.len);
    try archive.rows.ensureUnusedCapacity(alloc, parsed.rows.items.len);
    const chunk_index: u32 = @intCast(archive.chunks.items.len);
    const page_base: u32 = @intCast(archive.pages.items.len);
    const row_base = archive.rows.items.len;
    archive.chunks.appendAssumeCapacity(parsed.bytes);
    parsed.bytes = &.{};
    for (parsed.pages.items) |page| {
        archive.pages.appendAssumeCapacity(.{
            .chunk_index = chunk_index,
            .record_offset = page.record_offset,
            .record_len = page.record_len,
            .first_row = row_base + page.first_row,
            .columns = page.columns,
            .rows = page.rows,
        });
    }
    for (parsed.rows.items) |row| {
        var stored = row;
        stored.page_index = try std.math.add(u32, stored.page_index, page_base);
        archive.rows.appendAssumeCapacity(stored);
    }
    if (archive.first_logical_line_id == 0) {
        archive.first_logical_line_id = parsed.first_logical_line_id;
    }
    archive.next_logical_line_id = parsed.next_logical_line_id;
    if (archive_was_empty) {
        archive.uniform_columns = parsed_uniform_columns;
    } else if (archive.uniform_columns == null or parsed_uniform_columns == null or
        archive.uniform_columns.? != parsed_uniform_columns.?)
    {
        archive.uniform_columns = null;
    }
    archive.all_simple_narrow = archive.all_simple_narrow and parsed_all_simple_narrow;
}

fn parseArchiveChunk(encoded: []const u8, retain_bytes: bool) !ParsedArchiveChunk {
    const alloc = std.heap.c_allocator;
    if (encoded.len < archive_header_len or !std.mem.eql(u8, encoded[0..8], archive_magic)) {
        return error.InvalidArchive;
    }
    var cursor: usize = 8;
    const version = try readArchiveInt(u16, encoded, &cursor);
    const header_len = try readArchiveInt(u16, encoded, &cursor);
    const page_count = try readArchiveInt(u32, encoded, &cursor);
    const row_count = try readArchiveInt(u64, encoded, &cursor);
    const first_logical_line_id = try readArchiveInt(u64, encoded, &cursor);
    const next_logical_line_id = try readArchiveInt(u64, encoded, &cursor);
    const physical_rows = try readArchiveInt(u64, encoded, &cursor);
    if (version != archive_version or
        header_len != archive_header_len or
        row_count == 0 or
        row_count != physical_rows or
        first_logical_line_id == 0 or
        next_logical_line_id <= first_logical_line_id)
    {
        return error.InvalidArchive;
    }
    const page_count_usize = std.math.cast(usize, page_count) orelse return error.InvalidArchive;
    const row_count_usize = std.math.cast(usize, row_count) orelse return error.InvalidArchive;
    const metadata_len = try std.math.add(
        usize,
        archive_header_len,
        try std.math.add(
            usize,
            try std.math.mul(usize, page_count_usize, archive_page_len),
            try std.math.mul(usize, row_count_usize, archive_row_len),
        ),
    );
    if (metadata_len > encoded.len) return error.InvalidArchive;

    var pages: std.ArrayList(StoredArchivePage) = .empty;
    errdefer pages.deinit(alloc);
    try pages.ensureTotalCapacity(alloc, page_count_usize);
    var expected_first_row: usize = 0;
    var expected_record_offset = metadata_len;
    for (0..page_count_usize) |_| {
        const record_offset_u64 = try readArchiveInt(u64, encoded, &cursor);
        const record_len_u64 = try readArchiveInt(u64, encoded, &cursor);
        const first_row_u64 = try readArchiveInt(u64, encoded, &cursor);
        const columns = try readArchiveInt(u16, encoded, &cursor);
        const rows = try readArchiveInt(u16, encoded, &cursor);
        const reserved = try readArchiveInt(u32, encoded, &cursor);
        const record_offset = std.math.cast(usize, record_offset_u64) orelse return error.InvalidArchive;
        const record_len = std.math.cast(usize, record_len_u64) orelse return error.InvalidArchive;
        const first_row = std.math.cast(usize, first_row_u64) orelse return error.InvalidArchive;
        const record_end = try std.math.add(usize, record_offset, record_len);
        if (reserved != 0 or columns == 0 or rows == 0 or
            first_row != expected_first_row or record_offset != expected_record_offset or
            record_len == 0 or record_end > encoded.len)
        {
            return error.InvalidArchive;
        }
        var page_reader: std.Io.Reader = .fixed(encoded[record_offset..record_end]);
        try SnapshotPage.discard(&page_reader);
        if (page_reader.bufferedLen() != 0) return error.InvalidArchive;
        pages.appendAssumeCapacity(.{
            .chunk_index = 0,
            .record_offset = record_offset,
            .record_len = record_len,
            .first_row = first_row,
            .columns = columns,
            .rows = rows,
        });
        expected_first_row = try std.math.add(usize, expected_first_row, rows);
        expected_record_offset = record_end;
    }
    if (expected_first_row != row_count_usize or expected_record_offset != encoded.len) {
        return error.InvalidArchive;
    }

    var rows: std.ArrayList(StoredArchiveRow) = .empty;
    errdefer rows.deinit(alloc);
    try rows.ensureTotalCapacity(alloc, row_count_usize);
    var previous_wraps = false;
    var previous_line_simple_narrow = false;
    var expected_line = first_logical_line_id;
    var expected_offset: u32 = 0;
    for (0..row_count_usize) |row_index| {
        const logical_line_id = try readArchiveInt(u64, encoded, &cursor);
        const logical_cell_offset = try readArchiveInt(u32, encoded, &cursor);
        const logical_cell_span = try readArchiveInt(u32, encoded, &cursor);
        const page_index = try readArchiveInt(u32, encoded, &cursor);
        const page_row = try readArchiveInt(u16, encoded, &cursor);
        const columns = try readArchiveInt(u16, encoded, &cursor);
        const flags = try readArchiveInt(u8, encoded, &cursor);
        const reserved = encoded[cursor..][0..7];
        cursor += 7;
        const wraps = flags & 1 != 0;
        const continues = flags & 2 != 0;
        const line_simple_narrow = flags & 4 != 0;
        const page_index_usize = std.math.cast(usize, page_index) orelse return error.InvalidArchive;
        if (page_index_usize >= pages.items.len) return error.InvalidArchive;
        const page = pages.items[page_index_usize];
        if (flags & ~@as(u8, 7) != 0 or !std.mem.allEqual(u8, reserved, 0) or
            logical_line_id != expected_line or logical_cell_offset != expected_offset or
            logical_cell_span > columns or page_row >= page.rows or columns != page.columns or
            page.first_row + page_row != row_index or
            (row_index == 0 and continues) or (row_index > 0 and continues != previous_wraps) or
            (continues and line_simple_narrow != previous_line_simple_narrow))
        {
            return error.InvalidArchive;
        }
        rows.appendAssumeCapacity(.{
            .logical_line_id = logical_line_id,
            .logical_cell_offset = logical_cell_offset,
            .logical_cell_span = logical_cell_span,
            .page_index = page_index,
            .page_row = page_row,
            .columns = columns,
            .wraps = wraps,
            .continues = continues,
            .line_simple_narrow = line_simple_narrow,
        });
        previous_wraps = wraps;
        previous_line_simple_narrow = line_simple_narrow;
        if (wraps) {
            expected_offset = try std.math.add(u32, expected_offset, logical_cell_span);
        } else {
            expected_line = try std.math.add(u64, expected_line, 1);
            expected_offset = 0;
        }
    }
    if (cursor != metadata_len or previous_wraps or expected_line != next_logical_line_id) {
        return error.InvalidArchive;
    }

    return .{
        .bytes = if (retain_bytes) try alloc.dupe(u8, encoded) else &.{},
        .pages = pages,
        .rows = rows,
        .first_logical_line_id = first_logical_line_id,
        .next_logical_line_id = next_logical_line_id,
    };
}

fn readArchiveInt(
    comptime T: type,
    bytes: []const u8,
    cursor: *usize,
) !T {
    const end = try std.math.add(usize, cursor.*, @sizeOf(T));
    if (end > bytes.len) return error.InvalidArchive;
    const value = std.mem.readInt(T, bytes[cursor.*..][0..@sizeOf(T)], .little);
    cursor.* = end;
    return value;
}

const ArchiveWindow = struct {
    first_row: usize,
    end_row: usize,
    source_cell_offset: u32,
};

const ArchiveMoveAnchor = struct {
    logical_line_id: u64,
    logical_cell_offset: u32,
};

const ArchiveMovePosition = union(enum) {
    anchor: ArchiveMoveAnchor,
    after_tail,
};

const ArchiveMoveResult = struct {
    moved: u64,
    requires_projection: bool,
    budget_exhausted: bool,
};

const ArchiveLineBounds = struct {
    logical_line_id: u64,
    cell_span: u32,
    simple_narrow: bool,
};

fn moveArchiveRows(
    archive: *const HistoryArchive,
    position: *ArchiveMovePosition,
    columns: u16,
    requested: u64,
    backwards: bool,
    maximum_line_visits: usize,
    work: *ArchiveProjectionWork,
) !ArchiveMoveResult {
    if (requested == 0) return .{
        .moved = 0,
        .requires_projection = false,
        .budget_exhausted = false,
    };
    if (archive.all_simple_narrow and archive.uniform_columns == columns) {
        if (try moveArchiveRowsAtNativeColumns(
            archive,
            position,
            requested,
            backwards,
            work,
        )) |movement| return movement;
    }
    var remaining = requested;
    var moved: u64 = 0;
    var line_visits: usize = 0;
    while (remaining > 0) {
        if (line_visits >= maximum_line_visits) {
            return .{
                .moved = moved,
                .requires_projection = false,
                .budget_exhausted = true,
            };
        }
        if (backwards) {
            switch (position.*) {
                .after_tail => {
                    if (archive.next_logical_line_id <= archive.first_logical_line_id) break;
                    const line = try archiveLineBounds(
                        archive,
                        archive.next_logical_line_id - 1,
                        work,
                    );
                    line_visits += 1;
                    if (!line.simple_narrow) return .{
                        .moved = moved,
                        .requires_projection = true,
                        .budget_exhausted = false,
                    };
                    position.* = .{ .anchor = .{
                        .logical_line_id = line.logical_line_id,
                        .logical_cell_offset = simpleLineLastOffset(line.cell_span, columns),
                    } };
                    remaining -= 1;
                    moved += 1;
                },
                .anchor => |anchor| {
                    const line = try archiveLineBounds(archive, anchor.logical_line_id, work);
                    line_visits += 1;
                    if (!line.simple_narrow) return .{
                        .moved = moved,
                        .requires_projection = true,
                        .budget_exhausted = false,
                    };
                    try validateSimpleAnchor(line, anchor.logical_cell_offset);
                    const column_width = @as(u32, columns);
                    const rows_before = anchor.logical_cell_offset / column_width +
                        @intFromBool(anchor.logical_cell_offset % column_width != 0);
                    const within = @min(remaining, @as(u64, rows_before));
                    if (within > 0) {
                        const distance = try std.math.mul(u64, within, @as(u64, columns));
                        position.* = .{ .anchor = .{
                            .logical_line_id = anchor.logical_line_id,
                            .logical_cell_offset = anchor.logical_cell_offset -| @as(u32, @intCast(distance)),
                        } };
                        remaining -= within;
                        moved += within;
                        continue;
                    }
                    if (anchor.logical_line_id <= archive.first_logical_line_id) break;
                    if (line_visits >= maximum_line_visits) return .{
                        .moved = moved,
                        .requires_projection = false,
                        .budget_exhausted = true,
                    };
                    const previous = try archiveLineBounds(
                        archive,
                        anchor.logical_line_id - 1,
                        work,
                    );
                    line_visits += 1;
                    if (!previous.simple_narrow) return .{
                        .moved = moved,
                        .requires_projection = true,
                        .budget_exhausted = false,
                    };
                    position.* = .{ .anchor = .{
                        .logical_line_id = previous.logical_line_id,
                        .logical_cell_offset = simpleLineLastOffset(previous.cell_span, columns),
                    } };
                    remaining -= 1;
                    moved += 1;
                },
            }
            continue;
        }

        switch (position.*) {
            .after_tail => break,
            .anchor => |anchor| {
                const line = try archiveLineBounds(archive, anchor.logical_line_id, work);
                line_visits += 1;
                if (!line.simple_narrow) return .{
                    .moved = moved,
                    .requires_projection = true,
                    .budget_exhausted = false,
                };
                try validateSimpleAnchor(line, anchor.logical_cell_offset);
                const rows_after = if (line.cell_span == 0)
                    0
                else
                    (line.cell_span - 1 - anchor.logical_cell_offset) / @as(u32, columns);
                const within = @min(remaining, @as(u64, rows_after));
                if (within > 0) {
                    const distance = try std.math.mul(u64, within, @as(u64, columns));
                    position.* = .{ .anchor = .{
                        .logical_line_id = anchor.logical_line_id,
                        .logical_cell_offset = anchor.logical_cell_offset + @as(u32, @intCast(distance)),
                    } };
                    remaining -= within;
                    moved += within;
                    continue;
                }
                if (anchor.logical_line_id + 1 >= archive.next_logical_line_id) {
                    position.* = .after_tail;
                } else {
                    if (line_visits >= maximum_line_visits) return .{
                        .moved = moved,
                        .requires_projection = false,
                        .budget_exhausted = true,
                    };
                    const next = try archiveLineBounds(archive, anchor.logical_line_id + 1, work);
                    line_visits += 1;
                    if (!next.simple_narrow) return .{
                        .moved = moved,
                        .requires_projection = true,
                        .budget_exhausted = false,
                    };
                    position.* = .{ .anchor = .{
                        .logical_line_id = next.logical_line_id,
                        .logical_cell_offset = 0,
                    } };
                }
                remaining -= 1;
                moved += 1;
            },
        }
    }
    return .{
        .moved = moved,
        .requires_projection = false,
        .budget_exhausted = false,
    };
}

/// When every retained line is narrow and the requested width is the exact
/// engine-produced width, the immutable Ghostty row index is already the
/// reflow result. Jumping by index preserves exact anchors without visiting
/// every intervening logical line.
fn moveArchiveRowsAtNativeColumns(
    archive: *const HistoryArchive,
    position: *ArchiveMovePosition,
    requested: u64,
    backwards: bool,
    work: *ArchiveProjectionWork,
) !?ArchiveMoveResult {
    const rows = archive.rows.items;
    if (rows.len == 0) return error.AnchorUnavailable;
    const maximum_request: u64 = @intCast(rows.len);
    const bounded_request: usize = @intCast(@min(requested, maximum_request));
    const moved: usize = if (backwards) switch (position.*) {
        .after_tail => blk: {
            const count = @min(bounded_request, rows.len);
            position.* = .{ .anchor = archiveRowAnchor(rows[rows.len - count]) };
            break :blk count;
        },
        .anchor => |anchor| blk: {
            const current = archiveRowIndex(rows, anchor, work) orelse return null;
            const count = @min(bounded_request, current);
            position.* = .{ .anchor = archiveRowAnchor(rows[current - count]) };
            break :blk count;
        },
    } else switch (position.*) {
        .after_tail => 0,
        .anchor => |anchor| blk: {
            const current = archiveRowIndex(rows, anchor, work) orelse return null;
            const available = rows.len - current;
            const count = @min(bounded_request, available);
            if (count == available) {
                position.* = .after_tail;
            } else {
                position.* = .{ .anchor = archiveRowAnchor(rows[current + count]) };
            }
            break :blk count;
        },
    };
    return .{
        .moved = @intCast(moved),
        .requires_projection = false,
        .budget_exhausted = false,
    };
}

fn archiveRowAnchor(row: StoredArchiveRow) ArchiveMoveAnchor {
    return .{
        .logical_line_id = row.logical_line_id,
        .logical_cell_offset = row.logical_cell_offset,
    };
}

fn archiveRowIndex(
    rows: []const StoredArchiveRow,
    anchor: ArchiveMoveAnchor,
    work: *ArchiveProjectionWork,
) ?usize {
    var low: usize = 0;
    var high = rows.len;
    while (low < high) {
        const middle = low + (high - low) / 2;
        const row = rows[middle];
        work.index_nodes_visited +|= 1;
        if (row.logical_line_id < anchor.logical_line_id or
            (row.logical_line_id == anchor.logical_line_id and
                row.logical_cell_offset < anchor.logical_cell_offset))
        {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low >= rows.len) return null;
    const row = rows[low];
    return if (row.logical_line_id == anchor.logical_line_id and
        row.logical_cell_offset == anchor.logical_cell_offset)
        low
    else
        null;
}

fn validateSimpleAnchor(
    line: ArchiveLineBounds,
    logical_cell_offset: u32,
) !void {
    if (!line.simple_narrow) return error.ComplexLine;
    if ((line.cell_span == 0 and logical_cell_offset != 0) or
        (line.cell_span > 0 and logical_cell_offset >= line.cell_span))
    {
        return error.AnchorUnavailable;
    }
}

fn simpleLineLastOffset(cell_span: u32, columns: u16) u32 {
    if (cell_span == 0) return 0;
    const column_width = @as(u32, columns);
    return ((cell_span - 1) / column_width) * column_width;
}

fn archiveLineBounds(
    archive: *const HistoryArchive,
    logical_line_id: u64,
    work: *ArchiveProjectionWork,
) !ArchiveLineBounds {
    if (logical_line_id < archive.first_logical_line_id or
        logical_line_id >= archive.next_logical_line_id)
    {
        return error.AnchorUnavailable;
    }
    const first = archiveLineBoundary(archive.rows.items, logical_line_id, false, work);
    const end = archiveLineBoundary(archive.rows.items, logical_line_id, true, work);
    if (first >= end or end > archive.rows.items.len) return error.AnchorUnavailable;
    const first_row = archive.rows.items[first];
    const last_row = archive.rows.items[end - 1];
    if (first_row.logical_line_id != logical_line_id or
        last_row.logical_line_id != logical_line_id or
        first_row.line_simple_narrow != last_row.line_simple_narrow)
    {
        return error.InvalidArchive;
    }
    return .{
        .logical_line_id = logical_line_id,
        .cell_span = try std.math.add(
            u32,
            last_row.logical_cell_offset,
            last_row.logical_cell_span,
        ),
        .simple_narrow = first_row.line_simple_narrow,
    };
}

fn archiveLineBoundary(
    rows: []const StoredArchiveRow,
    logical_line_id: u64,
    after: bool,
    work: *ArchiveProjectionWork,
) usize {
    var low: usize = 0;
    var high = rows.len;
    while (low < high) {
        const middle = low + (high - low) / 2;
        work.index_nodes_visited +|= 1;
        const row_line = rows[middle].logical_line_id;
        if (row_line < logical_line_id or (after and row_line == logical_line_id)) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

fn projectArchiveWindow(
    archive: *HistoryArchive,
    logical_line_id: u64,
    logical_cell_offset: u32,
    columns: u16,
    maximum_rows: usize,
    visit: ArchiveRowCallback,
    userdata: ?*anyopaque,
    work: *ArchiveProjectionWork,
    has_more_before: *u8,
    has_more_after: *u8,
) !void {
    const alloc = std.heap.c_allocator;
    const window = try selectArchiveWindow(
        archive,
        logical_line_id,
        logical_cell_offset,
        columns,
        maximum_rows,
        work,
    );
    has_more_before.* = @intFromBool(
        window.first_row > 0 or
            logical_line_id > archive.first_logical_line_id or
            logical_cell_offset > 0,
    );

    const initial_columns: u16 = if (columns == std.math.maxInt(u16))
        columns - 1
    else
        columns + 1;
    var builder = try PageList.Builder.init(alloc, .{
        .cols = initial_columns,
        .rows = 1,
        .max_size = null,
        .max_lines = null,
    });
    defer builder.deinit();

    var first_destination: ?*TerminalPage = null;
    var page_index = archive.rows.items[window.first_row].page_index;
    const last_page_index = archive.rows.items[window.end_row - 1].page_index;
    while (page_index <= last_page_index) : (page_index += 1) {
        const page_offset = std.math.cast(usize, page_index) orelse return error.InvalidArchive;
        if (page_offset >= archive.pages.items.len) return error.InvalidArchive;
        const page = archive.pages.items[page_offset];
        const page_end_row = try std.math.add(usize, page.first_row, page.rows);
        const selected_start = @max(window.first_row, page.first_row);
        const selected_end = @min(window.end_row, page_end_row);
        if (selected_start >= selected_end) return error.InvalidArchive;
        const local_start = selected_start - page.first_row;
        const local_end = selected_end - page.first_row;

        const chunk_offset = std.math.cast(usize, page.chunk_index) orelse
            return error.InvalidArchive;
        if (chunk_offset >= archive.chunks.items.len) return error.InvalidArchive;
        const chunk = archive.chunks.items[chunk_offset];
        const record_end = try std.math.add(usize, page.record_offset, page.record_len);
        if (record_end > chunk.len) return error.InvalidArchive;
        var reader: std.Io.Reader = .fixed(chunk[page.record_offset..record_end]);
        var decoder: SnapshotPage.Decoder = undefined;
        try decoder.init(&reader);
        var decoded = TerminalPage.init(decoder.capacity()) catch return error.OutOfMemory;
        defer decoded.deinit();
        try decoder.decode(&decoded, alloc);
        if (reader.bufferedLen() != 0 or
            decoded.size.cols != page.columns or
            decoded.size.rows != page.rows)
        {
            return error.InvalidArchive;
        }
        work.cells_visited +|= @as(usize, decoded.size.cols) *| decoded.size.rows;

        const capacity = decoded.exactRowCapacity(local_start, local_end);
        const destination = try builder.allocatePage(capacity);
        destination.size.rows = @intCast(local_end - local_start);
        try destination.cloneFrom(&decoded, @intCast(local_start), @intCast(local_end));
        const selected_cells = @as(usize, page.columns) *| (local_end - local_start);
        // One native visit for the clone and one for PageList reflow.
        work.cells_visited +|= selected_cells *| 2;
        if (first_destination == null) first_destination = destination;
        work.chunks_visited +|= 1;
    }

    const first_row = archive.rows.items[window.first_row];
    const first_page = first_destination orelse return error.InvalidArchive;
    const source_column = try sourceColumnForLogicalOffset(
        first_page,
        first_page.getRow(0),
        window.source_cell_offset,
        first_row.logical_cell_span,
    );
    shiftRowStart(first_page, first_page.getRow(0), source_column);
    work.cells_visited +|= @as(usize, first_page.size.cols) *| 2;

    var list = try builder.finish();
    defer list.deinit();
    const start_pin = list.getTopLeft(.screen);
    const tracked_pin = try list.trackPin(start_pin);
    defer list.untrackPin(tracked_pin);
    try list.resize(.{ .cols = columns, .reflow = true });
    if (tracked_pin.garbage or tracked_pin.x != 0) return error.InvalidArchive;

    var iterator = tracked_pin.*.rowIterator(.right_down, null);
    var projected_rows: usize = 0;
    var projected_line_id = logical_line_id;
    var projected_cell_offset = logical_cell_offset;
    while (projected_rows < maximum_rows) {
        var pin = iterator.next() orelse break;
        pin.x = 0;
        const row = pin.rowAndCell().row;
        const native_columns: u16 = @intCast(pin.cells(.all).len);
        if (native_columns != columns) return error.InvalidArchive;
        const reference = GridRef{
            .size = @sizeOf(GridRef),
            .node = @ptrCast(pin.node),
            .x = 0,
            .y = pin.y,
        };
        if (visit(
            userdata,
            @intCast(projected_rows),
            @intFromBool(row.wrap),
            @intFromBool(if (projected_rows == 0) false else row.wrap_continuation),
            projected_line_id,
            projected_cell_offset,
            &reference,
            native_columns,
        ) != 0) return error.CallbackFailed;
        projected_rows += 1;
        if (row.wrap) {
            projected_cell_offset = try std.math.add(
                u32,
                projected_cell_offset,
                logicalRowSpan(pin),
            );
        } else {
            projected_line_id = try std.math.add(u64, projected_line_id, 1);
            projected_cell_offset = 0;
        }
    }
    const temporary_has_more = projected_rows == maximum_rows and iterator.next() != null;
    work.cells_visited +|= projected_rows *| @as(usize, columns);
    has_more_after.* = @intFromBool(temporary_has_more or window.end_row < archive.rows.items.len);
}

fn selectArchiveWindow(
    archive: *const HistoryArchive,
    logical_line_id: u64,
    logical_cell_offset: u32,
    columns: u16,
    maximum_rows: usize,
    work: *ArchiveProjectionWork,
) !ArchiveWindow {
    if (archive.rows.items.len == 0 or logical_line_id == 0) return error.AnchorUnavailable;
    var low: usize = 0;
    var high = archive.rows.items.len;
    while (low < high) {
        const middle = low + (high - low) / 2;
        const row = archive.rows.items[middle];
        work.index_nodes_visited +|= 1;
        if (row.logical_line_id < logical_line_id or
            (row.logical_line_id == logical_line_id and
                row.logical_cell_offset <= logical_cell_offset))
        {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low == 0) return error.AnchorUnavailable;
    const first_row = low - 1;
    const first = archive.rows.items[first_row];
    const first_end = try std.math.add(u32, first.logical_cell_offset, first.logical_cell_span);
    if (first.logical_line_id != logical_line_id or logical_cell_offset > first_end) {
        return error.AnchorUnavailable;
    }
    const source_cell_offset = logical_cell_offset - first.logical_cell_offset;

    const target_rows = maximum_rows;
    var end_row = first_row;
    var estimated_rows: usize = 0;
    var pending_cells: usize = 0;
    while (end_row < archive.rows.items.len and estimated_rows < target_rows) {
        const row = archive.rows.items[end_row];
        if (end_row > first_row and row.logical_line_id != archive.rows.items[end_row - 1].logical_line_id and
            pending_cells != 0)
        {
            return error.InvalidArchive;
        }
        var span: usize = row.logical_cell_span;
        if (end_row == first_row) span -|= source_cell_offset;
        pending_cells = try std.math.add(usize, pending_cells, span);
        work.index_nodes_visited +|= 1;
        end_row += 1;
        if (!row.wraps) {
            estimated_rows = try std.math.add(
                usize,
                estimated_rows,
                @max(
                    @as(usize, 1),
                    try std.math.divCeil(usize, pending_cells, columns),
                ),
            );
            pending_cells = 0;
        } else {
            const wrapped_rows = try std.math.divCeil(usize, pending_cells, columns);
            if (try std.math.add(usize, estimated_rows, wrapped_rows) >= target_rows) break;
        }
    }
    if (end_row == first_row) return error.AnchorUnavailable;
    return .{
        .first_row = first_row,
        .end_row = end_row,
        .source_cell_offset = source_cell_offset,
    };
}

fn sourceColumnForLogicalOffset(
    page: *const TerminalPage,
    row: *TerminalRow,
    logical_offset: u32,
    logical_span: u32,
) !usize {
    if (logical_offset > logical_span) return error.AnchorUnavailable;
    const cells = page.getCells(row);
    var semantic_offset: u32 = 0;
    var column: usize = 0;
    while (column < cells.len and semantic_offset < logical_span) {
        const cell = cells[column];
        switch (cell.wide) {
            .spacer_head, .spacer_tail => {
                column += 1;
                continue;
            },
            .narrow => {
                if (semantic_offset == logical_offset) return column;
                semantic_offset += 1;
                column += 1;
            },
            .wide => {
                if (semantic_offset == logical_offset or semantic_offset + 1 == logical_offset) {
                    return column;
                }
                semantic_offset += 2;
                column += @min(@as(usize, 2), cells.len - column);
            },
        }
    }
    if (semantic_offset == logical_offset) return column;
    return error.AnchorUnavailable;
}

fn shiftRowStart(page: *TerminalPage, row: *TerminalRow, source_column: usize) void {
    const cells = page.getCells(row);
    if (source_column > cells.len) unreachable;
    if (source_column > 0) {
        page.pauseIntegrityChecks(true);
        defer page.pauseIntegrityChecks(false);
        const remaining = cells.len - source_column;
        for (0..remaining) |column| {
            page.swapCells(&cells[source_column + column], &cells[column]);
        }
        page.clearCells(row, remaining, cells.len);
        row.semantic_prompt = .none;
    }
    row.wrap_continuation = false;
}

/// Selects a bounded immutable history prefix. The last selected row must be
/// a canonical hard break, so ownership never crosses a logical-line boundary.
pub export fn hmux_ghostty_history_prefix_offer(
    reference: tracked.CTrackedGridRef,
    hot_reserve_rows: usize,
    maximum_rows: usize,
    output: ?*HistoryPrefix,
) c_int {
    const offer = output orelse return -100;
    offer.* = std.mem.zeroes(HistoryPrefix);
    const tracked_reference = reference orelse return -100;
    const list = pageList(tracked_reference) orelse return -4;
    if (tracked_reference.pin.garbage or maximum_rows == 0 or hot_reserve_rows == 0) return -4;

    const active = list.getTopLeft(.active);
    var node = list.getTopLeft(.screen).node;
    var complete_history_rows: usize = 0;
    while (node != active.node) : (node = node.next orelse return -100) {
        complete_history_rows += node.rows();
    }
    const history_rows = complete_history_rows + active.y;
    if (history_rows <= hot_reserve_rows) return -4;
    const minimum_rows = history_rows - hot_reserve_rows;
    const maximum_history_rows = @min(maximum_rows, history_rows);
    const first = list.getTopLeft(.screen).node;
    var iterator = tracked_reference.pin.*.rowIterator(.right_down, null);
    var selected_rows: usize = 0;
    var last_node: ?*PageList.List.Node = null;
    var last_y: u16 = 0;
    for (0..maximum_history_rows) |index| {
        const pin = iterator.next() orelse return -100;
        const row = pin.rowAndCell().row;
        if (!row.wrap) {
            selected_rows = index + 1;
            last_node = pin.node;
            last_y = pin.y;
            if (selected_rows >= minimum_rows) break;
        }
    }
    const last = last_node orelse return -4;
    var successor_iterator = tracked_reference.pin.*.rowIterator(.right_down, null);
    for (0..selected_rows) |_| _ = successor_iterator.next() orelse return -100;
    const successor = successor_iterator.next() orelse return -100;
    offer.* = .{
        .first_serial = first.serial,
        .last_serial = last.serial,
        .successor_serial = successor.node.serial,
        .physical_rows = selected_rows,
        .history_rows = history_rows,
        .last_y = last_y,
        .successor_y = successor.y,
    };
    return 0;
}

/// Retires exactly the retained logical prefix named by a prior offer. The two
/// tracked anchors survive canonical reflow, so ACK resolves the prefix in the
/// current geometry instead of treating resize-time row serials as identity.
/// Every identity check happens before PageList's infallible mutation.
pub export fn hmux_ghostty_history_prefix_ack(
    reference: tracked.CTrackedGridRef,
    successor_reference: tracked.CTrackedGridRef,
    expected: HistoryPrefix,
) c_int {
    const tracked_reference = reference orelse return -100;
    const tracked_successor = successor_reference orelse return -100;
    const list = pageList(tracked_reference) orelse return -4;
    const successor_list = pageList(tracked_successor) orelse return -4;
    if (list != successor_list or
        tracked_reference.pin.garbage or
        tracked_successor.pin.garbage or
        tracked_reference.pin.x != 0 or
        tracked_successor.pin.x != 0 or
        expected.physical_rows == 0 or
        expected.history_rows < expected.physical_rows)
    {
        return -4;
    }
    const active = list.getTopLeft(.active);
    const first = list.getTopLeft(.screen);
    if (tracked_reference.pin.node != first.node or tracked_reference.pin.y != first.y) return -4;

    var iterator = tracked_reference.pin.*.rowIterator(.right_down, null);
    var current = iterator.next() orelse return -4;
    var selected_rows: usize = 0;
    var last_pin = current;
    while (current.node != tracked_successor.pin.node or current.y != tracked_successor.pin.y) {
        selected_rows += 1;
        last_pin = current;
        current = iterator.next() orelse return -4;
    }
    if (selected_rows == 0) return -4;
    const last_row = last_pin.rowAndCell().row;
    if (last_row.wrap) return -4;
    const current_history_rows = blk: {
        var total: usize = 0;
        var cursor = first.node;
        while (cursor != active.node) : (cursor = cursor.next orelse return -100) {
            total += cursor.rows();
        }
        break :blk total + active.y;
    };
    if (selected_rows > current_history_rows) return -4;

    list.eraseHistory(.{ .history = .{ .x = 0, .y = @intCast(selected_rows - 1) } });
    const remaining_history_rows = blk: {
        const remaining_active = list.getTopLeft(.active);
        var total: usize = 0;
        var cursor = list.getTopLeft(.screen).node;
        while (cursor != remaining_active.node) : (cursor = cursor.next orelse return -100) {
            total += cursor.rows();
        }
        break :blk total + remaining_active.y;
    };
    if (remaining_history_rows != current_history_rows - selected_rows) return -100;
    return 0;
}

/// Reads only terminal-origin dynamic color overrides. Theme defaults remain
/// absent so each receiving surface can resolve semantic DEFAULT and ordinary
/// palette indices independently.
pub export fn hmux_ghostty_tracked_color_overrides(
    reference: tracked.CTrackedGridRef,
    indexed_rgb: ?[*]u32,
    indexed_present: ?[*]u8,
    indexed_len: usize,
    foreground_rgb: ?*u32,
    foreground_present: ?*u8,
    background_rgb: ?*u32,
    background_present: ?*u8,
    cursor_rgb: ?*u32,
    cursor_present: ?*u8,
) c_int {
    if (indexed_len != 256) return -100;
    const rgb_values = indexed_rgb orelse return -100;
    const present_values = indexed_present orelse return -100;
    const foreground_value = foreground_rgb orelse return -100;
    const foreground_has_value = foreground_present orelse return -100;
    const background_value = background_rgb orelse return -100;
    const background_has_value = background_present orelse return -100;
    const cursor_value = cursor_rgb orelse return -100;
    const cursor_has_value = cursor_present orelse return -100;
    const tracked_reference = reference orelse return -100;
    const wrapper = tracked_reference.terminal orelse return -4;
    const colors = &wrapper.terminal.colors;

    for (0..indexed_len) |index| {
        const overridden = colors.palette.mask.isSet(index);
        present_values[index] = @intFromBool(overridden);
        rgb_values[index] = if (overridden)
            rgbValue(colors.palette.current[index])
        else
            0;
    }
    setOptionalRgb(colors.foreground.override, foreground_value, foreground_has_value);
    setOptionalRgb(colors.background.override, background_value, background_has_value);
    setOptionalRgb(colors.cursor.override, cursor_value, cursor_has_value);
    return 0;
}

/// Walks forward from an already-resolved tracked grid reference.
///
/// Resolving the anchor is kept separate: the caller snapshots its long-lived
/// tracked reference immediately before this call. Once seeded, this iterator
/// visits only the requested rows and never scans or clones preceding history.
pub export fn hmux_ghostty_history_rows_from_grid_ref(
    reference: ?*const GridRef,
    maximum_rows: usize,
    callback: ?RowCallback,
    userdata: ?*anyopaque,
    visited_rows: ?*usize,
    has_more_before: ?*u8,
    has_more_after: ?*u8,
    cursor_row: ?*i32,
    cursor_column: ?*u16,
    cursor_node: ?*anyopaque,
    cursor_y: u16,
    cursor_x: u16,
) c_int {
    const output = visited_rows orelse return -100;
    const before = has_more_before orelse return -100;
    const after = has_more_after orelse return -100;
    const projected_cursor_row = cursor_row orelse return -100;
    const projected_cursor_column = cursor_column orelse return -100;
    output.* = 0;
    before.* = 0;
    after.* = 0;
    projected_cursor_row.* = -1;
    projected_cursor_column.* = 0;
    const start = reference orelse return -100;
    const visit = callback orelse return -100;
    if (start.size < @sizeOf(GridRef) or start.x != 0) return -100;
    const opaque_node = start.node orelse return -100;
    const node: *PageList.List.Node = @ptrCast(@alignCast(opaque_node));
    const start_pin = vt.Pin{
        .node = node,
        .x = 0,
        .y = start.y,
    };
    var before_iterator = start_pin.rowIterator(.left_up, null);
    _ = before_iterator.next() orelse return -100;
    before.* = @intFromBool(before_iterator.next() != null);
    var iterator = start_pin.rowIterator(.right_down, null);

    while (output.* < maximum_rows) {
        var pin = iterator.next() orelse break;
        pin.x = 0;
        const row = pin.rowAndCell().row;
        const columns: u16 = @intCast(pin.cells(.all).len);
        const row_reference = GridRef{
            .size = @sizeOf(GridRef),
            .node = @ptrCast(pin.node),
            .x = 0,
            .y = pin.y,
        };
        const row_index: u16 = @intCast(output.*);
        if (cursor_node != null and @as(?*anyopaque, @ptrCast(pin.node)) == cursor_node and pin.y == cursor_y) {
            projected_cursor_row.* = @intCast(row_index);
            projected_cursor_column.* = cursor_x;
        }
        if (visit(
            userdata,
            row_index,
            @intFromBool(row.wrap),
            @intFromBool(row.wrap_continuation),
            &row_reference,
            columns,
        ) != 0) return -100;
        output.* += 1;
    }
    if (output.* == maximum_rows) {
        after.* = @intFromBool(iterator.next() != null);
    }
    return 0;
}

/// Projects from the current value of a tracked anchor without resolving an
/// absolute screen or history coordinate first.
pub export fn hmux_ghostty_history_rows_from_tracked_ref(
    reference: tracked.CTrackedGridRef,
    maximum_rows: usize,
    callback: ?RowCallback,
    userdata: ?*anyopaque,
    visited_rows: ?*usize,
    has_more_before: ?*u8,
    has_more_after: ?*u8,
    cursor_row: ?*i32,
    cursor_column: ?*u16,
) c_int {
    const tracked_reference = reference orelse return -100;
    const list = pageList(tracked_reference) orelse return -4;
    if (tracked_reference.pin.garbage) return -4;
    _ = list;
    const snapshot = GridRef{
        .size = @sizeOf(GridRef),
        .node = @ptrCast(tracked_reference.pin.node),
        .x = 0,
        .y = tracked_reference.pin.y,
    };
    const wrapper = tracked_reference.terminal orelse return -4;
    const screen = wrapper.terminal.screens.get(tracked_reference.screen_key) orelse return -4;
    const cursor_pin = screen.cursor.page_pin.*;
    return hmux_ghostty_history_rows_from_grid_ref(
        &snapshot,
        maximum_rows,
        callback,
        userdata,
        visited_rows,
        has_more_before,
        has_more_after,
        cursor_row,
        cursor_column,
        @ptrCast(cursor_pin.node),
        cursor_pin.y,
        screen.cursor.x,
    );
}

/// Moves a tracked anchor by a bounded number of physical rows. The returned
/// count reports clamping at either end without converting the anchor to an
/// absolute coordinate.
pub export fn hmux_ghostty_tracked_grid_ref_move_rows(
    reference: tracked.CTrackedGridRef,
    delta: i64,
    moved_rows: ?*i64,
) c_int {
    const moved = moved_rows orelse return -100;
    moved.* = 0;
    const tracked_reference = reference orelse return -100;
    _ = pageList(tracked_reference) orelse return -4;
    if (tracked_reference.pin.garbage) return -4;
    if (delta == 0) return 0;
    if (delta == std.math.minInt(i64)) return -100;

    const direction: PageList.Direction = if (delta < 0) .left_up else .right_down;
    const magnitude: usize = @intCast(if (delta < 0) -delta else delta);
    var iterator = tracked_reference.pin.*.rowIterator(direction, null);
    _ = iterator.next() orelse return -4;
    var target = tracked_reference.pin.*;
    var count: usize = 0;
    while (count < magnitude) : (count += 1) {
        target = iterator.next() orelse break;
    }
    target.x = 0;
    tracked_reference.pin.* = target;
    const signed_count: i64 = @intCast(count);
    moved.* = if (delta < 0) -signed_count else signed_count;
    return 0;
}

fn pageList(reference: *const tracked.TrackedGridRef) ?*PageList {
    const wrapper = reference.terminal orelse return null;
    const terminal = wrapper.terminal;
    if (terminal.screens.generation(reference.screen_key) != reference.screen_generation) {
        return null;
    }
    const screen = terminal.screens.get(reference.screen_key) orelse return null;
    return &screen.pages;
}

fn setOptionalRgb(value: anytype, output: *u32, present: *u8) void {
    if (value) |rgb| {
        output.* = rgbValue(rgb);
        present.* = 1;
    } else {
        output.* = 0;
        present.* = 0;
    }
}

fn rgbValue(rgb: anytype) u32 {
    return (@as(u32, rgb.r) << 16) | (@as(u32, rgb.g) << 8) | @as(u32, rgb.b);
}

// The upstream terminal formatter emits tabstop setup before content without
// restoring the output cursor. A selected active grid has no preceding history
// lines to hide that offset, so keep the native formatters but separate setup.
pub export fn hmux_ghostty_formatter_format_active(
    formatter: vt.hmux_c_api.formatter.Formatter,
    output: ?[*]u8,
    capacity: usize,
    written: *usize,
) c_int {
    const wrapper = formatter orelse return -100;
    const terminal_formatter = switch (wrapper.kind) {
        .terminal => |value| value,
    };
    var writer: std.Io.Writer = .fixed(if (output) |buffer| buffer[0..capacity] else &.{});
    formatActive(terminal_formatter, &writer) catch {
        var discarding: std.Io.Writer.Discarding = .init(&.{});
        formatActive(terminal_formatter, &discarding.writer) catch return -100;
        written.* = @intCast(discarding.count);
        return -3;
    };
    written.* = writer.end;
    return 0;
}

fn formatActive(
    formatter: terminal_module.formatter.TerminalFormatter,
    writer: *std.Io.Writer,
) std.Io.Writer.Error!void {
    var setup = formatter;
    setup.content = .none;
    setup.extra = .none;
    setup.extra.tabstops = formatter.extra.tabstops;
    try setup.format(writer);
    try writer.writeAll("\x1b[0m\x1b[H\x1b[2J");
    var content = formatter;
    content.extra.tabstops = false;
    try content.format(writer);
}
