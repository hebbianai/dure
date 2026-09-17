#[cfg(feature = "terminal-state-stream")]
use crate::connection::ConnectionRecord;
mod create_chain;
mod host_compatibility;
#[cfg(unix)]
mod processes;

use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::recovery_journal::managed_create_ledger::{
    ManagedSessionRetirementObservation, observe_session_retirement,
};
use crate::runtime_broker::RuntimeBroker;
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, SessionClass, SessionDescriptor,
    SessionLifecycle, SessionSelector,
};
use hmux_host::provider_epoch::process_session_cleanup_is_incomplete;
use hmux_runtime_contract::{
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedStopBrokerResponse, ManagedStopConversationFence, ManagedStopQuiescenceFence,
    ManagedStopReceipt, ManagedStopReconcileRequest, ManagedStopRequest,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_runtime_contract::{
    TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
};
use hmux_session_protocol::{
    FrameBody, MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY, MANAGED_PROVIDER_STOP_CAPABILITY,
    ManagedProviderStop, ManagedProviderStopConversationFence, ManagedProviderStopQuiescenceFence,
    ManagedProviderStopReceiptState, OperationReceiptReason,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
};
use host_compatibility::HostStopConversationAuthority;
use std::fmt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const STOP_POLL_INTERVAL: Duration = Duration::from_millis(25);
const STOP_RECEIPT_TIMEOUT: Duration = Duration::from_secs(3);

pub const MANAGED_STOP_OUTCOME_UNKNOWN_CODE: &str = "hmux_managed_stop_outcome_unknown";
pub const MANAGED_STOP_REFUSED_CODE: &str = "hmux_managed_stop_refused";

impl LocalSessionCatalog {
    /// The permanent owner can identify an accepted stop even when the caller
    /// has lost its generation or operation ID. This is not chain-close authority.
    pub fn read_managed_session_retirement(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<ManagedSessionRetirementObservation, ClientError> {
        let mut observed = None;
        for root in self.managed_stop_reconcile_roots()? {
            let retirement =
                observe_session_retirement(&root, workspace_id, session_id).map_err(|error| {
                    ClientError::transport(MANAGED_STOP_OUTCOME_UNKNOWN_CODE, error)
                })?;
            if retirement == ManagedSessionRetirementObservation::NoLedger {
                continue;
            }
            if observed.replace(retirement).is_some() {
                return Err(ClientError::transport(
                    MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
                    "managed retirement belongs to competing discovery namespaces",
                ));
            }
        }
        Ok(observed.unwrap_or(ManagedSessionRetirementObservation::NoLedger))
    }

    /// Observe completed exact stop evidence without spawning a broker, repairing
    /// discovery, or granting permission to close a logical session.
    pub fn read_completed_managed_stop(
        &self,
        request: &ManagedStopReconcileRequest,
    ) -> Result<Option<ManagedStopReceipt>, ClientError> {
        request.validate().map_err(protocol_error)?;
        let mut completed = None;
        for root in self.managed_stop_reconcile_roots()? {
            let Some(receipt) = crate::recovery_journal::managed_stop::read_completed(
                &root, request,
            )
            .map_err(|error| ClientError::transport(MANAGED_STOP_OUTCOME_UNKNOWN_CODE, error))?
            else {
                continue;
            };
            if completed.replace(receipt).is_some() {
                return Err(ClientError::transport(
                    MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
                    "completed stop belongs to competing discovery namespaces",
                ));
            }
        }
        Ok(completed)
    }
}

#[derive(Clone, Debug)]
pub struct ManagedSessionStopper {
    runtime_executable: PathBuf,
    runtime_working_directory: PathBuf,
    discovery_root: Option<PathBuf>,
}

impl ManagedSessionStopper {
    #[must_use]
    pub fn new(
        runtime_executable: impl Into<PathBuf>,
        runtime_working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            runtime_working_directory: runtime_working_directory.into(),
            discovery_root: None,
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    pub fn stop(&self, request: ManagedStopRequest) -> Result<ManagedStopReceipt, ClientError> {
        request.validate().map_err(protocol_error)?;
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(runtime_error("managed Hmux runtime path is empty"));
        }
        if !self.runtime_working_directory.is_absolute() || !self.runtime_working_directory.is_dir()
        {
            return Err(runtime_error(
                "managed Hmux runtime working directory must be an existing absolute directory",
            ));
        }
        let request = self.require_complete_request_fence(request)?;
        if let Some(receipt) = self.reconcile_stop(&request)? {
            return Ok(receipt);
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_STOP_BROKER_SUBCOMMAND)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedStopBrokerResponse>::spawn(
            &mut command,
            "managed Hmux stop",
            "hmux_managed_runtime_failed",
        )?;
        broker
            .write(&request)
            .map_err(managed_stop_outcome_unknown)?;
        broker.close_input();
        let response = broker
            .read_response()
            .map_err(managed_stop_outcome_unknown)?;
        broker.finish().map_err(managed_stop_outcome_unknown)?;
        let receipt = match response {
            ManagedStopBrokerResponse::Completed(receipt) => receipt,
            ManagedStopBrokerResponse::Refused(failure) => {
                return Err(classify_broker_refusal(failure));
            }
        };
        receipt
            .validate()
            .map_err(|error| managed_stop_outcome_unknown(protocol_error(error)))?;
        if !receipt_matches_request(&receipt, &request) {
            return Err(ClientError::transport(
                MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
                "managed stop receipt does not match the requested identity",
            ));
        }
        Ok(*receipt)
    }

    fn reconcile_stop(
        &self,
        request: &ManagedStopRequest,
    ) -> Result<Option<ManagedStopReceipt>, ClientError> {
        let reconciliation =
            ManagedStopReconcileRequest::from_stop_request(request).map_err(protocol_error)?;
        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedStopBrokerResponse>::spawn(
            &mut command,
            "managed Hmux stop reconcile",
            "hmux_managed_runtime_failed",
        )?;
        broker
            .write(&reconciliation)
            .map_err(managed_stop_outcome_unknown)?;
        broker.close_input();
        let response = broker
            .read_response()
            .map_err(managed_stop_outcome_unknown)?;
        broker.finish().map_err(managed_stop_outcome_unknown)?;
        match response {
            ManagedStopBrokerResponse::Completed(receipt) => {
                receipt
                    .validate()
                    .map_err(|error| managed_stop_outcome_unknown(protocol_error(error)))?;
                if !receipt_matches_request(&receipt, request) {
                    return Err(ClientError::transport(
                        MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
                        "managed stop reconcile receipt changed operation or generation identity",
                    ));
                }
                Ok(Some(*receipt))
            }
            ManagedStopBrokerResponse::Refused(failure)
                if failure.code == "hmux_managed_stop_intent_not_found" =>
            {
                Ok(None)
            }
            ManagedStopBrokerResponse::Refused(failure) => Err(classify_broker_refusal(failure)),
        }
    }

    fn require_complete_request_fence(
        &self,
        request: ManagedStopRequest,
    ) -> Result<ManagedStopRequest, ClientError> {
        request.validate_complete_fence().map_err(protocol_error)?;
        Ok(request)
    }
}

fn classify_broker_refusal(failure: hmux_runtime_contract::ManagedStopFailure) -> ClientError {
    let message = format!("{}: {}", failure.code, failure.message);
    match failure.code.as_str() {
        MANAGED_STOP_OUTCOME_UNKNOWN_CODE => {
            ClientError::transport(MANAGED_STOP_OUTCOME_UNKNOWN_CODE, message)
        }
        "hmux_managed_stop_capacity_exceeded" => {
            ClientError::transport("hmux_managed_stop_capacity_exceeded", message)
        }
        _ => ClientError::managed_stop_refused(None, message),
    }
}

fn receipt_matches_request(receipt: &ManagedStopReceipt, request: &ManagedStopRequest) -> bool {
    receipt.stop_id() == request.stop_id()
        && receipt.session_id() == request.session_id()
        && receipt.workspace_id() == request.workspace_id()
        && request.expected_runner_principal() == Some(receipt.runner_principal())
        && request.expected_runner_instance() == Some(receipt.runner_instance())
        && request.expected_channel_epoch() == Some(receipt.channel_epoch())
        && request.expected_host_instance_id() == Some(receipt.host_instance_id())
        && request.expected_terminal_epoch() == Some(receipt.terminal_epoch())
}

fn managed_stop_outcome_unknown(error: ClientError) -> ClientError {
    ClientError::transport(
        MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
        format!("managed stop broker outcome is unknown: {error}"),
    )
}

impl LocalSession {
    /// Stop this exact managed provider through the Host-owned process handle.
    ///
    /// This low-level entry point requires the adapter-minted proof returned by
    /// the private runtime broker. Product callers should use
    /// [`ManagedSessionStopper`] so the proof never crosses their boundary.
    pub fn stop_managed_with_proof(
        &self,
        catalog: &LocalSessionCatalog,
        authorization_proof_reference: String,
        timeout: Duration,
    ) -> Result<SessionDescriptor, ClientError> {
        self.stop_managed_with_proof_inner(
            catalog,
            authorization_proof_reference,
            timeout,
            None,
            None,
        )
    }

    pub fn stop_managed_quiescent_with_proof(
        &self,
        catalog: &LocalSessionCatalog,
        authorization_proof_reference: String,
        timeout: Duration,
        expected: &ManagedStopQuiescenceFence,
    ) -> Result<SessionDescriptor, ClientError> {
        expected.validate().map_err(protocol_error)?;
        self.stop_managed_with_proof_inner(
            catalog,
            authorization_proof_reference,
            timeout,
            Some(expected),
            None,
        )
    }

    pub fn stop_managed_fenced_with_proof(
        &self,
        catalog: &LocalSessionCatalog,
        authorization_proof_reference: String,
        timeout: Duration,
        expected_conversation: &ManagedStopConversationFence,
        expected_quiescence: Option<&ManagedStopQuiescenceFence>,
    ) -> Result<SessionDescriptor, ClientError> {
        expected_conversation.validate().map_err(protocol_error)?;
        self.stop_managed_with_proof_inner(
            catalog,
            authorization_proof_reference,
            timeout,
            expected_quiescence,
            Some(expected_conversation),
        )
    }

    fn stop_managed_with_proof_inner(
        &self,
        catalog: &LocalSessionCatalog,
        authorization_proof_reference: String,
        timeout: Duration,
        expected_quiescence: Option<&ManagedStopQuiescenceFence>,
        expected_conversation: Option<&ManagedStopConversationFence>,
    ) -> Result<SessionDescriptor, ClientError> {
        let descriptor = self.descriptor();
        if descriptor.session_class != SessionClass::Managed {
            return Err(ClientError::managed_stop_refused(
                None,
                "only managed Hmux sessions can use the managed provider-stop action",
            ));
        }
        let host_mints_scoped_grants = descriptor
            .capabilities
            .iter()
            .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
        if !host_mints_scoped_grants
            && !self.matches_capability_token(&authorization_proof_reference)
        {
            return Err(ClientError::transport(
                "hmux_managed_stop_authorization_denied",
                "legacy managed Hmux provider-stop proof does not match this Host generation",
            ));
        }
        if descriptor.lifecycle == SessionLifecycle::Exited {
            ensure_cleanup_complete(descriptor)?;
            return Ok(descriptor.clone());
        }
        if !descriptor
            .capabilities
            .iter()
            .any(|capability| capability == MANAGED_PROVIDER_STOP_CAPABILITY)
        {
            if expected_quiescence.is_some() || expected_conversation.is_some() {
                return Err(ClientError::MissingCapability {
                    capability: if expected_conversation.is_some() {
                        MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY
                    } else {
                        MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY
                    },
                });
            }
            return self.stop_legacy_managed(catalog, timeout);
        }

        if expected_quiescence.is_some()
            && !descriptor
                .capabilities
                .iter()
                .any(|capability| capability == MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
            });
        }
        let conversation_authority =
            HostStopConversationAuthority::select(&descriptor.capabilities, expected_conversation)?;

        let mut optional_capabilities = vec![
            MANAGED_PROVIDER_STOP_CAPABILITY,
            MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
        ];
        if expected_quiescence.is_some() {
            optional_capabilities.push(MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY);
        }
        if conversation_authority.requests_host_conversation_fence() {
            optional_capabilities.push(MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY);
        }
        if conversation_authority.requests_identity_projection() {
            optional_capabilities.push(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY);
        }
        let options = ConnectionOptions::new(
            LocalAttachRole::Observer,
            Some(authorization_proof_reference),
        )
        .with_optional_capabilities(&optional_capabilities);
        #[cfg(feature = "terminal-state-stream")]
        let options = if descriptor
            .capabilities
            .iter()
            .any(|capability| capability == TERMINAL_STATE_BINARY_CAPABILITY)
            && descriptor
                .capabilities
                .iter()
                .any(|capability| capability == TERMINAL_VIEWPORT_PROJECTION_CAPABILITY)
            && descriptor
                .capabilities
                .iter()
                .any(|capability| capability == TERMINAL_VIEWPORT_MULTIPART_CAPABILITY)
        {
            options
                .with_terminal_viewport_projection()
                .with_terminal_viewport_multipart()
        } else {
            // The client crate's feature set says what it can consume; the
            // discovered Host capabilities decide what this generation can
            // serve. Rolling no-stream Hosts retain the legacy control path.
            options
        };
        let mut connection = self.connect_with_options(options)?;
        if !connection.supports(MANAGED_PROVIDER_STOP_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: MANAGED_PROVIDER_STOP_CAPABILITY,
            });
        }
        if expected_quiescence.is_some()
            && !connection.supports(MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
            });
        }
        conversation_authority
            .validate_selected_capabilities(|capability| connection.supports(capability))?;
        conversation_authority
            .validate_legacy_projection(initial_provider_conversation_identity(&connection))?;
        let request_id = next_stop_request_id();
        connection
            .writer()
            .send(FrameBody::ManagedProviderStop(ManagedProviderStop {
                request_id: request_id.clone(),
                expected_quiescence: expected_quiescence.map(|expected| {
                    ManagedProviderStopQuiescenceFence {
                        terminal_epoch: expected.terminal_epoch().to_string(),
                        runtime_revision: expected.runtime_revision(),
                        observed_through_output_seq: expected.observed_through_output_seq(),
                    }
                }),
                expected_conversation: conversation_authority
                    .requests_host_conversation_fence()
                    .then_some(expected_conversation)
                    .flatten()
                    .map(|expected| ManagedProviderStopConversationFence {
                        provider_id: expected.provider_id().to_string(),
                        conversation_id: expected.conversation_id().map(str::to_owned),
                    }),
            }))?;

        let receipt_started = Instant::now();
        loop {
            let elapsed = receipt_started.elapsed();
            if elapsed >= STOP_RECEIPT_TIMEOUT {
                let error = ClientError::transport(
                    "hmux_managed_stop_receipt_timeout",
                    "Hmux Host did not acknowledge managed provider stop before the deadline",
                );
                connection.shutdown();
                return converge_after_stop_receipt_loss(catalog, descriptor, timeout, error);
            }
            connection.set_read_timeout(Some(STOP_RECEIPT_TIMEOUT.saturating_sub(elapsed)))?;
            #[cfg(feature = "terminal-state-stream")]
            let body = match connection.read_record() {
                Ok(ConnectionRecord::Control(body)) => *body,
                Ok(ConnectionRecord::TerminalState(_)) => continue,
                Err(error) => {
                    connection.shutdown();
                    return converge_after_stop_receipt_loss(catalog, descriptor, timeout, error);
                }
            };
            #[cfg(not(feature = "terminal-state-stream"))]
            let body = match connection.read_body() {
                Ok(body) => body,
                Err(error) => {
                    connection.shutdown();
                    return converge_after_stop_receipt_loss(catalog, descriptor, timeout, error);
                }
            };
            match body {
                FrameBody::ManagedProviderStopReceipt(receipt)
                    if receipt.request_id == request_id =>
                {
                    match receipt.state {
                        ManagedProviderStopReceiptState::Accepted => break,
                        ManagedProviderStopReceiptState::Refused => {
                            return Err(ClientError::managed_stop_refused(
                                receipt.reason,
                                "the exact Hmux Host refused managed provider stop",
                            ));
                        }
                        ManagedProviderStopReceiptState::Failed => {
                            if receipt.reason == Some(OperationReceiptReason::HostExiting) {
                                break;
                            }
                            return Err(ClientError::transport(
                                "hmux_managed_stop_failed",
                                format!(
                                    "the exact Hmux Host could not determine managed provider stop ({:?})",
                                    receipt.reason
                                ),
                            ));
                        }
                    }
                }
                FrameBody::ManagedProviderStopReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_managed_stop_uncorrelated",
                        "Hmux Host returned a managed stop receipt for another request",
                    ));
                }
                FrameBody::OutputDelta(_)
                | FrameBody::ScreenSnapshot(_)
                | FrameBody::AgentRuntimeState(_) => {}
                FrameBody::Exit(_) => break,
                _ => {}
            }
        }
        connection.shutdown();
        wait_for_exited(catalog, descriptor, timeout)
    }

    #[cfg(unix)]
    fn stop_legacy_managed(
        &self,
        catalog: &LocalSessionCatalog,
        timeout: Duration,
    ) -> Result<SessionDescriptor, ClientError> {
        let mut connection =
            self.connect_with_options(ConnectionOptions::new(LocalAttachRole::Observer, None))?;
        let hello = connection.hello_ack();
        let target = self.descriptor();
        let provider_matches = hello.provider_process.as_ref().is_some_and(|provider| {
            provider.process_id == target.provider_process.process_id
                && provider.start_marker == target.provider_process.start_marker
        });
        if hello.host_process.process_id != target.host_process.process_id
            || hello.host_process.start_marker != target.host_process.start_marker
            || !provider_matches
        {
            return Err(ClientError::transport(
                "hmux_managed_stop_unverified",
                "authenticated Host process proofs do not match managed discovery",
            ));
        }
        // Detached, but deliberately kept alive: it owns the colocation
        // witness the terminate below requires, and that witness is what
        // proves the pids about to be signalled belong to this kernel.
        connection.detach("managed_stop_identity_verified")?;

        let current = catalog.open(&SessionSelector::new(
            target.session_id.clone(),
            Some(target.workspace_id.clone()),
        ))?;
        if current.descriptor().host_process != target.host_process
            || current.descriptor().provider_process != target.provider_process
        {
            return Err(ClientError::transport(
                "hmux_managed_stop_unverified",
                "managed process generation changed after authentication",
            ));
        }
        let scope = hmux_local_platform::peer_attestation::SessionScope::new(
            current.descriptor().workspace_id.clone(),
            current.descriptor().session_id.clone(),
            current.descriptor().host_instance_id.clone(),
        );
        let colocation = connection
            .attestation()
            .witness_for(&scope)
            .map_err(|error| {
                ClientError::transport("hmux_managed_stop_unwitnessed", error.to_string())
            })?;
        crate::legacy_terminate::terminate_verified_process_session(
            colocation,
            current.descriptor(),
        )?;
        wait_for_exited(catalog, target, timeout)
    }

    #[cfg(not(unix))]
    fn stop_legacy_managed(
        &self,
        _catalog: &LocalSessionCatalog,
        _timeout: Duration,
    ) -> Result<SessionDescriptor, ClientError> {
        Err(ClientError::MissingCapability {
            capability: MANAGED_PROVIDER_STOP_CAPABILITY,
        })
    }
}

fn initial_provider_conversation_identity(
    connection: &crate::LocalConnection,
) -> Option<(&str, &str)> {
    #[cfg(feature = "terminal-state-stream")]
    let identity = connection
        .initial_terminal_state()
        .and_then(|initial| initial.provider_conversation_identity())
        .or_else(|| {
            connection
                .initial_snapshot()
                .and_then(|snapshot| snapshot.provider_conversation_identity.as_deref())
        });
    #[cfg(not(feature = "terminal-state-stream"))]
    let identity = connection
        .initial_snapshot()
        .and_then(|snapshot| snapshot.provider_conversation_identity.as_deref());
    identity.map(|identity| {
        (
            identity.provider_id.as_str(),
            identity.conversation_id.as_str(),
        )
    })
}

fn wait_for_exited(
    catalog: &LocalSessionCatalog,
    target: &SessionDescriptor,
    timeout: Duration,
) -> Result<SessionDescriptor, ClientError> {
    let selector =
        SessionSelector::new(target.session_id.clone(), Some(target.workspace_id.clone()));
    let started = Instant::now();
    loop {
        let current = catalog.find(&selector)?;
        if current.host_instance_id != target.host_instance_id
            || current.terminal_epoch != target.terminal_epoch
        {
            return Err(ClientError::transport(
                "hmux_managed_stop_identity_changed",
                "managed Hmux identity changed while waiting for provider stop",
            ));
        }
        if current.lifecycle == SessionLifecycle::Exited {
            ensure_cleanup_complete(&current)?;
            return Ok(current);
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(ClientError::transport(
                "hmux_managed_stop_timeout",
                "managed Hmux provider remained ready after Host accepted stop",
            ));
        }
        thread::sleep(STOP_POLL_INTERVAL.min(timeout.saturating_sub(elapsed)));
    }
}

fn converge_after_stop_receipt_loss(
    catalog: &LocalSessionCatalog,
    target: &SessionDescriptor,
    timeout: Duration,
    receipt_error: ClientError,
) -> Result<SessionDescriptor, ClientError> {
    // A post-send transport failure proves nothing by itself. The existing
    // exact-generation Exited tombstone is the only compatible success path.
    match wait_for_exited(catalog, target, timeout) {
        Ok(exited) => Ok(exited),
        Err(_) => Err(receipt_error),
    }
}

fn ensure_cleanup_complete(descriptor: &SessionDescriptor) -> Result<(), ClientError> {
    if descriptor
        .exit
        .as_ref()
        .is_some_and(|exit| process_session_cleanup_is_incomplete(&exit.reason))
    {
        return Err(ClientError::transport(
            "hmux_managed_stop_incomplete",
            "Hmux Host could not prove that every managed provider process group stopped",
        ));
    }
    Ok(())
}

fn next_stop_request_id() -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "managed_stop_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_stop_protocol", error.to_string())
}

fn runtime_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_runtime_failed", error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn write_broker_frame(path: &std::path::Path, response: &ManagedStopBrokerResponse) {
        let payload = serde_json::to_vec(response).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend(payload);
        fs::write(path, frame).unwrap();
    }

    fn exact_request() -> ManagedStopRequest {
        ManagedStopRequest::new("stop-1", "session-1", "workspace-1")
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
            .unwrap()
    }

    #[test]
    fn broker_refusal_preserves_the_typed_definitive_disposition() {
        let state = tempfile::tempdir().unwrap();
        let runtime = state.path().join("refusing-runtime");
        fs::write(
            &runtime,
            format!(
                "#!/bin/sh\ncat >/dev/null\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) exec cat \"$0.reconcile\" ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) exec cat \"$0.stop\" ;;\n  *) exit 64 ;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        write_broker_frame(
            &runtime.with_extension("reconcile"),
            &ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_intent_not_found",
                "no prior stop intent",
            ),
        );
        write_broker_frame(
            &runtime.with_extension("stop"),
            &ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_fence_mismatch",
                "source generation retained",
            ),
        );

        let error = ManagedSessionStopper::new(&runtime, state.path())
            .stop(exact_request())
            .unwrap_err();

        assert!(error.is_definitive_managed_stop_refusal());
    }

    #[test]
    fn reconcile_refusal_preserves_the_typed_definitive_disposition() {
        let state = tempfile::tempdir().unwrap();
        let runtime = state.path().join("refusing-runtime");
        fs::write(
            &runtime,
            format!(
                "#!/bin/sh\ncat >/dev/null\n[ \"$2\" = {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND} ] || exit 97\nexec cat \"$0.reconcile\"\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        write_broker_frame(
            &runtime.with_extension("reconcile"),
            &ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_fence_mismatch",
                "reconciled source generation retained",
            ),
        );

        let error = ManagedSessionStopper::new(&runtime, state.path())
            .stop(exact_request())
            .unwrap_err();

        assert!(error.is_definitive_managed_stop_refusal());
    }

    #[test]
    fn ambiguous_and_capacity_refusals_remain_non_definitive() {
        for (code, expected) in [
            (
                MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
                MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
            ),
            (
                "hmux_managed_stop_capacity_exceeded",
                "hmux_managed_stop_capacity_exceeded",
            ),
        ] {
            let error = classify_broker_refusal(hmux_runtime_contract::ManagedStopFailure {
                code: code.into(),
                message: "not a definitive pre-effect refusal".into(),
            });
            assert_eq!(error.code(), expected);
            assert!(!error.is_definitive_managed_stop_refusal());
        }
    }

    #[test]
    fn post_write_reconcile_failure_is_an_unknown_stop_outcome() {
        let state = tempfile::tempdir().unwrap();
        let runtime = state.path().join("ambiguous-runtime");
        fs::write(&runtime, "#!/bin/sh\ncat >/dev/null\nexit 17\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let request = exact_request();

        let error = ManagedSessionStopper::new(&runtime, state.path())
            .stop(request)
            .unwrap_err();

        assert_eq!(error.code(), MANAGED_STOP_OUTCOME_UNKNOWN_CODE);
    }

    #[test]
    fn legacy_and_partial_stop_requests_fail_before_runtime_execution() {
        let state = tempfile::tempdir().unwrap();
        let legacy = ManagedStopRequest::new("stop-v1", "session-1", "workspace-1").unwrap();
        let partial = ManagedStopRequest::new("stop-v2", "session-1", "workspace-1")
            .unwrap()
            .with_expected_generation("host-1", "terminal-1")
            .unwrap();

        for request in [legacy, partial] {
            let error =
                ManagedSessionStopper::new(state.path().join("missing-runtime"), state.path())
                    .stop(request)
                    .unwrap_err();
            assert_eq!(error.code(), "hmux_managed_stop_protocol");
        }
    }
}
