use super::*;
use crate::agent_runtime_close_apply::{self, CloseDriveOutcome};
use dure_app::{
    AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1, AgentSpawnJournalReceiptV1,
    GitCheckoutCaptureRequestV1, WorkspaceIdV1,
};
use dure_git_checkout::{
    AdmittedGitCheckoutRemoval, GitCheckoutRemovalFailureDisposition, GitCheckoutRemovalOperation,
    capture_git_checkout_instance, release_git_checkout_registration,
};

pub(super) async fn owned_request(
    state: &ServiceState,
    spawn: &AgentSpawnJournalReceiptV1,
    workspace_id: &WorkspaceIdV1,
    guard: OwnedMutexGuard<()>,
) -> Result<(GitCheckoutRemovalRequestV1, OwnedMutexGuard<()>), BackendDispatchError> {
    if let Some(registration) = &spawn.checkout_registration {
        return Ok((
            GitCheckoutRemovalRequestV1 {
                repository_path: registration.repository_path.clone(),
                instance: registration.instance.clone(),
                policy: GitCheckoutRemovalPolicyV1::RequireClean,
            },
            guard,
        ));
    }
    // Legacy spawns predate exact registration evidence. Preserve their original
    // capture path; registered spawns never adopt a replacement from this projection.
    let workspace = state
        .store
        .workspace(workspace_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| terminal("agent_dispatch_stop_ownership_unsupported"))?;
    let catalog = crate::projects_catalog(state)
        .await
        .map_err(|_| retry("agent_dispatch_stop_project_unavailable"))?;
    let project = catalog
        .project(spawn.plan.authority.project_id.as_str())
        .ok_or_else(|| terminal("agent_dispatch_stop_ownership_unsupported"))?;
    crate::project_catalog::validate_project_root(&project)
        .map_err(|_| conflict("agent_dispatch_stop_project_conflict"))?;
    crate::agent_spawn_apply::validate_project_authority(spawn, &project)
        .map_err(|_| conflict("agent_dispatch_stop_project_conflict"))?;
    if workspace.project_id != spawn.plan.authority.project_id {
        return Err(terminal("agent_dispatch_stop_ownership_unsupported"));
    }
    let capture = GitCheckoutCaptureRequestV1 {
        repository_path: project.root().to_string_lossy().into_owned(),
        checkout_path: workspace.root_path,
    };
    let repository_path = capture.repository_path.clone();
    let (guard, instance) =
        tokio::task::spawn_blocking(move || (guard, capture_git_checkout_instance(&capture)))
            .await
            .map_err(|_| retry("agent_dispatch_stop_checkout_unavailable"))?;
    Ok((
        GitCheckoutRemovalRequestV1 {
            repository_path,
            instance: instance.map_err(capture_error)?,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        guard,
    ))
}

enum CheckoutAdmission {
    Preserve,
    Remove(Box<AdmittedGitCheckoutRemoval>),
    Replaced,
}

fn is_replacement(error: &GitCheckoutInstanceError) -> bool {
    error.removal_failure_disposition() == GitCheckoutRemovalFailureDisposition::CheckoutReplaced
}

fn removal_operation(
    stop: &AgentDispatchStopRecordV1,
    checkout: &GitCheckoutRemovalRequestV1,
) -> Result<GitCheckoutRemovalOperation, GitCheckoutInstanceError> {
    let operation = GitCheckoutRemovalOperation::new(checkout, stop.plan().operation_id())?;
    Ok(if stop.plan().spawn().checkout_registration.is_some() {
        operation.retiring_registration(&stop.plan().spawn().operation_id)
    } else {
        operation
    })
}

fn admit(
    stop: &AgentDispatchStopRecordV1,
    close_state: AgentRuntimeCloseStateV1,
) -> Result<CheckoutAdmission, GitCheckoutInstanceError> {
    match stop.plan().workspace_plan() {
        AgentDispatchStopWorkspacePlanV1::Preserve => Ok(CheckoutAdmission::Preserve),
        AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout } => {
            // Older backends acquired a legacy permit only after committing the stop.
            let removal =
                removal_operation(stop, checkout).and_then(|operation| match close_state {
                    AgentRuntimeCloseStateV1::Stopped => operation.resume(),
                    _ => operation.admit(),
                });
            match removal {
                Ok(removal) => Ok(CheckoutAdmission::Remove(Box::new(removal))),
                Err(error) if is_replacement(&error) => Ok(CheckoutAdmission::Replaced),
                Err(error) => Err(error),
            }
        }
    }
}

async fn with_checkout<T: Send + 'static>(
    guard: OwnedMutexGuard<()>,
    action: impl FnOnce() -> Result<T, GitCheckoutInstanceError> + Send + 'static,
) -> Result<(T, OwnedMutexGuard<()>), BackendDispatchError> {
    let (guard, result) = tokio::task::spawn_blocking(move || (guard, action()))
        .await
        .map_err(|_| retry("agent_dispatch_stop_checkout_unavailable"))?;
    let result = result.map_err(|error| match error.code {
        "checkout_use_in_use" => retry("checkout_use_in_use"),
        _ => retry("agent_dispatch_stop_checkout_unavailable"),
    })?;
    Ok((result, guard))
}

pub(super) async fn drive(
    state: &ServiceState,
    stop: &AgentDispatchStopRecordV1,
    child: &AgentRuntimeCloseRecordV1,
    guard: OwnedMutexGuard<()>,
) -> Result<(AgentDispatchStopTerminalTransitionV1, OwnedMutexGuard<()>), BackendDispatchError> {
    if child.state == AgentRuntimeCloseStateV1::SourceRetained {
        // Recovery must release an owned permit without acquiring a new one.
        // The Git authority also handles a lost abort response or a successor permit.
        let frozen = stop.clone();
        let (_, guard) = with_checkout(guard, move || {
            if let AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout } =
                frozen.plan().workspace_plan()
            {
                removal_operation(&frozen, checkout)?.abort()?;
            }
            Ok(())
        })
        .await?;
        agent_runtime_close_apply::drive_locked(state, child).await?;
        return Ok((
            AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: Box::new(load_child(state, &child.intent.operation_id).await?),
            },
            guard,
        ));
    }

    if let AgentDispatchStopWorkspacePlanV1::RemoveOwned { checkout } = stop.plan().workspace_plan()
    {
        dure_session_runtime::reconcile_checkout_users(
            state.store.as_ref().clone(),
            state.hmux_identity.runtime_executable_path.clone(),
            state.hmux_identity.discovery_root.clone(),
            dure_app::GitCheckoutRegistrationV1 {
                repository_path: checkout.repository_path.clone(),
                instance: checkout.instance.clone(),
            },
        )
        .await
        .map_err(|_| retry("agent_dispatch_stop_checkout_unavailable"))?;
    }

    let frozen = stop.clone();
    let close_state = child.state;
    let (admission, guard) = with_checkout(guard, move || admit(&frozen, close_state)).await?;
    let outcome = agent_runtime_close_apply::drive_locked(state, child).await?;
    let child = Box::new(load_child(state, &child.intent.operation_id).await?);
    let frozen = stop.clone();
    with_checkout(guard, move || {
        if matches!(outcome, CloseDriveOutcome::SourceRetained) {
            if let CheckoutAdmission::Remove(removal) = admission {
                removal.abort()?;
            }
            return Ok(AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: child,
            });
        }
        match admission {
            CheckoutAdmission::Preserve => {
                if let Some(registration) = &frozen.plan().spawn().checkout_registration {
                    release_git_checkout_registration(
                        registration,
                        &frozen.plan().spawn().operation_id,
                        frozen.plan().operation_id(),
                    )?;
                }
                Ok(AgentDispatchStopTerminalTransitionV1::Preserved {
                    runtime_close: child,
                })
            }
            CheckoutAdmission::Replaced => {
                Ok(AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                    runtime_close: child,
                })
            }
            CheckoutAdmission::Remove(removal) => match removal.remove() {
                Ok(workspace) => Ok(AgentDispatchStopTerminalTransitionV1::Succeeded {
                    runtime_close: child,
                    workspace,
                }),
                Err(error) if is_replacement(&error) => {
                    Ok(AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                        runtime_close: child,
                    })
                }
                Err(error) => Err(error),
            },
        }
    })
    .await
}
