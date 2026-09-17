//! The instance retains command-worker transitions independently of waiters.
//! Page, input and observer lifetimes continue to belong to Host and Chromium.
use super::*;
use tokio::sync::OwnedMutexGuard;

impl Execution<'_> {
    pub(super) async fn engine(
        &self,
    ) -> Result<OwnedMutexGuard<NativeBrowserEngine>, BrowserRuntimeError> {
        let mut engine = Arc::clone(&self.binding.engine).lock_owned().await;
        if !engine.disconnected() {
            return Ok(engine);
        }
        let target = {
            let host = self.resource.host.lock().await;
            let instance = self.binding.events.instance();
            host.require_instance_binding(&host.projection().resource, instance)?;
            let current = host
                .current_page()
                .filter(|page| host.instance_for_page(&page.page_id).ok() == Some(instance));
            let page = current
                .or_else(|| {
                    host.pages()
                        .into_iter()
                        .find(|page| host.instance_for_page(&page.page_id).ok() == Some(instance))
                })
                .ok_or(BrowserAdmissionError::PageGone)?;
            let target = host.target_for(&page)?.clone();
            // The new child is retained in the shared instance before Host
            // admission is released and before any cancellable startup wait.
            engine.start_reconnect()?;
            target
        };
        tokio::spawn(async move {
            engine.finish_reconnect(&target).await?;
            Ok(engine)
        })
        .await
        .map_err(|_| BrowserEngineError::after("browser_engine_reconnect_interrupted"))?
    }

    pub(super) async fn disconnect_worker(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut engine = Arc::clone(&self.binding.engine).lock_owned().await;
        self.resource.host.lock().await.dispatch_target(permit)?;
        // A canceled caller cannot release this lock during retirement. Resource
        // close and peer commands join this exact transition before proceeding.
        tokio::spawn(async move {
            engine.disconnect().await?;
            Ok(NativeBrowserResponse {
                id: "browser-disconnect".into(),
                success: true,
                data: json!({"closed":true}),
                error: None,
            })
        })
        .await
        .map_err(|_| BrowserEngineError::after("browser_engine_disconnect_interrupted"))?
    }
}
