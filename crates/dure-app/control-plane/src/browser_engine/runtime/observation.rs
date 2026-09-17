use super::{
    BrowserCdp, BrowserQuery, BrowserRuntimeError, BrowserSnapshot, EngineObservation, Execution,
    NativeBrowserEngine, NativeTab,
};
use hmux_session_protocol::browser_resource::*;
use serde_json::{Value, json};

impl Execution<'_> {
    pub(super) async fn observe_tabs(
        &self,
        engine: &mut NativeBrowserEngine,
    ) -> Result<Vec<NativeTab>, BrowserRuntimeError> {
        let state = engine.require(json!({"action":"tab_list"})).await?;
        let mut tabs: Vec<NativeTab> = serde_json::from_value(state["tabs"].clone())
            .map_err(|_| "browser_tab_observation_invalid")?;
        self.binding.events.synchronize_events().await?;
        {
            let host = self.resource.host.lock().await;
            tabs.retain(|tab| {
                host.owns_page_target(&tab.target_id)
                    && !host.page_target_is_retiring(&tab.target_id)
            });
        }
        if tabs.len() > 128 {
            return Err("browser_page_limit".into());
        }
        Ok(tabs)
    }

    pub async fn snapshot(
        &self,
        page: &BrowserPageIdentity,
        options: &super::BrowserSnapshotOptions,
    ) -> Result<BrowserSnapshot, BrowserRuntimeError> {
        options.validate()?;
        let baseline = match &options.diff_baseline {
            Some(file) => Some(
                String::from_utf8(
                    self.resource
                        .uploads
                        .lock()
                        .await
                        .read_sealed_with_limit(file, 1024 * 1024)
                        .await?,
                )
                .map_err(|_| "browser_diff_baseline_invalid")?,
            ),
            None => None,
        };
        let mut engine = self.engine().await?;
        let mut observed = self.observe_engine(&mut engine).await?;
        let target = self.resource.host.lock().await.target_for(page)?.clone();
        if !observed.tabs.iter().any(|tab| tab.target_id == target) {
            return Err("browser_page_gone".into());
        }
        self.resource.host.lock().await.element_table_replaced()?;
        let frame = self.resource.host.lock().await.selected_frame(page)?;
        let mut url = observed
            .tabs
            .iter()
            .find(|tab| tab.target_id == target)
            .ok_or("browser_page_gone")?
            .url
            .clone();
        observed.cdp = self.renderer_cdp(observed.cdp, target.clone());
        observed.cdp = self.document_cdp(observed.cdp, frame.clone()).await?;
        if frame.is_some() {
            url = self::url(&mut observed.cdp, target.as_str()).await?;
        }
        let (data, elements) =
            super::snapshot::observe(&mut observed.cdp, target.as_str(), &url, options, baseline)
                .await?;
        self.observe_engine(&mut engine).await?;
        self.validate_selected_frame(page, &frame).await?;
        let snapshot = self
            .resource
            .host
            .lock()
            .await
            .snapshot_observed_in_frame(page, &frame, elements)?;
        Ok(BrowserSnapshot { snapshot, data })
    }

    pub async fn query(
        &self,
        page: &BrowserPageIdentity,
        query: &BrowserQuery,
    ) -> Result<Value, BrowserRuntimeError> {
        let mut engine = self.engine().await?;
        let observed = self.observe_engine(&mut engine).await?;
        self.validate_query(page, query, &observed).await?;
        let target = self.resource.host.lock().await.target_for(page)?.clone();
        let frame = self.resource.host.lock().await.selected_frame(page)?;
        let cdp = self
            .document_cdp(
                self.renderer_cdp(observed.cdp, target.clone()),
                frame.clone(),
            )
            .await?;
        let data = query.read(cdp, target.as_str()).await?;
        let after = self.observe_engine(&mut engine).await?;
        self.validate_query(page, query, &after).await?;
        self.validate_selected_frame(page, &frame).await?;
        let mut result = json!({"page":page,"data":data});
        if frame.is_some() {
            result["frame"] = json!(frame);
        }
        Ok(result)
    }

    async fn validate_query(
        &self,
        page: &BrowserPageIdentity,
        query: &BrowserQuery,
        observed: &EngineObservation,
    ) -> Result<(), BrowserRuntimeError> {
        let host = self.resource.host.lock().await;
        let target = host.target_for(page)?;
        if let Some(reference) = query.reference() {
            if reference.snapshot.page != *page {
                return Err("browser_reference_page_mismatch".into());
            }
            host.validate_element(reference)?;
        }
        // Fixed-target CDP reads do not activate a tab. The Host's page and
        // reference fences still apply while another resource is selected.
        if !observed.tabs.iter().any(|tab| &tab.target_id == target) {
            return Err("browser_page_gone".into());
        }
        Ok(())
    }
}

/// Internal, fixed reads run in the isolated world. User expressions require
/// an admitted action and must never enter this observer path.
pub(super) async fn document(
    cdp: &mut BrowserCdp,
    target: &str,
    expression: &str,
) -> Result<Value, &'static str> {
    let session = cdp.attach(target).await?;
    let context = cdp.isolated_context(&session).await?;
    let result = cdp
        .request(
            "Runtime.evaluate",
            json!({"expression":expression,"contextId":context,"returnByValue":true}),
            Some(&session),
        )
        .await?;
    if result.get("exceptionDetails").is_some() {
        return Err("browser_selector_invalid");
    }
    Ok(result["result"]["value"].clone())
}

pub(super) async fn url(cdp: &mut BrowserCdp, target: &str) -> Result<String, &'static str> {
    if cdp.frame().is_some() {
        let session = cdp.attach(target).await?;
        return cdp.frame_metadata(&session).await?["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or("browser_frame_metadata_invalid");
    }
    cdp.request("Target.getTargetInfo", json!({"targetId":target}), None)
        .await?["targetInfo"]["url"]
        .as_str()
        .map(str::to_owned)
        .ok_or("browser_page_metadata_invalid")
}
