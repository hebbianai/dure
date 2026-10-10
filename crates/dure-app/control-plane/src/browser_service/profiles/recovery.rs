//! Both clients use this backend operation and its existing idempotency journal.
use super::*;

impl BrowserService {
    pub(in crate::browser_service) async fn profile_recovery(
        &self,
        store: &SqliteDomainStore,
        profile: BrowserProfileIdV1,
        recover: bool,
    ) -> Result<Value, BackendDispatchError> {
        // Selection, retirement and recovery use the same service admission.
        // The native claim also fences another backend and interrupted calls.
        let mut resources = self.resources.lock().await;
        selected(store, Some(profile.clone())).await?;
        let directory = self
            .root
            .address_for(self.root.durable())
            .map_err(|_| BackendDispatchError::terminal("browser_directory_unavailable"))?;
        let selected_profile = profile.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Value, BackendDispatchError> {
            if recover {
                crate::browser_engine::recover_profile_storage(&directory, &profile)
                    .map_err(|error| BackendDispatchError::terminal(error.code))?;
                Ok(json!({"profile_id":profile,"recovered":true}))
            } else {
                let state = crate::browser_engine::profile_recovery_status(&directory, &profile);
                Ok(json!({"profile_id":profile,"state":state}))
            }
        })
        .await
        .map_err(|_| BackendDispatchError::terminal("browser_profile_recovery_unconfirmed"))??;
        if recover {
            // Failed acquisition can leave a closed resource in the service
            // catalog. Retire only closed bindings for this proven-safe profile
            // so repeated refused creates do not consume every resource slot.
            let mut retired = Vec::new();
            for managed in resources.values() {
                let control = managed.runtime.control().await;
                if control.phase
                    != hmux_session_protocol::browser_resource::BrowserResourcePhase::Closed
                {
                    continue;
                }
                if managed
                    .runtime
                    .begin_profile_retirement(&selected_profile)
                    .await
                    .map_err(super::super::runtime_error)?
                    .await
                    .map_err(super::super::runtime_error)?
                {
                    retired.push(control.resource);
                }
            }
            for resource in retired {
                self.target_retired(&resources, &resource)?;
                resources.remove(&resource.resource_id);
            }
        }
        Ok(result)
    }
}
