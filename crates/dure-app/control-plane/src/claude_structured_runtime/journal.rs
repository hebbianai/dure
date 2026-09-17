use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use dure_app::{AgentInteractionBindingV1, AgentInteractionSessionIdV1};
use hmux_client::{MANAGED_CREATE_RETIRED_EXACT_CODE, SessionDescriptor};
use serde::{Deserialize, Serialize};

use super::{
    ClaudeStructuredRecordedFailureV1, ClaudeStructuredRuntimeErrorV1, random_hex, safe_token,
};
use crate::claude_sdk_host_client::{
    ClaudeDch1ProviderRetirementAuthority, ClaudeDch1ProviderRetirementPhase,
    ClaudeDch1QueryIdentity,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClaudeManagedCreateIdentityV1 {
    source_session_id: String,
    source_idempotency_key: String,
    effective_session_id: String,
    effective_idempotency_key: String,
}

impl ClaudeManagedCreateIdentityV1 {
    pub(super) fn new(
        source_session_id: &str,
        source_idempotency_key: &str,
        effective_session_id: &str,
        effective_idempotency_key: &str,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        let identity = Self {
            source_session_id: source_session_id.into(),
            source_idempotency_key: source_idempotency_key.into(),
            effective_session_id: effective_session_id.into(),
            effective_idempotency_key: effective_idempotency_key.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    fn validate(&self) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let source_is_effective = self.source_session_id == self.effective_session_id
            && self.source_idempotency_key == self.effective_idempotency_key;
        let source_is_replaced = self.source_session_id != self.effective_session_id
            && self.source_idempotency_key != self.effective_idempotency_key;
        if !safe_token(&self.source_session_id)
            || !safe_token(&self.source_idempotency_key)
            || !safe_token(&self.effective_session_id)
            || !safe_token(&self.effective_idempotency_key)
            || !(source_is_effective || source_is_replaced)
        {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        Ok(())
    }

    pub(super) fn effective_session_id(&self) -> &str {
        &self.effective_session_id
    }

    pub(super) fn effective_idempotency_key(&self) -> &str {
        &self.effective_idempotency_key
    }

    fn matches_source(&self, session_id: &str, idempotency_key: &str) -> bool {
        self.source_session_id == session_id && self.source_idempotency_key == idempotency_key
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ClaudeRuntimeLaunchStateV1 {
    Prepared,
    RelayReady,
    Attached,
    QueryRetired,
    StopCleanupPending,
    FailureCleanupPending,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClaudeRuntimeLaunchJournalV1 {
    schema_version: u16,
    interaction_session_id: AgentInteractionSessionIdV1,
    binding_revision: i64,
    runtime_generation: String,
    query_epoch: String,
    relay_id: String,
    relay_session_id: String,
    relay_workspace_id: String,
    cwd: PathBuf,
    state: ClaudeRuntimeLaunchStateV1,
    descriptor: Option<SessionDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_create_identity: Option<ClaudeManagedCreateIdentityV1>,
    host_process_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<ClaudeStructuredRecordedFailureV1>,
    #[serde(default, rename = "failureCode", skip_serializing)]
    legacy_failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replaces: Option<ClaudeDch1QueryIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_retirement_authority: Option<ClaudeDch1ProviderRetirementAuthority>,
    #[serde(
        default,
        rename = "providerReplacementFence",
        skip_serializing_if = "is_false"
    )]
    legacy_provider_replacement_fence: bool,
    #[serde(
        default,
        rename = "retainRetirementFence",
        skip_serializing_if = "is_false"
    )]
    legacy_retain_retirement_fence: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ClaudeRuntimeLaunchJournalV1 {
    pub(super) fn prepared(
        binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        relay_id: &str,
        relay_session_id: &str,
        replaces: Option<ClaudeDch1QueryIdentity>,
    ) -> Self {
        Self {
            schema_version: 6,
            interaction_session_id: binding.interaction_session_id.clone(),
            binding_revision: binding.binding_revision,
            runtime_generation: binding.runtime.runtime_generation.clone(),
            query_epoch: binding.runtime.provider_epoch.clone(),
            relay_id: relay_id.into(),
            relay_session_id: relay_session_id.into(),
            relay_workspace_id: workspace_id.into(),
            cwd: cwd.to_path_buf(),
            state: ClaudeRuntimeLaunchStateV1::Prepared,
            descriptor: None,
            managed_create_identity: None,
            host_process_id: None,
            failure: None,
            legacy_failure_code: None,
            replaces,
            provider_retirement_authority: None,
            legacy_provider_replacement_fence: false,
            legacy_retain_retirement_fence: false,
        }
    }

    pub(super) fn state(&self) -> ClaudeRuntimeLaunchStateV1 {
        self.state
    }

    pub(super) fn interaction_session_id(&self) -> &AgentInteractionSessionIdV1 {
        &self.interaction_session_id
    }

    pub(super) fn descriptor(&self) -> Option<&SessionDescriptor> {
        self.descriptor.as_ref()
    }

    pub(super) fn effective_managed_create_identity<'a>(
        &'a self,
        source_session_id: &'a str,
        source_idempotency_key: &'a str,
    ) -> (&'a str, &'a str) {
        self.managed_create_identity.as_ref().map_or(
            (source_session_id, source_idempotency_key),
            |identity| {
                (
                    identity.effective_session_id(),
                    identity.effective_idempotency_key(),
                )
            },
        )
    }

    pub(super) fn failure(&self) -> Option<&ClaudeStructuredRecordedFailureV1> {
        self.failure.as_ref()
    }

    pub(super) fn query_identity(&self) -> ClaudeDch1QueryIdentity {
        ClaudeDch1QueryIdentity {
            runtime_generation: self.runtime_generation.clone(),
            query_epoch: self.query_epoch.clone(),
            relay_id: self.relay_id.clone(),
        }
    }

    #[cfg(test)]
    pub(super) fn replaces(&self) -> Option<&ClaudeDch1QueryIdentity> {
        self.replaces.as_ref()
    }

    pub(super) fn retirement_authority(&self) -> Option<&ClaudeDch1ProviderRetirementAuthority> {
        self.provider_retirement_authority.as_ref()
    }

    /// The provider predecessor is not the same fact as journal ancestry in
    /// schema v4. Only the old explicit fence authorizes authority migration.
    pub(super) fn provider_predecessor(&self) -> Option<&ClaudeDch1QueryIdentity> {
        match self.schema_version {
            4 if self.legacy_provider_replacement_fence => self.replaces.as_ref(),
            5..=7 => self.replaces.as_ref(),
            _ => None,
        }
    }

    /// Selects the provider predecessor for a target that has not been
    /// published. A provider-committed authority without its exact target
    /// journal is a conflict, never permission to create a second Query.
    pub(super) fn provider_predecessor_for_new_target(
        &self,
    ) -> Result<Option<ClaudeDch1QueryIdentity>, ClaudeStructuredRuntimeErrorV1> {
        if self.schema_version == 4 {
            return Ok(self
                .has_legacy_successor_retirement_proof()
                .then(|| self.query_identity()));
        }
        match self.provider_retirement_authority.as_ref() {
            None => Ok(None),
            Some(authority)
                if authority.phase == ClaudeDch1ProviderRetirementPhase::Retired
                    && authority.allowed_target.is_some() =>
            {
                Ok(Some(self.query_identity()))
            }
            Some(authority)
                if authority.allowed_target.is_none()
                    && matches!(
                        authority.phase,
                        ClaudeDch1ProviderRetirementPhase::Retired
                            | ClaudeDch1ProviderRetirementPhase::Released
                    ) =>
            {
                Ok(None)
            }
            Some(_) => Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
        }
    }

    /// Checks lineage on an already-published exact target. Released is the
    /// only phase that admits either side of the final target-journal consume
    /// cut; earlier phases still require the predecessor to be present.
    pub(super) fn accepts_existing_target_predecessor(
        &self,
        target: &ClaudeDch1QueryIdentity,
        predecessor: Option<&ClaudeDch1QueryIdentity>,
    ) -> bool {
        let source = self.query_identity();
        if self.schema_version == 4 {
            return predecessor
                == self
                    .has_legacy_successor_retirement_proof()
                    .then_some(&source);
        }
        match self.provider_retirement_authority.as_ref() {
            None => predecessor.is_none(),
            Some(authority) if authority.allowed_target.is_none() => predecessor.is_none(),
            Some(authority) if authority.phase == ClaudeDch1ProviderRetirementPhase::Retired => {
                predecessor == Some(&source)
            }
            Some(authority)
                if authority.allowed_target.as_ref() == Some(target)
                    && authority.phase == ClaudeDch1ProviderRetirementPhase::TargetBound =>
            {
                predecessor == Some(&source)
            }
            Some(authority)
                if authority.allowed_target.as_ref() == Some(target)
                    && authority.phase == ClaudeDch1ProviderRetirementPhase::Released =>
            {
                predecessor.is_none() || predecessor == Some(&source)
            }
            Some(_) => false,
        }
    }

    pub(super) fn has_legacy_retirement_proof(&self) -> bool {
        self.schema_version == 4
            && (self.state == ClaudeRuntimeLaunchStateV1::QueryRetired
                || self.state == ClaudeRuntimeLaunchStateV1::Stopped
                    && self.legacy_retain_retirement_fence)
    }

    pub(super) fn has_legacy_successor_retirement_proof(&self) -> bool {
        self.schema_version == 4
            && self.legacy_retain_retirement_fence
            && matches!(
                self.state,
                ClaudeRuntimeLaunchStateV1::QueryRetired | ClaudeRuntimeLaunchStateV1::Stopped
            )
    }

    pub(super) fn is_legacy_v4(&self) -> bool {
        self.schema_version == 4
    }

    pub(super) fn consume_provider_predecessor(&mut self) {
        self.replaces = None;
        self.promote_retirement_schema();
    }

    fn promote_retirement_schema(&mut self) {
        if self.schema_version < 5 && !self.legacy_provider_replacement_fence {
            self.replaces = None;
        }
        self.schema_version = self.schema_version.max(5);
        self.legacy_provider_replacement_fence = false;
        self.legacy_retain_retirement_fence = false;
    }

    pub(super) fn matches(
        &self,
        binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        relay_id: &str,
        relay_session_id: &str,
        create_idempotency_key: &str,
    ) -> bool {
        let effective_session_id = self.managed_create_identity.as_ref().map_or(
            relay_session_id,
            ClaudeManagedCreateIdentityV1::effective_session_id,
        );
        let managed_identity_matches =
            match (self.schema_version, self.managed_create_identity.as_ref()) {
                (1..=6, None) => true,
                (7, Some(identity)) => {
                    identity.validate().is_ok()
                        && identity.matches_source(relay_session_id, create_idempotency_key)
                }
                _ => false,
            };
        matches!(self.schema_version, 1..=7)
            && self.interaction_session_id == binding.interaction_session_id
            && self.binding_revision > 0
            && self.binding_revision <= binding.binding_revision
            && self.runtime_generation == binding.runtime.runtime_generation
            && self.query_epoch == binding.runtime.provider_epoch
            && self.relay_id == relay_id
            && self.relay_session_id == relay_session_id
            && managed_identity_matches
            && self.relay_workspace_id == workspace_id
            && self.cwd == cwd
            && self.descriptor.as_ref().is_none_or(|descriptor| {
                descriptor.session_id == effective_session_id
                    && descriptor.workspace_id == self.relay_workspace_id
            })
    }

    #[cfg(test)]
    pub(super) fn relay_ready(&mut self, descriptor: SessionDescriptor) {
        self.state = ClaudeRuntimeLaunchStateV1::RelayReady;
        self.descriptor = Some(descriptor);
        self.failure = None;
    }

    pub(super) fn relay_ready_with_managed_identity(
        &mut self,
        descriptor: SessionDescriptor,
        identity: ClaudeManagedCreateIdentityV1,
    ) {
        self.schema_version = 7;
        self.state = ClaudeRuntimeLaunchStateV1::RelayReady;
        self.descriptor = Some(descriptor);
        self.managed_create_identity = Some(identity);
        self.failure = None;
    }

    pub(super) fn attached(&mut self, host_process_id: u32) {
        self.state = ClaudeRuntimeLaunchStateV1::Attached;
        self.host_process_id = Some(host_process_id);
        self.failure = None;
    }

    pub(super) fn query_retired(&mut self, authority: ClaudeDch1ProviderRetirementAuthority) {
        self.promote_retirement_schema();
        self.state = ClaudeRuntimeLaunchStateV1::QueryRetired;
        self.provider_retirement_authority = Some(authority);
        self.failure = None;
    }

    pub(super) fn set_retirement_authority(
        &mut self,
        authority: ClaudeDch1ProviderRetirementAuthority,
    ) {
        self.promote_retirement_schema();
        self.provider_retirement_authority = Some(authority);
    }

    pub(super) fn failure_cleanup_pending(&mut self, failure: ClaudeStructuredRecordedFailureV1) {
        self.state = ClaudeRuntimeLaunchStateV1::FailureCleanupPending;
        self.failure = Some(failure);
    }

    #[cfg(test)]
    pub(super) fn normalization_cleanup_pending(&mut self, descriptor: SessionDescriptor) {
        self.schema_version = self.schema_version.max(6);
        self.state = ClaudeRuntimeLaunchStateV1::FailureCleanupPending;
        self.descriptor = Some(descriptor);
        self.failure = Some(ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired);
    }

    pub(super) fn stop_cleanup_pending(&mut self, descriptor: Option<SessionDescriptor>) {
        self.schema_version = self.schema_version.max(6);
        self.state = ClaudeRuntimeLaunchStateV1::StopCleanupPending;
        self.descriptor = descriptor;
        self.failure = None;
    }

    pub(super) fn stop_cleanup_pending_with_managed_identity(
        &mut self,
        descriptor: SessionDescriptor,
        identity: ClaudeManagedCreateIdentityV1,
    ) {
        self.schema_version = 7;
        self.state = ClaudeRuntimeLaunchStateV1::StopCleanupPending;
        self.descriptor = Some(descriptor);
        self.managed_create_identity = Some(identity);
        self.failure = None;
    }

    pub(super) fn failure_cleanup_completed(&mut self) {
        self.state = ClaudeRuntimeLaunchStateV1::Failed;
    }

    pub(super) fn stopped(&mut self) {
        self.state = ClaudeRuntimeLaunchStateV1::Stopped;
    }
}

pub(super) fn write_journal(
    runtime_directory: &Path,
    journal: &ClaudeRuntimeLaunchJournalV1,
) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    journal.validate_failure_state()?;
    let target = runtime_directory.join("launch.json");
    let temporary = runtime_directory.join(format!(".launch.{}.tmp", random_hex::<12>()?));
    let source =
        serde_json::to_vec(journal).map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&source)?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
    }
    if fs::rename(&temporary, &target).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
    }
    File::open(runtime_directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)
}

pub(super) fn read_journal(
    runtime_directory: &Path,
) -> Result<ClaudeRuntimeLaunchJournalV1, ClaudeStructuredRuntimeErrorV1> {
    let target = runtime_directory.join("launch.json");
    let metadata =
        fs::symlink_metadata(&target).map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > 256 * 1024
    {
        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
    }
    let mut journal: ClaudeRuntimeLaunchJournalV1 = serde_json::from_slice(
        &fs::read(target).map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
    )
    .map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
    journal.normalize_legacy_failure()?;
    journal.normalize_legacy_retirement()?;
    journal.validate_failure_state()?;
    Ok(journal)
}

impl ClaudeRuntimeLaunchJournalV1 {
    fn normalize_legacy_retirement(&mut self) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        if self.schema_version > 7
            || self.schema_version >= 5
                && (self.legacy_provider_replacement_fence || self.legacy_retain_retirement_fence)
        {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        Ok(())
    }

    fn normalize_legacy_failure(&mut self) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let legacy_schema = matches!(self.schema_version, 1 | 2);
        if !legacy_schema && self.legacy_failure_code.is_some() {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        if let Some(code) = self.legacy_failure_code.take() {
            if self.failure.is_some() {
                return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
            }
            self.failure = Some(match code.as_str() {
                MANAGED_CREATE_RETIRED_EXACT_CODE => {
                    ClaudeStructuredRecordedFailureV1::ManagedCreateRetiredExact
                }
                "relay_readiness_failed" => ClaudeStructuredRecordedFailureV1::RelayReadiness,
                "host_attach_failed" => ClaudeStructuredRecordedFailureV1::HostAttach {
                    reason: code,
                    // A legacy code carries no evidence — only a live attach
                    // failure records the host's own words.
                    detail: None,
                },
                _ => return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed),
            });
        }
        if legacy_schema {
            if self.state == ClaudeRuntimeLaunchStateV1::Failed {
                self.state = ClaudeRuntimeLaunchStateV1::FailureCleanupPending;
            }
            self.schema_version = 3;
        }
        Ok(())
    }

    fn validate_failure_state(&self) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let managed_identity_is_valid =
            match (self.schema_version, self.managed_create_identity.as_ref()) {
                (1..=6, None) => true,
                (7, Some(identity)) => identity.validate().is_ok(),
                _ => false,
            };
        if !managed_identity_is_valid
            || self.legacy_failure_code.is_some()
            || self.schema_version < 4 && self.state == ClaudeRuntimeLaunchStateV1::QueryRetired
            || self.schema_version < 5 && self.provider_retirement_authority.is_some()
            || self.schema_version < 6
                && (self.state == ClaudeRuntimeLaunchStateV1::StopCleanupPending
                    || matches!(
                        self.failure.as_ref(),
                        Some(ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired)
                    ))
            || self.schema_version < 4
                && (self.legacy_provider_replacement_fence || self.legacy_retain_retirement_fence)
            || self.schema_version == 4
                && self.legacy_provider_replacement_fence
                && self.replaces.is_none()
            || self.schema_version == 4
                && self.legacy_retain_retirement_fence
                && !matches!(
                    self.state,
                    ClaudeRuntimeLaunchStateV1::QueryRetired | ClaudeRuntimeLaunchStateV1::Stopped
                )
            || self
                .provider_retirement_authority
                .as_ref()
                .is_some_and(|authority| {
                    authority.validate().is_err()
                        || authority.source != self.query_identity()
                        || !matches!(
                            self.state,
                            ClaudeRuntimeLaunchStateV1::QueryRetired
                                | ClaudeRuntimeLaunchStateV1::StopCleanupPending
                                | ClaudeRuntimeLaunchStateV1::FailureCleanupPending
                                | ClaudeRuntimeLaunchStateV1::Failed
                                | ClaudeRuntimeLaunchStateV1::Stopped
                        )
                })
            || self.failure.as_ref().is_some_and(|failure| {
                matches!(
                    failure,
                    // The detail is free-form evidence by design; only the
                    // machine-matched reason is token-checked.
                    ClaudeStructuredRecordedFailureV1::HostAttach { reason, .. }
                        if !safe_token(reason)
                )
            })
            || (matches!(
                self.failure.as_ref(),
                Some(ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired)
            ) && self.descriptor.is_none())
            || self.state == ClaudeRuntimeLaunchStateV1::StopCleanupPending
                && self.failure.is_some()
            || match self.state {
                ClaudeRuntimeLaunchStateV1::FailureCleanupPending
                | ClaudeRuntimeLaunchStateV1::Failed => self.failure.is_none(),
                ClaudeRuntimeLaunchStateV1::StopCleanupPending => false,
                ClaudeRuntimeLaunchStateV1::Stopped => false,
                ClaudeRuntimeLaunchStateV1::Prepared
                | ClaudeRuntimeLaunchStateV1::RelayReady
                | ClaudeRuntimeLaunchStateV1::Attached
                | ClaudeRuntimeLaunchStateV1::QueryRetired => self.failure.is_some(),
            }
            || self.schema_version >= 5
                && self.state == ClaudeRuntimeLaunchStateV1::QueryRetired
                && self.provider_retirement_authority.is_none()
        {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
