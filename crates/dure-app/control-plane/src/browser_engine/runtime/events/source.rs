//! One ordered browser connection routes observations through Host page ownership.
use super::*;
use std::collections::BTreeMap;
mod contexts;
pub(in crate::browser_engine::runtime) use contexts::{BrowserStorageContext, PageCreationContext};

pub(super) struct EventSource {
    pub(super) instance: BrowserInstanceId,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for EventSource {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

struct Source {
    cdp: BrowserCdp,
    resources: BTreeMap<BrowserResourceId, Monitor>,
}

pub(super) async fn detach_retiring_target(
    cdp: &mut BrowserCdp,
    target: &BrowserTargetId,
    session: &str,
    parent: Option<&str>,
) -> Result<(), &'static str> {
    let detached = cdp
        .request(
            "Target.detachFromTarget",
            json!({"sessionId":session}),
            parent,
        )
        .await;
    if let Err(error) = detached {
        // Closing the target also destroys its sessions. A rejected late
        // detach is settled by exact target absence, never by the error alone.
        if live_targets(cdp).await?.contains(target) {
            return Err(error);
        }
    }
    Ok(())
}

async fn live_targets(cdp: &mut BrowserCdp) -> Result<BTreeSet<BrowserTargetId>, &'static str> {
    let census = cdp
        .request(
            "Target.getTargets",
            json!({"filter":[{"exclude":false}]}),
            None,
        )
        .await?;
    census["targetInfos"]
        .as_array()
        .ok_or("browser_network_census_invalid")?
        .iter()
        .map(|info| {
            BrowserTargetId::new(field(info, "targetId")?)
                .map_err(|_| "browser_network_target_invalid")
        })
        .collect()
}

async fn monitor(
    host: Arc<Mutex<BrowserResourceHost>>,
    cdp: BrowserCdp,
    barriers: mpsc::Sender<Barrier>,
    instance: BrowserInstanceId,
    changed: Arc<Notify>,
) -> Monitor {
    let resource = Arc::new(host.lock().await.projection().resource);
    Monitor {
        instance,
        resource,
        changed,
        navigation: broadcast::channel(128).0,
        cdp,
        host,
        initializing: true,
        contexts: Default::default(),
        private_contexts: Default::default(),
        interceptions: Default::default(),
        barriers,
    }
}

impl Source {
    fn resource(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
    ) -> Result<&mut Monitor, &'static str> {
        self.resources
            .get_mut(&resource.resource_id)
            .filter(|monitor| Arc::ptr_eq(&monitor.resource, resource))
            .ok_or("browser_network_observation_lost")
    }

    async fn source_owner(&self, source: &str) -> Result<Option<BrowserResourceId>, &'static str> {
        let source = BrowserNetworkId::new(source)?;
        for (resource, monitor) in &self.resources {
            let mut host = monitor.host.lock().await;
            let target = host.network().source_target(&source).cloned();
            if host.network().source_is_attached(&source)
                && target
                    .as_ref()
                    .and_then(|target| host.instance_for_target(target))
                    == Some(&monitor.instance)
            {
                return Ok(Some(resource.clone()));
            }
        }
        Ok(None)
    }

    async fn target_owner(&self, target: &BrowserTargetId) -> Option<(BrowserResourceId, bool)> {
        for (resource, monitor) in &self.resources {
            let host = monitor.host.lock().await;
            if host.instance_for_target(target) == Some(&monitor.instance) {
                return Some((resource.clone(), host.page_target_is_retiring(target)));
            }
        }
        None
    }

    async fn event(&mut self, event: Value) -> Result<(), &'static str> {
        let owner = if event["method"] == "Target.attachedToTarget" {
            let info = &event["params"]["targetInfo"];
            if info["type"] == "page" {
                let target = BrowserTargetId::new(field(info, "targetId")?)
                    .map_err(|_| "browser_network_target_invalid")?;
                match self.target_owner(&target).await {
                    Some((_, true)) => {
                        detach_retiring_target(
                            &mut self.cdp,
                            &target,
                            field(&event["params"], "sessionId")?,
                            event["sessionId"].as_str(),
                        )
                        .await?;
                        return Ok(());
                    }
                    Some((owner, false)) => Some(owner),
                    None => match info["openerId"].as_str() {
                        Some(opener) => {
                            let opener = BrowserTargetId::new(opener)
                                .map_err(|_| "browser_network_target_invalid")?;
                            self.target_owner(&opener).await.map(|(owner, _)| owner)
                        }
                        None => None,
                    },
                }
            } else {
                match event["sessionId"].as_str() {
                    Some(parent) => self.source_owner(parent).await?,
                    None => None,
                }
            }
        } else if event["method"] == "Target.detachedFromTarget" {
            self.source_owner(field(&event["params"], "sessionId")?)
                .await?
        } else {
            match event["sessionId"].as_str() {
                Some(source) => self.source_owner(source).await?,
                None => None,
            }
        };
        // A Host census can retire a page before already-emitted object
        // mirrors reach this connection. Only their retained context owner may
        // receive late cleanup; this path never grants page or input ownership.
        let owner = if owner.is_none()
            && matches!(
                event["method"].as_str(),
                Some(
                    "Runtime.consoleAPICalled"
                        | "Runtime.exceptionThrown"
                        | "Runtime.executionContextCreated"
                        | "Runtime.executionContextDestroyed"
                        | "Runtime.executionContextsCleared"
                        | "Target.detachedFromTarget"
                )
            ) {
            let session = if event["method"] == "Target.detachedFromTarget" {
                field(&event["params"], "sessionId")?
            } else {
                field(&event, "sessionId")?
            };
            let session = BrowserNetworkId::new(session)?;
            self.resources
                .iter()
                .find(|(_, monitor)| monitor.contexts.has_source(&session))
                .map(|(id, _)| id.clone())
        } else {
            owner
        };
        if let Some(owner) = owner {
            self.resources
                .get_mut(&owner)
                .ok_or("browser_resource_observer_missing")?
                .event(event)
                .await?;
        } else if event["method"] == "Target.attachedToTarget" {
            // Discovery grants no authority. Release only our own attachment;
            // never resume or close an unowned page on another owner's behalf.
            let target = BrowserTargetId::new(field(&event["params"]["targetInfo"], "targetId")?)
                .map_err(|_| "browser_network_target_invalid")?;
            detach_retiring_target(
                &mut self.cdp,
                &target,
                field(&event["params"], "sessionId")?,
                event["sessionId"].as_str(),
            )
            .await?;
        }
        Ok(())
    }

    async fn drain(&mut self) -> Result<(), &'static str> {
        let result = async {
            for _ in 0..4096 {
                let Some(event) = self.cdp.pop_event().await else {
                    return Ok(());
                };
                self.event(event).await?;
            }
            Err("browser_network_event_limit")
        }
        .await;
        if result.is_err() {
            // Setup can fail before an attached session reaches the Host table.
            // Its native handlers still belong to this connection, so resource
            // withdrawal alone cannot prove their retirement.
            self.cdp.retire().await;
        }
        result
    }

    async fn census(&mut self) -> Result<(), &'static str> {
        let live = live_targets(&mut self.cdp).await?;
        for monitor in self.resources.values_mut() {
            let mut host = monitor.host.lock().await;
            host.reconcile_instance_pages(&monitor.instance, &live, Instant::now())
                .map_err(|_| "browser_page_invalid")?;
            monitor.changed.notify_waiters();
        }
        self.drain().await?;
        self.retire_empty_contexts().await
    }

    async fn add(&mut self, mut monitor: Monitor) -> Result<(), &'static str> {
        let host = monitor.host.lock().await;
        let resource = Arc::clone(&monitor.resource);
        let targets = host.instance_targets(&monitor.instance);
        drop(host);
        if self.resources.contains_key(&resource.resource_id) || self.resources.len() >= 8 {
            return Err("browser_resource_observer_conflict");
        }
        for target in &targets {
            if self.target_owner(target).await.is_some() {
                return Err("browser_page_owner_conflict");
            }
        }
        monitor.initializing = true;
        self.resources.insert(resource.resource_id.clone(), monitor);
        let attached = async {
            self.drain().await?;
            for target in targets {
                let observed = self
                    .resource(&resource)?
                    .host
                    .lock()
                    .await
                    .network()
                    .page_source(&target)
                    .is_some();
                if !observed {
                    self.cdp
                        .request(
                            "Target.attachToTarget",
                            json!({"targetId":target,"flatten":true}),
                            None,
                        )
                        .await?;
                }
            }
            self.drain().await?;
            self.resource(&resource)?.initializing = false;
            Ok(())
        }
        .await;
        if attached.is_err() {
            let _ = self.remove(&resource).await;
        }
        attached
    }

    async fn remove(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
    ) -> Result<(), &'static str> {
        if self.resource(resource).is_err() {
            return Ok(());
        }
        self.retire_resource_contexts(resource).await?;
        if let Some(monitor) = self.resources.remove(&resource.resource_id) {
            let sources = {
                let mut host = monitor.host.lock().await;
                let targets = host.instance_targets(&monitor.instance);
                let sources = targets
                    .iter()
                    .filter_map(|target| host.network().page_source(target))
                    .collect::<Vec<_>>();
                host.instance_observation_lost(&monitor.instance);
                sources
            };
            monitor.changed.notify_waiters();
            for source in sources {
                if let Err(code) = self
                    .cdp
                    .request(
                        "Target.detachFromTarget",
                        json!({"sessionId":source.as_str()}),
                        None,
                    )
                    .await
                {
                    // An unconfirmed withdrawal may retain native Fetch/Page
                    // handlers. Retire their owning connection before returning.
                    self.cdp.retire().await;
                    return Err(code);
                }
            }
            // Dropping this resource's contexts retires only its remote leases.
        }
        Ok(())
    }

    async fn create(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
        permit: &BrowserPageCreationPermit,
        context: &PageCreationContext,
    ) -> Result<BrowserTargetId, &'static str> {
        self.validate_creation_context(resource, context)?;
        let host = Arc::clone(&self.resource(resource)?.host);
        let instance = self.resource(resource)?.instance.clone();
        host.lock()
            .await
            .begin_page_creation(permit, &instance)
            .map_err(|_| "browser_page_creation_not_admitted")?;
        let isolated = matches!(context, PageCreationContext::Isolated);
        let context = match self.creation_context(resource, context).await {
            Ok(context) => context,
            Err(code) => {
                if code == "browser_cdp_request_rejected" {
                    let _ = host.lock().await.page_creation_rejected(permit);
                }
                return Err(code);
            }
        };
        let mut params = json!({"url":"about:blank","background":true});
        context.apply(&mut params);
        let target = self
            .cdp
            .request("Target.createTarget", params, None)
            .await
            .and_then(|result| {
                BrowserTargetId::new(field(&result, "targetId")?)
                    .map_err(|_| "browser_new_page_target_invalid")
            });
        let target = match target {
            Ok(target) => target,
            Err(code) => {
                if isolated {
                    // The confirmed private context bounds every possible target
                    // from this creation, including a lost or malformed reply.
                    self.discard_created_context(&context).await?;
                }
                if code == "browser_cdp_request_rejected" {
                    let _ = host.lock().await.page_creation_rejected(permit);
                } else if isolated {
                    let _ = host.lock().await.created_page_retired(permit);
                }
                return Err(code);
            }
        };
        let reserved = host
            .lock()
            .await
            .reserve_created_page_target(permit, target.clone());
        if reserved.is_err() {
            if super::super::lifecycle::close_targets(&mut self.cdp, &[target])
                .await
                .is_ok()
            {
                if isolated {
                    self.discard_created_context(&context).await?;
                }
                let _ = host.lock().await.created_page_retired(permit);
            }
            return Err("browser_new_page_owner_unavailable");
        }
        self.drain().await?;
        Ok(target)
    }

    async fn resolve_interceptions(&mut self) -> Result<(), &'static str> {
        for monitor in self.resources.values_mut() {
            monitor.resolve_interceptions().await?;
        }
        Ok(())
    }

    async fn run(&mut self, mut receiver: mpsc::Receiver<Barrier>) -> Result<(), &'static str> {
        loop {
            let budget = self
                .resources
                .values()
                .map(Monitor::interception_wait_remaining)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .min();
            let cdp = self.cdp.clone();
            let event = async move {
                let mut cdp = cdp;
                match budget {
                    Some(budget) => timeout(budget, cdp.next_event())
                        .await
                        .map_err(|_| "browser_interception_metadata_timeout")?,
                    None => cdp.next_event().await,
                }
            };
            tokio::select! {
                event = event => self.event(event?).await?,
                request = receiver.recv() => match request {
                    Some(Barrier::FrameScope(resource,frame,sender)) => {
                        let result = match self.resource(&resource) {
                            Ok(monitor) => monitor.frame_scope(&frame).await,
                            Err(code) => Err(code),
                        };
                        let _ = sender.send(result);
                    },
                    Some(Barrier::Observe(resource,sender)) => {
                        if self.resource(&resource).is_ok() {
                            // Preserve the original barrier: pending native
                            // dispatches settle before observation is acknowledged.
                            let result = async {
                                self.census().await?;
                                self.resolve_interceptions().await
                            }.await;
                            let _ = sender.send(result);
                            result?;
                        } else { let _ = sender.send(Err("browser_network_observation_lost")); }
                    },
                    Some(Barrier::Interception(resource,target,sender)) => {
                        if sender.is_closed() { continue; }
                        if let Ok(monitor) = self.resource(&resource) {
                            if monitor.host.lock().await.instance_for_target(&target) != Some(&monitor.instance) {
                                let _ = sender.send(Err("browser_page_owner_mismatch"));
                                continue;
                            }
                            let result = async {
                                monitor.project_interception(&target).await?;
                                monitor.resolve_interceptions().await
                            }.await;
                            let _ = sender.send(result);
                            result?;
                        } else { let _ = sender.send(Err("browser_network_observation_lost")); }
                    },
                    Some(Barrier::Add(monitor,sender)) => {
                        if sender.is_closed() { continue; }
                        let resource = Arc::clone(&monitor.resource);
                        let result = self.add(*monitor).await;
                        let added = result.is_ok();
                        if sender.send(result).is_err() && added { self.remove(&resource).await?; }
                    },
                    Some(Barrier::Create(resource,permit,context,sender)) => {
                        if sender.is_closed() { continue; }
                        let result = self.create(&resource,&permit,&context).await;
                        let _ = sender.send(result);
                    },
                    Some(Barrier::StorageContext(resource,target,sender)) => {
                        if sender.is_closed() { continue; }
                        let result = self.storage_context(&resource,&target).await;
                        let _ = sender.send(result);
                    },
                    Some(Barrier::Remove(resource,sender)) => {
                        let removed = self.remove(&resource).await;
                        let empty = self.resources.is_empty();
                        let _ = sender.send(empty || removed.is_err());
                        removed?;
                        if empty { return Ok(()); }
                    },
                    None => return Ok(()),
                }
            }
            self.resolve_interceptions().await?;
        }
    }
}

pub(super) async fn start(
    host: Arc<Mutex<BrowserResourceHost>>,
    address: &str,
    instance: BrowserInstanceId,
    changed: Arc<Notify>,
) -> Result<BrowserEventMonitor, &'static str> {
    let (barriers, receiver) = mpsc::channel(32);
    let mut cdp = BrowserCdp::connect(address).await?;
    cdp.retain_events().await;
    if let Err(code) = cdp
        .request("Target.setAutoAttach", auto_attach(true), None)
        .await
    {
        cdp.retire().await;
        return Err(code);
    }
    let mut source = Source {
        cdp: cdp.clone(),
        resources: BTreeMap::new(),
    };
    let task = tokio::spawn(async move {
        let _ = source.run(receiver).await;
        for monitor in source.resources.values() {
            let mut host = monitor.host.lock().await;
            host.instance_observation_lost(&monitor.instance);
            monitor.changed.notify_waiters();
        }
        source.cdp.retire().await;
    });
    let source = Arc::new(EventSource {
        instance,
        task: Mutex::new(Some(task)),
    });
    let result = share(&source, &cdp, &barriers, host, changed).await;
    if result.is_err() {
        cdp.retire().await;
        if let Some(task) = source.task.lock().await.take() {
            let _ = task.await;
        }
    }
    result
}

pub(super) async fn share(
    source: &Arc<EventSource>,
    cdp: &BrowserCdp,
    barriers: &mpsc::Sender<Barrier>,
    host: Arc<Mutex<BrowserResourceHost>>,
    changed: Arc<Notify>,
) -> Result<BrowserEventMonitor, &'static str> {
    let state = monitor(
        host.clone(),
        cdp.clone(),
        barriers.clone(),
        source.instance.clone(),
        changed,
    )
    .await;
    let resource = Arc::clone(&state.resource);
    let changed = Arc::clone(&state.changed);
    let navigation = state.navigation.clone();
    let (sender, receiver) = oneshot::channel();
    barriers
        .send(Barrier::Add(Box::new(state), sender))
        .await
        .map_err(|_| "browser_network_observation_lost")?;
    timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "browser_network_observation_timeout")?
        .map_err(|_| "browser_network_observation_lost")??;
    Ok(BrowserEventMonitor {
        cdp: cdp.clone(),
        changed,
        navigation,
        host,
        barriers: barriers.clone(),
        resource,
        source: Arc::clone(source),
    })
}

pub(super) async fn close(monitor: &BrowserEventMonitor) {
    let (sender, receiver) = oneshot::channel();
    let removed = async {
        monitor
            .barriers
            .send(Barrier::Remove(monitor.resource.clone(), sender))
            .await
            .map_err(|_| ())?;
        receiver.await.map_err(|_| ())
    };
    let empty = timeout(Duration::from_secs(5), removed).await;
    if matches!(empty, Ok(Ok(false))) {
        return;
    }
    if !matches!(empty, Ok(Ok(true))) {
        monitor.cdp.retire().await;
    }
    if let Some(task) = monitor.source.task.lock().await.take() {
        let _ = task.await;
    }
    monitor.cdp.retire().await;
    let mut host = monitor.host.lock().await;
    host.instance_observation_lost(&monitor.source.instance);
    monitor.changed.notify_waiters();
}

#[cfg(test)]
mod instances;
#[cfg(test)]
mod tests;
