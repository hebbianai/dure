//! Shared construction retains the selected lease in the destination resource.
use super::*;

pub(super) struct Construction {
    instance: Arc<instance::BrowserInstanceLease>,
    retirement: ResourceRetirement,
}

impl Construction {
    pub(super) fn new(
        instance: instance::BrowserInstanceLease,
        binding: HostBindingRetirement,
    ) -> Self {
        Self {
            instance: Arc::new(instance),
            retirement: ResourceRetirement::pending(binding),
        }
    }

    pub(super) async fn prepare(
        &mut self,
        source: &events::BrowserEventMonitor,
        binding: &HostBindingRetirement,
        creation: Option<BrowserPageCreationPermit>,
        init_scripts: &BrowserLaunchScripts,
    ) -> Result<(), BrowserRuntimeError> {
        self.instance
            .retain_resource(self.retirement.clone())
            .await?;
        {
            let mut host = binding.host.lock().await;
            host.require_instance_binding(&binding.identity, &binding.instance)?;
            if let Some(creation) = &creation {
                host.begin_page_creation(creation, &binding.instance)?;
            }
        }
        let target = match self.instance.launch_page().await {
            Ok(target) => target,
            Err(error) => {
                if let Some(creation) = &creation
                    && matches!(&error, BrowserRuntimeError::Engine(error) if !error.outcome_unknown)
                {
                    binding.host.lock().await.page_creation_rejected(creation)?;
                }
                return Err(error);
            }
        };
        self.retirement.retain_target(target.clone());
        let prepared: Result<_, BrowserRuntimeError> = async {
            {
                let mut host = binding.host.lock().await;
                match &creation {
                    Some(creation) => host.reserve_created_page_target(creation, target.clone())?,
                    None => host.reserve_page_target(
                        &binding.identity,
                        binding.instance.clone(),
                        target.clone(),
                    )?,
                }
            }
            let connection = self.instance.connection().await;
            self.retirement
                .retain_cdp(BrowserCdp::connect(connection.endpoint()).await?);
            let events = source
                .share(Arc::clone(&binding.host), Arc::clone(&binding.changed))
                .await?;
            self.retirement.retain_events(events.clone());
            Ok(events)
        }
        .await;
        // Join the shared worker's discovery while the created target is live,
        // including rejected publication. Closing an undiscovered target leaves
        // the pinned worker processing attachment events for an expired session.
        let tabs = self
            .instance
            .engine()
            .lock()
            .await
            .require(json!({"action":"tab_list"}))
            .await?;
        let events = prepared?;
        if !tabs["tabs"]
            .as_array()
            .ok_or("browser_tab_observation_invalid")?
            .iter()
            .any(|tab| tab["targetId"].as_str() == Some(target.as_str()))
        {
            return Err("browser_shared_page_missing".into());
        }
        if creation.is_some() {
            events.synchronize_events().await?;
        } else {
            events.synchronize(&target).await?;
        }
        init_scripts.install(binding, &events, &target).await?;
        Ok(())
    }

    pub(super) async fn retire(&self) -> Result<(), BrowserRuntimeError> {
        self.retirement.release(&self.instance).await
    }

    pub(super) fn finish(self) -> BrowserBinding {
        BrowserBinding {
            engine: self.instance.engine(),
            downloads: self.instance.downloads(),
            events: self
                .retirement
                .events
                .get()
                .expect("prepared event connection")
                .clone(),
            cdp: self
                .retirement
                .cdp
                .get()
                .expect("prepared command connection")
                .clone(),
            instance: self.instance,
            retirement: self.retirement,
        }
    }
}

impl BrowserRuntime {
    pub async fn share_instance(
        &self,
        identity: BrowserResourceIdentity,
    ) -> Result<Self, BrowserRuntimeError> {
        let instances = self.host.lock().await.instance_binding_ids();
        let [instance] = instances.as_slice() else {
            return Err("browser_profile_selection_required".into());
        };
        self.share_selected_instance(identity, instance).await
    }

    pub async fn share_selected_instance(
        &self,
        identity: BrowserResourceIdentity,
        instance: &BrowserInstanceId,
    ) -> Result<Self, BrowserRuntimeError> {
        let runtime = Self::new(identity, &self.directory);
        runtime.attach_shared_from(self, instance).await?;
        Ok(runtime)
    }
}
