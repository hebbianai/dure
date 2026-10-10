//! OSC 7501, the Program Status Protocol 0.3, on the terminal side.
//!
//! A program asks whether its terminal speaks the protocol (`OSC 7501;?`) and,
//! once answered, reports its own state. The Host answers and keeps the
//! records the program wrote. They are presentation from the program about
//! itself, as trustworthy as the screen it draws: they never change Host-owned
//! agent semantics, and they are published only beside a running agent.
mod records;
mod report;

use super::osc_scanner::{OscFilter, OscScanEvent, OscScanner, OscTerminator};
use super::{TerminalReplay, TerminalReplayError};
use crate::local_protocol::{
    AgentRuntimeLifecycle, AgentRuntimeStateProjection, ProgramStatusProjection,
};
use records::ProgramStatusRecords;
use report::ProgramStatusCommand;

const PROGRAM_STATUS: usize = 0;
const PROMPT_MARK: usize = 1;
const PROGRAM_STATUS_PREFIX: &[u8] = b"7501;";
const PROMPT_MARK_PREFIX: &[u8] = b"133;";
/// The protocol bounds a whole sequence, from `ESC ]` through its terminator.
const MAX_SEQUENCE_BYTES: usize = 4096;
const OSC_INTRODUCER_BYTES: usize = 2;
const FILTERS: &[OscFilter] = &[
    OscFilter {
        prefix: PROGRAM_STATUS_PREFIX,
        max_payload_bytes: MAX_SEQUENCE_BYTES - OSC_INTRODUCER_BYTES - 1,
    },
    // Only the OSC 133 command letter matters; options may follow it.
    OscFilter {
        prefix: PROMPT_MARK_PREFIX,
        max_payload_bytes: 1024,
    },
];

pub(super) struct ProgramStatus {
    scanner: OscScanner,
    records: ProgramStatusRecords,
}

impl Default for ProgramStatus {
    fn default() -> Self {
        Self {
            scanner: OscScanner::new(FILTERS),
            records: ProgramStatusRecords::default(),
        }
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct ProgramStatusIngest {
    /// The support reply owed to the program, if it asked in this read.
    pub probe_reply: Vec<u8>,
    pub records_changed: bool,
}

impl ProgramStatus {
    /// Applies one serialized PTY read in stream order.
    pub(super) fn ingest(&mut self, bytes: &[u8]) -> ProgramStatusIngest {
        let Self { scanner, records } = self;
        let mut ingest = ProgramStatusIngest::default();
        scanner.ingest(bytes, |event| match event {
            OscScanEvent::Osc {
                filter: PROGRAM_STATUS,
                payload,
                terminator,
            } => {
                if OSC_INTRODUCER_BYTES + payload.len() + terminator.bytes().len()
                    > MAX_SEQUENCE_BYTES
                {
                    return;
                }
                match report::parse(&payload[PROGRAM_STATUS_PREFIX.len()..]) {
                    // One reply per read at most: replayed or pasted probes
                    // cannot amplify into more PTY input than they occupy.
                    Some(ProgramStatusCommand::Query) if ingest.probe_reply.is_empty() => {
                        ingest.probe_reply = probe_reply(terminator);
                    }
                    Some(ProgramStatusCommand::Query) | None => {}
                    Some(ProgramStatusCommand::Report { id, record }) => {
                        ingest.records_changed |= records.report(id, record);
                    }
                    Some(ProgramStatusCommand::Clear { id }) => {
                        ingest.records_changed |= records.clear(&id);
                    }
                }
            }
            OscScanEvent::Osc {
                filter: PROMPT_MARK,
                payload,
                ..
            } => {
                if is_prompt_start(&payload[PROMPT_MARK_PREFIX.len()..]) {
                    ingest.records_changed |= records.end_activity();
                }
            }
            OscScanEvent::Osc { .. } => {}
            OscScanEvent::FullReset => ingest.records_changed |= records.clear_all(),
        });
        ingest
    }

    pub(super) fn root(&self) -> Option<ProgramStatusProjection> {
        self.records.root()
    }

    /// An agent started or exited, so nothing reported before belongs to the
    /// agent that runs now. Returns whether any record was removed.
    pub(super) fn clear(&mut self) -> bool {
        self.records.clear_all()
    }
}

impl TerminalReplay {
    /// Program status is published only beside a running agent.
    pub(super) fn program_status_projection(
        &self,
        lifecycle: AgentRuntimeLifecycle,
    ) -> Option<Box<ProgramStatusProjection>> {
        (lifecycle == AgentRuntimeLifecycle::Running)
            .then(|| self.program_status.root())
            .flatten()
            .map(Box::new)
    }

    /// Republishes the agent projection after the program's own status
    /// changed. Only `program_status` and the ordering fields move. Nothing
    /// the Host knows has changed, so semantic idle age stays put and every
    /// revision-fenced decision (a settling turn completion, a working lease)
    /// moves to the new revision instead of being superseded by it.
    pub(super) fn republish_program_status(
        &mut self,
    ) -> Result<Option<AgentRuntimeStateProjection>, TerminalReplayError> {
        let Some(current) = &self.agent_runtime_state else {
            return Ok(None);
        };
        let program_status = self.program_status_projection(current.lifecycle);
        if current.program_status == program_status {
            return Ok(None);
        }
        let previous = current.revision;
        let revision = previous
            .checked_add(1)
            .ok_or(TerminalReplayError::StateRevisionExhausted)?;
        let projection = AgentRuntimeStateProjection {
            revision,
            observed_through_output_seq: self.output_seq,
            program_status,
            ..current.clone()
        };
        if let Some(deadline) = self
            .working_deadline
            .as_mut()
            .filter(|deadline| deadline.state_revision == previous)
        {
            deadline.state_revision = revision;
        }
        if let Some(pending) = self
            .pending_turn_completion
            .as_mut()
            .filter(|pending| pending.state_revision == Some(previous))
        {
            pending.state_revision = Some(revision);
        }
        self.agent_runtime_state = Some(projection.clone());
        Ok(Some(projection))
    }
}

/// The supporting terminal echoes the query body with the query's terminator.
fn probe_reply(terminator: OscTerminator) -> Vec<u8> {
    [b"\x1b]7501;?".as_slice(), terminator.bytes()].concat()
}

/// OSC 133 `A` (prompt start), with or without options.
fn is_prompt_start(command: &[u8]) -> bool {
    command == b"A" || command.starts_with(b"A;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_protocol::{ProgramStatusBlockedKind, ProgramStatusState};

    fn state(status: &ProgramStatus) -> Option<ProgramStatusState> {
        status.root().map(|root| root.state)
    }

    #[test]
    fn a_probe_is_answered_once_per_read_with_its_own_terminator() {
        let mut status = ProgramStatus::default();
        assert_eq!(
            status.ingest(b"\x1b]7501;?\x1b\\").probe_reply,
            b"\x1b]7501;?\x1b\\"
        );
        assert_eq!(
            status.ingest(b"\x1b]7501;?\x07").probe_reply,
            b"\x1b]7501;?\x07"
        );
        let repeated = status.ingest(&b"\x1b]7501;?\x07".repeat(50));
        assert_eq!(repeated.probe_reply, b"\x1b]7501;?\x07");
        assert!(!repeated.records_changed);
        assert!(status.ingest(b"plain output").probe_reply.is_empty());
    }

    #[test]
    fn reports_prompts_and_resets_apply_in_stream_order() {
        let mut status = ProgramStatus::default();
        let ingest = status.ingest(
            b"\x1b]7501;state=working:app=claude-code\x07\x1b]133;A;redraw=0\x07\x1b]7501;state=blocked:kind=permission\x1b\\",
        );
        assert!(ingest.records_changed);
        let root = status.root().unwrap();
        assert_eq!(root.state, ProgramStatusState::Blocked);
        assert_eq!(
            root.blocked_kind,
            Some(ProgramStatusBlockedKind::Permission)
        );

        assert!(status.ingest(b"\x1b]133;A\x07").records_changed);
        assert_eq!(state(&status), None, "a new prompt ends a blocked record");

        status.ingest(b"\x1b]7501;state=done\x07\x1b]133;A\x07");
        assert_eq!(state(&status), Some(ProgramStatusState::Done));
        assert!(
            !status
                .ingest(b"\x1b]133;B\x07\x1b]133;D;0\x07")
                .records_changed
        );

        assert!(status.ingest(b"\x1bc").records_changed);
        assert_eq!(state(&status), None, "RIS removes every record");
    }

    #[test]
    fn a_sequence_over_the_protocol_limit_is_discarded() {
        let mut status = ProgramStatus::default();
        let report = |terminator: &[u8], length: usize| {
            let mut sequence = b"\x1b]7501;state=idle:pad=".to_vec();
            sequence.resize(length - terminator.len(), b'x');
            sequence.extend_from_slice(terminator);
            sequence
        };
        for terminator in [b"\x07".as_slice(), b"\x1b\\"] {
            assert!(
                !status
                    .ingest(&report(terminator, MAX_SEQUENCE_BYTES + 1))
                    .records_changed
            );
            assert!(
                status
                    .ingest(&report(terminator, MAX_SEQUENCE_BYTES))
                    .records_changed
            );
            status.clear();
        }
    }

    #[test]
    fn clearing_reports_whether_anything_was_removed() {
        let mut status = ProgramStatus::default();
        assert!(!status.clear());
        status.ingest(b"\x1b]7501;state=error\x07");
        assert!(status.clear());
        assert_eq!(state(&status), None);
    }
}
