use super::{BackendDispatchError, BrowserPageIdentity, BrowserService, runtime_error};
use serde_json::Value;

impl BrowserService {
    pub(super) async fn image(
        &self,
        page: &BrowserPageIdentity,
        frame: bool,
    ) -> Result<Value, BackendDispatchError> {
        let runtime = self.bound_resource(&page.resource).await?;
        let captured = if frame {
            runtime.frame(page).await
        } else {
            runtime.screenshot(page).await
        }
        .map_err(runtime_error)?;
        // Large exports use persisted artifacts. Live frames and the legacy
        // screenshot read stay within the existing authenticated carrier bound.
        if captured["base64"]
            .as_str()
            .is_some_and(|data| data.len() > crate::MAX_RESPONSE_BYTES as usize - 64 * 1024)
        {
            return Err(BackendDispatchError::terminal(
                "browser_capture_requires_artifact",
            ));
        }
        Ok(captured)
    }
}
