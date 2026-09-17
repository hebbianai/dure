use crate::ClientError;
use crate::runtime_broker::RuntimeBroker;
use hmux_runtime_contract::{
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest,
};
use std::path::PathBuf;
use std::process::Command;

/// Identity-only access to the runtime's permanent managed-create ledger.
///
/// The caller cannot supply launch material or a replacement digest. A
/// terminal response therefore describes only the generation already bound to
/// the request identity.
#[derive(Clone, Debug)]
pub struct ManagedSessionCreateReconciler {
    runtime_executable: PathBuf,
    discovery_root: Option<PathBuf>,
}

impl ManagedSessionCreateReconciler {
    #[must_use]
    pub fn new(runtime_executable: impl Into<PathBuf>) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            discovery_root: None,
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    pub fn reconcile(
        &self,
        request: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateReconcileBrokerResponse, ClientError> {
        request.validate().map_err(protocol_error)?;
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(ClientError::transport(
                "hmux_managed_create_reconcile_runtime_failed",
                "managed create reconcile runtime path is empty",
            ));
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedCreateReconcileBrokerResponse>::spawn(
            &mut command,
            "managed create reconcile",
            "hmux_managed_create_reconcile_runtime_failed",
        )?;
        broker.write(&request)?;
        broker.close_input();
        let response = broker.read_response()?;
        broker.finish()?;
        response
            .validate_against(&request)
            .map_err(protocol_error)?;
        Ok(response)
    }
}

fn protocol_error(error: impl std::fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_create_reconcile_protocol", error.to_string())
}
