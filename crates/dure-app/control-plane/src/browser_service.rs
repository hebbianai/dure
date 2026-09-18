//! Shared browser resources on the existing authenticated backend.
//! Operation admission uses the existing domain-store journal, including after
//! response loss or backend replacement; it never launches a replacement worker.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dure_app::{
    DomainStore, OperationEventBodyV1, OperationEventIdV1, OperationEventV1, OperationIdV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_host::browser_resource::BrowserAdmissionError;
use hmux_host::browser_workspace::BrowserWorkspaceTargetHost;
use hmux_session_protocol::browser_resource::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore};

use crate::browser_engine::{
    NativeBrowserEngineConfig,
    runtime::{BrowserProfileAction, BrowserRuntime, BrowserRuntimeError, capture::CapturedFile},
};
use crate::{BackendDispatchError, backend_runtime_root::BackendRuntimeRoot, now_ms};

pub(crate) const OPERATION: &str = "browser.resource";

#[cfg(test)]
mod active_target_tests;
#[cfg(test)]
mod construction_tests;
mod creation;
#[cfg(test)]
mod desktop_tests;
mod image;
mod installation;
mod profiles;
mod request;
mod results;
#[cfg(test)]
mod results_tests;
mod storage_workspace;
mod targets;
use request::BrowserRequest;
use results::BrowserResults;

struct ManagedBrowser {
    runtime: Arc<BrowserRuntime>,
    _slot: OwnedSemaphorePermit,
}

pub(crate) struct BrowserService {
    root: BackendRuntimeRoot,
    results: BrowserResults,
    generation: BrowserResourceGeneration,
    installation: PathBuf,
    installer: installation::Installer,
    resources: Mutex<BTreeMap<BrowserResourceId, ManagedBrowser>>,
    selected_browser: std::sync::Mutex<BrowserWorkspaceTargetHost>,
    slots: Arc<Semaphore>,
    journal_admission: Mutex<()>,
    // Service shutdown drains admitted receipts before its store is closed.
    closing: RwLock<bool>,
}

impl BrowserService {
    pub(crate) fn new(root: BackendRuntimeRoot, generation: &str, home: &Path) -> Self {
        Self {
            results: BrowserResults::new(root.durable()),
            root,
            generation: BrowserResourceGeneration::new(generation)
                .expect("validated backend generation"),
            installation: home.join("browser").join("installation.json"),
            installer: installation::Installer::default(),
            resources: Mutex::new(BTreeMap::new()),
            selected_browser: std::sync::Mutex::new(BrowserWorkspaceTargetHost::new(
                BrowserWorkspaceId::new(storage_workspace::ID)
                    .expect("static browser storage identity"),
                BrowserResourceGeneration::new(generation).expect("validated backend generation"),
            )),
            slots: Arc::new(Semaphore::new(8)),
            journal_admission: Mutex::new(()),
            closing: RwLock::new(false),
        }
    }

    fn config(&self) -> Result<NativeBrowserEngineConfig, BackendDispatchError> {
        installation::config(&self.installation)
    }

    async fn resource(
        &self,
        id: &BrowserResourceId,
    ) -> Result<Arc<BrowserRuntime>, BackendDispatchError> {
        self.resources
            .lock()
            .await
            .get(id)
            .map(|managed| Arc::clone(&managed.runtime))
            .ok_or_else(|| BackendDispatchError::terminal("browser_resource_unavailable"))
    }

    async fn bound_resource(
        &self,
        identity: &BrowserResourceIdentity,
    ) -> Result<Arc<BrowserRuntime>, BackendDispatchError> {
        let runtime = self.resource(&identity.resource_id).await?;
        if runtime.control().await.resource != *identity {
            return Err(BackendDispatchError::terminal("browser_resource_mismatch"));
        }
        Ok(runtime)
    }

    pub(crate) async fn dispatch(
        &self,
        store: &SqliteDomainStore,
        body: &Value,
    ) -> Result<Value, BackendDispatchError> {
        let mut response = self.dispatch_result(store, body).await?;
        response["schemaVersion"] = 1.into();
        Ok(response)
    }

    // Version the transport result once, including receipts and early returns.
    // Stored payloads and their idempotency fingerprints remain unchanged.
    async fn dispatch_result(
        &self,
        store: &SqliteDomainStore,
        body: &Value,
    ) -> Result<Value, BackendDispatchError> {
        let request: BrowserRequest = serde_json::from_value(body.clone())
            .map_err(|_| BackendDispatchError::terminal("browser_request_invalid"))?;
        let closing = self.closing.read().await;
        if *closing {
            return Err(BackendDispatchError::terminal("browser_service_retiring"));
        }
        if let BrowserRequest::Receipt { operation_id }
        | BrowserRequest::Artifact { operation_id, .. } = &request
        {
            let receipt = store
                .operation_receipt(operation_id)
                .await
                .map_err(|_| BackendDispatchError::terminal("browser_journal_unavailable"))?;
            if receipt
                .as_ref()
                .is_some_and(|receipt| receipt.operation_kind != OPERATION)
            {
                return Err(BackendDispatchError::terminal("browser_operation_mismatch"));
            }
            return match (receipt, &request) {
                (Some(receipt), BrowserRequest::Artifact { offset, .. }) => {
                    self.results.chunk(&receipt, *offset)
                }
                (Some(receipt), _) => self.results.recover(&receipt),
                (None, BrowserRequest::Artifact { .. }) => Err(BackendDispatchError::terminal(
                    "browser_artifact_unavailable",
                )),
                (None, _) => Ok(json!({"receipt":null,"result_available":false,"result":null})),
            };
        }
        let operation_id = request.operation_id();
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(body)
                    .map_err(|_| BackendDispatchError::terminal("browser_request_invalid"))?
            )
        );
        if let Some(operation_id) = &operation_id {
            let _admission = self.journal_admission.lock().await;
            if let Some(receipt) = store
                .operation_receipt(operation_id)
                .await
                .map_err(|_| BackendDispatchError::terminal("browser_journal_unavailable"))?
            {
                if receipt.idempotency_key != fingerprint || receipt.operation_kind != OPERATION {
                    return Err(BackendDispatchError::terminal("browser_operation_conflict"));
                }
                let mut recovered = self.results.recover(&receipt)?;
                recovered["replayed"] = true.into();
                return Ok(recovered);
            }
            append(
                store,
                operation_id,
                1,
                OperationEventBodyV1::Started {
                    idempotency_key: fingerprint.clone(),
                    operation_kind: OPERATION.into(),
                },
            )
            .await?;
        }
        let mut result = self.execute(store, request).await;
        if let Some(operation_id) = &operation_id {
            // Publish payloads before the journal's terminal event. Recovery
            // reads them only through that terminal receipt, never by existence.
            if let Err(error) = self.results.save(operation_id, &fingerprint, &result).await {
                result = Err(error);
            }
            let terminal = match &result {
                Ok(value) if value.pointer("/response/success") == Some(&Value::Bool(false)) => {
                    OperationEventBodyV1::Failed {
                        error_code: "browser_action_rejected".into(),
                    }
                }
                Ok(_) => OperationEventBodyV1::Succeeded {
                    result_code: Some("browser_completed".into()),
                },
                Err(error) => OperationEventBodyV1::Failed {
                    error_code: error.code.clone(),
                },
            };
            append(store, operation_id, 2, terminal).await?;
        }
        result.map(|result| json!({"operation_id":operation_id,"replayed":false,"result":result}))
    }

    async fn execute(
        &self,
        store: &SqliteDomainStore,
        request: BrowserRequest,
    ) -> Result<Value, BackendDispatchError> {
        match request {
            BrowserRequest::RuntimeStatus => {
                Ok(self.installer.status(&self.installation, false).await)
            }
            BrowserRequest::RuntimeInstall => {
                Ok(self.installer.status(&self.installation, true).await)
            }
            BrowserRequest::ProfileSet {
                caller,
                authority,
                profile_id,
            } => {
                self.profile_action(
                    store,
                    &caller,
                    &authority,
                    BrowserProfileAction::Set,
                    profile_id,
                )
                .await
            }
            BrowserRequest::ProfileClone {
                caller,
                authority,
                profile_id,
            } => {
                self.profile_action(
                    store,
                    &caller,
                    &authority,
                    BrowserProfileAction::Clone,
                    profile_id,
                )
                .await
            }
            BrowserRequest::ProfileNewPage {
                caller,
                authority,
                profile_id,
                url,
                label,
            } => {
                self.profile_action(
                    store,
                    &caller,
                    &authority,
                    BrowserProfileAction::Create { url, label },
                    profile_id,
                )
                .await
            }
            BrowserRequest::ProfileList => profiles::list(store).await,
            BrowserRequest::ProfileDelete { profile_id, .. } => {
                self.delete_profile(store, profile_id).await
            }
            BrowserRequest::ProfileCreate {
                operation_id,
                label,
                scope,
                user_agent_mode,
            } => profiles::create(store, &operation_id, label, scope, user_agent_mode).await,
            BrowserRequest::UploadChunk { resource, chunk } => self
                .bound_resource(&resource)
                .await?
                .stage_upload(chunk)
                .await
                .map_err(runtime_error),
            BrowserRequest::Create {
                operation_id,
                profile_id,
                init_scripts,
                features,
            } => {
                let workspace_id = storage_workspace::personal(store, self.root.durable()).await?;
                self.create(
                    store,
                    workspace_id,
                    operation_id,
                    profile_id,
                    init_scripts.with_features(features),
                )
                .await
            }
            BrowserRequest::List {} => {
                let workspace_id = storage_workspace::personal(store, self.root.durable()).await?;
                let table = self.resources.lock().await;
                let mut resources = Vec::new();
                for managed in table.values() {
                    let control = managed.runtime.control().await;
                    if control.resource.workspace_id.as_str() == workspace_id.as_str() {
                        resources.push(control);
                    }
                }
                let target = self.selected_browser(&table)?;
                Ok(json!({"workspace_id":workspace_id,"resources":resources,"target":target}))
            }
            BrowserRequest::SelectResource {
                resource, expected, ..
            } => self.select_resource(&resource, &expected).await,
            BrowserRequest::Observe { resource_id } => {
                let runtime = self.resource(&resource_id).await?;
                match runtime.observe().await {
                    Ok(observation) => Ok(json!(observation)),
                    Err(error) => Ok(
                        json!({"control":runtime.control().await,"pages":[],"observation_error":runtime_error(error).code}),
                    ),
                }
            }
            BrowserRequest::ControlState { resource_id } => {
                Ok(json!(self.resource(&resource_id).await?.control().await))
            }
            BrowserRequest::DialogState {
                resource_id,
                page_id,
            } => Ok(json!(
                self.resource(&resource_id)
                    .await?
                    .dialog(&page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::DialogRespond {
                caller,
                authority,
                dialog,
                response,
            } => Ok(json!(
                self.bound_resource(&authority.lease.resource)
                    .await?
                    .respond_dialog(&caller, &authority, &dialog, response)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::Control {
                resource,
                controller_id,
                expected,
                ..
            } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .request_control(controller_id, expected.as_ref())
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::Action {
                caller,
                authority,
                action,
            } => {
                let mut result = self
                    .bound_resource(&authority.lease.resource)
                    .await?
                    .action(&caller, &authority, *action)
                    .await
                    .map_err(runtime_error)?;
                self.results
                    .capture_response(
                        OperationIdV1::new(authority.operation_id.as_str())
                            .expect("validated operation"),
                        &authority.page,
                        &mut result,
                    )
                    .await?;
                Ok(json!(result))
            }
            BrowserRequest::TracingStop { caller, authority } => {
                let mut result = self
                    .bound_resource(&authority.lease.resource)
                    .await?
                    .stop_tracing(&caller, &authority)
                    .await
                    .map_err(runtime_error)?;
                if result.response.data.get("artifact_payload").is_some() {
                    // Provenance comes from the retained native interval, not the
                    // caller or another live page chosen after the original closed.
                    let origin: BrowserPageIdentity =
                        serde_json::from_value(result.response.data["interval"]["origin"].clone())
                            .map_err(|_| {
                                BackendDispatchError::terminal("browser_artifact_invalid")
                            })?;
                    if origin.resource != authority.lease.resource {
                        return Err(BackendDispatchError::terminal("browser_artifact_invalid"));
                    }
                    self.results
                        .capture_response(
                            OperationIdV1::new(authority.operation_id.as_str())
                                .expect("validated operation"),
                            &origin,
                            &mut result,
                        )
                        .await?;
                }
                Ok(json!(result))
            }
            BrowserRequest::Snapshot { page, options } => Ok(json!(
                self.bound_resource(&page.resource)
                    .await?
                    .snapshot(&page, &options)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::Screenshot { page } => self.image(&page, false).await,
            BrowserRequest::Frame { page } => self.image(&page, true).await,
            BrowserRequest::Capture {
                page,
                options,
                operation_id,
            } => {
                let capture = self
                    .bound_resource(&page.resource)
                    .await?
                    .capture_image(&page, &options)
                    .await
                    .map_err(runtime_error)?;
                let artifact = self.results.capture(operation_id, capture.file).await?;
                let mut result = json!({"artifact":artifact,"viewport":capture.viewport});
                if let Some(snapshot) = capture.snapshot {
                    result["snapshot"] = json!(snapshot);
                    result["annotations"] = json!(capture.annotations);
                }
                Ok(result)
            }
            BrowserRequest::CaptureDiff {
                page,
                options,
                baseline,
                threshold,
                operation_id,
            } => {
                let capture = self
                    .bound_resource(&page.resource)
                    .await?
                    .capture_diff(&page, &options, &baseline, threshold)
                    .await
                    .map_err(runtime_error)?;
                let mut result = capture.report;
                result["page"] = json!(page);
                result["viewport"] = capture.viewport;
                if let Some(file) = capture.file {
                    result["artifact"] = self.results.capture(operation_id, file).await?;
                }
                Ok(result)
            }
            BrowserRequest::Query { page, query } => self
                .bound_resource(&page.resource)
                .await?
                .query(&page, &query)
                .await
                .map_err(runtime_error),
            BrowserRequest::Wait { page, wait } => self
                .bound_resource(&page.resource)
                .await?
                .wait(&page, &wait)
                .await
                .map_err(runtime_error),
            BrowserRequest::Network { page } => Ok(json!(
                self.bound_resource(&page.resource)
                    .await?
                    .network(&page)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::NetworkState { resource, page_id } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .network_state(&resource, &page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::NetworkDetail {
                page,
                sequence,
                operation_id,
                export_file,
            } => {
                let detail = self
                    .bound_resource(&page.resource)
                    .await?
                    .network_detail(&page, sequence)
                    .await
                    .map_err(runtime_error)?;
                let bytes = serde_json::to_vec(&detail).map_err(|_| {
                    BackendDispatchError::terminal("browser_network_detail_invalid")
                })?;
                if export_file || bytes.len() > 512 * 1024 {
                    let artifact = self
                        .results
                        .capture(
                            operation_id,
                            CapturedFile {
                                page: page.clone(),
                                mime_type: "application/json",
                                suggested_filename: Some(format!("request-{}.json", sequence.0)),
                                bytes,
                            },
                        )
                        .await?;
                    Ok(json!({"page":page,"request":detail.request,"artifact":artifact}))
                } else {
                    Ok(json!(detail))
                }
            }
            BrowserRequest::InterceptionState { resource, page_id } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .interception_state(&resource, &page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::RecordingState { resource, page_id } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .recording_state(&resource, &page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::TracingIntervals { resource } => Ok(json!({
                "resource":resource,
                "instances":self.bound_resource(&resource).await?.tracing_intervals(&resource).await.map_err(runtime_error)?
            })),
            BrowserRequest::TracingState { resource, page_id } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .tracing_state(&resource, &page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::NetworkCaptureState { resource, page_id } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .network_capture_state(&resource, &page_id)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::Console {
                resource,
                page_id,
                query,
            } => Ok(json!(
                self.bound_resource(&resource)
                    .await?
                    .console(&resource, &page_id, query)
                    .await
                    .map_err(runtime_error)?
            )),
            BrowserRequest::Close { resource, .. } => {
                self.bound_resource(&resource)
                    .await?
                    .close(&resource)
                    .await
                    .map_err(runtime_error)?;
                let mut resources = self.resources.lock().await;
                self.target_retired(&resources, &resource)?;
                resources.remove(&resource.resource_id);
                Ok(json!({"resource":resource,"closed":true}))
            }
            BrowserRequest::Receipt { .. } | BrowserRequest::Artifact { .. } => {
                unreachable!("receipt reads are handled before execution")
            }
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<(), crate::ControlPlaneError> {
        self.slots.close();
        // Queue the exclusive admission lock first: later requests cannot start
        // while existing journaled work drains. Retire current resources in
        // parallel so a renderer waiting for a human dialog can release its
        // read guard only after its terminal receipt is stored.
        let (mut closing, ()) = tokio::join!(
            biased;
            self.closing.write(),
            async {
                let resources = self.resources.lock().await;
                for managed in resources.values() {
                    let identity = managed.runtime.control().await.resource;
                    // The final close below reports any unconfirmed retirement.
                    let _ = managed.runtime.begin_retirement(&identity).await;
                }
            }
        );
        *closing = true;
        self.installer.stop().await;
        let mut resources = self.resources.lock().await;
        let mut unconfirmed = false;
        for managed in resources.values() {
            let identity = managed.runtime.control().await.resource;
            if let Err(error) = managed.runtime.close(&identity).await {
                unconfirmed = true;
                eprintln!(
                    "browser retirement remains unconfirmed: {} ({error:?})",
                    identity.resource_id.as_str()
                );
            }
        }
        if unconfirmed {
            return Err(crate::ControlPlaneError::Invalid(
                "browser resource retirement is unconfirmed",
            ));
        }
        resources.clear();
        Ok(())
    }
}

async fn append(
    store: &SqliteDomainStore,
    operation_id: &OperationIdV1,
    sequence: i64,
    body: OperationEventBodyV1,
) -> Result<(), BackendDispatchError> {
    let event_id = format!(
        "browser:{:x}:{sequence}",
        Sha256::digest(operation_id.as_str().as_bytes())
    );
    store
        .append_operation_event(&OperationEventV1 {
            event_id: OperationEventIdV1::new(event_id).expect("bounded event digest"),
            operation_id: operation_id.clone(),
            sequence,
            body,
            created_at_ms: now_ms()
                .map_err(|_| BackendDispatchError::terminal("browser_clock_unavailable"))?,
        })
        .await
        .map_err(|_| BackendDispatchError::terminal("browser_journal_unavailable"))?;
    Ok(())
}

fn runtime_error(error: BrowserRuntimeError) -> BackendDispatchError {
    let code = match &error {
        BrowserRuntimeError::Engine(error) if error.outcome_unknown => "browser_outcome_unknown",
        BrowserRuntimeError::Engine(error) => error.code,
        BrowserRuntimeError::Observation(code) => code,
        BrowserRuntimeError::Admission(error) => match error {
            BrowserAdmissionError::ResourceMismatch => "browser_resource_mismatch",
            BrowserAdmissionError::InstanceMismatch => "browser_instance_mismatch",
            BrowserAdmissionError::PageGone => "browser_page_gone",
            BrowserAdmissionError::DocumentChanged => "browser_document_changed",
            BrowserAdmissionError::SnapshotChanged => "browser_snapshot_changed",
            BrowserAdmissionError::ElementNotObserved => "browser_element_not_observed",
            BrowserAdmissionError::ControllerChanged => "browser_controller_changed",
            BrowserAdmissionError::CallerMismatch => "browser_caller_mismatch",
            BrowserAdmissionError::ControlTransferPending => "browser_control_transfer_pending",
            BrowserAdmissionError::ActionInFlight => "browser_action_in_flight",
            BrowserAdmissionError::CommandAlreadyDispatched => "browser_command_already_dispatched",
            BrowserAdmissionError::CommandSequenceGap => "browser_command_sequence_gap",
            BrowserAdmissionError::OutcomeUnknown => "browser_outcome_unknown",
            BrowserAdmissionError::ResourceRetiring => "browser_resource_retiring",
            BrowserAdmissionError::ResourceClosed => "browser_resource_closed",
            BrowserAdmissionError::CapacityExceeded => "browser_capacity_exceeded",
            BrowserAdmissionError::RevisionExhausted => "browser_revision_exhausted",
            BrowserAdmissionError::PermitMismatch => "browser_permit_mismatch",
            BrowserAdmissionError::DialogChanged => "browser_dialog_changed",
            BrowserAdmissionError::DialogResponseInvalid => "browser_dialog_response_invalid",
            BrowserAdmissionError::DialogObservationLost => "browser_dialog_observation_lost",
            BrowserAdmissionError::FrameGone => "browser_frame_gone",
            BrowserAdmissionError::FrameChanged => "browser_frame_changed",
            BrowserAdmissionError::RecordingAlreadyActive => "browser_recording_already_active",
            BrowserAdmissionError::RecordingNotActive => "browser_recording_not_active",
            BrowserAdmissionError::TracingAlreadyActive => "browser_trace_already_active",
            BrowserAdmissionError::TracingNotActive => "browser_trace_not_active",
            BrowserAdmissionError::TracingScopeRequired => "browser_trace_browser_scope_required",
            BrowserAdmissionError::PageLabelTaken => "browser_tab_label_taken",
        },
    };
    BackendDispatchError::terminal(code)
}
