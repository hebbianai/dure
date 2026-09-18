#[cfg(feature = "supply-stage")]
pub mod supply;

#[cfg(feature = "external-proof")]
mod external {
    use std::cell::RefCell;
    use std::collections::{BTreeMap, VecDeque};
    use std::error::Error;
    use std::ffi::c_void;
    use std::fmt;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};

    const OUT_OF_SPACE: i32 = -3;
    const NO_VALUE: i32 = -4;
    const PROJECTION_CAPACITY_EXCEEDED: i32 = -101;
    const REPLY_CAPACITY: usize = 64 * 1024;
    const CLIPBOARD_CAPACITY: usize = 64 * 1024 + size_of::<u32>();
    const HISTORY_CURSOR_CAPACITY: usize = 1_024;
    const HISTORY_CURSOR_BYTES: usize = 20;
    const HISTORY_CURSOR_MAGIC: [u8; 4] = *b"HGC1";
    static HISTORY_CURSOR_GENERATION: AtomicU64 = AtomicU64::new(1);

    #[repr(C)]
    #[derive(Default)]
    struct NativeMutation {
        reply_len: usize,
        reply_overflow: u8,
        clipboard_len: usize,
        clipboard_overflow: u8,
        dirty_kind: u8,
        projection_degraded: u8,
        dirty_rows: usize,
        visited_rows: usize,
        total_rows: usize,
        scrollback_rows: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct NativeObservation {
        columns: u16,
        rows: u16,
        cursor_column: u16,
        cursor_row: u16,
        alternate_screen: u8,
        cursor_visible: u8,
        application_cursor: u8,
        bracketed_paste: u8,
        total_rows: usize,
        scrollback_rows: usize,
        title_hash: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct NativeHistoryPrefix {
        first_serial: u64,
        last_serial: u64,
        successor_serial: u64,
        physical_rows: usize,
        history_rows: usize,
        last_y: u16,
        successor_y: u16,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
    pub struct NativeHistoryProjectionWork {
        pub index_nodes_visited: usize,
        pub chunks_visited: usize,
        pub cells_visited: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct NativeRgb {
        r: u8,
        g: u8,
        b: u8,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct NativeCellStyle {
        fg_kind: u8,
        fg_value: u32,
        bg_kind: u8,
        bg_value: u32,
        underline_kind: u8,
        underline_value: u32,
        flags: u16,
        underline: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NativeProjectedCell {
        row: u16,
        column: u16,
        width: u8,
        grapheme: *const u8,
        grapheme_len: usize,
        style: NativeCellStyle,
        hyperlink: *const u8,
        hyperlink_len: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NativeProjectionHeader {
        columns: u16,
        rows: u16,
        cursor_column: u16,
        cursor_row: u16,
        alternate_screen: u8,
        cursor_visible: u8,
        cursor_blinking: u8,
        cursor_shape: u8,
        cursor_wrap_pending: u8,
        application_cursor: u8,
        application_keypad: u8,
        bracketed_paste: u8,
        focus_reporting: u8,
        insert_mode: u8,
        origin_mode: u8,
        auto_wrap: u8,
        newline_mode: u8,
        reverse_wrap: u8,
        synchronized_output: u8,
        mouse_tracking: u8,
        mouse_encoding: u8,
        foreground: NativeRgb,
        background: NativeRgb,
        cursor: NativeRgb,
        palette: [NativeRgb; 256],
        title: [u8; TITLE_CAPACITY],
        title_len: u16,
        title_truncated: u8,
    }

    /// Mirrors HMUX_GHOSTTY_TITLE_CAPACITY in the shim.
    const TITLE_CAPACITY: usize = 512;

    impl Default for NativeProjectionHeader {
        fn default() -> Self {
            Self {
                columns: 0,
                rows: 0,
                cursor_column: 0,
                cursor_row: 0,
                alternate_screen: 0,
                cursor_visible: 0,
                cursor_blinking: 0,
                cursor_shape: 0,
                cursor_wrap_pending: 0,
                application_cursor: 0,
                application_keypad: 0,
                bracketed_paste: 0,
                focus_reporting: 0,
                insert_mode: 0,
                origin_mode: 0,
                auto_wrap: 0,
                newline_mode: 0,
                reverse_wrap: 0,
                synchronized_output: 0,
                mouse_tracking: 0,
                mouse_encoding: 0,
                foreground: NativeRgb::default(),
                background: NativeRgb::default(),
                cursor: NativeRgb::default(),
                palette: [NativeRgb::default(); 256],
                title: [0; TITLE_CAPACITY],
                title_len: 0,
                title_truncated: 0,
            }
        }
    }

    unsafe extern "C" {
        fn hmux_ghostty_core_new(
            columns: u16,
            rows: u16,
            history_lines: usize,
            output: *mut *mut c_void,
        ) -> i32;
        fn hmux_ghostty_core_free(core: *mut c_void);
        fn hmux_ghostty_core_write(
            core: *mut c_void,
            bytes: *const u8,
            length: usize,
            reply_buffer: *mut u8,
            reply_capacity: usize,
            clipboard_buffer: *mut u8,
            clipboard_capacity: usize,
            mutation: *mut NativeMutation,
        ) -> i32;
        fn hmux_ghostty_core_resize(
            core: *mut c_void,
            columns: u16,
            rows: u16,
            reply_buffer: *mut u8,
            reply_capacity: usize,
            clipboard_buffer: *mut u8,
            clipboard_capacity: usize,
            mutation: *mut NativeMutation,
        ) -> i32;
        fn hmux_ghostty_core_encode_key(
            core: *mut c_void,
            utf8: *const u8,
            utf8_len: usize,
            code: *const u8,
            code_len: usize,
            modifiers: u32,
            repeat: u8,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_encode_paste(
            core: *mut c_void,
            utf8: *const u8,
            utf8_len: usize,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_encode_focus(
            core: *mut c_void,
            focused: u8,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_encode_pointer(
            core: *mut c_void,
            kind: u32,
            button: u32,
            modifiers: u32,
            wheel_delta_x: i32,
            wheel_delta_y: i32,
            pixel_x: u32,
            pixel_y: u32,
            surface_width: u32,
            surface_height: u32,
            cell_width: u32,
            cell_height: u32,
            padding_top: u32,
            padding_bottom: u32,
            padding_right: u32,
            padding_left: u32,
            pressed_buttons: u32,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_observe(core: *mut c_void, observation: *mut NativeObservation)
        -> i32;
        fn hmux_ghostty_core_content_rows(core: *mut c_void, rows: *mut u16) -> i32;
        fn hmux_ghostty_core_format(
            core: *mut c_void,
            styled: u8,
            active_only: u8,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_snapshot(
            core: *mut c_void,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_cell_hyperlink(
            core: *mut c_void,
            column: u16,
            row: u16,
            buffer: *mut u8,
            capacity: usize,
            written: *mut usize,
        ) -> i32;
        fn hmux_ghostty_core_restore(
            snapshot: *const u8,
            snapshot_length: usize,
            output: *mut *mut c_void,
        ) -> i32;
        fn hmux_ghostty_core_project_active(
            core: *mut c_void,
            header: *mut NativeProjectionHeader,
            row_callback: extern "C" fn(*mut c_void, u16, u8, u8) -> i32,
            cell_callback: extern "C" fn(*mut c_void, *const NativeProjectedCell) -> i32,
            userdata: *mut c_void,
        ) -> i32;
        fn hmux_ghostty_core_projection_header(
            core: *mut c_void,
            header: *mut NativeProjectionHeader,
        ) -> i32;
        fn hmux_ghostty_core_scroll_viewport_row(core: *mut c_void, row: usize) -> i32;
        fn hmux_ghostty_core_history_logical_start(
            core: *mut c_void,
            row: u32,
            start_row: *mut u32,
        ) -> i32;
        fn hmux_ghostty_core_viewport_logical_bounds(
            core: *mut c_void,
            screen_row: *mut u32,
            start_row: *mut u32,
        ) -> i32;
        fn hmux_ghostty_core_track_history_row(
            core: *mut c_void,
            row: u32,
            output: *mut *mut c_void,
        ) -> i32;
        fn hmux_ghostty_core_track_screen_row(
            core: *mut c_void,
            row: u32,
            output: *mut *mut c_void,
        ) -> i32;
        fn hmux_ghostty_core_track_viewport_row(
            core: *mut c_void,
            row: u16,
            output: *mut *mut c_void,
        ) -> i32;
        fn hmux_ghostty_screen_anchor_project(
            anchor: *mut c_void,
            columns: u16,
            maximum_rows: usize,
            row_callback: extern "C" fn(*mut c_void, u16, u8, u8) -> i32,
            cell_callback: extern "C" fn(*mut c_void, *const NativeProjectedCell) -> i32,
            userdata: *mut c_void,
            visited_rows: *mut usize,
            has_more_before: *mut u8,
            has_more_after: *mut u8,
            cursor_row: *mut i32,
            cursor_column: *mut u16,
        ) -> i32;
        fn hmux_ghostty_screen_anchor_index_rows(
            anchor: *mut c_void,
            maximum_rows: usize,
            row_callback: extern "C" fn(*mut c_void, u16, u8, u8) -> i32,
            userdata: *mut c_void,
            visited_rows: *mut usize,
            has_more_before: *mut u8,
            has_more_after: *mut u8,
            cursor_row: *mut i32,
            cursor_column: *mut u16,
        ) -> i32;
        fn hmux_ghostty_screen_anchor_move_rows(
            anchor: *mut c_void,
            delta: i64,
            moved_rows: *mut i64,
        ) -> i32;
        fn hmux_ghostty_tracked_color_overrides(
            anchor: *mut c_void,
            indexed_rgb: *mut u32,
            indexed_present: *mut u8,
            indexed_len: usize,
            foreground_rgb: *mut u32,
            foreground_present: *mut u8,
            background_rgb: *mut u32,
            background_present: *mut u8,
            cursor_rgb: *mut u32,
            cursor_present: *mut u8,
        ) -> i32;
        fn hmux_ghostty_screen_anchor_row(anchor: *mut c_void, row: *mut u32) -> i32;
        fn hmux_ghostty_seal_primary_screen_as_history(reference: *mut c_void) -> i32;
        fn hmux_ghostty_history_prefix_offer(
            reference: *mut c_void,
            hot_reserve_rows: usize,
            maximum_rows: usize,
            output: *mut NativeHistoryPrefix,
        ) -> i32;
        fn hmux_ghostty_history_prefix_ack(
            reference: *mut c_void,
            successor_reference: *mut c_void,
            expected: NativeHistoryPrefix,
        ) -> i32;
        fn hmux_ghostty_history_prefix_archive(
            reference: *mut c_void,
            expected: NativeHistoryPrefix,
            first_logical_line_id: u64,
            output: *mut u8,
            capacity: usize,
            written: *mut usize,
            next_logical_line_id: *mut u64,
        ) -> i32;
        fn hmux_ghostty_history_archive_new(output: *mut *mut c_void) -> i32;
        fn hmux_ghostty_history_archive_free(archive: *mut c_void);
        fn hmux_ghostty_history_archive_append(
            archive: *mut c_void,
            bytes: *const u8,
            bytes_len: usize,
        ) -> i32;
        fn hmux_ghostty_history_archive_bounds(
            archive: *mut c_void,
            first_logical_line_id: *mut u64,
            next_logical_line_id: *mut u64,
            physical_rows: *mut usize,
        ) -> i32;
        fn hmux_ghostty_history_archive_inspect(
            bytes: *const u8,
            bytes_len: usize,
            first_logical_line_id: *mut u64,
            next_logical_line_id: *mut u64,
            physical_rows: *mut usize,
        ) -> i32;
        fn hmux_ghostty_history_archive_move_rows(
            archive: *mut c_void,
            anchor_present: u8,
            logical_line_id: u64,
            logical_cell_offset: u32,
            columns: u16,
            delta: i64,
            maximum_line_visits: usize,
            output_anchor_present: *mut u8,
            output_logical_line_id: *mut u64,
            output_logical_cell_offset: *mut u32,
            output_moved_rows: *mut i64,
            output_requires_projection: *mut u8,
            output_budget_exhausted: *mut u8,
            work: *mut NativeHistoryProjectionWork,
        ) -> i32;
        fn hmux_ghostty_history_archive_project(
            archive: *mut c_void,
            logical_line_id: u64,
            logical_cell_offset: u32,
            columns: u16,
            maximum_rows: usize,
            row_callback: extern "C" fn(*mut c_void, u16, u8, u8, u64, u32) -> i32,
            cell_callback: extern "C" fn(*mut c_void, *const NativeProjectedCell) -> i32,
            userdata: *mut c_void,
            work: *mut NativeHistoryProjectionWork,
            has_more_before: *mut u8,
            has_more_after: *mut u8,
        ) -> i32;
        fn hmux_ghostty_screen_anchor_free(anchor: *mut c_void);
        fn hmux_ghostty_history_cursor_row(cursor: *mut c_void, row: *mut u32) -> i32;
        fn hmux_ghostty_history_cursor_free(cursor: *mut c_void);
    }

    #[derive(Clone, Debug, Eq, Hash, PartialEq)]
    pub enum ProjectedColor {
        Default,
        Palette(u8),
        Rgb(u32),
    }

    #[derive(Clone, Debug, Eq, Hash, PartialEq)]
    pub struct ProjectedStyle {
        pub foreground: ProjectedColor,
        pub background: ProjectedColor,
        pub underline_color: ProjectedColor,
        pub flags: u16,
        pub underline: i32,
        pub hyperlink: String,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ProjectedCell {
        pub text: String,
        pub width: u8,
        pub style: ProjectedStyle,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ProjectedRow {
        pub wraps: bool,
        pub continues: bool,
        pub cells: Vec<ProjectedCell>,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Projection {
        pub columns: u16,
        pub rows: u16,
        pub screen_start_row: usize,
        pub first_logical_start_row: usize,
        pub first_logical_cell_offset: u32,
        pub cursor_column: u16,
        pub cursor_row: u16,
        pub alternate_screen: bool,
        pub cursor_visible: bool,
        pub cursor_blinking: bool,
        pub cursor_shape: u8,
        pub cursor_wrap_pending: bool,
        pub application_cursor: bool,
        pub application_keypad: bool,
        pub bracketed_paste: bool,
        pub focus_reporting: bool,
        pub insert_mode: bool,
        pub origin_mode: bool,
        pub auto_wrap: bool,
        pub newline_mode: bool,
        pub reverse_wrap: bool,
        pub synchronized_output: bool,
        pub mouse_tracking: u8,
        pub mouse_encoding: u8,
        pub foreground_rgb: u32,
        pub background_rgb: u32,
        pub cursor_rgb: u32,
        pub palette_rgb: Vec<u32>,
        pub projected_rows: Vec<ProjectedRow>,
    }

    /// Cell-free presentation metadata for one canonical terminal generation.
    ///
    /// Viewport workers combine this small capture with rows read from their
    /// immutable native snapshot. PTY ingestion never has to materialize the
    /// active screen merely to publish cursor and mode state.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Presentation {
        pub columns: u16,
        pub rows: u16,
        pub cursor_column: u16,
        pub cursor_row: u16,
        pub alternate_screen: bool,
        pub cursor_visible: bool,
        pub cursor_blinking: bool,
        pub cursor_shape: u8,
        pub cursor_wrap_pending: bool,
        pub application_cursor: bool,
        pub application_keypad: bool,
        pub bracketed_paste: bool,
        pub focus_reporting: bool,
        pub insert_mode: bool,
        pub origin_mode: bool,
        pub auto_wrap: bool,
        pub newline_mode: bool,
        pub reverse_wrap: bool,
        pub synchronized_output: bool,
        pub mouse_tracking: u8,
        pub mouse_encoding: u8,
        pub foreground_rgb: u32,
        pub background_rgb: u32,
        pub cursor_rgb: u32,
        pub palette_rgb: Vec<u32>,
        /// The OSC 0/2 window title the program last set; empty when none.
        pub title: String,
        /// True when the title exceeded the FFI header's capacity and `title`
        /// holds only its first bytes.
        pub title_truncated: bool,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ProjectedHistory {
        pub columns: u16,
        pub total_rows: usize,
        pub start_row: usize,
        pub first_logical_start_row: usize,
        pub first_logical_cell_offset: u32,
        pub rows: Vec<ProjectedRow>,
    }

    /// A bounded projection read directly from a tracked engine anchor.
    ///
    /// Unlike `ProjectedHistory`, this never resolves an absolute history
    /// coordinate and never snapshots or restores the terminal. `visited_rows`
    /// is exposed so callers can enforce that extraction stays proportional to
    /// the requested viewport rather than retained history.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct AnchoredProjection {
        pub columns: u16,
        pub rows: Vec<ProjectedRow>,
        pub accounted_bytes: usize,
        pub visited_rows: usize,
        pub has_more_before: bool,
        pub has_more_after: bool,
        pub cursor: Option<(u16, u16)>,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct IndexedScreenRow {
        pub wraps: bool,
        pub continues: bool,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct AnchoredRowIndex {
        pub rows: Vec<IndexedScreenRow>,
        pub visited_rows: usize,
        pub has_more_before: bool,
        pub has_more_after: bool,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct IndexedColorOverride {
        pub index: u8,
        pub rgb: u32,
    }

    #[derive(Clone, Debug, Default, Eq, PartialEq)]
    pub struct ProjectedColorOverrides {
        pub indexed: Vec<IndexedColorOverride>,
        pub default_foreground_rgb: Option<u32>,
        pub default_background_rgb: Option<u32>,
        pub cursor_rgb: Option<u32>,
    }

    struct ProjectionBuilder {
        rows: Vec<ProjectedRow>,
        archive_anchors: Vec<NativeHistoryAnchor>,
        maximum_bytes: usize,
        accounted_bytes: usize,
        preallocated_columns: usize,
        preaccounted_rows: bool,
        capacity_exceeded: bool,
        invalid: bool,
    }

    impl Default for ProjectionBuilder {
        fn default() -> Self {
            Self {
                rows: Vec::new(),
                archive_anchors: Vec::new(),
                maximum_bytes: usize::MAX,
                accounted_bytes: 0,
                preallocated_columns: 0,
                preaccounted_rows: false,
                capacity_exceeded: false,
                invalid: false,
            }
        }
    }

    impl ProjectionBuilder {
        fn bounded(maximum_bytes: usize, columns: usize) -> Self {
            Self {
                maximum_bytes,
                preallocated_columns: columns,
                ..Self::default()
            }
        }

        fn account(&mut self, bytes: usize) -> bool {
            let Some(next) = self.accounted_bytes.checked_add(bytes) else {
                self.capacity_exceeded = true;
                return false;
            };
            if next > self.maximum_bytes {
                self.capacity_exceeded = true;
                return false;
            }
            self.accounted_bytes = next;
            true
        }
    }

    #[derive(Default)]
    struct RowIndexBuilder {
        rows: Vec<IndexedScreenRow>,
        invalid: bool,
    }

    extern "C" fn project_row(userdata: *mut c_void, row: u16, wraps: u8, continues: u8) -> i32 {
        let Some(builder) = (unsafe { (userdata as *mut ProjectionBuilder).as_mut() }) else {
            return -1;
        };
        if builder.invalid || usize::from(row) != builder.rows.len() {
            builder.invalid = true;
            return -1;
        }
        if (!builder.preaccounted_rows && !builder.account(std::mem::size_of::<ProjectedRow>()))
            || builder.rows.try_reserve(1).is_err()
        {
            builder.invalid = true;
            return -1;
        }
        let mut cells = Vec::new();
        let cell_capacity_bytes = builder
            .preallocated_columns
            .saturating_mul(std::mem::size_of::<ProjectedCell>());
        if !builder.account(cell_capacity_bytes)
            || cells
                .try_reserve_exact(builder.preallocated_columns)
                .is_err()
        {
            builder.invalid = true;
            return -1;
        }
        builder.rows.push(ProjectedRow {
            wraps: wraps != 0,
            continues: continues != 0,
            cells,
        });
        0
    }

    extern "C" fn index_row(userdata: *mut c_void, row: u16, wraps: u8, continues: u8) -> i32 {
        let Some(builder) = (unsafe { (userdata as *mut RowIndexBuilder).as_mut() }) else {
            return -1;
        };
        if builder.invalid || usize::from(row) != builder.rows.len() {
            builder.invalid = true;
            return -1;
        }
        if builder.rows.try_reserve(1).is_err() {
            builder.invalid = true;
            return -1;
        }
        builder.rows.push(IndexedScreenRow {
            wraps: wraps != 0,
            continues: continues != 0,
        });
        0
    }

    extern "C" fn project_archive_row(
        userdata: *mut c_void,
        row: u16,
        wraps: u8,
        continues: u8,
        logical_line_id: u64,
        logical_cell_offset: u32,
    ) -> i32 {
        let Some(builder) = (unsafe { (userdata as *mut ProjectionBuilder).as_mut() }) else {
            return -1;
        };
        if builder.invalid
            || usize::from(row) != builder.rows.len()
            || builder.archive_anchors.len() != builder.rows.len()
            || logical_line_id == 0
        {
            builder.invalid = true;
            return -1;
        }
        if !builder.account(
            std::mem::size_of::<ProjectedRow>() + std::mem::size_of::<NativeHistoryAnchor>(),
        ) || builder.rows.try_reserve(1).is_err()
            || builder.archive_anchors.try_reserve(1).is_err()
        {
            builder.invalid = true;
            return -1;
        }
        builder.rows.push(ProjectedRow {
            wraps: wraps != 0,
            continues: continues != 0,
            cells: Vec::new(),
        });
        builder.archive_anchors.push(NativeHistoryAnchor {
            logical_line_id,
            logical_cell_offset,
        });
        0
    }

    extern "C" fn project_cell(userdata: *mut c_void, cell: *const NativeProjectedCell) -> i32 {
        let Some(builder) = (unsafe { (userdata as *mut ProjectionBuilder).as_mut() }) else {
            return -1;
        };
        let Some(cell) = (unsafe { cell.as_ref() }) else {
            builder.invalid = true;
            return -1;
        };
        if builder.invalid
            || cell.grapheme_len > 1024
            || cell.hyperlink_len > 4096
            || cell.width > 2
            || (cell.grapheme_len != 0 && cell.grapheme.is_null())
            || (cell.hyperlink_len != 0 && cell.hyperlink.is_null())
        {
            builder.invalid = true;
            return -1;
        }
        let Some(projected_cells) = builder
            .rows
            .get(usize::from(cell.row))
            .map(|row| row.cells.len())
        else {
            builder.invalid = true;
            return -1;
        };
        if usize::from(cell.column) != projected_cells {
            builder.invalid = true;
            return -1;
        }
        let grapheme = if cell.grapheme_len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(cell.grapheme, cell.grapheme_len) }
        };
        let hyperlink = if cell.hyperlink_len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(cell.hyperlink, cell.hyperlink_len) }
        };
        let Ok(text) = std::str::from_utf8(grapheme) else {
            builder.invalid = true;
            return -1;
        };
        let Ok(hyperlink) = std::str::from_utf8(hyperlink) else {
            builder.invalid = true;
            return -1;
        };
        let style = cell.style;
        let Some(foreground) = projected_color(style.fg_kind, style.fg_value) else {
            builder.invalid = true;
            return -1;
        };
        let Some(background) = projected_color(style.bg_kind, style.bg_value) else {
            builder.invalid = true;
            return -1;
        };
        let Some(underline_color) = projected_color(style.underline_kind, style.underline_value)
        else {
            builder.invalid = true;
            return -1;
        };
        let cell_bytes = usize::from(builder.preallocated_columns == 0)
            .saturating_mul(std::mem::size_of::<ProjectedCell>())
            .saturating_add(cell.grapheme_len)
            .saturating_add(cell.hyperlink_len);
        if !builder.account(cell_bytes) {
            builder.invalid = true;
            return -1;
        }
        let projected_row = &mut builder.rows[usize::from(cell.row)];
        if projected_row.cells.try_reserve(1).is_err() {
            builder.invalid = true;
            return -1;
        }
        projected_row.cells.push(ProjectedCell {
            text: text.to_owned(),
            width: cell.width,
            style: ProjectedStyle {
                foreground,
                background,
                underline_color,
                flags: style.flags,
                underline: style.underline,
                hyperlink: hyperlink.to_owned(),
            },
        });
        0
    }

    fn projected_color(kind: u8, value: u32) -> Option<ProjectedColor> {
        match kind {
            0 => Some(ProjectedColor::Default),
            1 if value <= u32::from(u8::MAX) => Some(ProjectedColor::Palette(value as u8)),
            2 if value <= 0x00ff_ffff => Some(ProjectedColor::Rgb(value)),
            _ => None,
        }
    }

    fn rgb_value(color: NativeRgb) -> u32 {
        (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b)
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum ProjectionKind {
        Clean,
        Partial,
        Full,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Mutation {
        pub replies: Vec<u8>,
        pub reply_overflow: bool,
        pub clipboard_writes: Vec<Vec<u8>>,
        pub clipboard_overflow: bool,
        pub projection: ProjectionKind,
        pub projection_degraded: bool,
        pub dirty_rows: usize,
        pub visited_rows: usize,
        pub total_rows: usize,
        pub scrollback_rows: usize,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct Observation {
        pub columns: u16,
        pub rows: u16,
        pub cursor_column: u16,
        pub cursor_row: u16,
        pub alternate_screen: bool,
        pub cursor_visible: bool,
        pub application_cursor: bool,
        pub bracketed_paste: bool,
        pub total_rows: usize,
        pub scrollback_rows: usize,
        /// Identity of the OSC 0/2 title, so a title-only write compares unequal
        /// to the observation before it and publishes a frame.
        pub title_hash: u64,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct PointerInput {
        pub kind: u32,
        pub button: u32,
        pub modifiers: u32,
        pub wheel_delta_x: i32,
        pub wheel_delta_y: i32,
        pub pixel_x: u32,
        pub pixel_y: u32,
        pub surface_width: u32,
        pub surface_height: u32,
        pub cell_width: u32,
        pub cell_height: u32,
        pub padding_top: u32,
        pub padding_bottom: u32,
        pub padding_right: u32,
        pub padding_left: u32,
        pub pressed_buttons: u32,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum Format {
        Plain,
        StyledVt,
        /// Styled active grid, independent of the scrollable viewport.
        StyledActiveVt,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct ProofError(pub i32);

    impl ProofError {
        #[must_use]
        pub fn is_projection_capacity_exceeded(self) -> bool {
            self.0 == PROJECTION_CAPACITY_EXCEEDED
        }
    }

    impl fmt::Display for ProofError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "libghostty-vt proof ABI returned {}", self.0)
        }
    }

    impl Error for ProofError {}

    pub struct Core {
        raw: NonNull<c_void>,
        history_cursors: RefCell<HistoryCursorStore>,
    }

    pub struct TrackedScreenAnchor {
        raw: NonNull<c_void>,
    }

    pub struct HistoryPrefixOffer {
        pub first_serial: u64,
        pub last_serial: u64,
        pub successor_serial: u64,
        pub physical_rows: usize,
        pub history_rows: usize,
        pub last_y: u16,
        pub successor_y: u16,
        pub anchor: TrackedScreenAnchor,
        pub successor_anchor: TrackedScreenAnchor,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct NativeHistoryArchiveChunk {
        pub bytes: Vec<u8>,
        pub first_logical_line_id: u64,
        pub next_logical_line_id: u64,
        pub physical_rows: usize,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct NativeHistoryArchiveBounds {
        pub first_logical_line_id: u64,
        pub next_logical_line_id: u64,
        pub physical_rows: usize,
    }

    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
    pub struct NativeHistoryAnchor {
        pub logical_line_id: u64,
        pub logical_cell_offset: u32,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct NativeHistoryProjectedRow {
        pub anchor: NativeHistoryAnchor,
        pub row: ProjectedRow,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct NativeHistoryProjection {
        pub columns: u16,
        pub rows: Vec<NativeHistoryProjectedRow>,
        pub work: NativeHistoryProjectionWork,
        pub has_more_before: bool,
        pub has_more_after: bool,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct NativeHistoryMovement {
        pub anchor: Option<NativeHistoryAnchor>,
        pub moved_rows: i64,
        pub work: NativeHistoryProjectionWork,
        pub requires_projection: bool,
        pub budget_exhausted: bool,
    }

    /// Owns durable Ghostty PAGE records and their anchor index inside the
    /// exact-pinned native engine extension. Rust never decodes or duplicates
    /// the archived terminal cells.
    pub struct NativeHistoryArchive {
        raw: NonNull<c_void>,
    }

    impl NativeHistoryArchive {
        pub fn inspect_chunk(bytes: &[u8]) -> Result<NativeHistoryArchiveBounds, ProofError> {
            if bytes.is_empty() {
                return Err(ProofError(-100));
            }
            let mut first_logical_line_id = 0;
            let mut next_logical_line_id = 0;
            let mut physical_rows = 0;
            result(unsafe {
                hmux_ghostty_history_archive_inspect(
                    bytes.as_ptr(),
                    bytes.len(),
                    &mut first_logical_line_id,
                    &mut next_logical_line_id,
                    &mut physical_rows,
                )
            })?;
            Ok(NativeHistoryArchiveBounds {
                first_logical_line_id,
                next_logical_line_id,
                physical_rows,
            })
        }

        pub fn new() -> Result<Self, ProofError> {
            let mut raw = std::ptr::null_mut();
            result(unsafe { hmux_ghostty_history_archive_new(&mut raw) })?;
            Ok(Self {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
            })
        }

        pub fn append(&mut self, bytes: &[u8]) -> Result<(), ProofError> {
            if bytes.is_empty() {
                return Err(ProofError(-100));
            }
            result(unsafe {
                hmux_ghostty_history_archive_append(self.raw.as_ptr(), bytes.as_ptr(), bytes.len())
            })
        }

        pub fn bounds(&self) -> Result<NativeHistoryArchiveBounds, ProofError> {
            let mut first_logical_line_id = 0;
            let mut next_logical_line_id = 0;
            let mut physical_rows = 0;
            result(unsafe {
                hmux_ghostty_history_archive_bounds(
                    self.raw.as_ptr(),
                    &mut first_logical_line_id,
                    &mut next_logical_line_id,
                    &mut physical_rows,
                )
            })?;
            Ok(NativeHistoryArchiveBounds {
                first_logical_line_id,
                next_logical_line_id,
                physical_rows,
            })
        }

        pub fn move_rows(
            &self,
            anchor: Option<NativeHistoryAnchor>,
            columns: u16,
            delta: i64,
            maximum_line_visits: usize,
        ) -> Result<NativeHistoryMovement, ProofError> {
            if columns == 0 || delta == i64::MIN || maximum_line_visits == 0 {
                return Err(ProofError(-100));
            }
            let (anchor_present, logical_line_id, logical_cell_offset) = anchor
                .map_or((0, 0, 0), |anchor| {
                    (1, anchor.logical_line_id, anchor.logical_cell_offset)
                });
            if anchor_present == 1 && logical_line_id == 0 {
                return Err(ProofError(-100));
            }
            let mut output_anchor_present = anchor_present;
            let mut output_logical_line_id = logical_line_id;
            let mut output_logical_cell_offset = logical_cell_offset;
            let mut moved_rows = 0;
            let mut requires_projection = 0;
            let mut budget_exhausted = 0;
            let mut work = NativeHistoryProjectionWork::default();
            result(unsafe {
                hmux_ghostty_history_archive_move_rows(
                    self.raw.as_ptr(),
                    anchor_present,
                    logical_line_id,
                    logical_cell_offset,
                    columns,
                    delta,
                    maximum_line_visits,
                    &mut output_anchor_present,
                    &mut output_logical_line_id,
                    &mut output_logical_cell_offset,
                    &mut moved_rows,
                    &mut requires_projection,
                    &mut budget_exhausted,
                    &mut work,
                )
            })?;
            let anchor = match output_anchor_present {
                0 if output_logical_line_id == 0 && output_logical_cell_offset == 0 => None,
                1 if output_logical_line_id != 0 => Some(NativeHistoryAnchor {
                    logical_line_id: output_logical_line_id,
                    logical_cell_offset: output_logical_cell_offset,
                }),
                _ => return Err(ProofError(-100)),
            };
            if (moved_rows != 0 && moved_rows.signum() != delta.signum())
                || moved_rows.unsigned_abs() > delta.unsigned_abs()
                || requires_projection > 1
                || budget_exhausted > 1
                || (requires_projection == 1 && budget_exhausted == 1)
            {
                return Err(ProofError(-100));
            }
            Ok(NativeHistoryMovement {
                anchor,
                moved_rows,
                work,
                requires_projection: requires_projection == 1,
                budget_exhausted: budget_exhausted == 1,
            })
        }

        pub fn project(
            &self,
            anchor: NativeHistoryAnchor,
            columns: u16,
            maximum_rows: usize,
        ) -> Result<NativeHistoryProjection, ProofError> {
            if anchor.logical_line_id == 0
                || columns == 0
                || maximum_rows == 0
                || maximum_rows > usize::from(u16::MAX)
            {
                return Err(ProofError(-100));
            }
            let mut builder = ProjectionBuilder::default();
            builder.rows.reserve(maximum_rows);
            builder.archive_anchors.reserve(maximum_rows);
            let mut work = NativeHistoryProjectionWork::default();
            let mut has_more_before = 0;
            let mut has_more_after = 0;
            result(unsafe {
                hmux_ghostty_history_archive_project(
                    self.raw.as_ptr(),
                    anchor.logical_line_id,
                    anchor.logical_cell_offset,
                    columns,
                    maximum_rows,
                    project_archive_row,
                    project_cell,
                    std::ptr::addr_of_mut!(builder).cast(),
                    &mut work,
                    &mut has_more_before,
                    &mut has_more_after,
                )
            })?;
            if builder.invalid
                || builder.rows.len() != builder.archive_anchors.len()
                || builder.rows.len() > maximum_rows
                || has_more_before > 1
                || has_more_after > 1
                || builder
                    .rows
                    .iter()
                    .any(|row| row.cells.len() != usize::from(columns))
            {
                return Err(ProofError(-100));
            }
            let rows = builder
                .archive_anchors
                .into_iter()
                .zip(builder.rows)
                .map(|(anchor, row)| NativeHistoryProjectedRow { anchor, row })
                .collect();
            Ok(NativeHistoryProjection {
                columns,
                rows,
                work,
                has_more_before: has_more_before != 0,
                has_more_after: has_more_after != 0,
            })
        }
    }

    impl Drop for NativeHistoryArchive {
        fn drop(&mut self) {
            unsafe { hmux_ghostty_history_archive_free(self.raw.as_ptr()) };
        }
    }

    // The archive moves with its single owning Host terminal actor.
    unsafe impl Send for NativeHistoryArchive {}

    impl HistoryPrefixOffer {
        fn native(&self) -> NativeHistoryPrefix {
            NativeHistoryPrefix {
                first_serial: self.first_serial,
                last_serial: self.last_serial,
                successor_serial: self.successor_serial,
                physical_rows: self.physical_rows,
                history_rows: self.history_rows,
                last_y: self.last_y,
                successor_y: self.successor_y,
            }
        }

        pub fn encode_native_archive(
            &self,
            first_logical_line_id: u64,
            maximum_bytes: usize,
        ) -> Result<NativeHistoryArchiveChunk, ProofError> {
            if first_logical_line_id == 0 || maximum_bytes == 0 {
                return Err(ProofError(-100));
            }
            // One bounded native encode replaces the former size-query plus
            // second full encode. The Ghostty side rejects metadata/PAGE
            // growth at this capacity before constructing the final archive.
            let mut bytes = Vec::with_capacity(maximum_bytes);
            let mut written = 0;
            let mut next_logical_line_id = 0;
            result(unsafe {
                hmux_ghostty_history_prefix_archive(
                    self.anchor.raw.as_ptr(),
                    self.native(),
                    first_logical_line_id,
                    bytes.as_mut_ptr(),
                    bytes.capacity(),
                    &mut written,
                    &mut next_logical_line_id,
                )
            })?;
            if written == 0
                || written > maximum_bytes
                || next_logical_line_id <= first_logical_line_id
            {
                return Err(ProofError(-100));
            }
            unsafe { bytes.set_len(written) };
            Ok(NativeHistoryArchiveChunk {
                bytes,
                first_logical_line_id,
                next_logical_line_id,
                physical_rows: self.physical_rows,
            })
        }
    }

    struct HistoryCursorStore {
        generation: u64,
        next_id: u64,
        references: BTreeMap<u64, HistoryCursorReference>,
        order: VecDeque<u64>,
    }

    struct HistoryCursorReference {
        raw: NonNull<c_void>,
        after: bool,
    }

    // The proof core is moved into one Host terminal actor and is never shared.
    // libghostty-vt itself creates no background terminal mutation thread.
    unsafe impl Send for Core {}
    // The Host resolves and drops anchors only while holding the owning
    // terminal actor. Moving the opaque handle between actor messages does not
    // invoke a libghostty-vt operation by itself.
    unsafe impl Send for TrackedScreenAnchor {}

    impl TrackedScreenAnchor {
        pub fn screen_row(&self) -> Result<Option<usize>, ProofError> {
            let mut row = 0_u32;
            let status = unsafe { hmux_ghostty_screen_anchor_row(self.raw.as_ptr(), &mut row) };
            if status == NO_VALUE {
                return Ok(None);
            }
            result(status)?;
            Ok(Some(row as usize))
        }

        pub fn project_rows(
            &self,
            columns: u16,
            maximum_rows: usize,
        ) -> Result<AnchoredProjection, ProofError> {
            self.project_rows_with_budget(columns, maximum_rows, usize::MAX)
        }

        pub fn project_rows_with_budget(
            &self,
            columns: u16,
            maximum_rows: usize,
            maximum_bytes: usize,
        ) -> Result<AnchoredProjection, ProofError> {
            if columns == 0 || maximum_rows > usize::from(u16::MAX) {
                return Err(ProofError(-100));
            }
            let mut builder = ProjectionBuilder::bounded(maximum_bytes, usize::from(columns));
            let row_bytes = maximum_rows.saturating_mul(std::mem::size_of::<ProjectedRow>());
            if !builder.account(row_bytes) || builder.rows.try_reserve_exact(maximum_rows).is_err()
            {
                return Err(ProofError(PROJECTION_CAPACITY_EXCEEDED));
            }
            builder.preaccounted_rows = true;
            let mut visited_rows = 0;
            let mut has_more_before = 0;
            let mut has_more_after = 0;
            let mut cursor_row = -1;
            let mut cursor_column = 0;
            let status = unsafe {
                hmux_ghostty_screen_anchor_project(
                    self.raw.as_ptr(),
                    columns,
                    maximum_rows,
                    project_row,
                    project_cell,
                    std::ptr::addr_of_mut!(builder).cast(),
                    &mut visited_rows,
                    &mut has_more_before,
                    &mut has_more_after,
                    &mut cursor_row,
                    &mut cursor_column,
                )
            };
            if builder.capacity_exceeded {
                return Err(ProofError(PROJECTION_CAPACITY_EXCEEDED));
            }
            result(status)?;
            if builder.invalid
                || visited_rows != builder.rows.len()
                || visited_rows > maximum_rows
                || has_more_before > 1
                || has_more_after > 1
                || cursor_row < -1
                || cursor_row >= i32::try_from(visited_rows).map_err(|_| ProofError(-100))?
                || (cursor_row >= 0 && cursor_column >= columns)
            {
                return Err(ProofError(-100));
            }
            Ok(AnchoredProjection {
                columns,
                rows: builder.rows,
                accounted_bytes: builder.accounted_bytes,
                visited_rows,
                has_more_before: has_more_before != 0,
                has_more_after: has_more_after != 0,
                cursor: (cursor_row >= 0).then_some((cursor_row as u16, cursor_column)),
            })
        }

        pub fn index_rows(&self, maximum_rows: usize) -> Result<AnchoredRowIndex, ProofError> {
            if maximum_rows > usize::from(u16::MAX) {
                return Err(ProofError(-100));
            }
            let mut builder = RowIndexBuilder::default();
            builder.rows.reserve(maximum_rows);
            let mut visited_rows = 0;
            let mut has_more_before = 0;
            let mut has_more_after = 0;
            let mut cursor_row = -1;
            let mut cursor_column = 0;
            result(unsafe {
                hmux_ghostty_screen_anchor_index_rows(
                    self.raw.as_ptr(),
                    maximum_rows,
                    index_row,
                    (&mut builder as *mut RowIndexBuilder).cast(),
                    &mut visited_rows,
                    &mut has_more_before,
                    &mut has_more_after,
                    &mut cursor_row,
                    &mut cursor_column,
                )
            })?;
            if builder.invalid
                || builder.rows.len() != visited_rows
                || visited_rows > maximum_rows
                || has_more_before > 1
                || has_more_after > 1
                || cursor_row < -1
                || cursor_row >= i32::try_from(visited_rows).map_err(|_| ProofError(-100))?
            {
                return Err(ProofError(-100));
            }
            Ok(AnchoredRowIndex {
                rows: builder.rows,
                visited_rows,
                has_more_before: has_more_before != 0,
                has_more_after: has_more_after != 0,
            })
        }

        pub fn move_rows(&mut self, delta: i64) -> Result<i64, ProofError> {
            let mut moved_rows = 0;
            result(unsafe {
                hmux_ghostty_screen_anchor_move_rows(self.raw.as_ptr(), delta, &mut moved_rows)
            })?;
            if moved_rows.unsigned_abs() > delta.unsigned_abs()
                || (delta > 0 && moved_rows < 0)
                || (delta < 0 && moved_rows > 0)
            {
                return Err(ProofError(-100));
            }
            Ok(moved_rows)
        }

        pub fn color_overrides(&self) -> Result<ProjectedColorOverrides, ProofError> {
            let mut indexed_rgb = [0_u32; 256];
            let mut indexed_present = [0_u8; 256];
            let mut foreground_rgb = 0;
            let mut foreground_present = 0;
            let mut background_rgb = 0;
            let mut background_present = 0;
            let mut cursor_rgb = 0;
            let mut cursor_present = 0;
            result(unsafe {
                hmux_ghostty_tracked_color_overrides(
                    self.raw.as_ptr(),
                    indexed_rgb.as_mut_ptr(),
                    indexed_present.as_mut_ptr(),
                    indexed_rgb.len(),
                    &mut foreground_rgb,
                    &mut foreground_present,
                    &mut background_rgb,
                    &mut background_present,
                    &mut cursor_rgb,
                    &mut cursor_present,
                )
            })?;
            if indexed_present.iter().any(|value| *value > 1)
                || foreground_present > 1
                || background_present > 1
                || cursor_present > 1
                || indexed_rgb.iter().any(|rgb| *rgb > 0x00ff_ffff)
                || foreground_rgb > 0x00ff_ffff
                || background_rgb > 0x00ff_ffff
                || cursor_rgb > 0x00ff_ffff
            {
                return Err(ProofError(-100));
            }
            let indexed = indexed_present
                .into_iter()
                .enumerate()
                .filter_map(|(index, present)| {
                    (present != 0).then_some(IndexedColorOverride {
                        index: index as u8,
                        rgb: indexed_rgb[index],
                    })
                })
                .collect();
            Ok(ProjectedColorOverrides {
                indexed,
                default_foreground_rgb: (foreground_present != 0).then_some(foreground_rgb),
                default_background_rgb: (background_present != 0).then_some(background_rgb),
                cursor_rgb: (cursor_present != 0).then_some(cursor_rgb),
            })
        }
    }

    impl Drop for TrackedScreenAnchor {
        fn drop(&mut self) {
            unsafe { hmux_ghostty_screen_anchor_free(self.raw.as_ptr()) };
        }
    }

    impl Core {
        pub fn new(columns: u16, rows: u16, history_lines: usize) -> Result<Self, ProofError> {
            let mut raw = std::ptr::null_mut();
            // SAFETY: the out pointer is writable and the leaf C shim owns all
            // vendor-specific construction and validation.
            result(unsafe { hmux_ghostty_core_new(columns, rows, history_lines, &mut raw) })?;
            Ok(Self {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
                history_cursors: RefCell::new(HistoryCursorStore::new()?),
            })
        }

        pub fn new_history_supplier(
            columns: u16,
            rows: u16,
            maximum_history_lines: usize,
        ) -> Result<Self, ProofError> {
            Self::new(columns, rows, maximum_history_lines)
        }

        pub fn write(&mut self, bytes: &[u8]) -> Result<Mutation, ProofError> {
            self.mutate(|core, replies, clipboards, native| {
                // SAFETY: all pointers reference live caller-owned buffers for
                // the duration of this synchronous call.
                unsafe {
                    hmux_ghostty_core_write(
                        core,
                        bytes.as_ptr(),
                        bytes.len(),
                        replies.as_mut_ptr(),
                        replies.capacity(),
                        clipboards.as_mut_ptr(),
                        clipboards.capacity(),
                        native,
                    )
                }
            })
        }

        pub fn resize(&mut self, columns: u16, rows: u16) -> Result<Mutation, ProofError> {
            self.mutate(|core, replies, clipboards, native| {
                // SAFETY: all pointers reference live caller-owned buffers for
                // the duration of this synchronous call.
                unsafe {
                    hmux_ghostty_core_resize(
                        core,
                        columns,
                        rows,
                        replies.as_mut_ptr(),
                        replies.capacity(),
                        clipboards.as_mut_ptr(),
                        clipboards.capacity(),
                        native,
                    )
                }
            })
        }

        pub fn encode_key(
            &mut self,
            utf8: &[u8],
            code: &str,
            modifiers: u32,
            repeat: bool,
        ) -> Result<Vec<u8>, ProofError> {
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: all input slices and the optional output allocation
                // remain live for this synchronous engine call.
                unsafe {
                    hmux_ghostty_core_encode_key(
                        self.raw.as_ptr(),
                        utf8.as_ptr(),
                        utf8.len(),
                        code.as_ptr(),
                        code.len(),
                        modifiers,
                        u8::from(repeat),
                        buffer,
                        capacity,
                        written,
                    )
                }
            })
        }

        pub fn encode_paste(&mut self, utf8: &[u8]) -> Result<Vec<u8>, ProofError> {
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: the input slice is immutable; the C adapter makes
                // the private mutable copy required by libghostty-vt.
                unsafe {
                    hmux_ghostty_core_encode_paste(
                        self.raw.as_ptr(),
                        utf8.as_ptr(),
                        utf8.len(),
                        buffer,
                        capacity,
                        written,
                    )
                }
            })
        }

        pub fn encode_focus(&mut self, focused: bool) -> Result<Vec<u8>, ProofError> {
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: the optional output allocation remains live for the
                // synchronous mode-aware focus encoder call.
                unsafe {
                    hmux_ghostty_core_encode_focus(
                        self.raw.as_ptr(),
                        u8::from(focused),
                        buffer,
                        capacity,
                        written,
                    )
                }
            })
        }

        pub fn encode_pointer(&mut self, pointer: PointerInput) -> Result<Vec<u8>, ProofError> {
            const POINTER_OUTPUT_CAPACITY: usize = 8 * 1024;
            let mut output = Vec::with_capacity(POINTER_OUTPUT_CAPACITY);
            let mut written = 0;
            // SAFETY: the core and allocation remain live for this synchronous
            // call; validation caps wheel repetition below the allocation.
            result(unsafe {
                hmux_ghostty_core_encode_pointer(
                    self.raw.as_ptr(),
                    pointer.kind,
                    pointer.button,
                    pointer.modifiers,
                    pointer.wheel_delta_x,
                    pointer.wheel_delta_y,
                    pointer.pixel_x,
                    pointer.pixel_y,
                    pointer.surface_width,
                    pointer.surface_height,
                    pointer.cell_width,
                    pointer.cell_height,
                    pointer.padding_top,
                    pointer.padding_bottom,
                    pointer.padding_right,
                    pointer.padding_left,
                    pointer.pressed_buttons,
                    output.as_mut_ptr(),
                    output.capacity(),
                    &mut written,
                )
            })?;
            if written > output.capacity() {
                return Err(ProofError(-100));
            }
            // SAFETY: the C adapter initialized exactly `written` bytes and
            // the preceding bound check proves they fit this allocation.
            unsafe { output.set_len(written) };
            Ok(output)
        }

        pub fn observe(&self) -> Result<Observation, ProofError> {
            let mut native = NativeObservation::default();
            // SAFETY: the core and output pointer are live for the synchronous call.
            result(unsafe { hmux_ghostty_core_observe(self.raw.as_ptr(), &mut native) })?;
            Ok(Observation {
                columns: native.columns,
                rows: native.rows,
                cursor_column: native.cursor_column,
                cursor_row: native.cursor_row,
                alternate_screen: native.alternate_screen != 0,
                cursor_visible: native.cursor_visible != 0,
                application_cursor: native.application_cursor != 0,
                bracketed_paste: native.bracketed_paste != 0,
                total_rows: native.total_rows,
                scrollback_rows: native.scrollback_rows,
                title_hash: native.title_hash,
            })
        }

        /// Active rows through the cursor or last nonempty cell. Alternate
        /// screens retain their complete geometry, including blank rows.
        pub fn content_rows(&self) -> Result<u16, ProofError> {
            let mut rows = 0;
            // SAFETY: the core and output pointer remain live during the call.
            result(unsafe { hmux_ghostty_core_content_rows(self.raw.as_ptr(), &mut rows) })?;
            Ok(rows)
        }

        pub fn format(&self, format: Format) -> Result<Vec<u8>, ProofError> {
            let styled = u8::from(format != Format::Plain);
            let active_only = u8::from(format == Format::StyledActiveVt);
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: buffer is either null for the size query or writable
                // for capacity bytes, and written is always valid.
                unsafe {
                    hmux_ghostty_core_format(
                        self.raw.as_ptr(),
                        styled,
                        active_only,
                        buffer,
                        capacity,
                        written,
                    )
                }
            })
        }

        pub fn snapshot(&self) -> Result<Vec<u8>, ProofError> {
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: buffer is either null for the size query or writable
                // for capacity bytes, and written is always valid.
                unsafe { hmux_ghostty_core_snapshot(self.raw.as_ptr(), buffer, capacity, written) }
            })
        }

        pub fn cell_hyperlink(&self, column: u16, row: u16) -> Result<Vec<u8>, ProofError> {
            self.variable_output(|buffer, capacity, written| {
                // SAFETY: the opaque core is live and the output buffer follows
                // the same synchronous caller-owned contract as format/snapshot.
                unsafe {
                    hmux_ghostty_core_cell_hyperlink(
                        self.raw.as_ptr(),
                        column,
                        row,
                        buffer,
                        capacity,
                        written,
                    )
                }
            })
        }

        pub fn project_active(&self) -> Result<Projection, ProofError> {
            let mut header = NativeProjectionHeader::default();
            let mut builder = ProjectionBuilder::default();
            result(unsafe {
                hmux_ghostty_core_project_active(
                    self.raw.as_ptr(),
                    &mut header,
                    project_row,
                    project_cell,
                    (&mut builder as *mut ProjectionBuilder).cast(),
                )
            })?;
            if builder.invalid || builder.rows.len() != usize::from(header.rows) {
                return Err(ProofError(-100));
            }
            let mut screen_start_row = 0_u32;
            let mut first_logical_start_row = 0_u32;
            result(unsafe {
                hmux_ghostty_core_viewport_logical_bounds(
                    self.raw.as_ptr(),
                    &mut screen_start_row,
                    &mut first_logical_start_row,
                )
            })?;
            let first_logical_cell_offset = screen_start_row
                .checked_sub(first_logical_start_row)
                .and_then(|rows| rows.checked_mul(u32::from(header.columns)))
                .ok_or(ProofError(-100))?;
            Ok(Projection {
                columns: header.columns,
                rows: header.rows,
                screen_start_row: screen_start_row as usize,
                first_logical_start_row: first_logical_start_row as usize,
                first_logical_cell_offset,
                cursor_column: header.cursor_column,
                cursor_row: header.cursor_row,
                alternate_screen: header.alternate_screen != 0,
                cursor_visible: header.cursor_visible != 0,
                cursor_blinking: header.cursor_blinking != 0,
                cursor_shape: header.cursor_shape,
                cursor_wrap_pending: header.cursor_wrap_pending != 0,
                application_cursor: header.application_cursor != 0,
                application_keypad: header.application_keypad != 0,
                bracketed_paste: header.bracketed_paste != 0,
                focus_reporting: header.focus_reporting != 0,
                insert_mode: header.insert_mode != 0,
                origin_mode: header.origin_mode != 0,
                auto_wrap: header.auto_wrap != 0,
                newline_mode: header.newline_mode != 0,
                reverse_wrap: header.reverse_wrap != 0,
                synchronized_output: header.synchronized_output != 0,
                mouse_tracking: header.mouse_tracking,
                mouse_encoding: header.mouse_encoding,
                foreground_rgb: rgb_value(header.foreground),
                background_rgb: rgb_value(header.background),
                cursor_rgb: rgb_value(header.cursor),
                palette_rgb: header.palette.into_iter().map(rgb_value).collect(),
                projected_rows: builder.rows,
            })
        }

        pub fn presentation(&self) -> Result<Presentation, ProofError> {
            let mut header = NativeProjectionHeader::default();
            result(unsafe { hmux_ghostty_core_projection_header(self.raw.as_ptr(), &mut header) })?;
            Ok(Presentation {
                columns: header.columns,
                rows: header.rows,
                cursor_column: header.cursor_column,
                cursor_row: header.cursor_row,
                alternate_screen: header.alternate_screen != 0,
                cursor_visible: header.cursor_visible != 0,
                cursor_blinking: header.cursor_blinking != 0,
                cursor_shape: header.cursor_shape,
                cursor_wrap_pending: header.cursor_wrap_pending != 0,
                application_cursor: header.application_cursor != 0,
                application_keypad: header.application_keypad != 0,
                bracketed_paste: header.bracketed_paste != 0,
                focus_reporting: header.focus_reporting != 0,
                insert_mode: header.insert_mode != 0,
                origin_mode: header.origin_mode != 0,
                auto_wrap: header.auto_wrap != 0,
                newline_mode: header.newline_mode != 0,
                reverse_wrap: header.reverse_wrap != 0,
                synchronized_output: header.synchronized_output != 0,
                mouse_tracking: header.mouse_tracking,
                mouse_encoding: header.mouse_encoding,
                foreground_rgb: rgb_value(header.foreground),
                background_rgb: rgb_value(header.background),
                cursor_rgb: rgb_value(header.cursor),
                palette_rgb: header.palette.into_iter().map(rgb_value).collect(),
                title: String::from_utf8_lossy(
                    &header.title[..usize::from(header.title_len).min(TITLE_CAPACITY)],
                )
                .into_owned(),
                title_truncated: header.title_truncated != 0,
            })
        }

        /// Reads only a bounded tail from a native snapshot clone. Moving the
        /// clone's viewport cannot alter the Host's canonical follow-tail
        /// presentation or consume the sole live render-state projector.
        pub fn project_history_tail(
            &self,
            maximum_rows: usize,
        ) -> Result<ProjectedHistory, ProofError> {
            let observation = self.observe()?;
            let count = observation.scrollback_rows.min(maximum_rows);
            let start_row = observation.scrollback_rows.saturating_sub(count);
            self.project_history_range(start_row, count)
        }

        /// Projects one bounded absolute history range from an isolated native
        /// snapshot clone. The live terminal keeps follow-tail presentation and
        /// owns every tracked cursor; projection never consumes its render dirt.
        pub fn project_history_range(
            &self,
            start_row: usize,
            maximum_rows: usize,
        ) -> Result<ProjectedHistory, ProofError> {
            let observation = self.observe()?;
            if start_row > observation.scrollback_rows {
                return Err(ProofError(-100));
            }
            let count = observation
                .scrollback_rows
                .saturating_sub(start_row)
                .min(maximum_rows);
            if count == 0 {
                return Ok(ProjectedHistory {
                    columns: observation.columns,
                    total_rows: observation.scrollback_rows,
                    start_row,
                    first_logical_start_row: start_row,
                    first_logical_cell_offset: 0,
                    rows: Vec::new(),
                });
            }
            let start_row_u32 = u32::try_from(start_row).map_err(|_| ProofError(-100))?;
            let mut first_logical_start_row = 0_u32;
            result(unsafe {
                hmux_ghostty_core_history_logical_start(
                    self.raw.as_ptr(),
                    start_row_u32,
                    &mut first_logical_start_row,
                )
            })?;
            let first_logical_start_row = first_logical_start_row as usize;
            let first_logical_cell_offset = start_row
                .checked_sub(first_logical_start_row)
                .and_then(|rows| rows.checked_mul(usize::from(observation.columns)))
                .and_then(|cells| u32::try_from(cells).ok())
                .ok_or(ProofError(-100))?;
            let snapshot = self.snapshot()?;
            let clone = Self::restore(&snapshot)?;
            let mut rows = Vec::with_capacity(count);
            let mut offset = start_row;
            while rows.len() < count {
                result(unsafe {
                    hmux_ghostty_core_scroll_viewport_row(clone.raw.as_ptr(), offset)
                })?;
                let projection = clone.project_active()?;
                let remaining_history = observation.scrollback_rows.saturating_sub(offset);
                let take = remaining_history
                    .min(projection.projected_rows.len())
                    .min(count - rows.len());
                if take == 0 {
                    return Err(ProofError(-100));
                }
                rows.extend(projection.projected_rows.into_iter().take(take));
                offset += take;
            }
            Ok(ProjectedHistory {
                columns: observation.columns,
                total_rows: observation.scrollback_rows,
                start_row,
                first_logical_start_row,
                first_logical_cell_offset,
                rows,
            })
        }

        pub fn track_history_boundary(&self, boundary: usize) -> Result<Vec<u8>, ProofError> {
            let total_rows = self.observe()?.scrollback_rows;
            if total_rows == 0 || boundary > total_rows {
                return Err(ProofError(-100));
            }
            let (row, after) = if boundary == total_rows {
                (boundary - 1, true)
            } else {
                (boundary, false)
            };
            let row = u32::try_from(row).map_err(|_| ProofError(-100))?;
            let mut raw = std::ptr::null_mut();
            result(unsafe {
                hmux_ghostty_core_track_history_row(self.raw.as_ptr(), row, &mut raw)
            })?;
            let reference = NonNull::new(raw).ok_or(ProofError(-100))?;
            self.history_cursors
                .borrow_mut()
                .insert(HistoryCursorReference {
                    raw: reference,
                    after,
                })
        }

        pub fn track_screen_row(&self, row: usize) -> Result<TrackedScreenAnchor, ProofError> {
            let row = u32::try_from(row).map_err(|_| ProofError(-100))?;
            let mut raw = std::ptr::null_mut();
            result(unsafe {
                hmux_ghostty_core_track_screen_row(self.raw.as_ptr(), row, &mut raw)
            })?;
            Ok(TrackedScreenAnchor {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
            })
        }

        pub fn track_history_row(&self, row: usize) -> Result<TrackedScreenAnchor, ProofError> {
            let row = u32::try_from(row).map_err(|_| ProofError(-100))?;
            let mut raw = std::ptr::null_mut();
            result(unsafe {
                hmux_ghostty_core_track_history_row(self.raw.as_ptr(), row, &mut raw)
            })?;
            Ok(TrackedScreenAnchor {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
            })
        }

        pub fn next_history_prefix_offer(
            &self,
            hot_reserve_rows: usize,
            maximum_rows: usize,
        ) -> Result<Option<HistoryPrefixOffer>, ProofError> {
            let observation = self.observe()?;
            if observation.alternate_screen || observation.scrollback_rows == 0 {
                return Ok(None);
            }
            let mut raw = std::ptr::null_mut();
            let status =
                unsafe { hmux_ghostty_core_track_history_row(self.raw.as_ptr(), 0, &mut raw) };
            if status == NO_VALUE {
                return Ok(None);
            }
            result(status)?;
            let anchor = TrackedScreenAnchor {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
            };
            let mut native = NativeHistoryPrefix::default();
            let status = unsafe {
                hmux_ghostty_history_prefix_offer(
                    anchor.raw.as_ptr(),
                    hot_reserve_rows,
                    maximum_rows,
                    &mut native,
                )
            };
            if status == NO_VALUE {
                return Ok(None);
            }
            result(status)?;
            if native.physical_rows == 0
                || native.physical_rows > maximum_rows
                || native.history_rows < native.physical_rows
            {
                return Err(ProofError(-100));
            }
            let successor_anchor = self.track_history_row(native.physical_rows)?;
            Ok(Some(HistoryPrefixOffer {
                first_serial: native.first_serial,
                last_serial: native.last_serial,
                successor_serial: native.successor_serial,
                physical_rows: native.physical_rows,
                history_rows: native.history_rows,
                last_y: native.last_y,
                successor_y: native.successor_y,
                anchor,
                successor_anchor,
            }))
        }

        /// Seals the primary viewport into scrollback on this caller-owned
        /// clone. The operation is intentionally absent from the live write
        /// API so a terminal actor cannot mutate presentation to manufacture
        /// history while the source generation is still authoritative.
        pub fn seal_primary_screen_as_history(&mut self) -> Result<(), ProofError> {
            let anchor = self.track_screen_row(0)?;
            result(unsafe { hmux_ghostty_seal_primary_screen_as_history(anchor.raw.as_ptr()) })
        }

        pub fn acknowledge_history_prefix(
            &mut self,
            offer: &HistoryPrefixOffer,
        ) -> Result<(), ProofError> {
            result(unsafe {
                hmux_ghostty_history_prefix_ack(
                    offer.anchor.raw.as_ptr(),
                    offer.successor_anchor.raw.as_ptr(),
                    offer.native(),
                )
            })
        }

        pub fn track_viewport_row(&self, row: u16) -> Result<TrackedScreenAnchor, ProofError> {
            let mut raw = std::ptr::null_mut();
            result(unsafe {
                hmux_ghostty_core_track_viewport_row(self.raw.as_ptr(), row, &mut raw)
            })?;
            Ok(TrackedScreenAnchor {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
            })
        }

        pub fn resolve_history_cursor(&self, token: &[u8]) -> Result<usize, ProofError> {
            let cursors = self.history_cursors.borrow();
            let reference = cursors.resolve(token)?;
            let mut row = 0_u32;
            result(unsafe { hmux_ghostty_history_cursor_row(reference.raw.as_ptr(), &mut row) })?;
            (row as usize)
                .checked_add(usize::from(reference.after))
                .ok_or(ProofError(-100))
        }

        pub fn restore(snapshot: &[u8]) -> Result<Self, ProofError> {
            let mut raw = std::ptr::null_mut();
            // SAFETY: snapshot remains immutable for the synchronous decode and
            // the output pointer is writable.
            result(unsafe {
                hmux_ghostty_core_restore(snapshot.as_ptr(), snapshot.len(), &mut raw)
            })?;
            Ok(Self {
                raw: NonNull::new(raw).ok_or(ProofError(-100))?,
                history_cursors: RefCell::new(HistoryCursorStore::new()?),
            })
        }

        fn mutate(
            &mut self,
            call: impl FnOnce(*mut c_void, &mut Vec<u8>, &mut Vec<u8>, *mut NativeMutation) -> i32,
        ) -> Result<Mutation, ProofError> {
            let mut replies = Vec::with_capacity(REPLY_CAPACITY);
            let mut clipboards = Vec::with_capacity(CLIPBOARD_CAPACITY);
            let mut native = NativeMutation::default();
            result(call(
                self.raw.as_ptr(),
                &mut replies,
                &mut clipboards,
                &mut native,
            ))?;
            let reply_overflow =
                native.reply_overflow != 0 || native.reply_len > replies.capacity();
            let reply_len = native.reply_len.min(replies.capacity());
            // SAFETY: the C shim initialized exactly reply_len bytes and proved
            // it does not exceed the allocation capacity.
            unsafe { replies.set_len(reply_len) };
            let clipboard_overflow =
                native.clipboard_overflow != 0 || native.clipboard_len > clipboards.capacity();
            let clipboard_len = native.clipboard_len.min(clipboards.capacity());
            // SAFETY: the C shim initialized exactly clipboard_len bytes and
            // proved it does not exceed the allocation capacity.
            unsafe { clipboards.set_len(clipboard_len) };
            let clipboard_writes = decode_clipboard_writes(&clipboards)?;
            let projection = match native.dirty_kind {
                0 => ProjectionKind::Clean,
                1 => ProjectionKind::Partial,
                2 => ProjectionKind::Full,
                _ => return Err(ProofError(-100)),
            };
            if native.projection_degraded > 1 {
                return Err(ProofError(-100));
            }
            Ok(Mutation {
                replies,
                reply_overflow,
                clipboard_writes,
                clipboard_overflow,
                projection,
                projection_degraded: native.projection_degraded != 0,
                dirty_rows: native.dirty_rows,
                visited_rows: native.visited_rows,
                total_rows: native.total_rows,
                scrollback_rows: native.scrollback_rows,
            })
        }

        fn variable_output(
            &self,
            call: impl Fn(*mut u8, usize, *mut usize) -> i32,
        ) -> Result<Vec<u8>, ProofError> {
            let mut required = 0;
            let query = call(std::ptr::null_mut(), 0, &mut required);
            if query != OUT_OF_SPACE && !(query == 0 && required == 0) {
                return Err(ProofError(query));
            }
            let mut output = Vec::with_capacity(required);
            if required == 0 {
                return Ok(output);
            }
            let mut written = 0;
            result(call(output.as_mut_ptr(), output.capacity(), &mut written))?;
            if written > output.capacity() {
                return Err(ProofError(-100));
            }
            // SAFETY: the shim reported success after initializing written bytes.
            unsafe { output.set_len(written) };
            Ok(output)
        }
    }

    impl Drop for Core {
        fn drop(&mut self) {
            for reference in self.history_cursors.get_mut().references.values() {
                unsafe { hmux_ghostty_history_cursor_free(reference.raw.as_ptr()) };
            }
            // SAFETY: this wrapper uniquely owns the opaque handle.
            unsafe { hmux_ghostty_core_free(self.raw.as_ptr()) };
        }
    }

    fn decode_clipboard_writes(mut encoded: &[u8]) -> Result<Vec<Vec<u8>>, ProofError> {
        let mut writes = Vec::new();
        while !encoded.is_empty() {
            let (length, remainder) = encoded
                .split_at_checked(size_of::<u32>())
                .ok_or(ProofError(-100))?;
            let length = usize::try_from(u32::from_le_bytes(
                length.try_into().map_err(|_| ProofError(-100))?,
            ))
            .map_err(|_| ProofError(-100))?;
            let (content, remainder) =
                remainder.split_at_checked(length).ok_or(ProofError(-100))?;
            writes.push(content.to_vec());
            encoded = remainder;
        }
        Ok(writes)
    }

    impl HistoryCursorStore {
        fn new() -> Result<Self, ProofError> {
            let generation = HISTORY_CURSOR_GENERATION
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    current.checked_add(1)
                })
                .map_err(|_| ProofError(-100))?;
            Ok(Self {
                generation,
                next_id: 1,
                references: BTreeMap::new(),
                order: VecDeque::new(),
            })
        }

        fn insert(&mut self, reference: HistoryCursorReference) -> Result<Vec<u8>, ProofError> {
            while self.references.len() >= HISTORY_CURSOR_CAPACITY {
                let Some(oldest) = self.order.pop_front() else {
                    unsafe { hmux_ghostty_history_cursor_free(reference.raw.as_ptr()) };
                    return Err(ProofError(-100));
                };
                if let Some(expired) = self.references.remove(&oldest) {
                    unsafe { hmux_ghostty_history_cursor_free(expired.raw.as_ptr()) };
                }
            }
            let id = self.next_id;
            self.next_id = self.next_id.checked_add(1).ok_or_else(|| {
                unsafe { hmux_ghostty_history_cursor_free(reference.raw.as_ptr()) };
                ProofError(-100)
            })?;
            self.references.insert(id, reference);
            self.order.push_back(id);
            let mut token = Vec::with_capacity(HISTORY_CURSOR_BYTES);
            token.extend_from_slice(&HISTORY_CURSOR_MAGIC);
            token.extend_from_slice(&self.generation.to_be_bytes());
            token.extend_from_slice(&id.to_be_bytes());
            Ok(token)
        }

        fn resolve(&self, token: &[u8]) -> Result<&HistoryCursorReference, ProofError> {
            if token.len() != HISTORY_CURSOR_BYTES || token[..4] != HISTORY_CURSOR_MAGIC {
                return Err(ProofError(-100));
            }
            let generation = u64::from_be_bytes(token[4..12].try_into().unwrap());
            let id = u64::from_be_bytes(token[12..20].try_into().unwrap());
            if generation != self.generation || id == 0 {
                return Err(ProofError(-100));
            }
            self.references.get(&id).ok_or(ProofError(-100))
        }
    }

    fn result(code: i32) -> Result<(), ProofError> {
        if code == 0 {
            Ok(())
        } else {
            Err(ProofError(code))
        }
    }
}

#[cfg(feature = "external-proof")]
pub use external::*;
