use crate::LocalSessionCatalog;
use crate::recovery_journal::{
    self, PendingRecoverySource, RecoverySourceRetirementFence, RecoverySourceRetirementFenceState,
};
use std::collections::BTreeSet;

pub(super) fn pending_sources(
    catalog: &LocalSessionCatalog,
) -> Result<BTreeSet<PendingRecoverySource>, String> {
    let mut pending = BTreeSet::new();
    for root in catalog.discovery_paths() {
        pending.extend(recovery_journal::inspect_existing(root)?.pending_sources);
    }
    Ok(pending)
}

/// Retain the existing source/admission/maintenance fences in every configured
/// namespace that exists. A compatibility source may have its recovery intent
/// in the primary root. Never manufacture an absent root just to retire one.
/// None means an existing recovery or source-lock holder still owns the source.
pub(super) fn fence_source(
    catalog: &LocalSessionCatalog,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<Vec<RecoverySourceRetirementFence>>, String> {
    let mut roots: Vec<_> = catalog.discovery_paths().collect();
    roots.sort_unstable();
    let mut fences = Vec::with_capacity(roots.len());
    for root in roots {
        match std::fs::symlink_metadata(root) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("hmux_recovery_journal_invalid: {error}")),
        }
        let fence =
            match recovery_journal::try_fence_source_retirement(root, workspace_id, session_id)? {
                RecoverySourceRetirementFenceState::Acquired(fence) => fence,
                RecoverySourceRetirementFenceState::Busy => return Ok(None),
            };
        if fence.source_is_pending(workspace_id, session_id) {
            return Ok(None);
        }
        fences.push(fence);
    }
    Ok(Some(fences))
}
