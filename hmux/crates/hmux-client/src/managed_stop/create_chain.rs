use super::*;
use crate::recovery_journal::managed_create_ledger::{close_stopped_creation, final_stop_receipt};
use hmux_runtime_contract::{
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    ManagedCreateChainStopBrokerResponse, ManagedCreateChainStopBrokerResponseV2,
    ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2, ManagedCreateReconcileRequest,
};
use serde::de::DeserializeOwned;

impl ManagedSessionStopper {
    /// Retire one exact generation and close only its own vacant successor
    /// slot. Unlike chain stop, this cannot follow a competing recovery.
    /// Replays consume the existing stop journal and permanent create ledger.
    pub fn stop_and_close_creation(
        &self,
        request: ManagedStopRequest,
    ) -> Result<ManagedStopReceipt, ClientError> {
        let catalog = match &self.discovery_root {
            Some(root) => LocalSessionCatalog::new(root),
            None => LocalSessionCatalog::from_environment()?,
        };
        let reconciliation =
            ManagedStopReconcileRequest::from_stop_request(&request).map_err(protocol_error)?;
        // Keep the broker's complete lookup scope. Its exact stop transaction
        // owns source resolution, including a configured compatibility root.
        let receipt = self.stop(request)?;
        let close_error = |error: String| {
            ClientError::transport("hmux_managed_stop_create_close_unavailable", error)
        };
        let mut owner = None;
        for root in catalog.managed_stop_reconcile_roots()? {
            if final_stop_receipt(&root, &reconciliation)
                .map_err(&close_error)?
                .is_some()
                && owner.replace(root).is_some()
            {
                return Err(close_error(
                    "finalized stop belongs to competing discovery namespaces".into(),
                ));
            }
        }
        // The permanent ledger survives source-manifest and journal removal.
        // A legacy stop without a create ledger has no successor slot to close.
        if let Some(root) = owner {
            close_stopped_creation(&root, &receipt)
                .map_err(|error| close_error(error.to_string()))?;
        }
        Ok(receipt)
    }

    /// Durably closes one managed-create successor chain, then exact-stops
    /// the final completed generation selected by that same ledger authority.
    /// This legacy v1 API returns only the requested root and effective tail.
    pub fn stop_create_chain(
        &self,
        root: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopReceipt, ClientError> {
        let response: ManagedCreateChainStopBrokerResponse = self.request_create_chain_stop(
            &root,
            MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND,
            "managed Hmux create-chain stop",
        )?;
        response.validate_against(&root).map_err(protocol_error)?;
        match response {
            ManagedCreateChainStopBrokerResponse::Completed(receipt) => Ok(*receipt),
            ManagedCreateChainStopBrokerResponse::NotFound => Err(ClientError::transport(
                "hmux_managed_create_chain_stop_not_found",
                "managed create root is absent from the durable ledger",
            )),
            ManagedCreateChainStopBrokerResponse::Pending => Err(ClientError::transport(
                "hmux_managed_create_chain_stop_pending",
                "managed create chain has not reached a destructively stoppable state",
            )),
            ManagedCreateChainStopBrokerResponse::AuthorityUnavailable(authority) => {
                Err(ClientError::transport(
                    "hmux_managed_create_chain_stop_authority_unavailable",
                    format!("{}: {}", authority.code, authority.message),
                ))
            }
            ManagedCreateChainStopBrokerResponse::Refused(failure) => Err(ClientError::transport(
                "hmux_managed_create_chain_stop_refused",
                format!("{}: {}", failure.code, failure.message),
            )),
        }
    }

    /// Durably closes one managed-create successor chain and returns the full
    /// ordered identity path selected by the ledger authority.
    pub fn stop_create_chain_v2(
        &self,
        root: ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopReceiptV2, ClientError> {
        let response: ManagedCreateChainStopBrokerResponseV2 = self.request_create_chain_stop(
            &root,
            MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
            "managed Hmux create-chain stop v2",
        )?;
        response.validate_against(&root).map_err(protocol_error)?;
        match response {
            ManagedCreateChainStopBrokerResponseV2::Completed(receipt) => Ok(*receipt),
            ManagedCreateChainStopBrokerResponseV2::NotFound => Err(ClientError::transport(
                "hmux_managed_create_chain_stop_not_found",
                "managed create root is absent from the durable ledger",
            )),
            ManagedCreateChainStopBrokerResponseV2::Pending => Err(ClientError::transport(
                "hmux_managed_create_chain_stop_pending",
                "managed create chain has not reached a destructively stoppable state",
            )),
            ManagedCreateChainStopBrokerResponseV2::AuthorityUnavailable(authority) => {
                Err(ClientError::transport(
                    "hmux_managed_create_chain_stop_authority_unavailable",
                    format!("{}: {}", authority.code, authority.message),
                ))
            }
            ManagedCreateChainStopBrokerResponseV2::Refused(failure) => {
                Err(ClientError::transport(
                    "hmux_managed_create_chain_stop_refused",
                    format!("{}: {}", failure.code, failure.message),
                ))
            }
        }
    }

    fn request_create_chain_stop<Response: DeserializeOwned + Send + 'static>(
        &self,
        root: &ManagedCreateReconcileRequest,
        broker_subcommand: &str,
        label: &'static str,
    ) -> Result<Response, ClientError> {
        root.validate().map_err(protocol_error)?;
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(runtime_error("managed Hmux runtime path is empty"));
        }
        if !self.runtime_working_directory.is_absolute() || !self.runtime_working_directory.is_dir()
        {
            return Err(runtime_error(
                "managed Hmux runtime working directory must be an existing absolute directory",
            ));
        }

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(broker_subcommand)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker =
            RuntimeBroker::<Response>::spawn(&mut command, label, "hmux_managed_runtime_failed")?;
        broker.write(root)?;
        broker.close_input();
        let response = broker.read_response()?;
        broker.finish()?;
        Ok(response)
    }
}
