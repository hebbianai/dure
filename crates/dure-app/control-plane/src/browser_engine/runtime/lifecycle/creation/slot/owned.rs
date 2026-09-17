use super::*;

impl BindingSlot {
    async fn prepare(
        &self,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
        creation: Option<BrowserPageCreationPermit>,
        init_scripts: &BrowserLaunchScripts,
    ) -> Result<NativeBrowserEngine, BrowserRuntimeError> {
        let (connection, target) = {
            let mut pending = self.pending.lock().await;
            {
                let host = self.retirement.host.lock().await;
                host.require_instance_binding(
                    &self.retirement.identity,
                    &self.retirement.instance,
                )?;
                // The child is retained before releasing Host admission.
                *pending = Some(Construction::Owned(Box::new(
                    super::super::owned::Construction::spawn(
                        config,
                        directory,
                        profile.map(dure_app::BrowserProfileSpecV1::profile_id),
                        self.retirement.instance.clone(),
                        creation,
                    )?,
                )));
            }
            let Some(Construction::Owned(owned)) = pending.as_mut() else {
                unreachable!()
            };
            owned.prepare(&self.retirement, init_scripts).await?
        };
        // Native observation is armed before the command worker attaches. Its
        // connection is a projection; the child stays in the resource's slot.
        Ok(NativeBrowserEngine::attach(config, directory, connection, &target).await?)
    }

    pub(super) async fn construct_owned(
        &self,
        config: &NativeBrowserEngineConfig,
        directory: &Path,
        profile: Option<&dure_app::BrowserProfileSpecV1>,
        creation: Option<BrowserPageCreationPermit>,
        caller: &mut oneshot::Sender<Result<BrowserInstanceId, BrowserRuntimeError>>,
        init_scripts: &BrowserLaunchScripts,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        let result: Result<_, BrowserRuntimeError> = async {
            let engine = tokio::select! {
                biased;
                _ = caller.closed() => return Err("browser_resource_creation_interrupted".into()),
                _ = self.resource_retiring() => return Err("browser_resource_retiring".into()),
                result = self.prepare(config, directory, profile, creation, init_scripts) => result?,
            };
            let mut pending = self.pending.lock().await;
            let host = self.retirement.host.lock().await;
            host.require_instance_binding(&self.retirement.identity, &self.retirement.instance)?;
            if caller.is_closed() {
                return Err("browser_resource_creation_interrupted".into());
            }
            let Some(Construction::Owned(owned)) = pending.take() else {
                unreachable!()
            };
            let binding = (*owned).finish(engine, self.retirement.clone());
            assert!(
                self.ready.set(Arc::new(binding)).is_ok(),
                "binding publishes once"
            );
            Ok(self.retirement.instance.clone())
        }
        .await;
        self.retire_failed_construction(result).await
    }
}
