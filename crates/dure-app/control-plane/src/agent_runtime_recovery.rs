use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use dure_app::{
    AgentDispatchStopStateV1, AgentDispatchStopStore, AgentIdV1, AgentInteractionProfileV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseStateV1, AgentRuntimeTransitionStore,
};
use futures_util::FutureExt;
use tokio::task::JoinSet;

use crate::ServiceState;
use crate::agent_runtime_close_apply::CloseDriveOutcome;
use crate::agent_runtime_projection::{self, AgentRuntimeObservedV1};
use crate::agent_runtime_transition_apply::TransitionDriveOutcome;
use crate::structured_provider_runtime::StructuredProviderRuntimeErrorKindV1;

const AUTHORITY_RETRY: Duration = Duration::from_millis(100);
const RECOVERY_RETRY_MIN: Duration = Duration::from_millis(50);
const RECOVERY_RETRY_MAX: Duration = Duration::from_secs(1);
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
/// runtime is not a recurring recovery candidate. Dropping the coordinator
/// aborts all child tasks during control-plane shutdown.
pub(crate) async fn run(state: Arc<ServiceState>) {
    let mut active = HashSet::new();
    let mut workers = JoinSet::new();
    let candidates = wait_for_candidates(&state, RecoveryScan::Startup).await;
    spawn_candidates(&state, candidates, &mut active, &mut workers);

    loop {
        if workers.is_empty() {
            tokio::select! {
                () = state.agent_runtime_recovery_wake.notified() => {}
                () = tokio::time::sleep(RECOVERY_RESCAN_INTERVAL) => {}
            }
            let candidates = wait_for_candidates(&state, RecoveryScan::Incomplete).await;
            spawn_candidates(&state, candidates, &mut active, &mut workers);
            continue;
        }
        tokio::select! {
            () = state.agent_runtime_recovery_wake.notified() => {
                let candidates = wait_for_candidates(&state, RecoveryScan::Incomplete).await;
                spawn_candidates(&state, candidates, &mut active, &mut workers);
            }
            () = tokio::time::sleep(RECOVERY_RESCAN_INTERVAL) => {
                let candidates = wait_for_candidates(&state, RecoveryScan::Incomplete).await;
                spawn_candidates(&state, candidates, &mut active, &mut workers);
            }
            completed = workers.join_next() => {
                match completed {
                    Some(Ok(completed)) => {
                        active.remove(&completed.agent_id);
                        state.goal_wakeup.notify_one();
                        let candidates =
                            wait_for_candidates(&state, RecoveryScan::Incomplete).await;
                        spawn_candidates(&state, candidates, &mut active, &mut workers);
                    }
                    Some(Err(_)) => {
                        workers.abort_all();
                        while workers.join_next().await.is_some() {}
                        active.clear();
                        let candidates =
                            wait_for_candidates(&state, RecoveryScan::Startup).await;
                        spawn_candidates(&state, candidates, &mut active, &mut workers);
                    }
                    None => active.clear(),
                }
            }
        }
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

async fn wait_for_candidates(state: &ServiceState, scan: RecoveryScan) -> Vec<AgentIdV1> {
    loop {
        if !state.is_mutation_authority() {
            tokio::select! {
                () = tokio::time::sleep(AUTHORITY_RETRY) => {}
                () = state.agent_runtime_recovery_wake.notified() => {}
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
                        .filter(|agent_id| seen.insert(agent_id.as_str().to_owned())),
                );
                return parents;
            }
            (Err(_), _) | (_, Err(_)) => {
                tokio::select! {
                    () = tokio::time::sleep(RECOVERY_RETRY_MIN) => {}
                    () = state.agent_runtime_recovery_wake.notified() => {}
                }
            }
        }
    }
}

fn spawn_candidates(
    state: &Arc<ServiceState>,
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
        workers.spawn(async move {
            recover_agent(worker_state, agent_id).await;
            RecoveryWorkerCompletion { agent_id: key }
        });
    }
}

async fn recover_agent(state: Arc<ServiceState>, agent_id: AgentIdV1) {
    let mut retry_delay = RECOVERY_RETRY_MIN;
    loop {
        if !state.is_mutation_authority() {
            tokio::time::sleep(AUTHORITY_RETRY).await;
            continue;
        }

        let outcome = AssertUnwindSafe(async {
            let agent_guard = state.agent_operations.acquire(&agent_id).await;
            if !state.is_mutation_authority() {
                Err(())
            } else {
                recover_locked(&state, &agent_id, agent_guard).await
            }
        })
        .catch_unwind()
        .await
        .unwrap_or(Err(()));
        match outcome {
            Ok(RecoveryStep::Complete) => return,
            Ok(RecoveryStep::Continue) => retry_delay = RECOVERY_RETRY_MIN,
            Err(()) => {
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(RECOVERY_RETRY_MAX);
            }
        }
    }
}

enum RecoveryStep {
    Continue,
    Complete,
}

async fn recover_locked(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    agent_guard: tokio::sync::OwnedMutexGuard<()>,
) -> Result<RecoveryStep, ()> {
    if let Some(stop) = state
        .store
        .active_agent_dispatch_stop(agent_id)
        .await
        .map_err(|_| ())?
        && matches!(stop.state(), AgentDispatchStopStateV1::Authorized { .. })
    {
        return super::agent_dispatch_stop_apply::drive_locked(state, &stop, agent_guard)
            .await
            .map(|_| RecoveryStep::Continue)
            .map_err(|_| ());
    }
    let _agent_guard = agent_guard;
    match agent_runtime_projection::read_locked(state, agent_id)
        .await
        .map_err(|_| ())?
    {
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
        AgentRuntimeObservedV1::Closed(close) => {
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
