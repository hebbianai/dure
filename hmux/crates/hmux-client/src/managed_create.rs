use crate::managed_create_reconcile::ManagedSessionCreateReconciler;
use crate::recovery_journal::managed_create_ledger::{self, ManagedCreateSuccessorChainResolution};
use crate::runtime_broker::RuntimeBroker;
use crate::{ClientError, LocalSession, LocalSessionCatalog, SessionClass, SessionSelector};
pub use hmux_runtime_contract::ManagedCreateFailureDisposition;
use hmux_runtime_contract::{
    DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE, MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE, MANAGED_CREATE_REQUEST_INVALID_CODE,
    MANAGED_CREATE_RETIRED_EXACT_CODE, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ManagedCreateBrokerResponse,
    ManagedCreateFailure, ManagedCreateGenerationFence, ManagedCreateReceipt,
    ManagedCreateReconcileAuthorityUnavailable, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedCreateRequest,
};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

mod replacement;
pub use replacement::managed_replacement_root_request;

#[derive(Debug)]
pub struct ManagedCreateError {
    source: ClientError,
    disposition: ManagedCreateFailureDisposition,
}

impl ManagedCreateError {
    fn rejected(source: ClientError) -> Self {
        Self {
            source,
            disposition: ManagedCreateFailureDisposition::Rejected,
        }
    }

    fn retryable(source: ClientError) -> Self {
        Self {
            source,
            disposition: ManagedCreateFailureDisposition::Retryable,
        }
    }

    #[must_use]
    pub fn code(&self) -> &str {
        self.source.code()
    }

    #[must_use]
    pub fn disposition(&self) -> ManagedCreateFailureDisposition {
        self.disposition
    }

    fn into_source(self) -> ClientError {
        self.source
    }
}

impl fmt::Display for ManagedCreateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for ManagedCreateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[derive(Debug)]
pub struct CreatedManagedSession {
    session: LocalSession,
    receipt: ManagedCreateReceipt,
}

impl CreatedManagedSession {
    /// Reopen exactly the recorded generation without launching or following
    /// successors. Shared by runtime reconciliation and application recovery.
    pub fn from_completed_receipt(receipt: ManagedCreateReceipt) -> Result<Self, ClientError> {
        receipt.validate().map_err(protocol_error)?;
        let fence = receipt.generation_fence().ok_or_else(|| {
            protocol_error("reconciled managed create receipt omitted its exact generation fence")
        })?;
        let catalog = LocalSessionCatalog::new(receipt.discovery_root());
        let session = catalog.open(&SessionSelector::new(
            receipt.session_id(),
            Some(receipt.workspace_id().to_string()),
        ))?;
        let descriptor = session.descriptor();
        if descriptor.session_class != SessionClass::Managed
            || descriptor.workspace_id != receipt.workspace_id()
            || descriptor.session_id != receipt.session_id()
            || descriptor.provider_id != receipt.provider_id()
            || session.create_idempotency_key() != Some(receipt.idempotency_key())
        {
            return Err(protocol_error(
                "reconciled managed create receipt does not match its discovery generation",
            ));
        }
        validate_catalog_generation(descriptor, fence)?;
        Ok(Self { session, receipt })
    }

    #[must_use]
    pub fn session(&self) -> &LocalSession {
        &self.session
    }

    #[must_use]
    pub fn receipt(&self) -> &ManagedCreateReceipt {
        &self.receipt
    }
}

/// Result of composing exact create with identity-only ledger recovery.
/// `NormalizeExisting` is a validated old generation, never success for the
/// incoming policy.
#[derive(Debug)]
pub enum ManagedCreateResolution {
    Current(CreatedManagedSession),
    NormalizeExisting(CreatedManagedSession),
    Pending,
    AbandonedBeforeCompletion,
    Retired,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
}

/// Result of the single runtime-owned create/reconcile/terminal-advance
/// composition. No caller-generated identity is accepted by this API.
#[derive(Debug)]
pub enum ManagedCreateAdvanceResolution {
    Current(CreatedManagedSession),
    Advanced(CreatedManagedSession),
    Pending,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
}

/// Validated local projection of one permanent managed-create identity.
///
/// Unlike create composition, this operation cannot launch. Consumers use it
/// for lifecycle recovery and stop paths that no longer hold the canonical
/// create request.
#[derive(Debug)]
pub enum ManagedCreateIdentityResolution {
    NotFound,
    Existing(Box<CreatedManagedSession>),
    Pending,
    AbandonedBeforeCompletion,
    Retired,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
}

/// Read-only resolution through immutable managed-create successor edges.
/// A usable session is returned only after its completed receipt and complete
/// discovery generation fence have both been verified.
#[derive(Debug)]
pub enum ManagedCreateChainResolution {
    NotFound,
    Existing(Box<CreatedManagedSession>),
    Pending,
    TerminalWithoutSuccessor,
}

#[derive(Debug)]
pub enum ManagedCreateResolutionError {
    Create(ManagedCreateError),
    Reconcile(ClientError),
}

impl ManagedCreateResolutionError {
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::Create(error) => error.code(),
            Self::Reconcile(error) => error.code(),
        }
    }
}

impl fmt::Display for ManagedCreateResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Create(error) => error.fmt(formatter),
            Self::Reconcile(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ManagedCreateResolutionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Create(error) => Some(error),
            Self::Reconcile(error) => Some(error),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ManagedSessionCreator {
    runtime_executable: PathBuf,
    discovery_root: Option<PathBuf>,
    broker_timing: bool,
}

impl ManagedSessionCreator {
    #[must_use]
    pub fn new(runtime_executable: impl Into<PathBuf>) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            discovery_root: None,
            broker_timing: false,
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    /// Opt in only this creator's advance calls. The selector is sent to the
    /// broker process, never added to the durable/provider launch request.
    #[must_use]
    pub fn with_broker_timing(mut self) -> Self {
        self.broker_timing = true;
        self
    }

    pub fn create(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<CreatedManagedSession, ClientError> {
        self.create_with_disposition(request)
            .map_err(ManagedCreateError::into_source)
    }

    pub fn create_with_disposition(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<CreatedManagedSession, ManagedCreateError> {
        request
            .validate()
            .map_err(protocol_error)
            .map_err(ManagedCreateError::rejected)?;
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(ManagedCreateError::retryable(ClientError::transport(
                "hmux_managed_runtime_failed",
                "managed Hmux runtime path is empty",
            )));
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_BROKER_SUBCOMMAND);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedCreateBrokerResponse>::spawn(
            &mut command,
            "managed Hmux create",
            "hmux_managed_runtime_failed",
        )
        .map_err(ManagedCreateError::retryable)?;
        broker
            .write(&request)
            .map_err(ManagedCreateError::retryable)?;
        broker.close_input();
        let response = broker
            .read_response()
            .map_err(ManagedCreateError::retryable)?;
        broker.finish().map_err(ManagedCreateError::retryable)?;

        let receipt = match response {
            ManagedCreateBrokerResponse::Completed(receipt) => *receipt,
            ManagedCreateBrokerResponse::Refused(failure) => {
                return Err(classify_managed_create_failure(failure));
            }
        };
        self.open_created_for_request(receipt, &request, true)
    }

    fn open_created_for_request(
        &self,
        receipt: ManagedCreateReceipt,
        request: &ManagedCreateRequest,
        require_current_policy: bool,
    ) -> Result<CreatedManagedSession, ManagedCreateError> {
        receipt
            .validate()
            .map_err(protocol_error)
            .map_err(ManagedCreateError::retryable)?;
        if receipt.idempotency_key() != request.idempotency_key()
            || receipt.session_id() != request.session_id()
            || receipt.workspace_id() != request.workspace_id()
            || receipt.provider_id() != request.provider_id()
            || require_current_policy && receipt.permission_mode() != request.permission_mode()
        {
            return Err(ManagedCreateError::retryable(protocol_error(
                "managed create receipt does not match the requested identity",
            )));
        }
        if request.requires_managed_stop_lifecycle_contract()
            && receipt.generation_fence().is_none()
        {
            return Err(ManagedCreateError::retryable(protocol_error(
                "stop-lifecycle managed create receipt omitted its generation fence",
            )));
        }

        let catalog = LocalSessionCatalog::new(receipt.discovery_root());
        let session = catalog
            .open(&SessionSelector::new(
                receipt.session_id(),
                Some(receipt.workspace_id().to_string()),
            ))
            .map_err(ManagedCreateError::retryable)?;
        let descriptor = session.descriptor();
        if descriptor.session_class != SessionClass::Managed
            || descriptor.workspace_id != receipt.workspace_id()
        {
            return Err(ManagedCreateError::retryable(protocol_error(
                "managed create receipt does not match discovery identity",
            )));
        }
        if let Some(fence) = receipt.generation_fence() {
            validate_catalog_generation(descriptor, fence)
                .map_err(ManagedCreateError::retryable)?;
        }
        if require_current_policy {
            for required in request.required_host_capabilities() {
                if !descriptor
                    .capabilities
                    .iter()
                    .any(|capability| capability == required)
                {
                    return Err(ManagedCreateError::retryable(protocol_error(
                        "managed create Host omitted a required request capability",
                    )));
                }
            }
        }
        Ok(CreatedManagedSession { session, receipt })
    }

    /// Executes one bounded runtime composition. The source request carries no
    /// proposed target identity; a terminal successor can only come back from
    /// the runtime's durable managed-create ledger.
    pub fn create_or_reconcile_and_advance(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<ManagedCreateAdvanceResolution, ManagedCreateError> {
        self.create_or_reconcile_and_advance_with_mode(request, false)
    }

    /// Attempts one deterministic replacement root before consulting source
    /// history, even when the requested launch policy is byte-identical. The
    /// runtime uses the exact source only for fenced cleanup when required; the
    /// caller supplies no target identity and never inspects source liveness.
    pub fn replace_current_and_advance(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<ManagedCreateAdvanceResolution, ManagedCreateError> {
        self.create_or_reconcile_and_advance_with_mode(request, true)
    }

    fn create_or_reconcile_and_advance_with_mode(
        &self,
        request: ManagedCreateRequest,
        replace_current: bool,
    ) -> Result<ManagedCreateAdvanceResolution, ManagedCreateError> {
        let advance = if replace_current {
            ManagedCreateAdvanceRequest::replace_current(request.clone())
        } else {
            ManagedCreateAdvanceRequest::new(request.clone())
        }
        .map_err(protocol_error)
        .map_err(ManagedCreateError::rejected)?;
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(ManagedCreateError::retryable(ClientError::transport(
                "hmux_managed_runtime_failed",
                "managed Hmux runtime path is empty",
            )));
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND);
        if self.broker_timing {
            command.env("HMUX_BROKER_TIMING_REQUEST", request.idempotency_key());
        }
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedCreateAdvanceBrokerResponse>::spawn(
            &mut command,
            "managed Hmux create advance",
            "hmux_managed_runtime_failed",
        )
        .map_err(ManagedCreateError::retryable)?;
        broker
            .write(&advance)
            .map_err(ManagedCreateError::retryable)?;
        broker.close_input();
        let response = broker
            .read_response()
            .map_err(ManagedCreateError::retryable)?;
        broker.finish().map_err(ManagedCreateError::retryable)?;
        response
            .validate_against(&advance)
            .map_err(protocol_error)
            .map_err(ManagedCreateError::retryable)?;

        match response {
            ManagedCreateAdvanceBrokerResponse::Current(receipt) => self
                .open_created_for_request(*receipt, &request, !replace_current)
                .map(ManagedCreateAdvanceResolution::Current),
            ManagedCreateAdvanceBrokerResponse::Advanced(receipt) => {
                let target = request
                    .retarget_identity(receipt.idempotency_key(), receipt.session_id())
                    .map_err(protocol_error)
                    .map_err(ManagedCreateError::retryable)?;
                self.open_created_for_request(*receipt, &target, !replace_current)
                    .map(ManagedCreateAdvanceResolution::Advanced)
            }
            ManagedCreateAdvanceBrokerResponse::Pending => {
                Ok(ManagedCreateAdvanceResolution::Pending)
            }
            ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(authority) => Ok(
                ManagedCreateAdvanceResolution::AuthorityUnavailable(authority),
            ),
            ManagedCreateAdvanceBrokerResponse::Refused(failure) => {
                Err(classify_managed_create_failure(failure))
            }
        }
    }

    /// Reconciles only the stable same-idempotency canonical-digest conflict.
    /// Every other create failure is returned unchanged and cannot enter the
    /// tombstone path.
    pub fn create_or_reconcile(
        &self,
        request: ManagedCreateRequest,
    ) -> Result<ManagedCreateResolution, ManagedCreateResolutionError> {
        let idempotency_key = request.idempotency_key().to_string();
        let session_id = request.session_id().to_string();
        let workspace_id = request.workspace_id().to_string();
        let provider_id = request.provider_id().to_string();
        match self.create_with_disposition(request) {
            Ok(created) => return Ok(ManagedCreateResolution::Current(created)),
            Err(error) if error.code() == MANAGED_CREATE_RETIRED_EXACT_CODE => {
                return Ok(ManagedCreateResolution::Retired);
            }
            Err(error) if error.code() == MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE => {}
            Err(error) => return Err(ManagedCreateResolutionError::Create(error)),
        }
        let identity =
            ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
                .map_err(protocol_error)
                .map_err(ManagedCreateResolutionError::Reconcile)?;
        match self
            .reconcile_identity(identity)
            .map_err(ManagedCreateResolutionError::Reconcile)?
        {
            ManagedCreateIdentityResolution::NotFound => Err(
                ManagedCreateResolutionError::Reconcile(ClientError::transport(
                    "hmux_managed_create_reconcile_inconsistent_not_found",
                    "managed create ledger disappeared after a canonical request-digest conflict",
                )),
            ),
            ManagedCreateIdentityResolution::Existing(created)
                if created.receipt().provider_id() == provider_id =>
            {
                Ok(ManagedCreateResolution::NormalizeExisting(*created))
            }
            ManagedCreateIdentityResolution::Existing(_) => {
                Err(ManagedCreateResolutionError::Reconcile(protocol_error(
                    "managed create conflict changed the provider identity",
                )))
            }
            ManagedCreateIdentityResolution::Pending => Ok(ManagedCreateResolution::Pending),
            ManagedCreateIdentityResolution::AbandonedBeforeCompletion => {
                Ok(ManagedCreateResolution::AbandonedBeforeCompletion)
            }
            ManagedCreateIdentityResolution::Retired => Ok(ManagedCreateResolution::Retired),
            ManagedCreateIdentityResolution::AuthorityUnavailable(authority) => {
                Ok(ManagedCreateResolution::AuthorityUnavailable(authority))
            }
        }
    }

    /// Reads or safely terminalizes an existing create identity without any
    /// provider command, environment, credential, or request-digest input.
    pub fn reconcile_identity(
        &self,
        request: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateIdentityResolution, ClientError> {
        let mut reconciler = ManagedSessionCreateReconciler::new(&self.runtime_executable);
        if let Some(discovery_root) = &self.discovery_root {
            reconciler = reconciler.with_discovery_root(discovery_root);
        }
        let response = reconciler.reconcile(request)?;
        match response {
            ManagedCreateReconcileBrokerResponse::NotFound => {
                Ok(ManagedCreateIdentityResolution::NotFound)
            }
            ManagedCreateReconcileBrokerResponse::Completed(receipt) => self
                .open_prior_completed(*receipt)
                .map(Box::new)
                .map(ManagedCreateIdentityResolution::Existing),
            ManagedCreateReconcileBrokerResponse::Pending => {
                Ok(ManagedCreateIdentityResolution::Pending)
            }
            ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion => {
                Ok(ManagedCreateIdentityResolution::AbandonedBeforeCompletion)
            }
            ManagedCreateReconcileBrokerResponse::Retired => {
                Ok(ManagedCreateIdentityResolution::Retired)
            }
            ManagedCreateReconcileBrokerResponse::AuthorityUnavailable(authority) => Ok(
                ManagedCreateIdentityResolution::AuthorityUnavailable(authority),
            ),
        }
    }

    /// Resolves the current completed generation using only the permanent
    /// managed-create ledger. This path cannot spawn a runtime or allocate a
    /// successor identity.
    pub fn resolve_successor_chain(
        &self,
        request: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainResolution, ClientError> {
        self.resolve_successor_chain_with(request, managed_create_ledger::resolve_successor_chain)
    }

    /// Claims the final successor slot for destructive cleanup. The ledger
    /// claim prevents an already-running advance recovery from allocating a
    /// new successor after this method returns a cleanup target.
    pub fn claim_successor_chain_cleanup(
        &self,
        request: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainResolution, ClientError> {
        self.resolve_successor_chain_with(
            request,
            managed_create_ledger::claim_successor_chain_cleanup,
        )
    }

    fn resolve_successor_chain_with(
        &self,
        request: ManagedCreateReconcileRequest,
        resolve: fn(
            &Path,
            &ManagedCreateReconcileRequest,
        ) -> Result<ManagedCreateSuccessorChainResolution, String>,
    ) -> Result<ManagedCreateChainResolution, ClientError> {
        request.validate().map_err(protocol_error)?;
        let discovery_root = self.discovery_root.as_ref().ok_or_else(|| {
            ClientError::transport(
                "hmux_managed_create_resolution_failed",
                "managed create successor resolution requires an exact discovery root",
            )
        })?;
        match resolve(discovery_root, &request).map_err(|error| {
            ClientError::transport("hmux_managed_create_resolution_failed", error)
        })? {
            ManagedCreateSuccessorChainResolution::NotFound => {
                Ok(ManagedCreateChainResolution::NotFound)
            }
            ManagedCreateSuccessorChainResolution::Completed { receipt, .. } => self
                .open_prior_completed(*receipt)
                .map(Box::new)
                .map(ManagedCreateChainResolution::Existing),
            ManagedCreateSuccessorChainResolution::Pending { .. }
            | ManagedCreateSuccessorChainResolution::UnbornSuccessor { .. }
            | ManagedCreateSuccessorChainResolution::Retiring { .. } => {
                Ok(ManagedCreateChainResolution::Pending)
            }
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor { .. } => {
                Ok(ManagedCreateChainResolution::TerminalWithoutSuccessor)
            }
        }
    }

    fn open_prior_completed(
        &self,
        receipt: ManagedCreateReceipt,
    ) -> Result<CreatedManagedSession, ClientError> {
        if self
            .discovery_root
            .as_ref()
            .is_some_and(|configured| configured != receipt.discovery_root())
        {
            return Err(protocol_error(
                "reconciled managed create receipt changed the configured discovery root",
            ));
        }
        CreatedManagedSession::from_completed_receipt(receipt)
    }
}

fn classify_managed_create_failure(failure: ManagedCreateFailure) -> ManagedCreateError {
    let code = match failure.code.as_str() {
        MANAGED_CONVERSATION_WRITER_CONFLICT_CODE => MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
        MANAGED_CREATE_RETIRED_EXACT_CODE => MANAGED_CREATE_RETIRED_EXACT_CODE,
        MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE => MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE,
        MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE => {
            MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
        }
        MANAGED_CREATE_REQUEST_INVALID_CODE => MANAGED_CREATE_REQUEST_INVALID_CODE,
        DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE => {
            DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE
        }
        _ => "hmux_managed_create_refused",
    };
    let disposition = failure.effective_disposition();
    let source = ClientError::transport(code, format!("{}: {}", failure.code, failure.message));
    match disposition {
        ManagedCreateFailureDisposition::Rejected => ManagedCreateError::rejected(source),
        ManagedCreateFailureDisposition::Retryable => ManagedCreateError::retryable(source),
    }
}

fn validate_catalog_generation(
    descriptor: &crate::SessionDescriptor,
    fence: &ManagedCreateGenerationFence,
) -> Result<(), ClientError> {
    if !fence.matches_generation(
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        &descriptor.channel_epoch,
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    ) {
        return Err(protocol_error(
            "managed create catalog generation changed after the broker receipt",
        ));
    }
    Ok(())
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_create_protocol", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PermissionMode;

    #[test]
    fn managed_create_exposes_typed_rejection_and_retryable_boundaries() {
        let rejected = ManagedCreateError::rejected(protocol_error("invalid request"));
        assert_eq!(
            rejected.disposition(),
            ManagedCreateFailureDisposition::Rejected
        );

        let request = ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "provider-1",
            PermissionMode::Default,
            "/tmp",
            vec!["/bin/sh".into()],
            24,
            80,
        )
        .unwrap();
        let unavailable = ManagedSessionCreator::new("")
            .create_with_disposition(request.clone())
            .unwrap_err();
        assert_eq!(
            unavailable.disposition(),
            ManagedCreateFailureDisposition::Retryable
        );
        assert_eq!(unavailable.code(), "hmux_managed_runtime_failed");

        let composed = ManagedSessionCreator::new("")
            .create_or_reconcile(request)
            .unwrap_err();
        assert!(matches!(&composed, ManagedCreateResolutionError::Create(_)));
        assert_eq!(composed.code(), "hmux_managed_runtime_failed");
    }

    #[cfg(unix)]
    #[test]
    fn local_advance_never_enters_a_legacy_v2_destructive_route() {
        use std::os::unix::fs::PermissionsExt;

        let state = tempfile::tempdir().unwrap();
        let runtime = state.path().join("legacy-runtime");
        std::fs::write(
            &runtime,
            "#!/bin/sh\nif [ \"$2\" = \"internal-hmux-managed-create-advance-v2\" ]; then : > \"$0.destructive\"; fi\ncat >/dev/null\nexit 64\n",
        )
        .unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        let request = ManagedCreateRequest::new(
            "create-local-skew",
            "session-local-skew",
            "workspace-local-skew",
            "fixture",
            PermissionMode::Default,
            "/tmp",
            vec!["/bin/sh".into()],
            24,
            80,
        )
        .unwrap();

        ManagedSessionCreator::new(&runtime)
            .create_or_reconcile_and_advance(request)
            .expect_err("a legacy runtime must refuse the unknown v3 broker route");
        let destructive_marker = format!("{}.destructive", runtime.display());
        assert!(
            !std::path::Path::new(&destructive_marker).exists(),
            "the client must not invoke the legacy destructive v2 route",
        );
    }

    #[test]
    fn legacy_create_failure_without_disposition_keeps_only_known_admission_codes_permanent() {
        let response: ManagedCreateBrokerResponse = serde_json::from_value(serde_json::json!({
            "state": "refused",
            "payload": {
                "code": MANAGED_CREATE_REQUEST_INVALID_CODE,
                "message": "unsupported managed create schema"
            }
        }))
        .unwrap();
        let ManagedCreateBrokerResponse::Refused(failure) = response else {
            panic!("legacy fixture must be a refusal")
        };
        let rejected = classify_managed_create_failure(failure);
        assert_eq!(
            rejected.disposition(),
            ManagedCreateFailureDisposition::Rejected
        );
        assert_eq!(rejected.code(), MANAGED_CREATE_REQUEST_INVALID_CODE);

        let response: ManagedCreateBrokerResponse = serde_json::from_value(serde_json::json!({
            "state": "refused",
            "payload": {
                "code": "hmux_managed_launch_failed",
                "message": "launch outcome is unknown"
            }
        }))
        .unwrap();
        let ManagedCreateBrokerResponse::Refused(failure) = response else {
            panic!("legacy fixture must be a refusal")
        };
        assert_eq!(
            classify_managed_create_failure(failure).disposition(),
            ManagedCreateFailureDisposition::Retryable
        );

        let digest_conflict = classify_managed_create_failure(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Rejected,
            code: MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE.into(),
            message: "canonical request changed".into(),
        });
        assert_eq!(
            digest_conflict.code(),
            MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
        );
    }

    #[test]
    fn discovery_capacity_failure_keeps_its_authoritative_code() {
        let failure = ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Retryable,
            code: "hmux_discovery_registration_capacity_exceeded".into(),
            message: "discovery registration capacity is exhausted".into(),
        };

        assert_eq!(
            classify_managed_create_failure(failure).code(),
            "hmux_discovery_registration_capacity_exceeded"
        );
    }
}
