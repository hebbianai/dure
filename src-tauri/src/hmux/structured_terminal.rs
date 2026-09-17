use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, Weak,
};
use std::time::{Duration, Instant};

use hmux_client::{
    ClientError, ConnectionRecord, FrameBody, RetryDirective, SessionDescriptor, SessionSelector,
    TerminalSurfaceAccess, TerminalSurfaceAttachment, TerminalSurfaceDetachHandle,
    project_agent_identity as project_agent_identity_descriptor,
    project_agent_runtime_state as project_agent_runtime_state_descriptor,
    project_provider_conversation_identity as project_provider_conversation_identity_descriptor,
    project_working_directory_projection as project_working_directory_descriptor,
};
use hmux_ssh_transport::{
    attach_terminal_surface_over_ssh, AttachError, SessionFence, SshExecConfig,
};
use serde::Serialize;
use tauri::{
    ipc::Response,
    Manager, State, WebviewWindow,
};

use crate::structured_terminal_access::RequestedTerminalSurfaceAccess;
use crate::AppState;

use super::{
    observer_webview_lifecycle::ObserverWebviewBinding, product_catalog,
    project_agent_identity, project_agent_runtime_state, project_provider_conversation_identity,
    project_session, project_working_directory, retirement::PaneAttachmentIdentity,
    validate_identifier, HmuxManager, ObserverAgentIdentity, ObserverAgentRuntimeState,
    ObserverProviderConversationIdentity, ObserverWorkingDirectory, SessionSummary,
};

mod upstream_actor;

use upstream_actor::StructuredTerminalUpstream;

const STRUCTURED_TERMINAL_DETACH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
struct StructuredTerminalAttachState {
    started: bool,
    finished: bool,
    cleanup_failure: Option<String>,
}

#[derive(Debug, Default)]
struct StructuredTerminalAttachBarrier {
    state: Mutex<StructuredTerminalAttachState>,
    changed: Condvar,
}

impl StructuredTerminalAttachBarrier {
    fn begin(
        self: &Arc<Self>,
        cancelled: &AtomicBool,
    ) -> Result<StructuredTerminalAttachGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "hmux_structured_attach_poisoned: attach transaction state poisoned")?;
        if cancelled.load(Ordering::Acquire) {
            return Err(
                "hmux_structured_attach_retired: surface attachment was replaced".to_string(),
            );
        }
        if state.started || state.finished {
            return Err(
                "hmux_structured_attach_invalid: attach transaction already started".to_string(),
            );
        }
        state.started = true;
        Ok(StructuredTerminalAttachGuard {
            barrier: Arc::clone(self),
            finished: false,
        })
    }

    fn cancel(&self, cancelled: &AtomicBool) -> Result<(), String> {
        cancelled.store(true, Ordering::Release);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "hmux_structured_attach_poisoned: attach transaction state poisoned")?;
        if !state.started {
            state.finished = true;
            self.changed.notify_all();
        }
        Ok(())
    }

    fn started(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map(|state| state.started)
            .map_err(|_| {
                "hmux_structured_attach_poisoned: attach transaction state poisoned".into()
            })
    }

    fn cancel_and_wait(
        &self,
        cancelled: &AtomicBool,
        timeout: Duration,
    ) -> Result<(), String> {
        cancelled.store(true, Ordering::Release);
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            "hmux_structured_attach_deadline_invalid: attach retirement deadline overflowed"
                .to_string()
        })?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "hmux_structured_attach_poisoned: attach transaction state poisoned")?;
        if !state.started {
            state.finished = true;
            self.changed.notify_all();
            return Ok(());
        }
        while !state.finished {
            let now = Instant::now();
            if now >= deadline {
                return Err(
                    "hmux_structured_attach_retirement_timeout: in-flight surface attach is still retiring"
                        .to_string(),
                );
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| {
                    "hmux_structured_attach_poisoned: attach transaction state poisoned"
                        .to_string()
                })?;
            state = next;
            if result.timed_out() && !state.finished {
                return Err(
                    "hmux_structured_attach_retirement_timeout: in-flight surface attach is still retiring"
                        .to_string(),
                );
            }
        }
        match state.cleanup_failure.as_ref() {
            Some(error) => Err(format!(
                "hmux_structured_attach_cleanup_unconfirmed: {error}"
            )),
            None => Ok(()),
        }
    }

    fn finish(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.finished = true;
        self.changed.notify_all();
    }

    fn fail_cleanup(&self, error: String) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cleanup_failure.get_or_insert(error);
    }
}

#[derive(Debug)]
struct StructuredTerminalAttachGuard {
    barrier: Arc<StructuredTerminalAttachBarrier>,
    finished: bool,
}

impl StructuredTerminalAttachGuard {
    fn finish(mut self) {
        self.barrier.finish();
        self.finished = true;
    }
}

impl Drop for StructuredTerminalAttachGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.barrier.fail_cleanup(
                "hmux_structured_attach_abandoned: attach transaction ended without an explicit cleanup outcome"
                    .to_string(),
            );
            self.barrier.finish();
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StructuredTerminalAttachReceipt {
    terminal_epoch: String,
    through_output_seq: String,
    state_revision: String,
    initial_delivery_record_count: usize,
    selected_capabilities: Vec<String>,
    /// Tauri-adapter command duration. This is not part of the Hmux protocol.
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_command_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<SessionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StructuredTerminalAttachFailure {
    code: String,
    message: String,
    retry_directive: RetryDirective,
}

impl StructuredTerminalAttachFailure {
    pub(crate) fn adapter(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_directive: RetryDirective::Never,
        }
    }

    fn client(error: ClientError) -> Self {
        let retry_directive = error.retry_directive();
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
            retry_directive,
        }
    }
}

impl From<String> for StructuredTerminalAttachFailure {
    fn from(message: String) -> Self {
        Self::adapter("hmux_structured_attach_failed", message)
    }
}

impl From<ClientError> for StructuredTerminalAttachFailure {
    fn from(error: ClientError) -> Self {
        Self::client(error)
    }
}

impl From<AttachError> for StructuredTerminalAttachFailure {
    fn from(error: AttachError) -> Self {
        match error {
            AttachError::Ssh(error) => Self::client(error.into()),
            AttachError::Session(error) => Self::client(error),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct StructuredTerminalSlot {
    window_label: String,
    webview_instance_id: String,
    webview_generation: u64,
    webview_lifetime: usize,
    surface_id: String,
}

impl StructuredTerminalSlot {
    fn new(webview: &ObserverWebviewBinding, surface_id: String) -> Self {
        Self {
            window_label: webview.window_label().to_string(),
            webview_instance_id: webview.instance_id().to_string(),
            webview_generation: webview.generation(),
            webview_lifetime: webview.lifetime_identity(),
            surface_id,
        }
    }
}

pub(super) enum StructuredTerminalEntry {
    Attaching(StructuredTerminalReservation),
    Attached(Box<StructuredTerminalTask>),
}

impl StructuredTerminalEntry {
    pub(super) fn observer_id(&self) -> &str {
        match self {
            Self::Attaching(reservation) => &reservation.observer_id,
            Self::Attached(task) => &task.observer_id,
        }
    }

    pub(super) fn webview(&self) -> &ObserverWebviewBinding {
        match self {
            Self::Attaching(reservation) => &reservation.webview,
            Self::Attached(task) => &task.webview,
        }
    }

    pub(super) fn begin_stop(&self) {
        match self {
            Self::Attaching(reservation) => {
                let _ = reservation.cancel();
            }
            Self::Attached(task) => task.begin_stop(),
        }
    }

    pub(super) fn stop(self) {
        match self {
            Self::Attaching(reservation) => {
                let _ = reservation.cancel();
            }
            Self::Attached(task) => task.stop(),
        }
    }

    pub(super) fn stop_confirmed(self) -> Result<(), String> {
        match self {
            Self::Attaching(reservation) => {
                reservation.cancel_and_wait(STRUCTURED_TERMINAL_DETACH_TIMEOUT)
            }
            Self::Attached(task) => task.stop_confirmed(),
        }
    }

    fn retire(self) {
        match self {
            Self::Attaching(reservation) => {
                let _ = reservation.cancel();
            }
            Self::Attached(task) => task.retire(),
        }
    }

    fn attached(&self) -> Option<&StructuredTerminalTask> {
        match self {
            Self::Attaching(_) => None,
            Self::Attached(task) => Some(task),
        }
    }

    pub(super) fn matches_pane_departure(&self, target: &PaneAttachmentIdentity) -> bool {
        match self {
            Self::Attaching(reservation) => target.matches_owner(&reservation.slot.surface_id),
            Self::Attached(task) => target.matches_pane_attachment(&task.pane_attachment),
        }
    }

    pub(super) fn attachment_started(&self) -> Result<bool, String> {
        match self {
            Self::Attaching(reservation) => reservation.attach.started(),
            Self::Attached(_) => Ok(true),
        }
    }

    pub(super) fn attached_generation(&self) -> Option<SessionDescriptor> {
        self.attached()?
            .generation_proof
            .as_ref()?
            .live_session()
            .cloned()
    }
}

#[derive(Clone)]
pub(crate) struct StructuredTerminalReservation {
    slot: StructuredTerminalSlot,
    observer_id: String,
    webview: ObserverWebviewBinding,
    cancelled: Arc<AtomicBool>,
    attach: Arc<StructuredTerminalAttachBarrier>,
}

impl StructuredTerminalReservation {
    pub(super) fn surface_id(&self) -> &str {
        &self.slot.surface_id
    }

    fn same_claim(&self, other: &Self) -> bool {
        self.observer_id == other.observer_id
            && self.webview.same_generation(&other.webview)
            && Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }

    fn begin_attach(&self) -> Result<StructuredTerminalAttachGuard, String> {
        self.attach.begin(self.cancelled.as_ref())
    }

    fn cancel(&self) -> Result<(), String> {
        self.attach.cancel(self.cancelled.as_ref())
    }

    fn cancel_and_wait(&self, timeout: Duration) -> Result<(), String> {
        self.attach
            .cancel_and_wait(self.cancelled.as_ref(), timeout)
    }

    fn fail_cleanup(&self, error: String) {
        self.attach.fail_cleanup(error);
    }
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_attach(
    window: WebviewWindow,
    observer_id: String,
    webview_instance_id: String,
    surface_id: String,
    session_id: String,
    workspace_id: Option<String>,
    access: RequestedTerminalSurfaceAccess,
) -> Result<StructuredTerminalAttachReceipt, StructuredTerminalAttachFailure> {
    let command_started_at = Instant::now();
    let state = window.state::<AppState>();
    let webview = state
        .hmux
        .claim_observer_webview(&window, &webview_instance_id)
        .await?;
    let hmux = Arc::clone(&state.hmux);
    let mut receipt = tauri::async_runtime::spawn_blocking(move || {
        let reservation =
            hmux.reserve_structured_terminal(observer_id, surface_id, webview)?;
        hmux.attach_structured_terminal(reservation, session_id, workspace_id, access.into())
    })
    .await
    .map_err(|error| {
        StructuredTerminalAttachFailure::adapter(
            "hmux_structured_attach_task_failed",
            format!("attach structured terminal task failed: {error}"),
        )
    })??;
    receipt.backend_command_us =
        Some(u64::try_from(command_started_at.elapsed().as_micros()).unwrap_or(u64::MAX));
    Ok(receipt)
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_next(
    window: WebviewWindow,
    observer_id: String,
    webview_instance_id: String,
) -> Result<Response, String> {
    let state = window.state::<AppState>();
    let webview = state
        .hmux
        .capture_existing_observer_webview(window.label(), &webview_instance_id)?;
    let hmux = Arc::clone(&state.hmux);
    let record = tauri::async_runtime::spawn_blocking(move || {
        hmux.next_structured_terminal_record(&observer_id, &webview)
    })
    .await
    .map_err(|error| format!("read structured terminal task failed: {error}"))??;
    Ok(Response::new(record))
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_detach(
    state: State<'_, AppState>,
    observer_id: String,
) -> Result<(), String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.detach_structured_terminal(&observer_id))
        .await
        .map_err(|error| format!("detach structured terminal task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn hmux_structured_terminal_upstream(
    state: State<'_, AppState>,
    observer_id: String,
    record: Vec<u8>,
) -> Result<String, String> {
    state
        .hmux
        .structured_terminal_upstream(&observer_id, record)
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AdapterRecord<'a> {
    Control { body: &'a FrameBody },
    AgentIdentity { identity: ObserverAgentIdentity },
    AgentRuntimeState { state: ObserverAgentRuntimeState },
    WorkingDirectory {
        /// Explicit rename: the container's `rename_all` renames variants, not
        /// struct-variant fields.
        #[serde(rename = "workingDirectory")]
        working_directory: ObserverWorkingDirectory,
    },
    ProviderConversationIdentity {
        identity: ObserverProviderConversationIdentity,
    },
    Closed {
        code: &'a str,
        message: String,
        /// Explicit rename: the container's `rename_all` renames variants, not
        /// struct-variant fields, so an unrenamed field would ship as
        /// `retry_directive` and the frontend would never see the posture.
        #[serde(rename = "retryDirective")]
        retry_directive: RetryDirective,
    },
}

fn project_control_record(body: &FrameBody) -> Result<AdapterRecord<'_>, String> {
    Ok(match body {
        FrameBody::AgentIdentity(identity) => AdapterRecord::AgentIdentity {
            identity: project_agent_identity(project_agent_identity_descriptor(identity.clone())),
        },
        FrameBody::AgentRuntimeState(state) => AdapterRecord::AgentRuntimeState {
            state: project_agent_runtime_state(project_agent_runtime_state_descriptor(
                state.clone(),
            )
            .map_err(|error| format!("{}: {error}", error.code()))?),
        },
        FrameBody::WorkingDirectory(projection) => AdapterRecord::WorkingDirectory {
            working_directory: project_working_directory(project_working_directory_descriptor(
                projection.clone(),
            )),
        },
        FrameBody::ProviderConversationIdentity(identity) => {
            AdapterRecord::ProviderConversationIdentity {
                identity: project_provider_conversation_identity(
                    project_provider_conversation_identity_descriptor(identity.clone()),
                ),
            }
        }
        body => AdapterRecord::Control { body },
    })
}

pub(super) struct StructuredTerminalTask {
    observer_id: String,
    pane_attachment: PaneAttachmentIdentity,
    stop: Arc<AtomicBool>,
    interrupt: StructuredTerminalInterrupt,
    generation_proof: Option<StructuredTerminalGenerationProof>,
    pub(super) webview: ObserverWebviewBinding,
    departure: Option<TerminalSurfaceDetachHandle>,
    upstream: StructuredTerminalUpstream,
    pull: StructuredTerminalPull,
}

enum StructuredTerminalInterrupt {
    Live(hmux_client::ConnectionInterrupt),
    #[cfg(test)]
    Probe(Arc<AtomicBool>),
}

impl StructuredTerminalInterrupt {
    fn interrupt(&self) {
        match self {
            Self::Live(interrupt) => interrupt.interrupt(),
            #[cfg(test)]
            Self::Probe(interrupted) => interrupted.store(true, Ordering::Release),
        }
    }
}

#[derive(Clone)]
struct StructuredTerminalPull {
    state: Arc<Mutex<StructuredTerminalPullState>>,
    admission: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
    conversation_generation: Option<StructuredTerminalGenerationProof>,
}

struct StructuredTerminalPullState {
    initial_records: VecDeque<Vec<u8>>,
    surface: Option<TerminalSurfaceAttachment>,
}

struct StructuredTerminalPullRecord {
    encoded: Vec<u8>,
    terminal: bool,
}

#[derive(Debug)]
enum StructuredTerminalPullFailure {
    Retired,
    Concurrent,
    Other(String),
}

impl StructuredTerminalPullFailure {
    fn into_message(self) -> String {
        match self {
            Self::Retired => {
                "hmux_structured_pull_retired: attachment is retired".to_string()
            }
            Self::Concurrent => {
                "hmux_structured_pull_concurrent: one record request is already active"
                    .to_string()
            }
            Self::Other(message) => message,
        }
    }
}

#[derive(Debug)]
struct StructuredTerminalPullLease<'a> {
    active: &'a AtomicBool,
}

impl Drop for StructuredTerminalPullLease<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
struct StructuredTerminalGenerationProof {
    session: SessionDescriptor,
    live: Arc<AtomicBool>,
}

impl StructuredTerminalGenerationProof {
    fn new(session: SessionDescriptor) -> Self {
        Self {
            session,
            live: Arc::new(AtomicBool::new(true)),
        }
    }

    fn is_live_for(&self, session: &SessionDescriptor) -> bool {
        self.live.load(Ordering::Acquire) && self.session.same_generation(session)
    }

    fn live_session(&self) -> Option<&SessionDescriptor> {
        self.live.load(Ordering::Acquire).then_some(&self.session)
    }

    fn retire(&self) {
        self.live.store(false, Ordering::Release);
    }
}

impl StructuredTerminalPull {
    fn enter(&self) -> Result<StructuredTerminalPullLease<'_>, StructuredTerminalPullFailure> {
        enter_pull(self.admission.as_ref(), self.stop.as_ref())
    }

    fn same_authority(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    fn next_record(
        &self,
    ) -> Result<StructuredTerminalPullRecord, StructuredTerminalPullFailure> {
        let _lease = self.enter()?;
        if self.ended.load(Ordering::Acquire) {
            return Err(StructuredTerminalPullFailure::Other(
                "hmux_structured_pull_ended: terminal stream ended".to_string(),
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| {
                StructuredTerminalPullFailure::Other(
                    "Hmux structured terminal pull state poisoned".to_string(),
                )
            })?;
        if let Some(record) = state.initial_records.pop_front() {
            return Ok(StructuredTerminalPullRecord {
                encoded: record,
                terminal: false,
            });
        }
        let surface = state.surface.as_mut().ok_or_else(|| {
            StructuredTerminalPullFailure::Other(
                "hmux_structured_pull_retired: terminal surface is detached".to_string(),
            )
        })?;
        match surface.read_delivery_record() {
            Ok(ConnectionRecord::TerminalState(record)) => Ok(StructuredTerminalPullRecord {
                encoded: record,
                terminal: false,
            }),
            Ok(ConnectionRecord::Control(body)) => {
                if let FrameBody::ProviderConversationIdentity(identity) = body.as_ref() {
                    let identity =
                        project_provider_conversation_identity_descriptor(identity.clone());
                    observe_structured_provider_conversation_identity(
                        self.conversation_generation.as_ref(),
                        &identity,
                    );
                }
                let record = encode_control_pull_record(body.as_ref())
                    .map_err(StructuredTerminalPullFailure::Other)?;
                if record.terminal {
                    self.ended.store(true, Ordering::Release);
                }
                Ok(record)
            }
            Err(error) => {
                if self.stop.load(Ordering::Acquire) {
                    return Err(StructuredTerminalPullFailure::Retired);
                }
                self.ended.store(true, Ordering::Release);
                // Project the posture the client boundary owns; re-deriving it
                // downstream from the code string is what error.rs:352 forbids.
                let retry_directive = error.retry_directive();
                Ok(encode_closed_pull_record(
                    error.code(),
                    error.to_string(),
                    retry_directive,
                ))
            }
        }
    }
}

fn enter_pull<'a>(
    admission: &'a AtomicBool,
    stop: &AtomicBool,
) -> Result<StructuredTerminalPullLease<'a>, StructuredTerminalPullFailure> {
    if stop.load(Ordering::Acquire) {
        return Err(StructuredTerminalPullFailure::Retired);
    }
    admission
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| StructuredTerminalPullFailure::Concurrent)?;
    if stop.load(Ordering::Acquire) {
        admission.store(false, Ordering::Release);
        return Err(StructuredTerminalPullFailure::Retired);
    }
    Ok(StructuredTerminalPullLease { active: admission })
}

impl StructuredTerminalTask {
    pub(super) fn begin_stop(&self) {
        if let Some(proof) = &self.generation_proof {
            proof.retire();
        }
        self.stop.store(true, Ordering::Release);
        self.upstream.close();
        if self.departure.is_none() {
            self.interrupt.interrupt();
        }
    }

    pub(super) fn stop(self) {
        let _ = self.stop_with_confirmation(false);
    }

    pub(super) fn stop_confirmed(self) -> Result<(), String> {
        self.stop_with_confirmation(true)
    }

    fn stop_with_confirmation(self, confirmed: bool) -> Result<(), String> {
        self.begin_stop();
        let departure = self
            .departure
            .as_ref()
            .map(|departure| {
                departure
                    .begin_detach()
                    .map(|_| ())
                    .map_err(|error| format!("{}: {error}", error.code()))
            })
            .unwrap_or(Ok(()));
        if !confirmed || self.departure.is_none() || departure.is_err() {
            self.interrupt.interrupt();
        }
        let mut state = self
            .pull
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let detached = state
            .surface
            .take()
            .map(|surface| {
                if confirmed && departure.is_ok() {
                    surface.detach_confirmed(STRUCTURED_TERMINAL_DETACH_TIMEOUT)
                } else {
                    surface.detach()
                }
                .map_err(|error| format!("{}: {error}", error.code()))
            })
            .transpose();
        state.initial_records.clear();
        if confirmed {
            departure?;
        }
        detached.map(|_| ())
    }

    fn retire(self) {
        self.begin_stop();
        tauri::async_runtime::spawn_blocking(move || self.stop());
    }
}

impl HmuxManager {
    pub(crate) fn reserve_structured_terminal(
        &self,
        observer_id: String,
        surface_id: String,
        webview: ObserverWebviewBinding,
    ) -> Result<StructuredTerminalReservation, String> {
        validate_identifier("observer id", &observer_id)?;
        validate_identifier("surface id", &surface_id)?;
        webview.wait_for_predecessor_retirement()?;
        webview.require_live(
            "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
        )?;
        let reservation = StructuredTerminalReservation {
            slot: StructuredTerminalSlot::new(&webview, surface_id),
            observer_id,
            webview,
            cancelled: Arc::new(AtomicBool::new(false)),
            attach: Arc::new(StructuredTerminalAttachBarrier::default()),
        };
        let mut entries = self
            .structured_terminals
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
        if entries.iter().any(|(slot, entry)| {
            slot != &reservation.slot && entry.observer_id() == reservation.observer_id
        }) {
            return Err(
                "hmux_structured_observer_conflict: observer id is already attached".to_string(),
            );
        }
        let replaced = entries.insert(
            reservation.slot.clone(),
            StructuredTerminalEntry::Attaching(reservation.clone()),
        );
        drop(entries);
        if let Some(replaced) = replaced {
            if let Err(error) = replaced.stop_confirmed() {
                self.cancel_structured_terminal_reservation(&reservation);
                return Err(format!(
                    "hmux_structured_predecessor_detach_unconfirmed: {error}"
                ));
            }
        }
        if let Err(error) = reservation.webview.require_live(
            "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
        ) {
            self.cancel_structured_terminal_reservation(&reservation);
            return Err(error);
        }
        Ok(reservation)
    }

    pub(crate) fn cancel_structured_terminal_reservation(
        &self,
        reservation: &StructuredTerminalReservation,
    ) {
        let _ = reservation.cancel();
        let removed = self
            .structured_terminals
            .lock()
            .ok()
            .and_then(|mut entries| {
                let current = entries
                    .get(&reservation.slot)
                    .is_some_and(|entry| match entry {
                        StructuredTerminalEntry::Attaching(current) => {
                            current.same_claim(reservation)
                        }
                        StructuredTerminalEntry::Attached(_) => false,
                    });
                current.then(|| entries.remove(&reservation.slot)).flatten()
            });
        if let Some(removed) = removed {
            removed.retire();
        }
    }

    fn commit_structured_terminal(
        &self,
        reservation: &StructuredTerminalReservation,
        task: StructuredTerminalTask,
    ) -> Result<(), String> {
        let mut task = Some(task);
        let committed = self
            .structured_terminals
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())
            .and_then(|mut entries| {
                reservation.webview.require_live(
                    "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
                )?;
                if reservation.cancelled.load(Ordering::Acquire) {
                    return Err(
                        "hmux_structured_attach_retired: surface attachment was replaced"
                            .to_string(),
                    );
                }
                let entry = entries.get_mut(&reservation.slot).ok_or_else(|| {
                    "hmux_structured_attach_retired: surface attachment was retired".to_string()
                })?;
                let owns_slot = match entry {
                    StructuredTerminalEntry::Attaching(current) => {
                        current.same_claim(reservation)
                    }
                    StructuredTerminalEntry::Attached(_) => false,
                };
                if !owns_slot {
                    return Err(
                        "hmux_structured_attach_retired: surface attachment was replaced"
                            .to_string(),
                    );
                }
                *entry = StructuredTerminalEntry::Attached(Box::new(
                    task.take().expect("structured terminal task committed once"),
                ));
                Ok(())
            });
        if let Some(task) = task {
            if let Err(cleanup_error) = task.stop_confirmed() {
                reservation.fail_cleanup(cleanup_error.clone());
                return Err(match committed {
                    Ok(()) => format!(
                        "hmux_structured_uncommitted_detach_unconfirmed: {cleanup_error}"
                    ),
                    Err(error) => format!(
                        "{error}; hmux_structured_uncommitted_detach_unconfirmed: {cleanup_error}"
                    ),
                });
            }
        }
        committed
    }

    pub(crate) fn attach_structured_terminal(
        &self,
        reservation: StructuredTerminalReservation,
        session_id: String,
        workspace_id: Option<String>,
        access: TerminalSurfaceAccess,
    ) -> Result<StructuredTerminalAttachReceipt, StructuredTerminalAttachFailure> {
        let validation = (|| {
            validate_identifier("session id", &session_id)?;
            if let Some(workspace_id) = workspace_id.as_deref() {
                validate_identifier("workspace id", workspace_id)?;
            }
            Ok::<_, StructuredTerminalAttachFailure>(())
        })();
        if let Err(error) = validation {
            self.cancel_structured_terminal_reservation(&reservation);
            return Err(error);
        }
        let attach_guard = match reservation.begin_attach() {
            Ok(guard) => guard,
            Err(error) => {
                self.cancel_structured_terminal_reservation(&reservation);
                return Err(error.into());
            }
        };
        let attached = (|| -> Result<_, StructuredTerminalAttachFailure> {
            reservation.webview.require_live(
                "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
            )?;
            if reservation.cancelled.load(Ordering::Acquire) {
                return Err(
                    "hmux_structured_attach_retired: surface attachment was replaced"
                        .to_string()
                        .into(),
                );
            }
            let catalog = product_catalog()?;
            let selector = SessionSelector::new(session_id, workspace_id);
            let session = catalog.open_current_managed(&selector)?;
            let session_descriptor = session.descriptor().clone();
            let session_summary = project_session(session_descriptor.clone());
            let pane_attachment = PaneAttachmentIdentity::new(
                reservation.slot.surface_id.clone(),
                session_descriptor.session_id.clone(),
                session_descriptor.workspace_id.clone(),
            );
            if reservation.cancelled.load(Ordering::Acquire) {
                return Err(
                    "hmux_structured_attach_retired: surface attachment was replaced"
                        .to_string()
                        .into(),
                );
            }
            let connection = session
                .connect_with_options(TerminalSurfaceAttachment::connection_options(
                    access,
                    None,
                ))?;
            let surface = TerminalSurfaceAttachment::from_connection(connection).map_err(|error| {
                reservation.fail_cleanup(format!(
                    "hmux_structured_attach_negotiation_unconfirmed: {}: {error}",
                    error.code()
                ));
                StructuredTerminalAttachFailure::client(error)
            })?;
            self.attach_structured_terminal_surface(
                &reservation,
                surface,
                pane_attachment,
                Some(StructuredTerminalGenerationProof::new(session_descriptor)),
                Some(session_summary),
            )
            .map_err(Into::into)
        })();
        attach_guard.finish();
        if attached.is_err() {
            self.cancel_structured_terminal_reservation(&reservation);
        }
        attached
    }

    pub(crate) fn attach_remote_structured_terminal(
        &self,
        reservation: StructuredTerminalReservation,
        fence: SessionFence,
        ssh: SshExecConfig,
        access: TerminalSurfaceAccess,
        on_host_attach: impl FnOnce() -> Result<(), String>,
    ) -> Result<StructuredTerminalAttachReceipt, StructuredTerminalAttachFailure> {
        let attach_guard = match reservation.begin_attach() {
            Ok(guard) => guard,
            Err(error) => {
                self.cancel_structured_terminal_reservation(&reservation);
                return Err(error.into());
            }
        };
        let attached = (|| -> Result<_, StructuredTerminalAttachFailure> {
            reservation.webview.require_live(
                "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
            )?;
            if reservation.cancelled.load(Ordering::Acquire) {
                return Err(
                    "hmux_structured_attach_retired: surface attachment was replaced"
                        .to_string()
                        .into(),
                );
            }
            let pane_attachment = PaneAttachmentIdentity::new(
                reservation.slot.surface_id.clone(),
                fence.session_id.clone(),
                fence.workspace_id.clone(),
            );
            let surface = attach_terminal_surface_over_ssh(ssh, fence, access)
            .map_err(|error| {
                reservation.fail_cleanup(format!(
                    "hmux_structured_remote_attach_unconfirmed: {}: {error}",
                    error.code()
                ));
                StructuredTerminalAttachFailure::from(error)
            })?;
            if let Err(error) = on_host_attach() {
                let error = detach_uncommitted_surface(&reservation, surface, error);
                return Err(StructuredTerminalAttachFailure::adapter(
                    "hmux_structured_remote_authority_failed",
                    error,
                ));
            }
            self.attach_structured_terminal_surface(
                &reservation,
                surface,
                pane_attachment,
                None,
                None,
            )
            .map_err(Into::into)
        })();
        attach_guard.finish();
        if attached.is_err() {
            self.cancel_structured_terminal_reservation(&reservation);
        }
        attached
    }

    fn attach_structured_terminal_surface(
        &self,
        reservation: &StructuredTerminalReservation,
        surface: TerminalSurfaceAttachment,
        pane_attachment: PaneAttachmentIdentity,
        generation_proof: Option<StructuredTerminalGenerationProof>,
        session: Option<SessionSummary>,
    ) -> Result<StructuredTerminalAttachReceipt, String> {
        let prepared = (|| {
            reservation.webview.require_live(
                "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
            )?;
            let initial = surface.current_frame().clone();
            let departure = surface.detach_handle();
            let selected_capabilities = surface.selected_capabilities().to_vec();
            let mut initial_records = VecDeque::new();
            if let Some(identity) = surface.initial_agent_identity().cloned() {
                initial_records.push_back(encode_json(&AdapterRecord::AgentIdentity {
                    identity: project_agent_identity(identity),
                })?);
            }
            if let Some(state) = surface.initial_agent_runtime_state().cloned() {
                initial_records.push_back(encode_json(&AdapterRecord::AgentRuntimeState {
                    state: project_agent_runtime_state(state),
                })?);
            }
            if let Some(working_directory) = surface.initial_working_directory().cloned() {
                initial_records.push_back(encode_json(&AdapterRecord::WorkingDirectory {
                    working_directory: project_working_directory(working_directory),
                })?);
            }
            if let Some(identity) = surface.initial_provider_conversation_identity().cloned() {
                observe_structured_provider_conversation_identity(
                    generation_proof.as_ref(),
                    &identity,
                );
                initial_records.push_back(encode_json(
                    &AdapterRecord::ProviderConversationIdentity {
                        identity: project_provider_conversation_identity(identity),
                    },
                )?);
            }
            initial_records.extend(surface.initial_delivery_records().iter().cloned());
            let upstream_handles = surface.upstream_handles();
            let interrupt = surface
                .interrupt_handle()
                .map_err(|error| error.to_string())?;
            let upstream_interrupt = surface
                .interrupt_handle()
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((
                initial,
                departure,
                selected_capabilities,
                initial_records,
                upstream_handles,
                interrupt,
                upstream_interrupt,
            ))
        })();
        let (
            initial,
            departure,
            selected_capabilities,
            initial_records,
            upstream_handles,
            interrupt,
            upstream_interrupt,
        ) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(detach_uncommitted_surface(reservation, surface, error));
            }
        };
        let initial_delivery_record_count = initial_records.len();
        let stop = Arc::new(AtomicBool::new(false));
        let pull = StructuredTerminalPull {
            state: Arc::new(Mutex::new(StructuredTerminalPullState {
                initial_records,
                surface: Some(surface),
            })),
            admission: Arc::new(AtomicBool::new(false)),
            stop: Arc::clone(&stop),
            ended: Arc::new(AtomicBool::new(false)),
            conversation_generation: generation_proof.clone(),
        };
        let failed_registry = Arc::downgrade(&self.structured_terminals);
        let failed_slot = reservation.slot.clone();
        let failed_observer_id = reservation.observer_id.clone();
        let failed_pull = pull.clone();
        let failed_stop = Arc::clone(&stop);
        let upstream = StructuredTerminalUpstream::start(
            upstream_handles,
            Arc::new(move || {
                failed_stop.store(true, Ordering::Release);
                upstream_interrupt.interrupt();
                retire_failed_structured_terminal_authority(
                    &failed_registry,
                    &failed_slot,
                    &failed_observer_id,
                    &failed_pull,
                );
            }),
        );
        let task = StructuredTerminalTask {
            observer_id: reservation.observer_id.clone(),
            pane_attachment,
            stop,
            interrupt: StructuredTerminalInterrupt::Live(interrupt),
            generation_proof,
            webview: reservation.webview.clone(),
            departure: Some(departure),
            upstream,
            pull,
        };
        self.commit_structured_terminal(reservation, task)?;

        Ok(StructuredTerminalAttachReceipt {
            terminal_epoch: initial.terminal_epoch().to_string(),
            through_output_seq: initial.through_output_seq().to_string(),
            state_revision: initial.state_revision().to_string(),
            initial_delivery_record_count,
            selected_capabilities,
            backend_command_us: None,
            session,
        })
    }

    pub(crate) fn detach_structured_terminal(&self, observer_id: &str) -> Result<(), String> {
        validate_identifier("observer id", observer_id)?;
        let entry = {
            let mut entries = self
                .structured_terminals
                .lock()
                .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
            let slot = entries
                .iter()
                .find(|(_, entry)| entry.observer_id() == observer_id)
                .map(|(slot, _)| slot.clone());
            slot.and_then(|slot| entries.remove(&slot))
        };
        if let Some(entry) = entry {
            entry.stop_confirmed()?;
        }
        Ok(())
    }

    pub(super) fn take_structured_pane_attachments(
        &self,
        target: &PaneAttachmentIdentity,
    ) -> Result<Vec<StructuredTerminalEntry>, String> {
        let mut entries = self
            .structured_terminals
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
        let matching = entries
            .iter()
            .filter(|(_, entry)| entry.matches_pane_departure(target))
            .map(|(slot, _)| slot.clone())
            .collect::<Vec<_>>();
        Ok(matching
            .into_iter()
            .filter_map(|slot| entries.remove(&slot))
            .collect())
    }

    pub(crate) fn structured_terminal_count(&self) -> Result<usize, String> {
        let entries = self
            .structured_terminals
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
        // Diagnostic observation must not acquire a pull's blocking stream lock.
        Ok(entries
            .values()
            .filter_map(StructuredTerminalEntry::attached)
            .filter(|task| !task.stop.load(Ordering::Acquire) && task.webview.is_live())
            .count())
    }

    fn next_structured_terminal_record(
        &self,
        observer_id: &str,
        webview: &ObserverWebviewBinding,
    ) -> Result<Vec<u8>, String> {
        validate_identifier("observer id", observer_id)?;
        let (slot, pull) = {
            let entries = self
                .structured_terminals
                .lock()
                .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
            let (slot, task) = entries
                .iter()
                .find_map(|(slot, entry)| {
                    (entry.observer_id() == observer_id)
                        .then(|| entry.attached().map(|task| (slot, task)))
                        .flatten()
                })
                .ok_or_else(|| {
                    "hmux_structured_pull_retired: attachment is not registered".to_string()
                })?;
            webview.require_same_generation(
                &task.webview,
                "hmux_structured_pull_retired: attachment belongs to another WebView generation",
            )?;
            (slot.clone(), task.pull.clone())
        };
        let record = match pull.next_record() {
            Ok(record) => record,
            Err(StructuredTerminalPullFailure::Retired) => {
                self.retire_structured_terminal_authority(&slot, observer_id, &pull)?;
                return Err(StructuredTerminalPullFailure::Retired.into_message());
            }
            Err(failure) => return Err(failure.into_message()),
        };
        if record.terminal {
            self.retire_structured_terminal_authority(&slot, observer_id, &pull)?;
        }
        Ok(record.encoded)
    }

    fn retire_structured_terminal_authority(
        &self,
        slot: &StructuredTerminalSlot,
        observer_id: &str,
        pull: &StructuredTerminalPull,
    ) -> Result<(), String> {
        retire_structured_terminal_authority_in(
            self.structured_terminals.as_ref(),
            slot,
            observer_id,
            pull,
        )
    }

    pub(crate) fn structured_terminal_upstream(
        &self,
        observer_id: &str,
        record: Vec<u8>,
    ) -> Result<String, String> {
        validate_identifier("observer id", observer_id)?;
        let (slot, pull, admission) = {
            let entries = self
                .structured_terminals
                .lock()
                .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
            let (slot, task) = entries
                .iter()
                .find_map(|(slot, entry)| {
                    (entry.observer_id() == observer_id)
                        .then(|| entry.attached().map(|task| (slot, task)))
                        .flatten()
                })
                .ok_or_else(|| "structured terminal connection is not attached".to_string())?;
            (
                slot.clone(),
                task.pull.clone(),
                task.upstream.enqueue(record),
            )
        };
        if let Err(error) = admission {
            self.retire_structured_terminal_authority(&slot, observer_id, &pull)?;
            return Err(error);
        }
        Ok("queued".to_string())
    }

    pub(super) fn has_live_structured_terminal_generation(
        &self,
        session: &SessionDescriptor,
    ) -> bool {
        let Ok(entries) = self.structured_terminals.lock() else {
            return false;
        };
        entries.values().any(|entry| {
            entry.attached().is_some_and(|task| {
                task.webview.is_live()
                    && task
                        .generation_proof
                        .as_ref()
                        .is_some_and(|proof| proof.is_live_for(session))
            })
        })
    }

    pub(super) fn has_live_structured_pane_attachment(
        &self,
        target: &PaneAttachmentIdentity,
    ) -> Result<bool, String> {
        let entries = self
            .structured_terminals
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
        Ok(entries.values().any(|entry| {
            entry.attached().is_some_and(|task| {
                !task.stop.load(Ordering::Acquire)
                    && task.webview.is_live()
                    && target.matches_pane_attachment(&task.pane_attachment)
            })
        }))
    }
}

fn detach_uncommitted_surface(
    reservation: &StructuredTerminalReservation,
    surface: TerminalSurfaceAttachment,
    error: String,
) -> String {
    match surface.detach_confirmed(STRUCTURED_TERMINAL_DETACH_TIMEOUT) {
        Ok(()) => error,
        Err(cleanup_error) => {
            let cleanup = format!("{}: {cleanup_error}", cleanup_error.code());
            reservation.fail_cleanup(cleanup.clone());
            format!("{error}; hmux_structured_uncommitted_detach_unconfirmed: {cleanup}")
        }
    }
}

fn encode_json(record: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec(record)
        .map_err(|error| format!("encode structured terminal record failed: {error}"))
}

fn encode_control_pull_record(body: &FrameBody) -> Result<StructuredTerminalPullRecord, String> {
    Ok(StructuredTerminalPullRecord {
        encoded: encode_json(&project_control_record(body)?)?,
        terminal: matches!(body, FrameBody::Exit(_) | FrameBody::Error(_)),
    })
}

fn observe_structured_provider_conversation_identity(
    generation: Option<&StructuredTerminalGenerationProof>,
    identity: &hmux_client::ProviderConversationIdentityDescriptor,
) {
    let Some(generation) = generation.and_then(StructuredTerminalGenerationProof::live_session)
    else {
        return;
    };
    if let Err(error) =
        crate::session_credentials::observe_managed_provider_conversation_identity(
            generation, identity,
        )
    {
        // Attribution is observational. Storage or stale-generation evidence
        // must never prevent the terminal surface from attaching or replaying.
        eprintln!("credential session binding observation failed: {error}");
    }
}

fn encode_closed_pull_record(
    code: &str,
    message: String,
    retry_directive: RetryDirective,
) -> StructuredTerminalPullRecord {
    StructuredTerminalPullRecord {
        encoded: encode_closed_record(code, message, retry_directive),
        terminal: true,
    }
}

fn retire_structured_terminal_authority_in(
    registry: &Mutex<HashMap<StructuredTerminalSlot, StructuredTerminalEntry>>,
    slot: &StructuredTerminalSlot,
    observer_id: &str,
    pull: &StructuredTerminalPull,
) -> Result<(), String> {
    let retired = {
        let mut entries = registry
            .lock()
            .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
        let owns_slot = entries.get(slot).is_some_and(|entry| {
            entry.attached().is_some_and(|task| {
                exact_pull_authority(entry.observer_id(), &task.pull, observer_id, pull)
            })
        });
        owns_slot.then(|| entries.remove(slot)).flatten()
    };
    if let Some(retired) = retired {
        retired.retire();
    }
    Ok(())
}

fn retire_failed_structured_terminal_authority(
    registry: &Weak<Mutex<HashMap<StructuredTerminalSlot, StructuredTerminalEntry>>>,
    slot: &StructuredTerminalSlot,
    observer_id: &str,
    pull: &StructuredTerminalPull,
) {
    let Some(registry) = registry.upgrade() else {
        return;
    };
    let _ = retire_structured_terminal_authority_in(
        registry.as_ref(),
        slot,
        observer_id,
        pull,
    );
}

fn exact_pull_authority(
    current_observer_id: &str,
    current: &StructuredTerminalPull,
    expected_observer_id: &str,
    expected: &StructuredTerminalPull,
) -> bool {
    current_observer_id == expected_observer_id && current.same_authority(expected)
}

fn encode_closed_record(code: &str, message: String, retry_directive: RetryDirective) -> Vec<u8> {
    serde_json::to_vec(&AdapterRecord::Closed {
        code,
        message,
        retry_directive,
    })
    .unwrap_or_else(|_| {
        br#"{"kind":"closed","code":"hmux_adapter_encoding_failed","retryDirective":"never"}"#
            .to_vec()
    })
}

#[cfg(test)]
mod tests {
    mod observation;

    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    use super::*;
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, SessionClass,
        SessionLifecycle, VersionRange,
    };
    use hmux_host::local_protocol::{
        AgentIdentityProjection, AgentIdentitySource, AgentProvider, AgentRuntimeActivity,
        AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateProjection,
        AgentRuntimeStateSource, Exit, ProviderConversationIdentityProjection,
        ProviderConversationIdentitySource, SessionFence,
    };
    use hmux_ssh_transport::{HostKeyPolicy, SshAuthentication, SshEndpoint};

    fn agent_runtime_state_projection(revision: u64) -> AgentRuntimeStateProjection {
        AgentRuntimeStateProjection {
            terminal_epoch: "terminal-1".into(),
            revision,
            observed_through_output_seq: 11,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 3,
        }
    }

    fn agent_identity_projection(agent: Option<AgentProvider>) -> AgentIdentityProjection {
        AgentIdentityProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 11,
            agent,
            source: AgentIdentitySource::ProcessInspection,
        }
    }

    fn expected_agent_runtime_state(revision: u64) -> serde_json::Value {
        serde_json::json!({
            "terminalEpoch": "terminal-1",
            "revision": revision.to_string(),
            "observedThroughOutputSeq": "11",
            "lifecycle": "running",
            "activity": "working",
            "attention": "none",
            "attentionId": null,
            "source": "provider_event",
            "turnCompletedCount": "3",
        })
    }

    fn provider_conversation_identity_projection() -> ProviderConversationIdentityProjection {
        ProviderConversationIdentityProjection {
            fence: SessionFence {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 7,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-1".into(),
            },
            revision: 9,
            observed_through_output_seq: 11,
            provider_id: "codex".into(),
            conversation_id: "conversation-1".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        }
    }

    fn expected_provider_conversation_identity() -> serde_json::Value {
        serde_json::json!({
            "sessionId": "session-1",
            "workspaceId": "workspace-1",
            "runnerPrincipal": "runner",
            "runnerInstance": "runner-1",
            "channelEpoch": "7",
            "hostInstanceId": "host-1",
            "terminalEpoch": "terminal-1",
            "revision": "9",
            "observedThroughOutputSeq": "11",
            "providerId": "codex",
            "conversationId": "conversation-1",
            "source": "provider_event",
        })
    }

    fn session(host_instance_id: &str) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "session-1".into(),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Managed,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "fixture".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: None,
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: host_instance_id.into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "1".into(),
            host_build_version: "test-build".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["terminal_state_binary_v1".into()],
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "host".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 2,
                start_marker: "provider".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/tmp/session.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn live_structured_connection_proves_only_its_exact_host_generation() {
        let current = session("host-current");
        let replacement = session("host-replacement");
        let proof = StructuredTerminalGenerationProof::new(current.clone());

        assert!(proof.is_live_for(&current));
        assert!(!proof.is_live_for(&replacement));
        proof.retire();
        assert!(!proof.is_live_for(&current));
    }

    #[test]
    fn live_provider_conversation_identity_is_a_typed_adapter_record() {
        let body = FrameBody::ProviderConversationIdentity(
            provider_conversation_identity_projection(),
        );

        let serialized = serde_json::to_value(
            project_control_record(&body).expect("adapter record should project"),
        )
            .expect("adapter record should serialize");

        assert_eq!(
            serialized,
            serde_json::json!({
                "kind": "provider_conversation_identity",
                "identity": expected_provider_conversation_identity(),
            })
        );
    }

    #[test]
    fn live_agent_and_shell_identity_are_typed_adapter_records() {
        for (agent, expected) in [
            (Some(AgentProvider::Codex), serde_json::json!("codex")),
            (None, serde_json::Value::Null),
        ] {
            let body = FrameBody::AgentIdentity(agent_identity_projection(agent));
            let serialized = serde_json::to_value(
                project_control_record(&body).expect("adapter record should project"),
            )
                .expect("adapter record should serialize");

            assert_eq!(
                serialized,
                serde_json::json!({
                    "kind": "agent_identity",
                    "identity": {
                        "terminalEpoch": "terminal-1",
                        "observedThroughOutputSeq": "11",
                        "agent": expected,
                        "source": "process_inspection",
                    },
                })
            );
        }
    }

    #[test]
    fn live_agent_runtime_state_is_a_typed_adapter_record() {
        let body = FrameBody::AgentRuntimeState(agent_runtime_state_projection(7));

        let serialized = serde_json::to_value(
            project_control_record(&body).expect("adapter record should project"),
        )
            .expect("adapter record should serialize");

        assert_eq!(
            serialized,
            serde_json::json!({
                "kind": "agent_runtime_state",
                "state": expected_agent_runtime_state(7),
            })
        );
    }

    #[test]
    fn initial_projection_data_is_not_duplicated_in_the_attach_receipt() {
        let receipt = StructuredTerminalAttachReceipt {
            terminal_epoch: "terminal-1".into(),
            through_output_seq: "11".into(),
            state_revision: "12".into(),
            initial_delivery_record_count: 3,
            selected_capabilities: vec!["terminal_state_binary_v1".into()],
            backend_command_us: None,
            session: None,
        };

        let serialized = serde_json::to_value(receipt).expect("attach receipt should serialize");

        assert!(serialized.get("agentRuntimeState").is_none());
        assert!(serialized.get("providerConversationIdentity").is_none());
        assert!(serialized.get("backendCommandUs").is_none());
        assert_eq!(serialized["initialDeliveryRecordCount"], 3);
    }

    #[test]
    fn attach_receipt_serializes_the_adapter_command_duration() {
        let receipt = StructuredTerminalAttachReceipt {
            terminal_epoch: "terminal-1".into(),
            through_output_seq: "11".into(),
            state_revision: "12".into(),
            initial_delivery_record_count: 0,
            selected_capabilities: Vec::new(),
            backend_command_us: Some(42_000),
            session: None,
        };

        let serialized = serde_json::to_value(receipt).expect("attach receipt should serialize");

        assert_eq!(serialized["backendCommandUs"], 42_000);
    }

    #[test]
    fn remote_host_attach_refusal_preserves_its_retry_authority_for_the_webview() {
        let failure = StructuredTerminalAttachFailure::from(AttachError::Session(
            ClientError::HostRefused {
                code: hmux_client::HostErrorCode::TransportClosed,
                message: "structured terminal projection is inconsistent".into(),
                retry: RetryDirective::Reconnect,
            },
        ));

        let serialized =
            serde_json::to_value(failure).expect("attach failure should serialize");

        assert_eq!(
            serialized,
            serde_json::json!({
                "code": "hmux_transport_closed",
                "message": "Hmux Host refused attach (TransportClosed): structured terminal projection is inconsistent",
                "retryDirective": "reconnect",
            })
        );
    }

    #[test]
    fn remote_attach_projects_ssh_failure_code_and_retry_authority() {
        let manager = HmuxManager::default();
        let webview = manager
            .capture_observer_webview("window-remote-attach", "webview-remote-attach")
            .unwrap();
        let reservation = manager
            .reserve_structured_terminal(
                "observer-remote-attach".into(),
                "pane-remote-attach".into(),
                webview,
            )
            .unwrap();
        let mut ssh = SshExecConfig::new(
            SshEndpoint {
                host: "127.0.0.1".into(),
                port: 0,
            },
            "tester",
            SshAuthentication::Password("unused".into()),
            HostKeyPolicy::pinned(["SHA256:unused".into()]),
        );
        ssh.connect_timeout = Duration::from_millis(100);

        let failure = manager
            .attach_remote_structured_terminal(
                reservation,
                SessionFence {
                    workspace_id: "workspace-1".into(),
                    session_id: "session-1".into(),
                    runner_principal: "runner".into(),
                    runner_instance: "runner-1".into(),
                    channel_epoch: 1,
                    host_instance_id: "host-1".into(),
                    terminal_epoch: "terminal-1".into(),
                },
                ssh,
                TerminalSurfaceAccess::Writer,
                || Ok(()),
            )
            .unwrap_err();
        let serialized =
            serde_json::to_value(failure).expect("remote attach failure should serialize");

        assert_eq!(serialized["code"], "hmux_ssh_unreachable");
        assert_eq!(serialized["retryDirective"], "never");
        assert!(
            serialized["message"]
                .as_str()
                .is_some_and(|message| message.contains("could not reach 127.0.0.1:0 over SSH"))
        );
    }

    #[test]
    fn legacy_viewport_seed_eof_preserves_its_retry_authority_for_the_webview() {
        let failure = StructuredTerminalAttachFailure::client(
            ClientError::TerminalViewportAttachTransportClosed,
        );

        let serialized =
            serde_json::to_value(failure).expect("attach failure should serialize");

        assert_eq!(
            serialized,
            serde_json::json!({
                "code": "hmux_transport_closed",
                "message": "Hmux Host sent closed transport while client expected terminal_viewport_frame",
                "retryDirective": "reconnect",
            })
        );
    }

    /// A mid-stream close must carry the posture too, not only the attach
    /// refusal. Without the explicit serde rename this field ships as
    /// `retry_directive` and the frontend silently never sees it.
    #[test]
    fn closed_record_projects_the_retry_posture_the_client_owns() {
        let host_retired = ClientError::HostRefused {
            code: hmux_client::HostErrorCode::ResourceLimit,
            message: "Hmux subscriber output backlog requires snapshot recovery".into(),
            retry: RetryDirective::Reconnect,
        };
        let encoded = encode_closed_record(
            host_retired.code(),
            host_retired.to_string(),
            host_retired.retry_directive(),
        );

        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&encoded).expect("closed record JSON"),
            serde_json::json!({
                "kind": "closed",
                "code": "hmux_resource_limit",
                "message": "Hmux Host refused attach (ResourceLimit): Hmux subscriber output backlog requires snapshot recovery",
                "retryDirective": "reconnect",
            })
        );
    }

    /// An ordinary peer close is reconnectable, and says so itself rather than
    /// leaving a consumer to infer it from the code string.
    #[test]
    fn ordinary_peer_close_reports_a_reconnectable_posture() {
        let closed = ClientError::Transport {
            code: "hmux_transport_closed",
            message: "Hmux transport closed".into(),
        };

        assert_eq!(closed.retry_directive(), RetryDirective::Reconnect);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&encode_closed_record(
                closed.code(),
                closed.to_string(),
                closed.retry_directive(),
            ))
            .expect("closed record JSON")["retryDirective"],
            "reconnect"
        );
    }

    #[test]
    fn blocked_or_retired_webview_cannot_open_a_second_pull() {
        let active = AtomicBool::new(false);
        let retired = AtomicBool::new(false);
        let first = enter_pull(&active, &retired).expect("first pull should be admitted");

        assert_eq!(
            enter_pull(&active, &retired).unwrap_err().into_message(),
            "hmux_structured_pull_concurrent: one record request is already active"
        );
        retired.store(true, Ordering::Release);
        drop(first);
        assert_eq!(
            enter_pull(&active, &retired).unwrap_err().into_message(),
            "hmux_structured_pull_retired: attachment is retired"
        );
    }

    fn empty_pull_authority() -> StructuredTerminalPull {
        empty_pull_authority_with_stop(Arc::new(AtomicBool::new(false)))
    }

    fn empty_pull_authority_with_stop(stop: Arc<AtomicBool>) -> StructuredTerminalPull {
        StructuredTerminalPull {
            state: Arc::new(Mutex::new(StructuredTerminalPullState {
                initial_records: VecDeque::new(),
                surface: None,
            })),
            admission: Arc::new(AtomicBool::new(false)),
            stop,
            ended: Arc::new(AtomicBool::new(false)),
            conversation_generation: None,
        }
    }

    struct SinkWriter;

    impl upstream_actor::UpstreamWriter for SinkWriter {
        fn send(&self, _encoded: &[u8]) -> Result<(), String> {
            Ok(())
        }
    }

    struct FailingWriter {
        attempted: std_mpsc::Sender<()>,
    }

    impl upstream_actor::UpstreamWriter for FailingWriter {
        fn send(&self, _encoded: &[u8]) -> Result<(), String> {
            self.attempted.send(()).unwrap();
            Err("fixture write failed".to_string())
        }
    }

    struct BlockingWriter {
        entered: std_mpsc::Sender<()>,
        release: Mutex<std_mpsc::Receiver<()>>,
    }

    impl upstream_actor::UpstreamWriter for BlockingWriter {
        fn send(&self, _encoded: &[u8]) -> Result<(), String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(())
        }
    }

    struct InstalledTestAttachment {
        slot: StructuredTerminalSlot,
        observer_id: String,
        webview: ObserverWebviewBinding,
        pull: StructuredTerminalPull,
        stop: Arc<AtomicBool>,
        proof: StructuredTerminalGenerationProof,
        interrupted: Arc<AtomicBool>,
    }

    fn install_test_attachment<F>(
        manager: &HmuxManager,
        observer_id: &str,
        surface_id: &str,
        stop: Arc<AtomicBool>,
        build_upstream: F,
    ) -> InstalledTestAttachment
    where
        F: FnOnce(&StructuredTerminalSlot, &StructuredTerminalPull) -> StructuredTerminalUpstream,
    {
        let webview = manager
            .capture_observer_webview(
                &format!("window-{surface_id}"),
                &format!("webview-{surface_id}"),
            )
            .unwrap();
        let slot = StructuredTerminalSlot::new(&webview, surface_id.to_string());
        let pull = empty_pull_authority_with_stop(Arc::clone(&stop));
        let proof = StructuredTerminalGenerationProof::new(session("host-current"));
        let interrupted = Arc::new(AtomicBool::new(false));
        let upstream = build_upstream(&slot, &pull);
        let task = StructuredTerminalTask {
            observer_id: observer_id.to_string(),
            pane_attachment: PaneAttachmentIdentity::new(surface_id, "session-1", "workspace-1"),
            stop: Arc::clone(&stop),
            interrupt: StructuredTerminalInterrupt::Probe(Arc::clone(&interrupted)),
            generation_proof: Some(proof.clone()),
            webview: webview.clone(),
            departure: None,
            upstream,
            pull: pull.clone(),
        };
        assert!(manager
            .structured_terminals
            .lock()
            .unwrap()
            .insert(
                slot.clone(),
                StructuredTerminalEntry::Attached(Box::new(task)),
            )
            .is_none());
        InstalledTestAttachment {
            slot,
            observer_id: observer_id.to_string(),
            webview,
            pull,
            stop,
            proof,
            interrupted,
        }
    }

    #[test]
    fn structured_terminal_is_exact_native_pane_attachment_evidence() {
        let manager = HmuxManager::default();
        let owner_id = "window:main:desktop:desk-1:pane:agent:agent-1";
        let installed = install_test_attachment(
            &manager,
            "observer-pane-status",
            owner_id,
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );

        let status = manager
            .pane_attachment_status(
                owner_id.to_string(),
                "session-1".to_string(),
                "workspace-1".to_string(),
            )
            .unwrap();

        assert_eq!(status.state, "attached");
        assert!(status.observer_attached);
        assert!(!status.controller_attached);

        for (candidate_owner, candidate_session, candidate_workspace) in [
            (
                "window:main:desktop:desk-2:pane:agent:agent-1",
                "session-1",
                "workspace-1",
            ),
            (owner_id, "session-2", "workspace-1"),
            (owner_id, "session-1", "workspace-2"),
        ] {
            let mismatched = manager
                .pane_attachment_status(
                    candidate_owner.to_string(),
                    candidate_session.to_string(),
                    candidate_workspace.to_string(),
                )
                .unwrap();
            assert_eq!(mismatched.state, "detached");
        }

        installed.stop.store(true, Ordering::Release);
        let retired = manager
            .pane_attachment_status(
                owner_id.to_string(),
                "session-1".to_string(),
                "workspace-1".to_string(),
            )
            .unwrap();
        assert_eq!(retired.state, "detached");
    }

    #[test]
    fn structured_terminal_alone_authorizes_explicit_pane_departure() {
        let manager = HmuxManager::default();
        let owner_id = "window:main:desktop:desk-1:pane:agent:agent-1";
        let installed = install_test_attachment(
            &manager,
            "observer-pane-departure",
            owner_id,
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );

        let receipt = manager
            .depart_pane_gracefully(
                owner_id.to_string(),
                "session-1".to_string(),
                "workspace-1".to_string(),
            )
            .unwrap();

        assert_ne!(receipt.reason.as_deref(), Some("not_attached"));
        assert!(installed.interrupted.load(Ordering::Acquire));
    }

    #[test]
    fn upstream_writer_failure_retires_its_exact_attachment_without_a_next_pull() {
        let manager = HmuxManager::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (attempted_tx, attempted_rx) = std_mpsc::channel();
        let (failed_tx, failed_rx) = std_mpsc::channel();
        let failed_registry = Arc::downgrade(&manager.structured_terminals);
        let failed_observer_id = "observer-failure".to_string();
        let failed_callback_observer_id = failed_observer_id.clone();
        let installed = install_test_attachment(
            &manager,
            &failed_observer_id,
            "pane-failure",
            stop,
            move |slot, pull| {
                let failed_slot = slot.clone();
                let failed_pull = pull.clone();
                StructuredTerminalUpstream::with_writer(
                    Arc::new(FailingWriter {
                        attempted: attempted_tx,
                    }),
                    Arc::new(move || {
                        retire_failed_structured_terminal_authority(
                            &failed_registry,
                            &failed_slot,
                            &failed_callback_observer_id,
                            &failed_pull,
                        );
                        failed_tx.send(()).unwrap();
                    }),
                    2,
                    2,
                )
            },
        );

        assert_eq!(
            manager
                .structured_terminal_upstream(&installed.observer_id, vec![1])
                .unwrap(),
            "queued"
        );
        attempted_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        failed_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        assert!(manager.structured_terminals.lock().unwrap().is_empty());
        assert!(!installed.proof.live.load(Ordering::Acquire));
        assert!(installed.stop.load(Ordering::Acquire));
        assert!(installed.interrupted.load(Ordering::Acquire));
    }

    #[test]
    fn stopped_pull_retires_exact_authority_but_concurrent_pull_does_not() {
        let manager = HmuxManager::default();
        let stopped = install_test_attachment(
            &manager,
            "observer-stopped",
            "pane-stopped",
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        stopped.stop.store(true, Ordering::Release);

        assert_eq!(
            manager
                .next_structured_terminal_record(&stopped.observer_id, &stopped.webview)
                .unwrap_err(),
            "hmux_structured_pull_retired: attachment is retired"
        );
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
        assert!(!stopped.proof.live.load(Ordering::Acquire));

        let concurrent = install_test_attachment(
            &manager,
            "observer-concurrent",
            "pane-concurrent",
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        let lease = concurrent.pull.enter().unwrap();
        assert_eq!(
            manager
                .next_structured_terminal_record(&concurrent.observer_id, &concurrent.webview)
                .unwrap_err(),
            "hmux_structured_pull_concurrent: one record request is already active"
        );
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
        assert!(concurrent.proof.live.load(Ordering::Acquire));
        drop(lease);
        manager
            .detach_structured_terminal(&concurrent.observer_id)
            .unwrap();
    }

    #[test]
    fn upstream_backpressure_and_closed_admission_retire_exact_attachments() {
        let manager = HmuxManager::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let overflow = install_test_attachment(
            &manager,
            "observer-overflow",
            "pane-overflow",
            stop,
            move |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(BlockingWriter {
                        entered: entered_tx,
                        release: Mutex::new(release_rx),
                    }),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        manager
            .structured_terminal_upstream(&overflow.observer_id, vec![1])
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        manager
            .structured_terminal_upstream(&overflow.observer_id, vec![2])
            .unwrap();
        let overflow_error = manager
            .structured_terminal_upstream(&overflow.observer_id, vec![3])
            .unwrap_err();
        release_tx.send(()).unwrap();

        assert!(overflow_error.starts_with("hmux_structured_upstream_backpressure:"));
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
        assert!(!overflow.proof.live.load(Ordering::Acquire));
        assert!(overflow.stop.load(Ordering::Acquire));
        assert!(overflow.interrupted.load(Ordering::Acquire));

        let stop = Arc::new(AtomicBool::new(false));
        let closed = install_test_attachment(
            &manager,
            "observer-closed",
            "pane-closed",
            stop,
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        {
            let entries = manager.structured_terminals.lock().unwrap();
            entries
                .get(&closed.slot)
                .and_then(StructuredTerminalEntry::attached)
                .unwrap()
                .upstream
                .close();
        }
        let closed_error = manager
            .structured_terminal_upstream(&closed.observer_id, vec![1])
            .unwrap_err();

        assert!(closed_error.starts_with("hmux_structured_upstream_closed:"));
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
        assert!(!closed.proof.live.load(Ordering::Acquire));
        assert!(closed.stop.load(Ordering::Acquire));
        assert!(closed.interrupted.load(Ordering::Acquire));
    }

    #[test]
    fn stale_upstream_failure_cannot_retire_a_successor_in_the_same_slot() {
        let manager = HmuxManager::default();
        let old = install_test_attachment(
            &manager,
            "observer-old",
            "pane-shared",
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        let successor = manager
            .reserve_structured_terminal(
                "observer-successor".to_string(),
                "pane-shared".to_string(),
                old.webview.clone(),
            )
            .unwrap();

        manager
            .retire_structured_terminal_authority(&old.slot, &old.observer_id, &old.pull)
            .unwrap();

        let entries = manager.structured_terminals.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.values().next().unwrap().observer_id(), "observer-successor");
        assert!(!successor.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn final_record_is_terminal_and_only_its_exact_pull_authority_can_retire() {
        let current = empty_pull_authority();
        let current_command = current.clone();
        let successor = empty_pull_authority();
        let exit = FrameBody::Exit(Exit {
            final_output_seq: 7,
            exit_code: Some(0),
            platform_status: None,
            reason: "complete".to_string(),
        });

        assert!(encode_control_pull_record(&exit).unwrap().terminal);
        assert!(
            encode_closed_pull_record(
                "hmux_transport_closed",
                "eof".to_string(),
                RetryDirective::Reconnect,
            )
            .terminal
        );
        assert!(exact_pull_authority(
            "observer-current",
            &current,
            "observer-current",
            &current_command,
        ));
        assert!(!exact_pull_authority(
            "observer-current",
            &successor,
            "observer-current",
            &current_command,
        ));
        assert!(!exact_pull_authority(
            "observer-successor",
            &successor,
            "observer-current",
            &current_command,
        ));
    }

    #[test]
    fn repeated_attach_claims_one_stable_surface_slot_and_stale_detach_is_fenced() {
        let manager = HmuxManager::default();
        let webview = manager
            .capture_observer_webview("window-a", "webview-a")
            .unwrap();
        let mut claims = Vec::new();

        for generation in 1..=4 {
            claims.push(
                manager
                    .reserve_structured_terminal(
                        format!("observer-{generation}"),
                        "pane-a".to_string(),
                        webview.clone(),
                    )
                    .unwrap(),
            );
            assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
            for retired in &claims[..claims.len() - 1] {
                assert!(retired.cancelled.load(Ordering::Acquire));
            }
        }

        manager.detach_structured_terminal("observer-1").unwrap();
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
        assert!(!claims[3].cancelled.load(Ordering::Acquire));

        manager.detach_structured_terminal("observer-4").unwrap();
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
        assert!(claims[3].cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn observer_token_cannot_own_two_surface_slots() {
        let manager = HmuxManager::default();
        let webview = manager
            .capture_observer_webview("window-a", "webview-a")
            .unwrap();
        manager
            .reserve_structured_terminal(
                "observer-a".to_string(),
                "pane-a".to_string(),
                webview.clone(),
            )
            .unwrap();

        assert_eq!(
            manager
                .reserve_structured_terminal(
                    "observer-a".to_string(),
                    "pane-b".to_string(),
                    webview,
                )
                .err()
                .expect("duplicate observer token should be rejected"),
            "hmux_structured_observer_conflict: observer id is already attached"
        );
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
    }

    #[test]
    fn reload_successor_waits_for_an_in_flight_surface_attach_transaction() {
        let manager = Arc::new(HmuxManager::default());
        let old_webview = manager
            .capture_observer_webview("window-attach-reload", "webview-attach-1")
            .unwrap();
        let predecessor = manager
            .reserve_structured_terminal(
                "observer-attach-old".to_string(),
                "pane-attach-reload".to_string(),
                old_webview,
            )
            .unwrap();
        let attach_guard = predecessor.begin_attach().unwrap();

        let (_, retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-attach-reload")
        })
        .unwrap();
        assert_eq!(retired, 1);
        let current = manager
            .capture_observer_webview("window-attach-reload", "webview-attach-2")
            .unwrap();
        let successor_manager = Arc::clone(&manager);
        let (reserved_tx, reserved_rx) = std_mpsc::channel();
        std::thread::spawn(move || {
            let result = successor_manager.reserve_structured_terminal(
                "observer-attach-new".to_string(),
                "pane-attach-reload".to_string(),
                current,
            );
            reserved_tx.send(result).unwrap();
        });

        let cancellation_deadline = Instant::now() + Duration::from_secs(1);
        while !predecessor.cancelled.load(Ordering::Acquire)
            && Instant::now() < cancellation_deadline
        {
            std::thread::yield_now();
        }
        assert!(predecessor.cancelled.load(Ordering::Acquire));
        assert!(reserved_rx.recv_timeout(Duration::from_millis(50)).is_err());
        attach_guard.finish();

        let successor = reserved_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("successor should resume after the in-flight attach retires")
            .expect("current WebView generation should reserve its surface");
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
        manager.cancel_structured_terminal_reservation(&successor);
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn abandoned_in_flight_attach_keeps_successor_authority_fail_closed() {
        let manager = HmuxManager::default();
        let webview = manager
            .capture_observer_webview("window-attach-failure", "webview-attach-failure")
            .unwrap();
        let reservation = manager
            .reserve_structured_terminal(
                "observer-attach-failure".to_string(),
                "pane-attach-failure".to_string(),
                webview,
            )
            .unwrap();
        let attach_guard = reservation.begin_attach().unwrap();
        reservation.cancel().unwrap();

        drop(attach_guard);

        let error = reservation
            .cancel_and_wait(Duration::from_secs(1))
            .unwrap_err();
        assert!(error.starts_with("hmux_structured_attach_cleanup_unconfirmed:"));
        manager.cancel_structured_terminal_reservation(&reservation);
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_predecessor_detach_does_not_block_an_unrelated_reload_surface() {
        let manager = Arc::new(HmuxManager::default());
        let old_webview = manager
            .capture_observer_webview("window-detach-failure", "webview-detach-failure-1")
            .unwrap();
        let predecessor = manager
            .reserve_structured_terminal(
                "observer-detach-failure".to_string(),
                "pane-detach-failure".to_string(),
                old_webview,
            )
            .unwrap();
        let attach_guard = predecessor.begin_attach().unwrap();

        let (_, retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-detach-failure")
        })
        .unwrap();
        assert_eq!(retired, 1);
        let current = manager
            .capture_observer_webview("window-detach-failure", "webview-detach-failure-2")
            .unwrap();

        let cancellation_deadline = Instant::now() + Duration::from_secs(1);
        while !predecessor.cancelled.load(Ordering::Acquire)
            && Instant::now() < cancellation_deadline
        {
            std::thread::yield_now();
        }
        assert!(predecessor.cancelled.load(Ordering::Acquire));
        drop(attach_guard);

        let successor_manager = Arc::clone(&manager);
        let (reserved_tx, reserved_rx) = std_mpsc::channel();
        std::thread::spawn(move || {
            let result = successor_manager.reserve_structured_terminal(
                "observer-unrelated".to_string(),
                "pane-unrelated".to_string(),
                current,
            );
            reserved_tx.send(result).unwrap();
        });

        let successor = reserved_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("one failed retired surface must not stall unrelated reload surfaces")
            .expect("the unrelated successor surface should reserve normally");
        manager.cancel_structured_terminal_reservation(&successor);
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn reload_successor_waits_for_predecessor_surface_detach_transaction() {
        let manager = Arc::new(HmuxManager::default());
        let predecessor = install_test_attachment(
            manager.as_ref(),
            "observer-old",
            "pane-reload",
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        let detach_guard = predecessor.pull.state.lock().unwrap();

        let (_, retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-pane-reload")
        })
        .unwrap();
        assert_eq!(retired, 1);
        let successor_webview = manager
            .capture_observer_webview("window-pane-reload", "webview-reload-2")
            .unwrap();
        let successor_manager = Arc::clone(&manager);
        let (reserved_tx, reserved_rx) = std_mpsc::channel();
        std::thread::spawn(move || {
            let result = successor_manager.reserve_structured_terminal(
                "observer-new".to_string(),
                "pane-reload".to_string(),
                successor_webview,
            );
            reserved_tx.send(result).unwrap();
        });

        assert!(reserved_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(detach_guard);

        let successor = reserved_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("successor reservation should resume after predecessor detach")
            .expect("current WebView generation should reserve its surface");
        assert!(predecessor.stop.load(Ordering::Acquire));
        assert!(!predecessor.proof.live.load(Ordering::Acquire));
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
        manager.cancel_structured_terminal_reservation(&successor);
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn repeated_reload_cannot_skip_a_blocked_predecessor_detach() {
        let manager = Arc::new(HmuxManager::default());
        let predecessor = install_test_attachment(
            manager.as_ref(),
            "observer-old",
            "pane-reload-chain",
            Arc::new(AtomicBool::new(false)),
            |_, _| {
                StructuredTerminalUpstream::with_writer(
                    Arc::new(SinkWriter),
                    Arc::new(|| {}),
                    2,
                    2,
                )
            },
        );
        let detach_guard = predecessor.pull.state.lock().unwrap();

        let (_, first_retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-pane-reload-chain")
        })
        .unwrap();
        assert_eq!(first_retired, 1);
        let skipped = manager
            .capture_observer_webview("window-pane-reload-chain", "webview-reload-2")
            .unwrap();
        let (_, second_retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-pane-reload-chain")
        })
        .unwrap();
        assert_eq!(second_retired, 0);
        assert!(!skipped.is_live());
        let current = manager
            .capture_observer_webview("window-pane-reload-chain", "webview-reload-3")
            .unwrap();
        let successor_manager = Arc::clone(&manager);
        let (reserved_tx, reserved_rx) = std_mpsc::channel();
        std::thread::spawn(move || {
            let result = successor_manager.reserve_structured_terminal(
                "observer-current".to_string(),
                "pane-reload-chain".to_string(),
                current,
            );
            reserved_tx.send(result).unwrap();
        });

        assert!(reserved_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(detach_guard);

        let successor = reserved_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("retirement chain should release after the oldest detach")
            .expect("latest WebView generation should reserve after the chain");
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 1);
        manager.cancel_structured_terminal_reservation(&successor);
        assert!(manager.structured_terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn page_retirement_removes_only_that_exact_webview_slots() {
        let manager = HmuxManager::default();
        let webview_a = manager
            .capture_observer_webview("window-a", "webview-a")
            .unwrap();
        let webview_b = manager
            .capture_observer_webview("window-b", "webview-b")
            .unwrap();
        let claim_a = manager
            .reserve_structured_terminal(
                "observer-a".to_string(),
                "pane-shared".to_string(),
                webview_a,
            )
            .unwrap();
        let claim_b = manager
            .reserve_structured_terminal(
                "observer-b".to_string(),
                "pane-shared".to_string(),
                webview_b,
            )
            .unwrap();
        assert_eq!(manager.structured_terminals.lock().unwrap().len(), 2);

        let (_, retired) = tauri::async_runtime::block_on(async {
            manager.begin_observer_webview_load("window-a")
        })
        .unwrap();

        assert_eq!(retired, 1);
        assert!(claim_a.cancelled.load(Ordering::Acquire));
        assert!(!claim_b.cancelled.load(Ordering::Acquire));
        let entries = manager.structured_terminals.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.values().next().unwrap().observer_id(), "observer-b");
    }
}
