use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VersionRange {
    pub minimum: ProtocolVersion,
    pub maximum: ProtocolVersion,
}

impl VersionRange {
    #[must_use]
    pub fn contains(self, version: ProtocolVersion) -> bool {
        self.minimum <= version && version <= self.maximum
    }

    #[must_use]
    pub fn select_highest(self, peer: Self) -> Option<ProtocolVersion> {
        let minimum = self.minimum.max(peer.minimum);
        let maximum = self.maximum.min(peer.maximum);
        (minimum <= maximum).then_some(maximum)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionFence {
    pub workspace_id: String,
    pub session_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    #[serde(with = "super::json_u64")]
    pub channel_epoch: u64,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

impl SessionFence {
    /// Reports only the mismatching field so a refusal can remain useful
    /// without reflecting opaque adapter identifiers back to an untrusted peer.
    pub fn ensure_matches(&self, actual: &Self) -> Result<(), FenceMismatch> {
        let fields = [
            (
                FenceField::WorkspaceId,
                self.workspace_id == actual.workspace_id,
            ),
            (FenceField::SessionId, self.session_id == actual.session_id),
            (
                FenceField::RunnerPrincipal,
                self.runner_principal == actual.runner_principal,
            ),
            (
                FenceField::RunnerInstance,
                self.runner_instance == actual.runner_instance,
            ),
            (
                FenceField::ChannelEpoch,
                self.channel_epoch == actual.channel_epoch,
            ),
            (
                FenceField::HostInstanceId,
                self.host_instance_id == actual.host_instance_id,
            ),
            (
                FenceField::TerminalEpoch,
                self.terminal_epoch == actual.terminal_epoch,
            ),
        ];
        fields
            .into_iter()
            .find_map(|(field, matches)| (!matches).then_some(field))
            .map_or(Ok(()), |field| Err(FenceMismatch { field }))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FenceField {
    WorkspaceId,
    SessionId,
    RunnerPrincipal,
    RunnerInstance,
    ChannelEpoch,
    HostInstanceId,
    TerminalEpoch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FenceMismatch {
    pub field: FenceField,
}

impl fmt::Display for FenceMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "session fence mismatch at {:?}", self.field)
    }
}

impl std::error::Error for FenceMismatch {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReconnectCursor {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub after_output_seq: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProcessProof {
    pub process_id: u32,
    /// An OS-derived process start marker is required in addition to PID so a
    /// recycled PID cannot silently authenticate a stale discovery record.
    pub start_marker: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeContext {
    pub runtime_host: Option<String>,
    pub worktree_alias: Option<String>,
    pub branch: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fence() -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 7,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        }
    }

    #[test]
    fn complete_identity_fence_detects_terminal_replacement() {
        let expected = fence();
        let mut actual = expected.clone();
        actual.terminal_epoch = "terminal-2".into();

        assert_eq!(
            expected.ensure_matches(&actual),
            Err(FenceMismatch {
                field: FenceField::TerminalEpoch,
            })
        );
    }

    #[test]
    fn version_ranges_select_highest_mutual_version() {
        let host = VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 4 },
        };
        let client = VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 2 },
            maximum: ProtocolVersion { major: 1, minor: 3 },
        };

        assert_eq!(
            host.select_highest(client),
            Some(ProtocolVersion { major: 1, minor: 3 })
        );
    }
}
