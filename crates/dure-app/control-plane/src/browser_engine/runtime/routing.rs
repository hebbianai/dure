//! Host page bindings select native connections; the resource owns their lifetime.
use super::*;
use hmux_session_protocol::browser_console::{BrowserConsoleQuery, BrowserConsoleSnapshot};
use hmux_session_protocol::browser_dialog::{
    BrowserDialogIdentity, BrowserDialogObservation, BrowserDialogResponse,
};
use hmux_session_protocol::browser_interception::BrowserInterceptionStatus;
use hmux_session_protocol::browser_network::BrowserNetworkSnapshot;
use hmux_session_protocol::browser_network_capture::BrowserNetworkCaptureStatus;

impl BrowserRuntime {
    #[cfg(test)]
    pub(super) fn from_binding(
        host: Arc<Mutex<BrowserResourceHost>>,
        uploads: Arc<Mutex<upload::BrowserUploads>>,
        directory: PathBuf,
        binding: BrowserBinding,
        profile: Option<dure_app::BrowserProfileSpecV1>,
    ) -> Self {
        Self {
            host,
            uploads,
            directory,
            changed: Arc::clone(&binding.events.changed),
            bindings: Arc::new(BindingMutex::new(BTreeMap::from([(
                binding.events.instance().clone(),
                Arc::new(lifecycle::BindingSlot::published(binding, profile)),
            )]))),
        }
    }

    pub(super) fn execution_for_instance(
        &self,
        instance: &BrowserInstanceId,
    ) -> Result<Execution<'_>, BrowserRuntimeError> {
        let bindings = self.bindings.lock().unwrap();
        let slot = bindings
            .get(instance)
            .ok_or(BrowserAdmissionError::InstanceMismatch)?;
        let binding = slot
            .ready
            .get()
            .cloned()
            .ok_or("browser_instance_starting")?;
        Ok(Execution {
            resource: self,
            binding,
            user_agent_mode: slot.user_agent_mode(),
        })
    }

    pub(super) async fn execution_for_target(
        &self,
        target: &BrowserTargetId,
    ) -> Result<Execution<'_>, BrowserRuntimeError> {
        let instance = self
            .host
            .lock()
            .await
            .instance_for_target(target)
            .cloned()
            .ok_or(BrowserAdmissionError::PageGone)?;
        self.execution_for_instance(&instance)
    }

    pub(super) async fn execution(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Execution<'_>, BrowserRuntimeError> {
        let instance = {
            let host = self.host.lock().await;
            let target = host.target_for(page)?;
            host.instance_for_target(target)
                .cloned()
                .ok_or(BrowserAdmissionError::InstanceMismatch)?
        };
        self.execution_for_instance(&instance)
    }

    pub(super) async fn execution_for_page_id(
        &self,
        page: &BrowserPageId,
    ) -> Result<Execution<'_>, BrowserRuntimeError> {
        let instance = self.host.lock().await.instance_for_page(page)?.clone();
        self.execution_for_instance(&instance)
    }

    pub async fn profile_id(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Option<dure_app::BrowserProfileIdV1>, BrowserRuntimeError> {
        Ok(self
            .execution(page)
            .await?
            .binding
            .instance
            .profile_id()
            .await)
    }

    pub async fn observe(&self) -> Result<BrowserRuntimeObservation, BrowserRuntimeError> {
        let instances = self.host.lock().await.instance_binding_ids();
        let mut pages = Vec::new();
        for instance in instances {
            let observed = self.execution_for_instance(&instance)?.observe().await?;
            pages.extend(observed.pages);
        }
        let host = self.host.lock().await;
        // Publish a complete set of current Host identities, never a partial
        // page list carrying a later revision after a concurrent document change.
        let current = host.pages();
        if current.len() != pages.len()
            || current
                .iter()
                .any(|current| !pages.iter().any(|page| &page.page == current))
        {
            return Err("browser_resource_observation_changed".into());
        }
        Ok(BrowserRuntimeObservation {
            control: host.projection(),
            pages,
        })
    }

    pub async fn action(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        action: BrowserAction,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let (execution, permit) = {
            let mut host = self.host.lock().await;
            let permit = host.begin_action(caller, authority, action.references())?;
            if let Some(label) = action.new_page_label() {
                if let Err(error) = host.reserve_creation_label(&permit, label.clone()) {
                    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)?;
                    return Err(error.into());
                }
            }
            let instance = host.instance_for_page(&authority.page.page_id)?.clone();
            let execution = match self.execution_for_instance(&instance) {
                Ok(execution) => execution,
                Err(error) => {
                    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)?;
                    return Err(error);
                }
            };
            (execution, permit)
        };
        // Install completion ownership without another await after admission.
        let completion = completion::ActionCompletion::new(&execution, permit);
        execution.action(authority, action, completion).await
    }

    pub async fn snapshot(
        &self,
        page: &BrowserPageIdentity,
        options: &super::BrowserSnapshotOptions,
    ) -> Result<BrowserSnapshot, BrowserRuntimeError> {
        self.execution(page).await?.snapshot(page, options).await
    }

    pub async fn query(
        &self,
        page: &BrowserPageIdentity,
        query: &BrowserQuery,
    ) -> Result<Value, BrowserRuntimeError> {
        self.execution(page).await?.query(page, query).await
    }

    pub async fn screenshot(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Value, BrowserRuntimeError> {
        self.execution(page).await?.screenshot(page).await
    }

    pub(crate) async fn capture_image(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
    ) -> Result<capture::CapturedImage, BrowserRuntimeError> {
        self.execution(page)
            .await?
            .capture_image(page, options)
            .await
    }

    pub(crate) async fn capture_diff(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
        baseline: &super::BrowserUploadId,
        threshold: f64,
    ) -> Result<capture::CapturedImageDiff, BrowserRuntimeError> {
        self.execution(page)
            .await?
            .capture_diff(page, options, baseline, threshold)
            .await
    }

    pub async fn frame(&self, page: &BrowserPageIdentity) -> Result<Value, BrowserRuntimeError> {
        self.execution(page).await?.frame(page).await
    }

    pub async fn wait(
        &self,
        page: &BrowserPageIdentity,
        wait: &BrowserWait,
    ) -> Result<Value, BrowserRuntimeError> {
        self.execution(page).await?.wait(page, wait).await
    }

    pub async fn network(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<BrowserNetworkSnapshot, BrowserRuntimeError> {
        self.execution(page).await?.network(page).await
    }

    pub async fn network_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserNetworkSnapshot, BrowserRuntimeError> {
        self.execution_for_page_id(page)
            .await?
            .network_state(resource, page)
            .await
    }

    pub async fn network_detail(
        &self,
        page: &BrowserPageIdentity,
        sequence: hmux_session_protocol::browser_network::BrowserNetworkSequence,
    ) -> Result<hmux_session_protocol::browser_network::BrowserNetworkDetail, BrowserRuntimeError>
    {
        self.execution(page)
            .await?
            .network_detail(page, sequence)
            .await
    }

    pub async fn dialog(
        &self,
        page: &BrowserPageId,
    ) -> Result<BrowserDialogObservation, BrowserRuntimeError> {
        self.execution_for_page_id(page).await?.dialog(page).await
    }

    pub async fn respond_dialog(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        dialog: &BrowserDialogIdentity,
        response: BrowserDialogResponse,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        self.execution_for_page_id(&authority.page.page_id)
            .await?
            .respond_dialog(caller, authority, dialog, response)
            .await
    }

    pub async fn console(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
        query: BrowserConsoleQuery,
    ) -> Result<BrowserConsoleSnapshot, BrowserRuntimeError> {
        self.execution_for_page_id(page)
            .await?
            .console(resource, page, query)
            .await
    }

    pub async fn interception_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserInterceptionStatus, BrowserRuntimeError> {
        self.execution_for_page_id(page)
            .await?
            .interception_state(resource, page)
            .await
    }

    pub async fn network_capture_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserNetworkCaptureStatus, BrowserRuntimeError> {
        self.execution_for_page_id(page)
            .await?
            .network_capture_state(resource, page)
            .await
    }

    #[cfg(test)]
    pub(super) fn test_binding(&self) -> Arc<BrowserBinding> {
        let bindings = self.bindings.lock().unwrap();
        assert_eq!(
            bindings.len(),
            1,
            "fixture must select its native binding explicitly"
        );
        Arc::clone(
            bindings
                .values()
                .next()
                .unwrap()
                .ready
                .get()
                .expect("published fixture binding"),
        )
    }

    #[cfg(test)]
    pub(super) fn test_binding_mut(&mut self) -> &mut BrowserBinding {
        let bindings = Arc::get_mut(&mut self.bindings)
            .expect("fixture owns its binding table")
            .get_mut()
            .unwrap();
        assert_eq!(
            bindings.len(),
            1,
            "fixture must select its native binding explicitly"
        );
        let slot =
            Arc::get_mut(bindings.values_mut().next().unwrap()).expect("fault setup owns the slot");
        Arc::get_mut(slot.ready.get_mut().expect("published fixture binding"))
            .expect("fault setup owns the binding")
    }
}
