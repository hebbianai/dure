use crate::runtime_broker::RuntimeBroker;
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, LocalSessionController, SessionClass,
    SessionProbeStatus, SessionRetirementReceipt, SessionSelector, probe_local_session_exact,
};
use hmux_runtime_contract::{
    STANDALONE_CREATE_BROKER_SUBCOMMAND, StandaloneCreateBrokerResponse, StandaloneCreateReceipt,
    StandaloneCreateRequest,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::PathBuf;
use std::process::Command;

/// Non-secret create key persisted in a recovery-created standalone manifest.
/// Keep the existing runtime encoding so prepared requests retain their identity.
pub fn standalone_create_idempotency_key(
    identity: &hmux_runtime_contract::StandaloneRecoveryCreateIdentity,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"hmux_standalone_recovery_v1");
    digest.update(identity.target_session_id().len().to_le_bytes());
    digest.update(identity.target_session_id().as_bytes());
    digest.update(identity.launch_owner_proof().len().to_le_bytes());
    digest.update(identity.launch_owner_proof().as_bytes());
    if let Some(source) = identity.source_predecessor() {
        for field in [
            source.session_id(),
            source.runner_principal(),
            source.runner_instance(),
            source.host_instance_id(),
            source.terminal_epoch(),
        ] {
            digest.update(field.len().to_le_bytes());
            digest.update(field.as_bytes());
        }
        digest.update(source.channel_epoch().to_le_bytes());
    }
    format!("standalone_recovery_v1_{:x}", digest.finalize())
}

pub struct CreatedStandaloneSession {
    session: LocalSession,
    receipt: StandaloneCreateReceipt,
    launch_owner_proof: Option<String>,
}

impl fmt::Debug for CreatedStandaloneSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CreatedStandaloneSession")
            .field("session", &self.session)
            .field("receipt", &self.receipt)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

impl CreatedStandaloneSession {
    /// Reopen an already completed generation without submitting a create.
    /// Restore the same private launch proof for unpresented-create cleanup;
    /// the exact catalog fence prevents adopting a later target generation.
    #[cfg(any(unix, windows))]
    pub fn from_completed_target(
        target: &crate::CompletedStandaloneTarget,
    ) -> Result<Self, ClientError> {
        let catalog = LocalSessionCatalog::new(target.receipt().discovery_root());
        let session = catalog
            .open_completed_standalone_target(target.generation(), target.provider_process())?;
        Ok(Self::from_receipt(session, target.receipt().clone()))
    }

    fn from_receipt(session: LocalSession, receipt: StandaloneCreateReceipt) -> Self {
        let launch_owner_proof = Some(receipt.launch_owner_proof().to_string());
        Self {
            session,
            receipt,
            launch_owner_proof,
        }
    }

    #[must_use]
    pub fn session(&self) -> &LocalSession {
        &self.session
    }

    #[must_use]
    pub fn receipt(&self) -> &StandaloneCreateReceipt {
        &self.receipt
    }

    pub fn connect_controller(&mut self) -> Result<LocalSessionController, ClientError> {
        let connection = LocalSessionController::connect_session(
            self.session.clone(),
            self.launch_owner_proof.clone(),
        )?;
        self.launch_owner_proof = None;
        Ok(connection)
    }

    /// Abandon this exact launch only while the Host can prove that no normal
    /// attachment has ever committed. The opaque proof is never exposed to
    /// presentation code; a raced external attach makes the Host preserve.
    pub fn abandon_unpresented_creation(&self) -> Result<SessionRetirementReceipt, ClientError> {
        let proof = self.launch_owner_proof.clone().ok_or_else(|| {
            ClientError::transport(
                "hmux_unpresented_creation_abandon_refused",
                "standalone launch authority was already consumed",
            )
        })?;
        self.session.abandon_unpresented_creation(proof)
    }
}

#[derive(Clone, Debug)]
pub struct StandaloneSessionCreator {
    runtime_executable: PathBuf,
    discovery_root: Option<PathBuf>,
}

impl StandaloneSessionCreator {
    #[must_use]
    pub fn new(runtime_executable: impl Into<PathBuf>) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            discovery_root: None,
        }
    }

    /// Override the discovery root inherited by the detached runtime. This
    /// keeps `hmux --discovery-root ... new` self-contained and testable
    /// without mutating the caller's process environment.
    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    pub fn create(
        &self,
        request: StandaloneCreateRequest,
    ) -> Result<CreatedStandaloneSession, ClientError> {
        request.validate().map_err(protocol_error)?;
        let requires_deterministic_identity_probe = request.recovery_identity().is_some();
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(ClientError::transport(
                "hmux_standalone_runtime_failed",
                "standalone Hmux runtime path is empty",
            ));
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(STANDALONE_CREATE_BROKER_SUBCOMMAND)
            .current_dir(request.provider_cwd());
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<StandaloneCreateBrokerResponse>::spawn(
            &mut command,
            "standalone Hmux",
            "hmux_standalone_runtime_failed",
        )?;
        broker.write(&request)?;
        broker.close_input();
        let response = broker.read_response()?;
        broker.finish()?;

        let receipt = match response {
            StandaloneCreateBrokerResponse::Created(receipt) => receipt,
            StandaloneCreateBrokerResponse::Refused(failure) => {
                let code = match failure.code.as_str() {
                    "hmux_standalone_operation_not_pending" => {
                        "hmux_standalone_operation_not_pending"
                    }
                    "hmux_standalone_operation_input_conflict" => {
                        "hmux_standalone_operation_input_conflict"
                    }
                    "hmux_standalone_recovery_target_exited" => {
                        "hmux_standalone_recovery_target_exited"
                    }
                    "hmux_standalone_recovery_identity_conflict" => {
                        "hmux_standalone_recovery_identity_conflict"
                    }
                    "hmux_standalone_recovery_protocol_incompatible" => {
                        "hmux_standalone_recovery_protocol_incompatible"
                    }
                    "hmux_standalone_recovery_target_unavailable" => {
                        "hmux_standalone_recovery_target_unavailable"
                    }
                    "hmux_standalone_recovery_name_conflict" => {
                        "hmux_standalone_recovery_name_conflict"
                    }
                    "hmux_standalone_read_only_name_conflict" => {
                        "hmux_standalone_read_only_name_conflict"
                    }
                    "hmux_standalone_recipe_conflict" => "hmux_standalone_recipe_conflict",
                    _ => "hmux_standalone_create_refused",
                };
                return Err(ClientError::transport(
                    code,
                    format!("{}: {}", failure.code, failure.message),
                ));
            }
        };
        receipt.validate().map_err(protocol_error)?;

        let catalog = LocalSessionCatalog::new(receipt.discovery_root());
        let session = catalog.open(&SessionSelector::new(
            receipt.session_id(),
            Some(receipt.workspace_id().to_string()),
        ))?;
        let descriptor = session.descriptor();
        if descriptor.session_class != SessionClass::Standalone
            || descriptor.session_name.as_deref() != Some(receipt.session_name())
            || descriptor.workspace_id != receipt.workspace_id()
        {
            return Err(protocol_error(
                "standalone create receipt does not match discovery identity",
            ));
        }
        if requires_deterministic_identity_probe
            && probe_local_session_exact(&catalog, descriptor) != SessionProbeStatus::Healthy
        {
            return Err(protocol_error(
                "standalone create target failed its fresh control-plane handshake",
            ));
        }
        Ok(CreatedStandaloneSession::from_receipt(session, receipt))
    }
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_standalone_create_protocol", error.to_string())
}
