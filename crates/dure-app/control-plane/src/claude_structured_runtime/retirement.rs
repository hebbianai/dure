use std::path::Path;

use dure_app::{
    AgentInteractionBindingV1, AgentRuntimeTransitionStore, AgentTimelineStore, DomainStore,
    ProviderCredentialProfileStore,
};

use super::journal::{
    ClaudeRuntimeLaunchJournalV1, ClaudeRuntimeLaunchStateV1, read_journal, write_journal,
};
use super::{
    ClaudeStructuredRecordedFailureV1, ClaudeStructuredRuntimeErrorV1,
    ClaudeStructuredRuntimeManager, PreparedClaudeRuntime, map_query_retirement_error,
    predecessor_binding, relay_generation_is_absent, runtime_directory_for_query,
    runtime_query_identity,
};
use crate::claude_conversation_host::{
    ClaudeConversationAttachEffectV1, ClaudeConversationHostErrorV1,
};
use crate::claude_sdk_host_client::{
    ClaudeDch1ProviderRetirementAuthority, ClaudeDch1ProviderRetirementPhase,
    ClaudeDch1QueryIdentity,
};

impl<S> ClaudeStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    pub(super) async fn record_host_attach_failure(
        &self,
        cwd: &Path,
        prepared: &mut PreparedClaudeRuntime,
        error: &ClaudeConversationHostErrorV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        match error.attach_effect() {
            ClaudeConversationAttachEffectV1::Unknown => {
                return Err(ClaudeStructuredRuntimeErrorV1::HostAttachUncertain);
            }
            ClaudeConversationAttachEffectV1::NoQuery => {}
            ClaudeConversationAttachEffectV1::QueryRetired(authority) => {
                if authority.source != prepared.journal.query_identity()
                    || authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
                {
                    return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
                }
                prepared
                    .journal
                    .set_retirement_authority(authority.as_ref().clone());
            }
        }
        self.publish_failure(
            prepared,
            ClaudeStructuredRecordedFailureV1::HostAttach {
                reason: error.reason().into(),
                detail: error.detail().map(str::to_owned),
            },
        )?;
        self.complete_failed_runtime_cleanup(cwd, prepared).await
    }

    pub(super) async fn release_failed_target_predecessor(
        &self,
        failed: &mut PreparedClaudeRuntime,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let Some(target_authority) = failed.journal.retirement_authority() else {
            // A pre-bind failure never acquired the target Query. Its source
            // authority remains Retired and is retargeted by the next repair.
            return Ok(());
        };
        if target_authority.source != failed.journal.query_identity()
            || target_authority.allowed_target.is_some()
            || target_authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.release_predecessor_authority(&failed.journal).await?;
        failed.journal.consume_provider_predecessor();
        write_journal(&failed.files.runtime_directory, &failed.journal)
    }

    pub(super) async fn failed_target_replacement_source(
        &self,
        failed_binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        failed: &mut PreparedClaudeRuntime,
    ) -> Result<Option<ClaudeDch1QueryIdentity>, ClaudeStructuredRuntimeErrorV1> {
        let failed_identity = failed.journal.query_identity();
        if !failed.journal.is_legacy_v4() {
            return Ok(if failed.journal.retirement_authority().is_some() {
                Some(failed_identity)
            } else {
                failed.journal.provider_predecessor().cloned()
            });
        }

        if failed.journal.provider_predecessor().is_some() {
            let Some((mut source, authority)) = self
                .ensure_replacement_authority(failed_binding, workspace_id, cwd, &failed.journal)
                .await?
            else {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            };
            if authority.allowed_target.as_ref() != Some(&failed_identity) {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            self.release_journal_authority(&source.files.runtime_directory, &mut source.journal)
                .await?;
        }
        failed.journal.consume_provider_predecessor();
        write_journal(&failed.files.runtime_directory, &failed.journal)?;
        Ok(None)
    }

    pub(super) async fn release_terminal_predecessor(
        &self,
        terminal: &ClaudeRuntimeLaunchJournalV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        self.release_predecessor_authority(terminal).await
    }

    pub(super) async fn release_terminal_authority(
        &self,
        runtime_directory: &Path,
        terminal: &mut ClaudeRuntimeLaunchJournalV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let Some(authority) = terminal.retirement_authority() else {
            return Ok(());
        };
        if authority.source != terminal.query_identity() {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.release_journal_authority(runtime_directory, terminal)
            .await
    }

    async fn release_predecessor_authority(
        &self,
        successor: &ClaudeRuntimeLaunchJournalV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let Some(source_identity) = successor.provider_predecessor() else {
            return Ok(());
        };
        let source_directory = runtime_directory_for_query(
            &self.configuration,
            successor.interaction_session_id(),
            source_identity,
        )?;
        let mut source = read_journal(&source_directory)?;
        if source.query_identity() != *source_identity
            || !matches!(
                source.state(),
                ClaudeRuntimeLaunchStateV1::Stopped | ClaudeRuntimeLaunchStateV1::Failed
            )
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        if source.retirement_authority().is_none() {
            if !source.has_legacy_successor_retirement_proof() {
                return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
            }
            let target_binding = self
                .conversation_service
                .binding(successor.interaction_session_id())
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
                .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
            if runtime_query_identity(&self.configuration, &target_binding)?
                != successor.query_identity()
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            let source_binding = predecessor_binding(&target_binding, source_identity)?;
            let authority = self
                .host
                .reconcile_proven_retirement(
                    &source_binding,
                    source_identity,
                    Some(&successor.query_identity()),
                )
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
            persist_authority(&source_directory, &mut source, &authority)?;
        }
        let authority = source
            .retirement_authority()
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        if authority.allowed_target.as_ref() != Some(&successor.query_identity()) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.release_journal_authority(&source_directory, &mut source)
            .await
    }

    pub(super) async fn replacement_authority_for_target(
        &self,
        target_binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        target: &ClaudeRuntimeLaunchJournalV1,
    ) -> Result<Option<ClaudeDch1ProviderRetirementAuthority>, ClaudeStructuredRuntimeErrorV1> {
        let Some((_, authority)) = self
            .ensure_replacement_authority(target_binding, workspace_id, cwd, target)
            .await?
        else {
            return Ok(None);
        };
        if authority.phase != ClaudeDch1ProviderRetirementPhase::Retired {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok(Some(authority))
    }

    pub(super) async fn finalize_replacement_authority(
        &self,
        target_binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        target: &mut PreparedClaudeRuntime,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let target_identity = target.journal.query_identity();
        let consumes_predecessor =
            target.journal.provider_predecessor().is_some() || target.journal.is_legacy_v4();
        let Some((mut source, mut authority)) = self
            .ensure_replacement_authority(target_binding, workspace_id, cwd, &target.journal)
            .await?
        else {
            if consumes_predecessor {
                target.journal.consume_provider_predecessor();
                write_journal(&target.files.runtime_directory, &target.journal)?;
            }
            return Ok(());
        };
        if authority.phase == ClaudeDch1ProviderRetirementPhase::Retired {
            authority = self
                .host
                .commit_replacement(&authority, &target_identity)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
            persist_authority(
                &source.files.runtime_directory,
                &mut source.journal,
                &authority,
            )?;
        }
        self.release_journal_authority(&source.files.runtime_directory, &mut source.journal)
            .await?;
        if consumes_predecessor {
            target.journal.consume_provider_predecessor();
            write_journal(&target.files.runtime_directory, &target.journal)?;
        }
        Ok(())
    }

    async fn ensure_replacement_authority(
        &self,
        target_binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        target: &ClaudeRuntimeLaunchJournalV1,
    ) -> Result<
        Option<(PreparedClaudeRuntime, ClaudeDch1ProviderRetirementAuthority)>,
        ClaudeStructuredRuntimeErrorV1,
    > {
        let Some(source_identity) = target.provider_predecessor() else {
            return Ok(None);
        };
        let target_identity = target.query_identity();
        let source_binding = predecessor_binding(target_binding, source_identity)?;
        let mut source = self
            .read_runtime(&source_binding, workspace_id, cwd)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if source.journal.query_identity() != *source_identity
            || !matches!(
                source.journal.state(),
                ClaudeRuntimeLaunchStateV1::Stopped | ClaudeRuntimeLaunchStateV1::Failed
            )
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let mut authority = match source.journal.retirement_authority().cloned() {
            Some(authority) => authority,
            None => {
                if !source.journal.has_legacy_successor_retirement_proof() {
                    return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
                }
                let authority = self
                    .host
                    .reconcile_proven_retirement(
                        &source_binding,
                        source_identity,
                        Some(&target_identity),
                    )
                    .await
                    .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
                persist_authority(
                    &source.files.runtime_directory,
                    &mut source.journal,
                    &authority,
                )?;
                authority
            }
        };
        if authority.allowed_target.as_ref() != Some(&target_identity) {
            if authority.phase != ClaudeDch1ProviderRetirementPhase::Retired {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            if let Some(previous_target) = authority.allowed_target.as_ref()
                && !self.previous_target_is_retargetable(
                    target_binding,
                    source_identity,
                    previous_target,
                )?
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            authority = self
                .host
                .retarget_retirement(&authority, &target_identity)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
            persist_authority(
                &source.files.runtime_directory,
                &mut source.journal,
                &authority,
            )?;
        }
        Ok(Some((source, authority)))
    }

    fn previous_target_is_retargetable(
        &self,
        target_binding: &AgentInteractionBindingV1,
        source_identity: &ClaudeDch1QueryIdentity,
        previous_target: &ClaudeDch1QueryIdentity,
    ) -> Result<bool, ClaudeStructuredRuntimeErrorV1> {
        let previous_directory = runtime_directory_for_query(
            &self.configuration,
            &target_binding.interaction_session_id,
            previous_target,
        )?;
        let previous = read_journal(&previous_directory)?;
        Ok(previous.state() == ClaudeRuntimeLaunchStateV1::Failed
            && previous.query_identity() == *previous_target
            && previous.provider_predecessor() == Some(source_identity)
            && previous.retirement_authority().is_none())
    }

    pub(super) async fn retire_query_before_stop(
        &self,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        runtime_directory: &Path,
        journal: &mut ClaudeRuntimeLaunchJournalV1,
        require_idle: bool,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        if journal.query_identity() != *identity {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        match journal.state() {
            ClaudeRuntimeLaunchStateV1::Attached => {
                let retired = if require_idle {
                    self.host
                        .retire_idle(binding, identity, allowed_target)
                        .await
                } else {
                    self.host.retire(binding, identity, allowed_target).await
                };
                let authority = match retired {
                    Ok(authority) => authority,
                    Err(error) => {
                        // A relay whose host and provider processes are both
                        // durably absent can never answer a retire, and a
                        // host restarted since the launch has no record to
                        // retire; the proven absence IS the retirement. A
                        // dead chat runtime once wedged a chat-to-terminal
                        // switch forever here (2026-08-31).
                        let descriptor = journal
                            .descriptor()
                            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
                        if !relay_generation_is_absent(descriptor)? {
                            return Err(map_query_retirement_error(error));
                        }
                        self.host
                            .reconcile_proven_retirement(binding, identity, allowed_target)
                            .await
                            .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?
                    }
                };
                journal.query_retired(authority);
                write_journal(runtime_directory, journal)?;
            }
            ClaudeRuntimeLaunchStateV1::QueryRetired => {
                if journal.retirement_authority().is_none() {
                    if !journal.has_legacy_retirement_proof() {
                        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
                    }
                    let authority = self
                        .host
                        .reconcile_proven_retirement(binding, identity, allowed_target)
                        .await
                        .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
                    journal.query_retired(authority);
                    write_journal(runtime_directory, journal)?;
                }
            }
            _ => return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
        }
        let authority = journal
            .retirement_authority()
            .cloned()
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        if authority.phase == ClaudeDch1ProviderRetirementPhase::Retired
            && authority.allowed_target.as_ref() != allowed_target
        {
            if authority.allowed_target.is_some() || allowed_target.is_none() {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            let authority = self
                .host
                .retarget_retirement(
                    &authority,
                    allowed_target.ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?,
                )
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
            persist_authority(runtime_directory, journal, &authority)?;
        }
        Ok(())
    }

    async fn release_journal_authority(
        &self,
        runtime_directory: &Path,
        journal: &mut ClaudeRuntimeLaunchJournalV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let mut authority = journal
            .retirement_authority()
            .cloned()
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        if authority.phase != ClaudeDch1ProviderRetirementPhase::Released {
            authority = self
                .host
                .release_retirement(&authority)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
            persist_authority(runtime_directory, journal, &authority)?;
        }
        if authority.phase != ClaudeDch1ProviderRetirementPhase::Released {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.host
            .confirm_retirement_release(&authority)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
        Ok(())
    }
}

fn persist_authority(
    runtime_directory: &Path,
    journal: &mut ClaudeRuntimeLaunchJournalV1,
    authority: &ClaudeDch1ProviderRetirementAuthority,
) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    journal.set_retirement_authority(authority.clone());
    write_journal(runtime_directory, journal)
}
