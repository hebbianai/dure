//! Select from admitted bindings, including an owner whose startup is pending.
use super::*;

pub(crate) struct BrowserProfileSource {
    pub(super) slot: Arc<BindingSlot>,
}

impl BrowserProfileSource {
    pub(in crate::browser_engine::runtime) fn instance(&self) -> &BrowserInstanceId {
        &self.slot.retirement.instance
    }

    pub(in crate::browser_engine::runtime) async fn ready(
        &self,
    ) -> Result<Arc<BrowserBinding>, BrowserRuntimeError> {
        self.slot.wait_finished().await;
        let binding = &self.slot.retirement;
        let host = binding.host.lock().await;
        host.require_instance_binding(&binding.identity, &binding.instance)?;
        self.slot
            .ready
            .get()
            .cloned()
            .ok_or_else(|| "browser_profile_source_unavailable".into())
    }
}

impl BrowserRuntime {
    /// Fence every selected binding while service admission is serialized.
    /// The returned cleanup future retains only existing binding owners.
    /// Its result reports whether those owners included the selected profile.
    pub(crate) async fn begin_profile_retirement(
        &self,
        profile: &dure_app::BrowserProfileIdV1,
    ) -> Result<
        impl std::future::Future<Output = Result<bool, BrowserRuntimeError>> + Send + 'static + use<>,
        BrowserRuntimeError,
    > {
        let mut host = self.host.lock().await;
        let identity = host.projection().resource;
        let table = Arc::clone(&self.bindings);
        let bindings = table
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, slot)| {
                slot.profile
                    .as_ref()
                    .map(dure_app::BrowserProfileSpecV1::profile_id)
                    == Some(profile)
            })
            .map(|(instance, slot)| (instance.clone(), Arc::clone(slot)))
            .collect::<Vec<_>>();
        for (instance, _) in &bindings {
            host.begin_instance_retirement(&identity, instance)?;
        }
        drop(host);
        self.changed.notify_waiters();
        Ok(async move {
            let selected = !bindings.is_empty();
            crate::browser_engine::runtime::lifecycle::retire_bindings(&table, bindings).await?;
            Ok(selected)
        })
    }

    pub(crate) async fn profile_source(
        &self,
        profile: &dure_app::BrowserProfileIdV1,
    ) -> Option<BrowserProfileSource> {
        let host = self.host.lock().await;
        let identity = host.projection().resource;
        self.bindings
            .lock()
            .unwrap()
            .iter()
            .find(|(instance, slot)| {
                slot.profile
                    .as_ref()
                    .map(dure_app::BrowserProfileSpecV1::profile_id)
                    == Some(profile)
                    && host.require_instance_binding(&identity, instance).is_ok()
            })
            .map(|(_, slot)| BrowserProfileSource {
                slot: Arc::clone(slot),
            })
    }

    pub(super) async fn source_for_instance(
        &self,
        instance: &BrowserInstanceId,
    ) -> Result<BrowserProfileSource, BrowserRuntimeError> {
        let host = self.host.lock().await;
        host.require_instance_binding(&host.projection().resource, instance)?;
        self.bindings
            .lock()
            .unwrap()
            .get(instance)
            .map(|slot| BrowserProfileSource {
                slot: Arc::clone(slot),
            })
            .ok_or_else(|| "browser_profile_source_unavailable".into())
    }
}
