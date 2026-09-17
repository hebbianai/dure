use super::ReplayResult;
use crate::local_protocol::{OutputDelta, ReconnectCursor, ReplayGap};
use std::collections::VecDeque;

pub(super) struct DeltaRetention {
    records: VecDeque<OutputDelta>,
    retained_bytes: usize,
    max_records: usize,
    max_bytes: usize,
}

impl DeltaRetention {
    pub(super) fn new(max_records: usize, max_bytes: usize) -> Self {
        Self {
            records: VecDeque::new(),
            retained_bytes: 0,
            max_records,
            max_bytes,
        }
    }

    pub(super) fn push(&mut self, delta: OutputDelta) {
        self.retained_bytes = self.retained_bytes.saturating_add(delta.bytes.len());
        self.records.push_back(delta);
        while self.records.len() > self.max_records || self.retained_bytes > self.max_bytes {
            let removed = self
                .records
                .pop_front()
                .expect("retention overflow implies at least one record");
            self.retained_bytes = self.retained_bytes.saturating_sub(removed.bytes.len());
        }
    }

    pub(super) fn earliest_sequence(&self, current_output_seq: u64) -> u64 {
        self.records.front().map_or_else(
            || current_output_seq.saturating_add(1),
            |delta| delta.output_seq,
        )
    }

    pub(super) fn replay_after(
        &self,
        cursor: &ReconnectCursor,
        terminal_epoch: &str,
        current_output_seq: u64,
    ) -> ReplayResult {
        let earliest = self.earliest_sequence(current_output_seq);
        if cursor.after_output_seq.saturating_add(1) < earliest {
            return ReplayResult::Gap(ReplayGap {
                cursor: cursor.clone(),
                earliest_retained_output_seq: earliest,
                current_output_seq,
            });
        }
        ReplayResult::Deltas(
            self.records
                .iter()
                .filter(|delta| {
                    delta.terminal_epoch == terminal_epoch
                        && delta.output_seq > cursor.after_output_seq
                })
                .cloned()
                .collect(),
        )
    }
}
