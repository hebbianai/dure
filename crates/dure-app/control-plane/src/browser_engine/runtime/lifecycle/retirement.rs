//! Native cleanup handles are retained before shared construction can publish.
use super::*;
use std::sync::OnceLock;

#[derive(Clone)]
pub(in crate::browser_engine::runtime) struct ResourceRetirement {
    pub(super) binding: HostBindingRetirement,
    pub(super) events: Arc<OnceLock<events::BrowserEventMonitor>>,
    pub(super) cdp: Arc<OnceLock<BrowserCdp>>,
    initial_target: Arc<OnceLock<BrowserTargetId>>,
    pub(in crate::browser_engine::runtime) recordings: super::super::recording::RecordingStreams,
    pub(in crate::browser_engine::runtime) react_profiles: super::super::react::ReactProfiles,
}

impl ResourceRetirement {
    pub(in crate::browser_engine::runtime) fn identity(&self) -> &BrowserResourceIdentity {
        &self.binding.identity
    }

    pub(in crate::browser_engine::runtime) fn instance_id(&self) -> &BrowserInstanceId {
        &self.binding.instance
    }

    pub(super) fn pending(binding: HostBindingRetirement) -> Self {
        Self {
            binding,
            events: Arc::new(OnceLock::new()),
            cdp: Arc::new(OnceLock::new()),
            initial_target: Arc::new(OnceLock::new()),
            recordings: Default::default(),
            react_profiles: Default::default(),
        }
    }

    pub(super) fn with_observers(
        binding: HostBindingRetirement,
        events: &events::BrowserEventMonitor,
        cdp: &BrowserCdp,
    ) -> Self {
        let retained = Self::pending(binding);
        retained.retain_cdp(cdp.clone());
        retained.retain_events(events.clone());
        retained
    }

    #[cfg(test)]
    pub(in crate::browser_engine::runtime) fn new(
        identity: &BrowserResourceIdentity,
        host: &Arc<Mutex<BrowserResourceHost>>,
        events: &events::BrowserEventMonitor,
        cdp: &BrowserCdp,
        uploads: &Arc<Mutex<upload::BrowserUploads>>,
    ) -> Self {
        Self::with_observers(
            HostBindingRetirement::new(identity, host, events.instance(), uploads, &events.changed),
            events,
            cdp,
        )
    }

    pub(in crate::browser_engine::runtime) fn retain_target(&self, target: BrowserTargetId) {
        // This exact native creation response remains cleanup authority even
        // when Host rejects publication after resource retirement or capacity.
        assert!(
            self.initial_target.set(target).is_ok(),
            "initial target is retained once"
        );
    }

    pub(in crate::browser_engine::runtime) fn retain_cdp(&self, cdp: BrowserCdp) {
        assert!(
            self.cdp.set(cdp).is_ok(),
            "command connection is retained once"
        );
    }

    pub(in crate::browser_engine::runtime) fn retain_events(
        &self,
        events: events::BrowserEventMonitor,
    ) {
        assert!(
            self.events.set(events).is_ok(),
            "event connection is retained once"
        );
    }

    pub(in crate::browser_engine::runtime) async fn release(
        &self,
        instance: &instance::BrowserInstanceLease,
    ) -> Result<(), BrowserRuntimeError> {
        instance
            .release(self.clone(), async {
                if let Some(events) = self.events.get() {
                    events.synchronize_events().await?;
                }
                let mut targets = self
                    .binding
                    .host
                    .lock()
                    .await
                    .instance_targets(&self.binding.instance);
                targets.extend(self.initial_target.get().cloned());
                if targets.is_empty() {
                    return Ok(());
                }
                let connection = instance.connection().await;
                retire_targets(
                    connection.endpoint(),
                    &targets.into_iter().collect::<Vec<_>>(),
                )
                .await
            })
            .await
    }

    pub(in crate::browser_engine::runtime) async fn begin(
        &self,
    ) -> Result<(), BrowserRuntimeError> {
        self.binding.begin().await
    }

    pub(in crate::browser_engine::runtime) fn same_resource(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.binding.host, &other.binding.host)
    }

    pub(in crate::browser_engine::runtime) async fn complete(
        &self,
    ) -> Result<(), BrowserRuntimeError> {
        // Clones retain the same handles through cancellation and retry. Taking
        // them before an awaited close would lose cleanup on a canceled waiter.
        let recordings = self
            .recordings
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for recording in recordings {
            recording.retire().await;
        }
        if let Some(cdp) = self.cdp.get() {
            cdp.retire().await;
            self.recordings.lock().await.clear();
            self.react_profiles.lock().await.clear();
        }
        if let Some(events) = self.events.get() {
            events.close().await;
        }
        self.binding.complete().await
    }
}
