//! One app-wide recovery authority; the channel-pinned CLI owns lifecycle writes.

use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{mpsc, watch};
use tokio::time::{Duration, Instant};

use crate::dure_backend_transport::BackendProfile;
use crate::dure_cli_install::{BackendReconcileError, ReconciledBackendAuthority};

const STABLE_RESET_AFTER: Duration = Duration::from_secs(30);
const RECOVERY_JOIN_TIMEOUT: Duration = Duration::from_secs(45);
const RETRY_DELAYS: [u64; 6] = [1, 2, 4, 8, 16, 30];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecoveryTicket {
    authority: BackendProfile,
    incident: u64,
}

#[derive(Clone, Debug)]
enum Phase {
    Starting,
    StartupFailed(&'static str),
    Ready(Option<BackendProfile>, u64),
    Recovering(RecoveryTicket),
}

pub(crate) struct BackendCoordinatorError(pub(crate) &'static str, pub(crate) &'static str);

fn startup_error(code: &'static str) -> BackendCoordinatorError {
    BackendCoordinatorError(
        code,
        "the local backend could not start; check the CLI installation and retry",
    )
}

struct Shared {
    transition: StdMutex<()>,
    phase: watch::Sender<Phase>,
    requests: mpsc::Sender<RecoveryTicket>,
}

#[derive(Clone)]
pub(crate) struct ManagedBackendCoordinatorHandle(Arc<Shared>);

fn coordinator_channel(
    phase: Phase,
) -> (
    ManagedBackendCoordinatorHandle,
    mpsc::Receiver<RecoveryTicket>,
) {
    let (requests, receiver) = mpsc::channel(1);
    let (publisher, _) = watch::channel(phase);
    let handle = ManagedBackendCoordinatorHandle(Arc::new(Shared {
        transition: StdMutex::new(()),
        phase: publisher,
        requests,
    }));
    (handle, receiver)
}

impl ManagedBackendCoordinatorHandle {
    pub(crate) fn disabled() -> Self {
        coordinator_channel(Phase::Ready(None, 0)).0
    }

    #[cfg(test)]
    pub(crate) fn starting_for_test() -> Self {
        coordinator_channel(Phase::Starting).0
    }

    #[cfg(test)]
    pub(crate) fn ready_for_test(
        profile: BackendProfile,
    ) -> (Self, mpsc::Receiver<RecoveryTicket>) {
        coordinator_channel(Phase::Ready(Some(profile), 0))
    }

    #[cfg(test)]
    pub(crate) fn complete_for_test(
        &self,
        ticket: &RecoveryTicket,
        authority: BackendProfile,
    ) {
        self.publish(Phase::Ready(Some(authority), ticket.incident));
    }

    #[cfg(test)]
    pub(crate) fn complete_startup_for_test(&self, authority: BackendProfile) {
        self.publish(Phase::Ready(Some(authority), 0));
    }

    async fn wait_until(
        &self,
        timeout: Duration,
        classify: impl Fn(&Phase) -> Option<Result<(), BackendCoordinatorError>>,
    ) -> Result<(), BackendCoordinatorError> {
        let deadline = Instant::now() + timeout;
        let mut receiver = self.0.phase.subscribe();
        loop {
            if let Some(result) = classify(&receiver.borrow()) {
                return result;
            }
            tokio::time::timeout_at(deadline, receiver.changed())
                .await
                .map_err(|_| {
                    BackendCoordinatorError(
                        "backend_transport_recovery_timeout",
                        "managed backend recovery timed out; check the local backend configuration",
                    )
                })?
                .map_err(|_| {
                    BackendCoordinatorError(
                        "backend_transport_recovery_unavailable",
                        "managed backend recovery is unavailable",
                    )
                })?;
        }
    }

    /// Join the existing startup transition instead of racing its catalog publication.
    pub(crate) async fn wait_for_startup(&self) -> Result<(), BackendCoordinatorError> {
        let mut receiver = self.0.phase.subscribe();
        loop {
            match *receiver.borrow_and_update() {
                Phase::Starting => {}
                Phase::StartupFailed(code) => return Err(startup_error(code)),
                _ => return Ok(()),
            }
            receiver.changed().await.map_err(|_| {
                BackendCoordinatorError(
                    "backend_transport_startup_unavailable",
                    "managed backend startup is unavailable",
                )
            })?;
        }
    }

    pub(crate) async fn wait_before_request(
        &self,
        profile: &BackendProfile,
    ) -> Result<(), BackendCoordinatorError> {
        self.wait_until(profile.deadline(), |phase| match phase {
            Phase::Starting => None,
            Phase::StartupFailed(code) => Some(Err(startup_error(code))),
            Phase::Recovering(ticket) if ticket.authority.same_profile_id(profile) => None,
            _ => Some(Ok(())),
        })
        .await
    }

    pub(crate) fn begin_recovery(&self, profile: &BackendProfile) -> Option<RecoveryTicket> {
        let _transition = self.0.transition.lock().ok()?;
        let phase = self.0.phase.borrow().clone();
        match phase {
            Phase::Recovering(ticket) if ticket.authority.same_profile_id(profile) => Some(ticket),
            Phase::Ready(Some(authority), completed) if authority.same_profile_id(profile) => {
                let ticket = RecoveryTicket {
                    authority,
                    incident: completed.saturating_add(1),
                };
                self.0.phase.send_replace(Phase::Recovering(ticket.clone()));
                if self.0.requests.try_send(ticket.clone()).is_ok() {
                    Some(ticket)
                } else {
                    self.0
                        .phase
                        .send_replace(Phase::Ready(Some(ticket.authority), completed));
                    None
                }
            }
            _ => None,
        }
    }

    pub(crate) async fn wait_for_recovery(
        &self,
        ticket: &RecoveryTicket,
    ) -> Result<(), BackendCoordinatorError> {
        self.wait_until(RECOVERY_JOIN_TIMEOUT, |phase| match phase {
            Phase::Ready(Some(authority), completed)
                if authority.same_profile_id(&ticket.authority)
                    && *completed >= ticket.incident =>
            {
                Some(Ok(()))
            }
            Phase::Recovering(current)
                if current.authority.same_profile_id(&ticket.authority)
                    && current.incident == ticket.incident =>
            {
                None
            }
            Phase::Starting => None,
            _ => Some(Err(BackendCoordinatorError(
                "backend_transport_recovery_authority_changed",
                "the managed backend authority changed during recovery",
            ))),
        })
        .await
    }

    fn publish(&self, phase: Phase) {
        if let Ok(_transition) = self.0.transition.lock() {
            self.0.phase.send_replace(phase);
        }
    }
}

pub(crate) struct DureBackendCoordinator {
    handle: ManagedBackendCoordinatorHandle,
    receiver: StdMutex<Option<mpsc::Receiver<RecoveryTicket>>>,
}

impl DureBackendCoordinator {
    pub(crate) fn new() -> Self {
        let (handle, receiver) = coordinator_channel(Phase::Starting);
        Self {
            handle,
            receiver: StdMutex::new(Some(receiver)),
        }
    }

    pub(crate) fn handle(&self) -> ManagedBackendCoordinatorHandle {
        self.handle.clone()
    }

    pub(crate) fn start(&self, resource_dir: std::path::PathBuf) -> Result<(), String> {
        let receiver = self
            .receiver
            .lock()
            .map_err(|_| "Dure backend coordinator state is unavailable".to_string())?
            .take()
            .ok_or_else(|| "Dure backend coordinator was already started".to_string())?;
        tauri::async_runtime::spawn(run(self.handle.clone(), receiver, resource_dir));
        Ok(())
    }
}

async fn reconcile(
    expected: Option<BackendProfile>,
    resource_dir: std::path::PathBuf,
) -> Result<ReconciledBackendAuthority, BackendReconcileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let channel =
            crate::app_channel::current_name().map_err(|error| BackendReconcileError {
                code: "backend_reconcile_channel_unavailable",
                message: error.to_string(),
            })?;
        if expected.is_none() {
            crate::dure_cli_install::prepare_startup_channel(&channel, &resource_dir).map_err(
                |message| BackendReconcileError {
                    code: "backend_reconcile_cli_bootstrap_failed",
                    message,
                },
            )?;
        }
        let reconciled = crate::dure_cli_install::reconcile_backend_from_current_channel(
            &channel,
            expected.as_ref().map(BackendProfile::id),
        )?;
        Ok(reconciled)
    })
    .await
    .unwrap_or_else(|error| {
        Err(BackendReconcileError {
            code: "backend_reconcile_task_failed",
            message: format!("Dure backend reconciliation task failed: {error}"),
        })
    })
}

fn retry_delay(failures: u32) -> Duration {
    failures.checked_sub(1).map_or(Duration::ZERO, |index| {
        Duration::from_secs(RETRY_DELAYS[(index as usize).min(RETRY_DELAYS.len() - 1)])
    })
}

async fn reconcile_until<F, Fut>(
    handle: &ManagedBackendCoordinatorHandle,
    expected: Option<BackendProfile>,
    failures: &mut u32,
    mut attempt: F,
) -> ReconciledBackendAuthority
where
    F: FnMut(Option<BackendProfile>) -> Fut,
    Fut: std::future::Future<Output = Result<ReconciledBackendAuthority, BackendReconcileError>>,
{
    loop {
        match attempt(expected.clone()).await {
            Ok(reconciled) => return reconciled,
            Err(error) => {
                if expected.is_none() {
                    handle.publish(Phase::StartupFailed(error.code));
                }
                *failures = failures.saturating_add(1);
                eprintln!(
                    "dure: backend reconcile failed: {}: {}",
                    error.code, error.message
                );
                tokio::time::sleep(retry_delay(*failures)).await;
            }
        }
    }
}

async fn run(
    handle: ManagedBackendCoordinatorHandle,
    mut receiver: mpsc::Receiver<RecoveryTicket>,
    resource_dir: std::path::PathBuf,
) {
    let mut failures = 0;
    let startup = reconcile_until(&handle, None, &mut failures, |expected| {
        reconcile(expected, resource_dir.clone())
    })
    .await;
    handle.publish(Phase::Ready(startup.managed_authority, 0));
    let mut ready_since = Instant::now();
    while let Some(ticket) = receiver.recv().await {
        failures = if ready_since.elapsed() >= STABLE_RESET_AFTER {
            0
        } else {
            failures.saturating_add(1)
        };
        tokio::time::sleep(retry_delay(failures)).await;
        let recovered = reconcile_until(&handle, Some(ticket.authority), &mut failures, |expected| {
            reconcile(expected, resource_dir.clone())
        })
        .await;
        handle.publish(Phase::Ready(recovered.managed_authority, ticket.incident));
        ready_since = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn failed_startup_settles_waiters_and_a_later_success_restores_readiness() {
        let (handle, _requests) = coordinator_channel(Phase::Starting);
        let waiting = handle.wait_for_startup();
        tokio::pin!(waiting);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err());

        let (failed_tx, failed_rx) = oneshot::channel();
        let (recover_tx, recover_rx) = oneshot::channel();
        let worker_handle = handle.clone();
        let worker = tokio::spawn(async move {
            let mut failed_tx = Some(failed_tx);
            let mut recover_rx = Some(recover_rx);
            let mut failures = 0;
            let result = reconcile_until(&worker_handle, None, &mut failures, |_| {
                let failure = failed_tx.take();
                let recovery = if failure.is_none() {
                    recover_rx.take()
                } else {
                    None
                };
                async move {
                    if let Some(failed) = failure {
                        failed.send(()).unwrap();
                        return Err(BackendReconcileError {
                            code: "backend_reconcile_cli_bootstrap_failed",
                            message: "the previous CLI cannot be activated".into(),
                        });
                    }
                    recovery.unwrap().await.unwrap();
                    Ok(ReconciledBackendAuthority {
                        managed_authority: None,
                    })
                }
            })
            .await;
            worker_handle.publish(Phase::Ready(result.managed_authority, 0));
            failures
        });

        failed_rx.await.unwrap();
        let result = tokio::time::timeout(Duration::from_millis(100), &mut waiting)
            .await
            .expect("a reported bootstrap failure must not leave the original request pending");
        assert_eq!(
            result.expect_err("startup failed").0,
            "backend_reconcile_cli_bootstrap_failed"
        );
        let retry = tokio::time::timeout(Duration::from_millis(100), handle.wait_for_startup())
            .await
            .expect("a new request must see the current startup failure");
        assert_eq!(
            retry.expect_err("startup still failed").0,
            "backend_reconcile_cli_bootstrap_failed"
        );

        recover_tx.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), worker)
                .await
                .unwrap()
                .unwrap(),
            1
        );
        assert!(handle.wait_for_startup().await.is_ok());
    }
}
