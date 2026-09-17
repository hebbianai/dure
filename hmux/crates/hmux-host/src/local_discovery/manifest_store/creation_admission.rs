//! Starting publication is the final creation boundary, under the lifetime lock.

use super::*;
use crate::local_discovery::SessionClass;

impl SessionDiscovery {
    pub fn publish_starting(
        &self,
        lock: &LifetimeLock,
        manifest: StartingManifest,
    ) -> Result<(), DiscoveryError> {
        let result = (|| {
            self.ensure_lock(lock)?;
            let candidate = DiscoveryManifest::Starting(manifest);
            self.validate_for_key(&candidate)?;
            if let Some(current) = self.try_read_manifest()? {
                match current {
                    DiscoveryManifest::Starting(current)
                        if current.common == candidate.common().clone() => {}
                    DiscoveryManifest::Starting(_) => {
                        return Err(DiscoveryError::ManifestConflict);
                    }
                    DiscoveryManifest::Ready(_) => {
                        return Err(DiscoveryError::InvalidManifestTransition {
                            from: "ready",
                            to: "starting",
                        });
                    }
                    DiscoveryManifest::Exited(_) => {
                        return Err(DiscoveryError::InvalidManifestTransition {
                            from: "exited",
                            to: "starting",
                        });
                    }
                }
            }
            // Broker preflight can predate another Host's entire lifetime.
            // Apply its existing retirement record here, before provider spawn,
            // while the same lock excludes a competing publication/retirement.
            let common = candidate.common();
            if let (SessionClass::Standalone, Some(create_key)) = (
                common.session_class,
                common.claim_linkage.kickoff_action_id.as_deref(),
            ) {
                let root = DiscoveryRoot {
                    path: self.root_path.clone(),
                    limits: self.limits.clone(),
                };
                if root
                    .find_retired_creation(
                        &common.lifetime.workspace_id,
                        &common.lifetime.session_id,
                        create_key,
                    )?
                    .is_some()
                {
                    return Err(DiscoveryError::InvalidManifestTransition {
                        from: "retired",
                        to: "starting",
                    });
                }
            }
            self.write_manifest(&candidate)
        })();
        if result.is_ok() {
            lock.commit_creation_admission();
        } else {
            lock.rollback_creation_admission();
        }
        result
    }
}
