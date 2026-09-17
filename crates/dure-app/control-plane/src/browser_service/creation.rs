//! Service ownership precedes native startup, including failed or canceled work.
use super::*;
use dure_app::{BrowserProfileIdV1, WorkspaceIdV1};

impl BrowserService {
    pub(super) async fn create(
        &self,
        store: &SqliteDomainStore,
        workspace_id: WorkspaceIdV1,
        operation_id: OperationIdV1,
        profile_id: Option<BrowserProfileIdV1>,
        init_scripts: crate::browser_engine::runtime::BrowserLaunchScripts,
    ) -> Result<Value, BackendDispatchError> {
        if store
            .workspace(&workspace_id)
            .await
            .map_err(|_| BackendDispatchError::terminal("browser_workspace_unavailable"))?
            .is_none()
        {
            return Err(BackendDispatchError::terminal("browser_workspace_missing"));
        }
        let config = self.config()?;
        let slot = Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| BackendDispatchError::terminal("browser_resource_limit"))?;
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new(format!(
                "browser:{:x}",
                Sha256::digest(operation_id.as_str().as_bytes())
            ))
            .expect("bounded digest identity"),
            generation: self.generation.clone(),
            workspace_id: BrowserWorkspaceId::new(workspace_id.as_str())
                .expect("validated workspace identity"),
        };
        let directory = self
            .root
            .address_for(self.root.durable())
            .map_err(|_| BackendDispatchError::terminal("browser_directory_unavailable"))?;
        let runtime = Arc::new(BrowserRuntime::new(identity.clone(), &directory));
        // Source selection and destination admission share the existing resource
        // table lock. A concurrent Create can reuse an owner still starting up.
        let mut resources = self.resources.lock().await;
        let profile = profiles::selected(store, profile_id).await?;
        let source = profiles::source(&resources, profile.profile_id()).await;
        // The journal already owns the operation identity. List and Close use
        // this same runtime even if startup fails or its waiting caller leaves.
        self.target_created(&resources, &identity)?;
        resources.insert(
            identity.resource_id,
            ManagedBrowser {
                runtime: Arc::clone(&runtime),
                _slot: slot,
            },
        );
        let admitted = match source {
            Some(source) => runtime.admit_shared_binding(source).await,
            None => runtime.admit_owned_binding(&config, Some(&profile)).await,
        };
        // Native startup never holds service admission or blocks List/Close.
        drop(resources);
        runtime
            .finish_initialization(admitted, init_scripts)
            .await
            .map_err(runtime_error)?;
        Ok(json!({"control":runtime.control().await}))
    }
}
