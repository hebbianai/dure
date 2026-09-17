use super::*;
use hmux_session_protocol::browser_interception::{
    BrowserInterceptionAction, BrowserInterceptionStatus,
};

impl Execution<'_> {
    pub async fn interception_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserInterceptionStatus, BrowserRuntimeError> {
        let observed = self.binding.events.synchronize_events().await.is_ok();
        Ok(self
            .resource
            .host
            .lock()
            .await
            .interception_status(resource, page, observed)?)
    }

    pub(super) async fn configure_interception(
        &self,
        permit: &BrowserActionPermit,
        action: &BrowserInterceptionAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let (target, enabled) = {
            let mut host = self.resource.host.lock().await;
            let target = host.configure_interception(permit, action)?;
            let enabled = host.interception_enabled(&target);
            (target, enabled)
        };
        // The Host has changed its rules. Failure from this point cannot be
        // described as rejection before dispatch or silently replayed.
        self.binding
            .events
            .apply_interception(target)
            .await
            .map_err(BrowserEngineError::after)?;
        Ok(NativeBrowserResponse {
            id: "browser-interception".into(),
            success: true,
            data: json!({"enabled":enabled}),
            error: None,
        })
    }
}
