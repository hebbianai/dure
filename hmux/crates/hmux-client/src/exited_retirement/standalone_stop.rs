use super::*;
use std::time::Duration;

impl LocalSessionCatalog {
    /// Stop an exact standalone generation while retaining its recovery state.
    /// Unlike final retirement, this operation is valid under the recovery
    /// source lock and must not archive a pending replacement's source.
    pub fn stop_completed_standalone_target(
        &self,
        generation: &ExitedSessionRetirementGeneration,
        provider_process: &ProcessDescriptor,
        timeout: Duration,
    ) -> Result<(), ClientError> {
        match self.open_completed_standalone_target(generation, provider_process) {
            Ok(session) => session.terminate_standalone(self, timeout),
            Err(error) if error.is_session_absent() => {
                // Hosts can remove their active pointer after acknowledged
                // termination. Replay still needs exact process and cleanup
                // proof; pointer absence alone never authorizes replacement.
                let fence = generation.session_fence().map_err(|()| {
                    ClientError::transport(
                        "hmux_standalone_target_generation_invalid",
                        "saved standalone generation has an invalid fence",
                    )
                })?;
                let host = generation.host_process();
                if probe_local_process_generation(&host)? != LocalProcessGenerationStatus::Absent
                    || probe_local_process_generation(provider_process)?
                        != LocalProcessGenerationStatus::Absent
                {
                    return Err(error);
                }
                let archived = self.archived_exited_retirement_evidence(&fence, &host)?;
                let cleanup_complete = match archived {
                    Some(evidence) => {
                        evidence.session_class == SessionClass::Standalone
                            && evidence.provider_process == *provider_process
                            && !evidence.process_session_cleanup_incomplete
                    }
                    None => provider_process_session_is_stably_empty(provider_process)?,
                };
                if cleanup_complete && self.exact_session_absence_is_quiescent(&fence)? {
                    Ok(())
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }
}
