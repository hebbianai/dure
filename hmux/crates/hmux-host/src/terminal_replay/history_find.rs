//! Connection-local find over one terminal's retained history.
//!
//! The Host owns every retained row, including cold history no client holds,
//! so it searches here and returns stable logical-cell positions. Rows arrive
//! newest first; soft-wrapped rows of one logical line are joined before
//! matching, so a match may cross a physical row boundary.
//!
//! An active find stays live: when output advances, only the lines output
//! could still change (the screen the previous scan saw, and anything newer)
//! are searched again and merged with the older, settled matches.

use std::sync::Arc;

use regex::{Regex, RegexBuilder};
use terminal_state_protocol::{
    FindHighlight, FindStatus, FindStep, MAX_FIND_HIGHLIGHTS, MAX_FIND_MATCHES, TerminalRow,
    TerminalTables, ViewportFind,
};

use super::cold_history::LogicalCellAnchor;

/// Physical rows one find visits, newest first, before it reports an
/// incomplete count. The scan runs on the terminal actor; this bounds how long
/// one search can hold it.
pub(super) const MAX_FIND_SCAN_ROWS: usize = 200_000;

/// Compiled automaton bounds; a pathological pattern is refused, not run.
const MAX_FIND_PATTERN_BYTES: usize = 1 << 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FindRequest {
    pub query: String,
    pub case_sensitive: bool,
    pub regex: bool,
}

#[derive(Clone)]
pub(super) struct FindQuery {
    pattern: Regex,
}

impl FindQuery {
    /// `None` when a regex query does not compile within the Host's bounds.
    pub(super) fn compile(request: &FindRequest) -> Option<Self> {
        let source = if request.regex {
            request.query.clone()
        } else {
            regex::escape(&request.query)
        };
        RegexBuilder::new(&source)
            .case_insensitive(!request.case_sensitive)
            .size_limit(MAX_FIND_PATTERN_BYTES)
            .dfa_size_limit(MAX_FIND_PATTERN_BYTES)
            .build()
            .ok()
            .map(|pattern| Self { pattern })
    }
}

/// One match as logical cells of one logical line. `row_anchor` is the start
/// of the physical row holding the first matched cell, so a viewport can be
/// anchored there at the geometry the scan used.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct FindMatch {
    pub logical_line_id: u64,
    pub start_cell: u32,
    pub end_cell: u32,
    pub row_anchor: LogicalCellAnchor,
}

impl FindMatch {
    fn order_key(&self) -> (u64, u32) {
        (self.logical_line_id, self.start_cell)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum FindScanControl {
    Continue,
    Stop,
}

struct RowSegment {
    logical_cell_offset: u32,
    /// (byte offset in the joined line, first logical cell, display width)
    cells: Vec<(usize, u32, u32)>,
    text: String,
}

/// Accumulates newest-first rows and collects matches, newest first.
pub(super) struct FindScan {
    query: FindQuery,
    matches: Vec<FindMatch>,
    pending_line: Option<u64>,
    pending: Vec<RowSegment>,
    rows_visited: usize,
    bounded: bool,
    /// Lines older than this are not searched; see [`FindScan::lines_from`].
    floor_line: Option<u64>,
    reached_floor: bool,
}

impl FindScan {
    pub(super) fn new(query: FindQuery) -> Self {
        Self {
            query,
            matches: Vec::new(),
            pending_line: None,
            pending: Vec::new(),
            rows_visited: 0,
            bounded: false,
            floor_line: None,
            reached_floor: false,
        }
    }

    /// A scan of logical lines `floor_line` and newer only. It stops at the
    /// first older row, so a refresh revisits new output, not all history.
    pub(super) fn lines_from(query: FindQuery, floor_line: u64) -> Self {
        Self {
            floor_line: Some(floor_line),
            ..Self::new(query)
        }
    }

    pub(super) fn floor_line(&self) -> Option<u64> {
        self.floor_line
    }

    /// Whether any row at or after the floor was offered. A refresh that
    /// finds none has lost the lines its floor named (the history was
    /// cleared or rewound), so its older matches no longer describe output.
    pub(super) fn offered_rows(&self) -> bool {
        self.rows_visited > 0
    }

    /// Offers the next older physical row. `cells` yields each cell's text and
    /// display width in column order.
    pub(super) fn push_row<'a>(
        &mut self,
        logical_line_id: u64,
        logical_cell_offset: u32,
        cells: impl Iterator<Item = (&'a str, u32)>,
    ) -> FindScanControl {
        if self.bounded || self.reached_floor {
            return FindScanControl::Stop;
        }
        if self
            .floor_line
            .is_some_and(|floor_line| logical_line_id < floor_line)
        {
            self.finish_line();
            self.reached_floor = true;
            return FindScanControl::Stop;
        }
        if self.pending_line != Some(logical_line_id) {
            self.finish_line();
            self.pending_line = Some(logical_line_id);
        }
        let mut segment = RowSegment {
            logical_cell_offset,
            cells: Vec::new(),
            text: String::new(),
        };
        let mut cell = logical_cell_offset;
        for (text, width) in cells {
            segment.cells.push((segment.text.len(), cell, width));
            segment.text.push_str(text);
            cell = cell.saturating_add(width);
        }
        self.pending.push(segment);
        self.rows_visited += 1;
        if self.rows_visited >= MAX_FIND_SCAN_ROWS || self.matches.len() >= max_matches() {
            self.finish_line();
            self.bounded = true;
            return FindScanControl::Stop;
        }
        FindScanControl::Continue
    }

    /// Offers one terminal-state row with its frame-local tables.
    pub(super) fn push_terminal_row(
        &mut self,
        row: &TerminalRow,
        tables: &TerminalTables,
    ) -> FindScanControl {
        self.push_row(
            row.logical_line_id,
            row.logical_cell_offset,
            row.cells.iter().map(|cell| {
                tables
                    .graphemes
                    .get(cell.grapheme_index as usize)
                    .map_or((" ", 1), |grapheme| {
                        (grapheme.text.as_str(), grapheme.display_width)
                    })
            }),
        )
    }

    /// `reached_oldest` says the caller offered every retained row. A scan
    /// with a floor is complete once it reached a line below that floor.
    pub(super) fn finish(mut self, reached_oldest: bool) -> FindOutcome {
        self.finish_line();
        self.matches.truncate(max_matches());
        FindOutcome {
            complete: (reached_oldest || self.reached_floor) && !self.bounded,
            matches: self.matches,
        }
    }

    fn finish_line(&mut self) {
        let Some(logical_line_id) = self.pending_line.take() else {
            return;
        };
        let mut segments = std::mem::take(&mut self.pending);
        // Rows arrived newest first; a logical line reads oldest first.
        segments.reverse();
        let mut text = String::new();
        let mut cells = Vec::new();
        let mut row_starts = Vec::with_capacity(segments.len());
        for segment in segments {
            let base = text.len();
            row_starts.push(segment.logical_cell_offset);
            cells.extend(
                segment
                    .cells
                    .into_iter()
                    .map(|(byte, cell, width)| (byte + base, cell, width)),
            );
            text.push_str(&segment.text);
        }
        let mut line_matches = Vec::new();
        for found in self.query.pattern.find_iter(&text) {
            if found.is_empty() {
                continue;
            }
            let Some((start_cell, end_cell)) = cell_range(&cells, found.start(), found.end())
            else {
                continue;
            };
            let row_start = row_starts
                .iter()
                .rev()
                .find(|start| **start <= start_cell)
                .copied()
                .unwrap_or(0);
            line_matches.push(FindMatch {
                logical_line_id,
                start_cell,
                end_cell,
                row_anchor: LogicalCellAnchor {
                    logical_line_id,
                    logical_cell_offset: row_start,
                },
            });
        }
        // The rightmost match on a line is the newest one.
        self.matches.extend(line_matches.into_iter().rev());
    }
}

fn max_matches() -> usize {
    usize::try_from(MAX_FIND_MATCHES).unwrap_or(usize::MAX)
}

fn match_status(matches: &[FindMatch]) -> FindStatus {
    if matches.is_empty() {
        FindStatus::NoMatch
    } else {
        FindStatus::Matched
    }
}

/// Logical cells covering bytes `[start, end)` of a joined line.
fn cell_range(cells: &[(usize, u32, u32)], start: usize, end: usize) -> Option<(u32, u32)> {
    let first = cells
        .partition_point(|(byte, _, _)| *byte <= start)
        .checked_sub(1)?;
    let last = cells
        .partition_point(|(byte, _, _)| *byte < end)
        .checked_sub(1)?;
    let (_, start_cell, _) = cells[first];
    let (_, last_cell, last_width) = cells[last];
    let end_cell = last_cell.saturating_add(last_width.max(1));
    (start_cell < end_cell).then_some((start_cell, end_cell))
}

pub(super) struct FindOutcome {
    pub matches: Vec<FindMatch>,
    pub complete: bool,
}

/// Where one scan stood in the terminal's output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct FindScanPoint {
    /// The terminal state revision the matches describe.
    pub terminal_revision: u64,
    /// The top line of the screen when the scan ran. Output can rewrite that
    /// line and anything newer; older lines are settled history.
    pub floor_line: u64,
    pub alternate_screen: bool,
}

/// What a refresh needs to carry a find forward as output arrives.
#[derive(Clone)]
pub(super) struct LiveFind {
    pub query: FindQuery,
    pub scanned: FindScanPoint,
}

/// The connection's answer to its newest applied find.
#[derive(Clone)]
pub(super) struct FindState {
    pub request: FindRequest,
    pub intent_seq: u64,
    pub status: FindStatus,
    /// Newest first.
    pub matches: Arc<[FindMatch]>,
    pub complete: bool,
    pub current: Option<usize>,
    /// `None` when output cannot change the answer (an invalid pattern) or a
    /// refresh failed and the answer is kept as it was.
    pub live: Option<LiveFind>,
}

impl FindState {
    pub(super) fn invalid(request: FindRequest, intent_seq: u64) -> Self {
        Self {
            request,
            intent_seq,
            status: FindStatus::InvalidPattern,
            matches: Arc::from(Vec::new()),
            complete: true,
            current: None,
            live: None,
        }
    }

    pub(super) fn from_outcome(
        request: FindRequest,
        intent_seq: u64,
        outcome: FindOutcome,
        previous: Option<FindMatch>,
        step: FindStep,
        live: Option<LiveFind>,
    ) -> Self {
        let current = select_match(previous, &outcome.matches, step);
        Self {
            request,
            intent_seq,
            status: match_status(&outcome.matches),
            matches: Arc::from(outcome.matches),
            complete: outcome.complete,
            current,
            live,
        }
    }

    /// This answer after output advanced. `rescanned_from` is the oldest line
    /// the refresh searched again; older matches are kept as they were. `None`
    /// means all history was searched again. The selected match stays
    /// selected, and one that output rewrote continues from where it was. A
    /// refresh answers the same intent and never moves the viewport.
    pub(super) fn refreshed(
        &self,
        outcome: FindOutcome,
        rescanned_from: Option<u64>,
        live: LiveFind,
    ) -> Self {
        let FindOutcome {
            mut matches,
            mut complete,
        } = outcome;
        // A bounded rescan stopped short of the floor and leaves a gap; it
        // already covers as much history as a fresh find would.
        if let Some(floor_line) = rescanned_from.filter(|_| complete) {
            let settled = self
                .matches
                .partition_point(|found| found.logical_line_id >= floor_line);
            matches.extend_from_slice(&self.matches[settled..]);
            complete = self.complete && matches.len() <= max_matches();
            matches.truncate(max_matches());
        }
        let current = retain_match(self.current_match(), &matches);
        Self {
            request: self.request.clone(),
            intent_seq: self.intent_seq,
            status: match_status(&matches),
            matches: Arc::from(matches),
            complete,
            current,
            live: Some(live),
        }
    }

    /// The same answer, no longer refreshed by output.
    pub(super) fn frozen(&self) -> Self {
        Self {
            live: None,
            ..self.clone()
        }
    }

    pub(super) fn current_match(&self) -> Option<FindMatch> {
        self.current
            .and_then(|index| self.matches.get(index).copied())
    }

    /// The frame-relative answer for one projected set of rows.
    pub(super) fn viewport_find(&self, rows: &[TerminalRow], columns: u32) -> ViewportFind {
        let matched = self.status == FindStatus::Matched;
        ViewportFind {
            find_intent_seq: self.intent_seq,
            status: self.status as i32,
            match_count: if matched {
                u32::try_from(self.matches.len()).unwrap_or(MAX_FIND_MATCHES)
            } else {
                0
            },
            match_count_complete: self.complete,
            current_match: match (matched, self.current) {
                (true, Some(index)) => u32::try_from(index + 1).unwrap_or(MAX_FIND_MATCHES),
                _ => 0,
            },
            highlights: if matched {
                frame_highlights(&self.matches, self.current, rows, columns)
            } else {
                Vec::new()
            },
        }
    }
}

/// Selects the match a step lands on in a fresh newest-first scan. A step
/// continues from the previously selected match even when new output moved
/// every index; a vanished match continues from its position.
pub(super) fn select_match(
    previous: Option<FindMatch>,
    matches: &[FindMatch],
    step: FindStep,
) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    let Some(previous) = previous.filter(|_| step != FindStep::Restart) else {
        return Some(0);
    };
    let key = previous.order_key();
    let found = matches
        .iter()
        .position(|candidate| candidate.order_key() == key);
    let last = matches.len() - 1;
    Some(match (step, found) {
        (FindStep::Older, Some(index)) => {
            if index == last {
                0
            } else {
                index + 1
            }
        }
        (FindStep::Newer, Some(index)) => index.checked_sub(1).unwrap_or(last),
        // Descending order: the first older match follows every newer one.
        (FindStep::Older, None) => matches
            .iter()
            .position(|candidate| candidate.order_key() < key)
            .unwrap_or(0),
        (FindStep::Newer, None) => matches
            .iter()
            .rposition(|candidate| candidate.order_key() > key)
            .unwrap_or(last),
        (FindStep::Restart | FindStep::Unspecified, _) => 0,
    })
}

/// The match a refresh keeps selected: the same one, or the nearest older one
/// when output rewrote it. A find that had no match selects the newest.
fn retain_match(previous: Option<FindMatch>, matches: &[FindMatch]) -> Option<usize> {
    let last = matches.len().checked_sub(1)?;
    let Some(previous) = previous else {
        return Some(0);
    };
    let key = previous.order_key();
    // Descending order: the first match not newer than the previous one.
    Some(
        matches
            .partition_point(|candidate| candidate.order_key() > key)
            .min(last),
    )
}

/// Highlight segments for the rows of one frame. Matches are newest first,
/// which is descending logical order.
fn frame_highlights(
    matches: &[FindMatch],
    current: Option<usize>,
    rows: &[TerminalRow],
    columns: u32,
) -> Vec<FindHighlight> {
    let mut highlights = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let Ok(row_index) = u32::try_from(row_index) else {
            break;
        };
        let line = row.logical_line_id;
        let first = matches.partition_point(|candidate| candidate.logical_line_id > line);
        let row_start = row.logical_cell_offset;
        let row_end = row_start.saturating_add(row.logical_cell_span);
        for (offset, candidate) in matches[first..].iter().enumerate() {
            if candidate.logical_line_id != line {
                break;
            }
            let start = candidate.start_cell.max(row_start);
            let end = candidate.end_cell.min(row_end);
            if start >= end {
                continue;
            }
            let start_column = start - row_start;
            let end_column = (end - row_start).min(columns);
            if start_column >= end_column {
                continue;
            }
            if highlights.len() == MAX_FIND_HIGHLIGHTS {
                return highlights;
            }
            highlights.push(FindHighlight {
                row: row_index,
                start_column,
                end_column,
                current: current == Some(first + offset),
            });
        }
    }
    highlights
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_state_protocol::{Grapheme, RowTermination, TerminalCell};

    fn request(query: &str) -> FindRequest {
        FindRequest {
            query: query.to_string(),
            case_sensitive: false,
            regex: false,
        }
    }

    fn scan(request: &FindRequest) -> FindScan {
        FindScan::new(FindQuery::compile(request).expect("query compiles"))
    }

    /// Pushes `(line id, cell offset, text)` rows given oldest first, the way
    /// a reader sees them, in the newest-first order the Host scans.
    fn offer(find: &mut FindScan, rows: &[(u64, u32, &str)]) {
        for (line, offset, text) in rows.iter().rev() {
            let cells = text
                .chars()
                .map(|character| (character, if character == '界' { 2 } else { 1 }))
                .collect::<Vec<_>>();
            let strings = cells
                .iter()
                .map(|(character, width)| (character.to_string(), *width))
                .collect::<Vec<_>>();
            if find.push_row(
                *line,
                *offset,
                strings.iter().map(|(text, width)| (text.as_str(), *width)),
            ) == FindScanControl::Stop
            {
                return;
            }
        }
    }

    fn run(request: &FindRequest, rows: &[(u64, u32, &str)]) -> FindOutcome {
        let mut find = scan(request);
        offer(&mut find, rows);
        find.finish(true)
    }

    fn ranges(outcome: &FindOutcome) -> Vec<(u64, u32, u32)> {
        outcome
            .matches
            .iter()
            .map(|found| (found.logical_line_id, found.start_cell, found.end_cell))
            .collect()
    }

    #[test]
    fn matches_are_reported_newest_first_across_lines_and_within_a_line() {
        let outcome = run(
            &request("err"),
            &[(1, 0, "err one err"), (2, 0, "fine"), (3, 0, "ERR three")],
        );
        assert!(outcome.complete);
        assert_eq!(ranges(&outcome), [(3, 0, 3), (1, 8, 11), (1, 0, 3)]);
    }

    #[test]
    fn case_and_regex_options_change_what_matches() {
        let rows = [
            (1, 0, "Error: build failed"),
            (2, 0, "error at src/main.rs:42"),
        ];
        let mut sensitive = request("Error");
        sensitive.case_sensitive = true;
        assert_eq!(ranges(&run(&sensitive, &rows)), [(1, 0, 5)]);

        let mut pattern = request(r"main\.rs:\d+");
        pattern.regex = true;
        assert_eq!(ranges(&run(&pattern, &rows)), [(2, 13, 23)]);

        // Without the regex option the same text is a literal.
        assert!(run(&request(r"main\.rs:\d+"), &rows).matches.is_empty());

        let mut invalid = request("(unclosed");
        invalid.regex = true;
        assert!(FindQuery::compile(&invalid).is_none());
    }

    #[test]
    fn a_match_across_a_soft_wrap_anchors_on_the_row_where_it_starts() {
        // One logical line wrapped at four columns: "abcd" + "efgh".
        let outcome = run(&request("cdef"), &[(7, 0, "abcd"), (7, 4, "efgh")]);
        assert_eq!(ranges(&outcome), [(7, 2, 6)]);
        assert_eq!(
            outcome.matches[0].row_anchor,
            LogicalCellAnchor {
                logical_line_id: 7,
                logical_cell_offset: 0,
            }
        );
        let later = run(&request("fg"), &[(7, 0, "abcd"), (7, 4, "efgh")]);
        assert_eq!(later.matches[0].row_anchor.logical_cell_offset, 4);
    }

    #[test]
    fn wide_characters_count_their_display_width() {
        // "界" is two cells wide, so "x" after it starts at cell 3.
        let outcome = run(&request("界x"), &[(1, 0, "a界x")]);
        assert_eq!(ranges(&outcome), [(1, 1, 4)]);
    }

    #[test]
    fn a_scan_stopped_before_the_oldest_row_reports_an_incomplete_count() {
        let mut find = scan(&request("x"));
        assert_eq!(
            find.push_row(2, 0, [("x", 1)].into_iter()),
            FindScanControl::Continue
        );
        let outcome = find.finish(false);
        assert!(!outcome.complete);
        assert_eq!(outcome.matches.len(), 1);
    }

    #[test]
    fn empty_regex_matches_are_ignored() {
        let mut pattern = request("z*");
        pattern.regex = true;
        assert!(run(&pattern, &[(1, 0, "abc")]).matches.is_empty());
    }

    fn found(line: u64, start: u32) -> FindMatch {
        FindMatch {
            logical_line_id: line,
            start_cell: start,
            end_cell: start + 1,
            row_anchor: LogicalCellAnchor {
                logical_line_id: line,
                logical_cell_offset: 0,
            },
        }
    }

    #[test]
    fn steps_walk_toward_older_and_newer_output_and_wrap() {
        let matches = [found(9, 0), found(5, 3), found(5, 0), found(1, 0)];
        assert_eq!(select_match(None, &matches, FindStep::Older), Some(0));
        assert_eq!(
            select_match(Some(found(9, 0)), &matches, FindStep::Restart),
            Some(0)
        );
        assert_eq!(
            select_match(Some(found(5, 3)), &matches, FindStep::Older),
            Some(2)
        );
        assert_eq!(
            select_match(Some(found(1, 0)), &matches, FindStep::Older),
            Some(0)
        );
        assert_eq!(
            select_match(Some(found(9, 0)), &matches, FindStep::Newer),
            Some(3)
        );
        assert_eq!(
            select_match(Some(found(5, 0)), &matches, FindStep::Newer),
            Some(1)
        );
        // A match that vanished continues from where it was.
        assert_eq!(
            select_match(Some(found(6, 0)), &matches, FindStep::Older),
            Some(1)
        );
        assert_eq!(
            select_match(Some(found(6, 0)), &matches, FindStep::Newer),
            Some(0)
        );
        assert_eq!(select_match(None, &[], FindStep::Restart), None);
    }

    #[test]
    fn a_scan_from_a_floor_line_stops_below_it_and_is_complete() {
        let query = FindQuery::compile(&request("needle")).unwrap();
        let mut find = FindScan::lines_from(query, 5);
        // Line 5 wraps; its two rows are joined before matching.
        offer(
            &mut find,
            &[
                (3, 0, "needle settled"),
                (5, 0, "abc nee"),
                (5, 7, "dle"),
                (6, 0, "needle new"),
            ],
        );
        assert!(find.offered_rows());
        let outcome = find.finish(false);
        assert!(outcome.complete, "reaching the floor completes a refresh");
        assert_eq!(ranges(&outcome), [(6, 0, 6), (5, 4, 10)]);
    }

    #[test]
    fn a_floor_scan_whose_newest_row_is_older_than_the_floor_offers_nothing() {
        let query = FindQuery::compile(&request("x")).unwrap();
        let mut find = FindScan::lines_from(query, 9);
        assert_eq!(
            find.push_row(4, 0, [("x", 1)].into_iter()),
            FindScanControl::Stop
        );
        assert!(!find.offered_rows());
        assert!(find.finish(false).matches.is_empty());
    }

    fn live(floor_line: u64) -> LiveFind {
        LiveFind {
            query: FindQuery::compile(&request("x")).unwrap(),
            scanned: FindScanPoint {
                terminal_revision: 9,
                floor_line,
                alternate_screen: false,
            },
        }
    }

    fn state(matches: Vec<FindMatch>, previous: Option<FindMatch>, step: FindStep) -> FindState {
        FindState::from_outcome(
            request("x"),
            4,
            FindOutcome {
                matches,
                complete: true,
            },
            previous,
            step,
            Some(live(5)),
        )
    }

    fn lines(state: &FindState) -> Vec<(u64, u32)> {
        state
            .matches
            .iter()
            .map(|found| (found.logical_line_id, found.start_cell))
            .collect()
    }

    #[test]
    fn a_refresh_replaces_rescanned_lines_and_keeps_settled_ones_and_the_selection() {
        let before = state(
            vec![found(9, 0), found(5, 3), found(5, 0), found(1, 0)],
            Some(found(9, 0)),
            FindStep::Older,
        );
        assert_eq!(before.current_match(), Some(found(5, 3)));
        let after = before.refreshed(
            FindOutcome {
                matches: vec![found(12, 0), found(9, 0), found(5, 3)],
                complete: true,
            },
            Some(5),
            live(11),
        );
        // Lines 5 and newer come from the rescan; line 1 is settled history.
        assert_eq!(lines(&after), [(12, 0), (9, 0), (5, 3), (1, 0)]);
        assert_eq!(after.current_match(), Some(found(5, 3)));
        assert_eq!(after.current, Some(2));
        assert!(after.status == FindStatus::Matched);
        assert!(after.complete);
        assert_eq!(after.intent_seq, 4, "a refresh answers the same intent");
        assert_eq!(after.live.as_ref().unwrap().scanned.floor_line, 11);
    }

    #[test]
    fn a_refresh_that_rewrote_the_selected_match_continues_from_its_position() {
        let before = state(
            vec![found(9, 0), found(5, 3), found(5, 0), found(1, 0)],
            Some(found(9, 0)),
            FindStep::Older,
        );
        let after = before.refreshed(
            FindOutcome {
                matches: vec![found(12, 0), found(9, 0)],
                complete: true,
            },
            Some(5),
            live(11),
        );
        assert_eq!(lines(&after), [(12, 0), (9, 0), (1, 0)]);
        assert_eq!(after.current_match(), Some(found(1, 0)));

        // With nothing older left, the nearest newer match is selected.
        let before = state(
            vec![found(9, 0), found(5, 0)],
            Some(found(9, 0)),
            FindStep::Older,
        );
        let after = before.refreshed(
            FindOutcome {
                matches: vec![found(9, 0)],
                complete: true,
            },
            Some(5),
            live(9),
        );
        assert_eq!(after.current_match(), Some(found(9, 0)));

        // Output that rewrote every match leaves none.
        let after = after.refreshed(
            FindOutcome {
                matches: Vec::new(),
                complete: true,
            },
            Some(9),
            live(9),
        );
        assert!(after.status == FindStatus::NoMatch);
        assert_eq!(after.current, None);
    }

    #[test]
    fn a_refresh_of_a_find_without_matches_selects_the_newest_new_one() {
        let before = state(Vec::new(), None, FindStep::Restart);
        assert!(before.status == FindStatus::NoMatch);
        let after = before.refreshed(
            FindOutcome {
                matches: vec![found(7, 0), found(6, 2)],
                complete: true,
            },
            Some(5),
            live(7),
        );
        assert!(after.status == FindStatus::Matched);
        assert_eq!(after.current, Some(0));
    }

    #[test]
    fn a_bounded_or_full_rescan_replaces_the_answer() {
        let before = state(vec![found(9, 0), found(1, 0)], None, FindStep::Restart);
        let bounded = before.refreshed(
            FindOutcome {
                matches: vec![found(30, 0)],
                complete: false,
            },
            Some(5),
            live(30),
        );
        assert_eq!(lines(&bounded), [(30, 0)]);
        assert!(!bounded.complete);

        let full = before.refreshed(
            FindOutcome {
                matches: vec![found(2, 0)],
                complete: true,
            },
            None,
            live(2),
        );
        assert_eq!(lines(&full), [(2, 0)]);
        assert!(full.complete);
        assert!(full.frozen().live.is_none());
    }

    #[test]
    fn a_refresh_keeps_the_newest_matches_within_the_bound() {
        let bound = u64::from(MAX_FIND_MATCHES);
        let before = state(
            (1..=bound).rev().map(|line| found(line, 0)).collect(),
            None,
            FindStep::Restart,
        );
        assert!(before.complete);
        let after = before.refreshed(
            FindOutcome {
                matches: vec![found(bound + 10, 0)],
                complete: true,
            },
            Some(bound + 1),
            live(bound + 10),
        );
        assert_eq!(after.matches.len(), max_matches());
        assert_eq!(after.matches[0].logical_line_id, bound + 10);
        assert_eq!(after.matches[max_matches() - 1].logical_line_id, 2);
        assert!(!after.complete, "the oldest match fell past the bound");
        // The newest match stays selected, now one step from the newest.
        assert_eq!(after.current, Some(1));
    }

    fn frame_row(line: u64, offset: u32, span: u32, wraps: bool) -> TerminalRow {
        TerminalRow {
            row_id: line,
            continues_from_previous: offset > 0,
            cells: vec![TerminalCell::default(); span as usize],
            termination: if wraps {
                RowTermination::SoftWrap
            } else {
                RowTermination::HardBreak
            } as i32,
            logical_line_id: line,
            logical_cell_offset: offset,
            logical_cell_span: span,
        }
    }

    #[test]
    fn highlights_split_a_wrapped_match_and_mark_the_current_one() {
        let state = FindState::from_outcome(
            request("cdef"),
            4,
            FindOutcome {
                matches: vec![
                    FindMatch {
                        logical_line_id: 7,
                        start_cell: 2,
                        end_cell: 6,
                        row_anchor: LogicalCellAnchor {
                            logical_line_id: 7,
                            logical_cell_offset: 0,
                        },
                    },
                    found(3, 1),
                ],
                complete: true,
            },
            None,
            FindStep::Restart,
            None,
        );
        let rows = [
            frame_row(3, 0, 4, false),
            frame_row(7, 0, 4, true),
            frame_row(7, 4, 4, false),
        ];
        let find = state.viewport_find(&rows, 4);
        assert_eq!(find.status, FindStatus::Matched as i32);
        assert_eq!((find.match_count, find.current_match), (2, 1));
        assert!(find.match_count_complete);
        let segments = find
            .highlights
            .iter()
            .map(|highlight| {
                (
                    highlight.row,
                    highlight.start_column,
                    highlight.end_column,
                    highlight.current,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            segments,
            [(0, 1, 2, false), (1, 2, 4, true), (2, 0, 2, true)]
        );
    }

    #[test]
    fn terminal_rows_resolve_text_through_their_tables() {
        let tables = TerminalTables {
            graphemes: vec![
                Grapheme {
                    text: " ".into(),
                    display_width: 1,
                },
                Grapheme {
                    text: "o".into(),
                    display_width: 1,
                },
                Grapheme {
                    text: "k".into(),
                    display_width: 1,
                },
            ],
            ..TerminalTables::default()
        };
        let mut row = frame_row(4, 0, 3, false);
        row.cells = [1, 2, 0]
            .into_iter()
            .map(|grapheme_index| TerminalCell {
                grapheme_index,
                style_index: 0,
            })
            .collect();
        let mut find = scan(&request("OK"));
        find.push_terminal_row(&row, &tables);
        assert_eq!(ranges(&find.finish(true)), [(4, 0, 2)]);
    }
}
