const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
const MARKER_LEN: usize = PASTE_START.len();

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct SubmitScan {
    submitted: bool,
    input_after_last_submit: bool,
}

/// Streaming classifier for controller input: reports both whether a chunk
/// carries a submit keystroke and whether accepted bytes remain after its last
/// submit. Typing, arrow keys, and pasted newlines are presence, not evidence
/// that the provider started working. A bare CR/LF outside bracketed paste
/// (and not the newline half of Alt+Enter) submits input. Paste envelopes
/// and Alt+Enter pairs may split across input frames, so the scanner keeps the
/// unfinished marker prefix between calls.
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
                scan.input_after_last_submit |= scan.submitted;
                self.in_bracketed_paste = true;
                index += MARKER_LEN;
                continue;
            }
            if rest.starts_with(PASTE_END) {
                scan.input_after_last_submit |= scan.submitted;
                self.in_bracketed_paste = false;
                index += MARKER_LEN;
                continue;
            }
            if rest[0] == 0x1b {
                // The frame may end inside a paste envelope marker; defer
                // those bytes to the next chunk instead of misreading them
                // byte-wise.
                if rest.len() < MARKER_LEN
                    && (PASTE_START.starts_with(rest) || PASTE_END.starts_with(rest))
                {
                    scan.input_after_last_submit |= scan.submitted;
                    self.carried = rest.to_vec();
                    return scan;
                }
                // Alt+Enter (newline insert, not a submit) always arrives as
                // one frame. A carried ESC completed by a later frame is two
                // keypresses — Esc, then a real Enter — so only pair fresh
                // bytes.
                if index >= carried_len && matches!(rest.get(1), Some(b'\r') | Some(b'\n')) {
                    scan.input_after_last_submit |= scan.submitted;
                    index += 2;
                    continue;
                }
            }
            if !self.in_bracketed_paste && matches!(rest[0], b'\r' | b'\n') {
                scan.submitted = true;
                scan.input_after_last_submit = false;
            } else {
                scan.input_after_last_submit |= scan.submitted;
            }
            index += 1;
        }
        scan
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
) -> Result<
    Option<hmux_host::local_protocol::AgentRuntimeStateProjection>,
    hmux_host::session_host::SessionHostError,
> {
    // Legacy byte input has no typed Key intent. A bare Escape outside paste
    // is control traffic, not a draft. Still feed the scanner so a later Enter
    // remains a separate submit, and never erase previously retained input.
    if bytes == b"\x1b" && !scanner.in_bracketed_paste {
        host.record_controller_write(fence)?;
    } else {
        host.record_controller_input(fence)?;
    }
    let scan = scanner.observe_chunk(bytes, continues_frame);
    let runtime_state = if scan.submitted {
        host.record_controller_submit(fence)?
    } else {
        None
    };
    if scan.input_after_last_submit {
        host.record_controller_input(fence)?;
    }
    Ok(runtime_state)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn enter_is_a_submit() {
        assert!(SubmitScanner::default().observe(b"\r").submitted);
        assert!(SubmitScanner::default().observe(b"\n").submitted);
        assert!(SubmitScanner::default().observe(b"fix it\r").submitted);
    }

    #[test]
    fn input_after_the_last_submit_remains_pending() {
        let scan = SubmitScanner::default().observe(b"run\rnext draft");
        assert!(scan.submitted);
        assert!(scan.input_after_last_submit);

        let final_submit = SubmitScanner::default().observe(b"one\rtwo\r");
        assert!(final_submit.submitted);
        assert!(!final_submit.input_after_last_submit);
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
