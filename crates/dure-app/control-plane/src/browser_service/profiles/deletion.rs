//! Catalog retirement fences selection before existing owners close their pages.
use super::*;
use hmux_session_protocol::browser_resource::BrowserResourcePhase;
use std::sync::Arc;

impl BrowserService {
    pub(in crate::browser_service) async fn delete_profile(
        &self,
        store: &SqliteDomainStore,
        profile: BrowserProfileIdV1,
    ) -> Result<Value, BackendDispatchError> {
        let resources = self.resources.lock().await;
        let record = store.browser_profile(&profile).await.map_err(store_error)?;
        if profile.is_default()
            || record
                .as_ref()
                .is_none_or(|r| r.state == BrowserProfileStateV1::Deleted)
        {
            return Ok(json!({"deleted":false,"profile_id":profile}));
        }
        // Persist before native side effects. A new request can resume Retiring
        // after response loss without reviving selection or a browser process.
        store
            .begin_browser_profile_retirement(&profile)
            .await
            .map_err(store_error)?;
        let mut retirements = Vec::with_capacity(resources.len());
        for managed in resources.values() {
            retirements.push((
                Arc::clone(&managed.runtime),
                managed
                    .runtime
                    .begin_profile_retirement(&profile)
                    .await
                    .map_err(super::super::runtime_error)?,
            ));
        }
        drop(resources);
        let mut failure = None;
        let mut retired = Vec::new();
        for (runtime, retirement) in retirements {
            match retirement.await {
                Ok(true) => retired.push(runtime),
                Ok(false) => {}
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        let mut resources = self.resources.lock().await;
        let mut closed = Vec::new();
        for runtime in retired {
            let control = runtime.control().await;
            if control.phase == BrowserResourcePhase::Closed
                && resources
                    .get(&control.resource.resource_id)
                    .is_some_and(|managed| Arc::ptr_eq(&managed.runtime, &runtime))
            {
                closed.push(control.resource);
            }
        }
        for resource in closed {
            self.target_retired(&resources, &resource)?;
            resources.remove(&resource.resource_id);
        }
        drop(resources);
        if let Some(error) = failure {
            return Err(super::super::runtime_error(error));
        }
        let directory = self
            .root
            .address_for(self.root.durable())
            .map_err(|_| BackendDispatchError::terminal("browser_directory_unavailable"))?;
        let selected = profile.clone();
        tokio::task::spawn_blocking(move || {
            crate::browser_engine::retire_profile_storage(&directory, &selected)
        })
        .await
        .map_err(|_| {
            BackendDispatchError::terminal("browser_profile_storage_retirement_unconfirmed")
        })?
        .map_err(|error| BackendDispatchError::terminal(error.code))?;
        store
            .complete_browser_profile_retirement(&profile)
            .await
            .map_err(store_error)?;
        Ok(json!({"deleted":true,"profile_id":profile}))
    }
}
