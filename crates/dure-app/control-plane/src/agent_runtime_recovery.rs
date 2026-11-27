use std::collections::{BTreeMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dure_app::{
    AgentDispatchStopRecordV1, AgentDispatchStopStateV1, AgentDispatchStopStore, AgentIdV1,
    AgentInteractionProfileV1, AgentProviderRuntimeFenceV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseStateV1, AgentRuntimeDeferredTargetV1, AgentRuntimeTransitionStateV1,
    AgentRuntimeTransitionStore, AgentTimelineStore, OperationIdV1,
};
use futures_util::FutureExt;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::ServiceState;
use crate::agent_runtime_close_apply::CloseDriveOutcome;
use crate::agent_runtime_projection::{self, AgentRuntimeObservedV1};
use crate::agent_runtime_transition_apply::TransitionDriveOutcome;
use crate::structured_provider_runtime::StructuredProviderRuntimeErrorKindV1;

const AUTHORITY_RETRY: Duration = Duration::from_millis(100);
const RECOVERY_RETRY_MIN: Duration = Duration::from_millis(50);
/// A candidate that keeps failing on the same durable step is re-decided at
/// most this often. Each attempt may prepare credentials, read provider state
/// and start a Host, so an unbounded one-second retry of a step that cannot
/// converge kept the control plane busy with every Agent idle
/// (hebbianai/dure#621). The worker's own timer still ends every wait, so the
/// convergence contract below holds without a wake.
const RECOVERY_RETRY_MAX: Duration = Duration::from_secs(5 * 60);
/// A lifecycle operation whose drive failed after admission must converge
/// without an external kick: wakes are lossy (one notify is consumed per
/// scan), and an 'admitted' transition has no API that can move it. A stuck
/// chat-to-terminal switch once wedged an agent for 90+ minutes because no
/// further wake ever arrived (2026-08-31). Tests shorten the interval so the
/// convergence contract is provable in real time.
const RECOVERY_RESCAN_INTERVAL: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(30)
};

/// Restores selected structured runtimes once at startup, then owns recovery
/// for lifecycle operations admitted during this service lifetime. A converged
/// runtime is a candidate again only when input waits for it and no provider
/// takes it (`request_stable`). Dropping the coordinator aborts all child
/// tasks during control-plane shutdown.
pub(crate) async fn run(state: Arc<ServiceState>) {
    let mut active = HashSet::new();
    let mut workers = JoinSet::new();
    let wakes = RecoveryWakes::default();
    let candidates = wait_for_candidates(&state, &wakes, RecoveryScan::Startup).await;
    spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);

    loop {
        if workers.is_empty() {
            tokio::select! {
                () = wakes.notified(&state) => {}
                () = tokio::time::sleep(RECOVERY_RESCAN_INTERVAL) => {}
            }
            let candidates = wait_for_candidates(&state, &wakes, RecoveryScan::Incomplete).await;
            spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);
            continue;
        }
        tokio::select! {
            () = wakes.notified(&state) => {
                let candidates =
                    wait_for_candidates(&state, &wakes, RecoveryScan::Incomplete).await;
                spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);
            }
            () = tokio::time::sleep(RECOVERY_RESCAN_INTERVAL) => {
                let candidates =
                    wait_for_candidates(&state, &wakes, RecoveryScan::Incomplete).await;
                spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);
            }
            completed = workers.join_next() => {
                match completed {
                    Some(Ok(completed)) => {
                        active.remove(&completed.agent_id);
                        state.goal_wakeup.notify_one();
                        let candidates =
                            wait_for_candidates(&state, &wakes, RecoveryScan::Incomplete).await;
                        spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);
                    }
                    Some(Err(_)) => {
                        workers.abort_all();
                        while workers.join_next().await.is_some() {}
                        active.clear();
                        let candidates =
                            wait_for_candidates(&state, &wakes, RecoveryScan::Startup).await;
                        spawn_candidates(&state, &wakes, candidates, &mut active, &mut workers);
                    }
                    None => active.clear(),
                }
            }
        }
    }
}

/// Asks for the Agent's selected structured runtime to be relaunched: durable
/// input waits for it and no provider takes it, as when its provider process
/// ended (hebbianai/dure#777). The relaunch goes through `attach_existing`,
/// as a client's recover does, so input reaches an Agent no client watches;
/// its completion wakes the conversation loop to start the input.
pub(crate) async fn request_stable(state: &ServiceState, agent_id: &AgentIdV1) {
    // An unreadable binding asks nothing: the waiting input's next wake asks
    // again.
    let Ok(Some(binding)) = state.store.agent_interaction_for_agent(agent_id).await else {
        return;
    };
    if state
        .stable_runtime_requests
        .ask(agent_id, &binding.runtime)
    {
        state.agent_runtime_recovery_wake.notify_one();
    }
}

/// Asks for stable runtimes, from the conversation loop to this coordinator.
#[derive(Default)]
pub(crate) struct StableRuntimeRequests(Mutex<StableRuntimeRequestState>);

#[derive(Default)]
struct StableRuntimeRequestState {
    /// When each Agent was first asked for. An ask is answered by the first
    /// worker that starts after it: one already running may have decided
    /// before the provider ended.
    asked: BTreeMap<AgentIdV1, Instant>,
    /// The exact runtime an Agent's last answered ask left without a
    /// provider, and when. Asking again for it soon after could only repeat
    /// that outcome (a missing credential, a recorded launch failure) while
    /// each completion wakes the asker again, so it waits out the longest
    /// recovery backoff.
    unrecovered: BTreeMap<AgentIdV1, (AgentProviderRuntimeFenceV1, Instant)>,
}

impl StableRuntimeRequests {
    /// True when this ask is new: the coordinator has to be woken.
    fn ask(&self, agent_id: &AgentIdV1, runtime: &AgentProviderRuntimeFenceV1) -> bool {
        let Ok(mut requests) = self.0.lock() else {
            return false;
        };
        if requests
            .unrecovered
            .get(agent_id)
            .is_some_and(|(left, at)| left == runtime && at.elapsed() < RECOVERY_RETRY_MAX)
            || requests.asked.contains_key(agent_id)
        {
            return false;
        }
        requests.asked.insert(agent_id.clone(), Instant::now());
        true
    }

    /// Agents with an unanswered ask. They stay listed until answered.
    fn asked(&self) -> Vec<AgentIdV1> {
        self.0
            .lock()
            .map(|requests| requests.asked.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Whether a worker that started at `started` answers the Agent's ask.
    fn answers(&self, agent_id: &AgentIdV1, started: Instant) -> bool {
        self.0.lock().is_ok_and(|requests| {
            requests
                .asked
                .get(agent_id)
                .is_some_and(|asked| *asked <= started)
        })
    }

    fn answer(
        &self,
        agent_id: &AgentIdV1,
        started: Instant,
        unrecovered: Option<AgentProviderRuntimeFenceV1>,
    ) {
        let Ok(mut requests) = self.0.lock() else {
            return;
        };
        if !requests
            .asked
            .get(agent_id)
            .is_some_and(|asked| *asked <= started)
        {
            return;
        }
        requests.asked.remove(agent_id);
        match unrecovered {
            Some(runtime) => {
                requests
                    .unrecovered
                    .insert(agent_id.clone(), (runtime, Instant::now()));
            }
            None => {
                requests.unrecovered.remove(agent_id);
            }
        }
    }
}

/// Answers an ask the finished worker covers, recording whether it left the
/// Agent's conversation with a provider that takes its input.
async fn answer_stable_request(state: &ServiceState, agent_id: &AgentIdV1, started: Instant) {
    if !state.stable_runtime_requests.answers(agent_id, started) {
        return;
    }
    let unrecovered = match state.store.agent_interaction_for_agent(agent_id).await {
        Ok(Some(binding)) if state.agent_conversation_runtimes.resolve(&binding).is_err() => {
            Some(binding.runtime)
        }
        _ => None,
    };
    state
        .stable_runtime_requests
        .answer(agent_id, started, unrecovered);
}

/// The coordinator consumes each lossy service wake once and fans it out to
/// its workers. A worker waiting out a failure re-decides only when the wake
/// changed its own durable step.
struct RecoveryWakes(watch::Sender<()>);

impl Default for RecoveryWakes {
    fn default() -> Self {
        Self(watch::channel(()).0)
    }
}

impl RecoveryWakes {
    async fn notified(&self, state: &ServiceState) {
        state.agent_runtime_recovery_wake.notified().await;
        self.0.send_replace(());
    }

    fn subscribe(&self) -> watch::Receiver<()> {
        self.0.subscribe()
    }
}

#[derive(Clone, Copy)]
enum RecoveryScan {
    Startup,
    Incomplete,
}

struct RecoveryWorkerCompletion {
    agent_id: String,
}

async fn wait_for_candidates(
    state: &ServiceState,
    wakes: &RecoveryWakes,
    scan: RecoveryScan,
) -> Vec<AgentIdV1> {
    loop {
        if !state.is_mutation_authority() {
            tokio::select! {
                () = tokio::time::sleep(AUTHORITY_RETRY) => {}
                () = wakes.notified(state) => {}
            }
            continue;
        }
        let parent_candidates = state.store.agent_dispatch_stop_recovery_candidates().await;
        let runtime_candidates = match scan {
            RecoveryScan::Startup => {
                state
                    .store
                    .agent_runtime_startup_recovery_candidates()
                    .await
            }
            RecoveryScan::Incomplete => {
                state
                    .store
                    .agent_runtime_incomplete_recovery_candidates()
                    .await
            }
        };
        match (parent_candidates, runtime_candidates) {
            (Ok(mut parents), Ok(runtime)) => {
                let mut seen = parents
                    .iter()
                    .map(|agent_id| agent_id.as_str().to_owned())
                    .collect::<HashSet<_>>();
                parents.extend(
                    runtime
                        .into_iter()
                        .chain(state.stable_runtime_requests.asked())
                        .filter(|agent_id| seen.insert(agent_id.as_str().to_owned())),
                );
                return parents;
            }
            (Err(_), _) | (_, Err(_)) => {
                tokio::select! {
                    () = tokio::time::sleep(RECOVERY_RETRY_MIN) => {}
                    () = wakes.notified(state) => {}
                }
            }
        }
    }
}

fn spawn_candidates(
    state: &Arc<ServiceState>,
    wakes: &RecoveryWakes,
    candidates: Vec<AgentIdV1>,
    active: &mut HashSet<String>,
    workers: &mut JoinSet<RecoveryWorkerCompletion>,
) {
    for agent_id in candidates {
        let key = agent_id.as_str().to_owned();
        if !active.insert(key.clone()) {
            continue;
        }
        let worker_state = Arc::clone(state);
        let worker_wakes = wakes.subscribe();
        workers.spawn(async move {
            let started = Instant::now();
            recover_agent(Arc::clone(&worker_state), agent_id.clone(), worker_wakes).await;
            answer_stable_request(&worker_state, &agent_id, started).await;
            RecoveryWorkerCompletion { agent_id: key }
        });
    }
}

async fn recover_agent(
    state: Arc<ServiceState>,
    agent_id: AgentIdV1,
    mut wakes: watch::Receiver<()>,
) {
    let mut backoff = RecoveryBackoff::default();
    loop {
        if !state.is_mutation_authority() {
            tokio::time::sleep(AUTHORITY_RETRY).await;
            continue;
        }

        let outcome = AssertUnwindSafe(async {
            let agent_guard = state.agent_operations.acquire(&agent_id).await;
            if !state.is_mutation_authority() {
                Err(None)
            } else {
                recover_locked(&state, &agent_id, agent_guard).await
            }
        })
        .catch_unwind()
        .await
        .unwrap_or(Err(None));
        match outcome {
            Ok(RecoveryStep::Complete) => return,
            Ok(RecoveryStep::Continue) => backoff = RecoveryBackoff::default(),
            Err(subject) => {
                let retry_at = Instant::now() + backoff.failed(subject);
                wait_for_retry(&state, &agent_id, &backoff, &mut wakes, retry_at).await;
            }
        }
    }
}

/// Sleep out a failure's backoff. A wake ends it early only when the Agent's
/// durable step is no longer the one that failed: repeating provider or Host
/// effects for an unrelated wake cannot change their outcome.
async fn wait_for_retry(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    backoff: &RecoveryBackoff,
    wakes: &mut watch::Receiver<()>,
    retry_at: Instant,
) {
    loop {
        tokio::select! {
            () = tokio::time::sleep_until(retry_at) => return,
            Ok(()) = wakes.changed() => {
                let _agent_guard = state.agent_operations.acquire(agent_id).await;
                let observed = observe_locked(state, agent_id)
                    .await
                    .ok()
                    .map(|observation| observation.subject());
                if backoff.superseded_by(observed.as_ref()) {
                    return;
                }
            }
        }
    }
}

/// Consecutive failures on one durable step double the wait up to
/// `RECOVERY_RETRY_MAX`. A failure on another step starts over; a failure
/// that could not read its step counts against the current one.
#[derive(Default)]
struct RecoveryBackoff {
    subject: Option<RecoverySubject>,
    delay: Option<Duration>,
}

impl RecoveryBackoff {
    fn failed(&mut self, subject: Option<RecoverySubject>) -> Duration {
        if let Some(subject) = subject
            && self.subject.as_ref() != Some(&subject)
        {
            self.subject = Some(subject);
            self.delay = None;
        }
        let delay = self.delay.map_or(RECOVERY_RETRY_MIN, |delay| {
            (delay * 2).min(RECOVERY_RETRY_MAX)
        });
        self.delay = Some(delay);
        delay
    }

    fn superseded_by(&self, observed: Option<&RecoverySubject>) -> bool {
        observed.is_some_and(|observed| self.subject.as_ref() != Some(observed))
    }
}

/// The durable step an attempt decided: one operation in one phase. Phases
/// are finite and advance only through journal writes, so restarting the
/// backoff when the step changes cannot by itself keep a candidate hot.
#[derive(Debug, Eq, PartialEq)]
enum RecoverySubject {
    DispatchStop(OperationIdV1),
    Close(OperationIdV1, AgentRuntimeCloseStateV1),
    Transition {
        operation_id: OperationIdV1,
        state: AgentRuntimeTransitionStateV1,
        deferred_target: Option<AgentRuntimeDeferredTargetV1>,
    },
    Stable(i64),
    Unmanaged,
}

/// What recovery drives for one Agent: an authorized parent stop first,
/// otherwise the newest durable runtime state.
enum RecoveryObservation {
    DispatchStop(Box<AgentDispatchStopRecordV1>),
    Runtime(AgentRuntimeObservedV1),
}

impl RecoveryObservation {
    fn subject(&self) -> RecoverySubject {
        match self {
            Self::DispatchStop(stop) => {
                RecoverySubject::DispatchStop(stop.plan().operation_id().clone())
            }
            Self::Runtime(AgentRuntimeObservedV1::Unmanaged) => RecoverySubject::Unmanaged,
            Self::Runtime(AgentRuntimeObservedV1::Closed { close, .. }) => {
                RecoverySubject::Close(close.intent.operation_id.clone(), close.state)
            }
            Self::Runtime(AgentRuntimeObservedV1::Transitioning { transition, .. }) => {
                RecoverySubject::Transition {
                    operation_id: transition.intent.operation_id.clone(),
                    state: transition.state,
                    deferred_target: transition.deferred_target.clone(),
                }
            }
            Self::Runtime(AgentRuntimeObservedV1::Stable { selection, .. }) => {
                RecoverySubject::Stable(selection.revision)
            }
        }
    }
}

async fn observe_locked(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<RecoveryObservation, ()> {
    if let Some(stop) = state
        .store
        .active_agent_dispatch_stop(agent_id)
        .await
        .map_err(|_| ())?
        && matches!(stop.state(), AgentDispatchStopStateV1::Authorized { .. })
    {
        return Ok(RecoveryObservation::DispatchStop(Box::new(stop)));
    }
    agent_runtime_projection::read_locked(state, agent_id)
        .await
        .map(RecoveryObservation::Runtime)
        .map_err(|_| ())
}

enum RecoveryStep {
    Continue,
    Complete,
}

/// One attempt. A failure names the step it decided, or none when the step
/// could not be read.
async fn recover_locked(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    agent_guard: tokio::sync::OwnedMutexGuard<()>,
) -> Result<RecoveryStep, Option<RecoverySubject>> {
    let observation = observe_locked(state, agent_id).await.map_err(|()| None)?;
    let subject = observation.subject();
    drive_observed(state, agent_id, agent_guard, observation)
        .await
        .map_err(|()| Some(subject))
}

async fn drive_observed(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    agent_guard: tokio::sync::OwnedMutexGuard<()>,
    observation: RecoveryObservation,
) -> Result<RecoveryStep, ()> {
    let observed = match observation {
        RecoveryObservation::DispatchStop(stop) => {
            return super::agent_dispatch_stop_apply::drive_locked(state, &stop, agent_guard)
                .await
                .map(|_| RecoveryStep::Continue)
                .map_err(|_| ());
        }
        RecoveryObservation::Runtime(observed) => observed,
    };
    let _agent_guard = agent_guard;
    match observed {
        AgentRuntimeObservedV1::Unmanaged => {
            if let Some(record) = state
                .store
                .agent_runtime_checkout(agent_id)
                .await
                .map_err(|_| ())?
                && record.admission == dure_app::SessionCheckoutAdmissionV1::Closing
            {
                dure_session_runtime::CheckoutSessionRuntime::at_root(
                    state.store.as_ref().clone(),
                    state.hmux_identity.runtime_executable_path.clone(),
                    state.hmux_identity.discovery_root.clone(),
                )
                .map_err(|_| ())?
                .close_agent_registration(record.binding)
                .await
                .map_err(|_| ())?;
            }
            Ok(RecoveryStep::Complete)
        }
        AgentRuntimeObservedV1::Closed { close, .. } => {
            if close.state == AgentRuntimeCloseStateV1::Stopped {
                super::agent_runtime_remove_apply::finish_locked(state, &close)
                    .await
                    .map_err(|_| ())?;
                return Ok(RecoveryStep::Complete);
            }
            match super::agent_runtime_close_apply::drive_locked(state, &close).await {
                Ok(CloseDriveOutcome::Stopped) | Ok(CloseDriveOutcome::SourceRetained) => {
                    Ok(RecoveryStep::Continue)
                }
                Err(_) => Err(()),
            }
        }
        AgentRuntimeObservedV1::Transitioning { transition, .. } => {
            match super::agent_runtime_transition_apply::drive_locked(state, *transition).await {
                Ok(TransitionDriveOutcome::Committed(_)) => Ok(RecoveryStep::Continue),
                Ok(TransitionDriveOutcome::SourceRetained) => Ok(RecoveryStep::Continue),
                Ok(TransitionDriveOutcome::RepairRequired)
                | Ok(TransitionDriveOutcome::Deferred)
                | Ok(TransitionDriveOutcome::Superseded) => Ok(RecoveryStep::Complete),
                Err(_) => Err(()),
            }
        }
        AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => match (selection.interaction_profile, *authority) {
            (
                AgentInteractionProfileV1::StructuredProtocol,
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            ) => {
                let runtime = state
                    .structured_runtimes
                    .resolve(&selection.provider_id)
                    .ok_or(())?;
                let attached = match runtime.attach_existing(&selection, &binding).await {
                    Ok(attached) => attached,
                    // Credential authority cannot change on a recovery timer. A
                    // credential/profile switch re-enters through the journaled
                    // runtime transition path with its new exact authority.
                    Err(error)
                        if matches!(
                            error.kind,
                            StructuredProviderRuntimeErrorKindV1::CredentialUnavailable
                                | StructuredProviderRuntimeErrorKindV1::CredentialStale
                                | StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired
                        ) =>
                    {
                        return Ok(RecoveryStep::Complete);
                    }
                    Err(_) => return Err(()),
                };
                if attached == binding {
                    return Ok(RecoveryStep::Complete);
                }
                match agent_runtime_projection::read_locked(state, agent_id)
                    .await
                    .map_err(|_| ())?
                {
                    AgentRuntimeObservedV1::Stable {
                        selection: current_selection,
                        authority: current_authority,
                    } if *current_selection == *selection
                        && matches!(
                            &*current_authority,
                            AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                                binding: current_binding,
                            } if current_binding == &attached
                        ) =>
                    {
                        Ok(RecoveryStep::Complete)
                    }
                    _ => Err(()),
                }
            }
            (
                AgentInteractionProfileV1::NativeCli,
                AgentRuntimeBindingAuthorityV1::NativeCli { .. },
            ) => Ok(RecoveryStep::Complete),
            _ => Err(()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close_step(state: AgentRuntimeCloseStateV1) -> RecoverySubject {
        RecoverySubject::Close(OperationIdV1::new("close-backoff").unwrap(), state)
    }

    #[test]
    fn backoff_grows_on_one_step_and_restarts_when_the_step_changes() {
        let mut backoff = RecoveryBackoff::default();
        let delays = (0..16)
            .map(|_| backoff.failed(Some(close_step(AgentRuntimeCloseStateV1::Admitted))))
            .collect::<Vec<_>>();
        assert_eq!(
            delays[..7],
            [50, 100, 200, 400, 800, 1_600, 3_200].map(Duration::from_millis)
        );
        assert_eq!(delays.last(), Some(&RECOVERY_RETRY_MAX));
        assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]));

        // A failure that could not read its step counts against the current one.
        assert_eq!(backoff.failed(None), RECOVERY_RETRY_MAX);
        assert!(!backoff.superseded_by(None));
        assert!(!backoff.superseded_by(Some(&close_step(AgentRuntimeCloseStateV1::Admitted))));

        let advanced = close_step(AgentRuntimeCloseStateV1::Stopped);
        assert!(backoff.superseded_by(Some(&advanced)));
        assert_eq!(backoff.failed(Some(advanced)), RECOVERY_RETRY_MIN);
    }

    #[test]
    fn an_ask_is_answered_only_by_a_worker_that_started_after_it() {
        let agent = AgentIdV1::new("agent-asked").unwrap();
        let runtime = |generation: &str| AgentProviderRuntimeFenceV1 {
            runtime_generation: generation.into(),
            provider_epoch: format!("{generation}-epoch"),
        };
        let requests = StableRuntimeRequests::default();
        let before_ask = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        assert!(requests.ask(&agent, &runtime("runtime-1")));
        assert!(
            !requests.ask(&agent, &runtime("runtime-1")),
            "an unanswered ask does not wake the coordinator again"
        );

        // A worker already running may have decided before the provider
        // ended: the ask stays listed for a worker of its own.
        requests.answer(&agent, before_ask, Some(runtime("runtime-1")));
        assert_eq!(requests.asked(), std::slice::from_ref(&agent));

        // The next worker answers it. Asking again for the runtime it left
        // without a provider would only repeat that outcome.
        let started = Instant::now();
        assert!(requests.answers(&agent, started));
        requests.answer(&agent, started, Some(runtime("runtime-1")));
        assert!(requests.asked().is_empty());
        assert!(!requests.ask(&agent, &runtime("runtime-1")));

        // Another runtime, or a recovery that left a provider, is asked for.
        assert!(requests.ask(&agent, &runtime("runtime-2")));
        requests.answer(&agent, Instant::now(), None);
        assert!(requests.ask(&agent, &runtime("runtime-2")));
    }
}
