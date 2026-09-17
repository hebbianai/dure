use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{
    BrowserEngineError, ENGINE_DEADLINE, NativeBrowserEngine, NativeBrowserResponse,
};
use hmux_session_protocol::browser_resource::BrowserTargetId;
use serde_json::json;
pub(super) mod history;

impl Execution<'_> {
    pub(super) async fn navigate_page(
        &self,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        target: &BrowserTargetId,
        url: &str,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut cdp = self.renderer_cdp(cdp, target.clone());
        let session = cdp.attach(target.as_str()).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let deadline = cdp.deadline(ENGINE_DEADLINE);
        let navigate = async {
            let result = cdp
                .request_with_deadline(
                    "Page.navigate",
                    json!({"url":url}),
                    Some(&session),
                    ENGINE_DEADLINE,
                )
                .await?;
            if let Some(error) = result["errorText"].as_str() {
                return Ok(NativeBrowserResponse {
                    id: "browser-navigate".into(),
                    success: false,
                    data: json!({}),
                    error: Some(format!("Navigation failed: {error}")),
                });
            }
            // Page.navigate acknowledges a committed loader. Same-document
            // navigation has no new loader and must not wait for another load.
            if result["loaderId"].as_str().is_some() {
                let context = cdp.isolated_context(&session).await?;
                // The listener retains its resolver until load. Reading and
                // registering happen in one isolated-world turn, so an already
                // completed load cannot be missed or redefined by page code.
                let loaded = cdp.request_with_deadline("Runtime.evaluate", json!({
                    "expression":"new Promise(resolve=>{if(document.readyState==='complete')resolve(true);else addEventListener('load',()=>resolve(true),{once:true})})",
                    "contextId":context,"awaitPromise":true,"returnByValue":true,
                }), Some(&session), ENGINE_DEADLINE).await?;
                if loaded["result"]["value"] != true {
                    return Err("browser_navigation_load_incomplete");
                }
            }
            let info = cdp
                .request("Target.getTargetInfo", json!({"targetId":target}), None)
                .await?;
            Ok(NativeBrowserResponse {
                id: "browser-navigate".into(),
                success: true,
                data: json!({"url":info["targetInfo"]["url"],"title":info["targetInfo"]["title"],"targetId":target,"loaderId":result["loaderId"]}),
                error: None,
            })
        };
        // Preserve the native worker's whole navigation budget, including load.
        let navigate = tokio::select! {
            result = navigate => result,
            code = deadline => Err(code),
        };
        navigate.map_err(|_| BrowserEngineError::after("browser_navigation_outcome_unknown").into())
    }

    /// A URL passed to Target.createTarget can start its document request before
    /// an observer attaches. Create blank, bind the returned target, then navigate.
    pub(super) async fn create_page(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        url: &str,
        context: super::events::PageCreationContext,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let creation = self
            .resource
            .host
            .lock()
            .await
            .prepare_page_creation(permit)?;
        let target = self
            .binding
            .events
            .create_page_in(creation, context)
            .await
            .map_err(|_| BrowserEngineError::after("browser_new_page_incomplete"))?;
        let mut created = NativeBrowserResponse {
            id: "browser-new-page".into(),
            success: true,
            data: json!({"targetId":target,"label":null,"url":"about:blank"}),
            error: None,
        };
        let navigation: Result<_, BrowserRuntimeError> = async {
            self.binding.events.synchronize(&target).await?;
            let observed = self.observe_engine(engine).await?;
            let page = self
                .resource
                .host
                .lock()
                .await
                .page_for_target(&target)
                .ok_or("browser_new_page_missing")?;
            let network = self.network_snapshot(&page).await?;
            if !network.complete {
                return Err("browser_network_observation_incomplete".into());
            }
            created.data["tabId"] = json!(
                observed
                    .tabs
                    .iter()
                    .find(|tab| tab.target_id == target)
                    .ok_or("browser_new_page_missing")?
                    .tab_id
            );
            created.data["total"] = json!(observed.tabs.len());
            self.select_page(engine, &observed, permit, &page, false)
                .await?;
            self.resource.host.lock().await.dispatch_target(permit)?;
            let navigation = self
                .navigate_page(permit, observed.cdp, &target, url)
                .await?;
            if navigation.success {
                // The admitted creation, not a native tab label or census order,
                // owns the page returned to CLI and desktop consumers.
                let host = self.resource.host.lock().await;
                let page = host
                    .page_for_target(host.created_page_target(permit)?)
                    .ok_or("browser_new_page_missing")?;
                created.data["label"] = json!(host.page_label(&page)?);
                created.data["page"] = json!(page);
            }
            Ok(navigation)
        }
        .await;
        // A partial create is never replayable after a lost later step.
        let navigation =
            navigation.map_err(|_| BrowserEngineError::after("browser_new_page_incomplete"))?;
        if !navigation.success {
            return Ok(navigation);
        }
        created.data["navigation"] = navigation.data;
        Ok(created)
    }
}
