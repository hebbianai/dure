//! One retained event connection observes network activity and page dialogs.

use super::BrowserCdp;
use hmux_host::browser_network::BrowserNetworkId;
use hmux_host::browser_resource::BrowserResourceHost;
use hmux_host::browser_resource::creation::BrowserPageCreationPermit;
use hmux_session_protocol::browser_resource::{
    BrowserInstanceId, BrowserResourceId, BrowserResourceIdentity, BrowserTargetId,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc, time::Instant};
use tokio::sync::{Mutex, Notify, broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Duration, timeout};

enum Barrier {
    FrameScope(
        Arc<BrowserResourceIdentity>,
        hmux_session_protocol::browser_resource::BrowserFrameIdentity,
        oneshot::Sender<Result<crate::browser_engine::cdp::FrameScope, &'static str>>,
    ),
    Observe(
        Arc<BrowserResourceIdentity>,
        oneshot::Sender<Result<(), &'static str>>,
    ),
    Interception(
        Arc<BrowserResourceIdentity>,
        BrowserTargetId,
        oneshot::Sender<Result<(), &'static str>>,
    ),
    Add(Box<Monitor>, oneshot::Sender<Result<(), &'static str>>),
    Remove(Arc<BrowserResourceIdentity>, oneshot::Sender<bool>),
    Create(
        Arc<BrowserResourceIdentity>,
        BrowserPageCreationPermit,
        PageCreationContext,
        oneshot::Sender<Result<BrowserTargetId, &'static str>>,
    ),
    StorageContext(
        Arc<BrowserResourceIdentity>,
        BrowserTargetId,
        oneshot::Sender<Result<BrowserStorageContext, &'static str>>,
    ),
}
mod console;
mod dialog;
mod frames;
mod interception;
pub(super) mod navigation;
mod network;
mod source;
pub(super) use source::{BrowserStorageContext, PageCreationContext};

#[derive(Clone)]
pub(super) struct BrowserEventMonitor {
    pub(super) cdp: BrowserCdp,
    pub(super) changed: Arc<Notify>,
    pub(super) navigation: broadcast::Sender<navigation::NavigationEvent>,
    host: Arc<Mutex<BrowserResourceHost>>,
    barriers: mpsc::Sender<Barrier>,
    resource: Arc<BrowserResourceIdentity>,
    source: Arc<source::EventSource>,
}

struct Monitor {
    instance: BrowserInstanceId,
    // The allocation identifies this registration, including a reattachment
    // of an unchanged resource identity. Only its issued handles may address it.
    resource: Arc<BrowserResourceIdentity>,
    changed: Arc<Notify>,
    navigation: broadcast::Sender<navigation::NavigationEvent>,
    cdp: BrowserCdp,
    host: Arc<Mutex<BrowserResourceHost>>,
    initializing: bool,
    contexts: console::ConsoleContexts,
    private_contexts: BTreeSet<String>,
    interceptions: std::collections::VecDeque<interception::PausedRequest>,
    barriers: mpsc::Sender<Barrier>,
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    value[name].as_str().ok_or("browser_network_event_invalid")
}

fn auto_attach(root: bool) -> Value {
    json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,
        "filter":if root { json!([{"type":"page","exclude":false},{"exclude":true}]) }
                 else { json!([{"type":"page","exclude":true},{"exclude":false}]) }})
}

impl Monitor {
    async fn event(&mut self, event: Value) -> Result<(), &'static str> {
        let navigation = self.navigation_event(&event).await?;
        let result = match self.apply_event(event).await {
            Ok(()) => self.resolve_interceptions().await,
            Err(code) => Err(code),
        };
        if result.is_ok()
            && let Some(navigation) = navigation
        {
            let _ = self.navigation.send(navigation);
        }
        self.changed.notify_waiters();
        result
    }

    async fn apply_event(&mut self, event: Value) -> Result<(), &'static str> {
        if self.authentication_event(&event).await?
            || self.interception_event(&event)?
            || self.console_event(&event).await?
        {
            return Ok(());
        }
        let method = field(&event, "method")?;
        let params = &event["params"];
        if method == "Target.attachedToTarget" {
            let session = field(params, "sessionId")?;
            let source = BrowserNetworkId::new(session)?;
            let info = &params["targetInfo"];
            let engine_target = BrowserTargetId::new(field(info, "targetId")?)
                .map_err(|_| "browser_network_target_invalid")?;
            let target = if info["type"] == "page" {
                engine_target.clone()
            } else {
                let parent = BrowserNetworkId::new(field(&event, "sessionId")?)?;
                self.host
                    .lock()
                    .await
                    .network()
                    .source_target(&parent)
                    .cloned()
                    .ok_or("browser_network_parent_missing")?
            };
            // The only unpaused initial page is the owned blank launch target.
            let from_start = params["waitingForDebugger"] == true
                || (self.initializing
                    && info["type"] == "page"
                    && (info["url"] == "about:blank" || info["url"] == ""));
            let service_worker = info["type"] == "service_worker";
            if service_worker {
                self.cdp
                    .request("Target.setAutoAttach", auto_attach(false), Some(session))
                    .await?;
                let mut network = self.cdp.clone();
                let mut runtime = self.cdp.clone();
                // Chromium pauses service workers before fetching their script.
                // Network.enable observes that fetch, but its reply requires the
                // worker to start. Queue both observers before the resume command
                // on the ordered wire; await every reply before publishing a source.
                tokio::try_join!(
                    biased;
                    network.request("Network.enable", json!({}), Some(session)),
                    runtime.request("Runtime.enable", json!({}), Some(session)),
                    self.cdp.request("Runtime.runIfWaitingForDebugger", json!({}), Some(session)),
                )?;
            } else {
                self.cdp
                    .request("Network.enable", json!({}), Some(session))
                    .await?;
                self.cdp
                    .request("Runtime.enable", json!({}), Some(session))
                    .await?;
            }
            let frame_tree = if matches!(info["type"].as_str(), Some("page" | "iframe")) {
                // Page events track each renderer's frame lifetime. Dialog
                // handling still belongs to the root page's WebContents.
                self.cdp
                    .request("Page.enable", json!({}), Some(session))
                    .await?;
                Some(
                    self.cdp
                        .request("Page.getFrameTree", json!({}), Some(session))
                        .await?,
                )
            } else {
                None
            };
            if !service_worker {
                self.cdp
                    .request("Target.setAutoAttach", auto_attach(false), Some(session))
                    .await?;
            }
            let (intercept, authentication) = {
                let host = self.host.lock().await;
                (
                    host.interception_enabled(&target)
                        || host
                            .request_headers(&target)
                            .is_some_and(|headers| !headers.is_empty()),
                    host.handles_http_authentication(&target),
                )
            };
            if (intercept || authentication)
                && matches!(info["type"].as_str(), Some("page" | "iframe"))
            {
                self.set_interception(session, intercept, authentication)
                    .await?;
            }
            if !service_worker {
                self.cdp
                    .request("Runtime.runIfWaitingForDebugger", json!({}), Some(session))
                    .await?;
            }
            // Publish the source only once it can answer renderer requests.
            // Events emitted during setup remain ordered in the bounded queue.
            // A concurrent census must not send a barrier into a paused target.
            let mut host = self.host.lock().await;
            if host.page_target_is_retiring(&target) {
                // Replacement may have happened while this attachment enabled
                // its domains. Withdraw this exact session; it cannot rebind.
                drop(host);
                source::detach_retiring_target(
                    &mut self.cdp,
                    &target,
                    session,
                    event["sessionId"].as_str(),
                )
                .await?;
                return Ok(());
            }
            host.network().attach(
                source,
                engine_target,
                target.clone(),
                from_start,
                Instant::now(),
            )?;
            if let Some(tree) = frame_tree {
                if info["type"] == "page" {
                    let document = frames::document(&tree["frameTree"]["frame"])?;
                    host.observe_page_document(self.instance.clone(), target.clone(), document)
                        .map_err(|_| "browser_page_invalid")?;
                }
                // A replacement retains its native source before Host publishes
                // the logical page. Frame authority starts with that publication.
                if let Some(page) = host.page_for_target(&target) {
                    frames::observe_tree(&mut host, &page, &tree["frameTree"])?;
                }
            }
            return Ok(());
        }
        if method == "Target.detachedFromTarget" {
            let source = BrowserNetworkId::new(field(params, "sessionId")?)?;
            let mut host = self.host.lock().await;
            host.dialog_source_detached(
                &hmux_session_protocol::browser_resource::BrowserDialogSourceId::new(
                    source.as_str(),
                )
                .map_err(|_| "browser_dialog_source_invalid")?,
            );
            host.network().detach(&source, Instant::now());
            return Ok(());
        }
        if self.page_event(&event).await? {
            return Ok(());
        }
        self.network_event(&event).await
    }
}

impl BrowserEventMonitor {
    pub(super) fn instance(&self) -> &BrowserInstanceId {
        &self.source.instance
    }

    pub(super) async fn start(
        host: Arc<Mutex<BrowserResourceHost>>,
        address: &str,
        instance: BrowserInstanceId,
        changed: Arc<Notify>,
    ) -> Result<Self, &'static str> {
        source::start(host, address, instance, changed).await
    }

    pub(super) async fn share(
        &self,
        host: Arc<Mutex<BrowserResourceHost>>,
        changed: Arc<Notify>,
    ) -> Result<Self, &'static str> {
        source::share(&self.source, &self.cdp, &self.barriers, host, changed).await
    }

    pub(super) async fn create_page(
        &self,
        permit: BrowserPageCreationPermit,
    ) -> Result<BrowserTargetId, &'static str> {
        self.create_page_in(permit, PageCreationContext::Default)
            .await
    }

    pub(super) async fn create_page_in(
        &self,
        permit: BrowserPageCreationPermit,
        context: PageCreationContext,
    ) -> Result<BrowserTargetId, &'static str> {
        let (sender, receiver) = oneshot::channel();
        self.barriers
            .send(Barrier::Create(
                self.resource.clone(),
                permit,
                context,
                sender,
            ))
            .await
            .map_err(|_| "browser_network_observation_lost")?;
        timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "browser_new_page_outcome_unknown")?
            .map_err(|_| "browser_network_observation_lost")?
    }

    pub(super) async fn storage_context(
        &self,
        target: BrowserTargetId,
    ) -> Result<BrowserStorageContext, &'static str> {
        let (sender, receiver) = oneshot::channel();
        self.barriers
            .send(Barrier::StorageContext(
                self.resource.clone(),
                target,
                sender,
            ))
            .await
            .map_err(|_| "browser_network_observation_lost")?;
        timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "browser_storage_context_unavailable")?
            .map_err(|_| "browser_network_observation_lost")?
    }

    pub(super) async fn synchronize_events(&self) -> Result<(), &'static str> {
        synchronize_events(&self.barriers, &self.resource).await
    }

    pub(super) async fn settle_page_creation(&self) -> Result<(), &'static str> {
        // Completion must follow the ordered creator's bounded native work,
        // even when the original caller or its response deadline is gone.
        observe_events(&self.barriers, &self.resource).await
    }

    pub(super) async fn synchronize(&self, target: &BrowserTargetId) -> Result<(), &'static str> {
        if self.host.lock().await.instance_for_target(target) != Some(&self.source.instance) {
            return Err("browser_page_owner_mismatch");
        }
        let started = Instant::now();
        // A newly created page must be registered before binding its clock.
        // The control-plane census retains its existing wall-time bound.
        self.synchronize_events().await?;
        let budget = Duration::from_secs(5).saturating_sub(started.elapsed());
        let mut cdp = super::execution::renderer_cdp(
            &self.host,
            &self.changed,
            self.cdp.clone(),
            target.clone(),
            None,
        );
        let deadline = cdp.deadline(budget);
        let synchronize = async {
            let sources = {
                let mut host = self.host.lock().await;
                let network = host.network();
                network
                    .sources()
                    .into_iter()
                    .filter(|source| network.source_target(source) == Some(target))
                    .collect::<Vec<_>>()
            };
            for source in sources {
                // Include every attached source owned by this page, including
                // frames and workers. Dialog response stays on the event loop.
                let response = cdp
                    .request("Runtime.getIsolateId", json!({}), Some(source.as_str()))
                    .await;
                self.synchronize_events().await?;
                if self.host.lock().await.network().source_is_attached(&source) {
                    response?;
                }
            }
            Ok(())
        };
        // One five-second active budget covers all sources and event drains;
        // human dialog time belongs to this page's existing Host clock.
        let result = tokio::select! {
            biased;
            result = synchronize => result,
            code = deadline => Err(code),
        };
        result.map_err(|code| {
            if code == "browser_cdp_response_timeout" {
                "browser_network_observation_timeout"
            } else {
                code
            }
        })
    }

    pub(super) async fn synchronize_pages(
        &self,
        targets: &[&BrowserTargetId],
    ) -> Result<(), &'static str> {
        self.synchronize_events().await?;
        for target in targets {
            let source = {
                let mut host = self.host.lock().await;
                if host.instance_for_target(target) != Some(&self.source.instance) {
                    return Err("browser_page_owner_mismatch");
                }
                host.network()
                    .page_source(target)
                    .ok_or("browser_page_source_missing")?
            };
            super::execution::renderer_cdp(
                &self.host,
                &self.changed,
                self.cdp.clone(),
                (*target).clone(),
                None,
            )
            .request("Runtime.getIsolateId", json!({}), Some(source.as_str()))
            .await?;
        }
        self.synchronize_events().await
    }

    pub(super) async fn close(&self) {
        source::close(self).await;
    }
}

async fn synchronize_events(
    barriers: &mpsc::Sender<Barrier>,
    resource: &Arc<BrowserResourceIdentity>,
) -> Result<(), &'static str> {
    timeout(Duration::from_secs(5), observe_events(barriers, resource))
        .await
        .map_err(|_| "browser_network_observation_timeout")?
}

async fn observe_events(
    barriers: &mpsc::Sender<Barrier>,
    resource: &Arc<BrowserResourceIdentity>,
) -> Result<(), &'static str> {
    let (sender, receiver) = oneshot::channel();
    barriers
        .send(Barrier::Observe(resource.clone(), sender))
        .await
        .map_err(|_| "browser_network_observation_lost")?;
    receiver
        .await
        .map_err(|_| "browser_network_observation_lost")?
}
