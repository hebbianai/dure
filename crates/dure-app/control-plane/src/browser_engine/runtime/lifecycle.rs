//! Resource retirement closes its pages; the final instance lease closes processes.
use super::*;

mod binding;
mod creation;
mod retirement;
use binding::HostBindingRetirement;
pub(super) use creation::BindingSlot;
pub(crate) use creation::{
    BrowserInitialization, BrowserLaunchFeature, BrowserLaunchScripts, BrowserProfileSource,
};
pub(super) use retirement::ResourceRetirement;
#[cfg(test)]
mod tests;

impl BrowserRuntime {
    pub async fn close(
        &self,
        identity: &BrowserResourceIdentity,
    ) -> Result<(), BrowserRuntimeError> {
        let bindings = begin_resource_retirement(
            &self.host,
            identity,
            &self.bindings,
            &self.uploads,
            &self.changed,
        )
        .await?;
        retire_bindings(&self.bindings, bindings).await
    }

    pub(crate) async fn begin_retirement(
        &self,
        identity: &BrowserResourceIdentity,
    ) -> Result<(), BrowserRuntimeError> {
        begin_resource_retirement(
            &self.host,
            identity,
            &self.bindings,
            &self.uploads,
            &self.changed,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn retire_binding(
        &self,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserRuntimeError> {
        let execution = self.execution_for_instance(instance)?;
        execution.binding.close().await?;
        self.bindings.lock().unwrap().remove(instance);
        Ok(())
    }
}

pub(super) type BindingTable = Arc<BindingMutex<BTreeMap<BrowserInstanceId, Arc<BindingSlot>>>>;

async fn begin_resource_retirement(
    host: &Arc<Mutex<BrowserResourceHost>>,
    identity: &BrowserResourceIdentity,
    table: &BindingTable,
    uploads: &Arc<Mutex<upload::BrowserUploads>>,
    changed: &Arc<tokio::sync::Notify>,
) -> Result<Vec<(BrowserInstanceId, Arc<BindingSlot>)>, BrowserRuntimeError> {
    let mut host = host.lock().await;
    let state = host.projection();
    if state.resource != *identity
        || !matches!(
            state.phase,
            BrowserResourcePhase::Closed | BrowserResourcePhase::Retiring
        )
    {
        host.begin_retirement(identity)?;
    }
    // Admission and this capture share the Host lock, so an in-progress launch
    // cannot be omitted between fencing the resource and collecting its owners.
    let bindings = table
        .lock()
        .unwrap()
        .iter()
        .map(|(id, slot)| (id.clone(), Arc::clone(slot)))
        .collect();
    // A retained resource can close before initialization has admitted any
    // native owner. Holding Host admission proves no child can start afterward.
    let empty = host.instance_binding_ids().is_empty();
    if empty && host.projection().phase != BrowserResourcePhase::Closed {
        host.engine_exited(identity)?;
    }
    drop(host);
    if empty {
        uploads.lock().await.clear();
    }
    changed.notify_waiters();
    Ok(bindings)
}

async fn retire_bindings(
    table: &BindingTable,
    bindings: Vec<(BrowserInstanceId, Arc<BindingSlot>)>,
) -> Result<(), BrowserRuntimeError> {
    let mut failure = None;
    for (_, binding) in bindings {
        match binding.close().await {
            Err(error) => {
                failure.get_or_insert(error);
            }
            Ok(()) if binding.ready.get().is_none() => {
                binding.remove_from_open_resource(table).await;
            }
            Ok(()) => {}
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

impl BrowserBinding {
    async fn close(&self) -> Result<(), BrowserRuntimeError> {
        self.retirement.release(&self.instance).await
    }
}

impl Drop for BrowserRuntime {
    fn drop(&mut self) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let host = Arc::clone(&self.host);
            let table = Arc::clone(&self.bindings);
            let uploads = Arc::clone(&self.uploads);
            let changed = Arc::clone(&self.changed);
            runtime.spawn(async move {
                let identity = host.lock().await.projection().resource;
                if let Ok(bindings) =
                    begin_resource_retirement(&host, &identity, &table, &uploads, &changed).await
                {
                    let _ = retire_bindings(&table, bindings).await;
                }
            });
        }
    }
}

impl Drop for BrowserBinding {
    fn drop(&mut self) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let retirement = self.retirement.clone();
            let instance = Arc::clone(&self.instance);
            runtime.spawn(async move {
                let _ = retirement.release(&instance).await;
            });
        }
    }
}

async fn retire_targets(
    address: &str,
    targets: &[BrowserTargetId],
) -> Result<(), BrowserRuntimeError> {
    let mut cdp = BrowserCdp::connect(address).await?;
    let result = close_targets(&mut cdp, targets).await;
    #[cfg(test)]
    if let Err(code) = result {
        eprintln!("BROWSER_RETIRE_TARGETS_NATIVE_FAILURE targets={targets:?} code={code}");
    }
    cdp.retire().await;
    result.map_err(|_| BrowserEngineError::after("browser_page_retirement_unconfirmed").into())
}

pub(super) async fn close_targets(
    cdp: &mut BrowserCdp,
    targets: &[BrowserTargetId],
) -> Result<(), &'static str> {
    let live = cdp.request("Target.getTargets", json!({}), None).await?;
    let live = live["targetInfos"]
        .as_array()
        .ok_or("browser_retirement_census_invalid")?;
    for target in targets {
        if live
            .iter()
            .any(|info| info["targetId"].as_str() == Some(target.as_str()))
        {
            cdp.request("Target.closeTarget", json!({"targetId":target}), None)
                .await?;
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let live = cdp.request("Target.getTargets", json!({}), None).await?;
            let live = live["targetInfos"]
                .as_array()
                .ok_or("browser_retirement_census_invalid")?;
            if !live.iter().any(|info| {
                targets
                    .iter()
                    .any(|target| info["targetId"].as_str() == Some(target.as_str()))
            }) {
                return Ok::<_, &'static str>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| "browser_page_retirement_unconfirmed")?
}
