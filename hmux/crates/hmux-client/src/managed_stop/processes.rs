use super::*;
use crate::EndpointKind;
use crate::legacy_terminate::{terminate_verified_host, terminate_verified_process_session};
use crate::transport::unix_socket::UnixSocketDialer;
use hmux_local_platform::peer_attestation::SessionScope;
use std::path::Path;

impl LocalSession {
    /// Stop the exact local processes when an unconditional broker stop cannot
    /// reach the Host protocol. The broker still owns lifetime-lock acquisition,
    /// Exited publication, and the durable stop receipt after this returns.
    pub fn terminate_unresponsive_managed(
        &self,
        catalog: &LocalSessionCatalog,
        timeout: Duration,
    ) -> Result<(), ClientError> {
        let target = self.descriptor();
        let current = catalog.find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))?;
        if current.session_class != SessionClass::Managed
            || !current.same_generation(target)
            || current.host_process != target.host_process
            || current.provider_process != target.provider_process
        {
            return Err(ClientError::transport(
                "hmux_managed_stop_identity_changed",
                "managed process generation changed before local termination",
            ));
        }
        if current.lifecycle == SessionLifecycle::Exited {
            return ensure_cleanup_complete(&current);
        }
        if current.endpoint.kind != EndpointKind::UnixSocket {
            return Err(ClientError::transport(
                "hmux_managed_stop_unwitnessed",
                "local managed termination requires a pathname Unix socket",
            ));
        }
        let scope = SessionScope::new(
            &current.workspace_id,
            &current.session_id,
            &current.host_instance_id,
        );
        // The kernel establishes colocation at connect, before Hello. A stuck
        // or incompatible Host need not reply to prove which machine owns its
        // processes; exact OS generations remain the signalling authority.
        let transport = UnixSocketDialer::open_before(
            Path::new(&current.endpoint.address),
            scope.clone(),
            Some(Instant::now() + timeout),
        )?;
        let colocation = transport.attestation.witness_for(&scope).map_err(|error| {
            ClientError::transport("hmux_managed_stop_unwitnessed", error.to_string())
        })?;
        terminate_verified_process_session(colocation, &current)?;
        terminate_verified_host(colocation, &current)
    }
}
