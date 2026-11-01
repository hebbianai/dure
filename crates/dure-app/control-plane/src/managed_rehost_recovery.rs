//! Finishes Hmux managed rehost operations that a client reserved but never
//! completed.
//!
//! The desktop client reserves a `managed_rehost_exact_fence_v1` operation in
//! the Hmux recovery journal and drives it to completion in the same process.
//! When that process dies first, or when continuation refuses
//! deterministically (after a host reboot the exact source Host's process
//! evidence can no longer be proven), the record stays `reserved`. Every
//! reader then fails closed with `hmux_managed_rehost_retry_required`, and
//! nothing else owns the record: journal GC protects pending operations and
//! agent recovery drives only this store's own transitions (hebbianai/dure#309).
//!
//! This task is the owner. It resumes each pending operation through the
//! runtime's `managed-rehost-reconcile` broker, which replays the journaled
//! intent without any client input, and expires an operation only when that
//! resumption refuses and the journal proves the operation never crossed its
//! destructive boundary. Expiry returns the source to `not_found` resolution,
//! so the pane's ordinary unavailable-Host recovery applies and the client can
//! admit the same operation again.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmux_client::ManagedSessionRehoster;
use hmux_client::recovery_journal::{
    ManagedRehostExpiry, PendingManagedRehostOperation, expire_pending_managed_rehost,
    pending_managed_rehost_operations,
};

use crate::{HmuxToolchainIdentity, ServiceState};

#[cfg(test)]
mod tests;

/// A reservation younger than this still belongs to the client that admitted
/// it: that client finishes it, or reports its refusal and retries itself.
const MINIMUM_PENDING_AGE: Duration = Duration::from_secs(5 * 60);
/// A pane that keeps hitting `retry_required` has no hub request of its own,
/// so a bounded rescan, not only a wake, limits how long it stays stranded.
const RESCAN_INTERVAL: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(5 * 60)
};

/// Runs for the service lifetime: one sweep at startup and after every wake
/// or rescan interval, only while this process is the mutation authority.
pub(crate) async fn run(state: Arc<ServiceState>) {
    loop {
        state.wait_for_mutation_authority().await;
        let resumer: Arc<dyn PendingRehostResumer> =
            Arc::new(RuntimeResumer::new(&state.hmux_identity));
        match sweep(
            state.hmux_identity.discovery_root.clone(),
            resumer,
            MINIMUM_PENDING_AGE,
        )
        .await
        {
            Ok(report) if report.changed() => {
                eprintln!("dure-control-plane: managed rehost recovery {report}");
            }
            Ok(_) => {}
            Err(code) => eprintln!("dure-control-plane: managed rehost recovery failed: {code}"),
        }
        tokio::select! {
            () = state.managed_rehost_recovery_wake.notified() => {}
            () = tokio::time::sleep(RESCAN_INTERVAL) => {}
        }
    }
}

/// Resumes one pending operation from its journaled intent. Production spawns
/// the Hmux runtime broker; tests script the outcome.
pub(crate) trait PendingRehostResumer: Send + Sync {
    fn resume(&self, operation: &PendingManagedRehostOperation) -> Result<(), ResumeFailure>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResumeFailure {
    pub(crate) code: String,
    pub(crate) message: String,
}

struct RuntimeResumer {
    runtime_executable: PathBuf,
    working_directory: PathBuf,
    discovery_root: PathBuf,
}

impl RuntimeResumer {
    fn new(identity: &HmuxToolchainIdentity) -> Self {
        Self {
            runtime_executable: identity.runtime_executable_path.clone(),
            working_directory: identity
                .runtime_executable_path
                .parent()
                .map_or_else(|| identity.discovery_root.clone(), Path::to_path_buf),
            discovery_root: identity.discovery_root.clone(),
        }
    }
}

impl PendingRehostResumer for RuntimeResumer {
    fn resume(&self, operation: &PendingManagedRehostOperation) -> Result<(), ResumeFailure> {
        let request = operation
            .reconcile_request()
            .map_err(|message| ResumeFailure {
                code: "hmux_recovery_journal_invalid".into(),
                message,
            })?;
        ManagedSessionRehoster::new(&self.runtime_executable, &self.working_directory)
            .with_discovery_root(&self.discovery_root)
            .reconcile(request)
            .map(|_| ())
            .map_err(|error| ResumeFailure {
                code: error.code().to_owned(),
                message: error.to_string(),
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Disposition {
    /// The operation has its receipt, or no longer exists.
    Finished,
    /// This attempt failed for a reason that describes the attempt, not the
    /// operation; the next sweep tries again.
    Retry,
    /// The runtime refused the journaled intent; it will not change on its own.
    Expire,
}

fn disposition(outcome: &Result<(), ResumeFailure>) -> Disposition {
    match outcome {
        Ok(()) => Disposition::Finished,
        Err(failure) => match failure.code.as_str() {
            "hmux_managed_rehost_intent_not_found" => Disposition::Finished,
            // A held operation lock, a runtime that could not start or answer,
            // and an unknown outcome may all hide a live or partly completed
            // operation whose receipt the journal has not recorded yet.
            "hmux_recovery_busy"
            | "hmux_managed_runtime_failed"
            | "hmux_managed_rehost_protocol"
            | "hmux_managed_rehost_outcome_unknown"
            | "hmux_recovery_journal_invalid" => Disposition::Retry,
            _ => Disposition::Expire,
        },
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SweepReport {
    /// Operations whose receipt now exists.
    pub(crate) resumed: usize,
    /// Reserved records removed because resumption refused and nothing
    /// destructive had happened.
    pub(crate) expired: usize,
    /// Pending operations left for the next sweep or for reconciliation.
    pub(crate) retained: usize,
    /// Reservations still owned by the client that admitted them.
    pub(crate) deferred: usize,
}

impl SweepReport {
    fn changed(&self) -> bool {
        self.resumed > 0 || self.expired > 0
    }
}

impl fmt::Display for SweepReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "resumed={} expired={} retained={} deferred={}",
            self.resumed, self.expired, self.retained, self.deferred
        )
    }
}

/// One pass over every pending managed rehost in `discovery_root`.
///
/// Journal reads, the runtime broker and expiry all block, so each runs on
/// the blocking pool. Operations are handled one at a time: the journal's
/// operation lock already serializes executors, and a sweep must not launch
/// several providers at once on a machine that is still coming back.
pub(crate) async fn sweep(
    discovery_root: PathBuf,
    resumer: Arc<dyn PendingRehostResumer>,
    minimum_age: Duration,
) -> Result<SweepReport, String> {
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "clock is out of range".to_string())?;
    let pending = {
        let root = discovery_root.clone();
        tokio::task::spawn_blocking(move || pending_managed_rehost_operations(&root))
            .await
            .map_err(|error| error.to_string())??
    };
    let mut report = SweepReport::default();
    for operation in pending {
        if operation.age(now_unix_ms) < minimum_age {
            report.deferred += 1;
            continue;
        }
        let outcome = {
            let resumer = Arc::clone(&resumer);
            let operation = operation.clone();
            tokio::task::spawn_blocking(move || resumer.resume(&operation))
                .await
                .map_err(|error| error.to_string())?
        };
        match disposition(&outcome) {
            Disposition::Finished => {
                report.resumed += 1;
                eprintln!(
                    "dure-control-plane: resumed stranded managed rehost {}",
                    operation.operation_id
                );
            }
            Disposition::Retry => report.retained += 1,
            Disposition::Expire if operation.progress_checkpointed => report.retained += 1,
            Disposition::Expire => {
                let failure = outcome.expect_err("expiry follows a refused resumption");
                let request = operation.reconcile_request()?;
                let expiry = {
                    let root = discovery_root.clone();
                    tokio::task::spawn_blocking(move || {
                        expire_pending_managed_rehost(&root, &request, minimum_age)
                    })
                    .await
                    .map_err(|error| error.to_string())??
                };
                if expiry == ManagedRehostExpiry::Expired {
                    report.expired += 1;
                    eprintln!(
                        "dure-control-plane: expired stranded managed rehost {} after {}: {}",
                        operation.operation_id, failure.code, failure.message
                    );
                } else {
                    report.retained += 1;
                }
            }
        }
    }
    Ok(report)
}
