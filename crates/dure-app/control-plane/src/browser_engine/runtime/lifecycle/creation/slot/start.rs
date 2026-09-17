use super::*;

enum Plan {
    Owned {
        config: NativeBrowserEngineConfig,
        directory: PathBuf,
        profile: Option<dure_app::BrowserProfileSpecV1>,
        creation: Option<Box<BrowserPageCreationPermit>>,
    },
    Shared {
        source: BrowserProfileSource,
        creation: Option<Box<BrowserPageCreationPermit>>,
    },
}

impl Plan {
    fn profile(&self) -> Option<dure_app::BrowserProfileSpecV1> {
        match self {
            Self::Owned { profile, .. } => profile.clone(),
            Self::Shared { source, .. } => source.slot.profile.clone(),
        }
    }

    async fn run(
        self,
        slot: &BindingSlot,
        mut caller: oneshot::Sender<Result<BrowserInstanceId, BrowserRuntimeError>>,
        init_scripts: BrowserLaunchScripts,
    ) {
        match self {
            Self::Owned {
                config,
                directory,
                profile,
                creation,
            } => {
                let result = slot
                    .construct_owned(
                        &config,
                        &directory,
                        profile.as_ref(),
                        creation.map(|permit| *permit),
                        &mut caller,
                        &init_scripts,
                    )
                    .await;
                slot.deliver(result, caller).await;
            }
            Self::Shared { source, creation } => {
                let binding = tokio::select! {
                    biased;
                    _ = caller.closed() => Err("browser_resource_creation_interrupted".into()),
                    _ = slot.resource_retiring() => Err("browser_resource_retiring".into()),
                    result = source.ready() => result,
                };
                let binding = match binding {
                    Ok(binding) => binding,
                    Err(error) => {
                        let result = slot.retire_pending().await.and(Err(error));
                        slot.deliver(result, caller).await;
                        return;
                    }
                };
                let instance = Arc::clone(&binding.instance);
                instance
                    .share(&slot.retirement.identity, |lease| async move {
                        let result = slot
                            .construct_shared(
                                lease,
                                &binding.events,
                                creation.map(|permit| *permit),
                                &caller,
                                &init_scripts,
                            )
                            .await;
                        // Origin retirement also joins cleanup of an unreceived
                        // publication, not only the native creation response.
                        slot.deliver(result, caller).await;
                    })
                    .await;
            }
        }
    }
}

/// Awaiting callers do not own the task or the native construction it retains.
pub(crate) struct BrowserInitialization {
    slot: Arc<BindingSlot>,
    activate: oneshot::Sender<BrowserLaunchScripts>,
    result: oneshot::Receiver<Result<BrowserInstanceId, BrowserRuntimeError>>,
}

impl BrowserInitialization {
    pub(in crate::browser_engine::runtime) async fn wait(
        self,
        init_scripts: BrowserLaunchScripts,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        let _ = self.activate.send(init_scripts);
        self.slot.wait_finished().await;
        self.result
            .await
            .map_err(|_| BrowserEngineError::after("browser_resource_creation_interrupted"))?
    }
}

impl BrowserRuntime {
    #[cfg(test)]
    pub(in crate::browser_engine::runtime) async fn launch_binding(
        &self,
        config: &NativeBrowserEngineConfig,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        self.admit_owned_binding(config, profile)
            .await?
            .wait(Default::default())
            .await
    }

    pub(crate) async fn admit_owned_binding(
        &self,
        config: &NativeBrowserEngineConfig,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        self.admit_binding(
            OwnedChromium::new_instance_id()?,
            Plan::Owned {
                config: config.clone(),
                directory: self.directory.clone(),
                profile: profile.cloned(),
                creation: None,
            },
            None,
        )
        .await
    }

    pub(in crate::browser_engine::runtime) async fn admit_replacement_binding(
        &self,
        config: &NativeBrowserEngineConfig,
        profile: &dure_app::BrowserProfileSpecV1,
        permit: &BrowserActionPermit,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        let instance = OwnedChromium::new_instance_id()?;
        let creation = self
            .host
            .lock()
            .await
            .prepare_page_replacement(permit, &instance)?;
        self.admit_binding(
            instance,
            Plan::Owned {
                config: config.clone(),
                directory: self.directory.clone(),
                profile: Some(profile.clone()),
                creation: Some(Box::new(creation)),
            },
            None,
        )
        .await
    }

    pub(crate) async fn attach_shared_from(
        &self,
        source: &BrowserRuntime,
        instance: &BrowserInstanceId,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        self.admit_shared_binding(source.source_for_instance(instance).await?)
            .await?
            .wait(Default::default())
            .await
    }

    pub(crate) async fn admit_shared_binding(
        &self,
        source: BrowserProfileSource,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        self.admit_binding(
            source.instance().clone(),
            Plan::Shared {
                source,
                creation: None,
            },
            None,
        )
        .await
    }

    pub(in crate::browser_engine::runtime) async fn admit_shared_replacement_binding(
        &self,
        source: BrowserProfileSource,
        permit: &BrowserActionPermit,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        let instance = source.instance().clone();
        let creation = self
            .host
            .lock()
            .await
            .prepare_page_replacement(permit, &instance)?;
        self.admit_binding(
            instance,
            Plan::Shared {
                source,
                creation: Some(Box::new(creation)),
            },
            None,
        )
        .await
    }

    pub(in crate::browser_engine::runtime) async fn admit_clone_binding(
        &self,
        config: &NativeBrowserEngineConfig,
        profile: &dure_app::BrowserProfileSpecV1,
        source: Option<BrowserProfileSource>,
        permit: &BrowserActionPermit,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        let (instance, plan) = match source {
            Some(source) => (
                source.instance().clone(),
                Plan::Shared {
                    source,
                    creation: None,
                },
            ),
            None => (
                OwnedChromium::new_instance_id()?,
                Plan::Owned {
                    config: config.clone(),
                    directory: self.directory.clone(),
                    profile: Some(profile.clone()),
                    creation: None,
                },
            ),
        };
        self.admit_binding(instance, plan, Some(permit)).await
    }

    async fn admit_binding(
        &self,
        instance: BrowserInstanceId,
        mut plan: Plan,
        page_creation: Option<&BrowserActionPermit>,
    ) -> Result<BrowserInitialization, BrowserRuntimeError> {
        let bindings = Arc::clone(&self.bindings);
        let (caller, result) = oneshot::channel();
        let (activate, activated) = oneshot::channel();
        let (completed, finished) = watch::channel(false);
        let slot = {
            let mut host = self.host.lock().await;
            let identity = host.projection().resource;
            host.register_instance_binding(&identity, instance.clone())?;
            let prepared = page_creation
                .map(|permit| host.prepare_page_creation_in(permit, &instance))
                .transpose();
            let preparation = match prepared {
                Ok(Some(permit)) => {
                    let (Plan::Owned { creation, .. } | Plan::Shared { creation, .. }) = &mut plan;
                    *creation = Some(Box::new(permit));
                    Ok(())
                }
                Ok(None) => Ok(()),
                Err(error) => Err(BrowserRuntimeError::from(error)),
            };
            let slot = Arc::new(BindingSlot {
                ready: Default::default(),
                profile: plan.profile(),
                pending: Mutex::new(None),
                finished,
                retirement: HostBindingRetirement::new(
                    &identity,
                    &self.host,
                    &instance,
                    &self.uploads,
                    &self.changed,
                ),
            });
            bindings
                .lock()
                .unwrap()
                .insert(instance.clone(), Arc::clone(&slot));
            let owned = Arc::clone(&slot);
            tokio::spawn(async move {
                let mut caller = caller;
                let admission = match preparation {
                    Err(error) => Err(error),
                    Ok(()) => tokio::select! {
                        biased;
                        _ = caller.closed() => Err("browser_resource_creation_interrupted".into()),
                        _ = owned.resource_retiring() => Err("browser_resource_retiring".into()),
                        result = activated => result.map_err(|_| "browser_resource_creation_interrupted".into()),
                    },
                };
                match admission {
                    Ok(init_scripts) => plan.run(&owned, caller, init_scripts).await,
                    Err(error) => {
                        let result = owned.retire_pending().await.and(Err(error));
                        owned.deliver(result, caller).await;
                    }
                }
                if owned.ready.get().is_none() && owned.pending.lock().await.is_none() {
                    owned.remove_from_open_resource(&bindings).await;
                }
                drop(owned);
                drop(bindings);
                let _ = completed.send(true);
            });
            slot
        };
        Ok(BrowserInitialization {
            slot,
            activate,
            result,
        })
    }
}
