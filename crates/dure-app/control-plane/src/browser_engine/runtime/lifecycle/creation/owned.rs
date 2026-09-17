//! Partial native handles stay with the resource through construction and retry.
use super::*;
use crate::browser_engine::chromium::{ChromiumConnection, OwnedChromium};

pub(super) struct Construction {
    chromium: OwnedChromium,
    cdp: Option<BrowserCdp>,
    downloads: Option<download::DownloadState>,
    events: Option<events::BrowserEventMonitor>,
    creation: Option<BrowserPageCreationPermit>,
}

impl Construction {
    pub(super) fn spawn(
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: Option<&dure_app::BrowserProfileIdV1>,
        instance: BrowserInstanceId,
        creation: Option<BrowserPageCreationPermit>,
    ) -> Result<Self, BrowserRuntimeError> {
        Ok(Self {
            chromium: OwnedChromium::spawn(&config.chromium, directory, profile, instance)?,
            cdp: None,
            downloads: None,
            events: None,
            creation,
        })
    }

    pub(super) async fn prepare(
        &mut self,
        retirement: &HostBindingRetirement,
        init_scripts: &BrowserLaunchScripts,
    ) -> Result<(ChromiumConnection, BrowserTargetId), BrowserRuntimeError> {
        self.chromium.wait_ready().await?;
        let target = self.chromium.launch_page().await?;
        {
            let mut host = retirement.host.lock().await;
            if let Some(creation) = &self.creation {
                host.begin_page_creation(creation, self.chromium.connection().instance())?;
                host.reserve_created_page_target(creation, target.clone())?;
            } else {
                host.reserve_page_target(
                    &retirement.identity,
                    self.chromium.connection().instance().clone(),
                    target.clone(),
                )?;
            }
        }
        self.cdp = Some(BrowserCdp::connect(self.chromium.endpoint()).await?);
        self.downloads = Some(download::prepare(&self.chromium).await?);
        self.events = Some(
            events::BrowserEventMonitor::start(
                Arc::clone(&retirement.host),
                self.chromium.endpoint(),
                self.chromium.connection().instance().clone(),
                Arc::clone(&retirement.changed),
            )
            .await?,
        );
        init_scripts
            .install(
                retirement,
                self.events.as_ref().expect("prepared events"),
                &target,
            )
            .await?;
        Ok((self.chromium.connection(), target))
    }

    #[cfg(test)]
    pub(super) fn replace_test_endpoint(&mut self, endpoint: String) -> String {
        self.chromium.replace_test_endpoint(endpoint)
    }

    #[cfg(test)]
    pub(super) fn browser_has_exited(&mut self) -> Result<bool, BrowserEngineError> {
        self.chromium.has_exited()
    }

    pub(super) async fn retire(
        &mut self,
        retirement: &HostBindingRetirement,
    ) -> Result<(), BrowserRuntimeError> {
        retirement.begin().await?;
        self.chromium.close().await?;
        if let Some(cdp) = self.cdp.take() {
            cdp.retire().await;
        }
        if let Some(events) = self.events.take() {
            events.close().await;
        }
        // Native/observer absence is independent of remaining scratch files.
        retirement.complete().await?;
        if let Some(downloads) = self.downloads.as_mut() {
            downloads.close().await?;
        }
        self.downloads.take();
        Ok(())
    }

    pub(super) fn finish(
        self,
        engine: NativeBrowserEngine,
        binding: HostBindingRetirement,
    ) -> BrowserBinding {
        let cdp = self.cdp.expect("prepared browser connection");
        let events = self.events.expect("prepared browser observation");
        let downloads = self.downloads.expect("prepared download owner");
        let retirement = ResourceRetirement::with_observers(binding, &events, &cdp);
        let instance = Arc::new(instance::BrowserInstanceLease::owned(
            self.chromium,
            engine,
            downloads,
            retirement.clone(),
        ));
        BrowserBinding {
            engine: instance.engine(),
            downloads: instance.downloads(),
            instance,
            events,
            cdp,
            retirement,
        }
    }
}
