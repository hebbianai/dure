const CLEAR_ALL_TAB_STOPS: &[u8] = b"\x1b[3g";

/// Returns the cursor to column one after a repaint's tab-stop restoration.
///
/// Ghostty's VT formatter restores tab stops just before the screen contents
/// by clearing them (`CSI 3 g`) and, for each stop, moving the cursor there
/// (`CSI n G`) and setting it (`ESC H`). It then paints the first row from
/// wherever the last stop left the cursor, so a fresh terminal replaying the
/// repaint starts that row near the right edge, wraps it, and pushes every
/// following row down; a full screen loses its top row. Formatted screen
/// contents never contain `CSI 3 g`, so the first one starts that block. A
/// carriage return after it restores column one and changes no other state.
/// Repaints without the block, or already homed after it, are left unchanged.
pub fn home_column_after_tab_stops(repaint: &mut Vec<u8>) {
    let Some(start) = repaint
        .windows(CLEAR_ALL_TAB_STOPS.len())
        .position(|window| window == CLEAR_ALL_TAB_STOPS)
    else {
        return;
    };
    let mut end = start + CLEAR_ALL_TAB_STOPS.len();
    while let Some(length) = set_tab_stop_length(&repaint[end..]) {
        end += length;
    }
    if repaint.get(end) != Some(&b'\r') {
        repaint.insert(end, b'\r');
    }
}

/// Length of one leading `CSI <column> G ESC H` tab-stop assignment.
fn set_tab_stop_length(bytes: &[u8]) -> Option<usize> {
    let column = bytes.strip_prefix(b"\x1b[")?;
    let digits = column
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    (digits > 0 && column[digits..].starts_with(b"G\x1bH")).then_some(2 + digits + 3)
}

#[cfg(test)]
mod tests {
    use super::home_column_after_tab_stops;

    fn homed(repaint: &[u8]) -> Vec<u8> {
        let mut repaint = repaint.to_vec();
        home_column_after_tab_stops(&mut repaint);
        repaint
    }

    #[test]
    fn returns_to_column_one_after_the_last_restored_tab_stop() {
        assert_eq!(
            homed(b"\x1b[?1049h\x1b[3g\x1b[9G\x1bH\x1b[17G\x1bH\x1b[0mfirst\r\nsecond"),
            b"\x1b[?1049h\x1b[3g\x1b[9G\x1bH\x1b[17G\x1bH\r\x1b[0mfirst\r\nsecond"
        );
        assert_eq!(homed(b"\x1b[3gtext"), b"\x1b[3g\rtext");
    }

    #[test]
    fn leaves_repaints_without_tab_stops_or_already_homed_unchanged() {
        for repaint in [
            &b"\x1b[H\x1b[2Jplain"[..],
            &b"\x1b[3g\x1b[9G\x1bH\r\nrow"[..],
            &b""[..],
        ] {
            assert_eq!(homed(repaint), repaint);
        }
    }

    #[test]
    fn homing_is_idempotent() {
        let once = homed(b"\x1b[3g\x1b[9G\x1bHrow");
        assert_eq!(homed(&once), once);
    }
}
