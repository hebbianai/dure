use super::*;

impl Execution<'_> {
    pub(super) async fn document_cdp(
        &self,
        cdp: BrowserCdp,
        frame: Option<BrowserFrameIdentity>,
    ) -> Result<BrowserCdp, BrowserRuntimeError> {
        let Some(frame) = frame else {
            return Ok(cdp);
        };
        let scope = self.binding.events.frame_scope(frame).await?;
        self.resource
            .host
            .lock()
            .await
            .validate_frame(&scope.frame)?;
        // Context IDs belong to their retained event connection. Never send one
        // through a separately attached observer or native daemon connection.
        Ok(cdp.on_frame(&self.binding.events.cdp, scope))
    }

    pub(super) async fn select_frame(
        &self,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        cdp: BrowserCdp,
        target: Option<&BrowserElementTarget>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let frame = if let Some(target) = target {
            let selected = self.resource.host.lock().await.dispatch_frame(permit)?;
            let cdp = self.document_cdp(cdp, selected).await?;
            let page_target = self
                .resource
                .host
                .lock()
                .await
                .dispatch_target(permit)?
                .clone();
            let mut element = target.resolve(cdp, page_target.as_str()).await?;
            let id = element.frame_id().await?;
            self.binding.events.synchronize(&page_target).await?;
            let host = self.resource.host.lock().await;
            host.dispatch_frame(permit)?;
            Some(host.frame_identity(page, &id)?)
        } else {
            None
        };
        self.resource
            .host
            .lock()
            .await
            .select_frame(permit, frame.as_ref())?;
        Ok(NativeBrowserResponse {
            id: "browser-frame".into(),
            success: true,
            data: json!({"frame":frame}),
            error: None,
        })
    }

    pub(super) async fn validate_selected_frame(
        &self,
        page: &BrowserPageIdentity,
        frame: &Option<BrowserFrameIdentity>,
    ) -> Result<(), BrowserRuntimeError> {
        if self.resource.host.lock().await.selected_frame(page)? != *frame {
            return Err(BrowserAdmissionError::FrameChanged.into());
        }
        Ok(())
    }
}
