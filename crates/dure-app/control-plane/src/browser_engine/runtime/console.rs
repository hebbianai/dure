use super::{BrowserActionPermit, BrowserRuntimeError, Execution, NativeBrowserResponse};
use hmux_session_protocol::browser_console::{
    BrowserConsoleKind, BrowserConsoleQuery, BrowserConsoleSnapshot,
};
use hmux_session_protocol::browser_resource::{BrowserPageId, BrowserResourceIdentity};
use serde_json::json;

impl Execution<'_> {
    pub async fn console(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
        query: BrowserConsoleQuery,
    ) -> Result<BrowserConsoleSnapshot, BrowserRuntimeError> {
        // Observe the retained event stream without entering a renderer. Logs
        // remain available while input or a human dialog is still pending.
        self.binding.events.synchronize_events().await?;
        Ok(self
            .resource
            .host
            .lock()
            .await
            .console_snapshot(resource, page, query)?)
    }

    pub(super) async fn clear_console(
        &self,
        permit: &BrowserActionPermit,
        kind: Option<BrowserConsoleKind>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let removed = self
            .resource
            .host
            .lock()
            .await
            .clear_console(permit, kind)?;
        Ok(NativeBrowserResponse {
            id: "browser-console-clear".into(),
            success: true,
            data: json!({"cleared":true,"removed":removed}),
            error: None,
        })
    }
}
