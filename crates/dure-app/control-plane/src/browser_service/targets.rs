//! The resource table serializes inventory changes with the Hmux target owner.
use super::*;
use hmux_host::browser_workspace::BrowserWorkspaceTargetError;
use hmux_session_protocol::browser_workspace::BrowserWorkspaceTarget;
use tokio::sync::MutexGuard;

impl BrowserService {
    // Every projection/transition requires the caller to hold resource admission.
    // The target mutex is short-lived and never survives an await/native call.
    pub(super) fn workspace_target(
        &self,
        _resources: &MutexGuard<'_, BTreeMap<BrowserResourceId, ManagedBrowser>>,
        workspace: &BrowserWorkspaceId,
    ) -> Result<BrowserWorkspaceTarget, BackendDispatchError> {
        let targets = self.workspace_targets.lock().map_err(|_| unavailable())?;
        Ok(targets.get(workspace).map_or_else(
            || {
                BrowserWorkspaceTargetHost::new(workspace.clone(), self.generation.clone())
                    .projection()
            },
            BrowserWorkspaceTargetHost::projection,
        ))
    }

    pub(super) fn target_created(
        &self,
        _resources: &MutexGuard<'_, BTreeMap<BrowserResourceId, ManagedBrowser>>,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BackendDispatchError> {
        self.workspace_targets
            .lock()
            .map_err(|_| unavailable())?
            .entry(resource.workspace_id.clone())
            .or_insert_with(|| {
                BrowserWorkspaceTargetHost::new(
                    resource.workspace_id.clone(),
                    self.generation.clone(),
                )
            })
            .created(resource)
            .map_err(target_error)?;
        Ok(())
    }

    pub(super) fn target_retired(
        &self,
        _resources: &MutexGuard<'_, BTreeMap<BrowserResourceId, ManagedBrowser>>,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BackendDispatchError> {
        if let Some(target) = self
            .workspace_targets
            .lock()
            .map_err(|_| unavailable())?
            .get_mut(&resource.workspace_id)
        {
            target.retired(resource).map_err(target_error)?;
        }
        Ok(())
    }

    pub(super) async fn select_resource(
        &self,
        resource: &BrowserResourceIdentity,
        expected: &BrowserWorkspaceTarget,
    ) -> Result<Value, BackendDispatchError> {
        let resources = self.resources.lock().await;
        let runtime = &resources
            .get(&resource.resource_id)
            .ok_or_else(|| BackendDispatchError::terminal("browser_resource_unavailable"))?
            .runtime;
        let control = runtime.control().await;
        if control.resource != *resource {
            return Err(BackendDispatchError::terminal("browser_resource_mismatch"));
        }
        if matches!(
            control.phase,
            BrowserResourcePhase::Closed | BrowserResourcePhase::Retiring
        ) {
            return Err(BackendDispatchError::terminal(
                "browser_resource_unavailable",
            ));
        }
        let target = self
            .workspace_targets
            .lock()
            .map_err(|_| unavailable())?
            .entry(resource.workspace_id.clone())
            .or_insert_with(|| {
                BrowserWorkspaceTargetHost::new(
                    resource.workspace_id.clone(),
                    self.generation.clone(),
                )
            })
            .select(expected, resource)
            .map_err(target_error)?;
        Ok(json!({"target":target}))
    }
}

fn unavailable() -> BackendDispatchError {
    BackendDispatchError::terminal("browser_workspace_selection_unavailable")
}

fn target_error(error: BrowserWorkspaceTargetError) -> BackendDispatchError {
    BackendDispatchError::terminal(match error {
        BrowserWorkspaceTargetError::IdentityMismatch => "browser_resource_mismatch",
        BrowserWorkspaceTargetError::SelectionChanged => "browser_workspace_selection_changed",
        BrowserWorkspaceTargetError::RevisionExhausted => "browser_workspace_selection_exhausted",
    })
}
