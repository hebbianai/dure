//! One resource table retains both pending and published native binding handles.
use super::*;
use crate::browser_engine::chromium::OwnedChromium;
use tokio::sync::{oneshot, watch};

mod owned;
mod shared;
mod source;
mod start;
pub(crate) use source::BrowserProfileSource;
pub(crate) use start::BrowserInitialization;

enum Construction {
    Owned(Box<super::owned::Construction>),
    Shared(Box<super::shared::Construction>),
}

pub(in crate::browser_engine::runtime) struct BindingSlot {
    pub(in crate::browser_engine::runtime) ready: std::sync::OnceLock<Arc<BrowserBinding>>,
    // Immutable native profile settings, retained before startup. Host owns
    // whether this binding is still eligible to serve another resource.
    profile: Option<dure_app::BrowserProfileSpecV1>,
    pending: Mutex<Option<Construction>>,
    retirement: HostBindingRetirement,
    finished: watch::Receiver<bool>,
}

impl BindingSlot {
    pub(in crate::browser_engine::runtime) fn user_agent_mode(
        &self,
    ) -> dure_app::BrowserProfileUserAgentModeV1 {
        self.profile
            .as_ref()
            .map(dure_app::BrowserProfileSpecV1::user_agent_mode)
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(in crate::browser_engine::runtime) fn published(
        binding: BrowserBinding,
        profile: Option<dure_app::BrowserProfileSpecV1>,
    ) -> Self {
        let (_, finished) = watch::channel(true);
        Self {
            retirement: binding.retirement.binding.clone(),
            ready: std::sync::OnceLock::from(Arc::new(binding)),
            profile,
            pending: Mutex::new(None),
            finished,
        }
    }

    async fn wait_finished(&self) {
        let mut finished = self.finished.clone();
        // The sole sender belongs to the construction task. Sender loss also
        // ends that task's ownership; retained native handles still need cleanup.
        let _ = finished.wait_for(|finished| *finished).await;
    }

    pub(in crate::browser_engine::runtime) async fn close(
        &self,
    ) -> Result<(), BrowserRuntimeError> {
        self.wait_finished().await;
        match self.ready.get() {
            Some(binding) => binding.close().await,
            None => self.retire_pending().await,
        }
    }

    async fn retire_pending(&self) -> Result<(), BrowserRuntimeError> {
        let mut pending = self.pending.lock().await;
        match pending.as_mut() {
            Some(Construction::Owned(owned)) => owned.retire(&self.retirement).await?,
            Some(Construction::Shared(shared)) => shared.retire().await?,
            None => self.retirement.complete().await?,
        }
        pending.take();
        Ok(())
    }

    pub(in crate::browser_engine::runtime) async fn remove_from_open_resource(
        self: &Arc<Self>,
        table: &crate::browser_engine::runtime::lifecycle::BindingTable,
    ) {
        let host = self.retirement.host.lock().await;
        // A closed resource cannot admit more bindings. Retain its final profile
        // identity so a canceled service deletion can resume the same cleanup.
        if host.projection().phase == BrowserResourcePhase::Closed && self.profile.is_some() {
            return;
        }
        let mut table = table.lock().unwrap();
        let instance = &self.retirement.instance;
        if table
            .get(instance)
            .is_some_and(|slot| Arc::ptr_eq(slot, self))
        {
            table.remove(instance);
        }
    }

    async fn retire_failed_construction(
        &self,
        result: Result<BrowserInstanceId, BrowserRuntimeError>,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        if let Err(primary) = &result
            && let Err(cleanup) = self.retire_pending().await
        {
            // Cleanup uncertainty determines the public outcome. Keep the
            // initiating failure available to diagnose this same native owner.
            eprintln!(
                "browser construction cleanup unconfirmed: resource={:?} instance={} primary={primary:?} cleanup={cleanup:?}",
                self.retirement.identity,
                self.retirement.instance.as_str()
            );
            return Err(
                BrowserEngineError::after("browser_instance_retirement_unconfirmed").into(),
            );
        }
        result
    }

    async fn resource_retiring(&self) {
        loop {
            let changed = self.retirement.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .retirement
                .host
                .lock()
                .await
                .require_instance_binding(&self.retirement.identity, &self.retirement.instance)
                .is_err()
            {
                return;
            }
            changed.await;
        }
    }

    #[cfg(test)]
    pub(in crate::browser_engine::runtime) async fn replace_test_endpoint(
        &self,
        endpoint: String,
    ) -> Result<String, BrowserRuntimeError> {
        match self.pending.lock().await.as_mut() {
            Some(Construction::Owned(owned)) => Ok(owned.replace_test_endpoint(endpoint)),
            _ => Err("fixture pending browser missing".into()),
        }
    }

    #[cfg(test)]
    pub(in crate::browser_engine::runtime) async fn browser_has_exited(
        &self,
    ) -> Result<bool, BrowserRuntimeError> {
        match self.pending.lock().await.as_mut() {
            Some(Construction::Owned(owned)) => Ok(owned.browser_has_exited()?),
            _ => Err("fixture pending browser missing".into()),
        }
    }

    async fn deliver(
        &self,
        outcome: Result<BrowserInstanceId, BrowserRuntimeError>,
        caller: oneshot::Sender<Result<BrowserInstanceId, BrowserRuntimeError>>,
    ) {
        if let Err(Ok(_)) = caller.send(outcome)
            && let Some(binding) = self.ready.get()
        {
            let _ = binding.close().await;
        }
    }
}
