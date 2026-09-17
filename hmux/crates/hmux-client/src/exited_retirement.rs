use crate::catalog::ExactExitedRetirement;
#[cfg(unix)]
use crate::legacy_terminate::provider_process_session_is_stably_empty;
use crate::recovery_journal::{self, PendingRecoverySource, managed_create_ledger};
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, ProcessDescriptor, SessionClass,
    SessionDescriptor, SessionLifecycle, SessionSelector,
};
#[cfg(any(unix, windows))]
use crate::{
    LocalProcessGenerationStatus, SessionProbeStatus, probe_local_process_generation,
    probe_local_session_exact,
};
use hmux_host::local_discovery::{DiscoveryError, DiscoveryKey, MAX_DISCOVERY_ID_BYTES};
use hmux_runtime_contract::{ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest};
use hmux_session_protocol::SessionFence;
use serde::{Deserialize, Serialize};
use std::fmt;

mod recovery_roots;
#[cfg(any(unix, windows))]
mod standalone_stop;

/// One command invocation stays bounded even when the discovery root contains
/// substantially more debris. Exact targets are resolved directly by their
/// hashed workspace/session path, so unrelated entries do not consume this
/// budget or blind the lookup.
pub const MAX_EXITED_SESSION_RETIREMENT_TARGETS: usize = 128;
const MAX_RETIREMENT_IDENTIFIER_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitedSessionRetirementMode {
    Preview,
    Apply,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitedSessionRetirementTarget {
    pub workspace_id: String,
    pub session_id: String,
    /// Advisory identity observed by a legacy preview caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_epoch: Option<String>,
    /// Complete authority returned by preview and required by apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<ExitedSessionRetirementGeneration>,
}

impl ExitedSessionRetirementTarget {
    #[must_use]
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        terminal_epoch: Option<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            terminal_epoch,
            generation: None,
        }
    }

    #[must_use]
    pub fn with_generation(mut self, generation: ExitedSessionRetirementGeneration) -> Self {
        if self.terminal_epoch.is_none() {
            self.terminal_epoch = Some(generation.fence.terminal_epoch.clone());
        }
        self.generation = Some(generation);
        self
    }

    fn selector(&self) -> SessionSelector {
        SessionSelector::new(self.session_id.clone(), Some(self.workspace_id.clone()))
    }

    fn pending_source(&self) -> PendingRecoverySource {
        PendingRecoverySource {
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ExitedSessionRetirementGeneration {
    pub fence: ExitedSessionRetirementFence,
    pub host_process: ExitedSessionRetirementProcessProof,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ExitedSessionRetirementFence {
    pub workspace_id: String,
    pub session_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ExitedSessionRetirementProcessProof {
    pub process_id: u32,
    pub start_marker: String,
}

impl ExitedSessionRetirementGeneration {
    pub fn from_descriptor(descriptor: &SessionDescriptor) -> Result<Self, ClientError> {
        descriptor.channel_epoch.parse::<u64>().map_err(|_| {
            ClientError::transport(
                "hmux_manifest_identity_invalid",
                "Hmux descriptor has an invalid channel epoch",
            )
        })?;
        Ok(Self {
            fence: ExitedSessionRetirementFence {
                workspace_id: descriptor.workspace_id.clone(),
                session_id: descriptor.session_id.clone(),
                runner_principal: descriptor.runner_principal.clone(),
                runner_instance: descriptor.runner_instance.clone(),
                channel_epoch: descriptor.channel_epoch.clone(),
                host_instance_id: descriptor.host_instance_id.clone(),
                terminal_epoch: descriptor.terminal_epoch.clone(),
            },
            host_process: ExitedSessionRetirementProcessProof {
                process_id: descriptor.host_process.process_id,
                start_marker: descriptor.host_process.start_marker.clone(),
            },
        })
    }

    fn names_target_identity(&self, target: &ExitedSessionRetirementTarget) -> bool {
        self.fence.workspace_id == target.workspace_id && self.fence.session_id == target.session_id
    }

    fn matches_descriptor(&self, descriptor: &SessionDescriptor) -> bool {
        self.fence.workspace_id == descriptor.workspace_id
            && self.fence.session_id == descriptor.session_id
            && self.fence.runner_principal == descriptor.runner_principal
            && self.fence.runner_instance == descriptor.runner_instance
            && self.fence.channel_epoch == descriptor.channel_epoch
            && self.fence.host_instance_id == descriptor.host_instance_id
            && self.fence.terminal_epoch == descriptor.terminal_epoch
            && self.host_process.process_id == descriptor.host_process.process_id
            && self.host_process.start_marker == descriptor.host_process.start_marker
    }

    fn session_fence(&self) -> Result<SessionFence, ()> {
        Ok(SessionFence {
            workspace_id: self.fence.workspace_id.clone(),
            session_id: self.fence.session_id.clone(),
            runner_principal: self.fence.runner_principal.clone(),
            runner_instance: self.fence.runner_instance.clone(),
            channel_epoch: self.fence.channel_epoch.parse().map_err(|_| ())?,
            host_instance_id: self.fence.host_instance_id.clone(),
            terminal_epoch: self.fence.terminal_epoch.clone(),
        })
    }

    fn host_process(&self) -> ProcessDescriptor {
        ProcessDescriptor {
            process_id: self.host_process.process_id,
            start_marker: self.host_process.start_marker.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitedSessionRetirementOutcome {
    Retirable,
    Retired,
    AlreadyRetired,
    Skipped,
}

/// Conservative lifecycle result for one completed standalone target.
///
/// `Retired` is returned only after both exact process generations are absent
/// and a fenced cleanup or exited-retirement resolution completes. Missing
/// discovery state by itself is unresolved.
#[cfg(any(unix, windows))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletedStandaloneTargetLifecycle {
    Active,
    Retired,
    Unresolved,
}

#[cfg(any(unix, windows))]
fn completed_standalone_descriptor_matches(
    descriptor: &SessionDescriptor,
    generation: &ExitedSessionRetirementGeneration,
    provider_process: &ProcessDescriptor,
) -> bool {
    descriptor.session_class == SessionClass::Standalone
        && descriptor.provider_process == *provider_process
        && generation.matches_descriptor(descriptor)
}

#[cfg(windows)]
fn provider_process_session_is_stably_empty(
    _provider: &ProcessDescriptor,
) -> Result<bool, ClientError> {
    // Windows has no POSIX session census. Its completed target therefore
    // requires cleanup-complete archive evidence.
    Ok(false)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitedSessionRetirementReason {
    NotFound,
    NotExited,
    NotStale,
    RecoveryPending,
    EpochChanged,
    GenerationChanged,
    GenerationRequired,
    LifetimeBusy,
    JournalUnavailable,
    ArchiveCapacity,
    InvalidTarget,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitedSessionRetirementReceipt {
    pub workspace_id: String,
    pub session_id: String,
    pub outcome: ExitedSessionRetirementOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<ExitedSessionRetirementGeneration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ExitedSessionRetirementReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ExitedSessionRetirementReceipt {
    fn for_target(
        target: &ExitedSessionRetirementTarget,
        outcome: ExitedSessionRetirementOutcome,
        reason: Option<ExitedSessionRetirementReason>,
        message: Option<String>,
        generation: Option<ExitedSessionRetirementGeneration>,
    ) -> Self {
        Self {
            workspace_id: bounded_value(&target.workspace_id, MAX_DISCOVERY_ID_BYTES),
            session_id: bounded_value(&target.session_id, MAX_DISCOVERY_ID_BYTES),
            outcome,
            generation,
            reason,
            message,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitedSessionRetirementReport {
    pub schema_version: u16,
    pub operation: &'static str,
    pub mode: ExitedSessionRetirementMode,
    pub limit: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<ExitedSessionRetirementCursor>,
    pub evaluated: usize,
    pub retirable: usize,
    pub retired: usize,
    pub already_retired: usize,
    pub skipped: usize,
    pub results: Vec<ExitedSessionRetirementReceipt>,
}

impl ExitedSessionRetirementReport {
    fn new(operation: &'static str, mode: ExitedSessionRetirementMode, capacity: usize) -> Self {
        Self {
            schema_version: 1,
            operation,
            mode,
            limit: MAX_EXITED_SESSION_RETIREMENT_TARGETS,
            has_more: false,
            next_cursor: None,
            evaluated: 0,
            retirable: 0,
            retired: 0,
            already_retired: 0,
            skipped: 0,
            results: Vec::with_capacity(capacity),
        }
    }

    fn push(&mut self, receipt: ExitedSessionRetirementReceipt) {
        self.evaluated += 1;
        match receipt.outcome {
            ExitedSessionRetirementOutcome::Retirable => self.retirable += 1,
            ExitedSessionRetirementOutcome::Retired => self.retired += 1,
            ExitedSessionRetirementOutcome::AlreadyRetired => self.already_retired += 1,
            ExitedSessionRetirementOutcome::Skipped => self.skipped += 1,
        }
        self.results.push(receipt);
    }
}

#[derive(Debug)]
pub enum ExitedSessionRetirementError {
    TooManyTargets { actual: usize, maximum: usize },
}

impl fmt::Display for ExitedSessionRetirementError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyTargets { actual, maximum } => write!(
                formatter,
                "exited-session retirement request has {actual} targets; maximum is {maximum}"
            ),
        }
    }
}

impl std::error::Error for ExitedSessionRetirementError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitedSessionRetirementCandidates {
    pub targets: Vec<ExitedSessionRetirementTarget>,
    pub has_more: bool,
    pub next_cursor: Option<ExitedSessionRetirementCursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitedSessionRetirementCursor {
    pub schema_version: u16,
    pub workspace_id: String,
    pub session_id: String,
    pub runner_instance: String,
    pub channel_epoch: String,
}

impl ExitedSessionRetirementCursor {
    fn from_key(key: &DiscoveryKey) -> Self {
        Self {
            schema_version: 1,
            workspace_id: key.workspace_id().to_string(),
            session_id: key.session_id().to_string(),
            runner_instance: key.runner_instance().to_string(),
            channel_epoch: key.channel_epoch().to_string(),
        }
    }

    fn discovery_key(&self) -> Result<DiscoveryKey, ClientError> {
        if self.schema_version != 1 {
            return Err(ClientError::transport(
                "hmux_exited_retirement_cursor_invalid",
                "Hmux exited-retirement cursor has an unsupported schema",
            ));
        }
        let channel_epoch = self.channel_epoch.parse::<u64>().map_err(|_| {
            ClientError::transport(
                "hmux_exited_retirement_cursor_invalid",
                "Hmux exited-retirement cursor has an invalid channel epoch",
            )
        })?;
        DiscoveryKey::new(
            &self.workspace_id,
            &self.session_id,
            &self.runner_instance,
            channel_epoch,
        )
        .map_err(|error| ClientError::Discovery(DiscoveryError::InvalidDiscoveryKey(error)))
    }
}

impl LocalSessionCatalog {
    /// Open only the exact completed standalone generation named by one saved
    /// operation checkpoint. Callers may use the returned session for an
    /// explicit destructive action without reinterpreting generation fields.
    #[cfg(any(unix, windows))]
    pub fn open_completed_standalone_target(
        &self,
        generation: &ExitedSessionRetirementGeneration,
        provider_process: &ProcessDescriptor,
    ) -> Result<LocalSession, ClientError> {
        let selector = SessionSelector::new(
            generation.fence.session_id.clone(),
            Some(generation.fence.workspace_id.clone()),
        );
        let session = self.open(&selector)?;
        if !completed_standalone_descriptor_matches(
            session.descriptor(),
            generation,
            provider_process,
        ) {
            return Err(ClientError::transport(
                "hmux_standalone_target_generation_changed",
                "saved standalone target no longer names the current exact generation",
            ));
        }
        Ok(session)
    }

    /// Resolve one completed standalone target without treating discovery
    /// absence as proof that its exact generation retired.
    ///
    /// The supplied generation and provider process must come from the same
    /// completed standalone descriptor. A fresh exact Ready handshake proves
    /// the target active. Every cleanup path first proves both recorded process
    /// generations absent, then delegates to the existing generation-fenced
    /// cleanup or exited-retirement transaction.
    #[cfg(any(unix, windows))]
    pub fn resolve_completed_standalone_target(
        &self,
        generation: &ExitedSessionRetirementGeneration,
        provider_process: &ProcessDescriptor,
    ) -> CompletedStandaloneTargetLifecycle {
        self.resolve_completed_standalone_target_with_probes(
            generation,
            provider_process,
            |descriptor| probe_local_session_exact(self, descriptor),
            probe_local_process_generation,
            provider_process_session_is_stably_empty,
        )
        .unwrap_or(CompletedStandaloneTargetLifecycle::Unresolved)
    }

    #[cfg(any(unix, windows))]
    fn resolve_completed_standalone_target_with_probes<
        SessionProbe,
        ProcessProbe,
        ProcessSessionProbe,
    >(
        &self,
        generation: &ExitedSessionRetirementGeneration,
        provider_process: &ProcessDescriptor,
        session_probe: SessionProbe,
        mut process_probe: ProcessProbe,
        process_session_probe: ProcessSessionProbe,
    ) -> Result<CompletedStandaloneTargetLifecycle, ExitedSessionRetirementError>
    where
        SessionProbe: FnOnce(&SessionDescriptor) -> SessionProbeStatus,
        ProcessProbe:
            FnMut(&ProcessDescriptor) -> Result<LocalProcessGenerationStatus, ClientError>,
        ProcessSessionProbe: FnOnce(&ProcessDescriptor) -> Result<bool, ClientError>,
    {
        enum RequiredMutation {
            ResolveAbsent,
            RetireExited,
            CleanupStale,
        }

        let Ok(expected_fence) = generation.session_fence() else {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        };
        let selector = SessionSelector::new(
            generation.fence.session_id.clone(),
            Some(generation.fence.workspace_id.clone()),
        );
        let required_mutation = match self.open(&selector) {
            Ok(session) => {
                let descriptor = session.descriptor();
                if !completed_standalone_descriptor_matches(
                    descriptor,
                    generation,
                    provider_process,
                ) {
                    return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
                }
                match descriptor.lifecycle {
                    SessionLifecycle::Exited => RequiredMutation::RetireExited,
                    SessionLifecycle::Ready => match session_probe(descriptor) {
                        SessionProbeStatus::Healthy => {
                            let still_exact_ready = self.open(&selector).is_ok_and(|current| {
                                current.descriptor().lifecycle == SessionLifecycle::Ready
                                    && completed_standalone_descriptor_matches(
                                        current.descriptor(),
                                        generation,
                                        provider_process,
                                    )
                            });
                            return Ok(if still_exact_ready {
                                CompletedStandaloneTargetLifecycle::Active
                            } else {
                                CompletedStandaloneTargetLifecycle::Unresolved
                            });
                        }
                        SessionProbeStatus::Exited => RequiredMutation::RetireExited,
                        SessionProbeStatus::StaleTransport => RequiredMutation::CleanupStale,
                        SessionProbeStatus::GenerationChanged
                        | SessionProbeStatus::IncompatibleProtocol => {
                            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
                        }
                    },
                }
            }
            Err(error)
                if error.is_session_absent()
                    && self
                        .exact_session_absence_is_quiescent(&expected_fence)
                        .unwrap_or(false) =>
            {
                RequiredMutation::ResolveAbsent
            }
            Err(_) => return Ok(CompletedStandaloneTargetLifecycle::Unresolved),
        };

        let host_process = ProcessDescriptor {
            process_id: generation.host_process.process_id,
            start_marker: generation.host_process.start_marker.clone(),
        };
        if !matches!(
            process_probe(&host_process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) || !matches!(
            process_probe(provider_process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }

        let (current_still_resolvable, current_cleanup_complete) = match self.open(&selector) {
            Ok(current) => {
                let exact = completed_standalone_descriptor_matches(
                    current.descriptor(),
                    generation,
                    provider_process,
                );
                let resolvable = exact
                    && match required_mutation {
                        RequiredMutation::ResolveAbsent => false,
                        RequiredMutation::CleanupStale => {
                            current.descriptor().lifecycle == SessionLifecycle::Ready
                        }
                        RequiredMutation::RetireExited => {
                            current.descriptor().lifecycle == SessionLifecycle::Exited
                        }
                    };
                let cleanup_complete = exact
                    && current.descriptor().lifecycle == SessionLifecycle::Exited
                    && !current.descriptor().process_session_cleanup_incomplete();
                (resolvable, cleanup_complete)
            }
            Err(error) if error.is_session_absent() => (
                self.exact_session_absence_is_quiescent(&expected_fence)
                    .unwrap_or(false),
                false,
            ),
            Err(_) => (false, false),
        };
        if !current_still_resolvable {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }

        let prior_archived_evidence =
            match self.archived_exited_retirement_evidence(&expected_fence, &host_process) {
                Ok(evidence) => evidence,
                Err(_) => return Ok(CompletedStandaloneTargetLifecycle::Unresolved),
            };
        if prior_archived_evidence.as_ref().is_some_and(|evidence| {
            evidence.session_class != SessionClass::Standalone
                || evidence.provider_process != *provider_process
        }) {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }
        let prior_archive_is_cleanup_complete =
            prior_archived_evidence.as_ref().is_some_and(|evidence| {
                evidence.session_class == SessionClass::Standalone
                    && evidence.provider_process == *provider_process
                    && !evidence.process_session_cleanup_incomplete
            });
        let process_session_is_empty =
            if prior_archive_is_cleanup_complete || current_cleanup_complete {
                false
            } else {
                match process_session_probe(provider_process) {
                    Ok(empty) => empty,
                    Err(_) => return Ok(CompletedStandaloneTargetLifecycle::Unresolved),
                }
            };
        if !prior_archive_is_cleanup_complete
            && !current_cleanup_complete
            && !process_session_is_empty
        {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }

        let target = ExitedSessionRetirementTarget::new(
            generation.fence.workspace_id.clone(),
            generation.fence.session_id.clone(),
            Some(generation.fence.terminal_epoch.clone()),
        )
        .with_generation(generation.clone());
        let report = match required_mutation {
            RequiredMutation::ResolveAbsent | RequiredMutation::RetireExited => {
                self.retire_exited_sessions(vec![target], ExitedSessionRetirementMode::Apply)?
            }
            RequiredMutation::CleanupStale => {
                self.cleanup_stale_sessions(vec![target], ExitedSessionRetirementMode::Apply)?
            }
        };
        let Some(receipt) = report.results.as_slice().first().filter(|_| {
            report.results.len() == 1
                && report.mode == ExitedSessionRetirementMode::Apply
                && report.evaluated == 1
        }) else {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        };
        let exact_receipt = receipt.workspace_id == generation.fence.workspace_id
            && receipt.session_id == generation.fence.session_id
            && receipt.generation.as_ref() == Some(generation);
        if !exact_receipt {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }
        let archived_evidence =
            match self.archived_exited_retirement_evidence(&expected_fence, &host_process) {
                Ok(evidence) => evidence,
                Err(_) => return Ok(CompletedStandaloneTargetLifecycle::Unresolved),
            };
        if archived_evidence.as_ref().is_some_and(|evidence| {
            evidence.session_class != SessionClass::Standalone
                || evidence.provider_process != *provider_process
        }) {
            return Ok(CompletedStandaloneTargetLifecycle::Unresolved);
        }
        let archived_evidence_is_eligible = archived_evidence.as_ref().is_some_and(|evidence| {
            evidence.session_class == SessionClass::Standalone
                && evidence.provider_process == *provider_process
                && !evidence.process_session_cleanup_incomplete
        });
        let cleanup_is_proven = archived_evidence_is_eligible || process_session_is_empty;
        let retired = match required_mutation {
            RequiredMutation::CleanupStale => {
                matches!(
                    receipt.outcome,
                    ExitedSessionRetirementOutcome::Retired
                        | ExitedSessionRetirementOutcome::AlreadyRetired
                ) && cleanup_is_proven
            }
            RequiredMutation::ResolveAbsent
                if receipt.outcome == ExitedSessionRetirementOutcome::Skipped
                    && receipt.reason == Some(ExitedSessionRetirementReason::NotFound) =>
            {
                cleanup_is_proven
            }
            RequiredMutation::ResolveAbsent | RequiredMutation::RetireExited
                if matches!(
                    receipt.outcome,
                    ExitedSessionRetirementOutcome::Retired
                        | ExitedSessionRetirementOutcome::AlreadyRetired
                ) =>
            {
                cleanup_is_proven
            }
            RequiredMutation::ResolveAbsent | RequiredMutation::RetireExited => false,
        };
        let still_absent = self
            .exact_session_absence_is_quiescent(&expected_fence)
            .unwrap_or(false);
        Ok(if retired && still_absent {
            // Launch-input compaction is replaceable storage maintenance, not
            // permission to retire a process or release its checkout claim.
            // Keep the immutable edge even when those larger inputs are gone.
            #[cfg(feature = "local-runtime")]
            let _ = recovery_journal::standalone_upgrade::retire_launch_inputs(
                self,
                generation,
                provider_process,
            );
            CompletedStandaloneTargetLifecycle::Retired
        } else {
            CompletedStandaloneTargetLifecycle::Unresolved
        })
    }

    /// Enumerate a deterministic bounded page of exited active pointers.
    pub fn exited_retirement_candidates(
        &self,
    ) -> Result<ExitedSessionRetirementCandidates, ClientError> {
        self.exited_retirement_candidates_after(None)
    }

    /// Enumerate a deterministic bounded page strictly after one prior cursor.
    pub fn exited_retirement_candidates_after(
        &self,
        after: Option<&ExitedSessionRetirementCursor>,
    ) -> Result<ExitedSessionRetirementCandidates, ClientError> {
        let after_key = after
            .map(ExitedSessionRetirementCursor::discovery_key)
            .transpose()?;
        let Some(root) = self.open_if_present()? else {
            return Ok(ExitedSessionRetirementCandidates {
                targets: Vec::new(),
                has_more: false,
                next_cursor: None,
            });
        };
        let census = root.list_exited_sessions_after(
            MAX_EXITED_SESSION_RETIREMENT_TARGETS,
            after_key.as_ref(),
        )?;
        let next_cursor = if census.has_more {
            census
                .sessions
                .last()
                .map(|session| ExitedSessionRetirementCursor::from_key(&session.key))
        } else {
            None
        };
        let mut targets = Vec::with_capacity(census.sessions.len());
        for discovered in census.sessions {
            let descriptor = SessionDescriptor::from(discovered);
            let generation = ExitedSessionRetirementGeneration::from_descriptor(&descriptor)?;
            targets.push(
                ExitedSessionRetirementTarget::new(
                    descriptor.workspace_id,
                    descriptor.session_id,
                    Some(descriptor.terminal_epoch),
                )
                .with_generation(generation),
            );
        }
        Ok(ExitedSessionRetirementCandidates {
            targets,
            has_more: census.has_more,
            next_cursor,
        })
    }

    /// Preview or apply retirement of exact exited discovery generations.
    ///
    /// Preview is read-only, including when no recovery journal exists. Apply
    /// holds the recovery source and journal-admission fences while the Host
    /// lifetime lock verifies and archives the complete generation.
    pub fn retire_exited_sessions(
        &self,
        targets: Vec<ExitedSessionRetirementTarget>,
        mode: ExitedSessionRetirementMode,
    ) -> Result<ExitedSessionRetirementReport, ExitedSessionRetirementError> {
        if targets.len() > MAX_EXITED_SESSION_RETIREMENT_TARGETS {
            return Err(ExitedSessionRetirementError::TooManyTargets {
                actual: targets.len(),
                maximum: MAX_EXITED_SESSION_RETIREMENT_TARGETS,
            });
        }
        let preview_pending = if mode == ExitedSessionRetirementMode::Preview {
            Some(recovery_roots::pending_sources(self).map_err(|error| journal_error_code(&error)))
        } else {
            None
        };
        let mut report = ExitedSessionRetirementReport::new("cleanup_exited", mode, targets.len());
        for target in targets {
            let receipt = if valid_target(&target) {
                match mode {
                    ExitedSessionRetirementMode::Preview => {
                        match preview_pending.as_ref().unwrap() {
                            Ok(pending_sources) => {
                                self.preview_exited_retirement(&target, pending_sources)
                            }
                            Err(error_code) => skipped(
                                &target,
                                ExitedSessionRetirementReason::JournalUnavailable,
                                Some(error_code.clone()),
                            ),
                        }
                    }
                    ExitedSessionRetirementMode::Apply => self.apply_exited_retirement(&target),
                }
            } else {
                ExitedSessionRetirementReceipt::for_target(
                    &target,
                    ExitedSessionRetirementOutcome::Skipped,
                    Some(ExitedSessionRetirementReason::InvalidTarget),
                    None,
                    None,
                )
            };
            report.push(receipt);
        }
        Ok(report)
    }

    /// Preview or remove exact non-exited generations whose lifetime lock is
    /// no longer owned. This is deliberately separate from recovery: no Host
    /// is signalled and no replacement is created. Preview returns the full
    /// generation that apply must present back unchanged.
    pub fn cleanup_stale_sessions(
        &self,
        targets: Vec<ExitedSessionRetirementTarget>,
        mode: ExitedSessionRetirementMode,
    ) -> Result<ExitedSessionRetirementReport, ExitedSessionRetirementError> {
        if targets.len() > MAX_EXITED_SESSION_RETIREMENT_TARGETS {
            return Err(ExitedSessionRetirementError::TooManyTargets {
                actual: targets.len(),
                maximum: MAX_EXITED_SESSION_RETIREMENT_TARGETS,
            });
        }
        let preview_pending = if mode == ExitedSessionRetirementMode::Preview {
            Some(recovery_roots::pending_sources(self).map_err(|error| journal_error_code(&error)))
        } else {
            None
        };
        let mut report = ExitedSessionRetirementReport::new("cleanup_stale", mode, targets.len());
        for target in targets {
            let receipt = if valid_target(&target) {
                match mode {
                    ExitedSessionRetirementMode::Preview => {
                        match preview_pending.as_ref().unwrap() {
                            Ok(pending_sources) => {
                                self.preview_stale_cleanup(&target, pending_sources)
                            }
                            Err(error_code) => skipped(
                                &target,
                                ExitedSessionRetirementReason::JournalUnavailable,
                                Some(error_code.clone()),
                            ),
                        }
                    }
                    ExitedSessionRetirementMode::Apply => self.apply_stale_cleanup(&target),
                }
            } else {
                ExitedSessionRetirementReceipt::for_target(
                    &target,
                    ExitedSessionRetirementOutcome::Skipped,
                    Some(ExitedSessionRetirementReason::InvalidTarget),
                    None,
                    None,
                )
            };
            report.push(receipt);
        }
        Ok(report)
    }

    fn preview_stale_cleanup(
        &self,
        target: &ExitedSessionRetirementTarget,
        pending_sources: &std::collections::BTreeSet<PendingRecoverySource>,
    ) -> ExitedSessionRetirementReceipt {
        let session = match self.open(&target.selector()) {
            Ok(session) => session,
            Err(error) => return open_error_receipt(target, error),
        };
        if let Some(receipt) = stale_preflight_receipt(target, &session, pending_sources) {
            return receipt;
        }
        if target
            .generation
            .as_ref()
            .is_some_and(|expected| !expected.matches_descriptor(session.descriptor()))
        {
            return skipped(
                target,
                ExitedSessionRetirementReason::GenerationChanged,
                None,
            );
        }
        let generation =
            match ExitedSessionRetirementGeneration::from_descriptor(session.descriptor()) {
                Ok(generation) => generation,
                Err(error) => return client_error_receipt(target, error),
            };
        match self.reserve_discovered_stale_exact(&session) {
            Ok(Some(reservation)) => match reservation.verify_stale() {
                Ok(()) => ExitedSessionRetirementReceipt::for_target(
                    target,
                    ExitedSessionRetirementOutcome::Retirable,
                    None,
                    None,
                    Some(generation),
                ),
                Err(error) => stale_cleanup_error_receipt(target, error),
            },
            Ok(None) => skipped(target, ExitedSessionRetirementReason::NotFound, None),
            Err(error) => stale_cleanup_error_receipt(target, error),
        }
    }

    fn apply_stale_cleanup(
        &self,
        target: &ExitedSessionRetirementTarget,
    ) -> ExitedSessionRetirementReceipt {
        let Some(expected_generation) = target.generation.as_ref() else {
            return skipped(
                target,
                ExitedSessionRetirementReason::GenerationRequired,
                None,
            );
        };
        if !expected_generation.names_target_identity(target) {
            return skipped(target, ExitedSessionRetirementReason::InvalidTarget, None);
        }
        if target
            .terminal_epoch
            .as_ref()
            .is_some_and(|epoch| epoch != &expected_generation.fence.terminal_epoch)
        {
            return skipped(target, ExitedSessionRetirementReason::EpochChanged, None);
        }
        let retirement_fence =
            match recovery_roots::fence_source(self, &target.workspace_id, &target.session_id) {
                Ok(Some(fences)) => fences,
                Ok(None) => {
                    return skipped(target, ExitedSessionRetirementReason::RecoveryPending, None);
                }
                Err(error) => {
                    return skipped(
                        target,
                        ExitedSessionRetirementReason::JournalUnavailable,
                        Some(journal_error_code(&error)),
                    );
                }
            };
        let session = match self.open(&target.selector()) {
            Ok(session) => session,
            Err(error) if error.is_session_absent() => {
                return ExitedSessionRetirementReceipt::for_target(
                    target,
                    ExitedSessionRetirementOutcome::AlreadyRetired,
                    None,
                    None,
                    Some(expected_generation.clone()),
                );
            }
            Err(error) => return open_error_receipt(target, error),
        };
        if !expected_generation.matches_descriptor(session.descriptor()) {
            return skipped(
                target,
                ExitedSessionRetirementReason::GenerationChanged,
                None,
            );
        }
        if session.descriptor().lifecycle == SessionLifecycle::Exited {
            return skipped(target, ExitedSessionRetirementReason::NotStale, None);
        }
        let result = match self.reserve_discovered_stale_exact(&session) {
            Ok(Some(retirement)) => retirement.retire_stale(),
            Ok(None) => Ok(false),
            Err(error) => Err(error),
        };
        drop(retirement_fence);
        match result {
            Ok(true) => ExitedSessionRetirementReceipt::for_target(
                target,
                ExitedSessionRetirementOutcome::Retired,
                None,
                None,
                Some(expected_generation.clone()),
            ),
            Ok(false) => ExitedSessionRetirementReceipt::for_target(
                target,
                ExitedSessionRetirementOutcome::AlreadyRetired,
                None,
                None,
                Some(expected_generation.clone()),
            ),
            Err(error) => stale_cleanup_error_receipt(target, error),
        }
    }

    fn preview_exited_retirement(
        &self,
        target: &ExitedSessionRetirementTarget,
        pending_sources: &std::collections::BTreeSet<PendingRecoverySource>,
    ) -> ExitedSessionRetirementReceipt {
        let session = match self.open(&target.selector()) {
            Ok(session) => session,
            Err(error) => return open_error_receipt(target, error),
        };
        if let Some(receipt) = preflight_receipt(target, &session, pending_sources) {
            return receipt;
        }
        if target
            .generation
            .as_ref()
            .is_some_and(|expected| !expected.matches_descriptor(session.descriptor()))
        {
            return skipped(
                target,
                ExitedSessionRetirementReason::GenerationChanged,
                None,
            );
        }
        let generation =
            match ExitedSessionRetirementGeneration::from_descriptor(session.descriptor()) {
                Ok(generation) => generation,
                Err(error) => return client_error_receipt(target, error),
            };
        ExitedSessionRetirementReceipt::for_target(
            target,
            ExitedSessionRetirementOutcome::Retirable,
            None,
            None,
            Some(generation),
        )
    }

    fn apply_exited_retirement(
        &self,
        target: &ExitedSessionRetirementTarget,
    ) -> ExitedSessionRetirementReceipt {
        let Some(expected_generation) = target.generation.as_ref() else {
            return skipped(
                target,
                ExitedSessionRetirementReason::GenerationRequired,
                None,
            );
        };
        if !expected_generation.names_target_identity(target) {
            return skipped(target, ExitedSessionRetirementReason::InvalidTarget, None);
        }
        if target
            .terminal_epoch
            .as_ref()
            .is_some_and(|epoch| epoch != &expected_generation.fence.terminal_epoch)
        {
            return skipped(target, ExitedSessionRetirementReason::EpochChanged, None);
        }
        let Ok(expected_fence) = expected_generation.session_fence() else {
            return skipped(target, ExitedSessionRetirementReason::InvalidTarget, None);
        };
        let expected_host_process = expected_generation.host_process();
        let retirement_fence =
            match recovery_roots::fence_source(self, &target.workspace_id, &target.session_id) {
                Ok(Some(fences)) => fences,
                Ok(None) => {
                    return skipped(target, ExitedSessionRetirementReason::RecoveryPending, None);
                }
                Err(error) => {
                    return skipped(
                        target,
                        ExitedSessionRetirementReason::JournalUnavailable,
                        Some(journal_error_code(&error)),
                    );
                }
            };
        let mut managed_ledger_receipt = None;
        let result = match self.open(&target.selector()) {
            Ok(session) => {
                if session.descriptor().session_class == SessionClass::Managed
                    && session.descriptor().lifecycle == SessionLifecycle::Exited
                    && expected_generation.matches_descriptor(session.descriptor())
                {
                    let ledger_receipt =
                        match observed_exit_stop_receipt(target, expected_generation) {
                            Ok(receipt) => receipt,
                            Err(error) => return client_error_receipt(target, error),
                        };
                    if let Err(error) = managed_create_ledger::checkpoint_retirement_exact(
                        self.discovery_root(),
                        &ledger_receipt,
                    ) {
                        return client_error_receipt(target, managed_ledger_error(error));
                    }
                    managed_ledger_receipt = Some(ledger_receipt);
                }
                self.retire_discovered_exited_generation_exact(
                    &session,
                    &expected_fence,
                    &expected_host_process,
                )
            }
            Err(error) if error.is_session_absent() => match self
                .discovered_exited_generation_is_retired_managed(
                    &expected_fence,
                    &expected_host_process,
                ) {
                Ok(Some(true)) => {
                    let ledger_receipt =
                        match observed_exit_stop_receipt(target, expected_generation) {
                            Ok(receipt) => receipt,
                            Err(error) => return client_error_receipt(target, error),
                        };
                    if let Err(error) = managed_create_ledger::checkpoint_retirement_exact(
                        self.discovery_root(),
                        &ledger_receipt,
                    ) {
                        return client_error_receipt(target, managed_ledger_error(error));
                    }
                    managed_ledger_receipt = Some(ledger_receipt);
                    Ok(ExactExitedRetirement::AlreadyRetired)
                }
                Ok(Some(false)) => Ok(ExactExitedRetirement::AlreadyRetired),
                Ok(None) => {
                    self.retire_exited_generation_exact(&expected_fence, &expected_host_process)
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        if matches!(
            result,
            Ok(ExactExitedRetirement::Retired | ExactExitedRetirement::AlreadyRetired)
        ) {
            if let Some(ledger_receipt) = managed_ledger_receipt.as_ref() {
                if let Err(error) = managed_create_ledger::finalize_retirement_exact(
                    self.discovery_root(),
                    ledger_receipt,
                ) {
                    return client_error_receipt(target, managed_ledger_error(error));
                }
            }
        }
        drop(retirement_fence);
        match result {
            Ok(ExactExitedRetirement::Retired) => ExitedSessionRetirementReceipt::for_target(
                target,
                ExitedSessionRetirementOutcome::Retired,
                None,
                None,
                Some(expected_generation.clone()),
            ),
            Ok(ExactExitedRetirement::AlreadyRetired) => {
                ExitedSessionRetirementReceipt::for_target(
                    target,
                    ExitedSessionRetirementOutcome::AlreadyRetired,
                    None,
                    None,
                    Some(expected_generation.clone()),
                )
            }
            Ok(ExactExitedRetirement::NotFound) => {
                skipped(target, ExitedSessionRetirementReason::NotFound, None)
            }
            Err(error) if error.is_generation_mismatch() => skipped(
                target,
                ExitedSessionRetirementReason::GenerationChanged,
                None,
            ),
            Err(error) if error.is_invalid_manifest_transition() => {
                skipped(target, ExitedSessionRetirementReason::NotExited, None)
            }
            Err(ClientError::Discovery(DiscoveryError::AlreadyLocked { .. })) => {
                skipped(target, ExitedSessionRetirementReason::LifetimeBusy, None)
            }
            Err(ClientError::Discovery(
                DiscoveryError::RetiredHistoryRecordCapacityExceeded { .. }
                | DiscoveryError::RetiredHistoryByteCapacityExceeded { .. }
                | DiscoveryError::RetiredHistoryScanCapacityExceeded { .. },
            )) => skipped(target, ExitedSessionRetirementReason::ArchiveCapacity, None),
            Err(ClientError::Discovery(DiscoveryError::InvalidDiscoveryKey(_))) => {
                skipped(target, ExitedSessionRetirementReason::InvalidTarget, None)
            }
            Err(error) => client_error_receipt(target, error),
        }
    }
}

fn observed_exit_stop_receipt(
    target: &ExitedSessionRetirementTarget,
    generation: &ExitedSessionRetirementGeneration,
) -> Result<ManagedStopReceipt, ClientError> {
    let process_id = generation.host_process.process_id.to_string();
    let digest = recovery_journal::request_fingerprint(&[
        &target.workspace_id,
        &target.session_id,
        &generation.fence.runner_principal,
        &generation.fence.runner_instance,
        &generation.fence.channel_epoch,
        &generation.fence.host_instance_id,
        &generation.fence.terminal_epoch,
        &process_id,
        &generation.host_process.start_marker,
    ]);
    let channel_epoch = generation.fence.channel_epoch.parse::<u64>().map_err(|_| {
        ClientError::transport(
            "hmux_exited_retirement_ledger_failed",
            "exited generation has an invalid channel epoch",
        )
    })?;
    let request = ManagedStopRequest::new(
        format!("exited-retirement-{digest}"),
        &target.session_id,
        &target.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &generation.fence.runner_principal,
            &generation.fence.runner_instance,
            channel_epoch,
            &generation.fence.host_instance_id,
            &generation.fence.terminal_epoch,
        )
    })
    .map_err(|error| {
        ClientError::transport("hmux_exited_retirement_ledger_failed", error.to_string())
    })?;
    ManagedStopReceipt::from_request(
        &request,
        ManagedStopOutcome::AlreadyExited,
        "managed_provider_already_exited",
    )
    .map_err(|error| {
        ClientError::transport("hmux_exited_retirement_ledger_failed", error.to_string())
    })
}

fn managed_ledger_error(error: String) -> ClientError {
    ClientError::transport("hmux_exited_retirement_ledger_failed", error)
}

fn preflight_receipt(
    target: &ExitedSessionRetirementTarget,
    session: &LocalSession,
    pending_sources: &std::collections::BTreeSet<PendingRecoverySource>,
) -> Option<ExitedSessionRetirementReceipt> {
    if session.descriptor().lifecycle != SessionLifecycle::Exited {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::NotExited,
            None,
        ));
    }
    if pending_sources.contains(&target.pending_source()) {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::RecoveryPending,
            None,
        ));
    }
    if target
        .terminal_epoch
        .as_ref()
        .is_some_and(|epoch| epoch != &session.descriptor().terminal_epoch)
    {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::EpochChanged,
            None,
        ));
    }
    None
}

fn stale_preflight_receipt(
    target: &ExitedSessionRetirementTarget,
    session: &LocalSession,
    pending_sources: &std::collections::BTreeSet<PendingRecoverySource>,
) -> Option<ExitedSessionRetirementReceipt> {
    if session.descriptor().lifecycle == SessionLifecycle::Exited {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::NotStale,
            None,
        ));
    }
    if pending_sources.contains(&target.pending_source()) {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::RecoveryPending,
            None,
        ));
    }
    if target
        .terminal_epoch
        .as_ref()
        .is_some_and(|epoch| epoch != &session.descriptor().terminal_epoch)
    {
        return Some(skipped(
            target,
            ExitedSessionRetirementReason::EpochChanged,
            None,
        ));
    }
    None
}

fn stale_cleanup_error_receipt(
    target: &ExitedSessionRetirementTarget,
    error: ClientError,
) -> ExitedSessionRetirementReceipt {
    if error.is_generation_mismatch() {
        return skipped(
            target,
            ExitedSessionRetirementReason::GenerationChanged,
            None,
        );
    }
    if error.is_invalid_manifest_transition() {
        return skipped(target, ExitedSessionRetirementReason::NotStale, None);
    }
    if matches!(
        error,
        ClientError::Discovery(DiscoveryError::AlreadyLocked { .. })
    ) {
        return skipped(target, ExitedSessionRetirementReason::LifetimeBusy, None);
    }
    client_error_receipt(target, error)
}

fn open_error_receipt(
    target: &ExitedSessionRetirementTarget,
    error: ClientError,
) -> ExitedSessionRetirementReceipt {
    if error.is_session_absent() {
        skipped(target, ExitedSessionRetirementReason::NotFound, None)
    } else {
        client_error_receipt(target, error)
    }
}

fn client_error_receipt(
    target: &ExitedSessionRetirementTarget,
    error: ClientError,
) -> ExitedSessionRetirementReceipt {
    skipped(
        target,
        ExitedSessionRetirementReason::Error,
        Some(bounded_message(error.code())),
    )
}

fn skipped(
    target: &ExitedSessionRetirementTarget,
    reason: ExitedSessionRetirementReason,
    message: Option<String>,
) -> ExitedSessionRetirementReceipt {
    ExitedSessionRetirementReceipt::for_target(
        target,
        ExitedSessionRetirementOutcome::Skipped,
        Some(reason),
        message.map(|message| bounded_message(&message)),
        target.generation.clone(),
    )
}

fn journal_error_code(_error: &str) -> String {
    "recovery_journal_unavailable".to_string()
}

fn valid_target(target: &ExitedSessionRetirementTarget) -> bool {
    if !valid_discovery_id(&target.workspace_id)
        || !valid_discovery_id(&target.session_id)
        || target
            .terminal_epoch
            .as_deref()
            .is_some_and(|epoch| !valid_identifier(epoch))
    {
        return false;
    }
    let Some(generation) = target.generation.as_ref() else {
        return true;
    };
    let fence = &generation.fence;
    if ![
        fence.workspace_id.as_str(),
        fence.session_id.as_str(),
        fence.runner_instance.as_str(),
    ]
    .into_iter()
    .all(valid_discovery_id)
    {
        return false;
    }
    [
        fence.runner_principal.as_str(),
        fence.host_instance_id.as_str(),
        fence.terminal_epoch.as_str(),
        generation.host_process.start_marker.as_str(),
    ]
    .into_iter()
    .all(valid_identifier)
        && fence.channel_epoch.parse::<u64>().is_ok()
        && generation.host_process.process_id != 0
}

fn valid_discovery_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_DISCOVERY_ID_BYTES
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_RETIREMENT_IDENTIFIER_BYTES
}

fn bounded_value(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_string();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn bounded_message(message: &str) -> String {
    const MAX_MESSAGE_BYTES: usize = 192;
    if message.len() <= MAX_MESSAGE_BYTES {
        return message.to_string();
    }
    let mut end = MAX_MESSAGE_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_string()
}

#[cfg(test)]
mod tests {
    mod recovery_roots;
    use super::*;
    #[cfg(unix)]
    use crate::exact_local_process_generation;
    use crate::recovery_journal::{
        self, RecoveryIdentity, RecoveryReservationState, request_fingerprint,
    };
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
        HostLifetimeIdentity, LifetimeLock, LocalEndpoint, LocalEndpointKind, ManifestCommon,
        ReadyManifest, SessionClass, StartingManifest,
    };
    use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
    use hmux_session_protocol::{
        Exit, ProcessProof, ProtocolVersion, RuntimeContext, VersionRange,
    };
    use std::cell::Cell;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::process::{Child, Command, Stdio};
    #[cfg(unix)]
    use std::thread;
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    fn publish_ready(root: &DiscoveryRoot, session_id: &str) {
        publish_ready_in_workspace(root, "workspace", session_id);
    }

    fn publish_ready_in_workspace(root: &DiscoveryRoot, workspace_id: &str, session_id: &str) {
        publish_ready_in_workspace_with_processes(
            root,
            workspace_id,
            session_id,
            ProcessProof {
                process_id: 100,
                start_marker: format!("host-start-{session_id}"),
            },
            ProcessProof {
                process_id: 101,
                start_marker: format!("provider-start-{session_id}"),
            },
        );
    }

    fn publish_ready_in_workspace_with_processes(
        root: &DiscoveryRoot,
        workspace_id: &str,
        session_id: &str,
        host_process: ProcessProof,
        provider_process: ProcessProof,
    ) {
        let key = DiscoveryKey::new(workspace_id, session_id, "runner-1", 4).unwrap();
        let session = root.session(key).unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "build-v1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 1 },
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: workspace_id.into(),
                session_id: session_id.into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 4,
            },
            host_instance_id: format!("host-{session_id}"),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process,
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some(format!("fixture-{session_id}")),
            retirement_policy: None,
        };
        let lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lock,
                ReadyManifest {
                    common,
                    provider_process,
                    terminal_epoch: format!("terminal-{session_id}"),
                    ready_output_seq: 8,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: "host.sock".into(),
                    },
                    capability_token: format!("token-{session_id}"),
                    ready_unix_ms: 3,
                },
            )
            .unwrap();
    }

    fn publish_exited(root: &DiscoveryRoot, session_id: &str) {
        publish_exited_with_reason(root, session_id, "provider_exit");
    }

    fn publish_exited_with_reason(root: &DiscoveryRoot, session_id: &str, reason: &str) {
        publish_ready(root, session_id);
        transition_to_exited(root, session_id, reason);
    }

    fn transition_to_exited(root: &DiscoveryRoot, session_id: &str, reason: &str) {
        let key = DiscoveryKey::new("workspace", session_id, "runner-1", 4).unwrap();
        let session = root.open_session(key).unwrap();
        let lock = session.acquire_lifetime_lock().unwrap();
        let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
            panic!("fixture must be ready before exit");
        };
        session
            .publish_exited(
                &lock,
                ExitedManifest {
                    common: ready.common.clone(),
                    tombstone: Box::new(ExitTombstone {
                        fence: SessionFence {
                            workspace_id: "workspace".into(),
                            session_id: session_id.into(),
                            runner_principal: "runner".into(),
                            runner_instance: "runner-1".into(),
                            channel_epoch: 4,
                            host_instance_id: ready.common.host_instance_id.clone(),
                            terminal_epoch: ready.terminal_epoch.clone(),
                        },
                        provider_process: ready.provider_process.clone(),
                        exit: Exit {
                            final_output_seq: ready.ready_output_seq,
                            exit_code: Some(0),
                            platform_status: None,
                            reason: reason.into(),
                        },
                        exit_kind: ProviderExitKind::Normal,
                        created_unix_ms: 4,
                        failure: None,
                    }),
                    endpoint: ready.endpoint,
                    capability_token: ready.capability_token,
                    exited_unix_ms: 4,
                },
            )
            .unwrap();
    }

    fn publish_ready_successor(root: &DiscoveryRoot, session_id: &str) -> LifetimeLock {
        let key = DiscoveryKey::new("workspace", session_id, "runner-2", 5).unwrap();
        let session = root.session(key).unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "build-v1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 1 },
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: session_id.into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-2".into(),
                channel_epoch: 5,
            },
            host_instance_id: format!("successor-host-{session_id}"),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 200,
                start_marker: format!("successor-host-start-{session_id}"),
            },
            created_unix_ms: 5,
            session_class: SessionClass::Standalone,
            session_name: Some(format!("successor-{session_id}")),
            retirement_policy: None,
        };
        let lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 6,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lock,
                ReadyManifest {
                    common,
                    provider_process: ProcessProof {
                        process_id: 201,
                        start_marker: format!("successor-provider-start-{session_id}"),
                    },
                    terminal_epoch: format!("successor-terminal-{session_id}"),
                    ready_output_seq: 9,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: "successor-host.sock".into(),
                    },
                    capability_token: format!("successor-token-{session_id}"),
                    ready_unix_ms: 7,
                },
            )
            .unwrap();
        lock
    }

    fn exact_target(
        catalog: &LocalSessionCatalog,
        session_id: &str,
    ) -> ExitedSessionRetirementTarget {
        let session = catalog
            .open(&SessionSelector::new(session_id, Some("workspace".into())))
            .unwrap();
        ExitedSessionRetirementTarget::new(
            "workspace",
            session_id,
            Some(session.descriptor().terminal_epoch.clone()),
        )
        .with_generation(
            ExitedSessionRetirementGeneration::from_descriptor(session.descriptor()).unwrap(),
        )
    }

    #[cfg(any(unix, windows))]
    fn completed_target_proofs(
        catalog: &LocalSessionCatalog,
        session_id: &str,
    ) -> (ExitedSessionRetirementGeneration, ProcessDescriptor) {
        let session = catalog
            .open(&SessionSelector::new(session_id, Some("workspace".into())))
            .unwrap();
        (
            ExitedSessionRetirementGeneration::from_descriptor(session.descriptor()).unwrap(),
            session.descriptor().provider_process.clone(),
        )
    }

    fn compatibility_catalog(
        temp: &tempfile::TempDir,
        session_id: &str,
        publish: fn(&DiscoveryRoot, &str),
    ) -> LocalSessionCatalog {
        let canonical_path = temp.path().join("canonical");
        let compatibility_path = temp.path().join("compatibility");
        DiscoveryRoot::create(&canonical_path).unwrap();
        let compatibility = DiscoveryRoot::create(&compatibility_path).unwrap();
        publish(&compatibility, session_id);
        LocalSessionCatalog::with_read_only_discovery_roots(
            canonical_path,
            vec![compatibility_path],
        )
        .unwrap()
    }

    #[cfg(unix)]
    struct SurvivingProviderSession {
        leader: Option<Child>,
        leader_process: ProcessDescriptor,
        descendant_process: ProcessDescriptor,
        leader_release: PathBuf,
        descendant_release: PathBuf,
    }

    #[cfg(unix)]
    impl SurvivingProviderSession {
        fn spawn(temp: &Path) -> Self {
            let leader_release = temp.join("release-provider-leader");
            let descendant_release = temp.join("release-provider-descendant");
            let descendant_pid = temp.join("provider-descendant.pid");
            let script = "while [ ! -e \"$1\" ]; do sleep 0.02; done & \
                          echo $! > \"$2\"; \
                          while [ ! -e \"$3\" ]; do sleep 0.02; done";
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(script)
                .arg("hmux-provider-session-fixture")
                .arg(&descendant_release)
                .arg(&descendant_pid)
                .arg(&leader_release)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // SAFETY: this closure runs after fork and before exec, calls only
            // the async-signal-safe setsid syscall, and reports errno directly.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            let leader = command.spawn().unwrap();
            let leader_process = exact_local_process_generation(leader.id()).unwrap();
            let descendant_id = wait_for_fixture_pid(&descendant_pid);
            let descendant_process = exact_local_process_generation(descendant_id).unwrap();
            Self {
                leader: Some(leader),
                leader_process,
                descendant_process,
                leader_release,
                descendant_release,
            }
        }

        fn stop_leader(&mut self) {
            fs::write(&self.leader_release, b"release").unwrap();
            let status = self.leader.take().unwrap().wait().unwrap();
            assert!(status.success());
        }
    }

    #[cfg(unix)]
    impl Drop for SurvivingProviderSession {
        fn drop(&mut self) {
            let _ = fs::write(&self.leader_release, b"release");
            let _ = fs::write(&self.descendant_release, b"release");
            if let Some(mut leader) = self.leader.take() {
                let _ = leader.wait();
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline
                && matches!(
                    probe_local_process_generation(&self.descendant_process),
                    Ok(LocalProcessGenerationStatus::Live)
                )
            {
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_fixture_pid(path: &Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(process_id) = fs::read_to_string(path)
                .map(|value| value.trim().to_string())
                .and_then(|value| {
                    value
                        .parse()
                        .map_err(|error| std::io::Error::other(format!("invalid pid: {error}")))
                })
            {
                return process_id;
            }
            assert!(
                Instant::now() < deadline,
                "provider descendant pid was not published"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn exited_process_descriptor() -> ProcessDescriptor {
        let mut process = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let descriptor = exact_local_process_generation(process.id()).unwrap();
        process.kill().unwrap();
        process.wait().unwrap();
        descriptor
    }

    #[cfg(unix)]
    #[test]
    fn surviving_provider_session_descendant_blocks_completed_target_retirement() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let host_process = exited_process_descriptor();
        let mut provider_session = SurvivingProviderSession::spawn(temp.path());
        publish_ready_in_workspace_with_processes(
            &root,
            "workspace",
            "target",
            ProcessProof {
                process_id: host_process.process_id,
                start_marker: host_process.start_marker.clone(),
            },
            ProcessProof {
                process_id: provider_session.leader_process.process_id,
                start_marker: provider_session.leader_process.start_marker.clone(),
            },
        );
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");
        provider_session.stop_leader();

        assert_eq!(
            probe_local_process_generation(&host_process).unwrap(),
            LocalProcessGenerationStatus::Absent,
            "the regression requires a dead Host leader"
        );
        assert_eq!(
            probe_local_process_generation(&provider_process).unwrap(),
            LocalProcessGenerationStatus::Absent,
            "the regression requires a dead provider leader"
        );
        assert_eq!(
            probe_local_process_generation(&provider_session.descendant_process).unwrap(),
            LocalProcessGenerationStatus::Live,
            "the regression requires a live provider-session descendant"
        );
        let lifecycle = catalog.resolve_completed_standalone_target(&generation, &provider_process);

        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Unresolved);
        assert!(
            catalog
                .open(&SessionSelector::new("target", Some("workspace".into())))
                .is_ok(),
            "an unresolved target must remain available and cannot authorize successor rotation"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_target_is_active_only_after_an_exact_healthy_probe() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");

        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| SessionProbeStatus::Healthy,
                |_| panic!("a healthy exact target must not need process absence"),
                |_| panic!("a healthy exact target must not need a session census"),
            )
            .unwrap();

        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Active);
        assert!(
            catalog
                .open(&SessionSelector::new("target", Some("workspace".into())))
                .is_ok()
        );

        let raced = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| {
                    transition_to_exited(&root, "target", "provider_exit");
                    SessionProbeStatus::Healthy
                },
                |_| panic!("a claimed healthy target must not need process absence"),
                |_| panic!("a claimed healthy target must not need a session census"),
            )
            .unwrap();
        assert_eq!(raced, CompletedStandaloneTargetLifecycle::Unresolved);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_exit_is_archived_and_exact_archive_confirms_retry() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "target");
        let key = DiscoveryKey::new("workspace", "target", "runner-1", 4).unwrap();
        let discovered = root.open_session(key).unwrap();
        let archived_generation = discovered.read_manifest().unwrap().generation();
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");

        let retired = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an Exited manifest does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| panic!("a cleanup-complete exit must archive its own evidence"),
            )
            .unwrap();
        assert_eq!(retired, CompletedStandaloneTargetLifecycle::Retired);
        let tombstone = discovered
            .find_retired_exited_generation(&archived_generation)
            .unwrap()
            .expect("exact exited tombstone was not archived");

        let confirmed = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| panic!("a cleanup-complete archive must remain authoritative"),
            )
            .unwrap();
        assert_eq!(confirmed, CompletedStandaloneTargetLifecycle::Retired);
        assert_eq!(
            discovered
                .find_retired_exited_generation(&archived_generation)
                .unwrap(),
            Some(tombstone),
            "archive confirmation removed or rewrote the tombstone"
        );

        let mut changed_provider = provider_process.clone();
        changed_provider.start_marker.push_str("-replacement");
        let spliced = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &changed_provider,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| panic!("a spliced provider must not reach the session census"),
            )
            .unwrap();
        assert_eq!(spliced, CompletedStandaloneTargetLifecycle::Unresolved);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_cleanup_incomplete_stays_unresolved_across_archival() {
        const INCOMPLETE: &str = "provider_exit; process_session_cleanup_incomplete";

        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited_with_reason(&root, "initially-exited", INCOMPLETE);
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "initially-exited");

        let active_tombstone = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an Exited manifest does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(false),
            )
            .unwrap();
        assert_eq!(
            active_tombstone,
            CompletedStandaloneTargetLifecycle::Unresolved
        );

        let target = ExitedSessionRetirementTarget::new(
            "workspace",
            "initially-exited",
            Some(generation.fence.terminal_epoch.clone()),
        )
        .with_generation(generation.clone());
        assert_eq!(
            catalog
                .retire_exited_sessions(vec![target], ExitedSessionRetirementMode::Apply)
                .unwrap()
                .results[0]
                .outcome,
            ExitedSessionRetirementOutcome::Retired
        );
        let archived_tombstone = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(false),
            )
            .unwrap();
        assert_eq!(
            archived_tombstone,
            CompletedStandaloneTargetLifecycle::Unresolved
        );
        let later_empty_session = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(true),
            )
            .unwrap();
        assert_eq!(
            later_empty_session,
            CompletedStandaloneTargetLifecycle::Retired,
            "an exact stable empty-session witness may resolve incomplete archive evidence"
        );

        publish_ready(&root, "exits-during-probe");
        let (generation, provider_process) =
            completed_target_proofs(&catalog, "exits-during-probe");
        let raced_tombstone = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| {
                    transition_to_exited(&root, "exits-during-probe", INCOMPLETE);
                    SessionProbeStatus::Exited
                },
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(false),
            )
            .unwrap();
        assert_eq!(
            raced_tombstone,
            CompletedStandaloneTargetLifecycle::Unresolved
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_absence_requires_both_exact_processes_to_be_absent() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let session = catalog
            .open(&SessionSelector::new("target", Some("workspace".into())))
            .unwrap();
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");
        assert!(catalog.cleanup_stale_exact(&session).unwrap());

        let live_process = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Live),
                |_| panic!("a live process must block the session census"),
            )
            .unwrap();
        assert_eq!(
            live_process,
            CompletedStandaloneTargetLifecycle::Unresolved,
            "manifest absence must not override a live exact process"
        );

        let surviving_member = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(false),
            )
            .unwrap();
        assert_eq!(
            surviving_member,
            CompletedStandaloneTargetLifecycle::Unresolved,
            "a surviving provider-session member must block retirement"
        );

        let census_error = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| {
                    Err(ClientError::transport(
                        "hmux_process_session_census_unavailable",
                        "fixture census unavailable",
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            census_error,
            CompletedStandaloneTargetLifecycle::Unresolved,
            "an incomplete provider-session census must block retirement"
        );

        let absent_processes = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("an absent target does not need a Ready probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(true),
            )
            .unwrap();
        assert_eq!(
            absent_processes,
            CompletedStandaloneTargetLifecycle::Retired
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_stale_target_requires_two_absent_processes_and_exact_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");

        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| SessionProbeStatus::StaleTransport,
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| Ok(true),
            )
            .unwrap();

        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Retired);
        assert!(
            catalog
                .open(&SessionSelector::new("target", Some("workspace".into())))
                .is_err()
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_changed_unavailable_or_live_target_stays_unresolved() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");

        let mut changed = generation.clone();
        changed.fence.host_instance_id.push_str("-replacement");
        assert_eq!(
            catalog
                .resolve_completed_standalone_target_with_probes(
                    &changed,
                    &provider_process,
                    |_| panic!("a changed generation must not be probed"),
                    |_| panic!("a changed generation must not reach process cleanup"),
                    |_| panic!("a changed generation must not reach session census"),
                )
                .unwrap(),
            CompletedStandaloneTargetLifecycle::Unresolved
        );
        assert_eq!(
            catalog
                .resolve_completed_standalone_target_with_probes(
                    &generation,
                    &provider_process,
                    |_| SessionProbeStatus::StaleTransport,
                    |_| Ok(LocalProcessGenerationStatus::Live),
                    |_| panic!("a live process must block the session census"),
                )
                .unwrap(),
            CompletedStandaloneTargetLifecycle::Unresolved
        );
        assert_eq!(
            catalog
                .resolve_completed_standalone_target_with_probes(
                    &generation,
                    &provider_process,
                    |_| SessionProbeStatus::StaleTransport,
                    |_| {
                        Err(ClientError::transport(
                            "hmux_process_generation_unverified",
                            "fixture process probe unavailable",
                        ))
                    },
                    |_| panic!("a process-probe error must block the session census"),
                )
                .unwrap(),
            CompletedStandaloneTargetLifecycle::Unresolved
        );
        assert!(
            catalog
                .open(&SessionSelector::new("target", Some("workspace".into())))
                .is_ok(),
            "an unresolved target was removed"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_cleanup_race_converges_after_exact_process_absence() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let raced_session = catalog
            .open(&SessionSelector::new("target", Some("workspace".into())))
            .unwrap();
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");
        let process_probes = Cell::new(0_usize);

        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| SessionProbeStatus::StaleTransport,
                |_| {
                    let probe = process_probes.get();
                    process_probes.set(probe + 1);
                    if probe == 1 {
                        assert!(catalog.cleanup_stale_exact(&raced_session).unwrap());
                    }
                    Ok(LocalProcessGenerationStatus::Absent)
                },
                |_| Ok(true),
            )
            .unwrap();

        assert_eq!(process_probes.get(), 2);
        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Retired);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_creator_lock_window_is_not_absence() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let session = catalog
            .open(&SessionSelector::new("target", Some("workspace".into())))
            .unwrap();
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");
        assert!(catalog.cleanup_stale_exact(&session).unwrap());

        let key = DiscoveryKey::new("workspace", "target", "runner-1", 4).unwrap();
        let creator = root.session(key).unwrap();
        let _creator_lock = creator.acquire_lifetime_lock().unwrap();
        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("a missing manifest must not need a session probe"),
                |_| panic!("a creator-held lifetime lock must block absence proof"),
                |_| panic!("a creator-held lifetime lock must block session census"),
            )
            .unwrap();

        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Unresolved);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_stale_cleanup_rejects_incomplete_archival_race() {
        const INCOMPLETE: &str = "provider_exit; process_session_cleanup_incomplete";

        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let (generation, provider_process) = completed_target_proofs(&catalog, "target");
        let process_probes = Cell::new(0_usize);

        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| SessionProbeStatus::StaleTransport,
                |_| {
                    let probe = process_probes.get();
                    process_probes.set(probe + 1);
                    if probe == 1 {
                        transition_to_exited(&root, "target", INCOMPLETE);
                        let exited = catalog
                            .open(&SessionSelector::new("target", Some("workspace".into())))
                            .unwrap();
                        assert!(catalog.retire_exited_exact(&exited).unwrap());
                    }
                    Ok(LocalProcessGenerationStatus::Absent)
                },
                |_| Ok(false),
            )
            .unwrap();

        assert_eq!(process_probes.get(), 2);
        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Unresolved);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn completed_standalone_conflicting_archives_across_roots_are_unresolved() {
        const INCOMPLETE: &str = "provider_exit; process_session_cleanup_incomplete";

        let temp = tempfile::tempdir().unwrap();
        let canonical_path = temp.path().join("canonical");
        let compatibility_path = temp.path().join("compatibility");
        let canonical = DiscoveryRoot::create(&canonical_path).unwrap();
        let compatibility = DiscoveryRoot::create(&compatibility_path).unwrap();
        publish_exited(&canonical, "target");
        publish_exited_with_reason(&compatibility, "target", INCOMPLETE);

        let canonical_catalog = LocalSessionCatalog::new(&canonical_path);
        let (generation, provider_process) = completed_target_proofs(&canonical_catalog, "target");
        let canonical_session = canonical_catalog
            .open(&SessionSelector::new("target", Some("workspace".into())))
            .unwrap();
        assert!(
            canonical_catalog
                .retire_exited_exact(&canonical_session)
                .unwrap()
        );
        let compatibility_catalog = LocalSessionCatalog::new(&compatibility_path);
        let compatibility_session = compatibility_catalog
            .open(&SessionSelector::new("target", Some("workspace".into())))
            .unwrap();
        assert!(
            compatibility_catalog
                .retire_exited_exact(&compatibility_session)
                .unwrap()
        );

        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            canonical_path,
            vec![compatibility_path],
        )
        .unwrap();
        let lifecycle = catalog
            .resolve_completed_standalone_target_with_probes(
                &generation,
                &provider_process,
                |_| panic!("archived generations must not need a session probe"),
                |_| Ok(LocalProcessGenerationStatus::Absent),
                |_| panic!("conflicting archive evidence must block the session census"),
            )
            .unwrap();

        assert_eq!(lifecycle, CompletedStandaloneTargetLifecycle::Unresolved);
    }

    #[test]
    fn preview_is_read_only_and_apply_archives_only_exited_with_exact_retry() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "exited");
        publish_ready(&root, "ready");
        let catalog = LocalSessionCatalog::new(root.path());
        let exited = ExitedSessionRetirementTarget::new(
            "workspace",
            "exited",
            Some("terminal-exited".into()),
        );
        let ready =
            ExitedSessionRetirementTarget::new("workspace", "ready", Some("terminal-ready".into()));

        assert!(!root.path().join(".recovery").exists());
        let preview = catalog
            .retire_exited_sessions(vec![exited, ready], ExitedSessionRetirementMode::Preview)
            .unwrap();
        assert_eq!(preview.retirable, 1);
        assert_eq!(preview.skipped, 1);
        assert_eq!(
            preview.results[1].reason,
            Some(ExitedSessionRetirementReason::NotExited)
        );
        assert!(
            !root.path().join(".recovery").exists(),
            "preview created recovery state"
        );

        let exact = ExitedSessionRetirementTarget::new(
            "workspace",
            "exited",
            Some("terminal-exited".into()),
        )
        .with_generation(preview.results[0].generation.clone().unwrap());
        fs::write(root.path().join(".managed-create-v2"), b"not a ledger").unwrap();
        let applied = catalog
            .retire_exited_sessions(vec![exact.clone()], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            applied.results[0].outcome,
            ExitedSessionRetirementOutcome::Retired
        );
        assert!(
            catalog
                .open(&SessionSelector::new("ready", Some("workspace".into())))
                .is_ok()
        );
        assert!(
            catalog
                .open(&SessionSelector::new("exited", Some("workspace".into())))
                .is_err()
        );

        let retried = catalog
            .retire_exited_sessions(vec![exact.clone()], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            retried.results[0].outcome,
            ExitedSessionRetirementOutcome::AlreadyRetired,
            "standalone retirement must not depend on the managed-create ledger"
        );

        let successor_lock = publish_ready_successor(&root, "exited");
        let retried_after_successor = catalog
            .retire_exited_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            retried_after_successor.results[0].outcome,
            ExitedSessionRetirementOutcome::AlreadyRetired
        );
        let successor = catalog
            .open(&SessionSelector::new("exited", Some("workspace".into())))
            .unwrap();
        assert_eq!(
            successor.descriptor().host_instance_id,
            "successor-host-exited"
        );
        drop(successor_lock);
    }

    #[test]
    fn stale_cleanup_uses_exact_workspace_generation_and_leaves_no_source() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_ready(&root, "same-name");
        publish_ready_in_workspace(&root, "other-workspace", "same-name");
        let catalog = LocalSessionCatalog::new(root.path());

        let preview = catalog
            .cleanup_stale_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "same-name",
                    Some("terminal-same-name".into()),
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();
        assert_eq!(preview.operation, "cleanup_stale");
        assert_eq!(
            preview.results[0].outcome,
            ExitedSessionRetirementOutcome::Retirable
        );
        let exact = ExitedSessionRetirementTarget::new(
            "workspace",
            "same-name",
            Some("terminal-same-name".into()),
        )
        .with_generation(preview.results[0].generation.clone().unwrap());

        let applied = catalog
            .cleanup_stale_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();

        assert_eq!(
            applied.results[0].outcome,
            ExitedSessionRetirementOutcome::Retired
        );
        assert!(
            catalog
                .open(&SessionSelector::new("same-name", Some("workspace".into())))
                .is_err()
        );
        assert!(
            catalog
                .open(&SessionSelector::new(
                    "same-name",
                    Some("other-workspace".into()),
                ))
                .is_ok()
        );
    }

    #[test]
    fn confirmed_stale_cleanup_retires_a_compatibility_root_session() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = compatibility_catalog(&temp, "compatibility-stale", publish_ready);

        let preview = catalog
            .cleanup_stale_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "compatibility-stale",
                    Some("terminal-compatibility-stale".into()),
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();

        assert_eq!(
            preview.results[0].outcome,
            ExitedSessionRetirementOutcome::Retirable
        );
        let exact = ExitedSessionRetirementTarget::new(
            "workspace",
            "compatibility-stale",
            Some("terminal-compatibility-stale".into()),
        )
        .with_generation(preview.results[0].generation.clone().unwrap());

        let applied = catalog
            .cleanup_stale_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();

        assert_eq!(
            applied.results[0].outcome,
            ExitedSessionRetirementOutcome::Retired,
            "{:?}",
            applied.results[0],
        );
        assert!(
            catalog
                .open(&SessionSelector::new(
                    "compatibility-stale",
                    Some("workspace".into()),
                ))
                .is_err()
        );
    }

    #[test]
    fn confirmed_exited_retirement_retires_a_compatibility_root_session() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = compatibility_catalog(&temp, "compatibility-exited", publish_exited);

        let preview = catalog
            .retire_exited_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "compatibility-exited",
                    Some("terminal-compatibility-exited".into()),
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();
        assert_eq!(
            preview.results[0].outcome,
            ExitedSessionRetirementOutcome::Retirable
        );
        let exact = ExitedSessionRetirementTarget::new(
            "workspace",
            "compatibility-exited",
            Some("terminal-compatibility-exited".into()),
        )
        .with_generation(preview.results[0].generation.clone().unwrap());

        let applied = catalog
            .retire_exited_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();

        assert_eq!(
            applied.results[0].outcome,
            ExitedSessionRetirementOutcome::Retired,
            "{:?}",
            applied.results[0],
        );
        assert!(
            catalog
                .open(&SessionSelector::new(
                    "compatibility-exited",
                    Some("workspace".into()),
                ))
                .is_err()
        );
    }

    #[test]
    fn stale_cleanup_refuses_a_live_generation_without_removing_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let live_lock = publish_ready_successor(&root, "live");
        let catalog = LocalSessionCatalog::new(root.path());
        let exact = exact_target(&catalog, "live");

        let preview = catalog
            .cleanup_stale_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "live",
                    Some("successor-terminal-live".into()),
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();
        assert_eq!(
            preview.results[0].reason,
            Some(ExitedSessionRetirementReason::LifetimeBusy)
        );
        let applied = catalog
            .cleanup_stale_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            applied.results[0].reason,
            Some(ExitedSessionRetirementReason::LifetimeBusy)
        );
        assert!(
            catalog
                .open(&SessionSelector::new("live", Some("workspace".into())))
                .is_ok()
        );
        drop(live_lock);
    }

    #[test]
    fn apply_preserves_pending_and_source_locked_recoveries() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "pending");
        publish_exited(&root, "busy");
        let catalog = LocalSessionCatalog::new(root.path());
        let pending = exact_target(&catalog, "pending");
        let busy = exact_target(&catalog, "busy");
        let identity = RecoveryIdentity {
            recovery_id: "recovery-pending".into(),
            source_session_id: "pending".into(),
            source_workspace_id: "workspace".into(),
            request_fingerprint: request_fingerprint(&["recovery-pending"]),
            action: "test",
        };
        let reservation = recovery_journal::reserve(root.path(), identity).unwrap();
        assert!(matches!(reservation, RecoveryReservationState::Pending(_)));
        let source_lock = recovery_journal::lock_source(root.path(), "workspace", "busy").unwrap();

        let report = catalog
            .retire_exited_sessions(vec![pending, busy], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(report.retired, 0);
        assert_eq!(report.skipped, 2);
        assert!(report.results.iter().all(|receipt| {
            receipt.reason == Some(ExitedSessionRetirementReason::RecoveryPending)
        }));
        assert_eq!(catalog.list().unwrap().len(), 2);
        drop(source_lock);
        drop(reservation);
    }

    #[test]
    fn exact_target_is_not_blinded_by_more_than_128_unrelated_debris_entries() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "target");
        for index in 0..129 {
            fs::write(root.path().join(format!("debris-{index}")), b"broken").unwrap();
        }
        let catalog = LocalSessionCatalog::new(root.path());
        let report = catalog
            .retire_exited_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "target",
                    None,
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();
        assert_eq!(report.retirable, 1);
    }

    #[test]
    fn apply_requires_complete_generation_and_batch_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let missing_generation = catalog
            .retire_exited_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "target",
                    Some("terminal-target".into()),
                )],
                ExitedSessionRetirementMode::Apply,
            )
            .unwrap();
        assert_eq!(
            missing_generation.results[0].reason,
            Some(ExitedSessionRetirementReason::GenerationRequired)
        );
        assert!(catalog.list().is_ok());

        let targets = (0..=MAX_EXITED_SESSION_RETIREMENT_TARGETS)
            .map(|index| {
                ExitedSessionRetirementTarget::new("workspace", format!("session-{index}"), None)
            })
            .collect();
        assert!(matches!(
            catalog.retire_exited_sessions(targets, ExitedSessionRetirementMode::Preview),
            Err(ExitedSessionRetirementError::TooManyTargets {
                maximum: MAX_EXITED_SESSION_RETIREMENT_TARGETS,
                ..
            })
        ));
    }

    #[test]
    fn invalid_unbounded_authority_is_rejected_before_journal_mutation_and_not_reflected() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let catalog = LocalSessionCatalog::new(root.path());
        let oversized = "x".repeat(MAX_DISCOVERY_ID_BYTES + 1);
        let generation = ExitedSessionRetirementGeneration {
            fence: ExitedSessionRetirementFence {
                workspace_id: oversized.clone(),
                session_id: oversized.clone(),
                runner_principal: oversized.clone(),
                runner_instance: oversized.clone(),
                channel_epoch: "1".into(),
                host_instance_id: oversized.clone(),
                terminal_epoch: oversized.clone(),
            },
            host_process: ExitedSessionRetirementProcessProof {
                process_id: 1,
                start_marker: oversized.clone(),
            },
        };
        let target = ExitedSessionRetirementTarget::new(
            oversized.clone(),
            oversized,
            Some(generation.fence.terminal_epoch.clone()),
        )
        .with_generation(generation);

        let report = catalog
            .retire_exited_sessions(vec![target], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            report.results[0].reason,
            Some(ExitedSessionRetirementReason::InvalidTarget)
        );
        assert!(report.results[0].workspace_id.len() <= MAX_DISCOVERY_ID_BYTES);
        assert!(report.results[0].session_id.len() <= MAX_DISCOVERY_ID_BYTES);
        assert!(report.results[0].generation.is_none());
        assert!(
            !root.path().join(".recovery").exists(),
            "invalid target created journal state"
        );
    }

    #[test]
    fn bounded_messages_preserve_utf8_boundaries() {
        let bounded = bounded_message(&"한".repeat(100));
        assert!(bounded.len() <= 192);
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn destructive_generation_authority_rejects_unknown_fields() {
        let generation = serde_json::json!({
            "fence": {
                "workspaceId": "workspace",
                "sessionId": "session",
                "runnerPrincipal": "runner",
                "runnerInstance": "runner-1",
                "channelEpoch": "4",
                "hostInstanceId": "host-1",
                "terminalEpoch": "terminal-1",
                "futureFence": "must-not-be-ignored"
            },
            "hostProcess": {
                "processId": 100,
                "startMarker": "host-start",
            }
        });

        assert!(serde_json::from_value::<ExitedSessionRetirementGeneration>(generation).is_err());
    }

    #[test]
    fn corrupt_journal_is_a_typed_bounded_preview_refusal_without_path_disclosure() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "target");
        recovery_journal::inspect(root.path()).unwrap();
        fs::write(root.path().join(".recovery").join("broken.json"), b"{").unwrap();
        let catalog = LocalSessionCatalog::new(root.path());

        let report = catalog
            .retire_exited_sessions(
                vec![ExitedSessionRetirementTarget::new(
                    "workspace",
                    "target",
                    None,
                )],
                ExitedSessionRetirementMode::Preview,
            )
            .unwrap();
        assert_eq!(
            report.results[0].reason,
            Some(ExitedSessionRetirementReason::JournalUnavailable)
        );
        let message = report.results[0].message.as_deref().unwrap();
        assert_eq!(message, "recovery_journal_unavailable");
        assert!(!message.contains(temp.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn complete_fence_is_required_for_active_and_archived_generations() {
        let temp = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_exited(&root, "target");
        let catalog = LocalSessionCatalog::new(root.path());
        let exact = exact_target(&catalog, "target");
        let mut wrong_principal = exact.clone();
        wrong_principal
            .generation
            .as_mut()
            .unwrap()
            .fence
            .runner_principal = "replacement-runner".into();

        let refused = catalog
            .retire_exited_sessions(
                vec![wrong_principal.clone()],
                ExitedSessionRetirementMode::Apply,
            )
            .unwrap();
        assert_eq!(
            refused.results[0].reason,
            Some(ExitedSessionRetirementReason::GenerationChanged)
        );
        assert!(
            catalog
                .open(&SessionSelector::new("target", Some("workspace".into())))
                .is_ok()
        );

        let retired = catalog
            .retire_exited_sessions(vec![exact], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(retired.retired, 1);
        let refused_retry = catalog
            .retire_exited_sessions(vec![wrong_principal], ExitedSessionRetirementMode::Apply)
            .unwrap();
        assert_eq!(
            refused_retry.results[0].reason,
            Some(ExitedSessionRetirementReason::GenerationChanged)
        );
    }

    #[test]
    fn maximum_report_fits_the_default_local_protocol_frame() {
        let identifier = "x".repeat(256);
        let generation = ExitedSessionRetirementGeneration {
            fence: ExitedSessionRetirementFence {
                workspace_id: identifier.clone(),
                session_id: identifier.clone(),
                runner_principal: identifier.clone(),
                runner_instance: identifier.clone(),
                channel_epoch: u64::MAX.to_string(),
                host_instance_id: identifier.clone(),
                terminal_epoch: identifier.clone(),
            },
            host_process: ExitedSessionRetirementProcessProof {
                process_id: u32::MAX,
                start_marker: identifier.clone(),
            },
        };
        let mut report = ExitedSessionRetirementReport::new(
            "cleanup_exited",
            ExitedSessionRetirementMode::Preview,
            MAX_EXITED_SESSION_RETIREMENT_TARGETS,
        );
        for _ in 0..MAX_EXITED_SESSION_RETIREMENT_TARGETS {
            let target = ExitedSessionRetirementTarget::new(
                identifier.clone(),
                identifier.clone(),
                Some(identifier.clone()),
            );
            report.push(ExitedSessionRetirementReceipt::for_target(
                &target,
                ExitedSessionRetirementOutcome::Retirable,
                None,
                None,
                Some(generation.clone()),
            ));
        }
        let encoded = serde_json::to_vec(&report).unwrap();
        assert!(
            encoded.len() <= hmux_session_protocol::DEFAULT_MAX_FRAME_BYTES,
            "maximum report was {} bytes",
            encoded.len()
        );
    }
}
