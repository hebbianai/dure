use hmux_host::terminal_replay::ControllerDraftEdit;

use crate::controller_input_effect::DraftFold;

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
const MARKER_LEN: usize = PASTE_START.len();

const LEFT_OR_HOME: DraftFold = DraftFold::Edit(ControllerDraftEdit::EditedUncounted);
const BACKSPACE: DraftFold = DraftFold::Edit(ControllerDraftEdit::Erased(1));

/// What terminals send for keys that cannot put text into a line editor, with
/// the edit each makes to a draft. Legacy byte input carries no typed key, so
/// only a frame that is exactly one of these is that keypress; anything
/// longer may carry text.
const NON_INSERTING_KEY_CHUNKS: &[(&[u8], DraftFold)] = &[
    // Escape, which also asks a working agent turn to stop, and Shift+Tab.
    (b"\x1b", DraftFold::InterruptRequest),
    (b"\x1b[Z", DraftFold::WriteOnly),
    // Left and Home move the cursor into the line, in normal and application
    // cursor-key mode; Right and End leave a cursor at its end where it is.
    (b"\x1b[D", LEFT_OR_HOME),
    (b"\x1bOD", LEFT_OR_HOME),
    (b"\x1b[H", LEFT_OR_HOME),
    (b"\x1bOH", LEFT_OR_HOME),
    (b"\x1b[1~", LEFT_OR_HOME),
    (b"\x1b[C", DraftFold::WriteOnly),
    (b"\x1bOC", DraftFold::WriteOnly),
    (b"\x1b[F", DraftFold::WriteOnly),
    (b"\x1bOF", DraftFold::WriteOnly),
    (b"\x1b[4~", DraftFold::WriteOnly),
    // Backspace in both encodings; Insert, Delete and Ctrl+C.
    (b"\x7f", BACKSPACE),
    (b"\x08", BACKSPACE),
    (b"\x1b[2~", DraftFold::WriteOnly),
    (b"\x1b[3~", DraftFold::WriteOnly),
    (b"\x03", DraftFold::WriteOnly),
    // F1-F12.
    (b"\x1bOP", DraftFold::WriteOnly),
    (b"\x1bOQ", DraftFold::WriteOnly),
    (b"\x1bOR", DraftFold::WriteOnly),
    (b"\x1bOS", DraftFold::WriteOnly),
    (b"\x1b[11~", DraftFold::WriteOnly),
    (b"\x1b[12~", DraftFold::WriteOnly),
    (b"\x1b[13~", DraftFold::WriteOnly),
    (b"\x1b[14~", DraftFold::WriteOnly),
    (b"\x1b[15~", DraftFold::WriteOnly),
    (b"\x1b[17~", DraftFold::WriteOnly),
    (b"\x1b[18~", DraftFold::WriteOnly),
    (b"\x1b[19~", DraftFold::WriteOnly),
    (b"\x1b[20~", DraftFold::WriteOnly),
    (b"\x1b[21~", DraftFold::WriteOnly),
    (b"\x1b[23~", DraftFold::WriteOnly),
    (b"\x1b[24~", DraftFold::WriteOnly),
];

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct SubmitScan {
    submitted: bool,
    /// Edits to the line after the chunk's last submit, or the whole chunk's
    /// when it has none, in order with runs of one kind merged.
    edits: Vec<ControllerDraftEdit>,
}

impl SubmitScan {
    fn submit(&mut self) {
        self.submitted = true;
        self.edits.clear();
    }

    fn edit(&mut self, edit: ControllerDraftEdit) {
        match (self.edits.last_mut(), edit) {
            (Some(ControllerDraftEdit::Inserted(run)), ControllerDraftEdit::Inserted(count))
            | (Some(ControllerDraftEdit::Erased(run)), ControllerDraftEdit::Erased(count)) => {
                *run = run.saturating_add(count);
            }
            (Some(last), edit) if *last == edit => {}
            _ => self.edits.push(edit),
        }
    }
}

/// One byte typed outside a paste. A UTF-8 continuation byte completes a
/// character its leading byte already counted, so a character split across
/// PTY writes counts once. Control bytes other than Backspace may complete,
/// recall or yank text the Host cannot count.
fn typed_byte_edit(byte: u8) -> Option<ControllerDraftEdit> {
    match byte {
        0x80..=0xbf => None,
        0x7f | 0x08 => Some(ControllerDraftEdit::Erased(1)),
        0x20..=0x7e | 0xc0..=0xff => Some(ControllerDraftEdit::Inserted(1)),
        0x00..=0x07 | 0x09..=0x1f => Some(ControllerDraftEdit::InsertedUncounted),
    }
}

/// One pasted byte: inserted literally, counted by its leading byte.
fn pasted_byte_edit(byte: u8) -> Option<ControllerDraftEdit> {
    (!matches!(byte, 0x80..=0xbf)).then_some(ControllerDraftEdit::Inserted(1))
}

/// The length of the complete terminal report `bytes` starts with: a focus
/// report (`CSI I`, `CSI O`) or an SGR mouse report (`CSI < b ; x ; y M` or
/// `m`). A terminal sends these on its own once the application turns on
/// focus or SGR mouse reporting, and a terminal attached with `hmux attach`
/// forwards them as raw bytes. Structured clients send the same facts as
/// focus and pointer intents, which never edit the line either. No key
/// encodes as either report, so they put nothing into the line. X10
/// and urxvt mouse reports are not recognized: `CSI M` is also a function key
/// in SCO keyboard mode and their fields cannot be told from typed text.
fn terminal_report_len(bytes: &[u8]) -> Option<usize> {
    const CSI_LEN: usize = 2;
    match bytes {
        [0x1b, b'[', b'I' | b'O', ..] => Some(CSI_LEN + 1),
        [0x1b, b'[', b'<', fields @ ..] => {
            let mut length = 0;
            for final_bytes in [b";".as_slice(), b";", b"Mm"] {
                let digits = fields[length..]
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
                if digits == 0 || !final_bytes.contains(fields.get(length + digits)?) {
                    return None;
                }
                length += digits + 1;
            }
            Some(CSI_LEN + 1 + length)
        }
        _ => None,
    }
}

/// Streaming classifier for controller input: reports whether a chunk carries
/// a submit keystroke and which edits its accepted bytes make to the line
/// after the last submit. Typed characters and Backspaces are counted;
/// completion, history recall and other control sequences are input the Host
/// cannot count, while complete focus and SGR mouse reports outside a paste
/// edit nothing. A bare CR/LF outside bracketed paste (and not the newline
/// half of Alt+Enter) submits input. Paste envelopes and Alt+Enter pairs may
/// split across input frames, so the scanner keeps the unfinished marker
/// prefix between calls. A report split across writes is not reassembled and
/// stays input the Host cannot count.
#[derive(Default)]
pub(crate) struct SubmitScanner {
    in_bracketed_paste: bool,
    carried: Vec<u8>,
}

impl SubmitScanner {
    #[cfg(test)]
    fn observe(&mut self, bytes: &[u8]) -> SubmitScan {
        self.observe_chunk(bytes, false)
    }

    fn observe_chunk(&mut self, bytes: &[u8], continues_frame: bool) -> SubmitScan {
        let mut buffer = std::mem::take(&mut self.carried);
        let carried_len = if continues_frame { 0 } else { buffer.len() };
        buffer.extend_from_slice(bytes);
        let mut scan = SubmitScan::default();
        let mut index = 0;
        while index < buffer.len() {
            let rest = &buffer[index..];
            if rest.starts_with(PASTE_START) {
                self.in_bracketed_paste = true;
                index += MARKER_LEN;
                continue;
            }
            if rest.starts_with(PASTE_END) {
                self.in_bracketed_paste = false;
                index += MARKER_LEN;
                continue;
            }
            if rest[0] == 0x1b {
                if !self.in_bracketed_paste {
                    if let Some(length) = terminal_report_len(rest) {
                        index += length;
                        continue;
                    }
                }
                // The frame may end inside a paste envelope marker; defer
                // those bytes to the next chunk instead of misreading them
                // byte-wise.
                if rest.len() < MARKER_LEN
                    && (PASTE_START.starts_with(rest) || PASTE_END.starts_with(rest))
                {
                    self.carried = rest.to_vec();
                    return scan;
                }
                // Alt+Enter (newline insert, not a submit) always arrives as
                // one frame. A carried ESC completed by a later frame is two
                // keypresses — Esc, then a real Enter — so only pair fresh
                // bytes. Which line editors insert the newline is unknown.
                if index >= carried_len && matches!(rest.get(1), Some(b'\r') | Some(b'\n')) {
                    scan.edit(ControllerDraftEdit::InsertedUncounted);
                    index += 2;
                    continue;
                }
            }
            let byte = rest[0];
            let edit = if self.in_bracketed_paste {
                pasted_byte_edit(byte)
            } else if matches!(byte, b'\r' | b'\n') {
                scan.submit();
                None
            } else {
                typed_byte_edit(byte)
            };
            if let Some(edit) = edit {
                scan.edit(edit);
            }
            index += 1;
        }
        scan
    }

    /// The fold for a whole frame that is one keypress that cannot insert
    /// text, outside a bracketed paste. Inside one the same bytes are pasted
    /// content.
    fn non_inserting_key_fold(&self, bytes: &[u8]) -> Option<DraftFold> {
        if self.in_bracketed_paste {
            return None;
        }
        NON_INSERTING_KEY_CHUNKS
            .iter()
            .find(|(chunk, _)| *chunk == bytes)
            .map(|(_, fold)| *fold)
    }

    /// Forget paste and carry state. Called when stream continuity breaks —
    /// a controller change or writer disconnect can strand an unclosed paste
    /// envelope, which would otherwise classify every later Enter as paste
    /// content and silently disable submit detection for the session.
    pub(crate) fn reset(&mut self) {
        self.in_bracketed_paste = false;
        self.carried.clear();
    }
}

/// Applies the semantic effects of one accepted draft-capable PTY prefix.
/// Unix and Windows call this for complete and partial writes while holding
/// their serialized writer and Host state.
pub(crate) fn fold_written_input_prefix(
    host: &mut hmux_host::session_host::SessionHost,
    fence: &hmux_host::local_protocol::SessionFence,
    scanner: &mut SubmitScanner,
    bytes: &[u8],
    continues_frame: bool,
    completes_frame: bool,
) -> Result<
    Option<hmux_host::local_protocol::AgentRuntimeStateProjection>,
    hmux_host::session_host::SessionHostError,
> {
    // Legacy byte input has no typed Key intent. A whole frame that is one
    // keypress that cannot insert text (a bare Escape, an arrow, Backspace,
    // Ctrl+C...) outside paste is that key, not typed text. It carries no
    // submit and no paste marker, so the scanner needs nothing from it. A
    // partial write of a longer sequence is not such a key and is scanned.
    if !continues_frame && completes_frame {
        if let Some(fold) = scanner.non_inserting_key_fold(bytes) {
            return match fold {
                DraftFold::Edit(edit) => host.record_controller_draft_edit(fence, edit),
                DraftFold::InterruptRequest => {
                    host.record_controller_interrupt_request(fence)?;
                    Ok(None)
                }
                DraftFold::Bytes | DraftFold::WriteOnly => {
                    host.record_controller_write(fence)?;
                    Ok(None)
                }
            };
        }
    }
    let scan = scanner.observe_chunk(bytes, continues_frame);
    let mut runtime_state = if scan.submitted {
        host.record_controller_submit(fence)?
    } else {
        host.record_controller_write(fence)?;
        None
    };
    // Each projection is the Host's whole current state, so the newest one
    // supersedes any earlier one from the same chunk.
    for edit in scan.edits {
        if let Some(projection) = host.record_controller_draft_edit(fence, edit)? {
            runtime_state = Some(projection);
        }
    }
    Ok(runtime_state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ControllerDraftEdit::{EditedUncounted, Erased, Inserted, InsertedUncounted};

    #[test]
    fn plain_typing_is_not_a_submit() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe("사가 4단계".as_bytes()).submitted);
        assert!(!scanner.observe(b"a").submitted);
        assert!(!scanner.observe(b"\x1b[A").submitted);
    }

    #[test]
    fn alt_enter_keeps_one_frame_semantics_across_partial_writes() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe_chunk(b"\x1b", false).submitted);
        assert!(!scanner.observe_chunk(b"\r", true).submitted);
        let mut separate_frames = SubmitScanner::default();
        assert!(!separate_frames.observe_chunk(b"\x1b", false).submitted);
        assert!(separate_frames.observe_chunk(b"\r", false).submitted);
    }

    #[test]
    fn a_non_inserting_key_is_one_whole_chunk_outside_paste() {
        let scanner = SubmitScanner::default();
        for (keypress, fold) in NON_INSERTING_KEY_CHUNKS {
            assert_eq!(
                scanner.non_inserting_key_fold(keypress),
                Some(*fold),
                "{keypress:?}"
            );
            assert!(!SubmitScanner::default().observe(keypress).submitted);
        }
        assert_eq!(
            scanner.non_inserting_key_fold(b"\x1b"),
            Some(DraftFold::InterruptRequest)
        );
        assert_eq!(
            scanner.non_inserting_key_fold(b"\x1b[D"),
            Some(DraftFold::Edit(EditedUncounted))
        );
        assert_eq!(
            scanner.non_inserting_key_fold(b"\x7f"),
            Some(DraftFold::Edit(Erased(1)))
        );
        for chunk in [
            b"".as_slice(),
            b"\x1b[D\x1b[D",
            b"\x7fx",
            b"\x7f\x7f",
            b"\x1b[A",
            b"\x1b[5~",
            b"\x1b[1;2D",
            b"\x1bb",
            b"\t",
            b"\r",
        ] {
            assert_eq!(scanner.non_inserting_key_fold(chunk), None, "{chunk:?}");
        }
        let mut pasting = SubmitScanner::default();
        pasting.observe(b"\x1b[200~");
        assert_eq!(pasting.non_inserting_key_fold(b"\x7f"), None);
        pasting.observe(b"\x1b[201~");
        assert_eq!(
            pasting.non_inserting_key_fold(b"\x7f"),
            Some(DraftFold::Edit(Erased(1)))
        );
    }

    #[test]
    fn typed_characters_and_backspaces_are_counted_and_other_controls_are_not() {
        let mut scanner = SubmitScanner::default();
        assert_eq!(scanner.observe(b"ab").edits, vec![Inserted(2)]);
        assert_eq!(scanner.observe("한글".as_bytes()).edits, vec![Inserted(2)]);
        assert_eq!(scanner.observe(b"\x7f\x7f\x08").edits, vec![Erased(3)]);
        assert_eq!(
            scanner.observe(b"ab\x7f").edits,
            vec![Inserted(2), Erased(1)]
        );
        assert_eq!(scanner.observe(b"\t").edits, vec![InsertedUncounted]);
        assert_eq!(scanner.observe(b"\x12\x19").edits, vec![InsertedUncounted]);
        assert_eq!(
            scanner.observe(b"\x1b[A").edits,
            vec![InsertedUncounted, Inserted(2)]
        );
        assert_eq!(scanner.observe(b"\x1b\r").edits, vec![InsertedUncounted]);
        assert_eq!(scanner.observe(b"").edits, Vec::new());
    }

    #[test]
    fn a_character_split_across_pty_writes_counts_once() {
        let mut scanner = SubmitScanner::default();
        let syllable = "한".as_bytes();
        assert_eq!(
            scanner.observe_chunk(&syllable[..1], false).edits,
            vec![Inserted(1)]
        );
        assert_eq!(
            scanner.observe_chunk(&syllable[1..], true).edits,
            Vec::new()
        );
    }

    #[test]
    fn pasted_bytes_are_inserted_text_newlines_included() {
        let mut scanner = SubmitScanner::default();
        let scan = scanner.observe(b"\x1b[200~a\nb\r\x1b[201~");
        assert!(!scan.submitted);
        assert_eq!(scan.edits, vec![Inserted(4)]);
        assert_eq!(scanner.observe(b"\x1b[200~\x1b[201~").edits, Vec::new());
    }

    #[test]
    fn enter_is_a_submit() {
        assert!(SubmitScanner::default().observe(b"\r").submitted);
        assert!(SubmitScanner::default().observe(b"\n").submitted);
        assert!(SubmitScanner::default().observe(b"fix it\r").submitted);
    }

    #[test]
    fn only_edits_after_the_last_submit_remain_pending() {
        let scan = SubmitScanner::default().observe(b"run\rnext draft");
        assert!(scan.submitted);
        assert_eq!(scan.edits, vec![Inserted(10)]);

        let final_submit = SubmitScanner::default().observe(b"one\rtwo\r");
        assert!(final_submit.submitted);
        assert_eq!(final_submit.edits, Vec::new());
    }

    #[test]
    fn bracketed_paste_newlines_are_not_submits() {
        let mut scanner = SubmitScanner::default();
        assert!(
            !scanner
                .observe(b"\x1b[200~line1\nline2\r\x1b[201~")
                .submitted
        );
        assert!(scanner.observe(b"\r").submitted);
    }

    #[test]
    fn paste_markers_split_across_frames_are_tracked() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe(b"\x1b[2").submitted);
        assert!(!scanner.observe(b"00~pasted\r").submitted);
        assert!(!scanner.observe(b"still pasted\n\x1b").submitted);
        assert!(!scanner.observe(b"[201~").submitted);
        assert!(scanner.observe(b"\r").submitted);
    }

    #[test]
    fn alt_enter_inserts_a_newline_without_submitting() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe(b"\x1b\r").submitted);
        assert!(!scanner.observe(b"typing\x1b\ncontinued").submitted);
    }

    // Esc (its own frame) then Enter (a later frame) is two keypresses — an
    // interrupt followed by a real submit — not an Alt+Enter chord, which a
    // terminal always delivers in one frame.
    #[test]
    fn escape_keypress_then_enter_is_a_submit() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe(b"\x1b").submitted);
        assert!(scanner.observe(b"\r").submitted);
    }

    #[test]
    fn escape_sequence_before_enter_still_submits() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe(b"\x1b[").submitted);
        assert!(scanner.observe(b"A\r").submitted);
    }

    // A terminal attached with `hmux attach` reports focus changes and mouse
    // events on its own once the repaint turns those modes on. They are not
    // typing, so they leave the line as it was.
    #[test]
    fn focus_and_sgr_mouse_reports_are_not_typed_text() {
        for report in [
            b"\x1b[I".as_slice(),
            b"\x1b[O",
            b"\x1b[<0;10;5M",
            b"\x1b[<0;10;5m",
            b"\x1b[<35;120;48M",
            // A wheel turned quickly batches reports into one read.
            b"\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M",
            b"\x1b[O\x1b[<0;3;4M\x1b[I",
        ] {
            let scan = SubmitScanner::default().observe(report);
            assert!(!scan.submitted, "{}", report.escape_ascii());
            assert_eq!(scan.edits, Vec::new(), "{}", report.escape_ascii());
        }
    }

    #[test]
    fn text_around_a_terminal_report_is_still_counted() {
        let mut scanner = SubmitScanner::default();
        assert_eq!(scanner.observe(b"\x1b[Iab").edits, vec![Inserted(2)]);
        assert_eq!(
            scanner.observe(b"a\x1b[<0;1;1Mb\x7f").edits,
            vec![Inserted(2), Erased(1)]
        );
        let scan = scanner.observe(b"run\x1b[O\r");
        assert!(scan.submitted);
        assert_eq!(scan.edits, Vec::new());
    }

    #[test]
    fn report_shaped_bytes_inside_a_paste_are_pasted_text() {
        let mut scanner = SubmitScanner::default();
        assert_eq!(
            scanner.observe(b"\x1b[200~\x1b[I\x1b[201~").edits,
            vec![Inserted(3)]
        );
    }

    // Only complete reports are recognized. X10 and urxvt mouse encodings
    // cannot be told from a key or typed text, so they stay input the Host
    // cannot count.
    #[test]
    fn incomplete_or_ambiguous_reports_stay_uncounted_input() {
        for bytes in [
            b"\x1b[<0;10M".as_slice(),
            b"\x1b[<;1;1M",
            b"\x1b[<0;1;1;1M",
            b"\x1b[<0;1;1X",
            b"\x1b[M !!",
            b"\x1b[0;1;1M",
        ] {
            assert_eq!(
                SubmitScanner::default().observe(bytes).edits.first(),
                Some(&InsertedUncounted),
                "{}",
                bytes.escape_ascii()
            );
        }
    }

    // A writer can vanish mid-paste (crash, network drop); without a reset the
    // scanner would classify every later Enter as paste content forever.
    #[test]
    fn reset_recovers_from_an_unclosed_bracketed_paste() {
        let mut scanner = SubmitScanner::default();
        assert!(!scanner.observe(b"\x1b[200~orphaned").submitted);
        assert!(!scanner.observe(b"\r").submitted);
        scanner.reset();
        assert!(scanner.observe(b"\r").submitted);
    }
}
