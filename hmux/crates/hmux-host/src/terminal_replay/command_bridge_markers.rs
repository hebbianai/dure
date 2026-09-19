// The private command-bridge OSC is a Host/client handoff, not terminal
// emulation. Observe it at the serialized PTY boundary; Ghostty still owns
// every screen, mode and standard terminal effect. Never replay a handoff
// while restoring a terminal checkpoint.
const PREFIX: &[u8] = b"778;dure-hmux-command-bridge-v1;";
const MAX_OSC_BYTES: usize = 4 + 4096; // The typed event label's wire limit.
const MAX_MARKERS_PER_WRITE: usize = 32;

#[derive(Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    String,
    StringEscape,
}

#[derive(Default)]
pub(super) struct CommandBridgeMarkers {
    state: State,
    pending: Vec<u8>,
    rejected: bool,
}

impl CommandBridgeMarkers {
    pub(super) fn ingest(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        let mut markers = Vec::new();
        let mut overflow = false;
        for &byte in bytes {
            if matches!(byte, 0x18 | 0x1a) {
                self.state = State::Ground;
                self.pending.clear();
                continue;
            }
            match self.state {
                State::Ground => {
                    if byte == 0x1b {
                        self.state = State::Escape;
                    }
                }
                State::Escape => self.escape(byte),
                State::Osc => match byte {
                    0x07 => self.finish(&mut markers, &mut overflow),
                    0x1b => self.state = State::OscEscape,
                    _ => {
                        let index = self.pending.len();
                        if self.rejected {
                            continue;
                        }
                        if index >= MAX_OSC_BYTES
                            || (index < PREFIX.len() && byte != PREFIX[index])
                            || (index >= PREFIX.len()
                                && !byte.is_ascii_alphanumeric()
                                && !b"_-".contains(&byte))
                        {
                            self.rejected = true;
                            self.pending.clear();
                        } else {
                            self.pending.push(byte);
                        }
                    }
                },
                State::OscEscape => {
                    if byte == b'\\' {
                        self.finish(&mut markers, &mut overflow);
                    } else {
                        self.pending.clear();
                        self.escape(byte);
                    }
                }
                // Do not interpret marker-looking text inside DCS/SOS/PM/APC.
                State::String => {
                    if byte == 0x1b {
                        self.state = State::StringEscape;
                    }
                }
                State::StringEscape => {
                    self.state = match byte {
                        b'\\' => State::Ground,
                        0x1b => State::StringEscape,
                        _ => State::String,
                    };
                }
            }
        }
        (markers, overflow)
    }

    fn escape(&mut self, byte: u8) {
        self.state = match byte {
            b']' => {
                self.pending.clear();
                self.rejected = false;
                State::Osc
            }
            b'P' | b'X' | b'^' | b'_' => State::String,
            0x1b => State::Escape,
            _ => State::Ground,
        };
    }

    fn finish(&mut self, markers: &mut Vec<String>, overflow: &mut bool) {
        if !self.rejected && self.pending.len() > PREFIX.len() {
            if markers.len() < MAX_MARKERS_PER_WRITE {
                // All accepted bytes are ASCII; strip only the OSC number.
                markers.push(String::from_utf8_lossy(&self.pending[4..]).into_owned());
            } else {
                *overflow = true;
            }
        }
        self.pending.clear();
        self.state = State::Ground;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &[u8] = b"\x1b]778;dure-hmux-command-bridge-v1;eyJvayI6dHJ1ZX0\x07";

    #[test]
    fn command_bridge_markers_accept_both_terminators_at_every_chunk_boundary() {
        for bytes in [
            MARKER.to_vec(),
            [&MARKER[..MARKER.len() - 1], b"\x1b\\"].concat(),
        ] {
            for split in 0..=bytes.len() {
                let mut scanner = CommandBridgeMarkers::default();
                let (mut markers, _) = scanner.ingest(&bytes[..split]);
                markers.extend(scanner.ingest(&bytes[split..]).0);
                assert_eq!(markers, ["dure-hmux-command-bridge-v1;eyJvayI6dHJ1ZX0"]);
            }
        }
    }

    #[test]
    fn command_bridge_markers_ignore_unrelated_cancelled_nested_and_oversized_strings() {
        let mut scanner = CommandBridgeMarkers::default();
        for bytes in [
            b"\x1b]0;title\x07".to_vec(),
            b"\x1b]778;other;abc\x07".to_vec(),
            b"\x1b]778;dure-hmux-command-bridge-v1;abc\x18\x07".to_vec(),
            b"\x1b]778;dure-hmux-command-bridge-v1;\xff\x07".to_vec(),
            [b"\x1bP".as_slice(), MARKER, b"\x1b\\"].concat(),
            [
                b"\x1b]".as_slice(),
                PREFIX,
                &vec![b'a'; MAX_OSC_BYTES],
                b"\x07",
            ]
            .concat(),
        ] {
            assert!(scanner.ingest(&bytes).0.is_empty());
            assert!(scanner.pending.len() <= MAX_OSC_BYTES);
        }
        assert_eq!(scanner.ingest(MARKER).0.len(), 1);
    }

    #[test]
    fn command_bridge_markers_bound_one_output_batch() {
        let mut scanner = CommandBridgeMarkers::default();
        let (markers, overflow) = scanner.ingest(&MARKER.repeat(MAX_MARKERS_PER_WRITE + 1));
        assert_eq!(markers.len(), MAX_MARKERS_PER_WRITE);
        assert!(overflow);
        assert!(!scanner.ingest(MARKER).1);
    }
}
