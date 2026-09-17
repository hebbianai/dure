//! Admitted page evaluation uses the same owned renderer transport as input.

use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, ENGINE_DEADLINE, NativeBrowserResponse};
use serde_json::{Value, json};
use std::time::Duration;

impl Execution<'_> {
    pub(super) async fn insert_text(
        &self,
        permit: &BrowserActionPermit,
        mut cdp: BrowserCdp,
        text: &str,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let session = cdp.attach(target.as_str()).await?;
        self.resource.host.lock().await.dispatch_frame(permit)?;
        cdp.request_with_deadline(
            "Input.insertText",
            json!({"text":text}),
            Some(&session),
            ENGINE_DEADLINE,
        )
        .await
        .map_err(|_| BrowserEngineError::after("browser_insertion_outcome_unknown"))?;
        Ok(NativeBrowserResponse {
            id: "browser-insert".into(),
            success: true,
            data: json!({"inserted":true}),
            error: None,
        })
    }

    pub(super) async fn evaluate_action(
        &self,
        permit: &BrowserActionPermit,
        mut cdp: BrowserCdp,
        script: &str,
        budget: Duration,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let session = cdp.attach(target.as_str()).await?;
        self.resource.host.lock().await.dispatch_frame(permit)?;
        let mut params = json!({"expression":script,"returnByValue":true,"awaitPromise":true});
        cdp.evaluation_context(&mut params);
        let frame_origin = if cdp.frame().is_some() {
            Some(
                cdp.frame_metadata(&session).await?["url"]
                    .as_str()
                    .ok_or("browser_frame_metadata_invalid")?
                    .to_owned(),
            )
        } else {
            None
        };
        self.resource.host.lock().await.dispatch_frame(permit)?;
        let result = cdp
            .request_with_deadline("Runtime.evaluate", params, Some(&session), budget)
            .await
            .map_err(|_| BrowserEngineError::after("browser_evaluation_outcome_unknown"))?;
        if let Some(details) = result.get("exceptionDetails") {
            let message = details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("Evaluation failed");
            return Ok(NativeBrowserResponse {
                id: "browser-evaluate".into(),
                success: false,
                data: Value::Null,
                error: Some(format!("Evaluation error: {message}")),
            });
        }
        // Browser-side target metadata remains readable if this script starts
        // another dialog. Reading a renderer property here could block again.
        let origin = if let Some(origin) = frame_origin {
            origin
        } else {
            cdp.request("Target.getTargetInfo", json!({"targetId":target}), None)
                .await
                .ok()
                .and_then(|info| info["targetInfo"]["url"].as_str().map(str::to_owned))
                .unwrap_or_default()
        };
        Ok(NativeBrowserResponse {
            id: "browser-evaluate".into(),
            success: true,
            data: json!({"result":result["result"]["value"],"origin":origin}),
            error: None,
        })
    }
}
