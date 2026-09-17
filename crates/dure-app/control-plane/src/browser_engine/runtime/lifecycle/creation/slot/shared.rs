use super::*;

impl BindingSlot {
    pub(super) async fn construct_shared(
        &self,
        lease: Result<instance::BrowserInstanceLease, BrowserRuntimeError>,
        source: &events::BrowserEventMonitor,
        creation: Option<BrowserPageCreationPermit>,
        caller: &oneshot::Sender<Result<BrowserInstanceId, BrowserRuntimeError>>,
        init_scripts: &BrowserLaunchScripts,
    ) -> Result<BrowserInstanceId, BrowserRuntimeError> {
        let result = async {
            let lease = lease?;
            let mut pending = self.pending.lock().await;
            *pending = Some(Construction::Shared(Box::new(
                super::super::shared::Construction::new(lease, self.retirement.clone()),
            )));
            if caller.is_closed() {
                return Err("browser_resource_creation_interrupted".into());
            }
            let Some(Construction::Shared(shared)) = pending.as_mut() else {
                unreachable!()
            };
            // Do not abandon an in-flight shared native creation. This owned
            // task joins its reply and retains cleanup before honoring cancellation.
            shared
                .prepare(source, &self.retirement, creation, init_scripts)
                .await?;
            let host = self.retirement.host.lock().await;
            host.require_instance_binding(&self.retirement.identity, &self.retirement.instance)?;
            if caller.is_closed() {
                return Err("browser_resource_creation_interrupted".into());
            }
            let Some(Construction::Shared(shared)) = pending.take() else {
                unreachable!()
            };
            assert!(
                self.ready.set(Arc::new((*shared).finish())).is_ok(),
                "binding publishes once"
            );
            Ok(self.retirement.instance.clone())
        }
        .await;
        self.retire_failed_construction(result).await
    }
}
