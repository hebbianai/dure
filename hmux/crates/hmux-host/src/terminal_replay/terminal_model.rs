use super::TerminalReplayError;
use super::terminal_core::{
    SnapshotRepaint, TerminalCore, TerminalCoreCheckpoint, TerminalCoreCheckpointFormat,
    TerminalCoreWrite,
};
use crate::local_protocol::ScreenSnapshotProfile;
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, GridCell};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags, LineLength};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color, NamedColor};
use std::sync::{Arc, Mutex};

const MAIN_SCREEN: &[u8] = b"\x1b[?1049l";
const ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h";
const RESET_VISIBLE: &[u8] = b"\x1b[?25l\x1b[0m\x1b[?6l\x1b[?7h\x1b[H\x1b[2J";
const RESET_FULL: &[u8] = b"\x1b[?25l\x1b[0m\x1b[?6l\x1b[?7h\x1b[H\x1b[2J\x1b[3J";

#[derive(Clone, Copy)]
struct TerminalSize {
    rows: usize,
    columns: usize,
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

/// Same bound the proof core uses for its reply buffer, so both terminal cores
/// report overflow at the same point.
const PTY_REPLY_CAPACITY: usize = 64 * 1024;

/// Bounded terminal-generated replies, including device and cursor queries.
#[derive(Clone, Default)]
struct PtyReplySink {
    state: Arc<Mutex<PtyReplyState>>,
}

#[derive(Default)]
struct PtyReplyState {
    replies: Vec<u8>,
    overflow: bool,
}

impl PtyReplyState {
    fn push(&mut self, bytes: &[u8]) {
        if self.replies.len().saturating_add(bytes.len()) > PTY_REPLY_CAPACITY {
            self.overflow = true;
            return;
        }
        self.replies.extend_from_slice(bytes);
    }
}

impl PtyReplySink {
    fn take(&self) -> (Vec<u8>, bool) {
        let Ok(mut state) = self.state.lock() else {
            return (Vec::new(), false);
        };
        (
            std::mem::take(&mut state.replies),
            std::mem::replace(&mut state.overflow, false),
        )
    }
}

impl EventListener for PtyReplySink {
    fn send_event(&self, event: Event) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let reply = match event {
            Event::PtyWrite(text) => text,
            _ => return,
        };
        state.push(reply.as_bytes());
    }
}

/// Host-owned terminal state with structured rows and wrap metadata.
///
/// ANSI repaint streams are projections for observers. They are never parsed
/// back into this model during resize, so a lossy projection cannot become the
/// input to a later canonical reflow.
pub(super) struct TerminalModel {
    terminal: Term<PtyReplySink>,
    processor: ansi::Processor,
    replies: PtyReplySink,
}

impl TerminalModel {
    pub fn new(rows: u16, columns: u16, scrollback_rows: usize) -> Self {
        let size = TerminalSize {
            rows: usize::from(rows),
            columns: usize::from(columns),
        };
        let config = Config {
            scrolling_history: scrollback_rows,
            ..Config::default()
        };
        let replies = PtyReplySink::default();
        Self {
            terminal: Term::new(config, &size, replies.clone()),
            processor: ansi::Processor::new(),
            replies,
        }
    }

    pub fn process(&mut self, bytes: &[u8]) -> TerminalCoreWrite {
        self.processor.advance(&mut self.terminal, bytes);
        self.take_replies()
    }

    fn take_replies(&self) -> TerminalCoreWrite {
        let (pty_replies, pty_reply_overflow) = self.replies.take();
        TerminalCoreWrite {
            pty_replies,
            pty_reply_overflow,
            ..TerminalCoreWrite::default()
        }
    }

    pub fn resize(&mut self, rows: u16, columns: u16) {
        self.terminal.resize(TerminalSize {
            rows: usize::from(rows),
            columns: usize::from(columns),
        });
    }

    pub fn size(&self) -> (u16, u16) {
        (
            self.terminal.screen_lines().try_into().unwrap_or(u16::MAX),
            self.terminal.columns().try_into().unwrap_or(u16::MAX),
        )
    }

    pub fn alternate_screen(&self) -> bool {
        self.mode().contains(TermMode::ALT_SCREEN)
    }

    pub fn cursor_visible(&self) -> bool {
        self.mode().contains(TermMode::SHOW_CURSOR)
    }

    #[cfg(test)]
    pub fn application_cursor(&self) -> bool {
        self.mode().contains(TermMode::APP_CURSOR)
    }

    #[cfg(test)]
    pub fn bracketed_paste(&self) -> bool {
        self.mode().contains(TermMode::BRACKETED_PASTE)
    }

    #[cfg(test)]
    pub fn cursor_position(&self) -> (u16, u16) {
        let cursor = self.grid().cursor.point;
        (
            cursor.line.0.try_into().unwrap_or_default(),
            cursor.column.0.try_into().unwrap_or_default(),
        )
    }

    #[cfg(test)]
    pub fn retained_physical_rows(&self) -> usize {
        self.grid().history_size() + self.grid().screen_lines()
    }

    pub fn screen_contents(&self) -> String {
        let grid = self.grid();
        let mut contents = String::new();
        for line in 0..grid.screen_lines() {
            let line = Line(line as i32);
            let cursor_extent = (line == grid.cursor.point.line)
                .then(|| grid.cursor.point.column.0 + usize::from(grid.cursor.input_needs_wrap));
            append_plain_row(&mut contents, grid, line, cursor_extent);
            if !row_wrapped(grid, line) {
                contents.push('\n');
            }
        }
        while contents.ends_with('\n') {
            contents.pop();
        }
        contents
    }

    pub fn repaint(
        &self,
        profile: ScreenSnapshotProfile,
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError> {
        let alternate_screen = self.alternate_screen();
        let history_rows = if alternate_screen {
            0
        } else {
            self.grid().history_size()
        };
        let selector = if alternate_screen {
            ALTERNATE_SCREEN
        } else {
            MAIN_SCREEN
        };
        let suffix = self.repaint_suffix();
        let visible_rows = self.formatted_rows(0, self.grid().screen_lines() as i32);
        let mut visible = Vec::with_capacity(
            selector.len()
                + RESET_VISIBLE.len()
                + visible_rows.iter().map(Vec::len).sum::<usize>()
                + suffix.len(),
        );
        visible.extend_from_slice(selector);
        visible.extend_from_slice(RESET_VISIBLE);
        for row in &visible_rows {
            visible.extend_from_slice(row);
        }
        visible.extend_from_slice(&suffix);

        if visible.len() > maximum {
            return self.truncated_plain_repaint(selector, maximum);
        }

        let viewport_only_skip =
            profile == ScreenSnapshotProfile::ViewportOnly && !alternate_screen && history_rows > 0;
        if alternate_screen || history_rows == 0 || viewport_only_skip {
            return Ok(SnapshotRepaint {
                bytes: visible,
                truncated: false,
                actual_profile: viewport_only_skip.then_some(ScreenSnapshotProfile::ViewportOnly),
            });
        }

        let start_line = -(history_rows as i32);
        let rows = self.formatted_rows(start_line, self.grid().screen_lines() as i32);
        let fixed_bytes = selector.len() + RESET_FULL.len() + suffix.len();
        let mut total_bytes = fixed_bytes + rows.iter().map(Vec::len).sum::<usize>();
        let mut first_row = 0;
        while total_bytes > maximum && first_row < history_rows {
            total_bytes -= rows[first_row].len();
            first_row += 1;
        }
        if total_bytes > maximum {
            return self.truncated_plain_repaint(selector, maximum);
        }

        let mut bytes = Vec::with_capacity(total_bytes);
        bytes.extend_from_slice(selector);
        bytes.extend_from_slice(RESET_FULL);
        for row in &rows[first_row..] {
            bytes.extend_from_slice(row);
        }
        bytes.extend_from_slice(&suffix);
        Ok(SnapshotRepaint {
            bytes,
            truncated: first_row > 0,
            actual_profile: None,
        })
    }

    fn truncated_plain_repaint(
        &self,
        selector: &[u8],
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError> {
        let suffix = self.repaint_suffix();
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

    fn formatted_rows(&self, start_line: i32, end_line: i32) -> Vec<Vec<u8>> {
        let grid = self.grid();
        let mut rows = Vec::with_capacity((end_line - start_line).max(0) as usize);
        let mut previous_wrapped = false;
        for line_number in start_line..end_line {
            let line = Line(line_number);
            let wrapped = row_wrapped(grid, line);
            let last = line_number == end_line - 1;
            let minimum_extent = (line == grid.cursor.point.line)
                .then(|| grid.cursor.point.column.0 + usize::from(grid.cursor.input_needs_wrap));
            rows.push(format_row(
                grid,
                line,
                previous_wrapped,
                wrapped,
                last,
                minimum_extent,
            ));
            previous_wrapped = wrapped;
        }
        rows
    }

    fn repaint_suffix(&self) -> Vec<u8> {
        let grid = self.grid();
        let cursor = grid.cursor.point;
        let row = cursor.line.0.max(0) as usize + 1;
        let column = cursor.column.0 + 1;
        let mut suffix = b"\x1b[0m".to_vec();
        // Origin-mode changes home the cursor in common terminal emulators,
        // so all input modes must be restored before the final position.
        append_input_modes(&mut suffix, *self.mode());
        suffix.extend_from_slice(format!("\x1b[{row};{column}H").as_bytes());
        suffix.extend_from_slice(if self.cursor_visible() {
            b"\x1b[?25h"
        } else {
            b"\x1b[?25l"
        });
        suffix
    }

    fn grid(&self) -> &alacritty_terminal::Grid<Cell> {
        self.terminal.grid()
    }

    fn mode(&self) -> &TermMode {
        self.terminal.mode()
    }
}

impl TerminalCore for TerminalModel {
    fn process(&mut self, bytes: &[u8]) -> Result<TerminalCoreWrite, TerminalReplayError> {
        Ok(self.process(bytes))
    }

    fn resize(
        &mut self,
        rows: u16,
        columns: u16,
    ) -> Result<TerminalCoreWrite, TerminalReplayError> {
        self.resize(rows, columns);
        Ok(self.take_replies())
    }

    fn size(&self) -> (u16, u16) {
        self.size()
    }

    fn alternate_screen(&self) -> bool {
        self.alternate_screen()
    }

    fn cursor_visible(&self) -> bool {
        self.cursor_visible()
    }

    fn screen_contents(&self) -> String {
        self.screen_contents()
    }

    fn repaint(
        &self,
        profile: ScreenSnapshotProfile,
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError> {
        self.repaint(profile, maximum)
    }

    fn checkpoint(&self, maximum: usize) -> Result<TerminalCoreCheckpoint, TerminalReplayError> {
        let repaint = self.repaint(ScreenSnapshotProfile::Full, maximum)?;
        let (rows, columns) = self.size();
        Ok(TerminalCoreCheckpoint {
            format: TerminalCoreCheckpointFormat::LegacyAnsiRedrawV1,
            engine_fingerprint: None,
            rows,
            columns,
            bytes: repaint.bytes,
        })
    }

    #[cfg(test)]
    fn application_cursor(&self) -> bool {
        self.application_cursor()
    }

    #[cfg(test)]
    fn bracketed_paste(&self) -> bool {
        self.bracketed_paste()
    }

    #[cfg(test)]
    fn cursor_position(&self) -> (u16, u16) {
        self.cursor_position()
    }

    #[cfg(test)]
    fn retained_physical_rows(&self) -> usize {
        self.retained_physical_rows()
    }
}

fn append_plain_row(
    contents: &mut String,
    grid: &alacritty_terminal::Grid<Cell>,
    line: Line,
    minimum_extent: Option<usize>,
) {
    let row = &grid[line];
    let extent = row
        .line_length()
        .0
        .max(minimum_extent.unwrap_or_default())
        .min(grid.columns());
    for column in 0..extent {
        let cell = &row[Column(column)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        contents.push(cell.c);
        if let Some(zerowidth) = cell.zerowidth() {
            contents.extend(zerowidth);
        }
    }
}

fn format_row(
    grid: &alacritty_terminal::Grid<Cell>,
    line: Line,
    previous_wrapped: bool,
    wrapped: bool,
    last: bool,
    minimum_extent: Option<usize>,
) -> Vec<u8> {
    let row = &grid[line];
    let mut extent = (0..grid.columns())
        .rev()
        .find(|column| !row[Column(*column)].is_empty())
        .map_or(0, |column| column + 1);
    extent = extent.max(minimum_extent.unwrap_or_default());
    if previous_wrapped {
        // A printable cell is what commits xterm's pending autowrap. An empty
        // continuation row still needs one harmless default space.
        extent = extent.max(1);
    }

    let mut bytes = Vec::new();
    let mut current_style = CellStyle::default();
    for column in 0..extent {
        let cell = &row[Column(column)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let style = CellStyle::from(cell);
        if style != current_style {
            append_style(&mut bytes, style);
            current_style = style;
        }
        let mut encoded = [0; 4];
        bytes.extend_from_slice(cell.c.encode_utf8(&mut encoded).as_bytes());
        if let Some(zerowidth) = cell.zerowidth() {
            for character in zerowidth {
                bytes.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
            }
        }
    }
    if current_style != CellStyle::default() {
        bytes.extend_from_slice(b"\x1b[0m");
    }
    if !wrapped && !last {
        bytes.extend_from_slice(b"\r\n");
    }
    bytes
}

fn row_wrapped(grid: &alacritty_terminal::Grid<Cell>, line: Line) -> bool {
    grid[line][grid.last_column()]
        .flags
        .contains(Flags::WRAPLINE)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CellStyle {
    fg: Color,
    bg: Color,
    flags: Flags,
}

impl Default for CellStyle {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            flags: Flags::empty(),
        }
    }
}

impl From<&Cell> for CellStyle {
    fn from(cell: &Cell) -> Self {
        let visual_flags = Flags::INVERSE
            | Flags::BOLD
            | Flags::ITALIC
            | Flags::ALL_UNDERLINES
            | Flags::DIM
            | Flags::HIDDEN
            | Flags::STRIKEOUT;
        Self {
            fg: cell.fg,
            bg: cell.bg,
            flags: cell.flags & visual_flags,
        }
    }
}

fn append_style(bytes: &mut Vec<u8>, style: CellStyle) {
    let mut parameters = vec!["0".to_owned()];
    if style.flags.contains(Flags::BOLD) {
        parameters.push("1".to_owned());
    }
    if style.flags.contains(Flags::DIM) {
        parameters.push("2".to_owned());
    }
    if style.flags.contains(Flags::ITALIC) {
        parameters.push("3".to_owned());
    }
    if style.flags.contains(Flags::DOUBLE_UNDERLINE) {
        parameters.push("21".to_owned());
    } else if style.flags.intersects(Flags::ALL_UNDERLINES) {
        parameters.push("4".to_owned());
    }
    if style.flags.contains(Flags::INVERSE) {
        parameters.push("7".to_owned());
    }
    if style.flags.contains(Flags::HIDDEN) {
        parameters.push("8".to_owned());
    }
    if style.flags.contains(Flags::STRIKEOUT) {
        parameters.push("9".to_owned());
    }
    append_color(&mut parameters, style.fg, false);
    append_color(&mut parameters, style.bg, true);

    let mut sequence = String::from("\x1b[");
    sequence.push_str(&parameters.join(";"));
    sequence.push('m');
    bytes.extend_from_slice(sequence.as_bytes());
}

fn append_color(parameters: &mut Vec<String>, color: Color, background: bool) {
    match color {
        Color::Indexed(index) => {
            parameters.push(if background { "48" } else { "38" }.to_owned());
            parameters.push("5".to_owned());
            parameters.push(index.to_string());
        }
        Color::Spec(rgb) => {
            parameters.push(if background { "48" } else { "38" }.to_owned());
            parameters.push("2".to_owned());
            parameters.push(rgb.r.to_string());
            parameters.push(rgb.g.to_string());
            parameters.push(rgb.b.to_string());
        }
        Color::Named(named) => {
            let code = named_color_code(named, background);
            parameters.push(code.to_string());
        }
    }
}

fn named_color_code(color: NamedColor, background: bool) -> u8 {
    let base = if background { 40 } else { 30 };
    let bright_base = if background { 100 } else { 90 };
    match color {
        NamedColor::Black | NamedColor::DimBlack => base,
        NamedColor::Red | NamedColor::DimRed => base + 1,
        NamedColor::Green | NamedColor::DimGreen => base + 2,
        NamedColor::Yellow | NamedColor::DimYellow => base + 3,
        NamedColor::Blue | NamedColor::DimBlue => base + 4,
        NamedColor::Magenta | NamedColor::DimMagenta => base + 5,
        NamedColor::Cyan | NamedColor::DimCyan => base + 6,
        NamedColor::White | NamedColor::DimWhite => base + 7,
        NamedColor::BrightBlack => bright_base,
        NamedColor::BrightRed => bright_base + 1,
        NamedColor::BrightGreen => bright_base + 2,
        NamedColor::BrightYellow => bright_base + 3,
        NamedColor::BrightBlue => bright_base + 4,
        NamedColor::BrightMagenta => bright_base + 5,
        NamedColor::BrightCyan => bright_base + 6,
        NamedColor::BrightWhite => bright_base + 7,
        NamedColor::Foreground
        | NamedColor::BrightForeground
        | NamedColor::DimForeground
        | NamedColor::Cursor => {
            if background {
                49
            } else {
                39
            }
        }
        NamedColor::Background => {
            if background {
                49
            } else {
                39
            }
        }
    }
}

fn append_input_modes(bytes: &mut Vec<u8>, mode: TermMode) {
    bytes.extend_from_slice(if mode.contains(TermMode::APP_KEYPAD) {
        b"\x1b="
    } else {
        b"\x1b>"
    });
    append_private_mode(bytes, 1, mode.contains(TermMode::APP_CURSOR));
    append_private_mode(bytes, 2004, mode.contains(TermMode::BRACKETED_PASTE));
    for mouse_mode in [1000, 1002, 1003] {
        append_private_mode(bytes, mouse_mode, false);
    }
    let mouse_mode = if mode.contains(TermMode::MOUSE_MOTION) {
        Some(1003)
    } else if mode.contains(TermMode::MOUSE_DRAG) {
        Some(1002)
    } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
        Some(1000)
    } else {
        None
    };
    if let Some(mouse_mode) = mouse_mode {
        append_private_mode(bytes, mouse_mode, true);
    }
    append_private_mode(bytes, 1005, mode.contains(TermMode::UTF8_MOUSE));
    append_private_mode(bytes, 1006, mode.contains(TermMode::SGR_MOUSE));
    append_private_mode(bytes, 1004, mode.contains(TermMode::FOCUS_IN_OUT));
    append_private_mode(bytes, 7, mode.contains(TermMode::LINE_WRAP));
    append_private_mode(bytes, 6, mode.contains(TermMode::ORIGIN));
}

fn append_private_mode(bytes: &mut Vec<u8>, mode: u16, enabled: bool) {
    let state = if enabled { 'h' } else { 'l' };
    let sequence = format!("\x1b[?{mode}{state}");
    bytes.extend_from_slice(sequence.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> TerminalModel {
        TerminalModel::new(24, 80, 100)
    }

    #[test]
    fn startup_color_probe_has_no_embedder_reply_and_keeps_cursor_queries_live() {
        let mut terminal = model();
        let write = terminal.process(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n");
        assert_eq!(write.pty_replies, b"\x1b[1;1R");
        assert!(!write.pty_reply_overflow);
    }

    #[test]
    fn answers_device_and_cursor_queries_the_terminal_owes_its_program() {
        let mut terminal = model();

        let write = terminal.process(b"\x1b[c\x1b[6n");

        assert!(
            !write.pty_replies.is_empty(),
            "a terminal that never answers leaves every query to time out",
        );
    }

    #[test]
    fn leaves_a_palette_query_unanswered_rather_than_inventing_one() {
        let mut terminal = model();

        let write = terminal.process(b"\x1b]4;1;?\x1b\\");

        assert!(write.pty_replies.is_empty());
    }
}
