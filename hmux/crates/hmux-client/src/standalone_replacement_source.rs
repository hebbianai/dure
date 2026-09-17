use crate::{
    ClientError, ExitedSessionRetirementGeneration, LocalSession, LocalSessionCatalog,
    ProcessDescriptor, SessionClass,
    recovery_journal::{self, RecoverySourceLock},
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

/// Exact source stop input retained by the caller's prepared replacement.
/// Preserve the original journal shape; retries never resolve destruction by
/// a mutable session name or a different discovery namespace.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandaloneReplacementSource {
    discovery_root: PathBuf,
    generation: ExitedSessionRetirementGeneration,
    provider_process: ProcessDescriptor,
}

impl StandaloneReplacementSource {
    pub fn from_session(source: &LocalSession) -> Result<Self, ClientError> {
        let descriptor = source.descriptor();
        if descriptor.session_class != SessionClass::Standalone {
            return Err(ClientError::transport(
                "hmux_standalone_source_invalid",
                "replacement requires a standalone source",
            ));
        }
        Ok(Self {
            discovery_root: source
                .discovery_root()
                .ok_or_else(|| {
                    ClientError::transport(
                        "hmux_standalone_source_invalid",
                        "source has no discovery namespace",
                    )
                })?
                .to_path_buf(),
            generation: ExitedSessionRetirementGeneration::from_descriptor(descriptor)?,
            provider_process: descriptor.provider_process.clone(),
        })
    }

    pub fn lock(&self) -> Result<RecoverySourceLock, String> {
        recovery_journal::lock_source(
            &self.discovery_root,
            &self.generation.fence.workspace_id,
            &self.generation.fence.session_id,
        )
    }

    pub fn generation(&self) -> &ExitedSessionRetirementGeneration {
        &self.generation
    }

    pub fn discovery_root(&self) -> &std::path::Path {
        &self.discovery_root
    }

    pub fn provider_process(&self) -> &ProcessDescriptor {
        &self.provider_process
    }

    pub fn presentation_predecessor(
        &self,
    ) -> Result<crate::PresentationCheckpointPredecessor, String> {
        let fence = &self.generation.fence;
        crate::PresentationCheckpointPredecessor::new(
            &fence.session_id,
            &fence.runner_principal,
            &fence.runner_instance,
            fence.channel_epoch.parse().map_err(|_| {
                "hmux_standalone_source_invalid: channel epoch is invalid".to_string()
            })?,
            &fence.host_instance_id,
            &fence.terminal_epoch,
        )
        .map_err(|error| error.to_string())
    }

    pub fn open(&self) -> Result<LocalSession, ClientError> {
        LocalSessionCatalog::new(&self.discovery_root)
            .open_completed_standalone_target(&self.generation, &self.provider_process)
    }

    pub fn stop(&self, timeout: Duration) -> Result<(), ClientError> {
        // Stop the exact Host/provider without archiving the pending operation
        // that still owns the replacement and its saved launch inputs.
        LocalSessionCatalog::new(&self.discovery_root).stop_completed_standalone_target(
            &self.generation,
            &self.provider_process,
            timeout,
        )
    }
}
