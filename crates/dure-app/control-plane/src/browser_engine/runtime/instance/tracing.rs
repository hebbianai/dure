use super::super::tracing::{NativeTracing, TraceMode, TracingAction};
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_host::browser_resource::tracing::{
    BrowserTracingHost, BrowserTracingLease, BrowserTracingStopPermit,
};
use hmux_session_protocol::browser_tracing::{
    BrowserTracingMode, BrowserTracingPageStatus, BrowserTracingStatus, BrowserTracingStopAuthority,
};

pub(super) struct InstanceTracing {
    host: BrowserTracingHost,
    native: Option<NativeTracing>,
}

impl InstanceTracing {
    pub(super) fn new(resource: &lifecycle::ResourceRetirement) -> Self {
        Self {
            host: BrowserTracingHost::new(
                resource.instance_id().clone(),
                resource.identity().clone(),
            ),
            native: None,
        }
    }

    pub(super) fn admit_resource(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        self.host.admit_resource(resource)
    }

    fn release(&mut self, lease: &BrowserTracingLease) {
        self.host
            .finished(lease, true)
            .expect("confirmed native cleanup");
        self.host
            .release(lease)
            .expect("retained native owner matches its Host interval");
        self.native = None;
    }

    fn reconcile(&mut self) {
        if let Some(result) = self.native.as_ref().and_then(NativeTracing::completed)
            && let Some((lease, _)) = self.host.current()
        {
            self.host
                .finished(&lease, result.cleanup_confirmed())
                .expect("retained native interval");
        }
    }

    pub(super) async fn retire_resource(&mut self, resource: &BrowserResourceIdentity) -> bool {
        if self
            .host
            .current()
            .is_some_and(|(_, interval)| &interval.resource == resource)
        {
            self.retire().await
        } else {
            true
        }
    }

    pub(super) async fn retire(&mut self) -> bool {
        let Some((lease, _)) = self.host.current() else {
            return true;
        };
        let closed = match &self.native {
            Some(native) => native
                .retire()
                .await
                .is_ok_and(|result| result.cleanup_confirmed()),
            None => true,
        };
        if closed {
            self.release(&lease);
        }
        closed
    }

    async fn stop(
        &mut self,
        lease: &BrowserTracingLease,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let captured = self
            .native
            .as_ref()
            .ok_or_else(|| BrowserEngineError::after("browser_trace_owner_missing"))?
            .stop()
            .await?;
        if !captured.cleanup_confirmed() {
            self.reconcile();
            return Ok(failed(
                captured
                    .error
                    .unwrap_or("browser_trace_cleanup_unconfirmed"),
            ));
        }
        self.host.finished(lease, true)?;
        let interval = self.host.current().expect("admitted stop").1.clone();
        self.release(lease);
        if let Some(code) = captured.error {
            return Ok(failed(code));
        }
        Ok(NativeBrowserResponse {
            id: "browser-trace-stop".into(),
            success: true,
            data: json!({"stopped":true,"interval":interval,"eventCount":captured.event_count,"dataLoss":captured.data_loss,
                "artifact_payload":{"mime_type":"application/json","suggested_filename":match interval.mode {BrowserTracingMode::Trace=>"trace.json",BrowserTracingMode::Profiler=>"profile.json"},"base64":STANDARD.encode(&captured.bytes)}}),
            error: None,
        })
    }

    pub(super) fn process_exited(&mut self) {
        if let Some((lease, _)) = self.host.current() {
            self.release(&lease);
        }
    }
}

impl BrowserInstanceLease {
    pub(in crate::browser_engine::runtime) async fn tracing_instance_state(
        &self,
        resource_host: &Arc<Mutex<BrowserResourceHost>>,
        resource: &BrowserResourceIdentity,
        instance: &BrowserInstanceId,
    ) -> Result<BrowserTracingStatus, BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        resource_host
            .lock()
            .await
            .require_instance_binding(resource, instance)?;
        lifecycle.tracing.reconcile();
        let status = lifecycle.tracing.host.status(resource);
        if &status.instance_id != instance {
            return Err(BrowserAdmissionError::InstanceMismatch.into());
        }
        Ok(status)
    }

    pub(in crate::browser_engine::runtime) async fn admit_tracing_stop(
        &self,
        resource_host: &Arc<Mutex<BrowserResourceHost>>,
        caller: &BrowserControllerId,
        authority: &BrowserTracingStopAuthority,
    ) -> Result<BrowserTracingStopPermit, BrowserRuntimeError> {
        let lifecycle = self.owner.lifecycle.lock().await;
        if lifecycle.retiring {
            return Err("browser_resource_retiring".into());
        }
        Ok(lifecycle.tracing.host.begin_stop(
            &mut *resource_host.lock().await,
            caller,
            authority,
        )?)
    }

    pub(in crate::browser_engine::runtime) async fn stop_tracing(
        &self,
        resource_host: &Arc<Mutex<BrowserResourceHost>>,
        permit: &BrowserTracingStopPermit,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        resource_host.lock().await.dispatch_tracing_stop(permit)?;
        lifecycle.tracing.host.require_stop(permit)?;
        lifecycle.tracing.stop(permit.lease()).await
    }

    pub(in crate::browser_engine::runtime) async fn tracing_state(
        &self,
        resource_host: &Arc<Mutex<BrowserResourceHost>>,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserTracingPageStatus, BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        let host = resource_host.lock().await;
        let page = host.page_identity(page)?;
        if &page.resource != resource {
            return Err(BrowserAdmissionError::ResourceMismatch.into());
        }
        let instance = host.instance_for_page(&page.page_id)?;
        host.require_instance_binding(resource, instance)?;
        lifecycle.tracing.reconcile();
        let status = lifecycle.tracing.host.status(resource);
        if &status.instance_id != instance {
            return Err(BrowserAdmissionError::InstanceMismatch.into());
        }
        Ok(BrowserTracingPageStatus {
            page,
            tracing: status,
        })
    }

    pub(in crate::browser_engine::runtime) async fn trace(
        &self,
        resource: &Arc<Mutex<BrowserResourceHost>>,
        action: &BrowserActionPermit,
        command: &TracingAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut lifecycle = self.owner.lifecycle.lock().await;
        if lifecycle.retiring {
            return Err("browser_resource_retiring".into());
        }
        let permit = resource.lock().await.prepare_tracing(action)?;
        let connection = self.owner.chromium.lock().await.connection();
        let tracing = &mut lifecycle.tracing;
        tracing.reconcile();
        match command {
            TracingAction::Start {
                mode,
                scope,
                categories,
            } => {
                let lease = tracing.host.start(&permit, *mode, *scope)?;
                let native_mode = match mode {
                    BrowserTracingMode::Trace => TraceMode::Trace,
                    BrowserTracingMode::Profiler => TraceMode::Profiler {
                        categories: categories.clone(),
                    },
                };
                // No await separates admission, spawn and retained native cleanup.
                let native = NativeTracing::spawn(connection, permit.target().clone(), native_mode);
                tracing.native = Some(native.clone());
                let started = native.started().await;
                if let Err(code) = started {
                    let closed = tracing.retire().await;
                    if !closed {
                        tracing.reconcile();
                        return Ok(failed("browser_trace_cleanup_unconfirmed"));
                    }
                    return Ok(failed(code));
                }
                tracing.host.started(&lease)?;
                let (_, interval) = tracing.host.current().expect("admitted start");
                Ok(NativeBrowserResponse {
                    id: "browser-trace-start".into(),
                    success: true,
                    data: json!({"started":true,"interval":interval}),
                    error: None,
                })
            }
            TracingAction::Stop { recording } => {
                let lease = tracing.host.stop(&permit, recording)?;
                tracing.stop(&lease).await
            }
        }
    }
}

fn failed(code: &str) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-trace".into(),
        success: false,
        data: json!({}),
        error: Some(code.into()),
    }
}
