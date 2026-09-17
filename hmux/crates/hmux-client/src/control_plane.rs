use crate::{
    AgentIdentityDescriptor, AgentRuntimeStateDescriptor, ClientError, ExecutionLocationDescriptor,
    LocalSessionCatalog, LocalSessionObserver, ObserverAttachOptions,
    ProviderConversationIdentityDescriptor, RecoveredPresentationDescriptor, ScreenSnapshotProfile,
    SessionDescriptor, SessionLifecycle, SessionSelector, WorkingDirectoryDescriptor,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

pub const SESSION_PROBE_QUANTUM: Duration = Duration::from_millis(500);
pub const MAX_EXACT_SESSION_PROBE_TARGETS: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionProbeStatus {
    Healthy,
    StaleTransport,
    IncompatibleProtocol,
    Exited,
    GenerationChanged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEffectiveLifecycle {
    Ready,
    Stale,
    Incompatible,
    Exited,
    Unprobed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionHealth {
    Healthy,
    StaleTransport,
    IncompatibleProtocol,
    Exited,
    GenerationChanged,
    Unprobed,
}

/// A manifest descriptor plus the result of a fresh, bounded control-plane
/// handshake. `descriptor.lifecycle` intentionally remains serialized as the
/// legacy `lifecycle` field; callers that need current usability consume
/// `effectiveLifecycle` and `health`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInspection {
    #[serde(flatten)]
    pub descriptor: SessionDescriptor,
    pub manifest_lifecycle: SessionLifecycle,
    pub effective_lifecycle: SessionEffectiveLifecycle,
    pub health: SessionHealth,
    /// Fenced Host-owned runtime projections captured by the same bounded
    /// observer handshake that established `health`. These are absent for an
    /// unprobed, stale, incompatible, or replaced generation.
    pub working_directory: Option<WorkingDirectoryDescriptor>,
    pub execution_location: Option<ExecutionLocationDescriptor>,
    pub agent_identity: Option<AgentIdentityDescriptor>,
    pub agent_runtime_state: Option<AgentRuntimeStateDescriptor>,
    pub controller_input_pending: Option<bool>,
    pub semantic_idle_ms: Option<String>,
    pub provider_conversation_identity: Option<Box<ProviderConversationIdentityDescriptor>>,
    pub recovered_presentation: Option<Box<RecoveredPresentationDescriptor>>,
    #[serde(skip)]
    probe: Option<SessionProbeStatus>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SessionProbeObservation {
    status: SessionProbeStatus,
    observed_descriptor: Option<SessionDescriptor>,
    working_directory: Option<WorkingDirectoryDescriptor>,
    execution_location: Option<ExecutionLocationDescriptor>,
    agent_identity: Option<AgentIdentityDescriptor>,
    agent_runtime_state: Option<AgentRuntimeStateDescriptor>,
    controller_input_pending: Option<bool>,
    semantic_idle_ms: Option<String>,
    provider_conversation_identity: Option<Box<ProviderConversationIdentityDescriptor>>,
    recovered_presentation: Option<Box<RecoveredPresentationDescriptor>>,
}

impl From<SessionProbeStatus> for SessionProbeObservation {
    fn from(status: SessionProbeStatus) -> Self {
        Self {
            status,
            observed_descriptor: None,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            controller_input_pending: None,
            semantic_idle_ms: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
        }
    }
}

trait IntoOptionalSessionProbeObservation {
    fn into_optional_observation(self) -> Option<SessionProbeObservation>;
}

impl IntoOptionalSessionProbeObservation for SessionProbeStatus {
    fn into_optional_observation(self) -> Option<SessionProbeObservation> {
        Some(self.into())
    }
}

impl IntoOptionalSessionProbeObservation for SessionProbeObservation {
    fn into_optional_observation(self) -> Option<SessionProbeObservation> {
        Some(self)
    }
}

impl IntoOptionalSessionProbeObservation for Option<SessionProbeStatus> {
    fn into_optional_observation(self) -> Option<SessionProbeObservation> {
        self.map(SessionProbeObservation::from)
    }
}

impl IntoOptionalSessionProbeObservation for Option<SessionProbeObservation> {
    fn into_optional_observation(self) -> Option<SessionProbeObservation> {
        self
    }
}

impl std::ops::Deref for SessionInspection {
    type Target = SessionDescriptor;

    fn deref(&self) -> &Self::Target {
        &self.descriptor
    }
}

impl SessionInspection {
    #[must_use]
    pub fn unprobed(descriptor: SessionDescriptor) -> Self {
        inspection_from_probe(descriptor, None)
    }

    #[must_use]
    pub fn probe_status(&self) -> Option<SessionProbeStatus> {
        self.probe
    }
}

/// One exact selector's outcome in a bounded batch probe. Missing and failed
/// discovery stay distinct: only an exact absence can be projected as dead by
/// an adapter, while an unreadable manifest must remain unknown.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExactSessionProbeResult {
    Inspection(Box<SessionInspection>),
    NotFound(SessionSelector),
    LookupFailed {
        selector: SessionSelector,
        error_code: String,
    },
    Unprobed(SessionSelector),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExactSessionProbeBatchError {
    TooManyTargets {
        actual: usize,
        maximum: usize,
    },
    ExactWorkspaceRequired {
        session_id: String,
    },
    EmptySessionId,
    DuplicateTarget {
        session_id: String,
        workspace_id: String,
    },
}

impl fmt::Display for ExactSessionProbeBatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyTargets { actual, maximum } => write!(
                formatter,
                "exact session probe batch has {actual} targets; maximum is {maximum}"
            ),
            Self::ExactWorkspaceRequired { session_id } => write!(
                formatter,
                "exact session probe target {session_id:?} requires a non-empty workspace id"
            ),
            Self::EmptySessionId => {
                formatter.write_str("exact session probe target requires a non-empty session id")
            }
            Self::DuplicateTarget {
                session_id,
                workspace_id,
            } => write!(
                formatter,
                "exact session probe target {session_id:?} in workspace {workspace_id:?} was specified more than once"
            ),
        }
    }
}

impl std::error::Error for ExactSessionProbeBatchError {}

pub fn probe_local_session(
    catalog: &LocalSessionCatalog,
    selector: &SessionSelector,
) -> SessionProbeStatus {
    let descriptor = match catalog.find(selector) {
        Ok(descriptor) => descriptor,
        Err(_) => return SessionProbeStatus::StaleTransport,
    };
    probe_local_session_exact(catalog, &descriptor)
}

pub fn probe_local_session_with_timeout(
    catalog: &LocalSessionCatalog,
    selector: &SessionSelector,
    timeout: Duration,
) -> SessionProbeStatus {
    let descriptor = match catalog.find(selector) {
        Ok(descriptor) => descriptor,
        Err(_) => return SessionProbeStatus::StaleTransport,
    };
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        return probe_local_session_exact(catalog, &descriptor);
    };
    probe_local_session_exact_until(catalog, &descriptor, deadline)
}

pub fn probe_local_session_exact(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
) -> SessionProbeStatus {
    probe_local_session_exact_until(catalog, descriptor, Instant::now() + SESSION_PROBE_QUANTUM)
}

pub fn probe_local_session_exact_until(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
    deadline: Instant,
) -> SessionProbeStatus {
    match try_probe_local_session_exact_until(catalog, descriptor, deadline) {
        Ok(status) => status,
        Err(error) => classify_probe_error(&error),
    }
}

fn try_probe_local_session_exact_until(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
    deadline: Instant,
) -> Result<SessionProbeStatus, ClientError> {
    try_probe_local_session_observation_until(catalog, descriptor, deadline)
        .map(|observation| observation.status)
}

fn try_probe_local_session_observation_until(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
    deadline: Instant,
) -> Result<SessionProbeObservation, ClientError> {
    if descriptor.lifecycle == SessionLifecycle::Exited {
        return Ok(SessionProbeStatus::Exited.into());
    }
    let selector = SessionSelector::new(
        descriptor.session_id.clone(),
        Some(descriptor.workspace_id.clone()),
    );
    let options = ObserverAttachOptions::default()
        .with_handshake_completion_timeout(SESSION_PROBE_QUANTUM)
        .with_handshake_deadline(deadline)
        .with_initial_snapshot_profile(ScreenSnapshotProfile::ViewportOnly);
    match LocalSessionObserver::inspect(catalog, &selector, options) {
        Ok(observer) => {
            let attachment = observer.attachment();
            let observed = attachment.session.clone();
            let same_generation = descriptor.same_generation(&observed);
            let observed_lifecycle = observed.lifecycle;
            let working_directory = attachment.initial_snapshot.working_directory.clone();
            let execution_location = attachment.initial_snapshot.execution_location.clone();
            let agent_identity = attachment.initial_snapshot.agent_identity.clone();
            let agent_runtime_state = attachment.initial_snapshot.agent_runtime_state.clone();
            let controller_input_pending = attachment.initial_snapshot.controller_input_pending;
            let semantic_idle_ms = attachment.initial_snapshot.semantic_idle_ms.clone();
            let provider_conversation_identity = attachment
                .initial_snapshot
                .provider_conversation_identity
                .clone();
            let recovered_presentation = attachment.initial_snapshot.recovered_presentation.clone();
            let _ = observer.detach();
            let status = if !same_generation {
                SessionProbeStatus::GenerationChanged
            } else if observed_lifecycle == SessionLifecycle::Exited {
                SessionProbeStatus::Exited
            } else {
                SessionProbeStatus::Healthy
            };
            if !same_generation {
                return Ok(status.into());
            }
            Ok(SessionProbeObservation {
                status,
                observed_descriptor: Some(observed),
                working_directory,
                execution_location,
                agent_identity,
                agent_runtime_state,
                controller_input_pending,
                semantic_idle_ms,
                provider_conversation_identity,
                recovered_presentation,
            })
        }
        Err(error) => Err(error),
    }
}

fn bounded_probe_observation(
    result: Result<SessionProbeObservation, ClientError>,
) -> Option<SessionProbeObservation> {
    match result {
        Ok(observation) => Some(observation),
        Err(error) if probe_deadline_exhausted(&error) => None,
        Err(error) => Some(classify_probe_error(&error).into()),
    }
}

fn probe_deadline_exhausted(error: &ClientError) -> bool {
    match error {
        ClientError::Io { source, .. } => source.kind() == std::io::ErrorKind::TimedOut,
        ClientError::Transport { code, .. } => *code == "hmux_attach_deadline_exceeded",
        ClientError::WriteNotStarted { .. } => true,
        _ => false,
    }
}

#[must_use]
pub fn inspect_local_session(
    catalog: &LocalSessionCatalog,
    descriptor: SessionDescriptor,
) -> SessionInspection {
    let observation = match descriptor.lifecycle {
        SessionLifecycle::Exited => Some(SessionProbeStatus::Exited.into()),
        SessionLifecycle::Ready => {
            bounded_probe_observation(try_probe_local_session_observation_until(
                catalog,
                &descriptor,
                Instant::now() + SESSION_PROBE_QUANTUM,
            ))
        }
    };
    inspection_from_observation(descriptor, observation)
}

pub(crate) fn inspection_from_probe(
    descriptor: SessionDescriptor,
    probe: Option<SessionProbeStatus>,
) -> SessionInspection {
    inspection_from_observation(descriptor, probe.map(SessionProbeObservation::from))
}

fn inspection_from_observation(
    mut descriptor: SessionDescriptor,
    observation: Option<SessionProbeObservation>,
) -> SessionInspection {
    let manifest_lifecycle = descriptor.lifecycle;
    let probe = observation.as_ref().map(|observation| observation.status);
    if let Some(observed) = observation
        .as_ref()
        .and_then(|observation| observation.observed_descriptor.clone())
    {
        descriptor = observed;
    }
    let (effective_lifecycle, health) = match manifest_lifecycle {
        SessionLifecycle::Exited => (SessionEffectiveLifecycle::Exited, SessionHealth::Exited),
        SessionLifecycle::Ready => match probe {
            Some(SessionProbeStatus::Healthy) => {
                (SessionEffectiveLifecycle::Ready, SessionHealth::Healthy)
            }
            Some(SessionProbeStatus::StaleTransport) => (
                SessionEffectiveLifecycle::Stale,
                SessionHealth::StaleTransport,
            ),
            Some(SessionProbeStatus::IncompatibleProtocol) => (
                SessionEffectiveLifecycle::Incompatible,
                SessionHealth::IncompatibleProtocol,
            ),
            Some(SessionProbeStatus::Exited) => {
                (SessionEffectiveLifecycle::Exited, SessionHealth::Exited)
            }
            Some(SessionProbeStatus::GenerationChanged) => (
                SessionEffectiveLifecycle::Stale,
                SessionHealth::GenerationChanged,
            ),
            None => (SessionEffectiveLifecycle::Unprobed, SessionHealth::Unprobed),
        },
    };
    SessionInspection {
        descriptor,
        manifest_lifecycle,
        effective_lifecycle,
        health,
        working_directory: observation
            .as_ref()
            .and_then(|observation| observation.working_directory.clone()),
        execution_location: observation
            .as_ref()
            .and_then(|observation| observation.execution_location.clone()),
        agent_identity: observation
            .as_ref()
            .and_then(|observation| observation.agent_identity.clone()),
        agent_runtime_state: observation
            .as_ref()
            .and_then(|observation| observation.agent_runtime_state.clone()),
        controller_input_pending: observation
            .as_ref()
            .and_then(|observation| observation.controller_input_pending),
        semantic_idle_ms: observation
            .as_ref()
            .and_then(|observation| observation.semantic_idle_ms.clone()),
        provider_conversation_identity: observation
            .as_ref()
            .and_then(|observation| observation.provider_conversation_identity.clone()),
        recovered_presentation: observation
            .and_then(|observation| observation.recovered_presentation),
        probe,
    }
}

/// Inspect a catalog snapshot without allowing a large stale catalog to turn
/// into an unbounded thread/process fan-out.
#[must_use]
pub fn inspect_local_sessions(
    catalog: &LocalSessionCatalog,
    descriptors: Vec<SessionDescriptor>,
    maximum_workers: usize,
    total_budget: Duration,
) -> Vec<SessionInspection> {
    inspect_local_sessions_with_probe(
        descriptors,
        maximum_workers,
        total_budget,
        |descriptor, deadline| {
            bounded_probe_observation(try_probe_local_session_observation_until(
                catalog, descriptor, deadline,
            ))
        },
    )
}

/// Probe only the requested exact workspace/session identities. Unlike
/// [`inspect_local_sessions`], this never enumerates the discovery catalog, so
/// unrelated slow or stale entries cannot starve a selected target near the
/// tail of the catalog.
///
/// This compatibility entry point runs discovery inside the caller process.
/// Long-running local consumers should use
/// `inspect_local_sessions_exact_isolated`, because portable `std::fs` lookups
/// cannot be cancelled after their deadline.
pub fn inspect_local_sessions_exact(
    catalog: &LocalSessionCatalog,
    selectors: Vec<SessionSelector>,
    maximum_workers: usize,
    total_budget: Duration,
) -> Result<Vec<ExactSessionProbeResult>, ExactSessionProbeBatchError> {
    let exact_catalog = Arc::new(catalog.clone());
    let resolve_catalog = Arc::clone(&exact_catalog);
    let probe_catalog = Arc::clone(&exact_catalog);
    inspect_local_sessions_exact_with_probe(
        selectors,
        maximum_workers,
        total_budget,
        move |selector| resolve_catalog.find(selector),
        move |descriptor, deadline| {
            bounded_probe_observation(try_probe_local_session_observation_until(
                &probe_catalog,
                descriptor,
                deadline,
            ))
        },
    )
}

fn inspect_local_sessions_exact_with_probe<R, P>(
    selectors: Vec<SessionSelector>,
    maximum_workers: usize,
    total_budget: Duration,
    resolve: R,
    probe: P,
) -> Result<Vec<ExactSessionProbeResult>, ExactSessionProbeBatchError>
where
    R: Fn(&SessionSelector) -> Result<SessionDescriptor, ClientError> + Send + Sync + 'static,
    P: Fn(&SessionDescriptor, Instant) -> Option<SessionProbeObservation> + Send + Sync + 'static,
{
    validate_exact_probe_targets(&selectors)?;
    if selectors.is_empty() {
        return Ok(Vec::new());
    }
    let workers = maximum_workers.clamp(1, 8).min(selectors.len());
    let deadline = Instant::now().checked_add(total_budget);
    let next = Arc::new(AtomicUsize::new(0));
    let selectors = Arc::new(selectors);
    let resolve = Arc::new(resolve);
    let probe = Arc::new(probe);
    let mut results = selectors
        .iter()
        .cloned()
        .map(ExactSessionProbeResult::Unprobed)
        .collect::<Vec<_>>();
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Ok(results);
    }
    let (sender, receiver) = mpsc::channel();
    for _ in 0..workers {
        let selectors = Arc::clone(&selectors);
        let next = Arc::clone(&next);
        let resolve = Arc::clone(&resolve);
        let probe = Arc::clone(&probe);
        let sender = sender.clone();
        std::thread::spawn(move || {
            loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(selector) = selectors.get(index) else {
                    break;
                };
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    break;
                }
                let resolved = match resolve(selector) {
                    Ok(descriptor) => descriptor,
                    Err(error) => {
                        let result = if error.is_session_absent() {
                            ExactSessionProbeResult::NotFound(selector.clone())
                        } else {
                            ExactSessionProbeResult::LookupFailed {
                                selector: selector.clone(),
                                error_code: error.code().to_owned(),
                            }
                        };
                        if sender
                            .send(ExactProbeWorkerMessage::Result(index, result))
                            .is_err()
                        {
                            return;
                        }
                        continue;
                    }
                };
                if resolved.lifecycle == SessionLifecycle::Exited {
                    if sender
                        .send(ExactProbeWorkerMessage::Result(
                            index,
                            ExactSessionProbeResult::Inspection(Box::new(inspection_from_probe(
                                resolved,
                                Some(SessionProbeStatus::Exited),
                            ))),
                        ))
                        .is_err()
                    {
                        return;
                    }
                    continue;
                }
                let now = Instant::now();
                if deadline.is_some_and(|deadline| now >= deadline) {
                    let _ = sender.send(ExactProbeWorkerMessage::Result(
                        index,
                        ExactSessionProbeResult::Inspection(Box::new(SessionInspection::unprobed(
                            resolved,
                        ))),
                    ));
                    break;
                }
                let quantum_deadline = now.checked_add(SESSION_PROBE_QUANTUM);
                let probe_deadline = match (quantum_deadline, deadline) {
                    (Some(quantum), Some(global)) => quantum.min(global),
                    (Some(quantum), None) => quantum,
                    (None, Some(global)) => global,
                    (None, None) => {
                        if sender
                            .send(ExactProbeWorkerMessage::Result(
                                index,
                                ExactSessionProbeResult::Inspection(Box::new(
                                    SessionInspection::unprobed(resolved),
                                )),
                            ))
                            .is_err()
                        {
                            return;
                        }
                        continue;
                    }
                };
                let observation = probe(&resolved, probe_deadline);
                if sender
                    .send(ExactProbeWorkerMessage::Result(
                        index,
                        ExactSessionProbeResult::Inspection(Box::new(inspection_from_observation(
                            resolved,
                            observation,
                        ))),
                    ))
                    .is_err()
                {
                    return;
                }
            }
            let _ = sender.send(ExactProbeWorkerMessage::Done);
        });
    }
    drop(sender);
    let mut active_workers = workers;
    while active_workers > 0 {
        let message = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receiver.recv_timeout(remaining) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                        break;
                    }
                }
            }
            None => match receiver.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };
        match message {
            ExactProbeWorkerMessage::Result(index, result) => results[index] = result,
            ExactProbeWorkerMessage::Done => active_workers -= 1,
        }
    }
    Ok(results)
}

enum ExactProbeWorkerMessage {
    Result(usize, ExactSessionProbeResult),
    Done,
}

pub(crate) fn validate_exact_probe_targets(
    selectors: &[SessionSelector],
) -> Result<(), ExactSessionProbeBatchError> {
    if selectors.len() > MAX_EXACT_SESSION_PROBE_TARGETS {
        return Err(ExactSessionProbeBatchError::TooManyTargets {
            actual: selectors.len(),
            maximum: MAX_EXACT_SESSION_PROBE_TARGETS,
        });
    }
    let mut unique = BTreeSet::new();
    for selector in selectors {
        if selector.session_id.is_empty() {
            return Err(ExactSessionProbeBatchError::EmptySessionId);
        }
        let Some(workspace_id) = selector
            .workspace_id
            .as_deref()
            .filter(|workspace_id| !workspace_id.is_empty())
        else {
            return Err(ExactSessionProbeBatchError::ExactWorkspaceRequired {
                session_id: selector.session_id.clone(),
            });
        };
        if !unique.insert((selector.session_id.as_str(), workspace_id)) {
            return Err(ExactSessionProbeBatchError::DuplicateTarget {
                session_id: selector.session_id.clone(),
                workspace_id: workspace_id.to_string(),
            });
        }
    }
    Ok(())
}

fn inspect_local_sessions_with_probe<F, O>(
    descriptors: Vec<SessionDescriptor>,
    maximum_workers: usize,
    total_budget: Duration,
    probe: F,
) -> Vec<SessionInspection>
where
    F: Fn(&SessionDescriptor, Instant) -> O + Sync,
    O: IntoOptionalSessionProbeObservation,
{
    if descriptors.is_empty() {
        return Vec::new();
    }
    let workers = maximum_workers.clamp(1, 8).min(descriptors.len());
    let deadline = Instant::now().checked_add(total_budget);
    let next = AtomicUsize::new(0);
    let inspections = Mutex::new(
        descriptors
            .iter()
            .cloned()
            .map(SessionInspection::unprobed)
            .collect::<Vec<_>>(),
    );
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let descriptors = &descriptors;
            let next = &next;
            let inspections = &inspections;
            let probe = &probe;
            scope.spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(descriptor) = descriptors.get(index) else {
                        break;
                    };
                    if descriptor.lifecycle == SessionLifecycle::Exited {
                        continue;
                    }
                    let now = Instant::now();
                    if deadline.is_some_and(|deadline| now >= deadline) {
                        break;
                    }
                    let quantum_deadline = now.checked_add(SESSION_PROBE_QUANTUM);
                    let probe_deadline = match (quantum_deadline, deadline) {
                        (Some(quantum), Some(global)) => quantum.min(global),
                        (Some(quantum), None) => quantum,
                        (None, Some(global)) => global,
                        (None, None) => break,
                    };
                    let inspection = inspection_from_observation(
                        descriptor.clone(),
                        probe(descriptor, probe_deadline).into_optional_observation(),
                    );
                    inspections
                        .lock()
                        .expect("session inspection results poisoned")[index] = inspection;
                }
            });
        }
    });
    inspections
        .into_inner()
        .expect("session inspection results poisoned")
}

fn classify_probe_error(error: &ClientError) -> SessionProbeStatus {
    match error.code() {
        "hmux_protocol_version_unsupported"
        | "hmux_capability_missing"
        | "hmux_capability_unsupported" => SessionProbeStatus::IncompatibleProtocol,
        // A listener at the recorded address is not the recorded Host when
        // its complete fence or OS process generation differs. Keep this
        // distinct from a silent/broken transport so callers can refuse PID
        // reuse and socket replacement deterministically.
        "hmux_identity_mismatch" | "hmux_manifest_process_mismatch" => {
            SessionProbeStatus::GenerationChanged
        }
        _ => SessionProbeStatus::StaleTransport,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryPolicyInput {
    PlainShell {
        verified_recipe: bool,
        replays_explicit_command: bool,
        confirmed: bool,
    },
    ManagedProvider {
        resume_identity_present: bool,
        adapter_supports_exact_resume: bool,
        confirmed: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryDecision {
    RestorePlainShell {
        requires_confirmation: bool,
    },
    ReplaceManagedProvider,
    Refused {
        reason: &'static str,
        requires_confirmation: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StandaloneUpgradePolicyInput {
    pub verified_recipe: bool,
    pub source_healthy: bool,
    pub target_build_differs: bool,
    pub confirmed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StandaloneUpgradeDecision {
    AlreadyCurrent,
    Rehost,
    Refused {
        reason: &'static str,
        requires_confirmation: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LegacyAdoptionPolicyInput {
    pub source_binding_exact: bool,
    pub source_process_verified: bool,
    pub resume_identity_exact: bool,
    pub adapter_supports_exact_resume: bool,
    pub confirmed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LegacyAdoptionDecision {
    Adopt,
    Refused {
        reason: &'static str,
        requires_confirmation: bool,
    },
}

/// Decide whether a legacy provider may be stopped and resumed under a
/// managed Host. Provider adapters own the evidence; this policy only accepts
/// exact, process-fenced facts and never infers a "latest" conversation.
#[must_use]
pub fn evaluate_legacy_adoption_policy(input: LegacyAdoptionPolicyInput) -> LegacyAdoptionDecision {
    if !input.source_binding_exact {
        return LegacyAdoptionDecision::Refused {
            reason: "legacy_adoption_source_mismatch",
            requires_confirmation: false,
        };
    }
    if !input.source_process_verified {
        return LegacyAdoptionDecision::Refused {
            reason: "legacy_adoption_process_unverified",
            requires_confirmation: false,
        };
    }
    if !input.resume_identity_exact {
        return LegacyAdoptionDecision::Refused {
            reason: "conversation_identity_required",
            requires_confirmation: false,
        };
    }
    if !input.adapter_supports_exact_resume {
        return LegacyAdoptionDecision::Refused {
            reason: "explicit_resume_unsupported",
            requires_confirmation: false,
        };
    }
    if !input.confirmed {
        return LegacyAdoptionDecision::Refused {
            reason: "legacy_adoption_requires_confirmation",
            requires_confirmation: true,
        };
    }
    LegacyAdoptionDecision::Adopt
}

/// Decide whether a live standalone session may be rehosted.
///
/// The policy is deliberately provider-neutral. Recipe producers are
/// responsible for recording an exact command; higher-level provider adapters
/// may impose stricter resume-identity checks before requesting this operation.
#[must_use]
pub fn evaluate_standalone_upgrade_policy(
    input: StandaloneUpgradePolicyInput,
) -> StandaloneUpgradeDecision {
    if !input.verified_recipe {
        return StandaloneUpgradeDecision::Refused {
            reason: "verified_resurrection_recipe_required",
            requires_confirmation: false,
        };
    }
    if !input.source_healthy {
        return StandaloneUpgradeDecision::Refused {
            reason: "upgrade_source_unhealthy",
            requires_confirmation: false,
        };
    }
    if !input.target_build_differs {
        return StandaloneUpgradeDecision::AlreadyCurrent;
    }
    if !input.confirmed {
        return StandaloneUpgradeDecision::Refused {
            reason: "upgrade_restart_requires_confirmation",
            requires_confirmation: true,
        };
    }
    StandaloneUpgradeDecision::Rehost
}

#[must_use]
pub fn evaluate_recovery_policy(input: RecoveryPolicyInput) -> RecoveryDecision {
    match input {
        RecoveryPolicyInput::PlainShell {
            verified_recipe: false,
            ..
        } => RecoveryDecision::Refused {
            reason: "verified_resurrection_recipe_required",
            requires_confirmation: false,
        },
        RecoveryPolicyInput::PlainShell {
            verified_recipe: true,
            replays_explicit_command: true,
            confirmed: false,
        } => RecoveryDecision::Refused {
            reason: "update_requires_confirmation",
            requires_confirmation: true,
        },
        RecoveryPolicyInput::PlainShell {
            replays_explicit_command,
            ..
        } => RecoveryDecision::RestorePlainShell {
            requires_confirmation: replays_explicit_command,
        },
        RecoveryPolicyInput::ManagedProvider {
            resume_identity_present: false,
            ..
        } => RecoveryDecision::Refused {
            reason: "conversation_identity_required",
            requires_confirmation: false,
        },
        RecoveryPolicyInput::ManagedProvider {
            adapter_supports_exact_resume: false,
            ..
        }
        | RecoveryPolicyInput::ManagedProvider {
            confirmed: false, ..
        } => RecoveryDecision::Refused {
            reason: "update_requires_confirmation",
            requires_confirmation: true,
        },
        RecoveryPolicyInput::ManagedProvider { .. } => RecoveryDecision::ReplaceManagedProvider,
    }
}

#[cfg(test)]
mod tests {
    mod inspection_projection;

    use super::*;
    use crate::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor,
        ProtocolVersion as ClientProtocolVersion, SessionClass as ClientSessionClass,
        VersionRange as ClientVersionRange,
    };
    #[cfg(all(unix, feature = "local-runtime"))]
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
        LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
    };
    #[cfg(all(unix, feature = "local-runtime"))]
    use hmux_session_protocol::{
        FrameBody, FrameCodec, FrameLimits, PROTOCOL_V1, ProcessProof, RuntimeContext, VersionRange,
    };
    #[cfg(all(unix, feature = "local-runtime"))]
    use std::io::{Read, Write};
    #[cfg(all(unix, feature = "local-runtime"))]
    use std::os::unix::net::UnixListener;
    #[cfg(all(unix, feature = "local-runtime"))]
    use std::sync::mpsc;
    #[cfg(all(unix, feature = "local-runtime"))]
    use std::thread;
    #[cfg(all(unix, feature = "local-runtime"))]
    use std::time::Duration;
    #[cfg(all(unix, feature = "local-runtime"))]
    use tempfile::TempDir;

    fn ready_descriptor(index: usize) -> SessionDescriptor {
        SessionDescriptor {
            launch_program: None,
            schema_version: 1,
            session_id: format!("session-{index:03}"),
            session_name: Some(format!("session-{index:03}")),
            workspace_id: "workspace".into(),
            session_class: ClientSessionClass::Standalone,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "fixture".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: format!("host-{index:03}"),
            terminal_epoch: format!("terminal-{index:03}"),
            output_seq: "0".into(),
            host_build_version: "test".into(),
            supported_protocol: ClientVersionRange {
                minimum: ClientProtocolVersion { major: 1, minor: 0 },
                maximum: ClientProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec![],
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "host".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "provider".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: format!("/unreachable/session-{index:03}.sock"),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn exact_batch_probes_the_selected_catalog_tail_without_touching_slow_prefixes() {
        let catalog = (0..128).map(ready_descriptor).collect::<Vec<_>>();
        let target = SessionSelector::new("session-127", Some("workspace".into()));
        let probed = Arc::new(AtomicUsize::new(0));
        let probed_by_worker = Arc::clone(&probed);
        let started = Instant::now();

        let results = inspect_local_sessions_exact_with_probe(
            vec![target],
            8,
            Duration::from_millis(100),
            move |selector| {
                catalog
                    .iter()
                    .find(|descriptor| {
                        descriptor.session_id == selector.session_id
                            && selector.workspace_id.as_deref()
                                == Some(descriptor.workspace_id.as_str())
                    })
                    .cloned()
                    .ok_or_else(|| ClientError::SessionNotFound {
                        session_id: selector.session_id.clone(),
                        workspace_id: selector.workspace_id.clone(),
                    })
            },
            move |descriptor, _deadline| {
                probed_by_worker.fetch_add(1, Ordering::Relaxed);
                if descriptor.session_id != "session-127" {
                    std::thread::sleep(Duration::from_secs(1));
                }
                Some(SessionProbeStatus::Healthy.into())
            },
        )
        .unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(probed.load(Ordering::Relaxed), 1);
        let ExactSessionProbeResult::Inspection(inspection) = &results[0] else {
            panic!("selected exact target was not inspected")
        };
        assert_eq!(inspection.session_id, "session-127");
        assert_eq!(inspection.health, SessionHealth::Healthy);
    }

    #[test]
    fn exact_batch_rejects_ambiguous_or_unbounded_target_sets() {
        let duplicate = SessionSelector::new("session-1", Some("workspace-1".into()));
        assert!(matches!(
            validate_exact_probe_targets(&[duplicate.clone(), duplicate]),
            Err(ExactSessionProbeBatchError::DuplicateTarget { .. })
        ));
        assert!(matches!(
            validate_exact_probe_targets(&[SessionSelector::new("session-1", None)]),
            Err(ExactSessionProbeBatchError::ExactWorkspaceRequired { .. })
        ));
        let too_many = (0..=MAX_EXACT_SESSION_PROBE_TARGETS)
            .map(|index| SessionSelector::new(format!("session-{index}"), Some("workspace".into())))
            .collect::<Vec<_>>();
        assert!(matches!(
            validate_exact_probe_targets(&too_many),
            Err(ExactSessionProbeBatchError::TooManyTargets { .. })
        ));
    }

    #[test]
    fn exact_batch_keeps_absence_and_observation_failure_typed() {
        let selectors = vec![
            SessionSelector::new("missing", Some("workspace".into())),
            SessionSelector::new("unreadable", Some("workspace".into())),
        ];
        let results = inspect_local_sessions_exact_with_probe(
            selectors.clone(),
            8,
            Duration::from_millis(100),
            |selector| {
                if selector.session_id == "missing" {
                    Err(ClientError::SessionNotFound {
                        session_id: selector.session_id.clone(),
                        workspace_id: selector.workspace_id.clone(),
                    })
                } else {
                    Err(ClientError::InvalidDiscoveryRoot)
                }
            },
            |_descriptor, _deadline| panic!("failed lookup must not start a probe"),
        )
        .unwrap();

        assert_eq!(
            results[0],
            ExactSessionProbeResult::NotFound(selectors[0].clone())
        );
        assert_eq!(
            results[1],
            ExactSessionProbeResult::LookupFailed {
                selector: selectors[1].clone(),
                error_code: "hmux_discovery_root_invalid".into(),
            }
        );
    }

    #[test]
    fn exact_batch_caps_probe_workers_at_eight() {
        let selectors = (0..16)
            .map(|index| {
                SessionSelector::new(format!("session-{index:03}"), Some("workspace".into()))
            })
            .collect();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let active_by_worker = Arc::clone(&active);
        let maximum_by_worker = Arc::clone(&maximum);
        let results = inspect_local_sessions_exact_with_probe(
            selectors,
            64,
            Duration::from_secs(1),
            |selector| {
                let index = selector
                    .session_id
                    .strip_prefix("session-")
                    .unwrap()
                    .parse()
                    .unwrap();
                Ok(ready_descriptor(index))
            },
            move |_descriptor, _deadline| {
                let current = active_by_worker.fetch_add(1, Ordering::SeqCst) + 1;
                maximum_by_worker.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                active_by_worker.fetch_sub(1, Ordering::SeqCst);
                Some(SessionProbeStatus::Healthy.into())
            },
        )
        .unwrap();

        assert_eq!(results.len(), 16);
        assert_eq!(maximum.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn exact_batch_deadline_bounds_a_stalled_exact_lookup() {
        let selector = SessionSelector::new("session-1", Some("workspace".into()));
        let started = Instant::now();
        let results = inspect_local_sessions_exact_with_probe(
            vec![selector.clone()],
            1,
            Duration::from_millis(20),
            move |_selector| {
                std::thread::sleep(Duration::from_millis(200));
                Ok(ready_descriptor(1))
            },
            |_descriptor, _deadline| panic!("late discovery must not start a probe"),
        )
        .unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(results, vec![ExactSessionProbeResult::Unprobed(selector)]);
    }

    #[test]
    fn large_silent_catalog_respects_the_global_probe_budget() {
        let descriptors = (0..128).map(ready_descriptor).collect::<Vec<_>>();
        let started = Instant::now();
        let inspections = inspect_local_sessions_with_probe(
            descriptors,
            64,
            Duration::from_millis(550),
            |_descriptor, deadline| {
                std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
                Some(SessionProbeStatus::StaleTransport)
            },
        );
        let elapsed = started.elapsed();

        assert!(elapsed < Duration::from_millis(900), "{elapsed:?}");
        assert_eq!(inspections.len(), 128);
        assert!(
            inspections
                .iter()
                .take(8)
                .all(|inspection| inspection.health == SessionHealth::StaleTransport)
        );
        assert!(
            inspections
                .iter()
                .skip(16)
                .all(|inspection| inspection.health == SessionHealth::Unprobed)
        );
        assert_eq!(inspections[0].session_id, "session-000");
        assert_eq!(inspections[127].session_id, "session-127");
    }

    #[test]
    fn zero_budget_leaves_ready_sessions_explicitly_unprobed() {
        let inspections = inspect_local_sessions_with_probe(
            (0..3).map(ready_descriptor).collect(),
            8,
            Duration::ZERO,
            |_descriptor, _deadline| -> SessionProbeStatus {
                panic!("zero budget must not start a probe")
            },
        );

        assert!(
            inspections
                .iter()
                .all(|inspection| inspection.effective_lifecycle
                    == SessionEffectiveLifecycle::Unprobed
                    && inspection.health == SessionHealth::Unprobed
                    && inspection.probe_status().is_none())
        );
    }

    #[test]
    fn sub_quantum_budget_still_probes_ready_sessions() {
        let inspections = inspect_local_sessions_with_probe(
            (0..3).map(ready_descriptor).collect(),
            1,
            Duration::from_millis(40),
            |_descriptor, deadline| {
                assert!(deadline > Instant::now());
                Some(SessionProbeStatus::Healthy)
            },
        );

        assert!(
            inspections
                .iter()
                .any(|inspection| inspection.health == SessionHealth::Healthy)
        );
    }

    #[test]
    fn maximum_duration_does_not_overflow_the_global_deadline() {
        let inspections = inspect_local_sessions_with_probe(
            vec![ready_descriptor(0)],
            1,
            Duration::MAX,
            |_descriptor, _deadline| Some(SessionProbeStatus::Healthy),
        );

        assert_eq!(inspections[0].health, SessionHealth::Healthy);
    }

    #[test]
    fn probe_classification_distinguishes_replacement_and_outdated_capability() {
        let expected = hmux_session_protocol::SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        let mut replacement = expected.clone();
        replacement.host_instance_id = "replacement-host".into();
        let identity_error = expected.ensure_matches(&replacement).unwrap_err().into();
        assert_eq!(
            classify_probe_error(&identity_error),
            SessionProbeStatus::GenerationChanged
        );

        let process_error = ClientError::transport(
            "hmux_manifest_process_mismatch",
            "same PID belongs to another start marker",
        );
        assert_eq!(
            classify_probe_error(&process_error),
            SessionProbeStatus::GenerationChanged
        );

        let capability_error = ClientError::MissingCapability {
            capability: "screen_snapshot_profile_v1",
        };
        assert_eq!(
            classify_probe_error(&capability_error),
            SessionProbeStatus::IncompatibleProtocol
        );
    }

    #[test]
    fn bounded_probe_deadlines_remain_unprobed_instead_of_stale() {
        let status = |result| {
            bounded_probe_observation(result)
                .map(|observation: SessionProbeObservation| observation.status)
        };
        let connect_deadline = ClientError::transport(
            "hmux_attach_deadline_exceeded",
            "Hmux attach deadline elapsed during connect",
        );
        assert_eq!(status(Err(connect_deadline)), None);

        let handshake_deadline = ClientError::Io {
            operation: "wait for Hmux frame",
            source: std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "no Hmux frame arrived before the deadline",
            ),
        };
        assert_eq!(status(Err(handshake_deadline)), None);

        let write_deadline =
            ClientError::write_not_started("the bounded Hello write was refused before admission");
        assert_eq!(status(Err(write_deadline)), None);

        let closed = ClientError::transport("hmux_transport_closed", "peer closed");
        assert_eq!(
            status(Err(closed)),
            Some(SessionProbeStatus::StaleTransport)
        );
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn ready_manifest_and_live_provider_do_not_override_handshake_eof() {
        let temp = TempDir::new().unwrap();
        let discovery_path = temp.path().join("discovery");
        let socket_path = temp.path().join("stale-host.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let process_id = std::process::id();
        let root = DiscoveryRoot::create(&discovery_path).unwrap();
        let session = root
            .session(DiscoveryKey::new("workspace-1", "session-1", "runner-1", 1).unwrap())
            .unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "current-build".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: vec!["screen_snapshot".into(), "live_output".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id,
                start_marker: "live-test-process".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some("stale-fixture".into()),
            retirement_policy: None,
        };
        let lifetime_lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lifetime_lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lifetime_lock,
                ReadyManifest {
                    common,
                    provider_process: ProcessProof {
                        process_id,
                        start_marker: "live-test-process".into(),
                    },
                    terminal_epoch: "terminal-1".into(),
                    ready_output_seq: 1,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: socket_path.to_string_lossy().into_owned(),
                    },
                    capability_token: "fixture-token".into(),
                    ready_unix_ms: 3,
                },
            )
            .unwrap();

        let (hello_sender, hello_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let hello = FrameCodec::new(FrameLimits::default())
                .read_from(&mut stream)
                .unwrap();
            assert!(matches!(hello.body, FrameBody::Hello(_)));
            hello_sender.send(()).unwrap();
            // Fault injection: the manifest and both recorded PIDs remain
            // ready/live, but the transport closes before HelloAck/snapshot.
        });

        let catalog = LocalSessionCatalog::new(discovery_path);
        let ready = catalog.list().unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].lifecycle, crate::SessionLifecycle::Ready);
        assert_eq!(ready[0].host_process.process_id, process_id);
        assert_eq!(ready[0].provider_process.process_id, process_id);
        let process_id = i32::try_from(process_id).unwrap();
        // SAFETY: signal 0 only checks that this test process still exists.
        assert_eq!(unsafe { libc::kill(process_id, 0) }, 0);
        assert_eq!(
            probe_local_session(
                &catalog,
                &SessionSelector::new("session-1", Some("workspace-1".into()))
            ),
            SessionProbeStatus::StaleTransport
        );
        hello_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("probe must complete a real Hello write before the injected EOF");
        server.join().unwrap();
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    #[test]
    fn caller_budget_bounds_a_partial_handshake_exact_probe() {
        let temp = TempDir::new().unwrap();
        let discovery_path = temp.path().join("discovery");
        let socket_path = temp.path().join("silent-host.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let process_id = std::process::id();
        let root = DiscoveryRoot::create(&discovery_path).unwrap();
        let session = root
            .session(DiscoveryKey::new("workspace-1", "session-1", "runner-1", 1).unwrap())
            .unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "current-build".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: vec!["screen_snapshot".into(), "live_output".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id,
                start_marker: "live-test-process".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some("silent-fixture".into()),
            retirement_policy: None,
        };
        let lifetime_lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lifetime_lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lifetime_lock,
                ReadyManifest {
                    common,
                    provider_process: ProcessProof {
                        process_id,
                        start_marker: "live-test-process".into(),
                    },
                    terminal_epoch: "terminal-1".into(),
                    ready_output_seq: 1,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: socket_path.to_string_lossy().into_owned(),
                    },
                    capability_token: "fixture-token".into(),
                    ready_unix_ms: 3,
                },
            )
            .unwrap();

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let hello = FrameCodec::new(FrameLimits::default())
                .read_from(&mut stream)
                .unwrap();
            assert!(matches!(hello.body, FrameBody::Hello(_)));
            if let Err(error) = stream.write_all(&4096_u32.to_be_bytes()) {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ),
                    "partial-frame fixture write failed unexpectedly: {error}"
                );
                return;
            }
            if let Err(error) = stream.flush() {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ),
                    "partial-frame fixture flush failed unexpectedly: {error}"
                );
                return;
            }
            let mut byte = [0_u8; 1];
            match stream.read(&mut byte) {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ) => {}
                result => panic!("partial-frame client did not disconnect: {result:?}"),
            }
        });
        let catalog = LocalSessionCatalog::new(discovery_path);
        let started = std::time::Instant::now();

        let status = probe_local_session_with_timeout(
            &catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            Duration::from_millis(40),
        );

        assert_eq!(status, SessionProbeStatus::StaleTransport);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "probe ignored its caller budget: {:?}",
            started.elapsed()
        );
        server.join().unwrap();
    }

    #[test]
    fn recovery_requires_verified_recipe_or_exact_managed_resume() {
        assert_eq!(
            evaluate_recovery_policy(RecoveryPolicyInput::PlainShell {
                verified_recipe: false,
                replays_explicit_command: false,
                confirmed: true,
            }),
            RecoveryDecision::Refused {
                reason: "verified_resurrection_recipe_required",
                requires_confirmation: false,
            }
        );
        assert_eq!(
            evaluate_recovery_policy(RecoveryPolicyInput::ManagedProvider {
                resume_identity_present: false,
                adapter_supports_exact_resume: true,
                confirmed: true,
            }),
            RecoveryDecision::Refused {
                reason: "conversation_identity_required",
                requires_confirmation: false,
            }
        );
        assert_eq!(
            evaluate_recovery_policy(RecoveryPolicyInput::ManagedProvider {
                resume_identity_present: true,
                adapter_supports_exact_resume: true,
                confirmed: true,
            }),
            RecoveryDecision::ReplaceManagedProvider
        );
    }

    #[test]
    fn live_upgrade_requires_a_healthy_source_recipe_and_restart_confirmation() {
        assert_eq!(
            evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
                verified_recipe: false,
                source_healthy: true,
                target_build_differs: true,
                confirmed: true,
            }),
            StandaloneUpgradeDecision::Refused {
                reason: "verified_resurrection_recipe_required",
                requires_confirmation: false,
            }
        );
        assert_eq!(
            evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
                verified_recipe: true,
                source_healthy: false,
                target_build_differs: true,
                confirmed: true,
            }),
            StandaloneUpgradeDecision::Refused {
                reason: "upgrade_source_unhealthy",
                requires_confirmation: false,
            }
        );
        assert_eq!(
            evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
                verified_recipe: true,
                source_healthy: true,
                target_build_differs: true,
                confirmed: false,
            }),
            StandaloneUpgradeDecision::Refused {
                reason: "upgrade_restart_requires_confirmation",
                requires_confirmation: true,
            }
        );
        assert_eq!(
            evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
                verified_recipe: true,
                source_healthy: true,
                target_build_differs: false,
                confirmed: false,
            }),
            StandaloneUpgradeDecision::AlreadyCurrent
        );
        assert_eq!(
            evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
                verified_recipe: true,
                source_healthy: true,
                target_build_differs: true,
                confirmed: true,
            }),
            StandaloneUpgradeDecision::Rehost
        );
    }

    #[test]
    fn legacy_adoption_requires_exact_process_bound_resume_and_confirmation() {
        let allowed = LegacyAdoptionPolicyInput {
            source_binding_exact: true,
            source_process_verified: true,
            resume_identity_exact: true,
            adapter_supports_exact_resume: true,
            confirmed: true,
        };
        assert_eq!(
            evaluate_legacy_adoption_policy(LegacyAdoptionPolicyInput {
                resume_identity_exact: false,
                ..allowed
            }),
            LegacyAdoptionDecision::Refused {
                reason: "conversation_identity_required",
                requires_confirmation: false,
            }
        );
        assert_eq!(
            evaluate_legacy_adoption_policy(LegacyAdoptionPolicyInput {
                confirmed: false,
                ..allowed
            }),
            LegacyAdoptionDecision::Refused {
                reason: "legacy_adoption_requires_confirmation",
                requires_confirmation: true,
            }
        );
        assert_eq!(
            evaluate_legacy_adoption_policy(allowed),
            LegacyAdoptionDecision::Adopt
        );
    }
}
