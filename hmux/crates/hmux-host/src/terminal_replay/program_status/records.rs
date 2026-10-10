//! The terminal's program status records (Program Status Protocol 0.3).
//!
//! One record per id; a report replaces its record whole. Records belong to
//! the terminal, not to a screen. `working` and `blocked` end at the next
//! prompt; `idle`, `done` and `error` last until replaced or cleared.
use super::report::{RecordId, ReportedRecord};
use crate::local_protocol::{ProgramStatusProjection, ProgramStatusState};
use std::collections::BTreeMap;

/// The protocol requires at least 64 and allows at most 256.
pub(super) const MAX_RECORDS: usize = 256;

struct StoredRecord {
    record: ReportedRecord,
    updated: u64,
}

#[derive(Default)]
pub(super) struct ProgramStatusRecords {
    records: BTreeMap<RecordId, StoredRecord>,
    clock: u64,
}

impl ProgramStatusRecords {
    /// Returns whether any record changed. A full table evicts its least
    /// recently updated record.
    pub(super) fn report(&mut self, id: RecordId, record: ReportedRecord) -> bool {
        self.clock += 1;
        if let Some(stored) = self.records.get_mut(&id) {
            stored.updated = self.clock;
            let changed = stored.record != record;
            stored.record = record;
            return changed;
        }
        if self.records.len() >= MAX_RECORDS {
            let oldest = self
                .records
                .iter()
                .min_by_key(|(_, stored)| stored.updated)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.records.remove(&oldest);
            }
        }
        self.records.insert(
            id,
            StoredRecord {
                record,
                updated: self.clock,
            },
        );
        true
    }

    /// Removes the addressed record and its descendants.
    pub(super) fn clear(&mut self, id: &RecordId) -> bool {
        self.retain(|candidate, _| !id.contains(candidate))
    }

    /// A new prompt ends whatever was running or waiting on the user.
    pub(super) fn end_activity(&mut self) -> bool {
        self.retain(|_, record| {
            !matches!(
                record.state,
                ProgramStatusState::Working | ProgramStatusState::Blocked
            )
        })
    }

    pub(super) fn clear_all(&mut self) -> bool {
        let changed = !self.records.is_empty();
        self.records.clear();
        changed
    }

    pub(super) fn root(&self) -> Option<ProgramStatusProjection> {
        self.records
            .get(&RecordId::root())
            .map(|stored| ProgramStatusProjection {
                state: stored.record.state,
                blocked_kind: stored.record.blocked_kind,
                app: stored.record.app.clone(),
                message: stored.record.message.clone(),
            })
    }

    fn retain(&mut self, mut keep: impl FnMut(&RecordId, &ReportedRecord) -> bool) -> bool {
        let before = self.records.len();
        self.records.retain(|id, stored| keep(id, &stored.record));
        self.records.len() != before
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.records.len()
    }
}

#[cfg(test)]
mod tests {
    use super::super::report::{ProgramStatusCommand, parse};
    use super::*;

    fn apply(records: &mut ProgramStatusRecords, body: &str) -> bool {
        match parse(body.as_bytes()).expect(body) {
            ProgramStatusCommand::Report { id, record } => records.report(id, record),
            ProgramStatusCommand::Clear { id } => records.clear(&id),
            ProgramStatusCommand::Query => unreachable!("{body}"),
        }
    }

    fn root_state(records: &ProgramStatusRecords) -> Option<ProgramStatusState> {
        records.root().map(|status| status.state)
    }

    #[test]
    fn a_report_replaces_its_record_whole_and_repeats_are_not_changes() {
        let mut records = ProgramStatusRecords::default();
        assert!(apply(&mut records, "state=working:app=claude-code"));
        assert!(!apply(&mut records, "state=working:app=claude-code"));
        assert!(
            !apply(&mut records, "state=working:app=claude-code:progress=30"),
            "progress is not presented, so it is not a change"
        );
        assert!(apply(&mut records, "state=working"));
        assert_eq!(records.root().unwrap().app, None);
    }

    #[test]
    fn clearing_removes_a_subtree_and_a_bare_clear_removes_everything() {
        let mut records = ProgramStatusRecords::default();
        for body in [
            "state=working",
            "state=working:id=task",
            "state=done:id=task/a",
            "state=idle:id=taskbar",
        ] {
            apply(&mut records, body);
        }
        assert!(apply(&mut records, "state=clear:id=task"));
        assert_eq!(records.len(), 2, "task and task/a are gone; taskbar is not");
        assert!(!apply(&mut records, "state=clear:id=task"));
        assert!(apply(&mut records, "state=clear"));
        assert_eq!(records.len(), 0);
    }

    #[test]
    fn a_prompt_ends_running_and_blocked_records_only() {
        let mut records = ProgramStatusRecords::default();
        for body in [
            "state=working:id=a",
            "state=blocked:id=b",
            "state=idle:id=c",
            "state=done:id=d",
            "state=error:id=e",
        ] {
            apply(&mut records, body);
        }
        assert!(records.end_activity());
        assert_eq!(records.len(), 3);
        assert!(!records.end_activity());
    }

    #[test]
    fn a_full_table_evicts_the_least_recently_updated_record() {
        let mut records = ProgramStatusRecords::default();
        apply(&mut records, "state=idle");
        for index in 1..MAX_RECORDS {
            apply(&mut records, &format!("state=idle:id=r{index}"));
        }
        // Refresh the root so r1 becomes the oldest record.
        apply(&mut records, "state=working");
        apply(&mut records, "state=idle:id=newest");
        assert_eq!(records.len(), MAX_RECORDS);
        assert_eq!(root_state(&records), Some(ProgramStatusState::Working));
        assert!(!apply(&mut records, "state=clear:id=r1"), "r1 was evicted");
    }

    #[test]
    fn only_the_root_record_is_projected() {
        let mut records = ProgramStatusRecords::default();
        apply(&mut records, "state=working:id=task/a");
        assert_eq!(records.root(), None);
        apply(&mut records, "state=blocked:kind=question:app=pi");
        assert_eq!(root_state(&records), Some(ProgramStatusState::Blocked));
        assert!(records.clear_all());
        assert!(!records.clear_all());
    }
}
