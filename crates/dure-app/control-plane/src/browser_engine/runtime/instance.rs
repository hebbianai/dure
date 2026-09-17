//! The browser process owns its worker and browser-wide download policy.
//! Instance retirement fences published resources before closing either process.
use super::*;
use crate::browser_engine::chromium::OwnedChromium;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};

mod tracing;

struct BrowserInstance {
    engine: Arc<Mutex<NativeBrowserEngine>>,
    chromium: Mutex<OwnedChromium>,
    downloads: Arc<Mutex<Option<download::DownloadState>>>,
    leases: AtomicUsize,
    lifecycle: Mutex<InstanceLifecycle>,
}

struct InstanceLifecycle {
    retiring: bool,
    resources: Vec<lifecycle::ResourceRetirement>,
    tracing: tracing::InstanceTracing,
}

pub(super) struct BrowserInstanceLease {
    owner: Arc<BrowserInstance>,
    state: Mutex<LeaseState>,
}

#[derive(Clone, Copy, PartialEq)]
enum LeaseState {
    Active,
    Retiring,
    Released,
}

impl BrowserInstanceLease {
    pub(super) fn owned(
        chromium: OwnedChromium,
        engine: NativeBrowserEngine,
        downloads: download::DownloadState,
        resource: lifecycle::ResourceRetirement,
    ) -> Self {
        Self {
            owner: Arc::new(BrowserInstance {
                engine: Arc::new(Mutex::new(engine)),
                chromium: Mutex::new(chromium),
                downloads: Arc::new(Mutex::new(Some(downloads))),
                leases: AtomicUsize::new(1),
                lifecycle: Mutex::new(InstanceLifecycle {
                    retiring: false,
                    tracing: tracing::InstanceTracing::new(&resource),
                    resources: vec![resource],
                }),
            }),
            state: Mutex::new(LeaseState::Active),
        }
    }

    pub(super) async fn profile_id(&self) -> Option<dure_app::BrowserProfileIdV1> {
        self.owner.chromium.lock().await.profile_id().cloned()
    }

    pub(super) fn engine(&self) -> Arc<Mutex<NativeBrowserEngine>> {
        Arc::clone(&self.owner.engine)
    }

    pub(super) fn downloads(&self) -> Arc<Mutex<Option<download::DownloadState>>> {
        Arc::clone(&self.owner.downloads)
    }

    pub(super) async fn share<F>(
        &self,
        resource: &BrowserResourceIdentity,
        create: impl FnOnce(Result<Self, BrowserRuntimeError>) -> F,
    ) where
        F: Future<Output = ()>,
    {
        let state = self.state.lock().await;
        let lease = if *state != LeaseState::Active {
            Err("browser_resource_retiring".into())
        } else {
            let mut lifecycle = self.owner.lifecycle.lock().await;
            if lifecycle.retiring {
                Err("browser_resource_retiring".into())
            } else if let Err(error) = lifecycle.tracing.admit_resource(resource) {
                Err(error.into())
            } else {
                self.owner
                    .leases
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                        count.checked_add(1)
                    })
                    .map(|_| Self {
                        owner: Arc::clone(&self.owner),
                        state: Mutex::new(LeaseState::Active),
                    })
                    .map_err(|_| "browser_instance_lease_exhausted".into())
            }
        };
        // Origin retirement waits for construction and failed publication to
        // settle. Other resources still use the instance's ordinary authority.
        create(lease).await;
        drop(state);
    }

    pub(super) async fn launch_page(&self) -> Result<BrowserTargetId, BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        if lifecycle.retiring {
            return Err("browser_resource_retiring".into());
        }
        let created = self.owner.chromium.lock().await.launch_page().await;
        if let Err(error) = &created
            && error.outcome_unknown
        {
            // Without the native target identity, this exact process is the
            // remaining cleanup authority. Fence every resource before exit.
            self.owner.close(&mut lifecycle).await.map_err(|_| {
                BrowserEngineError::after("browser_instance_retirement_unconfirmed")
            })?;
        }
        Ok(created?)
    }

    pub(super) async fn retain_resource(
        &self,
        resource: lifecycle::ResourceRetirement,
    ) -> Result<(), BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        lifecycle.resources.push(resource);
        if lifecycle.retiring {
            // A concurrent construction cannot publish after instance retirement.
            // Its completed handles join the same exact cleanup path.
            self.owner.close(&mut lifecycle).await?;
            return Err("browser_resource_retiring".into());
        }
        Ok(())
    }

    pub(super) async fn retire_unaccounted_creation(&self) -> Result<(), BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        self.owner.close(&mut lifecycle).await.map_err(|_| {
            BrowserEngineError::after("browser_instance_retirement_unconfirmed").into()
        })
    }

    pub(super) async fn connection(&self) -> super::super::chromium::ChromiumConnection {
        self.owner.chromium.lock().await.connection()
    }

    #[cfg(test)]
    pub(super) async fn browser_has_exited(&self) -> Result<bool, BrowserEngineError> {
        self.owner.chromium.lock().await.has_exited()
    }

    #[cfg(test)]
    pub(super) async fn replace_test_endpoint(&self, endpoint: String) -> String {
        self.owner
            .chromium
            .lock()
            .await
            .replace_test_endpoint(endpoint)
    }

    pub(super) async fn release(
        &self,
        retirement: lifecycle::ResourceRetirement,
        retire_pages: impl Future<Output = Result<(), BrowserRuntimeError>>,
    ) -> Result<(), BrowserRuntimeError> {
        let mut state = self.state.lock().await;
        let mut lifecycle = self.owner.lifecycle.lock().await;
        if *state == LeaseState::Released {
            return Ok(());
        }
        // Retain native cleanup handles before any cancellable retirement. They
        // contain no instance lease, so a dropped caller cannot create a cycle.
        let resource = if let Some(index) = lifecycle
            .resources
            .iter()
            .position(|entry| entry.same_resource(&retirement))
        {
            index
        } else {
            lifecycle.resources.push(retirement);
            lifecycle.resources.len() - 1
        };
        lifecycle.resources[resource].begin().await?;
        let identity = lifecycle.resources[resource].identity().clone();
        let trace_closed = lifecycle.tracing.retire_resource(&identity).await;
        if *state == LeaseState::Active {
            self.owner.leases.fetch_sub(1, Ordering::AcqRel);
            *state = LeaseState::Retiring;
        }
        // A failed page retirement keeps its retry authority, but it cannot
        // keep the process alive after every resource has fenced new input.
        if !trace_closed || lifecycle.retiring || self.owner.leases.load(Ordering::Acquire) == 0 {
            self.owner.close(&mut lifecycle).await?;
        } else {
            retire_pages.await?;
            lifecycle.resources[resource].complete().await?;
            lifecycle.resources.remove(resource);
        }
        *state = LeaseState::Released;
        Ok(())
    }
}

impl BrowserInstance {
    async fn close(&self, lifecycle: &mut InstanceLifecycle) -> Result<(), BrowserRuntimeError> {
        lifecycle.retiring = true;
        for resource in &lifecycle.resources {
            resource.begin().await?;
        }
        lifecycle.tracing.retire().await;
        // Attempt both exact retirements even after an uncertain worker close.
        let worker = self.engine.lock().await.close().await;
        let browser = self.chromium.lock().await.close().await;
        #[cfg(test)]
        if worker.is_err() || browser.is_err() {
            eprintln!("BROWSER_INSTANCE_NATIVE_RETIREMENT worker={worker:?} browser={browser:?}");
        }
        worker?;
        browser?;
        lifecycle.tracing.process_exited();
        {
            let mut downloads = self.downloads.lock().await;
            if let Some(downloads) = downloads.as_mut() {
                downloads.close().await?;
            }
            downloads.take();
        }
        while let Some(retirement) = lifecycle.resources.last() {
            retirement.complete().await?;
            lifecycle.resources.pop();
        }
        Ok(())
    }
}

impl Drop for BrowserInstanceLease {
    fn drop(&mut self) {
        let state = *self.state.get_mut();
        if state == LeaseState::Active {
            self.owner.leases.fetch_sub(1, Ordering::AcqRel);
        }
        if state != LeaseState::Released
            && self.owner.leases.load(Ordering::Acquire) == 0
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let owner = Arc::clone(&self.owner);
            runtime.spawn(async move {
                let mut lifecycle = owner.lifecycle.lock().await;
                let _ = owner.close(&mut lifecycle).await;
            });
        }
        // Explicit retirement remains the path that can report a confirmed exit.
    }
}
