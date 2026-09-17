//! Host-authorized browser operations over the resource's owned native bindings.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as BindingMutex;

use hmux_host::browser_resource::{
    BrowserActionPermit, BrowserAdmissionError, BrowserResourceHost,
};
use hmux_session_protocol::browser_resource::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::cdp::BrowserCdp;
use super::{
    BrowserEngineError, ENGINE_DEADLINE, NativeBrowserEngine, NativeBrowserEngineConfig,
    NativeBrowserResponse,
};

mod action;
pub(crate) mod capture;
mod completion;
mod console;
mod data;
mod dialog;
mod download;
mod drag;
mod environment;
mod evaluate;
mod events;
mod execution;
mod find;
mod frames;
mod har;
mod init_script;
mod input;
mod instance;
mod interception;
mod keyboard;
mod lifecycle;
mod locator;
mod mouse;
mod network;
mod observation;
mod pages;
mod profiles;
mod query;
mod react;
mod recording;
mod routing;
mod snapshot;
mod state;
mod stream;
mod touch;
mod tracing;
mod upload;
mod vitals;
mod wait;
mod worker;
pub(crate) use action::BrowserPageUrl;
pub use action::{BrowserAction, BrowserElementTarget};
pub use capture::ImageCapture;
pub(crate) use lifecycle::{BrowserLaunchFeature, BrowserLaunchScripts, BrowserProfileSource};
pub(crate) use profiles::BrowserProfileAction;
pub use query::BrowserQuery;
pub use snapshot::BrowserSnapshotOptions;
pub use upload::{BrowserUploadChunk, BrowserUploadId};
pub use wait::BrowserWait;

#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum BrowserRuntimeError {
    Admission(BrowserAdmissionError),
    Engine(BrowserEngineError),
    Observation(&'static str),
}

impl From<BrowserAdmissionError> for BrowserRuntimeError {
    fn from(error: BrowserAdmissionError) -> Self {
        Self::Admission(error)
    }
}
impl From<BrowserEngineError> for BrowserRuntimeError {
    fn from(error: BrowserEngineError) -> Self {
        Self::Engine(error)
    }
}
impl From<&'static str> for BrowserRuntimeError {
    fn from(error: &'static str) -> Self {
        Self::Observation(error)
    }
}

#[derive(Debug, Serialize)]
pub struct BrowserPageObservation {
    pub page: BrowserPageIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<BrowserPageLabel>,
    pub url: String,
    pub title: String,
    pub profile_id: Option<dure_app::BrowserProfileIdV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<BrowserFrameIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct BrowserRuntimeObservation {
    pub control: BrowserControlProjection,
    pub pages: Vec<BrowserPageObservation>,
}

#[derive(Debug, Serialize)]
pub struct BrowserSnapshot {
    pub snapshot: BrowserSnapshotIdentity,
    pub data: Value,
}

#[derive(Debug, Serialize)]
pub struct BrowserActionResult {
    pub response: NativeBrowserResponse,
    pub control: BrowserControlProjection,
    /// Action completion survives a later observation failure. Clients must
    /// refresh the projection, never replay the completed action to recover it.
    pub observation: Option<BrowserRuntimeObservation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTab {
    tab_id: String,
    target_id: BrowserTargetId,
    active: bool,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
}

struct EngineObservation {
    tabs: Vec<NativeTab>,
    cdp: BrowserCdp,
    view: BrowserRuntimeObservation,
}

pub struct BrowserRuntime {
    // Host owns every page binding and controller; this table owns native handles.
    host: Arc<Mutex<BrowserResourceHost>>,
    bindings: Arc<BindingMutex<BTreeMap<BrowserInstanceId, Arc<lifecycle::BindingSlot>>>>,
    uploads: Arc<Mutex<upload::BrowserUploads>>,
    directory: PathBuf,
    changed: Arc<tokio::sync::Notify>,
}

struct BrowserBinding {
    engine: Arc<Mutex<NativeBrowserEngine>>,
    instance: Arc<instance::BrowserInstanceLease>,
    events: events::BrowserEventMonitor,
    downloads: Arc<Mutex<Option<download::DownloadState>>>,
    cdp: BrowserCdp,
    retirement: lifecycle::ResourceRetirement,
}

struct Execution<'a> {
    resource: &'a BrowserRuntime,
    binding: Arc<BrowserBinding>,
    user_agent_mode: dure_app::BrowserProfileUserAgentModeV1,
}

impl BrowserRuntime {
    pub async fn control(&self) -> BrowserControlProjection {
        self.host.lock().await.projection()
    }

    pub async fn request_control(
        &self,
        controller: BrowserControllerId,
        expected: Option<&BrowserControllerLease>,
    ) -> Result<BrowserControlProjection, BrowserRuntimeError> {
        self.host
            .lock()
            .await
            .request_control(controller, expected)?;
        self.drain_input_transfer().await?;
        Ok(self.control().await)
    }
}

impl Execution<'_> {
    async fn observe_engine(
        &self,
        engine: &mut NativeBrowserEngine,
    ) -> Result<EngineObservation, BrowserRuntimeError> {
        let tabs = self.observe_tabs(engine).await?;
        // Page lifetime and document revisions come from the retained event
        // source. A later tab-list read cannot overwrite a newer frame event.
        self.binding
            .events
            .synchronize_pages(&tabs.iter().map(|tab| &tab.target_id).collect::<Vec<_>>())
            .await?;
        let cdp = self.binding.cdp.clone();
        cdp.retain_targets(
            &tabs
                .iter()
                .map(|tab| tab.target_id.as_str())
                .collect::<Vec<_>>(),
        )
        .await;
        let profile_id = self.binding.instance.profile_id().await;
        let mut host = self.resource.host.lock().await;
        let mut active = tabs.iter().filter(|tab| tab.active);
        let target = active.next().map(|tab| &tab.target_id);
        if active.next().is_some() {
            return Err("browser_tab_observation_invalid".into());
        }
        host.active_page_observed(self.binding.events.instance(), target)?;
        let mut pages = Vec::with_capacity(tabs.len());
        for tab in &tabs {
            let page = host
                .page_for_target(&tab.target_id)
                .ok_or("browser_page_missing")?;
            let (frame, frame_error) = match host.selected_frame(&page) {
                Ok(frame) => (frame, None),
                Err(BrowserAdmissionError::FrameGone) => (None, Some("browser_frame_gone")),
                Err(error) => return Err(error.into()),
            };
            pages.push(BrowserPageObservation {
                label: host.page_label(&page)?.cloned(),
                page,
                url: tab.url.clone(),
                title: tab.title.clone(),
                profile_id: profile_id.clone(),
                frame,
                frame_error,
            });
        }
        Ok(EngineObservation {
            tabs,
            cdp,
            view: BrowserRuntimeObservation {
                control: host.projection(),
                pages,
            },
        })
    }

    pub async fn observe(&self) -> Result<BrowserRuntimeObservation, BrowserRuntimeError> {
        let mut engine = self.engine().await?;
        Ok(self.observe_engine(&mut engine).await?.view)
    }

    async fn select_page(
        &self,
        engine: &mut NativeBrowserEngine,
        observation: &EngineObservation,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        explicit: bool,
    ) -> Result<(), BrowserRuntimeError> {
        let (target, current_changed) = {
            let host = self.resource.host.lock().await;
            (
                host.target_for(page)?.clone(),
                host.current_page().as_ref() != Some(page),
            )
        };
        let tab = observation
            .tabs
            .iter()
            .find(|tab| tab.target_id == target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if !tab.active || (explicit && current_changed) {
            // Changing the selected page expires Host's element table.
            self.resource.host.lock().await.element_table_replaced()?;
        }
        if !tab.active {
            engine
                .require(json!({"action":"tab_switch","tabId":tab.tab_id}))
                .await?;
        }
        // A popup can hide the engine's still-bound page. Require Chromium's
        // activation reply for the exact admitted target before input; the
        // native tab switch does not propagate its bring-to-front failure.
        let mut cdp = observation.cdp.clone();
        cdp.request("Target.activateTarget", json!({"targetId":target}), None)
            .await
            .map_err(|_| BrowserEngineError::after("browser_page_selection_incomplete"))?;
        let mut host = self.resource.host.lock().await;
        if explicit {
            host.select_frame(permit, None)?;
        }
        host.page_activated(permit, page)?;
        Ok(())
    }

    pub(super) async fn action(
        &self,
        authority: &BrowserActionAuthority,
        action: BrowserAction,
        mut completion: completion::ActionCompletion,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let permit = completion.permit_mut();
        let headers = action
            .environment()
            .and_then(|action| action.request_headers());
        let host_action = action.disconnects_worker()
            || headers.is_some()
            || action.console_clear().is_some()
            || action.is_network_clear()
            || action.network_capture().is_some()
            || action.recording().is_some()
            || action.tracing().is_some()
            || action.interception().is_some();
        let dispatched = if action.disconnects_worker() {
            self.disconnect_worker(permit).await
        } else if let Some(headers) = headers {
            self.configure_request_headers(permit, headers).await
        } else if let Some(kind) = action.console_clear() {
            self.clear_console(permit, kind).await
        } else if action.is_network_clear() {
            self.clear_network(permit).await
        } else if let Some(capture) = action.network_capture() {
            self.capture_network(permit, *capture).await
        } else if let Some((command, format)) = action.recording() {
            self.record(permit, command, format).await
        } else if let Some(tracing) = action.tracing() {
            self.trace(permit, tracing).await
        } else if let Some(interception) = action.interception() {
            self.configure_interception(permit, interception).await
        } else if let Some(wait) = action.function_wait() {
            self.wait_function(permit, &authority.page, wait).await
        } else {
            match self.engine().await {
                Ok(mut engine) => {
                    self.dispatch(&mut engine, permit, &authority.page, action)
                        .await
                }
                Err(error) => Err(error),
            }
        };
        self.complete_action(completion, dispatched, !host_action)
            .await
    }

    async fn dispatch(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &mut BrowserActionPermit,
        page: &BrowserPageIdentity,
        action: BrowserAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut observed = self.observe_engine(engine).await?;
        if self
            .input_before_action(
                permit,
                action.replaces_elements() || action.frame_selection().is_some(),
            )
            .await?
        {
            // Release handlers can navigate or close pages. Resolve the new
            // authoritative document before dispatching the proposed action.
            observed = self
                .observe_engine(engine)
                .await
                .map_err(|_| BrowserEngineError::after("browser_input_drain_unobserved"))?;
        }
        self.select_page(engine, &observed, permit, page, action.selects_page())
            .await?;
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        observed.cdp = self.renderer_cdp(observed.cdp, target);
        if let Some(selection) = action.frame_selection() {
            return self
                .select_frame(permit, page, observed.cdp, selection)
                .await;
        }
        if action.uses_document() {
            let frame = self.resource.host.lock().await.dispatch_frame(permit)?;
            observed.cdp = self.document_cdp(observed.cdp, frame).await?;
        }
        if let Some(keyboard) = action.keyboard() {
            return self.keyboard_action(engine, permit, page, keyboard).await;
        }
        if let Some((direction, x, y)) = action.swipe() {
            return self.swipe_action(permit, direction, x, y).await;
        }
        if let Some(mouse) = action.mouse() {
            return self.pointer_action(permit, mouse, 1).await;
        }
        if let Some(environment) = action.environment() {
            return self
                .environment_action(permit, page, observed.cdp, environment)
                .await;
        }
        if let Some(init_script) = action.init_script() {
            return self.init_script_action(permit, page, init_script).await;
        }
        if let Some(data) = action.data() {
            return self.data_action(engine, permit, observed.cdp, data).await;
        }
        if action.replaces_elements() {
            self.resource.host.lock().await.element_table_replaced()?;
        }
        if let Some(url) = action.vitals() {
            return self.vitals_action(engine, permit, observed.cdp, url).await;
        }
        if let Some(react) = action.react() {
            return self.react_action(engine, permit, observed.cdp, react).await;
        }
        if let Some(key) = action.state_save() {
            return self
                .save_state(engine, permit, page, observed.cdp, key)
                .await;
        }
        if let Some((file, key)) = action.state_load() {
            return self
                .load_state(engine, permit, observed.cdp, file, key)
                .await;
        }
        if let Some(script) = action.evaluation_script() {
            return self
                .evaluate_action(permit, observed.cdp, script, ENGINE_DEADLINE)
                .await;
        }
        if let Some((x, y)) = action.scroll_offset() {
            let mut response = self
                .evaluate_action(
                    permit,
                    observed.cdp,
                    &format!("window.scrollBy({x},{y});true"),
                    ENGINE_DEADLINE,
                )
                .await?;
            if response.success {
                response.id = "browser-scroll".into();
                response.data = json!({"scrolled":true});
            }
            return Ok(response);
        }
        if let Some(url) = action.push_state_url() {
            return self.push_state_action(permit, observed.cdp, url).await;
        }
        if let Some(history) = action.history() {
            return self.history_action(permit, history).await;
        }
        if let Some(text) = action.insertion_text() {
            return self.insert_text(permit, observed.cdp, text).await;
        }
        if let Some(text) = action.typing_text() {
            return self.type_text(engine, permit, observed.cdp, text).await;
        }
        if action.is_pdf() {
            return self.print_pdf(engine, permit, page, observed.cdp).await;
        }
        if let Some(download) = action.download() {
            return self
                .download_action(engine, permit, page, observed.cdp, download)
                .await;
        }
        if let Some((target, files)) = action.upload() {
            return self
                .upload_action(engine, permit, observed.cdp, target, files)
                .await;
        }
        if let Some((target, operation)) = action.element_action() {
            return self
                .bound_element_action(engine, permit, observed.cdp, target, &operation)
                .await;
        }
        if let Some((source, target)) = action.drag() {
            return self
                .drag_action(engine, permit, observed.cdp, source, target)
                .await;
        }
        if let Some(find) = action.find() {
            return self.find_action(engine, permit, observed.cdp, find).await;
        }
        if let Some((url, context)) = action.new_page() {
            return self.create_page(engine, permit, url, context).await;
        }
        if let Some(url) = action.navigation_url() {
            let target = self
                .resource
                .host
                .lock()
                .await
                .dispatch_target(permit)?
                .clone();
            return self.navigate_page(permit, observed.cdp, &target, url).await;
        }
        let mut response = None;
        for command in action.commands() {
            if response.is_some() {
                // Replacement is one admitted operation with multiple engine
                // steps. Navigation after selection cannot receive its text.
                self.observe_engine(engine).await.map_err(|_| {
                    BrowserEngineError::after("browser_replacement_observation_failed")
                })?;
                self.resource
                    .host
                    .lock()
                    .await
                    .dispatch_target(permit)
                    .map_err(|_| BrowserEngineError::after("browser_replacement_target_changed"))?;
            }
            let current = engine.request(command).await.map_err(|error| {
                if response.is_some() {
                    BrowserEngineError::after("browser_replacement_incomplete")
                } else {
                    error
                }
            })?;
            if !current.success {
                return Ok(current);
            }
            response = Some(current);
        }
        response.ok_or_else(|| "browser_action_empty".into())
    }
}
