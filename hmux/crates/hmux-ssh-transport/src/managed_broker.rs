//! Exact managed-provider creation through an ordinary pinned SSH login.
//!
//! The remote runtime broker is the same private, idempotent authority used by
//! a colocated client. SSH supplies the outer account authority; no capability
//! token, attach grant, or provider credential crosses the transport. The
//! caller still resolves the returned identity through the remote catalog
//! before attaching. The broker-pinned generation fence turns that resolution
//! into a comparison instead of allowing a later generation to be adopted.

use crate::catalog::{finish_answer, read_answer};
use crate::{SshExecConfig, SshExecDialer, SshTransportError, execute_bounded_over_ssh};
use hmux_runtime_contract::{
    MANAGED_CONVERSATION_WRITER_CONFLICT_CODE, MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_CAPABILITY, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    MANAGED_CREATE_CHAIN_STOP_CAPABILITY, MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE,
    MANAGED_CREATE_REQUEST_INVALID_CODE, MANAGED_CREATE_RETIRED_EXACT_CODE,
    MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE, MANAGED_REHOST_BROKER_SUBCOMMAND,
    MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND, MANAGED_STOP_BROKER_SUBCOMMAND,
    MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND, MAX_BROKER_FRAME_BYTES,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ManagedCreateBrokerResponse,
    ManagedCreateChainStopBrokerResponse, ManagedCreateChainStopBrokerResponseV2,
    ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2,
    ManagedCreateFailureDisposition, ManagedCreateReceipt,
    ManagedCreateReconcileAuthorityUnavailable, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedRehostBrokerResponse,
    ManagedRehostReceipt, ManagedRehostReconcileRequest, ManagedRehostRequest,
    ManagedStopBrokerResponse, ManagedStopReceipt, ManagedStopReconcileRequest, ManagedStopRequest,
    write_json_frame,
};
use hmux_session_protocol::transport::FrameWriter;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::fmt;
use std::time::{Duration, Instant};

mod response;

#[derive(Debug)]
pub enum RemoteManagedRehostError {
    Ssh(SshTransportError),
    Request(String),
    OutcomeUnknown(String),
    IntentNotFound(String),
    RuntimeUpdateRequired(String),
    Refused { code: String, message: String },
}

impl RemoteManagedRehostError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_remote_managed_rehost_request_failed",
            Self::OutcomeUnknown(_) => "hmux_remote_managed_rehost_outcome_unknown",
            Self::IntentNotFound(_) => "hmux_remote_managed_rehost_intent_not_found",
            Self::RuntimeUpdateRequired(_) => "hmux_remote_runtime_update_required",
            Self::Refused { code, .. } if code == "hmux_managed_rehost_precondition_refused" => {
                "hmux_remote_managed_rehost_precondition_refused"
            }
            Self::Refused { .. } => "hmux_remote_managed_rehost_refused",
        }
    }
}

impl fmt::Display for RemoteManagedRehostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => write!(
                formatter,
                "could not request remote managed rehost: {detail}"
            ),
            Self::OutcomeUnknown(detail) => write!(
                formatter,
                "the remote managed-rehost request was admitted but its outcome is unknown: {detail}"
            ),
            Self::IntentNotFound(detail) => write!(
                formatter,
                "no durable remote managed-rehost intent exists: {detail}"
            ),
            Self::RuntimeUpdateRequired(detail) => write!(
                formatter,
                "the remote Hmux runtime must be updated before managed rehost: {detail}"
            ),
            Self::Refused { code, message } => write!(
                formatter,
                "the remote managed broker refused rehost ({code}): {message}"
            ),
        }
    }
}

impl std::error::Error for RemoteManagedRehostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

/// Runs one journal-first replacement entirely on the remote account. Retrying
/// the exact operation after an SSH response loss replays the remote runtime's
/// canonical receipt. Once replayed, changed client fences and replacement
/// hints cannot override the journal; they are first-admission checks only.
pub fn rehost_managed_over_ssh(
    mut ssh: SshExecConfig,
    request: ManagedRehostRequest,
    timeout: Duration,
) -> Result<ManagedRehostReceipt, RemoteManagedRehostError> {
    request
        .validate()
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    ssh.command = format!(
        "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_REHOST_BROKER_SUBCOMMAND}"
    );
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    let mut transport = SshExecDialer::open_halves(ssh).map_err(RemoteManagedRehostError::Ssh)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| RemoteManagedRehostError::Request("the timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedRehostError::from)?
        .ok_or_else(|| {
            RemoteManagedRehostError::OutcomeUnknown("the broker returned no receipt".into())
        })?;
    let response: ManagedRehostBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    let receipt = match response {
        ManagedRehostBrokerResponse::Completed(receipt) => *receipt,
        ManagedRehostBrokerResponse::Refused(failure) => {
            return Err(classify_managed_rehost_refusal(
                failure.code,
                failure.message,
            ));
        }
    };
    receipt
        .validate_against(&request)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    Ok(receipt)
}

/// Resumes or replays only an existing remote rehost intent. An absent intent
/// is a definite non-destructive result, allowing callers to run target
/// preflight only for a genuinely new operation.
pub fn reconcile_managed_rehost_over_ssh(
    mut ssh: SshExecConfig,
    request: ManagedRehostReconcileRequest,
    timeout: Duration,
) -> Result<ManagedRehostReceipt, RemoteManagedRehostError> {
    request
        .validate()
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    ssh.command = format!(
        "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND}"
    );
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    let mut transport = SshExecDialer::open_halves(ssh).map_err(RemoteManagedRehostError::Ssh)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| RemoteManagedRehostError::Request("the timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedRehostError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedRehostError::from)?
        .ok_or_else(|| {
            RemoteManagedRehostError::OutcomeUnknown(
                "the reconcile broker returned no receipt".into(),
            )
        })?;
    let response: ManagedRehostBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    let receipt = match response {
        ManagedRehostBrokerResponse::Completed(receipt) => *receipt,
        ManagedRehostBrokerResponse::Refused(failure) => {
            return Err(classify_managed_rehost_refusal(
                failure.code,
                failure.message,
            ));
        }
    };
    receipt
        .validate_against_reconcile(&request)
        .map_err(|error| RemoteManagedRehostError::OutcomeUnknown(error.to_string()))?;
    Ok(receipt)
}

fn classify_managed_rehost_refusal(code: String, message: String) -> RemoteManagedRehostError {
    if code == "hmux_managed_rehost_intent_not_found" {
        RemoteManagedRehostError::IntentNotFound(message)
    } else {
        RemoteManagedRehostError::Refused { code, message }
    }
}

#[derive(Debug)]
pub enum RemoteManagedCreateError {
    Ssh(SshTransportError),
    Request(String),
    OutcomeUnknown(String),
    UnsupportedLifecycleContract { message: String },
    RuntimeUpdateRequired(String),
    Rejected { code: String, message: String },
    Retryable { code: String, message: String },
}

impl RemoteManagedCreateError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_remote_managed_create_request_failed",
            Self::OutcomeUnknown(_) => "hmux_remote_managed_create_outcome_unknown",
            Self::UnsupportedLifecycleContract { .. } => {
                "hmux_remote_managed_lifecycle_contract_unsupported"
            }
            Self::RuntimeUpdateRequired(_) => "hmux_remote_runtime_update_required",
            Self::Rejected { code, .. } if code == MANAGED_CONVERSATION_WRITER_CONFLICT_CODE => {
                MANAGED_CONVERSATION_WRITER_CONFLICT_CODE
            }
            Self::Rejected { code, .. } if code == MANAGED_CREATE_RETIRED_EXACT_CODE => {
                MANAGED_CREATE_RETIRED_EXACT_CODE
            }
            Self::Rejected { code, .. } if code == MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE => {
                MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
            }
            Self::Rejected { code, .. }
                if code == MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE =>
            {
                MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
            }
            Self::Rejected { .. } => "hmux_remote_managed_create_refused",
            Self::Retryable { .. } => "hmux_remote_managed_create_retryable",
        }
    }
}

impl fmt::Display for RemoteManagedCreateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => {
                write!(
                    formatter,
                    "could not request remote managed creation: {detail}"
                )
            }
            Self::OutcomeUnknown(detail) => {
                write!(
                    formatter,
                    "the remote managed-create request was admitted but its outcome is unknown: {detail}"
                )
            }
            Self::UnsupportedLifecycleContract { message } => write!(
                formatter,
                "the remote Hmux runtime cannot guarantee the requested managed-stop lifecycle: {message}"
            ),
            Self::RuntimeUpdateRequired(detail) => write!(
                formatter,
                "the remote Hmux runtime must be updated before managed creation: {detail}"
            ),
            Self::Rejected { code, message } => {
                write!(
                    formatter,
                    "the remote managed broker refused creation ({code}): {message}"
                )
            }
            Self::Retryable { code, message } => write!(
                formatter,
                "the remote managed broker could not complete creation ({code}): {message}"
            ),
        }
    }
}

impl std::error::Error for RemoteManagedCreateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum RemoteManagedCreateReconcileError {
    Ssh(SshTransportError),
    Request(String),
    OutcomeUnknown(String),
    RuntimeUpdateRequired(String),
}

impl RemoteManagedCreateReconcileError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_remote_managed_create_reconcile_request_failed",
            Self::OutcomeUnknown(_) => "hmux_remote_managed_create_reconcile_outcome_unknown",
            Self::RuntimeUpdateRequired(_) => "hmux_remote_runtime_update_required",
        }
    }
}

impl fmt::Display for RemoteManagedCreateReconcileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => write!(
                formatter,
                "could not request remote managed-create reconciliation: {detail}"
            ),
            Self::OutcomeUnknown(detail) => write!(
                formatter,
                "the remote managed-create reconciliation outcome is unknown: {detail}"
            ),
            Self::RuntimeUpdateRequired(detail) => write!(
                formatter,
                "the remote Hmux runtime must be updated before managed-create reconciliation: {detail}"
            ),
        }
    }
}

impl std::error::Error for RemoteManagedCreateReconcileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum RemoteManagedCreateResolution {
    Current(ManagedCreateReceipt),
    /// Exact receipt for the old canonical policy. The caller must normalize
    /// this generation before treating the new request as successful.
    NormalizeExisting(ManagedCreateReceipt),
    Pending,
    AbandonedBeforeCompletion,
    Retired,
    AuthorityUnavailable(hmux_runtime_contract::ManagedCreateReconcileAuthorityUnavailable),
}

#[derive(Debug)]
pub enum RemoteManagedCreateAdvanceResolution {
    Current(ManagedCreateReceipt),
    Advanced(ManagedCreateReceipt),
    Pending,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
}

#[derive(Debug)]
pub enum RemoteManagedCreateResolutionError {
    Create(RemoteManagedCreateError),
    Reconcile(RemoteManagedCreateReconcileError),
    AuthorityInconsistent(String),
}

impl RemoteManagedCreateResolutionError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Create(error) => error.code(),
            Self::Reconcile(error) => error.code(),
            Self::AuthorityInconsistent(_) => {
                "hmux_remote_managed_create_reconcile_authority_inconsistent"
            }
        }
    }
}

impl fmt::Display for RemoteManagedCreateResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Create(error) => error.fmt(formatter),
            Self::Reconcile(error) => error.fmt(formatter),
            Self::AuthorityInconsistent(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RemoteManagedCreateResolutionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Create(error) => Some(error),
            Self::Reconcile(error) => Some(error),
            Self::AuthorityInconsistent(_) => None,
        }
    }
}

/// Reads or safely terminalizes one existing remote managed-create identity.
/// The request carries no provider launch policy, so this endpoint cannot
/// reinterpret an older generation using newer client state.
pub fn reconcile_managed_create_over_ssh(
    mut ssh: SshExecConfig,
    request: ManagedCreateReconcileRequest,
    timeout: Duration,
) -> Result<ManagedCreateReconcileBrokerResponse, RemoteManagedCreateReconcileError> {
    request
        .validate()
        .map_err(|error| RemoteManagedCreateReconcileError::Request(error.to_string()))?;
    ssh.command = format!(
        "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}"
    );
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedCreateReconcileError::Request(error.to_string()))?;
    let mut transport =
        SshExecDialer::open_halves(ssh).map_err(RemoteManagedCreateReconcileError::Ssh)?;
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        RemoteManagedCreateReconcileError::Request("the timeout overflowed".into())
    })?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedCreateReconcileError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedCreateReconcileError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedCreateReconcileError::from)?
        .ok_or_else(|| {
            RemoteManagedCreateReconcileError::OutcomeUnknown(
                "the reconcile broker returned no receipt".into(),
            )
        })?;
    let response: ManagedCreateReconcileBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedCreateReconcileError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedCreateReconcileError::OutcomeUnknown(error.to_string()))?;
    response
        .validate_against(&request)
        .map_err(|error| RemoteManagedCreateReconcileError::OutcomeUnknown(error.to_string()))?;
    Ok(response)
}

/// Executes the same ledger-owned create/reconcile/terminal-advance broker as
/// a local client through a read-only capability probe followed by one
/// authenticated, no-PTY destructive SSH exec. The packet never carries a
/// caller-proposed successor identity.
pub fn create_managed_or_reconcile_and_advance_over_ssh(
    capability_ssh: SshExecConfig,
    mut advance_ssh: SshExecConfig,
    request: ManagedCreateRequest,
    timeout: Duration,
) -> Result<RemoteManagedCreateAdvanceResolution, RemoteManagedCreateError> {
    let advance = ManagedCreateAdvanceRequest::new(request.clone())
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;
    if !same_remote_command_authority(&capability_ssh, &advance_ssh) {
        return Err(RemoteManagedCreateError::Request(
            "capability probe and create advance changed SSH endpoint, user, or host-key authority"
                .into(),
        ));
    }
    require_remote_create_advance_capability(capability_ssh, timeout)?;
    advance_ssh.command = format!(
        "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}"
    );
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &advance)
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;
    let mut transport =
        SshExecDialer::open_halves(advance_ssh).map_err(RemoteManagedCreateError::Ssh)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| RemoteManagedCreateError::Request("the timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedCreateError::from)?
        .ok_or_else(|| {
            RemoteManagedCreateError::OutcomeUnknown(
                "the create-advance broker returned no response".into(),
            )
        })?;
    let response: ManagedCreateAdvanceBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    response
        .validate_against(&advance)
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    match response {
        ManagedCreateAdvanceBrokerResponse::Current(receipt) => {
            Ok(RemoteManagedCreateAdvanceResolution::Current(*receipt))
        }
        ManagedCreateAdvanceBrokerResponse::Advanced(receipt) => {
            Ok(RemoteManagedCreateAdvanceResolution::Advanced(*receipt))
        }
        ManagedCreateAdvanceBrokerResponse::Pending => {
            Ok(RemoteManagedCreateAdvanceResolution::Pending)
        }
        ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(authority) => Ok(
            RemoteManagedCreateAdvanceResolution::AuthorityUnavailable(authority),
        ),
        ManagedCreateAdvanceBrokerResponse::Refused(failure) => {
            let disposition = failure.effective_disposition();
            Err(classify_managed_create_failure(
                disposition,
                failure.code,
                failure.message,
            ))
        }
    }
}

/// Composes remote create with identity-only recovery only for the exact
/// canonical request-digest conflict. The factory supplies a fresh SSH
/// authority for each exec without making authentication secrets cloneable.
pub fn create_managed_or_reconcile_over_ssh<F>(
    mut ssh: F,
    request: ManagedCreateRequest,
    timeout: Duration,
) -> Result<RemoteManagedCreateResolution, RemoteManagedCreateResolutionError>
where
    F: FnMut() -> SshExecConfig,
{
    let idempotency_key = request.idempotency_key().to_string();
    let session_id = request.session_id().to_string();
    let workspace_id = request.workspace_id().to_string();
    let create_ssh = ssh();
    let authority = (
        create_ssh.endpoint.clone(),
        create_ssh.user.clone(),
        create_ssh.host_key.clone(),
    );
    match create_managed_over_ssh(create_ssh, request, timeout) {
        Ok(receipt) => return Ok(RemoteManagedCreateResolution::Current(receipt)),
        Err(error) if error.code() == MANAGED_CREATE_RETIRED_EXACT_CODE => {
            return Ok(RemoteManagedCreateResolution::Retired);
        }
        Err(error) if error.code() == MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE => {}
        Err(error) => return Err(RemoteManagedCreateResolutionError::Create(error)),
    }
    let identity = ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
        .map_err(|error| {
            RemoteManagedCreateResolutionError::Reconcile(
                RemoteManagedCreateReconcileError::Request(error.to_string()),
            )
        })?;
    let reconcile_ssh = ssh();
    if (
        reconcile_ssh.endpoint.clone(),
        reconcile_ssh.user.clone(),
        reconcile_ssh.host_key.clone(),
    ) != authority
    {
        return Err(RemoteManagedCreateResolutionError::AuthorityInconsistent(
            "remote managed create reconciliation changed SSH endpoint, user, or host-key authority"
                .into(),
        ));
    }
    let response = reconcile_managed_create_over_ssh(reconcile_ssh, identity, timeout)
        .map_err(RemoteManagedCreateResolutionError::Reconcile)?;
    project_remote_managed_create_resolution(response)
}

fn project_remote_managed_create_resolution(
    response: ManagedCreateReconcileBrokerResponse,
) -> Result<RemoteManagedCreateResolution, RemoteManagedCreateResolutionError> {
    match response {
        ManagedCreateReconcileBrokerResponse::NotFound => Err(
            RemoteManagedCreateResolutionError::AuthorityInconsistent(
                "remote managed create ledger disappeared after a canonical request-digest conflict"
                    .into(),
            ),
        ),
        ManagedCreateReconcileBrokerResponse::Completed(receipt)
            if receipt.generation_fence().is_none() =>
        {
            Err(RemoteManagedCreateResolutionError::AuthorityInconsistent(
                "remote prior managed generation has no exact normalization fence".into(),
            ))
        }
        ManagedCreateReconcileBrokerResponse::Completed(receipt) => Ok(
            RemoteManagedCreateResolution::NormalizeExisting(*receipt),
        ),
        ManagedCreateReconcileBrokerResponse::Pending => {
            Ok(RemoteManagedCreateResolution::Pending)
        }
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion => {
            Ok(RemoteManagedCreateResolution::AbandonedBeforeCompletion)
        }
        ManagedCreateReconcileBrokerResponse::Retired => {
            Ok(RemoteManagedCreateResolution::Retired)
        }
        ManagedCreateReconcileBrokerResponse::AuthorityUnavailable(authority) => {
            Ok(RemoteManagedCreateResolution::AuthorityUnavailable(authority))
        }
    }
}

/// Creates or reuses one exact managed provider on the remote account.
///
/// A forced-command observer key cannot run the private broker and therefore
/// fails before state changes. Ordinary saved hosts use their pinned key and
/// the remote account's existing provider authentication.
pub fn create_managed_over_ssh(
    mut ssh: SshExecConfig,
    request: ManagedCreateRequest,
    timeout: Duration,
) -> Result<ManagedCreateReceipt, RemoteManagedCreateError> {
    request
        .validate()
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;
    let expected_idempotency_key = request.idempotency_key().to_string();
    let expected_session_id = request.session_id().to_string();
    let expected_workspace_id = request.workspace_id().to_string();
    let expected_provider_id = request.provider_id().to_string();
    let expected_permission_mode = request.permission_mode();
    let requires_stop_lifecycle_contract = request.requires_managed_stop_lifecycle_contract();

    ssh.command = format!(
        "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_BROKER_SUBCOMMAND}"
    );
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;

    let mut transport = SshExecDialer::open_halves(ssh).map_err(RemoteManagedCreateError::Ssh)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| RemoteManagedCreateError::Request("the timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedCreateError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedCreateError::from)?
        .ok_or_else(|| {
            RemoteManagedCreateError::OutcomeUnknown("the broker returned no receipt".into())
        })?;
    let response: ManagedCreateBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;

    let receipt = match response {
        ManagedCreateBrokerResponse::Completed(receipt) => *receipt,
        ManagedCreateBrokerResponse::Refused(failure) => {
            let disposition = failure.effective_disposition();
            return Err(classify_managed_create_failure(
                disposition,
                failure.code,
                failure.message,
            ));
        }
    };
    receipt
        .validate()
        .map_err(|error| RemoteManagedCreateError::OutcomeUnknown(error.to_string()))?;
    if receipt.idempotency_key() != expected_idempotency_key
        || receipt.session_id() != expected_session_id
        || receipt.workspace_id() != expected_workspace_id
        || receipt.provider_id() != expected_provider_id
        || receipt.permission_mode() != expected_permission_mode
    {
        return Err(RemoteManagedCreateError::OutcomeUnknown(
            "the receipt did not match the exact request".into(),
        ));
    }
    if requires_stop_lifecycle_contract && receipt.generation_fence().is_none() {
        return Err(RemoteManagedCreateError::OutcomeUnknown(
            "the lifecycle-compatible receipt omitted its generation fence".into(),
        ));
    }
    Ok(receipt)
}

fn classify_managed_create_failure(
    disposition: ManagedCreateFailureDisposition,
    code: String,
    message: String,
) -> RemoteManagedCreateError {
    match disposition {
        ManagedCreateFailureDisposition::Rejected
            if code == MANAGED_CREATE_REQUEST_INVALID_CODE =>
        {
            RemoteManagedCreateError::UnsupportedLifecycleContract { message }
        }
        ManagedCreateFailureDisposition::Rejected => {
            RemoteManagedCreateError::Rejected { code, message }
        }
        ManagedCreateFailureDisposition::Retryable => {
            RemoteManagedCreateError::Retryable { code, message }
        }
    }
}

#[derive(Debug)]
pub enum RemoteManagedCreateChainStopError {
    Ssh(SshTransportError),
    Request(String),
    OutcomeUnknown(String),
    RuntimeUpdateRequired(String),
    NotFound(String),
    Pending(String),
    AuthorityUnavailable { code: String, message: String },
    Refused { code: String, message: String },
}

impl RemoteManagedCreateChainStopError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_remote_managed_create_chain_stop_request_failed",
            Self::OutcomeUnknown(_) => "hmux_remote_managed_create_chain_stop_outcome_unknown",
            Self::RuntimeUpdateRequired(_) => "hmux_remote_runtime_update_required",
            Self::NotFound(_) => "hmux_remote_managed_create_chain_stop_not_found",
            Self::Pending(_) => "hmux_remote_managed_create_chain_stop_pending",
            Self::AuthorityUnavailable { .. } => {
                "hmux_remote_managed_create_chain_stop_authority_unavailable"
            }
            Self::Refused { .. } => "hmux_remote_managed_create_chain_stop_refused",
        }
    }
}

impl fmt::Display for RemoteManagedCreateChainStopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => {
                write!(
                    formatter,
                    "could not request remote managed chain stop: {detail}"
                )
            }
            Self::OutcomeUnknown(detail) => write!(
                formatter,
                "the remote managed chain-stop outcome is unknown: {detail}"
            ),
            Self::RuntimeUpdateRequired(detail) => write!(
                formatter,
                "the remote Hmux runtime must be updated before managed chain stop: {detail}"
            ),
            Self::NotFound(detail) => {
                write!(
                    formatter,
                    "the remote managed create root was not found: {detail}"
                )
            }
            Self::Pending(detail) => {
                write!(
                    formatter,
                    "the remote managed create chain is pending: {detail}"
                )
            }
            Self::AuthorityUnavailable { code, message } => write!(
                formatter,
                "remote managed chain-stop authority is unavailable ({code}): {message}"
            ),
            Self::Refused { code, message } => write!(
                formatter,
                "the remote managed chain-stop broker refused the request ({code}): {message}"
            ),
        }
    }
}

impl std::error::Error for RemoteManagedCreateChainStopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRuntimeBuildInfo {
    schema_version: u16,
    #[serde(default)]
    capabilities: Vec<String>,
}

fn same_remote_command_authority(left: &SshExecConfig, right: &SshExecConfig) -> bool {
    left.endpoint == right.endpoint && left.user == right.user && left.host_key == right.host_key
}

fn require_remote_create_advance_capability(
    mut ssh: SshExecConfig,
    timeout: Duration,
) -> Result<(), RemoteManagedCreateError> {
    ssh.command = "\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".into();
    let output = execute_bounded_over_ssh(ssh, timeout).map_err(RemoteManagedCreateError::Ssh)?;
    if output.exit_status != 0 {
        return Err(RemoteManagedCreateError::RuntimeUpdateRequired(format!(
            "runtime capability probe exited with status {}{}",
            output.exit_status,
            if output.stderr.is_empty() {
                String::new()
            } else {
                format!(": {}", String::from_utf8_lossy(&output.stderr))
            }
        )));
    }
    let build: RemoteRuntimeBuildInfo =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            RemoteManagedCreateError::RuntimeUpdateRequired(format!(
                "runtime build info is incompatible: {error}"
            ))
        })?;
    if build.schema_version != 1
        || !build
            .capabilities
            .iter()
            .any(|advertised| advertised == MANAGED_CREATE_ADVANCE_CAPABILITY)
    {
        return Err(RemoteManagedCreateError::RuntimeUpdateRequired(format!(
            "missing {MANAGED_CREATE_ADVANCE_CAPABILITY}"
        )));
    }
    Ok(())
}

/// Closes and stops one remote managed-create successor chain through two
/// ordinary no-PTY execs: a non-mutating capability probe followed by the
/// single destructive broker call. Missing capability never falls back to an
/// exact-session stop because that would reopen the advance race.
pub fn stop_managed_create_chain_over_ssh(
    capability_ssh: SshExecConfig,
    stop_ssh: SshExecConfig,
    root: ManagedCreateReconcileRequest,
    timeout: Duration,
) -> Result<ManagedCreateChainStopReceipt, RemoteManagedCreateChainStopError> {
    root.validate()
        .map_err(|error| RemoteManagedCreateChainStopError::Request(error.to_string()))?;
    let response: ManagedCreateChainStopBrokerResponse = request_remote_chain_stop_version(
        capability_ssh,
        stop_ssh,
        &root,
        timeout,
        MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
        MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND,
    )?;
    response
        .validate_against(&root)
        .map_err(|error| RemoteManagedCreateChainStopError::OutcomeUnknown(error.to_string()))?;
    match response {
        ManagedCreateChainStopBrokerResponse::Completed(receipt) => Ok(*receipt),
        ManagedCreateChainStopBrokerResponse::NotFound => {
            Err(RemoteManagedCreateChainStopError::NotFound(
                "the durable create ledger has no exact root identity".into(),
            ))
        }
        ManagedCreateChainStopBrokerResponse::Pending => {
            Err(RemoteManagedCreateChainStopError::Pending(
                "the admitted successor tail has not reached a stoppable state".into(),
            ))
        }
        ManagedCreateChainStopBrokerResponse::AuthorityUnavailable(authority) => {
            Err(RemoteManagedCreateChainStopError::AuthorityUnavailable {
                code: authority.code,
                message: authority.message,
            })
        }
        ManagedCreateChainStopBrokerResponse::Refused(failure)
            if failure.code == MANAGED_CREATE_REQUEST_INVALID_CODE =>
        {
            Err(RemoteManagedCreateChainStopError::RuntimeUpdateRequired(
                failure.message,
            ))
        }
        ManagedCreateChainStopBrokerResponse::Refused(failure) => {
            Err(RemoteManagedCreateChainStopError::Refused {
                code: failure.code,
                message: failure.message,
            })
        }
    }
}

/// V2 chain stop requires ordered lineage support. A v1-only remote is
/// rejected by the capability probe before the destructive broker is opened.
pub fn stop_managed_create_chain_v2_over_ssh(
    capability_ssh: SshExecConfig,
    stop_ssh: SshExecConfig,
    root: ManagedCreateReconcileRequest,
    timeout: Duration,
) -> Result<ManagedCreateChainStopReceiptV2, RemoteManagedCreateChainStopError> {
    root.validate()
        .map_err(|error| RemoteManagedCreateChainStopError::Request(error.to_string()))?;
    let response: ManagedCreateChainStopBrokerResponseV2 = request_remote_chain_stop_version(
        capability_ssh,
        stop_ssh,
        &root,
        timeout,
        MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
        MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    )?;
    response
        .validate_against(&root)
        .map_err(|error| RemoteManagedCreateChainStopError::OutcomeUnknown(error.to_string()))?;
    match response {
        ManagedCreateChainStopBrokerResponseV2::Completed(receipt) => Ok(*receipt),
        ManagedCreateChainStopBrokerResponseV2::NotFound => {
            Err(RemoteManagedCreateChainStopError::NotFound(
                "the durable create ledger has no exact root identity".into(),
            ))
        }
        ManagedCreateChainStopBrokerResponseV2::Pending => {
            Err(RemoteManagedCreateChainStopError::Pending(
                "the admitted successor tail has not reached a stoppable state".into(),
            ))
        }
        ManagedCreateChainStopBrokerResponseV2::AuthorityUnavailable(authority) => {
            Err(RemoteManagedCreateChainStopError::AuthorityUnavailable {
                code: authority.code,
                message: authority.message,
            })
        }
        ManagedCreateChainStopBrokerResponseV2::Refused(failure)
            if failure.code == MANAGED_CREATE_REQUEST_INVALID_CODE =>
        {
            Err(RemoteManagedCreateChainStopError::RuntimeUpdateRequired(
                failure.message,
            ))
        }
        ManagedCreateChainStopBrokerResponseV2::Refused(failure) => {
            Err(RemoteManagedCreateChainStopError::Refused {
                code: failure.code,
                message: failure.message,
            })
        }
    }
}

fn request_remote_chain_stop_version<Response: DeserializeOwned>(
    capability_ssh: SshExecConfig,
    stop_ssh: SshExecConfig,
    root: &ManagedCreateReconcileRequest,
    timeout: Duration,
    capability: &str,
    broker_subcommand: &str,
) -> Result<Response, RemoteManagedCreateChainStopError> {
    if !same_remote_command_authority(&capability_ssh, &stop_ssh) {
        return Err(RemoteManagedCreateChainStopError::Request(
            "capability probe and chain stop changed SSH endpoint, user, or host-key authority"
                .into(),
        ));
    }
    require_remote_chain_stop_capability(capability_ssh, timeout, capability)?;

    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, root)
        .map_err(|error| RemoteManagedCreateChainStopError::Request(error.to_string()))?;
    request_remote_chain_stop(stop_ssh, encoded, timeout, broker_subcommand)
}

fn require_remote_chain_stop_capability(
    mut ssh: SshExecConfig,
    timeout: Duration,
    capability: &str,
) -> Result<(), RemoteManagedCreateChainStopError> {
    ssh.command = "\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".into();
    let output =
        execute_bounded_over_ssh(ssh, timeout).map_err(RemoteManagedCreateChainStopError::Ssh)?;
    if output.exit_status != 0 {
        return Err(RemoteManagedCreateChainStopError::RuntimeUpdateRequired(
            format!(
                "runtime capability probe exited with status {}{}",
                output.exit_status,
                if output.stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", String::from_utf8_lossy(&output.stderr))
                }
            ),
        ));
    }
    let build: RemoteRuntimeBuildInfo =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            RemoteManagedCreateChainStopError::RuntimeUpdateRequired(format!(
                "runtime build info is incompatible: {error}"
            ))
        })?;
    if build.schema_version != 1
        || !build
            .capabilities
            .iter()
            .any(|advertised| advertised == capability)
    {
        return Err(RemoteManagedCreateChainStopError::RuntimeUpdateRequired(
            format!("missing {capability}"),
        ));
    }
    Ok(())
}

fn request_remote_chain_stop<Response: DeserializeOwned>(
    mut ssh: SshExecConfig,
    encoded: Vec<u8>,
    timeout: Duration,
    broker_subcommand: &str,
) -> Result<Response, RemoteManagedCreateChainStopError> {
    ssh.command = format!("\"$HOME/.local/bin/hmux-runtime\" --no-autostart {broker_subcommand}");
    let mut transport =
        SshExecDialer::open_halves(ssh).map_err(RemoteManagedCreateChainStopError::Ssh)?;
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        RemoteManagedCreateChainStopError::Request("the timeout overflowed".into())
    })?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedCreateChainStopError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedCreateChainStopError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedCreateChainStopError::from)?
        .ok_or_else(|| {
            RemoteManagedCreateChainStopError::OutcomeUnknown(
                "the chain-stop broker returned no response".into(),
            )
        })?;
    let response = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedCreateChainStopError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedCreateChainStopError::OutcomeUnknown(error.to_string()))?;
    Ok(response)
}

#[derive(Debug)]
pub enum RemoteManagedStopError {
    Ssh(SshTransportError),
    Request(String),
    OutcomeUnknown(String),
    RuntimeUpdateRequired(String),
    IntentNotFound(String),
    Capacity(String),
    Refused { code: String, message: String },
}

impl RemoteManagedStopError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_remote_managed_stop_request_failed",
            Self::OutcomeUnknown(_) => "hmux_remote_managed_stop_outcome_unknown",
            Self::RuntimeUpdateRequired(_) => "hmux_remote_runtime_update_required",
            Self::IntentNotFound(_) => "hmux_remote_managed_stop_intent_not_found",
            Self::Capacity(_) => "hmux_remote_managed_stop_capacity_exceeded",
            Self::Refused { .. } => "hmux_remote_managed_stop_refused",
        }
    }
}

impl fmt::Display for RemoteManagedStopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => {
                write!(formatter, "could not request remote managed stop: {detail}")
            }
            Self::OutcomeUnknown(detail) => write!(
                formatter,
                "the remote managed-stop request was admitted but its outcome is unknown: {detail}"
            ),
            Self::RuntimeUpdateRequired(detail) => write!(
                formatter,
                "the remote Hmux runtime must be updated before managed stop: {detail}"
            ),
            Self::IntentNotFound(detail) => {
                write!(
                    formatter,
                    "no durable remote managed-stop receipt exists: {detail}"
                )
            }
            Self::Capacity(detail) => {
                write!(
                    formatter,
                    "remote managed-stop capacity is exhausted: {detail}"
                )
            }
            Self::Refused { code, message } => write!(
                formatter,
                "the remote managed broker refused stop ({code}): {message}"
            ),
        }
    }
}

impl std::error::Error for RemoteManagedStopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

/// Stops one exact remote managed provider with the complete generation fence
/// already resolved from the remote catalog by the caller.
pub fn stop_managed_over_ssh(
    ssh: SshExecConfig,
    request: ManagedStopRequest,
    timeout: Duration,
) -> Result<ManagedStopReceipt, RemoteManagedStopError> {
    request
        .validate()
        .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
    let expected = CompleteRemoteStopFence::from_request(&request)?;

    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
    let receipt =
        request_managed_stop_broker(ssh, MANAGED_STOP_BROKER_SUBCOMMAND, encoded, timeout)?;
    if !expected.matches_receipt(&receipt) {
        return Err(RemoteManagedStopError::OutcomeUnknown(
            "the receipt did not match the exact request fence".into(),
        ));
    }
    Ok(receipt)
}

/// Reconciles only an already-journaled stop intent. A completed intent returns
/// its exact receipt; a pending intent resumes from its canonical stored
/// request. An absent intent is never created by this endpoint.
pub fn reconcile_managed_stop_over_ssh(
    ssh: SshExecConfig,
    request: ManagedStopReconcileRequest,
    timeout: Duration,
) -> Result<ManagedStopReceipt, RemoteManagedStopError> {
    request
        .validate()
        .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
    let expected = CompleteRemoteStopFence::from_reconcile_request(&request)?;
    let mut encoded = Vec::new();
    write_json_frame(&mut encoded, &request)
        .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
    let receipt = request_managed_stop_broker(
        ssh,
        MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
        encoded,
        timeout,
    )?;
    if !expected.matches_receipt(&receipt) {
        return Err(RemoteManagedStopError::OutcomeUnknown(
            "the replayed receipt did not match the exact operation and generation fence".into(),
        ));
    }
    Ok(receipt)
}

fn request_managed_stop_broker(
    mut ssh: SshExecConfig,
    subcommand: &str,
    encoded: Vec<u8>,
    timeout: Duration,
) -> Result<ManagedStopReceipt, RemoteManagedStopError> {
    ssh.command = format!("\"$HOME/.local/bin/hmux-runtime\" --no-autostart {subcommand}");
    let mut transport = SshExecDialer::open_halves(ssh).map_err(RemoteManagedStopError::Ssh)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| RemoteManagedStopError::Request("the timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| RemoteManagedStopError::OutcomeUnknown(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));

    let payload = read_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(RemoteManagedStopError::from)?
        .ok_or_else(|| {
            RemoteManagedStopError::OutcomeUnknown("the broker returned no receipt".into())
        })?;
    let response: ManagedStopBrokerResponse = serde_json::from_slice(&payload)
        .map_err(|error| RemoteManagedStopError::OutcomeUnknown(error.to_string()))?;
    finish_answer(&mut transport.reader, MAX_BROKER_FRAME_BYTES)
        .map_err(|error| RemoteManagedStopError::OutcomeUnknown(error.to_string()))?;

    let receipt = match response {
        ManagedStopBrokerResponse::Completed(receipt) => receipt,
        ManagedStopBrokerResponse::Refused(failure) => {
            if failure.code == "hmux_managed_stop_outcome_unknown" {
                return Err(RemoteManagedStopError::OutcomeUnknown(failure.message));
            }
            if failure.code == "hmux_managed_stop_intent_not_found" {
                return Err(RemoteManagedStopError::IntentNotFound(failure.message));
            }
            if failure.code == "hmux_managed_stop_capacity_exceeded" {
                return Err(RemoteManagedStopError::Capacity(failure.message));
            }
            return Err(RemoteManagedStopError::Refused {
                code: failure.code,
                message: failure.message,
            });
        }
    };
    receipt
        .validate()
        .map_err(|error| RemoteManagedStopError::OutcomeUnknown(error.to_string()))?;
    Ok(*receipt)
}

#[derive(Debug)]
struct CompleteRemoteStopFence {
    stop_id: String,
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
}

impl CompleteRemoteStopFence {
    fn from_request(request: &ManagedStopRequest) -> Result<Self, RemoteManagedStopError> {
        request
            .validate_complete_fence()
            .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
        let runner_principal = request
            .expected_runner_principal()
            .ok_or_else(|| {
                RemoteManagedStopError::Request("the complete runner fence is required".into())
            })?
            .to_string();
        let runner_instance = request
            .expected_runner_instance()
            .ok_or_else(|| {
                RemoteManagedStopError::Request("the complete runner fence is required".into())
            })?
            .to_string();
        let channel_epoch = request.expected_channel_epoch().ok_or_else(|| {
            RemoteManagedStopError::Request("the complete runner fence is required".into())
        })?;
        let host_instance_id = request
            .expected_host_instance_id()
            .ok_or_else(|| {
                RemoteManagedStopError::Request("the complete Host fence is required".into())
            })?
            .to_string();
        let terminal_epoch = request
            .expected_terminal_epoch()
            .ok_or_else(|| {
                RemoteManagedStopError::Request("the complete terminal fence is required".into())
            })?
            .to_string();
        Ok(Self {
            stop_id: request.stop_id().to_string(),
            session_id: request.session_id().to_string(),
            workspace_id: request.workspace_id().to_string(),
            runner_principal,
            runner_instance,
            channel_epoch,
            host_instance_id,
            terminal_epoch,
        })
    }

    fn from_reconcile_request(
        request: &ManagedStopReconcileRequest,
    ) -> Result<Self, RemoteManagedStopError> {
        request
            .validate()
            .map_err(|error| RemoteManagedStopError::Request(error.to_string()))?;
        Ok(Self {
            stop_id: request.stop_id().to_string(),
            session_id: request.session_id().to_string(),
            workspace_id: request.workspace_id().to_string(),
            runner_principal: request.expected_runner_principal().to_string(),
            runner_instance: request.expected_runner_instance().to_string(),
            channel_epoch: request.expected_channel_epoch(),
            host_instance_id: request.expected_host_instance_id().to_string(),
            terminal_epoch: request.expected_terminal_epoch().to_string(),
        })
    }

    fn matches_receipt(&self, receipt: &ManagedStopReceipt) -> bool {
        receipt.stop_id() == self.stop_id
            && receipt.session_id() == self.session_id
            && receipt.workspace_id() == self.workspace_id
            && receipt.runner_principal() == self.runner_principal
            && receipt.runner_instance() == self.runner_instance
            && receipt.channel_epoch() == self.channel_epoch
            && receipt.host_instance_id() == self.host_instance_id
            && receipt.terminal_epoch() == self.terminal_epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_definitive_rehost_refusals_allow_another_operation() {
        let refused = classify_managed_rehost_refusal(
            "hmux_managed_rehost_precondition_refused".into(),
            "refused before stop".into(),
        );
        assert_eq!(
            refused.code(),
            "hmux_remote_managed_rehost_precondition_refused"
        );
        let unknown = classify_managed_rehost_refusal(
            "hmux_managed_rehost_outcome_unknown".into(),
            "no receipt".into(),
        );
        assert_eq!(unknown.code(), "hmux_remote_managed_rehost_refused");
    }

    #[test]
    fn remote_stop_rejects_a_partial_v2_fence_before_dialing_ssh() {
        let partial = ManagedStopRequest::new("stop-1", "session-1", "workspace-1")
            .unwrap()
            .with_expected_generation("host-1", "terminal-1")
            .unwrap();

        let error = CompleteRemoteStopFence::from_request(&partial).unwrap_err();

        assert_eq!(error.code(), "hmux_remote_managed_stop_request_failed");
        assert!(error.to_string().contains("complete fence"));
    }

    #[test]
    fn legacy_create_schema_refusal_is_an_actionable_lifecycle_error() {
        let error = classify_managed_create_failure(
            ManagedCreateFailureDisposition::Rejected,
            "hmux_managed_request_invalid".into(),
            "managed create request has an unsupported schema".into(),
        );

        assert_eq!(
            error.code(),
            "hmux_remote_managed_lifecycle_contract_unsupported"
        );
        assert!(error.to_string().contains("managed-stop lifecycle"));
    }

    #[test]
    fn remote_legacy_failure_without_disposition_uses_the_shared_admission_classification() {
        let response: ManagedCreateBrokerResponse = serde_json::from_value(serde_json::json!({
            "state": "refused",
            "payload": {
                "code": MANAGED_CREATE_REQUEST_INVALID_CODE,
                "message": "managed create request has an unsupported schema"
            }
        }))
        .unwrap();
        let ManagedCreateBrokerResponse::Refused(failure) = response else {
            panic!("legacy fixture must be a refusal")
        };
        let disposition = failure.effective_disposition();
        let error = classify_managed_create_failure(disposition, failure.code, failure.message);
        assert_eq!(
            error.code(),
            "hmux_remote_managed_lifecycle_contract_unsupported"
        );

        let response: ManagedCreateBrokerResponse = serde_json::from_value(serde_json::json!({
            "state": "refused",
            "payload": {
                "code": "hmux_managed_launch_failed",
                "message": "the launch outcome is unknown"
            }
        }))
        .unwrap();
        let ManagedCreateBrokerResponse::Refused(failure) = response else {
            panic!("legacy fixture must be a refusal")
        };
        let error = classify_managed_create_failure(
            failure.effective_disposition(),
            failure.code,
            failure.message,
        );
        assert!(matches!(error, RemoteManagedCreateError::Retryable { .. }));
    }

    #[test]
    fn exact_conversation_writer_refusal_keeps_its_host_authority_code() {
        let error = classify_managed_create_failure(
            ManagedCreateFailureDisposition::Rejected,
            MANAGED_CONVERSATION_WRITER_CONFLICT_CODE.into(),
            "another managed session owns the exact conversation".into(),
        );

        assert_eq!(error.code(), MANAGED_CONVERSATION_WRITER_CONFLICT_CODE);
    }

    #[test]
    fn remote_prior_completed_without_a_fence_cannot_be_normalized() {
        let receipt = ManagedCreateReceipt::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            hmux_runtime_contract::PermissionMode::Default,
            "/tmp/managed-discovery",
            hmux_runtime_contract::ManagedCreateOutcome::Created,
        )
        .unwrap();

        let error = project_remote_managed_create_resolution(
            ManagedCreateReconcileBrokerResponse::Completed(Box::new(receipt)),
        )
        .unwrap_err();

        assert_eq!(
            error.code(),
            "hmux_remote_managed_create_reconcile_authority_inconsistent"
        );
        assert!(error.to_string().contains("no exact normalization fence"));
    }

    #[test]
    fn exact_retirement_refusal_survives_the_ssh_transport() {
        let error = classify_managed_create_failure(
            ManagedCreateFailureDisposition::Rejected,
            MANAGED_CREATE_RETIRED_EXACT_CODE.into(),
            "the exact generation is retired".into(),
        );

        assert_eq!(error.code(), MANAGED_CREATE_RETIRED_EXACT_CODE);
    }

    #[test]
    fn ambiguous_remote_launch_failure_remains_retryable() {
        let error = classify_managed_create_failure(
            ManagedCreateFailureDisposition::Retryable,
            "hmux_managed_launch_failed".into(),
            "the exact launch outcome must be reconciled".into(),
        );

        assert_eq!(error.code(), "hmux_remote_managed_create_retryable");
        assert!(matches!(error, RemoteManagedCreateError::Retryable { .. }));
    }

    #[test]
    fn remote_stop_accepts_only_a_complete_generation_fence() {
        let complete = ManagedStopRequest::new("stop-1", "session-1", "workspace-1")
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
            .unwrap();

        let expected = CompleteRemoteStopFence::from_request(&complete).unwrap();

        assert_eq!(expected.stop_id, "stop-1");
        assert_eq!(expected.runner_principal, "principal-1");
        assert_eq!(expected.runner_instance, "runner-1");
        assert_eq!(expected.channel_epoch, 7);
        assert_eq!(expected.host_instance_id, "host-1");
        assert_eq!(expected.terminal_epoch, "terminal-1");
    }
}
