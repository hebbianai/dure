// The private command-bridge OSC is a Host/client handoff, not terminal
// emulation. Observe it at the serialized PTY boundary; Ghostty still owns
// every screen, mode and standard terminal effect. Never replay a handoff
// while restoring a terminal checkpoint.
use super::osc_scanner::{OscFilter, OscScanEvent, OscScanner};

const PREFIX: &[u8] = b"778;dure-hmux-command-bridge-v1;";
const MAX_OSC_BYTES: usize = 4 + 4096; // The typed event label's wire limit.
const MAX_MARKERS_PER_WRITE: usize = 32;
const FILTERS: &[OscFilter] = &[OscFilter {
    prefix: PREFIX,
    max_payload_bytes: MAX_OSC_BYTES,
}];

pub(super) struct CommandBridgeMarkers {
    scanner: OscScanner,
}

impl Default for CommandBridgeMarkers {
    fn default() -> Self {
        Self {
            scanner: OscScanner::new(FILTERS),
        }
    }
}

impl CommandBridgeMarkers {
    pub(super) fn ingest(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        let mut markers = Vec::new();
        let mut overflow = false;
        self.scanner.ingest(bytes, |event| {
            let OscScanEvent::Osc { payload, .. } = event else {
                return;
            };
            let label = &payload[PREFIX.len()..];
            if label.is_empty()
                || !label
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(byte))
            {
                return;
            }
            if markers.len() < MAX_MARKERS_PER_WRITE {
                // All accepted bytes are ASCII; strip only the OSC number.
                markers.push(String::from_utf8_lossy(&payload[4..]).into_owned());
            } else {
                overflow = true;
            }
        });
        (markers, overflow)
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
            assert!(scanner.scanner.buffered_len() <= MAX_OSC_BYTES);
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
