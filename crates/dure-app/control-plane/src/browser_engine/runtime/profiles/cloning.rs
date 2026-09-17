//! Profile page creation keeps the source document and the admitted destination.
use super::*;

impl Execution<'_> {
    pub(super) async fn create_profile_page(
        &self,
        permit: &BrowserActionPermit,
        source_page: &BrowserPageIdentity,
        profile: &BrowserProfileIdV1,
        destination: Destination,
        url: Option<&str>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let is_clone = url.is_none();
        let url = match url {
            Some(url) => url.to_owned(),
            None => self.profile_source_url(permit).await?,
        };
        let (instance, creation) = destination.ready().await?;
        let cloned: Result<_, BrowserRuntimeError> = async {
            let next = self.resource.execution_for_instance(&instance)?;
            let mut engine = next.engine().await?;
            let target = next
                .profile_created_target(&mut engine, permit, creation)
                .await?;
            next.binding.events.synchronize(&target).await?;
            let observed = next.observe_engine(&mut engine).await?;
            let page = self
                .resource
                .host
                .lock()
                .await
                .page_for_target(&target)
                .ok_or("browser_new_page_missing")?;
            next.select_page(&mut engine, &observed, permit, &page, false)
                .await?;
            let navigation = next
                .navigate_page(permit, observed.cdp, &target, &url)
                .await?;
            if !navigation.success {
                return Ok(navigation);
            }
            next.observe_engine(&mut engine).await?;
            let host = self.resource.host.lock().await;
            let page = host.page_identity(&page.page_id)?;
            let mut response = profile_response(&page, profile);
            if let Some(label) = host.page_label(&page)? {
                response.data["label"] = json!(label);
            }
            if is_clone {
                response.data["source_page"] = json!(source_page);
            }
            Ok(response)
        }
        .await;
        cloned.map_err(|_| {
            BrowserEngineError::after(if is_clone {
                "browser_profile_clone_incomplete"
            } else {
                "browser_profile_create_incomplete"
            })
            .into()
        })
    }
}
