use crate::runtime_broker::RuntimeBroker;
use crate::{
    ClientError, DISCOVERY_ROOT_ENV, LocalSessionCatalog, SessionClass, SessionDescriptor,
    SessionSelector,
};
use hmux_runtime_contract::{
    MANAGED_REHOST_BROKER_SUBCOMMAND, MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND,
    ManagedRehostBrokerResponse, ManagedRehostReceipt, ManagedRehostReconcileRequest,
    ManagedRehostRequest,
};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV: &str =
    "HMUX_MANAGED_REHOST_SOURCE_DISCOVERY_ROOT";

/// One catalog-resolved managed source and the discovery root that published it.
///
/// The descriptor is the parsed identity authority; the root only routes the
/// runtime to that exact generation and never relaxes its complete fence check.
#[derive(Clone, Debug)]
pub struct ManagedRehostSource {
    descriptor: SessionDescriptor,
    discovery_root: PathBuf,
}

impl ManagedRehostSource {
    #[must_use]
    pub fn descriptor(&self) -> &SessionDescriptor {
        &self.descriptor
    }

    fn validates(&self, request: &ManagedRehostRequest) -> bool {
        let source = request.source();
        self.descriptor.session_class == SessionClass::Managed
            && self.descriptor.session_id == source.session_id()
            && self.descriptor.workspace_id == source.workspace_id()
            && source.expected_runner_principal() == Some(self.descriptor.runner_principal.as_str())
            && source.expected_runner_instance() == Some(self.descriptor.runner_instance.as_str())
            && source
                .expected_channel_epoch()
                .is_some_and(|epoch| epoch.to_string() == self.descriptor.channel_epoch)
            && source.expected_host_instance_id() == Some(self.descriptor.host_instance_id.as_str())
            && source.expected_terminal_epoch() == Some(self.descriptor.terminal_epoch.as_str())
    }
}

impl LocalSessionCatalog {
    /// Parse an exact managed source once and retain the root that published it.
    pub fn managed_rehost_source(
        &self,
        selector: &SessionSelector,
    ) -> Result<ManagedRehostSource, ClientError> {
        let discovered = self.resolve_discovered(selector)?;
        let discovery_root = discovered
            .discovery_path
            .parent()
            .and_then(Path::parent)
            .filter(|root| root.is_absolute())
            .ok_or_else(|| {
                ClientError::transport(
                    "hmux_managed_rehost_source_invalid",
                    "managed source has no exact discovery root",
                )
            })?
            .to_path_buf();
        let descriptor = SessionDescriptor::from(discovered);
        if descriptor.session_class != SessionClass::Managed {
            return Err(ClientError::transport(
                "hmux_managed_rehost_source_invalid",
                "managed rehost requires a managed source",
            ));
        }
        Ok(ManagedRehostSource {
            descriptor,
            discovery_root,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ManagedSessionRehoster {
    runtime_executable: PathBuf,
    runtime_working_directory: PathBuf,
    discovery_root: Option<PathBuf>,
    source: Option<ManagedRehostSource>,
}

impl ManagedSessionRehoster {
    #[must_use]
    pub fn new(
        runtime_executable: impl Into<PathBuf>,
        runtime_working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            runtime_working_directory: runtime_working_directory.into(),
            discovery_root: None,
            source: None,
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    #[must_use]
    pub fn with_source(mut self, source: ManagedRehostSource) -> Self {
        self.source = Some(source);
        self
    }

    pub fn rehost(
        &self,
        request: ManagedRehostRequest,
    ) -> Result<ManagedRehostReceipt, ClientError> {
        request.validate().map_err(protocol_error)?;
        if self
            .source
            .as_ref()
            .is_some_and(|source| !source.validates(&request))
        {
            return Err(protocol_error(
                "managed rehost source handle does not match the request fence",
            ));
        }
        self.validate_runtime()?;
        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_REHOST_BROKER_SUBCOMMAND)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(DISCOVERY_ROOT_ENV, discovery_root);
        }
        configure_source_discovery_root(
            &mut command,
            self.source
                .as_ref()
                .map(|source| source.discovery_root.as_path()),
        );
        let mut broker = RuntimeBroker::<ManagedRehostBrokerResponse>::spawn(
            &mut command,
            "managed Hmux rehost",
            "hmux_managed_runtime_failed",
        )?;
        broker.write(&request)?;
        broker.close_input();
        let response = broker.read_response()?;
        broker.finish()?;
        let receipt = receipt_from_response(response)?;
        receipt.validate_against(&request).map_err(protocol_error)?;
        Ok(receipt)
    }

    pub fn reconcile(
        &self,
        request: ManagedRehostReconcileRequest,
    ) -> Result<ManagedRehostReceipt, ClientError> {
        request.validate().map_err(protocol_error)?;
        self.validate_runtime()?;
        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(DISCOVERY_ROOT_ENV, discovery_root);
        }
        configure_source_discovery_root(&mut command, None);
        let mut broker = RuntimeBroker::<ManagedRehostBrokerResponse>::spawn(
            &mut command,
            "managed Hmux rehost reconcile",
            "hmux_managed_runtime_failed",
        )?;
        broker.write(&request)?;
        broker.close_input();
        let response = broker.read_response()?;
        broker.finish()?;
        let receipt = receipt_from_response(response)?;
        receipt
            .validate_against_reconcile(&request)
            .map_err(protocol_error)?;
        Ok(receipt)
    }

    fn validate_runtime(&self) -> Result<(), ClientError> {
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(runtime_error("managed Hmux runtime path is empty"));
        }
        if !self.runtime_working_directory.is_absolute() || !self.runtime_working_directory.is_dir()
        {
            return Err(runtime_error(
                "managed Hmux runtime working directory must be an existing absolute directory",
            ));
        }
        if self.source.as_ref().is_some_and(|source| {
            !source.discovery_root.is_absolute() || !source.discovery_root.is_dir()
        }) {
            return Err(runtime_error(
                "managed rehost source discovery root must be an existing absolute directory",
            ));
        }
        Ok(())
    }
}

fn configure_source_discovery_root(command: &mut Command, source: Option<&Path>) {
    match source {
        Some(source) => {
            command.env(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, source);
        }
        None => {
            command.env_remove(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV);
        }
    }
}

fn receipt_from_response(
    response: ManagedRehostBrokerResponse,
) -> Result<ManagedRehostReceipt, ClientError> {
    match response {
        ManagedRehostBrokerResponse::Completed(receipt) => Ok(*receipt),
        ManagedRehostBrokerResponse::Refused(failure) => {
            let code = match failure.code.as_str() {
                "hmux_managed_rehost_confirmation_required" => {
                    "hmux_managed_rehost_confirmation_required"
                }
                "hmux_managed_rehost_recipe_missing" => "hmux_managed_rehost_recipe_missing",
                "hmux_managed_rehost_recipe_invalid" => "hmux_managed_rehost_recipe_invalid",
                "hmux_managed_rehost_request_invalid" => "hmux_managed_rehost_request_invalid",
                "hmux_managed_rehost_unavailable" => "hmux_managed_rehost_unavailable",
                "hmux_managed_rehost_source_changed" => "hmux_managed_rehost_source_changed",
                "managed_rehost_socket_owner_absence_required" => {
                    "managed_rehost_socket_owner_absence_required"
                }
                "hmux_managed_rehost_identity_mismatch" => "hmux_managed_rehost_identity_mismatch",
                "hmux_managed_rehost_conversation_required" => {
                    "hmux_managed_rehost_conversation_required"
                }
                "hmux_managed_rehost_checkpoint_required" => {
                    "hmux_managed_rehost_checkpoint_required"
                }
                "hmux_managed_rehost_target_conflict" => "hmux_managed_rehost_target_conflict",
                "hmux_managed_rehost_target_build_changed" => {
                    "hmux_managed_rehost_target_build_changed"
                }
                "hmux_managed_rehost_target_validation_failed" => {
                    "hmux_managed_rehost_target_validation_failed"
                }
                "hmux_managed_rehost_intent_not_found" => "hmux_managed_rehost_intent_not_found",
                "hmux_managed_rehost_outcome_unknown" => "hmux_managed_rehost_outcome_unknown",
                "hmux_recovery_busy" => "hmux_recovery_busy",
                _ => "hmux_managed_rehost_refused",
            };
            Err(ClientError::transport(
                code,
                format!("{}: {}", failure.code, failure.message),
            ))
        }
    }
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_rehost_protocol", error.to_string())
}

fn runtime_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_runtime_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, configure_source_discovery_root};
    use std::ffi::OsStr;
    use std::path::Path;
    use std::process::Command;

    fn configured_source(command: &Command) -> Option<Option<&OsStr>> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV))
            .map(|(_, value)| value)
    }

    #[test]
    fn source_discovery_root_is_owned_by_the_explicit_client_handle() {
        let mut absent = Command::new("broker");
        absent.env(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, "/ambient/source");
        configure_source_discovery_root(&mut absent, None);
        assert_eq!(configured_source(&absent), Some(None));

        let explicit_root = Path::new("/explicit/source");
        let mut explicit = Command::new("broker");
        explicit.env(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, "/ambient/source");
        configure_source_discovery_root(&mut explicit, Some(explicit_root));
        assert_eq!(
            configured_source(&explicit),
            Some(Some(explicit_root.as_os_str()))
        );
    }
}
