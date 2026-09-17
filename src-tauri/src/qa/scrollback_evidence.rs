pub(super) fn canonical_snapshot_scrollback_history_line_count(bytes: &[u8]) -> usize {
    const PREFIX: &[u8] = b"HMUX_SCROLL_QA_LINE_";
    const DIGITS: usize = 4;

    // An interactive shell can repaint the fixture's printf source. Count its
    // numbered output, preserving duplicates for the exact-count assertion.
    bytes
        .windows(PREFIX.len() + DIGITS)
        .filter(|window| {
            window.starts_with(PREFIX) && window[PREFIX.len()..].iter().all(u8::is_ascii_digit)
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::canonical_snapshot_scrollback_history_line_count;

    #[test]
    fn counts_numbered_scrollback_history() {
        let bytes = b"HMUX_SCROLL_QA_LINE_0001 one\r\nnoise\r\nHMUX_SCROLL_QA_LINE_0002 two\r\n";

        assert_eq!(canonical_snapshot_scrollback_history_line_count(bytes), 2);
    }

    #[test]
    fn counts_numbered_history_without_counting_echoed_printf_source() {
        let bytes = concat!(
            "printf '\\033[31mHMUX_SCROLL_QA_LINE_%04d\\033[0m canonical-history\\n' \"$i\";\r\n",
            "\x1b[31mHMUX_SCROLL_QA_LINE_0001\x1b[0m canonical-history\r\n",
            "\x1b[31mHMUX_SCROLL_QA_LINE_0002\x1b[0m canonical-history\r\n",
        );

        assert_eq!(
            canonical_snapshot_scrollback_history_line_count(bytes.as_bytes()),
            2,
        );
    }

    #[test]
    fn preserves_duplicate_numbered_output_in_the_count() {
        let bytes = b"HMUX_SCROLL_QA_LINE_0001\r\nHMUX_SCROLL_QA_LINE_0001\r\n";

        assert_eq!(canonical_snapshot_scrollback_history_line_count(bytes), 2);
    }

    #[test]
    fn echoed_source_cannot_replace_missing_numbered_output() {
        let bytes = b"printf 'HMUX_SCROLL_QA_LINE_%04d' 1\r\n";

        assert_eq!(canonical_snapshot_scrollback_history_line_count(bytes), 0);
    }
}
