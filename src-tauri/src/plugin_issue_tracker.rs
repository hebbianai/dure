use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

use hmux_client::TerminalEnvironment;
use dure_app::{
    ContributionIdV2,
    ISSUE_TRACKER_QUERY_LIMIT_V1,
    IssueTrackerAgentBindingSourceV1, IssueTrackerAgentBindingV1, IssueTrackerCountsV1,
    IssueTrackerIssueDetailV1, IssueTrackerIssueIdV1, IssueTrackerIssueSummaryV1,
    IssueTrackerOperationV1, IssueTrackerProviderV1, IssueTrackerQueryResultV1,
    IssueTrackerQueryV1, IssueTrackerWatchEventV1, IssueTrackerWatchSnapshotV1,
    IssueTrackerWatchStateV1, IssueTrackerWatchSubscriptionV1, PermissionKindIdV2, PluginIdV2,
    PluginPermissionPlanV2,
};
use hebbian_bounded_process::{CommandFailure, CommandSpec};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::plugin_permission_commands::DurePluginPermissionRuntime;
use crate::plugin_permissions::{
    PluginPermissionExecutionRequest, PluginPermissionStoreError,
    ResolvedPluginPermissionTarget,
};

/// The GitHub backend: `gh` argv and `gh --json` parsing, pure and fixture
/// tested. Process execution stays with the host module.
mod github;

#[cfg(test)]
const BUNDLED_BEADS_PLUGIN_ID: &str = "dure.beads";
#[cfg(test)]
const BUNDLED_BEADS_CONTRIBUTION_ID: &str = "dure.beads.issue-tracker";
#[cfg(test)]
const BUNDLED_GITHUB_PLUGIN_ID: &str = "dure.github";
#[cfg(test)]
const BUNDLED_GITHUB_CONTRIBUTION_ID: &str = "dure.github.issue-tracker";
const ISSUE_TRACKER_EVENT: &str = "dure://plugin/issue-tracker";
const ISSUE_TRACKER_ACTIVATION_EVENT: &str = "dure://plugin/issue-tracker-activation";
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
const QUERY_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const MAX_GIT_POINTER_BYTES: u64 = 4 * 1024;
const MAX_WORKSPACE_ROOT_BYTES: usize = 4_096;
const MAX_WORKSPACE_KEY_BYTES: usize = 512;
const MAX_SUBSCRIBER_ID_BYTES: usize = 128;
const MAX_SUBSCRIBER_EPOCH: u64 = 9_007_199_254_740_991;
const MAX_WATCHERS: usize = 32;
const MAX_SUBSCRIBERS_PER_WORKSPACE: usize = 64;
const MAX_AGENT_CLAIM_POLICIES: usize = 1_024;
const AGENT_CLAIM_FENCE_TIMEOUT: Duration = Duration::from_secs(65);
const MAX_TITLE_BYTES: usize = 4_096;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_SHORT_FIELD_BYTES: usize = 256;
const MAX_SCM_BRANCH_BYTES: usize = 512;
const MIN_WATCH_INTERVAL_SECONDS: u64 = 5;
const MAX_WATCH_INTERVAL_SECONDS: u64 = 300;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IssueTrackerError {
    InvalidRequest,
    AgentClaimPolicyRequired,
    ActivationRequired,
    PermissionRequired,
    UnsupportedPlugin,
    UnsupportedOperation,
    WorkspaceUnavailable,
    WorkspaceIsSymlink,
    WorkspaceHasNoBeads,
    WorkspaceHasNoGithubRemote,
    GithubAuthRequired,
    ExecutableUnavailable,
    ExecutableInsideWorkspace,
    EmbeddedEngine,
    CommandFailed,
    CommandTimedOut,
    OutputTooLarge,
    InvalidOutput,
    ResourceLimit,
    WatcherUnavailable,
}

impl IssueTrackerError {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::AgentClaimPolicyRequired => "agent_claim_policy_required",
            Self::ActivationRequired => "activation_required",
            Self::PermissionRequired => "permission_required",
            Self::UnsupportedPlugin => "unsupported_plugin",
            Self::UnsupportedOperation => "unsupported_operation",
            Self::WorkspaceUnavailable => "workspace_unavailable",
            Self::WorkspaceIsSymlink => "workspace_is_symlink",
            Self::WorkspaceHasNoBeads => "workspace_has_no_beads",
            Self::WorkspaceHasNoGithubRemote => "workspace_has_no_github_remote",
            Self::GithubAuthRequired => "github_auth_required",
            Self::ExecutableUnavailable => "executable_unavailable",
            Self::ExecutableInsideWorkspace => "executable_inside_workspace",
            Self::EmbeddedEngine => "embedded_engine",
            Self::CommandFailed => "command_failed",
            Self::CommandTimedOut => "command_timed_out",
            Self::OutputTooLarge => "output_too_large",
            Self::InvalidOutput => "invalid_output",
            Self::ResourceLimit => "resource_limit",
            Self::WatcherUnavailable => "watcher_unavailable",
        }
    }

    fn public(self) -> String {
        format!("issue_tracker_{}", self.code())
    }
}

impl From<PluginPermissionStoreError> for IssueTrackerError {
    fn from(_error: PluginPermissionStoreError) -> Self {
        Self::PermissionRequired
    }
}

#[derive(Debug, Deserialize)]
pub struct DureIssueTrackerQueryRequest {
    plugin_id: String,
    contribution_id: String,
    workspace_root: String,
    #[serde(default)]
    agent_claim_policy_epoch: Option<u32>,
    query: IssueTrackerQueryV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DureIssueTrackerActivationRequest {
    plugin_id: String,
    contribution_id: String,
    workspace_root: String,
}

#[derive(Clone, Debug, Serialize)]
struct DureIssueTrackerActivationEvent {
    plugin_id: String,
    contribution_id: String,
    workspace_root: String,
    active: bool,
}

fn emit_activation_state(
    app: &AppHandle,
    plugin_id: &str,
    contribution_id: &str,
    workspace_root: &str,
    active: bool,
) {
    let _ = app.emit(
        ISSUE_TRACKER_ACTIVATION_EVENT,
        DureIssueTrackerActivationEvent {
            plugin_id: plugin_id.to_owned(),
            contribution_id: contribution_id.to_owned(),
            workspace_root: workspace_root.to_owned(),
            active,
        },
    );
}

#[derive(Debug, Deserialize)]
pub struct DureIssueTrackerWatchSubscribeRequest {
    plugin_id: String,
    contribution_id: String,
    workspace_key: String,
    workspace_root: String,
    subscriber_id: String,
    #[serde(default)]
    subscriber_epoch: u64,
    interval_seconds: u64,
    #[serde(default)]
    include_agent_claims: bool,
    #[serde(default)]
    agent_claim_policy_epoch: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct DureIssueTrackerWatchUnsubscribeRequest {
    plugin_id: String,
    contribution_id: String,
    workspace_root: String,
    subscriber_id: String,
    #[serde(default)]
    subscriber_epoch: u64,
    #[serde(default)]
    generation: Option<u32>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct WatcherIdentity {
    plugin_id: String,
    contribution_id: String,
    workspace_root: PathBuf,
}

/// Which host-implemented backend a bundled provider declaration names. The
/// provider id is an open stable string in the contract; the host recognises
/// exactly these two and fails closed on anything else.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderBackend {
    Beads,
    Github,
}

impl ProviderBackend {
    fn from_provider(provider: &IssueTrackerProviderV1) -> Result<Self, IssueTrackerError> {
        match provider.provider.as_str() {
            "beads" => Ok(Self::Beads),
            "github" => Ok(Self::Github),
            _ => Err(IssueTrackerError::UnsupportedPlugin),
        }
    }

    fn executable_name(self) -> &'static str {
        match self {
            Self::Beads => "bd",
            Self::Github => "gh",
        }
    }
}

/// The workspace fact an activation is bound to. It is re-read from the
/// filesystem at every use so a workspace re-pointed at another tracker (or
/// another repository) cannot keep an old activation alive. Both variants
/// are cheap filesystem lookups: GitHub-ness itself (`gh repo view`) is
/// established once at activation, not per query.
#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderBinding {
    Beads { beads_directory: PathBuf },
    Github { git_common_directory: PathBuf },
}

impl ProviderBinding {
    fn backend(&self) -> ProviderBackend {
        match self {
            Self::Beads { .. } => ProviderBackend::Beads,
            Self::Github { .. } => ProviderBackend::Github,
        }
    }

    /// The directory whose owner may not also own the executable: a tracker
    /// or repository must not ship the binary that reads it.
    fn authority_directory(&self) -> &Path {
        match self {
            Self::Beads { beads_directory } => beads_directory,
            Self::Github {
                git_common_directory,
            } => git_common_directory,
        }
    }
}

#[derive(Clone, Debug)]
struct ActivatedProvider {
    executable: PathBuf,
    environment: Arc<BTreeMap<String, String>>,
    binding: ProviderBinding,
    /// `host/owner/name` the GitHub backend saw at activation; every later
    /// `gh` command is pinned to it. `None` for Beads.
    repository: Option<String>,
    activation_epoch: u64,
}

enum QueryExecutionAttempt {
    Failed(IssueTrackerError),
    MissingActivation {
        identity: WatcherIdentity,
    },
    MismatchedActivation {
        identity: WatcherIdentity,
        activation_epoch: u64,
    },
    Ran {
        identity: WatcherIdentity,
        activation_epoch: u64,
        result: Result<IssueTrackerQueryResultV1, IssueTrackerError>,
        claim_execution_guard: Option<AgentClaimExecutionGuard>,
    },
}

enum QueryAttemptPublication {
    Retry,
    Complete(Result<IssueTrackerQueryResultV1, IssueTrackerError>),
}

enum WatchSubscriptionPreparation {
    Failed(IssueTrackerError),
    MissingActivation {
        identity: WatcherIdentity,
    },
    MismatchedActivation {
        identity: WatcherIdentity,
        activation_epoch: u64,
    },
    Ready {
        identity: WatcherIdentity,
        root: PathBuf,
        binding: ProviderBinding,
    },
}

impl ActivatedProvider {
    fn same_configuration(&self, other: &Self) -> bool {
        self.executable == other.executable
            && self.environment == other.environment
            && self.binding == other.binding
            && self.repository == other.repository
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Subscriber {
    window_label: String,
    subscriber_id: String,
    subscriber_epoch: u64,
    include_agent_claims: bool,
    agent_claim_policy_epoch: Option<u32>,
}

impl Subscriber {
    fn same_lease(&self, other: &Self) -> bool {
        self.window_label == other.window_label && self.subscriber_id == other.subscriber_id
    }
}

struct UnsubscribeTarget<'a> {
    plugin_id: &'a str,
    contribution_id: &'a str,
    resolved_root: Option<&'a Path>,
}

type AgentClaimPolicyEpochs = BTreeMap<String, u32>;
type AgentClaimPolicyPersistenceResult<T> =
    Result<(AgentClaimPolicyEpochs, T), (String, AgentClaimPolicyEpochs)>;

#[derive(Debug)]
struct WatcherControl {
    stop: bool,
    interval: Duration,
    revision: u32,
    latest: Option<IssueTrackerWatchEventV1>,
    activated: Option<ActivatedProvider>,
}

type SharedSubscribers = Arc<Mutex<BTreeSet<Subscriber>>>;
type SharedWatcherControl = Arc<(Mutex<WatcherControl>, Condvar)>;
const WATCHER_RETRY_BACKOFF: Duration = Duration::from_millis(50);

#[derive(Debug)]
struct AgentClaimExecutionFence {
    state: Mutex<AgentClaimExecutionFenceState>,
    changed: Condvar,
}

#[derive(Debug)]
struct AgentClaimExecutionFenceState {
    accepting: bool,
    in_flight: usize,
}

impl Default for AgentClaimExecutionFence {
    fn default() -> Self {
        Self {
            state: Mutex::new(AgentClaimExecutionFenceState {
                accepting: true,
                in_flight: 0,
            }),
            changed: Condvar::new(),
        }
    }
}

impl AgentClaimExecutionFence {
    fn begin(self: &Arc<Self>) -> Result<AgentClaimExecutionGuard, IssueTrackerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        if !state.accepting {
            return Err(IssueTrackerError::AgentClaimPolicyRequired);
        }
        state.in_flight = state
            .in_flight
            .checked_add(1)
            .ok_or(IssueTrackerError::ResourceLimit)?;
        Ok(AgentClaimExecutionGuard {
            fence: Arc::clone(self),
        })
    }

    fn is_idle(&self) -> Result<bool, IssueTrackerError> {
        self.state
            .lock()
            .map(|state| state.in_flight == 0)
            .map_err(|_| IssueTrackerError::WatcherUnavailable)
    }

    fn pause(&self) -> Result<(), IssueTrackerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        state.accepting = false;
        Ok(())
    }

    fn resume(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.accepting = true;
        self.changed.notify_all();
    }

    fn wait_until_idle(&self, timeout: Duration) -> Result<(), IssueTrackerError> {
        let state = self
            .state
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let (state, wait_result) = self
            .changed
            .wait_timeout_while(state, timeout, |state| state.in_flight > 0)
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        if wait_result.timed_out() && state.in_flight > 0 {
            return Err(IssueTrackerError::CommandTimedOut);
        }
        Ok(())
    }
}

struct AgentClaimExecutionGuard {
    fence: Arc<AgentClaimExecutionFence>,
}

impl Drop for AgentClaimExecutionGuard {
    fn drop(&mut self) {
        let mut state = self
            .fence
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight = state.in_flight.saturating_sub(1);
        self.fence.changed.notify_all();
    }
}

fn subscribers_include_agent_claims(subscribers: &BTreeSet<Subscriber>) -> bool {
    subscribers
        .iter()
        .any(|subscriber| subscriber.include_agent_claims)
}

fn subscribers_agent_claim_policy_epoch(subscribers: &BTreeSet<Subscriber>) -> Option<u32> {
    subscribers
        .iter()
        .find(|subscriber| subscriber.include_agent_claims)
        .and_then(|subscriber| subscriber.agent_claim_policy_epoch)
}

fn watch_event_matches_claim_projection(
    event: &IssueTrackerWatchEventV1,
    include_agent_claims: bool,
) -> bool {
    match &event.state {
        IssueTrackerWatchStateV1::Snapshot { snapshot, .. } => {
            snapshot.agent_claim_issues.is_some() == include_agent_claims
        }
        IssueTrackerWatchStateV1::Unavailable { .. } => true,
    }
}

#[derive(Debug, Eq, PartialEq)]
enum WatcherPublicationOutcome {
    Published,
    Retry,
    PermissionRevoked,
    Stop,
}

fn watcher_publication_outcome(
    publication: Result<bool, IssueTrackerError>,
) -> WatcherPublicationOutcome {
    match publication {
        Ok(true) => WatcherPublicationOutcome::Published,
        Ok(false) | Err(IssueTrackerError::AgentClaimPolicyRequired) => {
            WatcherPublicationOutcome::Retry
        }
        Err(IssueTrackerError::PermissionRequired) => {
            WatcherPublicationOutcome::PermissionRevoked
        }
        Err(_) => WatcherPublicationOutcome::Stop,
    }
}

fn wait_for_watcher_retry(control: &SharedWatcherControl, timeout: Duration) -> bool {
    let (control_mutex, changed) = &**control;
    let Ok(control_guard) = control_mutex.lock() else {
        return false;
    };
    if control_guard.stop {
        return false;
    }
    let Ok((control_guard, _)) = changed.wait_timeout(control_guard, timeout) else {
        return false;
    };
    !control_guard.stop
}

struct WorkspaceWatcherLaunch {
    app: AppHandle,
    permission_target: ResolvedPluginPermissionTarget,
    permission_plan: PluginPermissionPlanV2,
    plugin_id: String,
    contribution_id: String,
    workspace_key: String,
    workspace_root: String,
    root: PathBuf,
    generation: u32,
    subscribers: SharedSubscribers,
    control: SharedWatcherControl,
}

struct WatcherLease {
    workspace_key: String,
    generation: u32,
    subscribers: SharedSubscribers,
    control: SharedWatcherControl,
    handle: JoinHandle<()>,
}

#[derive(Clone, Debug)]
struct AgentClaimPolicy {
    enabled: bool,
    epoch: u32,
    execution_fence: Arc<AgentClaimExecutionFence>,
}

struct PausedAgentClaimFences(Vec<Arc<AgentClaimExecutionFence>>);

impl Drop for PausedAgentClaimFences {
    fn drop(&mut self) {
        for fence in &self.0 {
            fence.resume();
        }
    }
}

fn signal_watcher_stop(lease: WatcherLease) -> JoinHandle<()> {
    let (control, changed) = &*lease.control;
    let mut control = control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    control.stop = true;
    changed.notify_one();
    drop(control);
    lease.handle
}

#[derive(Default)]
struct WatcherRuntime {
    watchers: BTreeMap<WatcherIdentity, WatcherLease>,
    /// Persisted settings and their ABA-safe epochs are authoritative over
    /// renderer leases. Inactive entries may be evicted at the bounded cap;
    /// a fresh settings read then issues a new epoch before subscribing.
    agent_claim_policies: BTreeMap<WatcherIdentity, AgentClaimPolicy>,
    last_agent_claim_policy_epoch: u32,
    /// Stopped workers remain accounted for until their bounded command exits.
    /// This keeps renderer cleanup non-blocking without allowing subscription
    /// churn to create an unbounded set of detached processes.
    retired_workers: Vec<JoinHandle<()>>,
    /// Logical watcher incarnations never reuse a generation during one app
    /// process, even after the previous identity has been fully retired.
    last_generation: u32,
}

#[derive(Default)]
struct ActivationRuntime {
    providers: BTreeMap<WatcherIdentity, ActivatedProvider>,
    last_epoch: u64,
}

#[derive(Default)]
pub struct DureIssueTrackerState {
    runtime: Mutex<WatcherRuntime>,
    activations: Mutex<ActivationRuntime>,
}

impl DureIssueTrackerState {
    fn reap_retired_workers(runtime: &mut WatcherRuntime) -> usize {
        let mut pending = Vec::with_capacity(runtime.retired_workers.len());
        for handle in std::mem::take(&mut runtime.retired_workers) {
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                pending.push(handle);
            }
        }
        runtime.retired_workers = pending;
        runtime.retired_workers.len()
    }

    fn retire_watcher(runtime: &mut WatcherRuntime, lease: WatcherLease) {
        let handle = signal_watcher_stop(lease);
        runtime.retired_workers.push(handle);
    }

    fn is_activated(
        &self,
        identity: &WatcherIdentity,
        binding: &ProviderBinding,
    ) -> Result<bool, IssueTrackerError> {
        self.activations
            .lock()
            .map(|activations| {
                activations
                    .providers
                    .get(identity)
                    .is_some_and(|activated| activated.binding == *binding)
            })
            .map_err(|_| IssueTrackerError::WatcherUnavailable)
    }

    fn activated_provider(
        &self,
        identity: &WatcherIdentity,
    ) -> Result<Option<ActivatedProvider>, IssueTrackerError> {
        self.activations
            .lock()
            .map(|activations| activations.providers.get(identity).cloned())
            .map_err(|_| IssueTrackerError::WatcherUnavailable)
    }

    fn activation_epoch_is_current(
        &self,
        identity: &WatcherIdentity,
        activation_epoch: u64,
    ) -> Result<bool, IssueTrackerError> {
        self.activations
            .lock()
            .map(|activations| {
                activations
                    .providers
                    .get(identity)
                    .is_some_and(|activated| activated.activation_epoch == activation_epoch)
            })
            .map_err(|_| IssueTrackerError::WatcherUnavailable)
    }

    fn emit_inactive_if_current(
        &self,
        app: &AppHandle,
        identity: &WatcherIdentity,
        expected_epoch: Option<u64>,
        plugin_id: &str,
        contribution_id: &str,
        workspace_root: &str,
    ) -> Result<bool, IssueTrackerError> {
        // Keep the epoch check and event ordering atomic with activate(),
        // which takes the same runtime -> activations locks. A newer true
        // event can follow this false event, never be overtaken by it.
        let _runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let activations = self
            .activations
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let current_epoch = activations
            .providers
            .get(identity)
            .map(|activated| activated.activation_epoch);
        if current_epoch != expected_epoch {
            return Ok(false);
        }
        emit_activation_state(
            app,
            plugin_id,
            contribution_id,
            workspace_root,
            false,
        );
        Ok(true)
    }

    fn activate(
        &self,
        identity: WatcherIdentity,
        mut provider: ActivatedProvider,
    ) -> Result<bool, IssueTrackerError> {
        // Activation and watcher refresh share one lock order. A subscriber
        // that is concurrently creating a worker either captures this epoch
        // or finishes first and is refreshed below; it cannot install an old
        // provider after activation returns.
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let mut activations = self
            .activations
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        if activations
            .providers
            .get(&identity)
            .is_some_and(|current| current.same_configuration(&provider))
        {
            return Ok(false);
        }
        let watcher_control = runtime
            .watchers
            .get(&identity)
            .map(|watcher| Arc::clone(&watcher.control));
        let mut watcher_guard = watcher_control
            .as_ref()
            .map(|control| {
                control
                    .0
                    .lock()
                    .map_err(|_| IssueTrackerError::WatcherUnavailable)
            })
            .transpose()?;
        let activation_epoch = activations
            .last_epoch
            .checked_add(1)
            .ok_or(IssueTrackerError::ResourceLimit)?;
        activations.last_epoch = activation_epoch;
        provider.activation_epoch = activation_epoch;
        let changed = activations
            .providers
            .insert(identity.clone(), provider.clone())
            .is_none();
        if let Some(control) = watcher_guard.as_mut() {
            control.activated = Some(provider);
            // A late subscriber must never receive a cached snapshot or
            // activation error produced by the previous epoch. The next poll
            // retains this logical lease's generation/revision and publishes
            // an authoritative replacement.
            control.latest = None;
        }
        if let Some(control) = watcher_control.as_ref() {
            control.1.notify_one();
        }
        Ok(changed)
    }

    fn subscribe_with<F>(
        &self,
        identity: WatcherIdentity,
        workspace_key: String,
        mut subscriber: Subscriber,
        interval: Duration,
        start_worker: F,
    ) -> Result<IssueTrackerWatchSubscriptionV1, IssueTrackerError>
    where
        F: FnOnce(
            u32,
            SharedSubscribers,
            SharedWatcherControl,
        ) -> Result<JoinHandle<()>, IssueTrackerError>,
    {
        validate_bounded_key(&workspace_key, MAX_WORKSPACE_KEY_BYTES)?;
        validate_bounded_key(&subscriber.window_label, MAX_SUBSCRIBER_ID_BYTES)?;
        validate_bounded_key(&subscriber.subscriber_id, MAX_SUBSCRIBER_ID_BYTES)?;
        validate_subscriber_epoch(subscriber.subscriber_epoch)?;
        if interval.as_secs() < MIN_WATCH_INTERVAL_SECONDS
            || interval.as_secs() > MAX_WATCH_INTERVAL_SECONDS
        {
            return Err(IssueTrackerError::InvalidRequest);
        }

        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let retired_count = Self::reap_retired_workers(&mut runtime);
        subscriber.agent_claim_policy_epoch = subscriber
            .include_agent_claims
            .then_some(subscriber.agent_claim_policy_epoch)
            .flatten()
            .filter(|epoch| {
                runtime
                    .agent_claim_policies
                    .get(&identity)
                    .is_some_and(|policy| policy.enabled && *epoch == policy.epoch)
            });
        subscriber.include_agent_claims = subscriber.agent_claim_policy_epoch.is_some();

        if let Some(existing) = runtime.watchers.get_mut(&identity) {
            if existing.workspace_key != workspace_key {
                return Err(IssueTrackerError::InvalidRequest);
            }
            if !existing.handle.is_finished() {
                let mut subscribers = existing
                    .subscribers
                    .lock()
                    .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
                let existing_subscriber = subscribers
                    .iter()
                    .find(|candidate| candidate.same_lease(&subscriber))
                    .cloned();
                if existing_subscriber
                    .as_ref()
                    .is_some_and(|current| {
                        subscriber.subscriber_epoch <= current.subscriber_epoch
                    })
                {
                    drop(subscribers);
                    let latest = existing
                        .control
                        .0
                        .lock()
                        .map_err(|_| IssueTrackerError::WatcherUnavailable)?
                        .latest
                        .clone();
                    return Ok(IssueTrackerWatchSubscriptionV1 {
                        workspace_key,
                        generation: existing.generation,
                        reused_watcher: true,
                        latest,
                    });
                }
                if existing_subscriber.is_none()
                    && subscribers.len() >= MAX_SUBSCRIBERS_PER_WORKSPACE
                {
                    return Err(IssueTrackerError::ResourceLimit);
                }
                let previously_included_claims = subscribers_include_agent_claims(&subscribers);
                if let Some(existing_subscriber) = existing_subscriber {
                    subscribers.remove(&existing_subscriber);
                }
                subscribers.insert(subscriber);
                let includes_agent_claims = subscribers_include_agent_claims(&subscribers);
                drop(subscribers);
                let (control, changed) = &*existing.control;
                let mut control = control
                    .lock()
                    .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
                control.interval = interval;
                if previously_included_claims != includes_agent_claims {
                    control.latest = None;
                }
                let latest = control.latest.clone();
                changed.notify_one();
                return Ok(IssueTrackerWatchSubscriptionV1 {
                    workspace_key,
                    generation: existing.generation,
                    reused_watcher: true,
                    latest,
                });
            }
        }

        let stale = runtime.watchers.remove(&identity);
        if stale.is_none()
            && runtime
                .watchers
                .len()
                .saturating_add(retired_count)
                >= MAX_WATCHERS
        {
            return Err(IssueTrackerError::ResourceLimit);
        }
        let (generation, subscribers, revision, latest, existing_interval, stale_handle) =
            match stale {
            Some(stale) => {
                let revision_and_latest = stale
                    .control
                    .0
                    .lock()
                    .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
                let revision = revision_and_latest.revision;
                let latest = revision_and_latest.latest.clone();
                    let existing_interval = revision_and_latest.interval;
                drop(revision_and_latest);
                (
                    // The worker is an implementation detail of one logical
                    // subscriber lease. Preserve its generation so existing
                    // subscribers can consume the replacement worker and
                    // later unsubscribe their exact lease.
                    stale.generation,
                    stale.subscribers,
                    revision,
                    latest,
                        Some(existing_interval),
                    Some(stale.handle),
                )
            }
            None => {
                let generation = runtime
                    .last_generation
                    .checked_add(1)
                    .ok_or(IssueTrackerError::ResourceLimit)?;
                runtime.last_generation = generation;
                (
                    generation,
                    Arc::new(Mutex::new(BTreeSet::new())),
                    0,
                    None,
                    None,
                        None,
                )
            }
        };
        if let Some(stale_handle) = stale_handle {
            let _ = stale_handle.join();
        }
        let (includes_agent_claims, accepted_subscriber) = {
            let mut subscribers_guard = subscribers
                .lock()
                .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
            let existing_subscriber = subscribers_guard
                .iter()
                .find(|candidate| candidate.same_lease(&subscriber))
                .cloned();
            if existing_subscriber
                .as_ref()
                .is_some_and(|current| {
                    subscriber.subscriber_epoch <= current.subscriber_epoch
                })
            {
                (
                    subscribers_include_agent_claims(&subscribers_guard),
                    false,
                )
            } else {
                if existing_subscriber.is_none()
                && subscribers_guard.len() >= MAX_SUBSCRIBERS_PER_WORKSPACE
            {
                return Err(IssueTrackerError::ResourceLimit);
            }
                if let Some(existing_subscriber) = existing_subscriber {
                    subscribers_guard.remove(&existing_subscriber);
                }
            subscribers_guard.insert(subscriber);
                (
                    subscribers_include_agent_claims(&subscribers_guard),
                    true,
                )
        }
        };
        let latest = latest.filter(|event| {
            watch_event_matches_claim_projection(event, includes_agent_claims)
        });
        let interval = if accepted_subscriber {
            interval
        } else {
            existing_interval.unwrap_or(interval)
        };
        let control = Arc::new((
            Mutex::new(WatcherControl {
                stop: false,
                interval,
                revision,
                latest: latest.clone(),
                activated: None,
            }),
            Condvar::new(),
        ));
        let handle = start_worker(generation, Arc::clone(&subscribers), Arc::clone(&control))?;
        runtime.watchers.insert(
            identity,
            WatcherLease {
                workspace_key: workspace_key.clone(),
                generation,
                subscribers,
                control,
                handle,
            },
        );
        Ok(IssueTrackerWatchSubscriptionV1 {
            workspace_key,
            generation,
            reused_watcher: false,
            latest,
        })
    }

    fn begin_agent_claim_execution(
        &self,
        identity: &WatcherIdentity,
        expected_policy_epoch: u32,
    ) -> Result<AgentClaimExecutionGuard, IssueTrackerError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let policy = runtime
            .agent_claim_policies
            .get(identity)
            .ok_or(IssueTrackerError::AgentClaimPolicyRequired)?;
        if !policy.enabled || expected_policy_epoch != policy.epoch {
            return Err(IssueTrackerError::AgentClaimPolicyRequired);
        }
        policy.execution_fence.begin()
    }

    fn begin_query_agent_claim_execution(
        &self,
        identity: &WatcherIdentity,
        query: &IssueTrackerQueryV1,
        policy_epoch: Option<u32>,
    ) -> Result<Option<AgentClaimExecutionGuard>, IssueTrackerError> {
        if !matches!(query, IssueTrackerQueryV1::AgentClaims { .. }) {
            return Ok(None);
        }
        let policy_epoch = policy_epoch.ok_or(IssueTrackerError::AgentClaimPolicyRequired)?;
        self.begin_agent_claim_execution(identity, policy_epoch)
            .map(Some)
    }

    fn execute_query_with_claim_policy<T>(
        &self,
        identity: &WatcherIdentity,
        query: &IssueTrackerQueryV1,
        policy_epoch: Option<u32>,
        execute: impl FnOnce() -> T,
    ) -> Result<(T, Option<AgentClaimExecutionGuard>), IssueTrackerError> {
        let guard =
            self.begin_query_agent_claim_execution(identity, query, policy_epoch)?;
        Ok((execute(), guard))
    }

    fn query_agent_claim_policy_is_current(
        &self,
        identity: &WatcherIdentity,
        query: &IssueTrackerQueryV1,
        policy_epoch: Option<u32>,
    ) -> Result<bool, IssueTrackerError> {
        if !matches!(query, IssueTrackerQueryV1::AgentClaims { .. }) {
            return Ok(true);
        }
        let Some(policy_epoch) = policy_epoch else {
            return Ok(false);
        };
        self.runtime
            .lock()
            .map(|runtime| {
                runtime
                    .agent_claim_policies
                    .get(identity)
                    .is_some_and(|policy| policy.enabled && policy.epoch == policy_epoch)
            })
            .map_err(|_| IssueTrackerError::WatcherUnavailable)
    }

    pub(crate) fn set_agent_claim_policy(
        &self,
        plugin_id: &str,
        contribution_id: &str,
        workspace_root: PathBuf,
        enabled: bool,
    ) -> Result<u32, String> {
        let identity = WatcherIdentity {
            plugin_id: plugin_id.to_owned(),
            contribution_id: contribution_id.to_owned(),
            workspace_root,
        };
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable.public())?;
        let current = runtime.agent_claim_policies.get(&identity).cloned();
        let policy = if current
            .as_ref()
            .is_some_and(|policy| policy.enabled == enabled)
        {
            current.expect("checked above")
        } else {
            if current.is_none() && runtime.agent_claim_policies.len() >= MAX_AGENT_CLAIM_POLICIES
            {
                let mut evicted = None;
                for (candidate, policy) in &runtime.agent_claim_policies {
                    if !runtime.watchers.contains_key(candidate)
                        && policy
                            .execution_fence
                            .is_idle()
                            .map_err(IssueTrackerError::public)?
                    {
                        evicted = Some(candidate.clone());
                        break;
                    }
                }
                let evicted =
                    evicted.ok_or_else(|| IssueTrackerError::ResourceLimit.public())?;
                runtime.agent_claim_policies.remove(&evicted);
            }
            let epoch = runtime
                .last_agent_claim_policy_epoch
                .checked_add(1)
                .ok_or_else(|| IssueTrackerError::ResourceLimit.public())?;
            runtime.last_agent_claim_policy_epoch = epoch;
            let policy = AgentClaimPolicy {
                enabled,
                epoch,
                execution_fence: current
                    .map(|policy| policy.execution_fence)
                    .unwrap_or_else(|| Arc::new(AgentClaimExecutionFence::default())),
            };
            runtime
                .agent_claim_policies
                .insert(identity.clone(), policy.clone());
            policy
        };
        if let Some(watcher) = runtime.watchers.get(&identity) {
            let mut subscribers = watcher
                .subscribers
                .lock()
                .map_err(|_| IssueTrackerError::WatcherUnavailable.public())?;
            let previously_included_claims =
                subscribers_include_agent_claims(&subscribers);
            if !enabled {
                *subscribers = subscribers
                    .iter()
                    .cloned()
                    .map(|mut subscriber| {
                        subscriber.include_agent_claims = false;
                        subscriber.agent_claim_policy_epoch = None;
                        subscriber
                    })
                    .collect();
            }
            let includes_agent_claims = subscribers_include_agent_claims(&subscribers);
            drop(subscribers);

            let control = Arc::clone(&watcher.control);
            let (control_mutex, changed) = &*control;
            let mut control_guard = control_mutex
                .lock()
                .map_err(|_| IssueTrackerError::WatcherUnavailable.public())?;
            if !enabled || previously_included_claims != includes_agent_claims {
                control_guard.latest = None;
                changed.notify_one();
            }
            drop(control_guard);
        }
        let wait_fence = (!enabled).then(|| Arc::clone(&policy.execution_fence));
        drop(runtime);

        if let Some(fence) = wait_fence {
            fence
                .wait_until_idle(AGENT_CLAIM_FENCE_TIMEOUT)
                .map_err(IssueTrackerError::public)?;
        }
        Ok(policy.epoch)
    }

    pub(crate) fn persist_agent_claim_policy_update<T>(
        &self,
        plugin_id: &str,
        workspace_root: PathBuf,
        policies: Vec<(String, bool)>,
        persist: impl FnOnce() -> Result<T, String>,
    ) -> AgentClaimPolicyPersistenceResult<T> {
        let runtime = self.runtime.lock().map_err(|_| {
            (
                IssueTrackerError::WatcherUnavailable.public(),
                BTreeMap::new(),
            )
        })?;
        let original_last_epoch = runtime.last_agent_claim_policy_epoch;
        let mut prepared_policies = runtime.agent_claim_policies.clone();
        let mut prepared_last_epoch = original_last_epoch;
        let mut previous = Vec::new();
        let mut previous_epochs = BTreeMap::new();
        let mut next_epochs = BTreeMap::new();
        let mut changed = Vec::new();
        let mut seen = BTreeSet::new();

        for (contribution_id, enabled) in policies {
            if !seen.insert(contribution_id.clone()) {
                return Err((
                    "plugin agent claim policy update contains a duplicate contribution".into(),
                    previous_epochs,
                ));
            }
            let identity = WatcherIdentity {
                plugin_id: plugin_id.to_owned(),
                contribution_id: contribution_id.clone(),
                workspace_root: workspace_root.clone(),
            };
            let current = runtime.agent_claim_policies.get(&identity).cloned();
            if let Some(current) = &current {
                previous_epochs.insert(contribution_id.clone(), current.epoch);
            }
            previous.push((identity.clone(), current.clone()));
            let policy = if current
                .as_ref()
                .is_some_and(|policy| policy.enabled == enabled)
            {
                current.expect("checked above")
            } else {
                if current.is_none()
                    && !prepared_policies.contains_key(&identity)
                    && prepared_policies.len() >= MAX_AGENT_CLAIM_POLICIES
                {
                    return Err((IssueTrackerError::ResourceLimit.public(), previous_epochs));
                }
                prepared_last_epoch = prepared_last_epoch
                    .checked_add(1)
                    .ok_or_else(|| {
                        (IssueTrackerError::ResourceLimit.public(), previous_epochs.clone())
                    })?;
                changed.push((identity.clone(), enabled));
                AgentClaimPolicy {
                    enabled,
                    epoch: prepared_last_epoch,
                    execution_fence: current
                        .map(|policy| policy.execution_fence)
                        .unwrap_or_else(|| Arc::new(AgentClaimExecutionFence::default())),
                }
            };
            next_epochs.insert(contribution_id, policy.epoch);
            prepared_policies.insert(identity, policy);
        }

        let mut paused_fences = PausedAgentClaimFences(Vec::new());
        for (identity, previous_policy) in &previous {
            let Some(previous_policy) = previous_policy else {
                continue;
            };
            let is_being_disabled = previous_policy.enabled
                && prepared_policies
                    .get(identity)
                    .is_some_and(|policy| !policy.enabled);
            if is_being_disabled {
                previous_policy
                    .execution_fence
                    .pause()
                    .map_err(|error| (error.public(), previous_epochs.clone()))?;
                paused_fences
                    .0
                    .push(Arc::clone(&previous_policy.execution_fence));
            }
        }
        drop(runtime);

        for fence in &paused_fences.0 {
            fence
                .wait_until_idle(AGENT_CLAIM_FENCE_TIMEOUT)
                .map_err(|error| (error.public(), previous_epochs.clone()))?;
        }

        let mut runtime = self.runtime.lock().map_err(|_| {
            (
                IssueTrackerError::WatcherUnavailable.public(),
                previous_epochs.clone(),
            )
        })?;
        let policies_unchanged = runtime.last_agent_claim_policy_epoch == original_last_epoch
            && previous.iter().all(|(identity, expected)| {
                let observed = runtime.agent_claim_policies.get(identity);
                match (expected, observed) {
                    (None, None) => true,
                    (Some(expected), Some(observed)) => {
                        expected.enabled == observed.enabled
                            && expected.epoch == observed.epoch
                            && Arc::ptr_eq(
                                &expected.execution_fence,
                                &observed.execution_fence,
                            )
                    }
                    _ => false,
                }
            });
        if !policies_unchanged {
            return Err((
                "plugin agent claim policy changed during persistence preparation".into(),
                previous_epochs,
            ));
        }

        for (identity, _) in &changed {
            if let Some(watcher) = runtime.watchers.get(identity) {
                drop(watcher.subscribers.lock().map_err(|_| {
                    (
                        IssueTrackerError::WatcherUnavailable.public(),
                        previous_epochs.clone(),
                    )
                })?);
                drop(watcher.control.0.lock().map_err(|_| {
                    (
                        IssueTrackerError::WatcherUnavailable.public(),
                        previous_epochs.clone(),
                    )
                })?);
            }
        }

        let persisted = persist().map_err(|error| (error, previous_epochs.clone()))?;
        runtime.agent_claim_policies = prepared_policies;
        runtime.last_agent_claim_policy_epoch = prepared_last_epoch;
        for (identity, enabled) in changed {
            let Some(watcher) = runtime.watchers.get(&identity) else {
                continue;
            };
            let mut subscribers = watcher
                .subscribers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previously_included_claims = subscribers_include_agent_claims(&subscribers);
            if !enabled {
                *subscribers = subscribers
                    .iter()
                    .cloned()
                    .map(|mut subscriber| {
                        subscriber.include_agent_claims = false;
                        subscriber.agent_claim_policy_epoch = None;
                        subscriber
                    })
                    .collect();
            }
            let includes_agent_claims = subscribers_include_agent_claims(&subscribers);
            drop(subscribers);
            if !enabled || previously_included_claims != includes_agent_claims {
                let mut control = watcher
                    .control
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                control.latest = None;
                watcher.control.1.notify_one();
            }
        }
        drop(runtime);
        drop(paused_fences);
        Ok((next_epochs, persisted))
    }

    #[cfg(test)]
    fn unsubscribe(
        &self,
        identity: &WatcherIdentity,
        window_label: &str,
        subscriber_id: &str,
        subscriber_epoch: u64,
        generation: u32,
    ) -> Result<bool, IssueTrackerError> {
        self.unsubscribe_lease(
            UnsubscribeTarget {
                plugin_id: &identity.plugin_id,
                contribution_id: &identity.contribution_id,
                resolved_root: Some(&identity.workspace_root),
            },
            window_label,
            subscriber_id,
            subscriber_epoch,
            Some(generation),
        )
    }

    fn unsubscribe_lease(
        &self,
        target: UnsubscribeTarget<'_>,
        window_label: &str,
        subscriber_id: &str,
        subscriber_epoch: u64,
        generation: Option<u32>,
    ) -> Result<bool, IssueTrackerError> {
        validate_subscriber_epoch(subscriber_epoch)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let mut identity = None;
        for (candidate, watcher) in &runtime.watchers {
            if candidate.plugin_id != target.plugin_id
                || candidate.contribution_id != target.contribution_id
            {
                continue;
            }
            let matches = if let Some(root) = target.resolved_root {
                candidate.workspace_root == root
            } else if let Some(generation) = generation {
                watcher.generation == generation
            } else {
                watcher
                    .subscribers
                    .lock()
                    .map_err(|_| IssueTrackerError::WatcherUnavailable)?
            .iter()
                    .any(|subscriber| {
                        subscriber.window_label == window_label
                            && subscriber.subscriber_id == subscriber_id
                            && subscriber.subscriber_epoch == subscriber_epoch
            })
            };
            if !matches {
                continue;
            }
            if identity.is_some() {
                // A response-loss cleanup without a resolvable root or
                // generation may use the exact logical lease as its final
                // authority, but it must never guess between two workspaces.
                return Ok(false);
            }
            identity = Some(candidate.clone());
        }
        let Some(identity) = identity else {
            return Ok(false);
        };
        let watcher = runtime
            .watchers
            .get_mut(&identity)
            .ok_or(IssueTrackerError::WatcherUnavailable)?;
        let mut subscribers = watcher
            .subscribers
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
        let previously_included_claims = subscribers_include_agent_claims(&subscribers);
        let before = subscribers.len();
        subscribers.retain(|subscriber| {
            subscriber.window_label != window_label
                || subscriber.subscriber_id != subscriber_id
                || subscriber.subscriber_epoch != subscriber_epoch
        });
        let removed = subscribers.len() != before;
        let includes_agent_claims = subscribers_include_agent_claims(&subscribers);
        let empty = subscribers.is_empty();
        drop(subscribers);
        if !empty && previously_included_claims != includes_agent_claims {
            let (control, changed) = &*watcher.control;
            let mut control = control
                .lock()
                .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
            control.latest = None;
            changed.notify_one();
        }
        let stopped = if empty {
            runtime.watchers.remove(&identity)
        } else {
            None
        };
        if let Some(lease) = stopped {
            Self::retire_watcher(&mut runtime, lease);
        }
        Ok(removed)
    }

    pub fn retire_window(&self, window_label: &str) -> usize {
        let Ok(mut runtime) = self.runtime.lock() else {
            return 0;
        };
        let mut removed = 0;
        let mut empty = Vec::new();
        for (identity, watcher) in &mut runtime.watchers {
            let Ok(mut subscribers) = watcher.subscribers.lock() else {
                continue;
            };
            let previously_included_claims = subscribers_include_agent_claims(&subscribers);
            let before = subscribers.len();
            subscribers.retain(|subscriber| subscriber.window_label != window_label);
            removed += before.saturating_sub(subscribers.len());
            let includes_agent_claims = subscribers_include_agent_claims(&subscribers);
            let is_empty = subscribers.is_empty();
            drop(subscribers);
            if is_empty {
                empty.push(identity.clone());
            } else if previously_included_claims != includes_agent_claims {
                let (control, changed) = &*watcher.control;
                let Ok(mut control) = control.lock() else {
                    continue;
                };
                control.latest = None;
                changed.notify_one();
            }
        }
        let stopped = empty
            .into_iter()
            .filter_map(|identity| runtime.watchers.remove(&identity))
            .collect::<Vec<_>>();
        for lease in stopped {
            Self::retire_watcher(&mut runtime, lease);
        }
        removed
    }

    pub(crate) fn retire_permission_target(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        workspace_root: &Path,
        event_workspace_root: &str,
    ) -> Result<usize, String> {
        // Permission transitions take their exclusive fence before entering
        // here. Keep the established issue runtime -> activation lock order so
        // activation, subscription, and revocation cannot invert each other.
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable.public())?;
        Self::reap_retired_workers(&mut runtime);
        let mut activations = self
            .activations
            .lock()
            .map_err(|_| IssueTrackerError::WatcherUnavailable.public())?;
        let identities = runtime
            .watchers
            .keys()
            .chain(activations.providers.keys())
            .filter(|identity| {
                identity.plugin_id == plugin_id && identity.workspace_root == workspace_root
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut stopped = Vec::new();
        let mut contributions = BTreeSet::new();
        for identity in identities {
            contributions.insert(identity.contribution_id.clone());
            if let Some(lease) = runtime.watchers.remove(&identity) {
                stopped.push(lease);
            }
            activations.providers.remove(&identity);
        }
        drop(activations);
        for lease in stopped {
            Self::retire_watcher(&mut runtime, lease);
        }
        drop(runtime);
        for contribution_id in &contributions {
            emit_activation_state(
                app,
                plugin_id,
                contribution_id,
                event_workspace_root,
                false,
            );
        }
        Ok(contributions.len())
    }
}

impl Drop for DureIssueTrackerState {
    fn drop(&mut self) {
        let Ok(runtime) = self.runtime.get_mut() else {
            return;
        };
        let leases = std::mem::take(&mut runtime.watchers);
        for lease in leases.values() {
            let (control, changed) = &*lease.control;
            if let Ok(mut control) = control.lock() {
                control.stop = true;
                changed.notify_one();
            }
        }
        for (_, lease) in leases {
            let _ = lease.handle.join();
        }
        for handle in std::mem::take(&mut runtime.retired_workers) {
            let _ = handle.join();
        }
    }
}

fn validate_bounded_key(value: &str, maximum: usize) -> Result<(), IssueTrackerError> {
    if value.is_empty()
        || value.len() > maximum
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(IssueTrackerError::InvalidRequest);
    }
    Ok(())
}

fn validate_subscriber_epoch(epoch: u64) -> Result<(), IssueTrackerError> {
    if epoch == 0 || epoch > MAX_SUBSCRIBER_EPOCH {
        return Err(IssueTrackerError::InvalidRequest);
    }
    Ok(())
}

fn issue_tracker_permission_kind() -> PermissionKindIdV2 {
    PermissionKindIdV2::new("dure.issue-tracker.read")
        .expect("issue tracker permission kind is static and valid")
}

fn permission_operation_value(operation: IssueTrackerOperationV1) -> &'static str {
    match operation {
        IssueTrackerOperationV1::Human => "human",
        IssueTrackerOperationV1::List => "list",
        IssueTrackerOperationV1::Ready => "ready",
        IssueTrackerOperationV1::Show => "show",
        IssueTrackerOperationV1::Watch => "watch",
    }
}

fn current_permission_target(
    runtime: &DurePluginPermissionRuntime,
    plugin_id: &str,
    workspace_root: &str,
) -> Result<(ResolvedPluginPermissionTarget, PluginPermissionPlanV2), IssueTrackerError> {
    runtime
        .resolve_current(plugin_id, workspace_root)
        .map_err(|_| IssueTrackerError::PermissionRequired)
}

fn bundled_provider(
    plugin_id: &str,
    contribution_id: &str,
) -> Result<IssueTrackerProviderV1, IssueTrackerError> {
    let (_, resource) = crate::plugin_catalog::bundled_contribution_resource(
        plugin_id,
        contribution_id,
        "dure.issue-tracker",
    )
    .map_err(|_| IssueTrackerError::UnsupportedPlugin)?;
    let provider: IssueTrackerProviderV1 = serde_json::from_slice(resource)
        .map_err(|_| IssueTrackerError::UnsupportedPlugin)?;
    provider
        .validate()
        .map_err(|_| IssueTrackerError::UnsupportedPlugin)?;
    ProviderBackend::from_provider(&provider)?;
    Ok(provider)
}

/// The workspace fact a backend binds to, or the error that names what the
/// workspace lacks for it.
fn workspace_binding(
    backend: ProviderBackend,
    root: &Path,
) -> Result<ProviderBinding, IssueTrackerError> {
    match backend {
        ProviderBackend::Beads => workspace_beads_directory(root)
            .map(|beads_directory| ProviderBinding::Beads { beads_directory })
            .ok_or(IssueTrackerError::WorkspaceHasNoBeads),
        ProviderBackend::Github => workspace_git_common_directory(root)
            .map(|git_common_directory| ProviderBinding::Github {
                git_common_directory,
            })
            .ok_or(IssueTrackerError::WorkspaceHasNoGithubRemote),
    }
}

#[cfg(test)]
fn exact_workspace_root(value: &str) -> Result<PathBuf, IssueTrackerError> {
    let root = exact_workspace_directory(value)?;
    if workspace_beads_directory(&root).is_none() {
        return Err(IssueTrackerError::WorkspaceHasNoBeads);
    }
    Ok(root)
}

fn permission_bound_activated_identity(
    permission_root: &Path,
    plugin_id: &str,
    contribution_id: &str,
    workspace_root: &str,
) -> Result<(WatcherIdentity, PathBuf, ProviderBinding), IssueTrackerError> {
    validate_bounded_key(plugin_id, MAX_SUBSCRIBER_ID_BYTES)?;
    validate_bounded_key(contribution_id, MAX_SUBSCRIBER_ID_BYTES)?;
    let backend = ProviderBackend::from_provider(&bundled_provider(plugin_id, contribution_id)?)?;
    validate_workspace_root_text(workspace_root)?;
    let requested_root = Path::new(workspace_root);
    let metadata = fs::symlink_metadata(requested_root)
        .map_err(|_| IssueTrackerError::PermissionRequired)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(IssueTrackerError::PermissionRequired);
    }
    let observed_root = fs::canonicalize(requested_root)
        .map_err(|_| IssueTrackerError::PermissionRequired)?;
    if observed_root != permission_root {
        return Err(IssueTrackerError::PermissionRequired);
    }
    let root = permission_root.to_path_buf();
    let binding = workspace_binding(backend, &root)?;
    Ok((
        WatcherIdentity {
            plugin_id: plugin_id.to_owned(),
            contribution_id: contribution_id.to_owned(),
            workspace_root: root.clone(),
        },
        root,
        binding,
    ))
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
        .unwrap_or(false)
}

fn bounded_path_pointer(path: &Path, prefix: Option<&str>) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_GIT_POINTER_BYTES
    {
        return None;
    }
    let contents = fs::read_to_string(path).ok()?;
    let value = match prefix {
        Some(prefix) => contents.trim().strip_prefix(prefix)?,
        None => contents.trim(),
    };
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(PathBuf::from(value))
}

fn workspace_beads_directory(root: &Path) -> Option<PathBuf> {
    let direct = root.join(".beads");
    if is_real_directory(&direct) {
        return fs::canonicalize(direct).ok();
    }
    let common_directory = workspace_git_common_directory(root)?;
    let beads_directory = common_directory.parent()?.join(".beads");
    if !is_real_directory(&beads_directory) {
        return None;
    }
    fs::canonicalize(beads_directory).ok()
}

/// The canonical common git directory of the repository the workspace
/// belongs to: `.git` itself, or the `commondir` a linked worktree points at.
/// Both bundled backends key their binding on it — Beads through the
/// `.beads` beside it, GitHub directly.
fn workspace_git_common_directory(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let git_directory = if is_real_directory(&dot_git) {
        dot_git
    } else {
        let pointer = bounded_path_pointer(&dot_git, Some("gitdir: "))?;
        let candidate = if pointer.is_absolute() {
            pointer
        } else {
            root.join(pointer)
        };
        let Ok(candidate) = fs::canonicalize(candidate) else {
            return None;
        };
        if !is_real_directory(&candidate) {
            return None;
        }
        candidate
    };
    let common_directory = match bounded_path_pointer(&git_directory.join("commondir"), None) {
        Some(pointer) => {
            let candidate = if pointer.is_absolute() {
                pointer
            } else {
                git_directory.join(pointer)
            };
            let Ok(candidate) = fs::canonicalize(candidate) else {
                return None;
            };
            candidate
        }
        None => git_directory,
    };
    if !is_real_directory(&common_directory) {
        return None;
    }
    Some(common_directory)
}

fn exact_workspace_directory(value: &str) -> Result<PathBuf, IssueTrackerError> {
    validate_workspace_root_text(value)?;
    let root = Path::new(value);
    let metadata =
        fs::symlink_metadata(root).map_err(|_| IssueTrackerError::WorkspaceUnavailable)?;
    if metadata.file_type().is_symlink() {
        return Err(IssueTrackerError::WorkspaceIsSymlink);
    }
    if !metadata.is_dir() {
        return Err(IssueTrackerError::WorkspaceUnavailable);
    }
    fs::canonicalize(root).map_err(|_| IssueTrackerError::WorkspaceUnavailable)
}

fn validate_workspace_root_text(value: &str) -> Result<(), IssueTrackerError> {
    if value.is_empty()
        || value.len() > MAX_WORKSPACE_ROOT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(IssueTrackerError::InvalidRequest);
    }
    let root = Path::new(value);
    if !root.is_absolute() {
        return Err(IssueTrackerError::InvalidRequest);
    }
    Ok(())
}

fn agent_binding_metadata_key(
    provider: &IssueTrackerProviderV1,
) -> Result<&str, IssueTrackerError> {
    let Some(IssueTrackerAgentBindingSourceV1::ScmBranchMetadata { metadata_key }) =
        &provider.agent_binding
    else {
        return Err(IssueTrackerError::UnsupportedOperation);
    };
    Ok(metadata_key)
}

fn claim_list_arguments(
    statuses: &[String],
    limit: u16,
    metadata_key: Option<&str>,
) -> Vec<String> {
    let mut arguments = vec![
        "list".into(),
        "--status".into(),
        statuses.join(","),
    ];
    if let Some(metadata_key) = metadata_key {
        arguments.extend(["--has-metadata-key".into(), metadata_key.into()]);
    }
    arguments.extend([
        "--limit".into(),
        limit.to_string(),
        "--flat".into(),
        "--json".into(),
    ]);
    arguments
}

fn command_arguments(
    query: &IssueTrackerQueryV1,
    provider: &IssueTrackerProviderV1,
) -> Result<Vec<String>, IssueTrackerError> {
    Ok(match query {
        IssueTrackerQueryV1::Ready { limit } => vec![
            "ready".into(),
            "--limit".into(),
            limit.saturating_add(1).to_string(),
            "--json".into(),
        ],
        IssueTrackerQueryV1::List { limit } => vec![
            "list".into(),
            "--status".into(),
            "open,in_progress".into(),
            "--limit".into(),
            limit.saturating_add(1).to_string(),
            "--flat".into(),
            "--json".into(),
        ],
        IssueTrackerQueryV1::ListByStatus { statuses, limit } => vec![
            "list".into(),
            "--status".into(),
            statuses.join(","),
            "--limit".into(),
            limit.saturating_add(1).to_string(),
            "--flat".into(),
            "--json".into(),
        ],
        IssueTrackerQueryV1::AgentClaims { statuses, limit } => {
            agent_binding_metadata_key(provider)?;
            claim_list_arguments(statuses, limit.saturating_add(1), None)
        }
        IssueTrackerQueryV1::Show { issue_id } => vec![
            "show".into(),
            format!("--id={}", issue_id.as_str()),
            "--json".into(),
        ],
        IssueTrackerQueryV1::Human { .. } => vec!["human".into(), "list".into(), "--json".into()],
        IssueTrackerQueryV1::Counts => vec![
            "status".into(),
            "--no-activity".into(),
            "--json".into(),
        ],
    })
}

fn prepare_command(
    root: &Path,
    activated: &ActivatedProvider,
    provider: &IssueTrackerProviderV1,
    query: &IssueTrackerQueryV1,
) -> Result<CommandSpec, IssueTrackerError> {
    match &activated.binding {
        ProviderBinding::Beads { .. } => {
            prepare_bd_command(root, activated, command_arguments(query, provider)?)
        }
        ProviderBinding::Github { .. } => prepare_gh_command(
            root,
            activated,
            github::command_arguments(query, pinned_repository(activated)?)?,
        ),
    }
}

fn pinned_repository(activated: &ActivatedProvider) -> Result<&str, IssueTrackerError> {
    activated
        .repository
        .as_deref()
        .ok_or(IssueTrackerError::ActivationRequired)
}

/// A pinned `gh` invocation: the activated executable, the login-shell
/// environment it was resolved with, and the non-interactive settings ghx.rs
/// uses so a prompt can never park the watcher.
fn prepare_gh_command(
    root: &Path,
    activated: &ActivatedProvider,
    arguments: Vec<String>,
) -> Result<CommandSpec, IssueTrackerError> {
    validate_activated_workspace(root, activated)?;
    let ProviderBinding::Github { .. } = &activated.binding else {
        return Err(IssueTrackerError::UnsupportedOperation);
    };
    if executable_is_workspace_owned(
        root,
        activated.binding.authority_directory(),
        &activated.executable,
    ) {
        return Err(IssueTrackerError::ExecutableInsideWorkspace);
    }
    let mut command = CommandSpec::new(&activated.executable);
    command.clear_env();
    for (key, value) in activated.environment.iter() {
        command.env(key, value);
    }
    for (key, value) in crate::ghx::NON_INTERACTIVE_ENVIRONMENT {
        command.env(key, value);
    }
    command.args(arguments).current_dir(root);
    Ok(command)
}

fn prepare_bd_command(
    root: &Path,
    activated: &ActivatedProvider,
    arguments: Vec<String>,
) -> Result<CommandSpec, IssueTrackerError> {
    validate_activated_workspace(root, activated)?;
    let ProviderBinding::Beads { beads_directory } = &activated.binding else {
        return Err(IssueTrackerError::UnsupportedOperation);
    };
    if executable_is_workspace_owned(root, beads_directory, &activated.executable) {
        return Err(IssueTrackerError::ExecutableInsideWorkspace);
    }
    let mut command = CommandSpec::new(&activated.executable);
    command.clear_env();
    for (key, value) in activated.environment.iter() {
        if matches!(key.as_str(), "BEADS_DIR" | "BEADS_DB" | "BD_JSON_ENVELOPE") {
            continue;
        }
        command.env(key, value);
    }
    command
        .args(["--readonly", "--sandbox"])
        .args(arguments)
        .current_dir(root)
        .env("BEADS_DIR", beads_directory)
        .env("NO_COLOR", "1");
    Ok(command)
}

fn validate_activated_workspace(
    root: &Path,
    activated: &ActivatedProvider,
) -> Result<(), IssueTrackerError> {
    let current = workspace_binding(activated.binding.backend(), root)?;
    if current != activated.binding {
        return Err(IssueTrackerError::ActivationRequired);
    }
    Ok(())
}

/// True when the executable lives under the workspace or under the root that
/// owns the binding's authority directory (a linked worktree's common
/// repository counts). A tracker or repository must not ship the binary that
/// reads it.
fn executable_is_workspace_owned(root: &Path, authority_directory: &Path, executable: &Path) -> bool {
    executable.starts_with(root)
        || authority_directory
            .parent()
            .is_some_and(|authority_root| executable.starts_with(authority_root))
}

#[derive(Debug, Deserialize)]
struct BeadsWhereOutput {
    path: String,
}

fn validate_beads_where_output(
    output: &[u8],
    expected: &Path,
) -> Result<(), IssueTrackerError> {
    let observed: BeadsWhereOutput =
        serde_json::from_slice(output).map_err(|_| IssueTrackerError::InvalidOutput)?;
    let observed = fs::canonicalize(observed.path).map_err(|_| IssueTrackerError::InvalidOutput)?;
    if observed != expected {
        return Err(IssueTrackerError::InvalidOutput);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BeadsMetadata {
    dolt_mode: Option<String>,
}

/// bd's embedded Dolt engine hands the whole database to one process at a
/// time, so this plugin's reads would queue behind every agent's wrapper
/// transaction (93 s for one read on 2026-09-03). The plugin therefore
/// activates only against a server-mode tracker; the wrapper owns the
/// switch (`pnpm beads -- engine server`), never the host.
fn require_server_dolt_engine(beads_directory: &Path) -> Result<(), IssueTrackerError> {
    let metadata = fs::read(beads_directory.join("metadata.json"))
        .map_err(|_| IssueTrackerError::EmbeddedEngine)?;
    let metadata: BeadsMetadata =
        serde_json::from_slice(&metadata).map_err(|_| IssueTrackerError::EmbeddedEngine)?;
    if metadata.dolt_mode.as_deref() == Some("server") {
        Ok(())
    } else {
        Err(IssueTrackerError::EmbeddedEngine)
    }
}

fn preflight_activated_provider(
    root: &Path,
    binding: ProviderBinding,
) -> Result<ActivatedProvider, IssueTrackerError> {
    if let ProviderBinding::Beads { beads_directory } = &binding {
        require_server_dolt_engine(beads_directory)?;
    }
    let resolved = crate::provider_preflight::resolve_login_command_environment(
        binding.backend().executable_name(),
        root,
        TerminalEnvironment::default(),
    )
    .map_err(|_| IssueTrackerError::ExecutableUnavailable)?;
    if executable_is_workspace_owned(root, binding.authority_directory(), &resolved.executable) {
        return Err(IssueTrackerError::ExecutableInsideWorkspace);
    }
    let mut activated = ActivatedProvider {
        executable: resolved.executable,
        environment: Arc::new(resolved.environment),
        binding,
        repository: None,
        activation_epoch: 0,
    };
    match &activated.binding {
        ProviderBinding::Beads { beads_directory } => {
            let output = execute_command(&prepare_bd_command(
                root,
                &activated,
                vec!["where".into(), "--json".into()],
            )?)?;
            validate_beads_where_output(&output, beads_directory)?;
        }
        ProviderBinding::Github { .. } => {
            // Two probes, each naming the one thing the user can fix: no
            // account in gh, or no GitHub remote in this repository.
            let argv = |arguments: &[&str]| arguments.iter().map(|s| (*s).to_owned()).collect();
            execute_command(&prepare_gh_command(
                root,
                &activated,
                argv(&github::AUTH_STATUS_ARGUMENTS),
            )?)
            .map_err(|error| match error {
                IssueTrackerError::CommandFailed => IssueTrackerError::GithubAuthRequired,
                other => other,
            })?;
            let output = execute_command(&prepare_gh_command(
                root,
                &activated,
                argv(&github::REPOSITORY_VIEW_ARGUMENTS),
            )?)
            .map_err(|error| match error {
                IssueTrackerError::CommandFailed => IssueTrackerError::WorkspaceHasNoGithubRemote,
                other => other,
            })?;
            activated.repository = Some(github::parse_repository(&output)?);
        }
    }
    Ok(activated)
}

fn execute_command(command: &CommandSpec) -> Result<Vec<u8>, IssueTrackerError> {
    let output = hebbian_bounded_process::run(command, QUERY_TIMEOUT, QUERY_OUTPUT_LIMIT)
        .map_err(|failure| match failure {
            CommandFailure::Timeout(_) => IssueTrackerError::CommandTimedOut,
            _ => IssueTrackerError::CommandFailed,
        })?;
    if output.exceeded_limit {
        return Err(IssueTrackerError::OutputTooLarge);
    }
    if !output.status.success() {
        return Err(IssueTrackerError::CommandFailed);
    }
    Ok(output.stdout)
}

fn run_query(
    plugin_id: &str,
    contribution_id: &str,
    workspace_root: &Path,
    activated: &ActivatedProvider,
    query: &IssueTrackerQueryV1,
) -> Result<IssueTrackerQueryResultV1, IssueTrackerError> {
    query
        .validate()
        .map_err(|_| IssueTrackerError::InvalidRequest)?;
    let provider = bundled_provider(plugin_id, contribution_id)?;
    if !provider.supports(query.operation()) {
        return Err(IssueTrackerError::UnsupportedOperation);
    }
    if matches!(query, IssueTrackerQueryV1::Counts) {
        if activated.binding.backend() == ProviderBackend::Github {
            let commands = github::counts_arguments(pinned_repository(activated)?)?
                .into_iter()
                .map(|arguments| prepare_gh_command(workspace_root, activated, arguments))
                .collect::<Result<Vec<_>, _>>()?;
            let outputs = execute_prepared(&commands)?;
            let [open, assigned] = <[Vec<u8>; 2]>::try_from(outputs)
                .map_err(|_| IssueTrackerError::CommandFailed)?;
            validate_activated_workspace(workspace_root, activated)?;
            return github::parse_counts(&open, &assigned);
        }
        let mut outputs = execute_batch(
            workspace_root,
            activated,
            vec![
                command_arguments(query, &provider)?,
                vec![
                    "count".into(),
                    "--status".into(),
                    "blocked".into(),
                    "--json".into(),
                ],
            ],
        )?
        .into_iter();
        let status_output = outputs.next().ok_or(IssueTrackerError::CommandFailed)?;
        let blocked_output = outputs.next().ok_or(IssueTrackerError::CommandFailed)?;
        validate_activated_workspace(workspace_root, activated)?;
        return parse_count_outputs(&status_output, &blocked_output);
    }
    let command = prepare_command(workspace_root, activated, &provider, query)?;
    let output = execute_command(&command)?;
    if let IssueTrackerQueryV1::AgentClaims { statuses, limit } = query {
        let metadata_output = execute_command(&prepare_bd_command(
            workspace_root,
            activated,
            claim_list_arguments(
                statuses,
                *limit,
                Some(agent_binding_metadata_key(&provider)?),
            ),
        )?)?;
        let (issues, complete) = parse_claim_issues(
            &output,
            &metadata_output,
            &provider,
            usize::from(*limit),
            Some(usize::from(*limit) + 1),
        )?;
        validate_activated_workspace(workspace_root, activated)?;
        return Ok(IssueTrackerQueryResultV1::List {
            issues,
            complete: Some(complete),
        });
    }
    validate_activated_workspace(workspace_root, activated)?;
    match activated.binding.backend() {
        ProviderBackend::Beads => parse_query_output(query, &output, &provider),
        ProviderBackend::Github => github::parse_query_output(query, &output),
    }
}

#[derive(Clone, Debug, Deserialize)]
struct RawIssue {
    id: String,
    title: String,
    status: String,
    priority: i32,
    issue_type: String,
    assignee: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    dependency_count: u32,
    #[serde(default)]
    dependent_count: u32,
    description: Option<String>,
    design: Option<String>,
    acceptance_criteria: Option<String>,
    notes: Option<String>,
    metadata: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone, Debug, Deserialize)]
struct RawIssueTrackerStatus {
    schema_version: u16,
    summary: RawIssueTrackerStatusSummary,
}

#[derive(Clone, Debug, Deserialize)]
struct RawIssueTrackerStatusSummary {
    ready_issues: u64,
    open_issues: u64,
    in_progress_issues: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct RawIssueTrackerCount {
    schema_version: u16,
    count: u64,
}

fn bounded_count(value: u64) -> Result<u32, IssueTrackerError> {
    u32::try_from(value).map_err(|_| IssueTrackerError::InvalidOutput)
}

fn parse_count_outputs(
    status_output: &[u8],
    blocked_output: &[u8],
) -> Result<IssueTrackerQueryResultV1, IssueTrackerError> {
    let status: RawIssueTrackerStatus =
        serde_json::from_slice(status_output).map_err(|_| IssueTrackerError::InvalidOutput)?;
    let blocked: RawIssueTrackerCount =
        serde_json::from_slice(blocked_output).map_err(|_| IssueTrackerError::InvalidOutput)?;
    if status.schema_version != 1 || blocked.schema_version != 1 {
        return Err(IssueTrackerError::InvalidOutput);
    }
    let open = status
        .summary
        .open_issues
        .checked_add(status.summary.in_progress_issues)
        .ok_or(IssueTrackerError::InvalidOutput)?;
    Ok(IssueTrackerQueryResultV1::Counts {
        counts: IssueTrackerCountsV1 {
            ready: bounded_count(status.summary.ready_issues)?,
            open: bounded_count(open)?,
            blocked: bounded_count(blocked.count)?,
        },
    })
}

fn parse_raw_issues(output: &[u8]) -> Result<Vec<RawIssue>, IssueTrackerError> {
    serde_json::from_slice::<Option<Vec<RawIssue>>>(output)
        .map_err(|_| IssueTrackerError::InvalidOutput)
        .map(Option::unwrap_or_default)
}

fn parse_claim_issues(
    list_output: &[u8],
    metadata_output: &[u8],
    provider: &IssueTrackerProviderV1,
    maximum: usize,
    maximum_rows: Option<usize>,
) -> Result<(Vec<IssueTrackerIssueSummaryV1>, bool), IssueTrackerError> {
    let mut raw = parse_raw_issues(list_output)?;
    if maximum_rows.is_some_and(|maximum_rows| raw.len() > maximum_rows) {
        return Err(IssueTrackerError::InvalidOutput);
    }
    let complete = raw.len() <= maximum;
    let mut seen = BTreeSet::new();
    for issue in &raw {
        let id = IssueTrackerIssueIdV1::new(issue.id.clone())
            .map_err(|_| IssueTrackerError::InvalidOutput)?;
        if !seen.insert(id.as_str().to_owned()) {
            return Err(IssueTrackerError::InvalidOutput);
        }
    }
    let mut metadata_by_id = BTreeMap::new();
    for issue in parse_raw_issues(metadata_output)? {
        let id = IssueTrackerIssueIdV1::new(issue.id.clone())
            .map_err(|_| IssueTrackerError::InvalidOutput)?;
        if metadata_by_id
            .insert(id.as_str().to_owned(), issue.metadata)
            .is_some()
        {
            return Err(IssueTrackerError::InvalidOutput);
        }
    }
    raw.truncate(maximum);
    let issues = raw
        .into_iter()
        .map(|mut issue| {
            if let Some(metadata) = metadata_by_id.remove(&issue.id) {
                issue.metadata = metadata;
            }
            raw_summary(issue, provider)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((issues, complete))
}

fn parse_query_output(
    query: &IssueTrackerQueryV1,
    output: &[u8],
    provider: &IssueTrackerProviderV1,
) -> Result<IssueTrackerQueryResultV1, IssueTrackerError> {
    query
        .validate()
        .map_err(|_| IssueTrackerError::InvalidRequest)?;
    let mut raw = parse_raw_issues(output)?;
    let maximum = match query {
        IssueTrackerQueryV1::Ready { limit }
        | IssueTrackerQueryV1::List { limit }
        | IssueTrackerQueryV1::ListByStatus { limit, .. }
        | IssueTrackerQueryV1::AgentClaims { limit, .. }
        | IssueTrackerQueryV1::Human { limit } => usize::from(*limit),
        IssueTrackerQueryV1::Show { .. } => 1,
        IssueTrackerQueryV1::Counts => return Err(IssueTrackerError::InvalidRequest),
    };
    match query {
        IssueTrackerQueryV1::Show { .. } if raw.len() > 1 => {
            return Err(IssueTrackerError::InvalidOutput);
        }
        IssueTrackerQueryV1::Human { .. } | IssueTrackerQueryV1::Show { .. } => {}
        _ if raw.len() > maximum.saturating_add(1) => {
            return Err(IssueTrackerError::InvalidOutput);
        }
        _ => {}
    }
    let complete = raw.len() <= maximum;
    raw.truncate(maximum);
    match query {
        IssueTrackerQueryV1::Ready { .. } => Ok(IssueTrackerQueryResultV1::Ready {
            issues: raw
                .into_iter()
                .map(|issue| raw_summary(issue, provider))
                .collect::<Result<_, _>>()?,
            complete: Some(complete),
        }),
        IssueTrackerQueryV1::List { .. }
        | IssueTrackerQueryV1::ListByStatus { .. }
        | IssueTrackerQueryV1::AgentClaims { .. } => {
            Ok(IssueTrackerQueryResultV1::List {
                issues: raw
                    .into_iter()
                    .map(|issue| raw_summary(issue, provider))
                    .collect::<Result<_, _>>()?,
                complete: Some(complete),
            })
        }
        IssueTrackerQueryV1::Human { .. } => Ok(IssueTrackerQueryResultV1::Human {
            issues: raw
                .into_iter()
                .map(|issue| raw_summary(issue, provider))
                .collect::<Result<_, _>>()?,
            complete: Some(complete),
        }),
        IssueTrackerQueryV1::Show { issue_id } => {
            let raw = raw
                .into_iter()
                .next()
                .filter(|raw| raw.id == issue_id.as_str())
                .ok_or(IssueTrackerError::InvalidOutput)?;
            Ok(IssueTrackerQueryResultV1::Show {
                issue: Box::new(raw_detail(raw, provider)?),
            })
        }
        IssueTrackerQueryV1::Counts => Err(IssueTrackerError::InvalidRequest),
    }
}

fn raw_agent_binding(
    raw: &RawIssue,
    provider: &IssueTrackerProviderV1,
) -> Result<Option<IssueTrackerAgentBindingV1>, IssueTrackerError> {
    let Some(IssueTrackerAgentBindingSourceV1::ScmBranchMetadata { metadata_key }) =
        &provider.agent_binding
    else {
        return Ok(None);
    };
    let Some(value) = raw
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(metadata_key))
    else {
        return Ok(None);
    };
    let branch = value.as_str().ok_or(IssueTrackerError::InvalidOutput)?;
    if branch.is_empty()
        || branch.len() > MAX_SCM_BRANCH_BYTES
        || branch.trim() != branch
        || branch.chars().any(char::is_control)
    {
        return Err(IssueTrackerError::InvalidOutput);
    }
    Ok(Some(IssueTrackerAgentBindingV1::ScmBranch {
        branch: branch.to_owned(),
    }))
}

fn raw_summary(
    raw: RawIssue,
    provider: &IssueTrackerProviderV1,
) -> Result<IssueTrackerIssueSummaryV1, IssueTrackerError> {
    validate_text(&raw.title, 1, MAX_TITLE_BYTES)?;
    validate_text(&raw.status, 1, MAX_SHORT_FIELD_BYTES)?;
    validate_text(&raw.issue_type, 1, MAX_SHORT_FIELD_BYTES)?;
    validate_optional_text(raw.assignee.as_deref(), MAX_SHORT_FIELD_BYTES)?;
    validate_optional_text(raw.updated_at.as_deref(), MAX_SHORT_FIELD_BYTES)?;
    let agent_binding = raw_agent_binding(&raw, provider)?;
    Ok(IssueTrackerIssueSummaryV1 {
        id: IssueTrackerIssueIdV1::new(raw.id).map_err(|_| IssueTrackerError::InvalidOutput)?,
        title: raw.title,
        status: raw.status,
        priority: Some(raw.priority),
        issue_type: raw.issue_type,
        assignee: raw.assignee,
        updated_at: raw.updated_at,
        dependency_count: raw.dependency_count,
        dependent_count: raw.dependent_count,
        agent_binding,
    })
}

fn raw_detail(
    mut raw: RawIssue,
    provider: &IssueTrackerProviderV1,
) -> Result<IssueTrackerIssueDetailV1, IssueTrackerError> {
    validate_optional_text(raw.description.as_deref(), MAX_BODY_BYTES)?;
    validate_optional_text(raw.design.as_deref(), MAX_BODY_BYTES)?;
    validate_optional_text(raw.acceptance_criteria.as_deref(), MAX_BODY_BYTES)?;
    validate_optional_text(raw.notes.as_deref(), MAX_BODY_BYTES)?;
    let description = raw.description.take();
    let design = raw.design.take();
    let acceptance_criteria = raw.acceptance_criteria.take();
    let notes = raw.notes.take();
    Ok(IssueTrackerIssueDetailV1 {
        summary: raw_summary(raw, provider)?,
        description,
        design,
        acceptance_criteria,
        notes,
    })
}

fn validate_optional_text(value: Option<&str>, maximum: usize) -> Result<(), IssueTrackerError> {
    match value {
        Some(value) => validate_text(value, 0, maximum),
        None => Ok(()),
    }
}

fn validate_text(value: &str, minimum: usize, maximum: usize) -> Result<(), IssueTrackerError> {
    if value.len() < minimum || value.len() > maximum || value.contains('\0') {
        return Err(IssueTrackerError::InvalidOutput);
    }
    Ok(())
}

fn watch_state(
    plugin_id: &str,
    contribution_id: &str,
    root: &Path,
    activated: &ActivatedProvider,
    include_agent_claims: bool,
) -> Result<IssueTrackerWatchStateV1, IssueTrackerError> {
    match activated.binding.backend() {
        ProviderBackend::Beads => watch_state_with(
            plugin_id,
            contribution_id,
            include_agent_claims,
            |batch| execute_batch(root, activated, batch),
            || validate_activated_workspace(root, activated),
        ),
        ProviderBackend::Github => {
            // No human list and no claim projection exist on GitHub: a watch
            // cycle is the one open-issue list, and a claim interest is a
            // policy error rather than an empty answer.
            if include_agent_claims {
                return Err(IssueTrackerError::UnsupportedOperation);
            }
            let commands = github::watch_arguments(pinned_repository(activated)?)
                .into_iter()
                .map(|arguments| prepare_gh_command(root, activated, arguments))
                .collect::<Result<Vec<_>, _>>()?;
            let outputs = execute_prepared(&commands)?;
            let [open, assigned] = <[Vec<u8>; 2]>::try_from(outputs)
                .map_err(|_| IssueTrackerError::CommandFailed)?;
            validate_activated_workspace(root, activated)?;
            github::watch_state(&open, &assigned)
        }
    }
}

/// A watch cycle or count projection uses independent read-only `bd` queries.
/// Each spawn costs close to a second of fixed start-up regardless of its
/// limit (measured 2026-09-03), so run each batch concurrently and preserve
/// its output order.
fn execute_batch(
    root: &Path,
    activated: &ActivatedProvider,
    batch: Vec<Vec<String>>,
) -> Result<Vec<Vec<u8>>, IssueTrackerError> {
    let commands = batch
        .into_iter()
        .map(|arguments| prepare_bd_command(root, activated, arguments))
        .collect::<Result<Vec<_>, _>>()?;
    execute_prepared(&commands)
}

/// Independent read-only commands run concurrently; outputs keep the order.
fn execute_prepared(commands: &[CommandSpec]) -> Result<Vec<Vec<u8>>, IssueTrackerError> {
    std::thread::scope(|scope| {
        let handles = commands
            .iter()
            .map(|command| scope.spawn(move || execute_command(command)))
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| IssueTrackerError::CommandFailed)?
            })
            .collect()
    })
}

fn watch_state_with<F, V>(
    plugin_id: &str,
    contribution_id: &str,
    include_agent_claims: bool,
    mut execute: F,
    validate: V,
) -> Result<IssueTrackerWatchStateV1, IssueTrackerError>
where
    F: FnMut(Vec<Vec<String>>) -> Result<Vec<Vec<u8>>, IssueTrackerError>,
    V: FnOnce() -> Result<(), IssueTrackerError>,
{
    let provider = bundled_provider(plugin_id, contribution_id)?;
    if !provider.supports(IssueTrackerOperationV1::List)
        || !provider.supports(IssueTrackerOperationV1::Human)
    {
        return Err(IssueTrackerError::UnsupportedOperation);
    }
    let claim_statuses = if include_agent_claims {
        crate::plugin_catalog::bundled_agent_claim_statuses(plugin_id, contribution_id)
            .map_err(|_| IssueTrackerError::UnsupportedPlugin)?
    } else {
        Vec::new()
    };
    let claim_metadata_key = if claim_statuses.is_empty() {
        None
    } else {
        Some(agent_binding_metadata_key(&provider)?)
    };
    // Every list probes one row past the visible limit: enough to report
    // `complete` truthfully, never the whole tracker. An unbounded list grew
    // with the database (1.2 MB for 344 rows on 2026-09-03, sixty percent of
    // the output cap) while the UI only ever shows the first hundred.
    let probe_limit = ISSUE_TRACKER_QUERY_LIMIT_V1 + 1;
    let mut batch = vec![
        vec![
            "list".into(),
            "--status".into(),
            "open,in_progress".into(),
            "--limit".into(),
            probe_limit.to_string(),
            "--flat".into(),
            "--json".into(),
        ],
        vec!["human".into(), "list".into(), "--json".into()],
    ];
    if !claim_statuses.is_empty() {
        batch.push(claim_list_arguments(&claim_statuses, probe_limit, None));
        batch.push(claim_list_arguments(
            &claim_statuses,
            ISSUE_TRACKER_QUERY_LIMIT_V1,
            claim_metadata_key,
        ));
    }
    let mut outputs = execute(batch)?.into_iter();
    let mut next_output = || outputs.next().ok_or(IssueTrackerError::CommandFailed);
    let all_output = next_output()?;
    let human_output = next_output()?;
    let (claim_list_output, claim_metadata_output) = if claim_statuses.is_empty() {
        (b"null".to_vec(), b"null".to_vec())
    } else {
        (next_output()?, next_output()?)
    };
    validate()?;
    build_watch_state(
        &provider,
        &claim_statuses,
        include_agent_claims,
        &all_output,
        &human_output,
        &claim_list_output,
        &claim_metadata_output,
    )
}

fn build_watch_state(
    provider: &IssueTrackerProviderV1,
    claim_statuses: &[String],
    include_agent_claims: bool,
    all_output: &[u8],
    human_output: &[u8],
    claim_list_output: &[u8],
    claim_metadata_output: &[u8],
) -> Result<IssueTrackerWatchStateV1, IssueTrackerError> {
    let all = parse_raw_issues(all_output)?;
    let human = parse_raw_issues(human_output)?;
    let maximum = usize::from(ISSUE_TRACKER_QUERY_LIMIT_V1);
    let (agent_claim_issues, agent_claim_issues_complete) = if include_agent_claims {
        let (issues, complete) = parse_claim_issues(
        claim_list_output,
        claim_metadata_output,
        provider,
        maximum,
        None,
    )?;
        (Some(issues), Some(complete))
    } else {
        (None, None)
    };
    let issues_complete = all.len() <= maximum;
    let human_issues_complete = human.len() <= maximum;
    let issues = all
        .iter()
        .take(maximum)
        .cloned()
        .map(|issue| raw_summary(issue, provider))
        .collect::<Result<Vec<_>, _>>()?;
    let human_issues = human
        .into_iter()
        .take(maximum)
        .map(|issue| raw_summary(issue, provider))
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = IssueTrackerWatchSnapshotV1 {
        issues,
        issues_complete: Some(issues_complete),
        human_issues,
        human_issues_complete: Some(human_issues_complete),
        agent_claim_issues,
        agent_claim_issues_complete,
    };
    let mut digest = Sha256::new();
    digest.update(b"dure.issue-tracker.watch.v1\0open\0");
    digest.update(all_output);
    digest.update(b"\0human\0");
    digest.update(human_output);
    if include_agent_claims {
    digest.update(b"\0agent-claims\0");
    for status in claim_statuses {
        digest.update(status.as_bytes());
        digest.update(b"\0");
    }
    digest.update(claim_list_output);
    digest.update(b"\0metadata\0");
    digest.update(claim_metadata_output);
    } else {
        digest.update(b"\0agent-claims-disabled\0");
    }
    Ok(IssueTrackerWatchStateV1::Snapshot {
        revision_digest: format!("{:x}", digest.finalize()),
        snapshot,
    })
}

fn start_workspace_watcher(
    launch: WorkspaceWatcherLaunch,
) -> Result<JoinHandle<()>, IssueTrackerError> {
    let WorkspaceWatcherLaunch {
        app,
        permission_target,
        permission_plan,
        plugin_id,
        contribution_id,
        workspace_key,
        workspace_root,
        root,
        generation,
        subscribers,
        control,
    } = launch;
    if root != permission_target.workspace().canonical_root() {
        return Err(IssueTrackerError::PermissionRequired);
    }
    let event_plugin_id =
        PluginIdV2::new(plugin_id.clone()).map_err(|_| IssueTrackerError::InvalidRequest)?;
    let event_contribution_id = ContributionIdV2::new(contribution_id.clone())
        .map_err(|_| IssueTrackerError::InvalidRequest)?;
    let permission_kind = issue_tracker_permission_kind();
    let watcher_identity = WatcherIdentity {
        plugin_id: plugin_id.clone(),
        contribution_id: contribution_id.clone(),
        workspace_root: root.clone(),
    };
    thread::Builder::new()
        .name(format!("dure-issue-watch-{generation}"))
        .spawn(move || 'watch: loop {
            let (activated, agent_claim_policy_epoch) = {
                let (control_mutex, _) = &*control;
                let Ok(control_guard) = control_mutex.lock() else {
                    return;
                };
                if control_guard.stop {
                    return;
                }
                let Some(activated) = control_guard.activated.clone() else {
                    return;
                };
                // Publication also snapshots subscribers while holding control.
                // Keep one lock order so future multi-worker changes cannot
                // turn the two paths into a control/subscriber deadlock.
                let Ok(subscribers_guard) = subscribers.lock() else {
                    return;
            };
                let agent_claim_policy_epoch =
                    subscribers_agent_claim_policy_epoch(&subscribers_guard);
                (activated, agent_claim_policy_epoch)
            };
            let issue_state = app.state::<DureIssueTrackerState>();
            let include_agent_claims = agent_claim_policy_epoch.is_some();
            let permission_runtime = app.state::<DurePluginPermissionRuntime>();
            let Ok(permission_state) = permission_runtime.available() else {
                return;
            };
            let publication = permission_state.with_authorized_execution(
                &permission_target,
                PluginPermissionExecutionRequest::new(
                    &permission_plan,
                    &permission_kind,
                    "operations",
                    "watch",
                ),
                |_lease| {
                    let claim_poll_guard = agent_claim_policy_epoch
                        .map(|epoch| {
                            issue_state.begin_agent_claim_execution(&watcher_identity, epoch)
                        })
                        .transpose()?;
                    let state = watch_state(
                            &plugin_id,
                            &contribution_id,
                            &root,
                            &activated,
                            include_agent_claims,
                        )
                            .unwrap_or_else(|error| IssueTrackerWatchStateV1::Unavailable {
                                code: error.public(),
                        });
                    Ok::<_, IssueTrackerError>((state, claim_poll_guard))
                },
                |(state, claim_poll_guard), _lease| {
                    let targets = {
                        let (control_mutex, _) = &*control;
                        let mut control_guard = control_mutex
                            .lock()
                            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
                        if control_guard.stop {
                            return Ok(false);
                        }
                        let current_agent_claim_policy_epoch = subscribers
                            .lock()
                            .map(|subscribers| {
                                subscribers_agent_claim_policy_epoch(&subscribers)
                            })
                            .map_err(|_| IssueTrackerError::WatcherUnavailable)?;
                        if current_agent_claim_policy_epoch != agent_claim_policy_epoch {
                            // A setting transition changed the shared watcher
                            // projection while commands were in flight. Never
                            // cache or emit rows from the retired interest.
                            return Ok(false);
                        }
                        if control_guard
                            .activated
                            .as_ref()
                            .map(|current| current.activation_epoch)
                            != Some(activated.activation_epoch)
                        {
                            // Activation changed while the bounded command was
                            // in flight. Discard this epoch before cache/event
                            // publication while the permission fence is held.
                            return Ok(false);
                        }
                        let changed = control_guard
                            .latest
                            .as_ref()
                            .is_none_or(|event| event.state != state);
                        if changed {
                            if matches!(
                                &state,
                                IssueTrackerWatchStateV1::Unavailable { code }
                                    if code == "issue_tracker_activation_required"
                            ) {
                                emit_activation_state(
                                    &app,
                                    &plugin_id,
                                    &contribution_id,
                                    &workspace_root,
                                    false,
                                );
                            }
                            control_guard.revision = control_guard.revision.saturating_add(1);
                            let event = IssueTrackerWatchEventV1 {
                                plugin_id: Some(event_plugin_id.clone()),
                                contribution_id: Some(event_contribution_id.clone()),
                                workspace_key: workspace_key.clone(),
                                generation,
                                revision: control_guard.revision,
                                state,
                            };
                            control_guard.latest = Some(event.clone());
                            subscribers
                                .lock()
                                .map(|subscribers| {
                                    subscribers
                                        .iter()
                                        .map(|subscriber| subscriber.window_label.clone())
                                        .collect::<BTreeSet<_>>()
                                })
                                .unwrap_or_default()
                                .into_iter()
                                .map(|window_label| (window_label, event.clone()))
                                .collect::<Vec<_>>()
                        } else {
                            Vec::new()
                        }
                    };
                    for (window_label, event) in targets {
                        let _ = app.emit_to(window_label, ISSUE_TRACKER_EVENT, event);
                    }
                    drop(claim_poll_guard);
                    Ok(true)
                },
            );
            match watcher_publication_outcome(publication) {
                WatcherPublicationOutcome::Published => {}
                WatcherPublicationOutcome::Retry => {
                    if !wait_for_watcher_retry(&control, WATCHER_RETRY_BACKOFF) {
                        return;
            }
                    continue 'watch;
                }
                WatcherPublicationOutcome::PermissionRevoked => {
                    let _ = issue_state.emit_inactive_if_current(
                        &app,
                        &watcher_identity,
                        Some(activated.activation_epoch),
                        &plugin_id,
                        &contribution_id,
                        &workspace_root,
                    );
                    return;
                }
                WatcherPublicationOutcome::Stop => return,
            }
            let (control_mutex, changed) = &*control;
            let Ok(control_guard) = control_mutex.lock() else {
                return;
            };
            if control_guard.stop {
                return;
            }
            if control_guard.activated.as_ref().map(|current| current.activation_epoch)
                != Some(activated.activation_epoch)
            {
                // Activation may have changed after targets were prepared but
                // before they were emitted. Skip the interval so the cleared
                // cache is replaced immediately.
                continue 'watch;
            }
            let interval = control_guard.interval;
            let Ok((control_guard, _)) = changed.wait_timeout(control_guard, interval) else {
                return;
            };
            if control_guard.stop {
                return;
            }
        })
        .map_err(|_| IssueTrackerError::WatcherUnavailable)
}

#[tauri::command]
pub fn dure_issue_tracker_activation_get(
    state: State<'_, DureIssueTrackerState>,
    permissions: State<'_, DurePluginPermissionRuntime>,
    request: DureIssueTrackerActivationRequest,
) -> Result<bool, String> {
    let (permission_target, permission_plan) = current_permission_target(
        &permissions,
        &request.plugin_id,
        &request.workspace_root,
    )
    .map_err(IssueTrackerError::public)?;
    let permission_state = permissions
        .available()
        .map_err(|_| IssueTrackerError::PermissionRequired.public())?;
    let permission_kind = issue_tracker_permission_kind();
    permission_state
        .with_authorized_execution(
            &permission_target,
            PluginPermissionExecutionRequest::new(
                &permission_plan,
                &permission_kind,
                "operations",
                "activate",
            ),
            |_lease| {
                Ok::<_, IssueTrackerError>((|| -> Result<_, IssueTrackerError> {
                    let (identity, _, binding) = permission_bound_activated_identity(
                        permission_target.workspace().canonical_root(),
                        &request.plugin_id,
                        &request.contribution_id,
                        &request.workspace_root,
                    )?;
                    Ok((identity, binding))
                })())
            },
            |resolved, _lease| {
                let (identity, binding) = resolved?;
                state.is_activated(&identity, &binding)
            },
        )
        .map_err(IssueTrackerError::public)
}

#[tauri::command]
pub async fn dure_issue_tracker_activate(
    app: AppHandle,
    permissions: State<'_, DurePluginPermissionRuntime>,
    request: DureIssueTrackerActivationRequest,
) -> Result<bool, String> {
    let (permission_target, permission_plan) = current_permission_target(
        &permissions,
        &request.plugin_id,
        &request.workspace_root,
    )
    .map_err(IssueTrackerError::public)?;
    let permission_app = app.clone();
    let activated_request = request.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = permission_app.state::<DurePluginPermissionRuntime>();
        let permission_state = runtime
            .available()
            .map_err(|_| IssueTrackerError::PermissionRequired)?;
        let permission_kind = issue_tracker_permission_kind();
        permission_state.with_authorized_execution(
            &permission_target,
            PluginPermissionExecutionRequest::new(
                &permission_plan,
                &permission_kind,
                "operations",
                "activate",
            ),
            |_lease| {
                let (identity, root, binding) = permission_bound_activated_identity(
                    permission_target.workspace().canonical_root(),
                    &activated_request.plugin_id,
                    &activated_request.contribution_id,
                    &activated_request.workspace_root,
                )?;
                let activated = preflight_activated_provider(&root, binding)?;
                // Preflight ran processes; the workspace may have moved under
                // it. Bind only what the filesystem still says.
                if workspace_binding(activated.binding.backend(), &root)? != activated.binding {
                    return Err(IssueTrackerError::ActivationRequired);
                }
                Ok((identity, activated))
            },
            |(identity, activated), _lease| {
                let issue_state = permission_app.state::<DureIssueTrackerState>();
                let changed = issue_state.activate(identity, activated)?;
                emit_activation_state(
                    &permission_app,
                    &activated_request.plugin_id,
                    &activated_request.contribution_id,
                    &activated_request.workspace_root,
                    true,
                );
                Ok(changed)
            },
        )
    })
    .await
    .map_err(|_| IssueTrackerError::ExecutableUnavailable.public())?
    .map_err(IssueTrackerError::public)
}

#[tauri::command]
pub async fn dure_issue_tracker_query(
    app: AppHandle,
    permissions: State<'_, DurePluginPermissionRuntime>,
    request: DureIssueTrackerQueryRequest,
) -> Result<IssueTrackerQueryResultV1, String> {
    let (permission_target, permission_plan) = current_permission_target(
        &permissions,
        &request.plugin_id,
        &request.workspace_root,
    )
    .map_err(IssueTrackerError::public)?;
    let permission_operation = permission_operation_value(request.query.operation());
    let query_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let permission_runtime = query_app.state::<DurePluginPermissionRuntime>();
        let permission_state = permission_runtime
            .available()
            .map_err(|_| IssueTrackerError::PermissionRequired)?;
        let permission_kind = issue_tracker_permission_kind();
        let issue_state = query_app.state::<DureIssueTrackerState>();

        for attempt in 0..=1 {
            let publication = permission_state.with_authorized_execution(
                &permission_target,
                PluginPermissionExecutionRequest::new(
                    &permission_plan,
                    &permission_kind,
                    "operations",
                    permission_operation,
                ),
                |_lease| {
                    let execution = (|| -> Result<_, IssueTrackerError> {
                        let (identity, root, binding) =
                            permission_bound_activated_identity(
                                permission_target.workspace().canonical_root(),
                            &request.plugin_id,
                            &request.contribution_id,
                            &request.workspace_root,
                        )?;
                        let Some(activated) = issue_state.activated_provider(&identity)? else {
                            return Ok(QueryExecutionAttempt::MissingActivation { identity });
                        };
                        let activation_epoch = activated.activation_epoch;
                        if activated.binding != binding {
                            return Ok(QueryExecutionAttempt::MismatchedActivation {
                                identity,
                                activation_epoch,
                            });
                        }
                        let (result, claim_execution_guard) = issue_state
                            .execute_query_with_claim_policy(
                                &identity,
                                &request.query,
                                request.agent_claim_policy_epoch,
                                || {
                                    run_query(
                                &request.plugin_id,
                                &request.contribution_id,
                                &root,
                                &activated,
                                &request.query,
                                    )
                                },
                            )?;
                        Ok(QueryExecutionAttempt::Ran {
                            identity,
                            activation_epoch,
                            result,
                            claim_execution_guard,
                        })
                    })()
                    .unwrap_or_else(QueryExecutionAttempt::Failed);
                    Ok::<_, IssueTrackerError>(execution)
                },
                |execution, _lease| {
                    let stale_publication = || {
                        if attempt == 1 {
                            QueryAttemptPublication::Complete(Err(
                                IssueTrackerError::ActivationRequired,
                            ))
                        } else {
                            QueryAttemptPublication::Retry
                        }
                    };
                    match execution {
                        QueryExecutionAttempt::Failed(error) => Ok(
                            QueryAttemptPublication::Complete(Err(error)),
                        ),
                        QueryExecutionAttempt::MissingActivation { identity } => {
                            if issue_state.emit_inactive_if_current(
                                &query_app,
                                &identity,
                                None,
                                &request.plugin_id,
                                &request.contribution_id,
                                &request.workspace_root,
                            )? {
                                Ok(QueryAttemptPublication::Complete(Err(
                                    IssueTrackerError::ActivationRequired,
                                )))
                            } else {
                                Ok(stale_publication())
                            }
                        }
                        QueryExecutionAttempt::MismatchedActivation {
                            identity,
                            activation_epoch,
                        } => {
                            if issue_state.emit_inactive_if_current(
                                &query_app,
                                &identity,
                                Some(activation_epoch),
                                &request.plugin_id,
                                &request.contribution_id,
                                &request.workspace_root,
                            )? {
                                Ok(QueryAttemptPublication::Complete(Err(
                                    IssueTrackerError::ActivationRequired,
                                )))
                            } else {
                                Ok(stale_publication())
                            }
                        }
                        QueryExecutionAttempt::Ran {
                            identity,
                            activation_epoch,
                            result,
                            claim_execution_guard,
                        } => {
                            if !issue_state.query_agent_claim_policy_is_current(
                                &identity,
                                &request.query,
                                request.agent_claim_policy_epoch,
                            )? {
                                return Ok(QueryAttemptPublication::Complete(Err(
                                    IssueTrackerError::AgentClaimPolicyRequired,
                                )));
                            }
                            if !issue_state
                                .activation_epoch_is_current(&identity, activation_epoch)?
                            {
                                return Ok(stale_publication());
                            }
                            if matches!(result, Err(IssueTrackerError::ActivationRequired))
                                && !issue_state.emit_inactive_if_current(
                                    &query_app,
                                    &identity,
                                    Some(activation_epoch),
                                    &request.plugin_id,
                                    &request.contribution_id,
                                    &request.workspace_root,
                                )?
                            {
                                return Ok(stale_publication());
                            }
                            drop(claim_execution_guard);
                            Ok(QueryAttemptPublication::Complete(result))
                        }
                    }
                },
            )?;
            match publication {
                QueryAttemptPublication::Retry => continue,
                QueryAttemptPublication::Complete(result) => return result,
            }
        }
        unreachable!("bounded query retry loop always publishes on the second attempt")
    })
    .await
    .map_err(|_| IssueTrackerError::CommandFailed.public())?
    .map_err(IssueTrackerError::public)
}

#[tauri::command]
pub fn dure_issue_tracker_watch_subscribe(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, DureIssueTrackerState>,
    permissions: State<'_, DurePluginPermissionRuntime>,
    request: DureIssueTrackerWatchSubscribeRequest,
) -> Result<IssueTrackerWatchSubscriptionV1, String> {
    validate_subscriber_epoch(request.subscriber_epoch).map_err(IssueTrackerError::public)?;
    let (permission_target, permission_plan) = current_permission_target(
        &permissions,
        &request.plugin_id,
        &request.workspace_root,
    )
    .map_err(IssueTrackerError::public)?;
    let checked_plugin_id = request.plugin_id.clone();
    let checked_contribution_id = request.contribution_id.clone();
    let checked_workspace_root = request.workspace_root.clone();
    let permission_state = permissions
        .available()
        .map_err(|_| IssueTrackerError::PermissionRequired.public())?;
    let permission_kind = issue_tracker_permission_kind();
    permission_state
        .with_authorized_execution(
            &permission_target,
            PluginPermissionExecutionRequest::new(
                &permission_plan,
                &permission_kind,
                "operations",
                "watch",
            ),
            |_lease| {
                let preparation = (|| -> Result<_, IssueTrackerError> {
                    let (identity, root, binding) = permission_bound_activated_identity(
                        permission_target.workspace().canonical_root(),
                        &checked_plugin_id,
                        &checked_contribution_id,
                        &checked_workspace_root,
                    )?;
                    let Some(activated) = state.activated_provider(&identity)? else {
                        return Ok(WatchSubscriptionPreparation::MissingActivation {
                            identity,
                        });
                    };
                    if activated.binding != binding {
                        return Ok(WatchSubscriptionPreparation::MismatchedActivation {
                            identity,
                            activation_epoch: activated.activation_epoch,
                        });
                    }
                    let provider = bundled_provider(&checked_plugin_id, &checked_contribution_id)?;
                    if !provider.supports(IssueTrackerOperationV1::Watch) {
                        return Err(IssueTrackerError::UnsupportedOperation);
                    }
                    Ok(WatchSubscriptionPreparation::Ready {
                        identity,
                        root,
                        binding,
                    })
                })()
                .unwrap_or_else(WatchSubscriptionPreparation::Failed);
                Ok::<_, IssueTrackerError>(preparation)
            },
            |preparation, _lease| match preparation {
                WatchSubscriptionPreparation::Failed(error) => Err(error),
                WatchSubscriptionPreparation::MissingActivation { identity } => {
                    state.emit_inactive_if_current(
                        &app,
                        &identity,
                        None,
                        &request.plugin_id,
                        &request.contribution_id,
                        &request.workspace_root,
                    )?;
                    Err(IssueTrackerError::ActivationRequired)
                }
                WatchSubscriptionPreparation::MismatchedActivation {
                    identity,
                    activation_epoch,
                } => {
                    state.emit_inactive_if_current(
                        &app,
                        &identity,
                        Some(activation_epoch),
                        &request.plugin_id,
                        &request.contribution_id,
                        &request.workspace_root,
                    )?;
                    Err(IssueTrackerError::ActivationRequired)
                }
                WatchSubscriptionPreparation::Ready {
                    identity,
                    root,
                    binding,
                } => {
                    let worker_root = root.clone();
                    let worker_plugin_id = request.plugin_id.clone();
                    let worker_contribution_id = request.contribution_id.clone();
                    let worker_workspace_key = request.workspace_key.clone();
                    let worker_workspace_root = request.workspace_root.clone();
                    let worker_identity = identity.clone();
                    let worker_app = app.clone();
                    let worker_permission_target = permission_target.clone();
                    let worker_permission_plan = permission_plan.clone();
                    let state_ref: &DureIssueTrackerState = &state;
                    state.subscribe_with(
                        identity,
                        request.workspace_key,
                        Subscriber {
                            window_label: window.label().to_owned(),
                            subscriber_id: request.subscriber_id,
                            subscriber_epoch: request.subscriber_epoch,
                            include_agent_claims: request.include_agent_claims,
                            agent_claim_policy_epoch: request.agent_claim_policy_epoch,
                        },
                        Duration::from_secs(request.interval_seconds),
                        move |generation, subscribers, control| {
                            // subscribe_with holds the issue runtime lock while
                            // this callback rechecks activation. Keep the
                            // established runtime -> activation lock order.
                            let activated = state_ref
                                .activated_provider(&worker_identity)?
                                .ok_or(IssueTrackerError::ActivationRequired)?;
                            if activated.binding != binding {
                                return Err(IssueTrackerError::ActivationRequired);
                            }
                            let (control_mutex, _) = &*control;
                            control_mutex
                                .lock()
                                .map_err(|_| IssueTrackerError::WatcherUnavailable)?
                                .activated = Some(activated);
                            start_workspace_watcher(WorkspaceWatcherLaunch {
                                app: worker_app,
                                permission_target: worker_permission_target,
                                permission_plan: worker_permission_plan,
                                plugin_id: worker_plugin_id,
                                contribution_id: worker_contribution_id,
                                workspace_key: worker_workspace_key,
                                workspace_root: worker_workspace_root,
                                root: worker_root,
                                generation,
                                subscribers,
                                control,
                            })
                        },
                    )
                }
            },
        )
        .map_err(IssueTrackerError::public)
}

#[tauri::command]
pub fn dure_issue_tracker_watch_unsubscribe(
    window: tauri::WebviewWindow,
    state: State<'_, DureIssueTrackerState>,
    request: DureIssueTrackerWatchUnsubscribeRequest,
) -> Result<bool, String> {
    validate_bounded_key(&request.plugin_id, MAX_SUBSCRIBER_ID_BYTES)
        .map_err(IssueTrackerError::public)?;
    validate_bounded_key(&request.contribution_id, MAX_SUBSCRIBER_ID_BYTES)
        .map_err(IssueTrackerError::public)?;
    validate_bounded_key(&request.subscriber_id, MAX_SUBSCRIBER_ID_BYTES)
        .map_err(IssueTrackerError::public)?;
    validate_subscriber_epoch(request.subscriber_epoch).map_err(IssueTrackerError::public)?;
    validate_workspace_root_text(&request.workspace_root).map_err(IssueTrackerError::public)?;
    let root = exact_workspace_directory(&request.workspace_root).ok();
    state
        .unsubscribe_lease(
            UnsubscribeTarget {
                plugin_id: &request.plugin_id,
                contribution_id: &request.contribution_id,
                resolved_root: root.as_deref(),
            },
            window.label(),
            &request.subscriber_id,
            request.subscriber_epoch,
            request.generation,
        )
        .map_err(IssueTrackerError::public)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".beads")).unwrap();
        root
    }

    fn subscriber(
        window_label: &str,
        subscriber_id: &str,
        subscriber_epoch: u64,
        include_agent_claims: bool,
        agent_claim_policy_epoch: Option<u32>,
    ) -> Subscriber {
        Subscriber {
            window_label: window_label.into(),
            subscriber_id: subscriber_id.into(),
            subscriber_epoch,
            include_agent_claims,
            agent_claim_policy_epoch,
        }
    }

    fn provider() -> IssueTrackerProviderV1 {
        bundled_provider(BUNDLED_BEADS_PLUGIN_ID, BUNDLED_BEADS_CONTRIBUTION_ID).unwrap()
    }

    fn raw_issue_value(id: &str, title: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "title": title,
            "status": status,
            "priority": 1,
            "issue_type": "task"
        })
    }

    fn wait_worker(
        stopped: Arc<AtomicBool>,
    ) -> impl FnOnce(
        u32,
        SharedSubscribers,
        SharedWatcherControl,
    ) -> Result<JoinHandle<()>, IssueTrackerError> {
        move |_, _, control| {
            Ok(thread::spawn(move || {
                let (mutex, changed) = &*control;
                let mut guard = mutex.lock().unwrap();
                while !guard.stop && !stopped.load(Ordering::Relaxed) {
                    guard = changed
                        .wait_timeout(guard, Duration::from_millis(10))
                        .unwrap()
                        .0;
                }
            }))
        }
    }

    /// A git repository with no `.beads`: what the GitHub backend binds to
    /// and the Beads backend refuses.
    fn git_workspace() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        root
    }

    #[test]
    fn bundled_providers_name_a_host_backend_each() {
        let beads = bundled_provider(BUNDLED_BEADS_PLUGIN_ID, BUNDLED_BEADS_CONTRIBUTION_ID).unwrap();
        assert_eq!(ProviderBackend::from_provider(&beads), Ok(ProviderBackend::Beads));
        let github =
            bundled_provider(BUNDLED_GITHUB_PLUGIN_ID, BUNDLED_GITHUB_CONTRIBUTION_ID).unwrap();
        assert_eq!(ProviderBackend::from_provider(&github), Ok(ProviderBackend::Github));
        assert!(!github.supports(IssueTrackerOperationV1::Human));
        assert_eq!(
            bundled_provider("dure.github", "dure.beads.issue-tracker"),
            Err(IssueTrackerError::UnsupportedPlugin)
        );
    }

    #[test]
    fn the_github_backend_binds_to_the_repository_and_beads_still_needs_its_tracker() {
        let workspace = git_workspace();
        let root = fs::canonicalize(workspace.path()).unwrap();
        assert_eq!(
            workspace_binding(ProviderBackend::Github, &root),
            Ok(ProviderBinding::Github {
                git_common_directory: root.join(".git"),
            })
        );
        assert_eq!(
            workspace_binding(ProviderBackend::Beads, &root),
            Err(IssueTrackerError::WorkspaceHasNoBeads)
        );
        // A linked worktree binds to the common repository, not its own gitdir.
        let linked = tempfile::tempdir().unwrap();
        fs::create_dir(root.join(".git/worktrees")).unwrap();
        fs::create_dir(root.join(".git/worktrees/linked")).unwrap();
        fs::write(
            root.join(".git/worktrees/linked/commondir"),
            "../..\n",
        )
        .unwrap();
        fs::write(
            linked.path().join(".git"),
            format!("gitdir: {}\n", root.join(".git/worktrees/linked").display()),
        )
        .unwrap();
        assert_eq!(
            workspace_binding(ProviderBackend::Github, &fs::canonicalize(linked.path()).unwrap()),
            Ok(ProviderBinding::Github {
                git_common_directory: root.join(".git"),
            })
        );
        // No repository at all is "no GitHub remote" for the user.
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(
            workspace_binding(ProviderBackend::Github, plain.path()),
            Err(IssueTrackerError::WorkspaceHasNoGithubRemote)
        );
    }

    #[test]
    fn gh_commands_are_pinned_non_interactive_and_bound_to_the_workspace() {
        let workspace = git_workspace();
        let root = fs::canonicalize(workspace.path()).unwrap();
        let activated = ActivatedProvider {
            executable: PathBuf::from("/trusted/bin/gh"),
            environment: Arc::new(BTreeMap::from([(
                "PATH".to_owned(),
                "/trusted/bin".to_owned(),
            )])),
            binding: ProviderBinding::Github {
                git_common_directory: root.join(".git"),
            },
            repository: Some("github.com/o/r".into()),
            activation_epoch: 0,
        };
        let command =
            prepare_gh_command(&root, &activated, vec!["issue".into(), "list".into()]).unwrap();
        let environment = command
            .environment()
            .iter()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert!(command.clears_environment());
        assert_eq!(command.program(), Path::new("/trusted/bin/gh"));
        assert_eq!(command.current_directory(), Some(root.as_path()));
        assert_eq!(environment.get("PATH").map(String::as_str), Some("/trusted/bin"));
        for (key, value) in crate::ghx::NON_INTERACTIVE_ENVIRONMENT {
            assert_eq!(environment.get(key).map(String::as_str), Some(value), "{key}");
        }
        // The same activation cannot be driven through the other backend's
        // command builder, and a workspace-owned gh is refused.
        assert_eq!(
            prepare_bd_command(&root, &activated, vec!["list".into()]).map(|_| ()),
            Err(IssueTrackerError::UnsupportedOperation)
        );
        let owned = ActivatedProvider {
            executable: root.join("bin/gh"),
            ..activated.clone()
        };
        assert_eq!(
            prepare_gh_command(&root, &owned, vec!["issue".into(), "list".into()]).map(|_| ()),
            Err(IssueTrackerError::ExecutableInsideWorkspace)
        );
        // Re-pointing the workspace away from the bound repository invalidates it.
        let other = git_workspace();
        assert_eq!(
            prepare_gh_command(
                &fs::canonicalize(other.path()).unwrap(),
                &activated,
                vec!["issue".into(), "list".into()],
            )
            .map(|_| ()),
            Err(IssueTrackerError::ActivationRequired)
        );
    }

    fn stop_all(state: &DureIssueTrackerState) {
        let runtime = state.runtime.lock().unwrap();
        for watcher in runtime.watchers.values() {
            let (control, changed) = &*watcher.control;
            control.lock().unwrap().stop = true;
            changed.notify_one();
        }
    }

    fn watcher_identity(root: PathBuf) -> WatcherIdentity {
        WatcherIdentity {
            plugin_id: BUNDLED_BEADS_PLUGIN_ID.into(),
            contribution_id: BUNDLED_BEADS_CONTRIBUTION_ID.into(),
            workspace_root: root,
        }
    }

    #[test]
    fn status_filtered_queries_compile_to_bounded_direct_bd_arguments() {
        let provider = provider();
        assert_eq!(
            command_arguments(&IssueTrackerQueryV1::List { limit: 100 }, &provider).unwrap(),
            vec![
                "list",
                "--status",
                "open,in_progress",
                "--limit",
                "101",
                "--flat",
                "--json",
            ]
        );
        assert_eq!(
            command_arguments(
                &IssueTrackerQueryV1::ListByStatus {
                    statuses: vec!["in_progress".to_owned()],
                    limit: 100,
                },
                &provider,
            )
            .unwrap(),
            vec![
                "list",
                "--status",
                "in_progress",
                "--limit",
                "101",
                "--flat",
                "--json",
            ]
        );
        assert_eq!(
            command_arguments(&IssueTrackerQueryV1::Human { limit: 7 }, &provider).unwrap(),
            vec!["human", "list", "--json"]
        );
        assert_eq!(
            command_arguments(&IssueTrackerQueryV1::Counts, &provider).unwrap(),
            vec!["status", "--no-activity", "--json"]
        );
        assert_eq!(
            command_arguments(
                &IssueTrackerQueryV1::AgentClaims {
                    statuses: vec!["in_progress".to_owned()],
                    limit: 100,
                },
                &provider,
            )
            .unwrap(),
            vec![
                "list",
                "--status",
                "in_progress",
                "--limit",
                "101",
                "--flat",
                "--json",
            ]
        );
        assert_eq!(
            claim_list_arguments(
                &["in_progress".to_owned()],
                100,
                Some("dure_worktree_branch"),
            ),
            vec![
                "list",
                "--status",
                "in_progress",
                "--has-metadata-key",
                "dure_worktree_branch",
                "--limit",
                "100",
                "--flat",
                "--json",
            ]
        );
    }

    #[test]
    fn parses_mode_counts_from_status_and_explicit_blocked_status() {
        let result = parse_count_outputs(
            br#"{"schema_version":1,"summary":{"ready_issues":7,"open_issues":5,"in_progress_issues":7,"blocked_issues":40}}"#,
            br#"{"schema_version":1,"count":3}"#,
        )
        .unwrap();

        assert_eq!(
            result,
            IssueTrackerQueryResultV1::Counts {
                counts: IssueTrackerCountsV1 {
                    ready: 7,
                    open: 12,
                    blocked: 3,
                },
            }
        );
    }

    #[test]
    fn parses_ready_list_show_and_null_human_into_typed_bounded_results() {
        let issue =
            br#"[{"id":"repo-1","title":"First","status":"in_progress","priority":1,"issue_type":"task","dependency_count":2,"dependent_count":3,"description":"detail","metadata":{"dure_worktree_branch":"agent/plugin"}}]"#;
        let provider = provider();
        assert!(matches!(
            parse_query_output(&IssueTrackerQueryV1::Ready { limit: 1 }, issue, &provider).unwrap(),
            IssueTrackerQueryResultV1::Ready { .. }
        ));
        let IssueTrackerQueryResultV1::List { issues, complete } =
            parse_query_output(&IssueTrackerQueryV1::List { limit: 1 }, issue, &provider).unwrap()
        else {
            panic!("expected list result");
        };
        assert_eq!(
            issues[0].agent_binding,
            Some(IssueTrackerAgentBindingV1::ScmBranch {
                branch: "agent/plugin".to_owned()
            })
        );
        assert_eq!(complete, Some(true));
        assert!(matches!(
            parse_query_output(
                &IssueTrackerQueryV1::ListByStatus {
                    statuses: vec!["in_progress".to_owned()],
                    limit: 1,
                },
                issue,
                &provider,
            )
            .unwrap(),
            IssueTrackerQueryResultV1::List { .. }
        ));
        assert!(matches!(
            parse_query_output(
                &IssueTrackerQueryV1::Show {
                    issue_id: IssueTrackerIssueIdV1::new("repo-1").unwrap()
                },
                issue,
                &provider,
            )
            .unwrap(),
            IssueTrackerQueryResultV1::Show { .. }
        ));
        assert_eq!(
            parse_query_output(&IssueTrackerQueryV1::Human { limit: 1 }, b"null", &provider)
                .unwrap(),
            IssueTrackerQueryResultV1::Human {
                issues: Vec::new(),
                complete: Some(true),
            }
        );
        assert!(
            parse_query_output(&IssueTrackerQueryV1::List { limit: 0 }, issue, &provider).is_err()
        );
    }

    #[test]
    fn query_results_probe_one_extra_row_and_report_unknown_legacy_completeness() {
        let two = serde_json::to_vec(&vec![
            raw_issue_value("repo-1", "repo-1", "in_progress"),
            raw_issue_value("repo-2", "repo-2", "in_progress"),
        ])
        .unwrap();
        let three = serde_json::to_vec(&vec![
            raw_issue_value("repo-1", "repo-1", "in_progress"),
            raw_issue_value("repo-2", "repo-2", "in_progress"),
            raw_issue_value("repo-3", "repo-3", "in_progress"),
        ])
        .unwrap();
        let provider = provider();

        let IssueTrackerQueryResultV1::List { issues, complete } = parse_query_output(
            &IssueTrackerQueryV1::List { limit: 1 },
            &two,
            &provider,
        )
        .unwrap()
        else {
            panic!("expected list result");
        };
        assert_eq!(issues.len(), 1);
        assert_eq!(complete, Some(false));
        assert!(
            parse_query_output(
                &IssueTrackerQueryV1::List { limit: 1 },
                &three,
                &provider,
            )
            .is_err()
        );

        let IssueTrackerQueryResultV1::Human { issues, complete } = parse_query_output(
            &IssueTrackerQueryV1::Human { limit: 1 },
            &three,
            &provider,
        )
        .unwrap()
        else {
            panic!("expected human result");
        };
        assert_eq!(issues.len(), 1);
        assert_eq!(complete, Some(false));

        let legacy: IssueTrackerQueryResultV1 = serde_json::from_value(serde_json::json!({
            "kind": "list",
            "issues": []
        }))
        .unwrap();
        assert!(matches!(
            legacy,
            IssueTrackerQueryResultV1::List { complete: None, .. }
        ));
    }

    #[test]
    fn watch_digest_covers_rows_beyond_the_visible_limit_and_declared_deferred_claims() {
        let provider = provider();
        let mut all = (0..=usize::from(ISSUE_TRACKER_QUERY_LIMIT_V1))
            .map(|index| {
                raw_issue_value(
                    &format!("repo-{index:03}"),
                    &format!("Issue {index}"),
                    "open",
                )
            })
            .collect::<Vec<_>>();
        let original = serde_json::to_vec(&all).unwrap();
        all.last_mut().unwrap()["title"] = serde_json::Value::String("Changed outside view".into());
        let changed = serde_json::to_vec(&all).unwrap();
        let deferred = serde_json::to_vec(&vec![
            raw_issue_value("repo-deferred", "Deferred claim", "deferred"),
            raw_issue_value("repo-detached", "Detached claim", "deferred"),
        ])
        .unwrap();
        let mut bound_deferred = raw_issue_value(
            "repo-deferred",
            "Deferred claim",
            "deferred",
        );
        bound_deferred["metadata"] = serde_json::json!({
            "dure_worktree_branch": "agent/plugin"
        });
        let deferred_metadata = serde_json::to_vec(&vec![bound_deferred]).unwrap();
        let statuses = vec!["deferred".to_owned()];

        let before = build_watch_state(
            &provider,
            &statuses,
            true,
            &original,
            b"null",
            &deferred,
            &deferred_metadata,
        )
        .unwrap();
        let after = build_watch_state(
            &provider,
            &statuses,
            true,
            &changed,
            b"null",
            &deferred,
            &deferred_metadata,
        )
        .unwrap();
        assert_ne!(before, after);
        let IssueTrackerWatchStateV1::Snapshot { snapshot, .. } = before else {
            panic!("expected watcher snapshot");
        };
        assert_eq!(snapshot.issues.len(), usize::from(ISSUE_TRACKER_QUERY_LIMIT_V1));
        assert_eq!(snapshot.issues_complete, Some(false));
        assert_eq!(
            snapshot
                .agent_claim_issues
                .as_ref()
                .unwrap()
                .iter()
                .map(|issue| issue.id.as_str())
                .collect::<Vec<_>>(),
            ["repo-deferred", "repo-detached"]
        );
        assert!(snapshot.agent_claim_issues.as_ref().unwrap()[0]
            .agent_binding
            .is_some());
        assert!(snapshot.agent_claim_issues.as_ref().unwrap()[1]
            .agent_binding
            .is_none());
        assert_eq!(snapshot.agent_claim_issues_complete, Some(true));
    }

    #[test]
    fn watch_without_claim_interest_runs_only_issue_and_human_commands() {
        let mut commands = Vec::new();
        let issue = serde_json::to_vec(&vec![raw_issue_value(
            "repo-open",
            "Open issue",
            "open",
        )])
        .unwrap();
        let state = watch_state_with(
            BUNDLED_BEADS_PLUGIN_ID,
            BUNDLED_BEADS_CONTRIBUTION_ID,
            false,
            |batch| {
                batch
                    .into_iter()
                    .map(|arguments| {
                        let output = if arguments.first().is_some_and(|value| value == "human")
                        {
                            b"[]".to_vec()
                        } else {
                            issue.clone()
                        };
                        commands.push(arguments);
                        Ok(output)
                    })
                    .collect()
            },
            || Ok(()),
        )
        .unwrap();

        assert_eq!(commands.len(), 2);
        assert_eq!(
            commands[0],
            [
                "list",
                "--status",
                "open,in_progress",
                "--limit",
                "101",
                "--flat",
                "--json"
            ]
        );
        assert_eq!(commands[1], ["human", "list", "--json"]);
        let IssueTrackerWatchStateV1::Snapshot { snapshot, .. } = state else {
            panic!("expected watcher snapshot");
        };
        assert_eq!(snapshot.issues.len(), 1);
        assert!(snapshot.agent_claim_issues.is_none());
        assert!(snapshot.agent_claim_issues_complete.is_none());
    }

    #[test]
    fn unsubscribe_can_resolve_the_workspace_after_beads_metadata_is_removed() {
        let root = workspace();
        let canonical = exact_workspace_root(root.path().to_str().unwrap()).unwrap();
        fs::remove_dir(root.path().join(".beads")).unwrap();
        assert_eq!(
            exact_workspace_directory(root.path().to_str().unwrap()).unwrap(),
            canonical
        );
        assert_eq!(
            exact_workspace_root(root.path().to_str().unwrap()),
            Err(IssueTrackerError::WorkspaceHasNoBeads)
        );
    }

    #[test]
    fn response_loss_cleanup_survives_workspace_removal_without_generation() {
        let workspace = workspace();
        let root = fs::canonicalize(workspace.path()).unwrap();
        let identity = watcher_identity(root.clone());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims:removed-root", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        drop(workspace);
        assert!(!root.exists());

        assert!(state
            .unsubscribe_lease(
                UnsubscribeTarget {
                    plugin_id: &identity.plugin_id,
                    contribution_id: &identity.contribution_id,
                    resolved_root: None,
                },
                "main",
                "claims:removed-root",
                1,
                None,
            )
            .unwrap());
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn response_loss_cleanup_never_guesses_between_matching_workspaces() {
        let first_workspace = workspace();
        let second_workspace = workspace();
        let first_identity = watcher_identity(fs::canonicalize(first_workspace.path()).unwrap());
        let second_identity = watcher_identity(fs::canonicalize(second_workspace.path()).unwrap());
        let state = DureIssueTrackerState::default();
        let first_stopped = Arc::new(AtomicBool::new(false));
        let second_stopped = Arc::new(AtomicBool::new(false));
        for (identity, stopped) in [
            (first_identity.clone(), Arc::clone(&first_stopped)),
            (second_identity.clone(), Arc::clone(&second_stopped)),
        ] {
            state
                .subscribe_with(
                    identity,
                    "workspace-1".into(),
                    subscriber("main", "claims:ambiguous-root", 1, false, None),
                    Duration::from_secs(5),
                    wait_worker(stopped),
                )
                .unwrap();
        }

        assert!(!state
            .unsubscribe_lease(
                UnsubscribeTarget {
                    plugin_id: &first_identity.plugin_id,
                    contribution_id: &first_identity.contribution_id,
                    resolved_root: None,
                },
                "main",
                "claims:ambiguous-root",
                1,
                None,
            )
            .unwrap());
        assert_eq!(state.runtime.lock().unwrap().watchers.len(), 2);
        stop_all(&state);
        first_stopped.store(true, Ordering::Relaxed);
        second_stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn permission_failure_requests_a_local_revocation_projection() {
        assert_eq!(
            watcher_publication_outcome(Err(IssueTrackerError::PermissionRequired)),
            WatcherPublicationOutcome::PermissionRevoked
        );
        assert_eq!(
            watcher_publication_outcome(Err(IssueTrackerError::AgentClaimPolicyRequired)),
            WatcherPublicationOutcome::Retry
        );
    }

    #[test]
    fn watcher_retry_uses_a_bounded_wait_and_honors_stop() {
        let control = Arc::new((
            Mutex::new(WatcherControl {
                stop: false,
                interval: Duration::from_secs(5),
                revision: 0,
                latest: None,
                activated: None,
            }),
            Condvar::new(),
        ));
        let started = Instant::now();
        assert!(wait_for_watcher_retry(
            &control,
            Duration::from_millis(5)
        ));
        assert!(started.elapsed() >= Duration::from_millis(1));
        assert!(started.elapsed() < Duration::from_secs(1));
        control.0.lock().unwrap().stop = true;
        assert!(!wait_for_watcher_retry(
            &control,
            Duration::from_secs(1)
        ));
    }

    #[test]
    fn linked_worktree_resolves_beads_beside_the_common_git_directory() {
        let fixture = tempfile::tempdir().unwrap();
        let repository = fixture.path().join("repository");
        let worktree = fixture.path().join("worktree");
        let git_directory = repository.join(".git/worktrees/task");
        fs::create_dir_all(&git_directory).unwrap();
        fs::create_dir_all(repository.join(".beads")).unwrap();
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            "gitdir: ../repository/.git/worktrees/task\n",
        )
        .unwrap();
        fs::write(git_directory.join("commondir"), "../..\n").unwrap();

        assert_eq!(
            exact_workspace_root(worktree.to_str().unwrap()).unwrap(),
            fs::canonicalize(worktree).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn permission_target_root_rejects_parent_symlink_retarget_before_activation() {
        use std::os::unix::fs::symlink;

        let fixture = tempfile::tempdir().unwrap();
        let first_parent = fixture.path().join("first");
        let second_parent = fixture.path().join("second");
        let alias = fixture.path().join("current");
        let first_workspace = first_parent.join("workspace");
        let second_workspace = second_parent.join("workspace");
        fs::create_dir_all(first_workspace.join(".beads")).unwrap();
        fs::create_dir_all(&second_workspace).unwrap();
        symlink(&first_parent, &alias).unwrap();
        let requested_workspace = alias.join("workspace");
        let permission_root =
            exact_workspace_directory(requested_workspace.to_str().unwrap()).unwrap();

        fs::remove_file(&alias).unwrap();
        symlink(&second_parent, &alias).unwrap();

        assert_eq!(
            permission_bound_activated_identity(
                &permission_root,
                BUNDLED_BEADS_PLUGIN_ID,
                BUNDLED_BEADS_CONTRIBUTION_ID,
                requested_workspace.to_str().unwrap(),
            ),
            Err(IssueTrackerError::PermissionRequired)
        );
    }

    #[test]
    fn pinned_commands_clear_ambient_db_selectors_and_bind_the_verified_beads_directory() {
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let beads_directory = fs::canonicalize(root.path().join(".beads")).unwrap();
        let activated = ActivatedProvider {
            executable: PathBuf::from("/trusted/bin/bd"),
            environment: Arc::new(BTreeMap::from([
                ("PATH".to_owned(), "/trusted/bin".to_owned()),
                ("BEADS_DIR".to_owned(), "/wrong/.beads".to_owned()),
                ("BEADS_DB".to_owned(), "/wrong/database".to_owned()),
                ("BEADS_DOLT_SERVER_HOST".to_owned(), "server.example".to_owned()),
            ])),
            binding: ProviderBinding::Beads {
                beads_directory: beads_directory.clone(),
            },
            repository: None,
            activation_epoch: 0,
        };

        let command = prepare_bd_command(
            &canonical_root,
            &activated,
            vec!["where".into(), "--json".into()],
        )
        .unwrap();
        let environment = command
            .environment()
            .iter()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert!(command.clears_environment());
        assert_eq!(command.program(), Path::new("/trusted/bin/bd"));
        assert_eq!(
            environment.get("BEADS_DIR").map(String::as_str),
            Some(beads_directory.to_string_lossy().as_ref())
        );
        assert!(!environment.contains_key("BEADS_DB"));
        assert_eq!(
            environment.get("BEADS_DOLT_SERVER_HOST").map(String::as_str),
            Some("server.example")
        );
    }

    #[test]
    fn activation_requires_the_server_dolt_engine() {
        let root = workspace();
        let beads = root.path().join(".beads");
        let metadata = beads.join("metadata.json");

        assert_eq!(
            require_server_dolt_engine(&beads),
            Err(IssueTrackerError::EmbeddedEngine)
        );
        fs::write(&metadata, r#"{"backend":"dolt","dolt_mode":"embedded"}"#).unwrap();
        assert_eq!(
            require_server_dolt_engine(&beads),
            Err(IssueTrackerError::EmbeddedEngine)
        );
        fs::write(&metadata, b"not json").unwrap();
        assert_eq!(
            require_server_dolt_engine(&beads),
            Err(IssueTrackerError::EmbeddedEngine)
        );
        fs::write(&metadata, r#"{"backend":"dolt","dolt_mode":"server"}"#).unwrap();
        assert_eq!(require_server_dolt_engine(&beads), Ok(()));
        assert_eq!(IssueTrackerError::EmbeddedEngine.code(), "embedded_engine");
    }

    #[test]
    fn activation_rejects_a_where_result_for_another_workspace() {
        let expected = workspace();
        let other = workspace();
        let expected_beads = fs::canonicalize(expected.path().join(".beads")).unwrap();
        let other_beads = fs::canonicalize(other.path().join(".beads")).unwrap();
        let output = serde_json::to_vec(&serde_json::json!({
            "path": other_beads,
        }))
        .unwrap();

        assert_eq!(
            validate_beads_where_output(&output, &expected_beads),
            Err(IssueTrackerError::InvalidOutput)
        );
    }

    #[test]
    fn activation_is_invalid_when_the_workspace_resolves_to_another_beads_directory() {
        let current = workspace();
        let old = workspace();
        let root = fs::canonicalize(current.path()).unwrap();
        let current_beads = fs::canonicalize(current.path().join(".beads")).unwrap();
        let old_beads = fs::canonicalize(old.path().join(".beads")).unwrap();
        let identity = watcher_identity(root.clone());
        let activated = ActivatedProvider {
            executable: PathBuf::from("/trusted/bin/bd"),
            environment: Arc::new(BTreeMap::new()),
            binding: ProviderBinding::Beads {
                beads_directory: old_beads,
            },
            repository: None,
            activation_epoch: 0,
        };
        let state = DureIssueTrackerState::default();
        state.activate(identity.clone(), activated.clone()).unwrap();

        assert!(!state
            .is_activated(
                &identity,
                &ProviderBinding::Beads {
                    beads_directory: current_beads,
                },
            )
            .unwrap());
        assert_eq!(
            validate_activated_workspace(&root, &activated),
            Err(IssueTrackerError::ActivationRequired)
        );
    }

    #[test]
    fn reactivation_refreshes_an_existing_watcher_and_fences_its_old_epoch() {
        let workspace = workspace();
        let root = fs::canonicalize(workspace.path()).unwrap();
        let beads_directory = fs::canonicalize(workspace.path().join(".beads")).unwrap();
        let identity = watcher_identity(root);
        let state = DureIssueTrackerState::default();
        let first_provider = ActivatedProvider {
            executable: PathBuf::from("/trusted/bin/bd-v1"),
            environment: Arc::new(BTreeMap::new()),
            binding: ProviderBinding::Beads {
                beads_directory: beads_directory.clone(),
            },
            repository: None,
            activation_epoch: 0,
        };
        assert!(state
            .activate(identity.clone(), first_provider)
            .unwrap());
        let first_provider = state
            .activated_provider(&identity)
            .unwrap()
            .unwrap();
        let first_epoch = first_provider.activation_epoch;
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let subscription = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims:refresh", 1, false, None),
                Duration::from_secs(5),
                move |generation, subscribers, control| {
                    control.0.lock().unwrap().activated = Some(first_provider);
                    wait_worker(worker_stopped)(generation, subscribers, control)
                },
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            runtime.watchers[&identity].control.0.lock().unwrap().latest = Some(
                IssueTrackerWatchEventV1 {
                    plugin_id: None,
                    contribution_id: None,
                    workspace_key: "workspace-1".into(),
                    generation: subscription.generation,
                    revision: 1,
                    state: IssueTrackerWatchStateV1::Unavailable {
                        code: "old_epoch".into(),
                    },
                },
            );
        }

        let replacement = ActivatedProvider {
            executable: PathBuf::from("/trusted/bin/bd-v2"),
            environment: Arc::new(BTreeMap::new()),
            binding: ProviderBinding::Beads { beads_directory },
            repository: None,
            activation_epoch: 0,
        };
        assert!(!state.activate(identity.clone(), replacement).unwrap());

        let runtime = state.runtime.lock().unwrap();
        let watcher = &runtime.watchers[&identity];
        assert_eq!(watcher.generation, subscription.generation);
        let refreshed = watcher
            .control
            .0
            .lock()
            .unwrap()
            .activated
            .clone()
            .unwrap();
        assert_eq!(refreshed.executable, PathBuf::from("/trusted/bin/bd-v2"));
        assert!(refreshed.activation_epoch > first_epoch);
        assert!(watcher.control.0.lock().unwrap().latest.is_none());
        drop(runtime);
        assert!(!state
            .activation_epoch_is_current(&identity, first_epoch)
            .unwrap());
        assert!(state
            .activation_epoch_is_current(&identity, refreshed.activation_epoch)
            .unwrap());
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn executable_cannot_come_from_a_linked_worktrees_common_repository() {
        let fixture = tempfile::tempdir().unwrap();
        let worktree = fixture.path().join("worktree");
        let repository = fixture.path().join("repository");
        let beads_directory = repository.join(".beads");
        let executable = repository.join("bin/bd");

        assert!(executable_is_workspace_owned(
            &worktree,
            &beads_directory,
            &executable,
        ));
    }

    #[test]
    fn two_windows_share_one_watcher_and_last_unsubscribe_reclaims_it() {
        let root = workspace();
        let root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(root.clone());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let first = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "issues", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        let second = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("desktop-2", "issues", 1, false, None),
                Duration::from_secs(10),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        let other_identity = WatcherIdentity {
            contribution_id: "dure.beads.other-issues".into(),
            ..identity.clone()
        };
        let other = state
            .subscribe_with(
                other_identity,
                "workspace-1".into(),
                subscriber("main", "other-issues", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        assert!(!first.reused_watcher);
        assert!(second.reused_watcher);
        assert!(!other.reused_watcher);
        assert_eq!(state.runtime.lock().unwrap().watchers.len(), 2);
        assert!(!state
            .unsubscribe(&identity, "main", "issues", 2, first.generation + 1)
            .unwrap());
        assert!(state
            .unsubscribe(&identity, "main", "issues", 1, first.generation + 1)
            .unwrap());
        assert_eq!(state.retire_window("desktop-2"), 1);
        assert_eq!(state.runtime.lock().unwrap().watchers.len(), 1);
        assert!(!state
            .runtime
            .lock()
            .unwrap()
            .watchers
            .contains_key(&identity));
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn replacing_a_claim_lease_with_no_interest_invalidates_cached_claims() {
        let root = workspace();
        let identity = watcher_identity(fs::canonicalize(root.path()).unwrap());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let policy_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                identity.workspace_root.clone(),
                true,
            )
            .unwrap();
        let first = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 1, true, Some(policy_epoch)),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            let watcher = &runtime.watchers[&identity];
            watcher.control.0.lock().unwrap().latest = Some(IssueTrackerWatchEventV1 {
                plugin_id: None,
                contribution_id: None,
                workspace_key: "workspace-1".into(),
                generation: first.generation,
                revision: 1,
                state: IssueTrackerWatchStateV1::Snapshot {
                    revision_digest: "claims".into(),
                    snapshot: IssueTrackerWatchSnapshotV1 {
                        issues: Vec::new(),
                        issues_complete: Some(true),
                        human_issues: Vec::new(),
                        human_issues_complete: Some(true),
                        agent_claim_issues: Some(Vec::new()),
                        agent_claim_issues_complete: Some(true),
                    },
                },
            });
        }

        let replacement = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 2, false, None),
                Duration::from_secs(5),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        assert!(replacement.reused_watcher);
        assert!(replacement.latest.is_none());
        let runtime = state.runtime.lock().unwrap();
        let watcher = &runtime.watchers[&identity];
        assert!(!subscribers_include_agent_claims(
            &watcher.subscribers.lock().unwrap()
        ));
        drop(runtime);
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn subscriber_epoch_keeps_new_lease_across_late_messages_and_lost_response_cleanup() {
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(canonical_root.clone());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let policy_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        let first = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "stable-claims", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        let replacement = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber(
                    "main",
                    "stable-claims",
                    2,
                    true,
                    Some(policy_epoch),
                ),
                Duration::from_secs(10),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        assert_eq!(replacement.generation, first.generation);

        for stale_epoch in [1, 2] {
            state
                .subscribe_with(
                    identity.clone(),
                    "workspace-1".into(),
                    subscriber("main", "stable-claims", stale_epoch, false, None),
                    Duration::from_secs(5),
                    |_, _, _| unreachable!(),
                )
                .unwrap();
        }
        {
            let runtime = state.runtime.lock().unwrap();
            let watcher = &runtime.watchers[&identity];
            let subscribers = watcher.subscribers.lock().unwrap();
            assert_eq!(subscribers.len(), 1);
            let subscriber = subscribers.iter().next().unwrap();
            assert_eq!(subscriber.subscriber_epoch, 2);
            assert!(subscriber.include_agent_claims);
            assert_eq!(watcher.control.0.lock().unwrap().interval, Duration::from_secs(10));
        }

        assert!(!state
            .unsubscribe_lease(
                UnsubscribeTarget {
                    plugin_id: &identity.plugin_id,
                    contribution_id: &identity.contribution_id,
                    resolved_root: Some(&canonical_root),
                },
                "main",
                "stable-claims",
                1,
                None,
            )
            .unwrap());
        assert_eq!(
            state.runtime.lock().unwrap().watchers[&identity]
                .subscribers
                .lock()
                .unwrap()
                .len(),
            1
        );
        assert!(state
            .unsubscribe_lease(
                UnsubscribeTarget {
                    plugin_id: &identity.plugin_id,
                    contribution_id: &identity.contribution_id,
                    resolved_root: Some(&canonical_root),
                },
                "main",
                "stable-claims",
                2,
                None,
            )
            .unwrap());
        assert!(!state.runtime.lock().unwrap().watchers.contains_key(&identity));
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn subscriber_epoch_must_be_nonzero_and_json_safe() {
        let root = workspace();
        let identity = watcher_identity(fs::canonicalize(root.path()).unwrap());
        let state = DureIssueTrackerState::default();
        for invalid_epoch in [0, MAX_SUBSCRIBER_EPOCH + 1] {
            let result = state.subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", invalid_epoch, false, None),
                Duration::from_secs(5),
                |_, _, _| unreachable!(),
            );
            assert!(matches!(result, Err(IssueTrackerError::InvalidRequest)));
        }
    }

    #[test]
    fn foreground_claim_query_executes_only_for_the_current_enabled_policy_epoch() {
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(canonical_root.clone());
        let state = DureIssueTrackerState::default();
        let query = IssueTrackerQueryV1::AgentClaims {
            statuses: vec!["in_progress".into()],
            limit: 10,
        };
        let mut executions = 0;

        let missing = state.execute_query_with_claim_policy(&identity, &query, None, || {
            executions += 1;
        });
        assert!(matches!(
            missing,
            Err(IssueTrackerError::AgentClaimPolicyRequired)
        ));
        let policy_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        let wrong = state.execute_query_with_claim_policy(
            &identity,
            &query,
            Some(policy_epoch + 1),
            || {
                executions += 1;
            },
        );
        assert!(matches!(
            wrong,
            Err(IssueTrackerError::AgentClaimPolicyRequired)
        ));
        let (_, guard) = state
            .execute_query_with_claim_policy(&identity, &query, Some(policy_epoch), || {
                executions += 1;
            })
            .unwrap();
        assert!(guard.is_some());
        drop(guard);
        assert_eq!(executions, 1);

        state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root,
                false,
            )
            .unwrap();
        let disabled = state.execute_query_with_claim_policy(
            &identity,
            &query,
            Some(policy_epoch),
            || {
                executions += 1;
            },
        );
        assert!(matches!(
            disabled,
            Err(IssueTrackerError::AgentClaimPolicyRequired)
        ));
        assert_eq!(executions, 1);

        let (_, guard) = state
            .execute_query_with_claim_policy(
                &identity,
                &IssueTrackerQueryV1::List { limit: 1 },
                None,
                || {
                    executions += 1;
                },
            )
            .unwrap();
        assert!(guard.is_none());
        assert_eq!(executions, 2);
    }

    #[test]
    fn workspace_policy_retires_stale_claim_leases_until_a_fresh_subscribe() {
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(canonical_root.clone());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let initial_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 1, true, Some(initial_epoch)),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            runtime.watchers[&identity].control.0.lock().unwrap().latest = Some(
                IssueTrackerWatchEventV1 {
                    plugin_id: None,
                    contribution_id: None,
                    workspace_key: "workspace-1".into(),
                    generation: 1,
                    revision: 1,
                    state: IssueTrackerWatchStateV1::Unavailable {
                        code: "cached_claims".into(),
                    },
                },
            );
        }

        let _disabled_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                false,
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            let watcher = &runtime.watchers[&identity];
            assert!(!subscribers_include_agent_claims(
                &watcher.subscribers.lock().unwrap()
            ));
            assert!(watcher.control.0.lock().unwrap().latest.is_none());
        }

        let enabled_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        assert!(!state
            .query_agent_claim_policy_is_current(
                &identity,
                &IssueTrackerQueryV1::AgentClaims {
                    statuses: vec!["in_progress".into()],
                    limit: 10,
                },
                Some(initial_epoch),
            )
            .unwrap());
        assert!(matches!(
            state.begin_agent_claim_execution(&identity, initial_epoch),
            Err(IssueTrackerError::AgentClaimPolicyRequired)
        ));
        drop(
            state
                .begin_agent_claim_execution(&identity, enabled_epoch)
                .unwrap(),
        );
        {
            let runtime = state.runtime.lock().unwrap();
            assert!(!subscribers_include_agent_claims(
                &runtime.watchers[&identity].subscribers.lock().unwrap()
            ));
        }

        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 1, true, Some(initial_epoch)),
                Duration::from_secs(5),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            assert!(!subscribers_include_agent_claims(
                &runtime.watchers[&identity].subscribers.lock().unwrap()
            ));
        }

        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 2, true, Some(enabled_epoch)),
                Duration::from_secs(5),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            assert!(subscribers_include_agent_claims(
                &runtime.watchers[&identity].subscribers.lock().unwrap()
            ));
        }

        state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root,
                false,
            )
            .unwrap();
        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("desktop-2", "claims", 1, true, Some(enabled_epoch)),
                Duration::from_secs(5),
                |_, _, _| unreachable!(),
            )
            .unwrap();
        {
            let runtime = state.runtime.lock().unwrap();
            assert!(!subscribers_include_agent_claims(
                &runtime.watchers[&identity].subscribers.lock().unwrap()
            ));
        }
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn failed_settings_persistence_leaves_claim_policy_and_subscribers_unchanged() {
        let state = DureIssueTrackerState::default();
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(canonical_root.clone());
        let stopped = Arc::new(AtomicBool::new(false));
        let initial_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 1, true, Some(initial_epoch)),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        let cached = IssueTrackerWatchEventV1 {
            plugin_id: None,
            contribution_id: None,
            workspace_key: "workspace-1".into(),
            generation: 1,
            revision: 1,
            state: IssueTrackerWatchStateV1::Unavailable {
                code: "cached_claims".into(),
            },
        };
        {
            let runtime = state.runtime.lock().unwrap();
            runtime.watchers[&identity].control.0.lock().unwrap().latest =
                Some(cached.clone());
        }

        let failure = state
            .persist_agent_claim_policy_update(
                &identity.plugin_id,
                canonical_root,
                vec![(identity.contribution_id.clone(), false)],
                || Err::<(), _>("injected settings write failure".into()),
            )
            .unwrap_err();
        assert_eq!(failure.0, "injected settings write failure");
        assert_eq!(failure.1[&identity.contribution_id], initial_epoch);
        {
            let runtime = state.runtime.lock().unwrap();
            assert_eq!(runtime.last_agent_claim_policy_epoch, initial_epoch);
            let policy = &runtime.agent_claim_policies[&identity];
            assert!(policy.enabled);
            assert_eq!(policy.epoch, initial_epoch);
            let watcher = &runtime.watchers[&identity];
            let subscribers = watcher.subscribers.lock().unwrap();
            assert!(subscribers_include_agent_claims(&subscribers));
            assert_eq!(
                subscribers_agent_claim_policy_epoch(&subscribers),
                Some(initial_epoch)
            );
            drop(subscribers);
            assert_eq!(watcher.control.0.lock().unwrap().latest, Some(cached));
        }
        drop(
            state
                .begin_agent_claim_execution(&identity, initial_epoch)
                .unwrap(),
        );
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn claim_execution_fence_timeout_is_bounded_and_remains_armed() {
        let fence = Arc::new(AgentClaimExecutionFence::default());
        let guard = fence.begin().unwrap();
        let started = Instant::now();
        assert_eq!(
            fence.wait_until_idle(Duration::from_millis(20)),
            Err(IssueTrackerError::CommandTimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!fence.is_idle().unwrap());
        drop(guard);
        assert_eq!(fence.wait_until_idle(Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn disabling_claim_policy_waits_for_all_generations_and_foreground_queries() {
        let root = workspace();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(canonical_root.clone());
        let state = Arc::new(DureIssueTrackerState::default());
        let stopped = Arc::new(AtomicBool::new(false));
        let policy_epoch = state
            .set_agent_claim_policy(
                &identity.plugin_id,
                &identity.contribution_id,
                canonical_root.clone(),
                true,
            )
            .unwrap();
        let subscription = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims", 1, true, Some(policy_epoch)),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        let retired_generation_guard = state
            .begin_agent_claim_execution(&identity, policy_epoch)
            .unwrap();
        assert!(state
            .unsubscribe(&identity, "main", "claims", 1, subscription.generation)
            .unwrap());
        assert!(!state.runtime.lock().unwrap().watchers.contains_key(&identity));
        let foreground_query_guard = state
            .begin_query_agent_claim_execution(
                &identity,
                &IssueTrackerQueryV1::AgentClaims {
                    statuses: vec!["in_progress".into()],
                    limit: 10,
                },
                Some(policy_epoch),
            )
            .unwrap()
            .expect("agent claim query must arm the shared fence");

        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let setter_state = Arc::clone(&state);
        let setter_identity = identity.clone();
        let setter = thread::spawn(move || {
            started_sender.send(()).unwrap();
            let result = setter_state.set_agent_claim_policy(
                &setter_identity.plugin_id,
                &setter_identity.contribution_id,
                canonical_root,
                false,
            );
            done_sender.send(result).unwrap();
        });
        started_receiver.recv().unwrap();
        assert!(done_receiver
            .recv_timeout(Duration::from_millis(20))
            .is_err());

        drop(retired_generation_guard);
        assert!(done_receiver
            .recv_timeout(Duration::from_millis(20))
            .is_err());
        drop(foreground_query_guard);
        assert_eq!(
            done_receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(policy_epoch + 1)
        );
        setter.join().unwrap();
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn last_unsubscribe_is_non_blocking_while_the_bounded_worker_retires() {
        let root = workspace();
        let identity = watcher_identity(fs::canonicalize(root.path()).unwrap());
        let state = DureIssueTrackerState::default();
        let subscription = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "issues:lease-1", 1, false, None),
                Duration::from_secs(5),
                |_, _, control| {
                    Ok(thread::spawn(move || {
                        let (mutex, changed) = &*control;
                        let mut guard = mutex.lock().unwrap();
                        while !guard.stop {
                            guard = changed.wait(guard).unwrap();
                        }
                        drop(guard);
                        thread::sleep(Duration::from_millis(200));
                    }))
                },
            )
            .unwrap();

        let started = Instant::now();
        assert!(state
            .unsubscribe(
                &identity,
                "main",
                "issues:lease-1",
                1,
                subscription.generation,
            )
            .unwrap());
        assert!(started.elapsed() < Duration::from_millis(100));
        let runtime = state.runtime.lock().unwrap();
        assert!(!runtime.watchers.contains_key(&identity));
        assert_eq!(runtime.retired_workers.len(), 1);
    }

    #[test]
    fn a_retired_logical_lease_never_reuses_its_generation() {
        let root = workspace();
        let identity = watcher_identity(fs::canonicalize(root.path()).unwrap());
        let state = DureIssueTrackerState::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let first = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims:first", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        assert!(state
            .unsubscribe(
                &identity,
                "main",
                "claims:first",
                1,
                first.generation,
            )
            .unwrap());

        let second = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "claims:second", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        assert!(second.generation > first.generation);
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

    #[test]
    fn finished_worker_restarts_within_the_existing_generation_and_keeps_subscribers() {
        let root = workspace();
        let root = fs::canonicalize(root.path()).unwrap();
        let identity = watcher_identity(root.clone());
        let state = DureIssueTrackerState::default();
        let first = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("main", "issues", 1, false, None),
                Duration::from_secs(5),
                |_, _, _| Ok(thread::spawn(|| {})),
            )
            .unwrap();
        state.runtime.lock().unwrap().watchers[&identity]
            .handle
            .thread()
            .unpark();
        while !state.runtime.lock().unwrap().watchers[&identity]
            .handle
            .is_finished()
        {
            thread::yield_now();
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let restarted = state
            .subscribe_with(
                identity.clone(),
                "workspace-1".into(),
                subscriber("desktop-2", "issues", 1, false, None),
                Duration::from_secs(5),
                wait_worker(Arc::clone(&stopped)),
            )
            .unwrap();
        assert_eq!(first.generation, 1);
        assert_eq!(restarted.generation, first.generation);
        assert!(!restarted.reused_watcher);
        assert_eq!(
            state.runtime.lock().unwrap().watchers[&identity]
                .subscribers
                .lock()
                .unwrap()
                .len(),
            2
        );
        assert!(state
            .unsubscribe(&identity, "main", "issues", 1, first.generation)
            .unwrap());
        stop_all(&state);
        stopped.store(true, Ordering::Relaxed);
    }

}
