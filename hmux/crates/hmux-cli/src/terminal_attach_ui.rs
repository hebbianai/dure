use crate::output;
use std::io::{self, IsTerminal, Write};

const SYNCHRONIZED_OUTPUT_BEGIN: &[u8] = b"\x1b[?2026h";
const SYNCHRONIZED_OUTPUT_END: &[u8] = b"\x1b[?2026l";

pub(crate) fn write_synchronized_repaint<W: Write>(
    output: &mut W,
    repaint_bytes: &[u8],
) -> io::Result<()> {
    let mut frame = Vec::with_capacity(
        SYNCHRONIZED_OUTPUT_BEGIN.len() + repaint_bytes.len() + SYNCHRONIZED_OUTPUT_END.len(),
    );
    frame.extend_from_slice(SYNCHRONIZED_OUTPUT_BEGIN);
    frame.extend_from_slice(repaint_bytes);
    frame.extend_from_slice(SYNCHRONIZED_OUTPUT_END);
    output.write_all(&frame)?;
    output.flush()
}

pub(crate) fn write_terminal_repaint(
    display_name: &str,
    repaint_bytes: &[u8],
    synchronized_output_open: bool,
) -> Result<(), output::StdoutError> {
    if synchronized_output_open {
        output::write_bytes(repaint_bytes)?;
        output::flush()?;
    } else {
        write_synchronized_repaint(&mut io::stdout(), repaint_bytes)
            .map_err(output::StdoutError::from)?;
    }
    write_terminal_title(display_name)
}

pub(crate) fn write_terminal_delta(
    display_name: &str,
    bytes: &[u8],
) -> Result<(), output::StdoutError> {
    let title_changed = terminal_bytes_change_title(bytes);
    output::write_bytes(bytes)?;
    output::flush()?;
    if title_changed {
        write_terminal_title(display_name)?;
    }
    Ok(())
}

pub(crate) fn write_terminal_title(display_name: &str) -> Result<(), output::StdoutError> {
    if !io::stdout().is_terminal() {
        return Ok(());
    }
    let name = display_name
        .chars()
        .filter(|character| !character.is_control())
        .take(24)
        .collect::<String>();
    output::write(format_args!("\x1b]0;hmux name · {name}\x07"))?;
    output::flush()
}

pub(crate) fn begin_synchronized_output() -> Result<(), output::StdoutError> {
    output::write_bytes(SYNCHRONIZED_OUTPUT_BEGIN)?;
    output::flush()
}

pub(crate) fn finish_synchronized_output() {
    let _ = output::write_bytes(SYNCHRONIZED_OUTPUT_END);
    let _ = output::flush();
}

fn terminal_bytes_change_title(bytes: &[u8]) -> bool {
    bytes
        .windows(4)
        .any(|window| matches!(window, b"\x1b]0;" | b"\x1b]2;"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingWriter {
        bytes: Vec<u8>,
        flushes: usize,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[test]
    fn synchronized_repaint_has_one_flush_and_exact_frame_boundaries() {
        let mut writer = RecordingWriter::default();
        write_synchronized_repaint(&mut writer, b"snapshot").unwrap();

        assert_eq!(writer.bytes, b"\x1b[?2026hsnapshot\x1b[?2026l");
        assert_eq!(writer.flushes, 1);
    }

    #[test]
    fn title_detection_accepts_only_osc_title_prefixes() {
        assert!(terminal_bytes_change_title(b"before\x1b]0;name\x07after"));
        assert!(terminal_bytes_change_title(b"\x1b]2;name\x07"));
        assert!(!terminal_bytes_change_title(b"\x1b[31mcolor"));
    }
}
