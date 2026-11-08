//! Keeps schedule-started agents and their checkouts from piling up. Nobody is
//! watching these agents, so this applies whatever the user-facing idle setting
//! says. Every stop goes through fenced hibernation, and every removal through
//! the Git checkout authority.
use std::path::PathBuf;

use dure_app::{
    AgentIdV1, AgentRuntimeCloseStateV1, AgentSpawnJournalReceiptV1, AgentSpawnJournalStore,
    AgentSpawnWorktreePolicyV1, DomainStore, GitCheckoutRegistrationV1, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalRequestV1,
};
use dure_git_checkout::{
    GitCheckoutInstanceError, GitCheckoutRemovalOperation, capture_git_checkout_registration,
    git_checkout_is_disposable, read_git_checkout_claims,
};

use super::*;
use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use crate::agent_runtime_transition_apply::deferred::idle::hibernate_if_host_idle;
use crate::workspace_git::{WorkspaceAcquireRequest, restore_owned_checkout};

const IDLE_AFTER: Duration = Duration::from_secs(30 * 60);
const SCAN_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_PAGE: usize = 64;
// A kept checkout is checked again on every cycle, and each check runs Git.
const CHECKOUT_PAGE: usize = 8;
const CHECKOUT_SCAN_EVERY: u32 = 2;
const AUTOMATION_BRANCH_PREFIX: &str = "automation-";
// The user-facing policy never persists revision 0, so an attempt made here
// cannot share an identity with one made under that policy.
const IDLE_POLICY_REVISION: u64 = 0;

pub(crate) async fn run_loop(state: Arc<ServiceState>) {
    let mut timer = tokio::time::interval(SCAN_INTERVAL);
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let (mut idle_cursor, mut checkout_cursor) = (None, None);
    let mut ticks: u32 = 0;
    loop {
        timer.tick().await;
        if !state.is_mutation_authority() {
            (idle_cursor, checkout_cursor) = (None, None);
            continue;
        }
        idle_cursor = hibernate_idle_page(&state, idle_cursor, IDLE_AFTER).await;
        if ticks % CHECKOUT_SCAN_EVERY == 0 {
            checkout_cursor = remove_finished_checkouts_page(&state, checkout_cursor).await;
        }
        ticks = ticks.wrapping_add(1);
    }
}

pub(crate) async fn hibernate_idle_page(
    state: &ServiceState,
    after: Option<OperationIdV1>,
    idle_after: Duration,
) -> Option<OperationIdV1> {
    let page = state
        .store
        .scheduled_agent_spawns(after.as_ref(), IDLE_PAGE)
        .await
        .ok()?;
    for (_, agent_id) in &page {
        // Refusals are retried by interval and recorded by the transition journal.
        let _ = hibernate_if_host_idle(state, agent_id, IDLE_POLICY_REVISION, idle_after).await;
    }
    next_cursor(page, IDLE_PAGE)
}

pub(crate) async fn remove_finished_checkouts_page(
    state: &ServiceState,
    after: Option<OperationIdV1>,
) -> Option<OperationIdV1> {
    let page = state
        .store
        .scheduled_agent_spawns(after.as_ref(), CHECKOUT_PAGE)
        .await
        .ok()?;
    for (operation, agent_id) in &page {
        remove_finished_checkout(state, operation, agent_id).await;
    }
    next_cursor(page, CHECKOUT_PAGE)
}

fn next_cursor(page: Vec<(OperationIdV1, AgentIdV1)>, limit: usize) -> Option<OperationIdV1> {
    if page.len() < limit {
        return None;
    }
    page.into_iter().last().map(|(operation, _)| operation)
}

async fn remove_finished_checkout(
    state: &ServiceState,
    operation: &OperationIdV1,
    agent_id: &AgentIdV1,
) {
    let Some((_, branch, checkout)) = owned_checkout(state, operation).await else {
        return;
    };
    if !checkout.is_dir() {
        return;
    }
    // Held through removal, so a wake cannot start in a checkout being removed.
    let Ok(_guard) = tokio::time::timeout(
        Duration::from_secs(1),
        state.agent_operations.acquire(agent_id),
    )
    .await
    else {
        return;
    };
    if runtime_is_stopped(state, agent_id).await {
        remove_checkout_if_disposable(state, operation, checkout, branch).await;
    }
}

/// Only a recorded stop counts. An unreachable runtime proves nothing.
async fn runtime_is_stopped(state: &ServiceState, agent_id: &AgentIdV1) -> bool {
    state.is_mutation_authority()
        && match read_locked(state, agent_id).await {
            Ok(AgentRuntimeObservedV1::Transitioning { transition, .. }) => transition.is_dormant(),
            Ok(AgentRuntimeObservedV1::Closed(close)) => {
                close.state == AgentRuntimeCloseStateV1::Stopped
            }
            _ => false,
        }
}

async fn owned_checkout(
    state: &ServiceState,
    operation: &OperationIdV1,
) -> Option<(AgentSpawnJournalReceiptV1, String, PathBuf)> {
    let spawn = state.store.agent_spawn_receipt(operation).await.ok()??;
    let AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } = &spawn.plan.request.worktree else {
        return None;
    };
    if !branch.starts_with(AUTOMATION_BRANCH_PREFIX) {
        return None;
    }
    let branch = branch.clone();
    let workspace = state
        .store
        .workspace(&spawn.plan.workspace_id)
        .await
        .ok()??;
    Some((spawn, branch, PathBuf::from(workspace.root_path)))
}

pub(crate) async fn remove_checkout_if_disposable(
    state: &ServiceState,
    operation: &OperationIdV1,
    checkout: PathBuf,
    branch: String,
) -> bool {
    let registration = tokio::task::spawn_blocking(
        move || -> Result<Option<GitCheckoutRegistrationV1>, GitCheckoutInstanceError> {
            if !git_checkout_is_disposable(&checkout, &branch)? {
                return Ok(None);
            }
            capture_git_checkout_registration(&checkout)
        },
    )
    .await;
    let Ok(Ok(Some(registration))) = registration else {
        return false;
    };
    // The stopped session's own claim is released here; any other live user
    // keeps its claim and refuses the removal permit below.
    if dure_session_runtime::reconcile_checkout_users(
        state.store.as_ref().clone(),
        state.hmux_identity.runtime_executable_path.clone(),
        state.hmux_identity.discovery_root.clone(),
        registration.clone(),
    )
    .await
    .is_err()
    {
        return false;
    }
    let operation = operation.clone();
    matches!(
        tokio::task::spawn_blocking(move || remove_registered(&registration, &operation)).await,
        Ok(Ok(()))
    )
}

fn remove_registered(
    registration: &GitCheckoutRegistrationV1,
    spawn: &OperationIdV1,
) -> Result<(), GitCheckoutInstanceError> {
    let request = GitCheckoutRemovalRequestV1 {
        repository_path: registration.repository_path.clone(),
        instance: registration.instance.clone(),
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let removal_id = cleanup_operation_id(spawn, &registration.instance.instance_token);
    let restore_prefix = restore_claim_prefix(spawn);
    // The spawn's claim, or the claim a wake took when it restored this checkout.
    let own_claim = read_git_checkout_claims(registration)?
        .into_iter()
        .map(|claim| claim.claim_id)
        .find(|id| id == spawn || id.as_str().starts_with(&restore_prefix));
    let removal = || {
        GitCheckoutRemovalOperation::new(&request, &removal_id).map(|operation| match &own_claim {
            Some(claim) => operation.retiring_registration(claim),
            None => operation,
        })
    };
    let admitted = removal()?.admit()?;
    admitted.remove().map(|_| ()).inspect_err(|_| {
        // Keep the checkout usable: release the permit so a wake is not refused.
        let _ = removal().and_then(GitCheckoutRemovalOperation::abort);
    })
}

/// A woken agent resumes in its original folder, so bring back a checkout this
/// module removed. Commits and branch are intact because removal required that.
pub(crate) async fn restore_checkout_for_wake(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    transition: &OperationIdV1,
) -> Result<(), String> {
    const UNAVAILABLE: &str = "agent_runtime_workspace_unavailable";
    let Some(operation) = state
        .store
        .scheduled_spawn_for_agent(agent_id)
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?
    else {
        return Ok(());
    };
    let Some((spawn, _, checkout)) = owned_checkout(state, &operation).await else {
        return Ok(());
    };
    if checkout.exists() {
        return Ok(());
    }
    let catalog = crate::projects_catalog(state)
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?;
    let project = catalog
        .project(spawn.plan.authority.project_id.as_str())
        .ok_or_else(|| UNAVAILABLE.to_owned())?;
    let registration_id = OperationIdV1::new(format!(
        "{}-{}",
        restore_claim_prefix(&operation),
        short_digest(transition.as_str()),
    ))
    .map_err(|_| UNAVAILABLE.to_owned())?;
    let restored = restore_owned_checkout(WorkspaceAcquireRequest {
        project_root: project.root().to_path_buf(),
        workspace_id: spawn.plan.workspace_id.clone(),
        registration_id,
        registration: None,
        policy: spawn.plan.request.worktree.clone(),
    })
    .await
    .map_err(|failure| failure.code)?;
    if restored == checkout {
        Ok(())
    } else {
        Err(UNAVAILABLE.to_owned())
    }
}

fn short_digest(value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    digest[..32].to_owned()
}

fn restore_claim_prefix(spawn: &OperationIdV1) -> String {
    format!("schedule-restore-{}", short_digest(spawn.as_str()))
}

fn cleanup_operation_id(spawn: &OperationIdV1, instance_token: &str) -> OperationIdV1 {
    OperationIdV1::new(format!(
        "schedule-checkout-cleanup-{}",
        short_digest(&format!("{}\0{instance_token}", spawn.as_str())),
    ))
    .expect("a fixed prefix and hex digest form a valid operation id")
}
