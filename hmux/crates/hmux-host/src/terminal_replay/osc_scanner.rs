//! Streaming recognition of the OSC strings the Host handles itself.
//!
//! The terminal core owns emulation and drops OSC numbers it does not know.
//! This observes the same serialized PTY bytes at the Host boundary and hands
//! each complete payload that starts with one of a fixed set of prefixes to its
//! owner, in stream order. A sequence split across reads still completes;
//! look-alike text inside DCS/SOS/PM/APC strings is never interpreted; and a
//! payload is buffered only while it can still match, up to its owner's bound.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OscTerminator {
    Bel,
    St,
}

impl OscTerminator {
    pub(super) fn bytes(self) -> &'static [u8] {
        match self {
            Self::Bel => b"\x07",
            Self::St => b"\x1b\\",
        }
    }
}

/// One owner's OSC payload prefix (`<number>;...`) and its buffering bound.
/// No prefix in a filter set may be a prefix of another.
pub(super) struct OscFilter {
    pub prefix: &'static [u8],
    pub max_payload_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum OscScanEvent<'a> {
    /// A complete OSC whose payload starts with `filters[filter].prefix`.
    Osc {
        filter: usize,
        payload: &'a [u8],
        terminator: OscTerminator,
    },
    /// RIS (`ESC c`), the full terminal reset.
    FullReset,
}

#[derive(Clone, Copy, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    String,
    StringEscape,
}

pub(super) struct OscScanner {
    filters: &'static [OscFilter],
    state: State,
    pending: Vec<u8>,
    /// Bit `i` is set while `filters[i]` can still match the pending payload.
    candidates: u32,
}

impl OscScanner {
    pub(super) const fn new(filters: &'static [OscFilter]) -> Self {
        assert!(filters.len() <= u32::BITS as usize);
        Self {
            filters,
            state: State::Ground,
            pending: Vec::new(),
            candidates: 0,
        }
    }

    pub(super) fn ingest(&mut self, bytes: &[u8], mut on_event: impl FnMut(OscScanEvent<'_>)) {
        for &byte in bytes {
            // CAN and SUB abort any sequence in progress.
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
                State::Escape => self.escape(byte, &mut on_event),
                State::Osc => match byte {
                    0x07 => self.finish(OscTerminator::Bel, &mut on_event),
                    0x1b => self.state = State::OscEscape,
                    _ => self.accumulate(byte),
                },
                State::OscEscape => {
                    if byte == b'\\' {
                        self.finish(OscTerminator::St, &mut on_event);
                    } else {
                        // ESC ends the OSC unterminated and starts a new escape.
                        self.pending.clear();
                        self.escape(byte, &mut on_event);
                    }
                }
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
    }

    #[cfg(test)]
    pub(super) fn buffered_len(&self) -> usize {
        self.pending.len()
    }

    fn escape(&mut self, byte: u8, on_event: &mut impl FnMut(OscScanEvent<'_>)) {
        self.state = match byte {
            b']' => {
                self.pending.clear();
                self.candidates = ((1_u64 << self.filters.len()) - 1) as u32;
                State::Osc
            }
            b'P' | b'X' | b'^' | b'_' => State::String,
            0x1b => State::Escape,
            b'c' => {
                on_event(OscScanEvent::FullReset);
                State::Ground
            }
            _ => State::Ground,
        };
    }

    fn accumulate(&mut self, byte: u8) {
        if self.candidates == 0 {
            return;
        }
        let index = self.pending.len();
        for (bit, filter) in self.filters.iter().enumerate() {
            if index >= filter.max_payload_bytes
                || filter
                    .prefix
                    .get(index)
                    .is_some_and(|&expected| expected != byte)
            {
                self.candidates &= !(1 << bit);
            }
        }
        if self.candidates == 0 {
            self.pending.clear();
        } else {
            self.pending.push(byte);
        }
    }

    fn finish(&mut self, terminator: OscTerminator, on_event: &mut impl FnMut(OscScanEvent<'_>)) {
        if self.candidates != 0 {
            if let Some(filter) = self
                .filters
                .iter()
                .position(|filter| self.pending.starts_with(filter.prefix))
            {
                on_event(OscScanEvent::Osc {
                    filter,
                    payload: &self.pending,
                    terminator,
                });
            }
        }
        self.pending.clear();
        self.state = State::Ground;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILTERS: &[OscFilter] = &[
        OscFilter {
            prefix: b"7501;",
            max_payload_bytes: 16,
        },
        OscFilter {
            prefix: b"133;",
            max_payload_bytes: 8,
        },
    ];

    #[derive(Debug, Eq, PartialEq)]
    enum Seen {
        Osc(usize, Vec<u8>, OscTerminator),
        FullReset,
    }

    fn scan(scanner: &mut OscScanner, bytes: &[u8]) -> Vec<Seen> {
        let mut seen = Vec::new();
        scanner.ingest(bytes, |event| {
            seen.push(match event {
                OscScanEvent::Osc {
                    filter,
                    payload,
                    terminator,
                } => Seen::Osc(filter, payload.to_vec(), terminator),
                OscScanEvent::FullReset => Seen::FullReset,
            })
        });
        seen
    }

    #[test]
    fn every_chunk_boundary_yields_the_same_events_in_stream_order() {
        let stream = b"a\x1b]7501;?\x1b\\b\x1b]133;A\x07\x1bc\x1b]7501;state=idle\x07";
        let expected = vec![
            Seen::Osc(0, b"7501;?".to_vec(), OscTerminator::St),
            Seen::Osc(1, b"133;A".to_vec(), OscTerminator::Bel),
            Seen::FullReset,
            Seen::Osc(0, b"7501;state=idle".to_vec(), OscTerminator::Bel),
        ];
        for split in 0..=stream.len() {
            let mut scanner = OscScanner::new(FILTERS);
            let mut seen = scan(&mut scanner, &stream[..split]);
            seen.extend(scan(&mut scanner, &stream[split..]));
            assert_eq!(seen, expected, "split at {split}");
        }
    }

    #[test]
    fn unrelated_cancelled_interrupted_nested_and_oversized_sequences_are_ignored() {
        let mut scanner = OscScanner::new(FILTERS);
        for bytes in [
            b"\x1b]0;title\x07".as_slice(),
            b"\x1b]75010;x\x07",
            b"\x1b]7501;x\x18\x07",
            b"\x1b]7501;x\x1a\x07",
            b"\x1bP\x1b]7501;x\x07\x1b\\",
            b"\x1b_\x1b]133;A\x07\x1b\\",
            b"\x1b]7501;0123456789ab\x07",
            b"\x1b]133;A;aid=9\x07",
        ] {
            assert_eq!(scan(&mut scanner, bytes), [], "{bytes:?}");
            assert!(scanner.buffered_len() <= 16);
        }
        // ESC that is not ST abandons the OSC and is itself interpreted.
        assert_eq!(scan(&mut scanner, b"\x1b]7501;x\x1bc"), [Seen::FullReset]);
        assert_eq!(
            scan(&mut scanner, b"\x1b]7501;x\x07"),
            [Seen::Osc(0, b"7501;x".to_vec(), OscTerminator::Bel)]
        );
    }

    #[test]
    fn a_payload_at_its_exact_bound_is_delivered() {
        let mut scanner = OscScanner::new(FILTERS);
        let payload = b"7501;0123456789a";
        assert_eq!(payload.len(), 16);
        assert_eq!(
            scan(
                &mut scanner,
                &[b"\x1b]".as_slice(), payload, b"\x07"].concat()
            ),
            [Seen::Osc(0, payload.to_vec(), OscTerminator::Bel)]
        );
    }
}
