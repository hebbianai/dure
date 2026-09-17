use super::{BrowserActionPermit, BrowserRuntimeError, Execution, NativeBrowserResponse};
use hmux_session_protocol::browser_network::{
    BrowserNetworkBody, BrowserNetworkDetail, BrowserNetworkSequence, BrowserNetworkSnapshot,
};
use hmux_session_protocol::browser_resource::{
    BrowserPageId, BrowserPageIdentity, BrowserResourceIdentity,
};
use serde_json::json;
use std::time::Instant;

impl Execution<'_> {
    pub async fn network_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserNetworkSnapshot, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let host = self.resource.host.lock().await;
        Ok(host.network_state(resource, page, Instant::now())?)
    }

    pub(super) async fn clear_network(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let removed = self.resource.host.lock().await.clear_network(permit)?;
        Ok(NativeBrowserResponse {
            id: "browser-network-clear".into(),
            success: true,
            data: json!({"cleared":true,"removed":removed}),
            error: None,
        })
    }

    pub async fn network_detail(
        &self,
        page: &BrowserPageIdentity,
        sequence: BrowserNetworkSequence,
    ) -> Result<BrowserNetworkDetail, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let read = self
            .resource
            .host
            .lock()
            .await
            .network_read(page, sequence)?
            .ok_or("browser_network_request_missing")?;
        let Some((source, request)) = &read.body_source else {
            let mut detail = read.detail;
            detail.body_error = Some("browser_network_body_unavailable".into());
            return Ok(detail);
        };
        // The retained data-received count bounds the body query independently
        // of its compressed transfer size and the existing artifact budget.
        const MAX_BODY_BYTES: usize = super::capture::MAX_ARTIFACT_BYTES;
        if read
            .decoded_bytes
            .is_none_or(|bytes| bytes > MAX_BODY_BYTES as u64)
        {
            let mut detail = read.detail;
            detail.body_error = Some("browser_network_body_limit".into());
            return Ok(detail);
        }
        let response = self
            .binding
            .events
            .cdp
            .clone()
            .request(
                "Network.getResponseBody",
                json!({"requestId":request.as_str()}),
                Some(source.as_str()),
            )
            .await;
        self.binding.events.synchronize_events().await?;
        let after = self
            .resource
            .host
            .lock()
            .await
            .network_read(page, sequence)?
            .ok_or("browser_network_request_missing")?;
        if after.body_source != read.body_source {
            return Err("browser_network_request_changed".into());
        }
        let mut detail = after.detail;
        match response {
            Ok(response) => {
                let data = response["body"]
                    .as_str()
                    .ok_or("browser_network_body_invalid")?;
                let encoded = response["base64Encoded"]
                    .as_bool()
                    .ok_or("browser_network_body_invalid")?;
                detail.body = Some(BrowserNetworkBody {
                    data: data.to_owned(),
                    base64_encoded: encoded,
                    truncated: false,
                });
            }
            Err(code) => detail.body_error = Some(code.into()),
        }
        Ok(detail)
    }

    pub async fn network(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<BrowserNetworkSnapshot, BrowserRuntimeError> {
        let mut engine = self.engine().await?;
        self.observe_engine(&mut engine).await?;
        self.network_snapshot(page).await
    }

    pub(super) async fn network_snapshot(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<BrowserNetworkSnapshot, BrowserRuntimeError> {
        let target = self.resource.host.lock().await.target_for(page)?.clone();
        self.binding.events.synchronize(&target).await?;
        Ok(self
            .resource
            .host
            .lock()
            .await
            .network_snapshot(page, Instant::now())?)
    }
}

#[cfg(test)]
use super::BrowserRuntime;
#[cfg(test)]
mod tests;
