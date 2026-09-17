use super::{BrowserActionPermit, BrowserRuntimeError, Execution, NativeBrowserResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::browser_network_capture::BrowserNetworkCaptureStatus;
use hmux_session_protocol::browser_resource::{BrowserPageId, BrowserResourceIdentity};
use serde::Deserialize;
use serde_json::json;

mod serialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum NetworkCaptureAction {
    Start,
    Stop,
}

impl Execution<'_> {
    pub async fn network_capture_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserNetworkCaptureStatus, BrowserRuntimeError> {
        let observed = self.binding.events.synchronize_events().await.is_ok();
        Ok(self
            .resource
            .host
            .lock()
            .await
            .network_capture_status(resource, page, observed)?)
    }

    pub(super) async fn capture_network(
        &self,
        permit: &BrowserActionPermit,
        action: NetworkCaptureAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let synchronized = self.binding.events.synchronize_events().await;
        if matches!(action, NetworkCaptureAction::Start) {
            synchronized?;
            self.resource
                .host
                .lock()
                .await
                .start_network_capture(permit)?;
            return Ok(NativeBrowserResponse {
                id: "browser-capture-start".into(),
                success: true,
                data: json!({"started":true}),
                error: None,
            });
        }
        // Stop freezes the retained interval even after observation loss. The
        // Host marks an unconfirmed final event boundary incomplete in the file.
        let captured = self
            .resource
            .host
            .lock()
            .await
            .stop_network_capture(permit, synchronized.is_ok())?;
        let result = serialize::har(captured);
        // The Host stop is already complete even if artifact encoding fails.
        // Report that outcome without retrying the recording transition.
        Ok(match result {
            Ok(bytes) => NativeBrowserResponse {
                id: "browser-capture-stop".into(),
                success: true,
                data: json!({"artifact_payload":{"mime_type":"application/json","suggested_filename":"capture.har","base64":STANDARD.encode(bytes)}}),
                error: None,
            },
            Err(code) => NativeBrowserResponse {
                id: "browser-capture-stop".into(),
                success: false,
                data: json!({"stopped":true}),
                error: Some(code.into()),
            },
        })
    }
}
