use super::{ProviderEpoch, SessionHost, SessionHostError};
use crate::local_protocol::{ScreenSnapshot, ScreenSnapshotProfile, SessionFence};
use crate::provider_epoch::{CompletedProviderEpoch, ExitTombstone};
use crate::terminal_replay::{TerminalProjections, TerminalReplay};

enum InspectionTarget<'a> {
    Running(&'a TerminalReplay),
    Completed(&'a CompletedProviderEpoch),
}

impl SessionHost {
    // Presentation and metadata inspection resolve the same exact epoch. A
    // retained predecessor must never inherit the successor's semantic state.
    fn inspection_target(
        &self,
        fence: &SessionFence,
    ) -> Result<InspectionTarget<'_>, SessionHostError> {
        match &self.current {
            ProviderEpoch::Running { replay, .. } if replay.fence() == fence => {
                Ok(InspectionTarget::Running(replay))
            }
            ProviderEpoch::Exited(completed) if completed.tombstone.fence == *fence => {
                Ok(InspectionTarget::Completed(completed))
            }
            ProviderEpoch::Transitioning
            | ProviderEpoch::Running { .. }
            | ProviderEpoch::Exited(_) => self
                .retained
                .iter()
                .find(|completed| completed.tombstone.fence == *fence)
                .map(InspectionTarget::Completed)
                .ok_or(SessionHostError::FenceMismatch),
        }
    }

    pub fn inspect(
        &self,
        fence: &SessionFence,
    ) -> Result<(ScreenSnapshot, Option<ExitTombstone>), SessionHostError> {
        match self.inspection_target(fence)? {
            InspectionTarget::Running(replay) => {
                Ok((replay.snapshot(ScreenSnapshotProfile::Full)?, None))
            }
            InspectionTarget::Completed(completed) => Ok((
                completed.final_snapshot.clone(),
                Some(completed.tombstone.clone()),
            )),
        }
    }

    /// Borrows current or retained semantic facts without reconstructing a
    /// screen. The borrow keeps the epoch stable until the caller projects it.
    pub fn inspect_metadata(
        &self,
        fence: &SessionFence,
    ) -> Result<(TerminalProjections<'_>, Option<&ExitTombstone>), SessionHostError> {
        match self.inspection_target(fence)? {
            InspectionTarget::Running(replay) => Ok((replay.projections(), None)),
            InspectionTarget::Completed(completed) => Ok((
                TerminalProjections::from_snapshot(&completed.final_snapshot),
                Some(&completed.tombstone),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_protocol::{
        AgentProvider, AgentRuntimeStateSource, ProcessProof, ProviderConversationIdentitySource,
        WorkingDirectorySource,
    };
    use crate::provider_epoch::{ProviderExitKind, ProviderExitStatus};
    use crate::terminal_replay::{
        AgentIdentityObservation, AgentRuntimeObservation, ExecutionLocationObservation,
        ProviderConversationIdentityObservation, TerminalReplayLimits, WorkingDirectoryObservation,
    };

    fn fence(epoch: u64) -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "principal".into(),
            runner_instance: format!("runner-{epoch}"),
            channel_epoch: epoch,
            host_instance_id: "host".into(),
            terminal_epoch: format!("terminal-{epoch}"),
        }
    }

    fn process() -> ProcessProof {
        ProcessProof {
            process_id: 11,
            start_marker: "test-generation".into(),
        }
    }

    fn host() -> SessionHost {
        SessionHost::new(
            fence(1),
            process(),
            24,
            80,
            TerminalReplayLimits::default(),
            1,
        )
        .unwrap()
    }

    fn complete(host: &mut SessionHost, epoch: u64) {
        host.complete_provider(
            &fence(epoch),
            ProviderExitStatus {
                exit_code: Some(0),
                platform_status: None,
                kind: ProviderExitKind::Normal,
                reason: "fixture-completed".into(),
                created_unix_ms: 10,
                failure: None,
            },
        )
        .unwrap();
    }

    fn assert_matches_snapshot(host: &SessionHost, epoch: u64) {
        let (snapshot, expected_exit) = host.inspect(&fence(epoch)).unwrap();
        let (metadata, exit) = host.inspect_metadata(&fence(epoch)).unwrap();
        assert_eq!(metadata, TerminalProjections::from_snapshot(&snapshot));
        assert_eq!(exit, expected_exit.as_ref());
    }

    #[test]
    fn metadata_preserves_unknown_state_and_matches_full_snapshot_facts() {
        let mut host = host();
        let current = fence(1);
        let (unknown, exit) = host.inspect_metadata(&current).unwrap();
        assert!(unknown.working_directory.is_none());
        assert!(unknown.execution_location.is_none());
        assert!(unknown.agent_identity.is_none());
        assert!(unknown.agent_runtime_state.is_none());
        assert!(unknown.provider_conversation_identity.is_none());
        assert!(exit.is_none());
        assert_matches_snapshot(&host, 1);

        host.observe_working_directory(
            &current,
            WorkingDirectoryObservation::new("/fixture", WorkingDirectorySource::LaunchFallback),
        )
        .unwrap();
        host.observe_execution_location(&current, ExecutionLocationObservation::local())
            .unwrap();
        host.observe_agent_identity(
            &current,
            AgentIdentityObservation::process_inspection(Some(AgentProvider::Codex)),
        )
        .unwrap();
        host.observe_agent_runtime_state(
            &current,
            AgentRuntimeObservation::working(AgentRuntimeStateSource::ProviderEvent),
        )
        .unwrap();
        host.observe_provider_conversation_identity(
            &current,
            ProviderConversationIdentityObservation::new(
                "codex",
                "fixture-conversation",
                ProviderConversationIdentitySource::ProviderEvent,
            ),
        )
        .unwrap();
        host.ingest_output(&current, b"fixture output").unwrap();
        let (metadata, _) = host.inspect_metadata(&current).unwrap();
        assert!(metadata.working_directory.is_some());
        assert!(metadata.execution_location.is_some());
        assert!(metadata.agent_identity.is_some());
        assert!(metadata.agent_runtime_state.is_some());
        assert!(metadata.provider_conversation_identity.is_some());
        assert_matches_snapshot(&host, 1);
        complete(&mut host, 1);
        assert_matches_snapshot(&host, 1);
        assert!(host.inspect_metadata(&current).unwrap().1.is_some());

        host.begin_replacement(&current, fence(2), process())
            .unwrap();
        assert_matches_snapshot(&host, 1);
        assert_matches_snapshot(&host, 2);
        let (successor, exit) = host.inspect_metadata(&fence(2)).unwrap();
        assert!(successor.working_directory.is_none());
        assert!(successor.agent_runtime_state.is_none());
        assert!(successor.provider_conversation_identity.is_none());
        assert!(exit.is_none());

        complete(&mut host, 2);
        host.begin_replacement(&fence(2), fence(3), process())
            .unwrap();
        assert_matches_snapshot(&host, 2);
        assert_matches_snapshot(&host, 3);
        assert!(matches!(
            host.inspect_metadata(&current),
            Err(SessionHostError::FenceMismatch)
        ));
        assert!(matches!(
            host.inspect(&current),
            Err(SessionHostError::FenceMismatch)
        ));
    }

    #[test]
    fn metadata_and_presentation_reject_every_mismatched_identity_field() {
        let host = host();
        for field in 0..7 {
            let mut changed = fence(1);
            match field {
                0 => changed.workspace_id.push_str("-other"),
                1 => changed.session_id.push_str("-other"),
                2 => changed.runner_principal.push_str("-other"),
                3 => changed.runner_instance.push_str("-other"),
                4 => changed.channel_epoch += 1,
                5 => changed.host_instance_id.push_str("-other"),
                6 => changed.terminal_epoch.push_str("-other"),
                _ => unreachable!(),
            }
            assert!(matches!(
                host.inspect_metadata(&changed),
                Err(SessionHostError::FenceMismatch)
            ));
            assert!(matches!(
                host.inspect(&changed),
                Err(SessionHostError::FenceMismatch)
            ));
        }
    }
}
