use std::time::{Duration, Instant};

use crate::{
    CompletedStandaloneTargetLifecycle, ExitedSessionRetirementGeneration, LocalSessionCatalog,
    ProcessDescriptor,
};

impl LocalSessionCatalog {
    /// Retire only the saved completed generation. Stop acknowledgement and
    /// an Exited manifest can precede Host drain, so the existing retirement
    /// authority, not transport success, owns completion within this deadline.
    /// Callers must retain these inputs durably before invoking this method.
    pub fn retire_completed_standalone_target(
        &self,
        generation: &ExitedSessionRetirementGeneration,
        provider_process: &ProcessDescriptor,
        timeout: Duration,
    ) -> CompletedStandaloneTargetLifecycle {
        let deadline = Instant::now() + timeout;
        // Lost stop acknowledgement is resolved by the exact retirement proof
        // below; stopping alone does not grant checkout-release authority.
        let _ = self.stop_completed_standalone_target(generation, provider_process, timeout);
        loop {
            let state = self.resolve_completed_standalone_target(generation, provider_process);
            let remaining = deadline.saturating_duration_since(Instant::now());
            if state == CompletedStandaloneTargetLifecycle::Retired || remaining.is_zero() {
                return state;
            }
            std::thread::sleep(remaining.min(Duration::from_millis(25)));
        }
    }
}
