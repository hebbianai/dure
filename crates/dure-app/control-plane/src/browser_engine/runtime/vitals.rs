//! A reload measurement remains one admitted action on its committed document.

use super::*;
use std::time::Duration;

mod data;
mod report;

impl Execution<'_> {
    pub(super) async fn vitals_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &mut BrowserActionPermit,
        cdp: BrowserCdp,
        url: Option<&str>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let (target, source, navigation) = {
            let mut host = self.resource.host.lock().await;
            let target = host.dispatch_target(permit)?.clone();
            let source = host
                .network()
                .page_source(&target)
                .ok_or("browser_page_source_missing")?;
            (target, source, host.prepare_action_navigation(permit)?)
        };
        let mut retained = self.renderer_cdp(self.binding.events.cdp.clone(), target.clone());
        let initial = self
            .evaluate_action(
                permit,
                cdp.clone(),
                include_str!("vitals/init.js"),
                ENGINE_DEADLINE,
            )
            .await?;
        if !initial.success {
            return Ok(initial);
        }
        let tree = retained
            .request("Page.getFrameTree", json!({}), Some(source.as_str()))
            .await?;
        let original_document = BrowserDocumentId::new(
            tree["frameTree"]["frame"]["loaderId"]
                .as_str()
                .ok_or("browser_vitals_document_invalid")?,
        )
        .map_err(|_| "browser_vitals_document_invalid")?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let registered = retained
            .request(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({
                    "source":include_str!("vitals/init.js")
                }),
                Some(source.as_str()),
            )
            .await
            .map_err(|_| BrowserEngineError::after("browser_vitals_registration_unknown"))?;
        let identifier = registered["identifier"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| BrowserEngineError::after("browser_vitals_registration_unknown"))?;
        let navigated: Result<_, BrowserRuntimeError> = async {
            let (response, document) = if let Some(url) = url {
                let response = self
                    .navigate_page(permit, cdp.clone(), &target, url)
                    .await?;
                let document = response.data["loaderId"]
                    .as_str()
                    .map(BrowserDocumentId::new)
                    .transpose()
                    .map_err(|_| "browser_vitals_document_invalid")?;
                (response, document)
            } else {
                self.history_navigation(permit, pages::history::HistoryAction::Reload)
                    .await?
            };
            if !response.success {
                return Ok(Some(response));
            }
            // Same-document navigation and dismissed beforeunload retain the
            // original loader. Never obtain a replacement from a later census.
            let document = document.unwrap_or(original_document);
            self.observe_engine(engine).await?;
            self.resource
                .host
                .lock()
                .await
                .continue_action_navigation(permit, navigation, &document)?;
            Ok(None)
        }
        .await;
        // Remove this exact registration even when navigation fails. Caller
        // disconnection cannot cancel the retained action/completion worker.
        retained
            .request(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
                Some(source.as_str()),
            )
            .await
            .map_err(|_| BrowserEngineError::after("browser_vitals_cleanup_unknown"))?;
        let navigated = navigated
            .map_err(|_| BrowserEngineError::after("browser_vitals_navigation_unknown"))?;
        if let Some(response) = navigated {
            return Ok(response);
        }
        // Preserve upstream's three-second observation window, using the
        // renderer clock so dialogs suspend it and retirement ends it.
        let settled = cdp.deadline(Duration::from_secs(3)).await;
        if settled != "browser_cdp_response_timeout" {
            return Err(BrowserEngineError::after("browser_vitals_measurement_interrupted").into());
        }
        let response = self
            .evaluate_action(permit, cdp, include_str!("vitals/read.js"), ENGINE_DEADLINE)
            .await?;
        if !response.success {
            return Ok(response);
        }
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let raw: Value = serde_json::from_str(
            response.data["result"]
                .as_str()
                .ok_or("browser_vitals_data_invalid")?,
        )
        .map_err(|_| "browser_vitals_data_invalid")?;
        if !["lcp", "cls", "clsEntries", "fcp", "inp"]
            .iter()
            .all(|key| raw["cwv"].get(key).is_some())
            || !raw["timing"].is_array()
        {
            return Err("browser_vitals_data_invalid".into());
        }
        let url = response.data["origin"]
            .as_str()
            .ok_or("browser_vitals_url_missing")?;
        Ok(NativeBrowserResponse {
            id: "browser-vitals".into(),
            success: true,
            data: data::measurement(url, &raw)?,
            error: None,
        })
    }
}
