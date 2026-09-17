#[cfg(unix)]
use crate::runtime_diagnostics::broker_timing::{self, Phase};
use hmux_client::recovery_journal::managed_stop::{
    completed_receipt, decode_completed_request, decode_receipt, identity,
    validate_reconcile_receipt, validate_reconcile_request,
};
use hmux_client::recovery_journal::{
    MANAGED_STOP_RECOVERY_ACTION, PreparedRecoveryIdentity, RecoveryCompletion,
    RecoveryJournalGcPolicy, RecoveryReservation, RecoveryReservationState,
    existing_operation::reopen_prepared, garbage_collect_completed_action,
    reserve_prepared_observed,
};
use hmux_runtime_contract::{ManagedStopReceipt, ManagedStopReconcileRequest, ManagedStopRequest};
use std::fmt;
use std::path::Path;

const MANAGED_STOP_ACTION: &str = MANAGED_STOP_RECOVERY_ACTION;

#[derive(Debug)]
pub(crate) enum ManagedStopIntentError {
    Refused(String),
    OutcomeUnknown(String),
    NotFound(String),
    Capacity(String),
}

impl ManagedStopIntentError {
    pub(crate) fn outcome_unknown(&self) -> bool {
        matches!(self, Self::OutcomeUnknown(_))
    }

    pub(crate) fn not_found(&self) -> bool {
        matches!(self, Self::NotFound(_))
    }

    pub(crate) fn capacity(&self) -> bool {
        matches!(self, Self::Capacity(_))
    }
}

impl fmt::Display for ManagedStopIntentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(message)
            | Self::OutcomeUnknown(message)
            | Self::NotFound(message)
            | Self::Capacity(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ManagedStopIntentError {}

pub(crate) enum ManagedStopIntent {
    Pending(ManagedStopIntentGuard),
    Checkpointed {
        receipt: ManagedStopReceipt,
        intent: ManagedStopIntentGuard,
    },
    Resume {
        request: ManagedStopRequest,
        intent: ManagedStopIntentGuard,
    },
    Completed(ManagedStopReceipt),
    Refused,
}

pub(crate) struct ManagedStopIntentGuard {
    reservation: RecoveryReservation,
}

pub(crate) fn acquire(
    discovery_root: &Path,
    request: &ManagedStopRequest,
) -> Result<ManagedStopIntent, ManagedStopIntentError> {
    request
        .validate_complete_fence()
        .map_err(|error| invalid(format!("managed stop intent is invalid: {error}")))?;
    let canonical_payload = serde_json::to_string(request)
        .map_err(|error| invalid(format!("serialize managed stop intent failed: {error}")))?;
    let identity = identity(
        request.stop_id(),
        request.session_id(),
        request.workspace_id(),
    );
    match reserve_with_capacity_maintenance(discovery_root, identity, canonical_payload).map_err(
        |error| {
            if is_capacity_error(&error) {
                capacity(error)
            } else if error.starts_with("hmux_recovery_busy:")
                || error.starts_with("hmux_recovery_journal_invalid:")
                || error.starts_with("hmux_recovery_journal_failed:")
            {
                outcome_unknown(error)
            } else {
                invalid(error)
            }
        },
    )? {
        RecoveryReservationState::Pending(reservation) => {
            if let Some(serialized) = reservation
                .operation_checkpoint()
                .and_then(|checkpoint| checkpoint.source_stop_receipt.as_deref())
                .map(str::to_string)
            {
                let receipt = decode_receipt(&serialized).map_err(outcome_unknown)?;
                validate_receipt(request, &receipt)?;
                return Ok(ManagedStopIntent::Checkpointed {
                    receipt,
                    intent: ManagedStopIntentGuard { reservation },
                });
            }
            if reservation.was_existing() {
                let stored = decode_pending_request(&reservation)?;
                return Ok(ManagedStopIntent::Resume {
                    request: stored,
                    intent: ManagedStopIntentGuard { reservation },
                });
            }
            Ok(ManagedStopIntent::Pending(ManagedStopIntentGuard {
                reservation,
            }))
        }
        RecoveryReservationState::Completed(completion) => {
            if completion.outcome == "refused_precondition" {
                return Ok(ManagedStopIntent::Refused);
            }
            let receipt = completed_receipt(&completion).map_err(outcome_unknown)?;
            validate_receipt(request, &receipt)?;
            Ok(ManagedStopIntent::Completed(receipt))
        }
    }
}

fn reserve_with_capacity_maintenance(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    canonical_payload: String,
) -> Result<RecoveryReservationState, String> {
    let reserved = reserve_timed(
        discovery_root,
        identity.clone(),
        canonical_payload.clone(),
        #[cfg(unix)]
        Phase::StopReservation,
    );
    match reserved {
        // Semantic stop pressure is already handled in one journal admission.
        // Only raw journal overflow still needs the bounded repair path.
        Err(error)
            if is_capacity_error(&error)
                && !error.starts_with("hmux_recovery_managed_stop_capacity_exceeded:") =>
        {
            {
                #[cfg(unix)]
                let _phase = broker_timing::phase(Phase::StopCapacityMaintenance);
                garbage_collect_completed_action(
                    discovery_root,
                    MANAGED_STOP_ACTION,
                    RecoveryJournalGcPolicy::managed_stop_capacity(),
                )?;
            }
            reserve_timed(
                discovery_root,
                identity,
                canonical_payload,
                #[cfg(unix)]
                Phase::StopReservationAfterMaintenance,
            )
        }
        result => result,
    }
}

fn reserve_timed(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    canonical_payload: String,
    #[cfg(unix)] phase: Phase,
) -> Result<RecoveryReservationState, String> {
    #[cfg(unix)]
    let timing = broker_timing::phase(phase);
    reserve_prepared_observed(discovery_root, identity, Some(canonical_payload), |_step| {
        #[cfg(unix)]
        {
            timing.reservation_step(_step)
        }
    })
}

pub(crate) fn reconcile(
    discovery_root: &Path,
    request: &ManagedStopReconcileRequest,
) -> Result<ManagedStopIntent, ManagedStopIntentError> {
    #[cfg(unix)]
    let _phase = broker_timing::phase(Phase::StopReconcile);
    request
        .validate()
        .map_err(|error| invalid(format!("managed stop reconcile is invalid: {error}")))?;
    let state = match reopen_prepared(
        discovery_root,
        &identity(
            request.stop_id(),
            request.session_id(),
            request.workspace_id(),
        ),
    ) {
        Ok(Some(state)) => state,
        Ok(None) => {
            return hmux_client::recovery_journal::managed_create_ledger::final_stop_receipt(
                discovery_root,
                request,
            )
            .map_err(outcome_unknown)?
            .map(ManagedStopIntent::Completed)
            .ok_or_else(|| not_found("no durable managed stop intent exists"));
        }
        Err(error) => {
            if error.starts_with("hmux_recovery_busy:")
                || error.starts_with("hmux_recovery_journal_invalid:")
                || error.starts_with("hmux_recovery_journal_failed:")
            {
                return Err(outcome_unknown(error));
            }
            return Err(invalid(error));
        }
    };
    match state {
        RecoveryReservationState::Completed(completion) => {
            let stored = decode_completed_request(&completion).map_err(outcome_unknown)?;
            validate_reconcile_request(request, &stored).map_err(outcome_unknown)?;
            if completion.outcome == "refused_precondition" {
                return Ok(ManagedStopIntent::Refused);
            }
            let receipt = completed_receipt(&completion).map_err(outcome_unknown)?;
            validate_reconcile_receipt(request, &receipt).map_err(outcome_unknown)?;
            Ok(ManagedStopIntent::Completed(receipt))
        }
        RecoveryReservationState::Pending(reservation) => {
            let stored = decode_pending_request(&reservation)?;
            validate_reconcile_request(request, &stored).map_err(outcome_unknown)?;
            if let Some(serialized) = reservation
                .operation_checkpoint()
                .and_then(|checkpoint| checkpoint.source_stop_receipt.as_deref())
                .map(str::to_string)
            {
                let receipt = decode_receipt(&serialized).map_err(outcome_unknown)?;
                validate_reconcile_receipt(request, &receipt).map_err(outcome_unknown)?;
                return Ok(ManagedStopIntent::Checkpointed {
                    receipt,
                    intent: ManagedStopIntentGuard { reservation },
                });
            }
            Ok(ManagedStopIntent::Resume {
                request: stored,
                intent: ManagedStopIntentGuard { reservation },
            })
        }
    }
}

pub(crate) fn reconciliation_exists(
    discovery_root: &Path,
    request: &ManagedStopReconcileRequest,
) -> Result<bool, ManagedStopIntentError> {
    request
        .validate()
        .map_err(|error| invalid(format!("managed stop reconcile is invalid: {error}")))?;
    let identity = identity(
        request.stop_id(),
        request.session_id(),
        request.workspace_id(),
    );
    if hmux_client::recovery_journal::prepared_operation_exists(discovery_root, &identity)
        .map_err(outcome_unknown)?
    {
        return Ok(true);
    }
    hmux_client::recovery_journal::managed_create_ledger::final_stop_receipt(
        discovery_root,
        request,
    )
    .map(|receipt| receipt.is_some())
    .map_err(outcome_unknown)
}

fn decode_pending_request(
    reservation: &RecoveryReservation,
) -> Result<ManagedStopRequest, ManagedStopIntentError> {
    let serialized = reservation
        .operation_checkpoint()
        .map(|checkpoint| checkpoint.canonical_payload.as_str())
        .ok_or_else(|| outcome_unknown("managed stop pending intent has no canonical request"))?;
    let stored: ManagedStopRequest = serde_json::from_str(serialized).map_err(|error| {
        outcome_unknown(format!(
            "decode pending managed stop request failed: {error}"
        ))
    })?;
    stored.validate_complete_fence().map_err(|error| {
        outcome_unknown(format!("pending managed stop request is invalid: {error}"))
    })?;
    Ok(stored)
}

impl ManagedStopIntentGuard {
    pub(crate) fn checkpoint_receipt(
        &mut self,
        request: &ManagedStopRequest,
        receipt: &ManagedStopReceipt,
    ) -> Result<(), ManagedStopIntentError> {
        validate_receipt(request, receipt)?;
        let serialized = serde_json::to_string(receipt)
            .map_err(|error| invalid(format!("serialize managed stop receipt failed: {error}")))?;
        self.reservation
            .checkpoint_source_stop_receipt(serialized)
            .map_err(outcome_unknown)
    }

    pub(crate) fn finish_checkpointed(
        &mut self,
        receipt: &ManagedStopReceipt,
    ) -> Result<(), ManagedStopIntentError> {
        let stored = self
            .reservation
            .operation_checkpoint()
            .and_then(|checkpoint| checkpoint.source_stop_receipt.as_deref())
            .ok_or_else(|| outcome_unknown("managed stop receipt was not checkpointed"))?;
        let stored = decode_receipt(stored).map_err(outcome_unknown)?;
        if stored != *receipt {
            return Err(outcome_unknown(
                "managed stop checkpoint changed before completion",
            ));
        }
        finish_reservation(&mut self.reservation, &stored)
    }

    pub(crate) fn refuse(
        &mut self,
        request: &ManagedStopRequest,
    ) -> Result<(), ManagedStopIntentError> {
        self.reservation
            .complete(RecoveryCompletion {
                target_session_id: request.session_id().to_string(),
                target_workspace_id: request.workspace_id().to_string(),
                target_build_id: "precondition".to_string(),
                action: MANAGED_STOP_ACTION.to_string(),
                outcome: "refused_precondition".to_string(),
                resume_checkpoint: None,
                operation_checkpoint: None,
            })
            .map_err(outcome_unknown)
    }
}

fn finish_reservation(
    reservation: &mut RecoveryReservation,
    receipt: &ManagedStopReceipt,
) -> Result<(), ManagedStopIntentError> {
    reservation
        .complete(RecoveryCompletion {
            target_session_id: receipt.session_id().to_string(),
            target_workspace_id: receipt.workspace_id().to_string(),
            target_build_id: format!(
                "{}:{}",
                receipt.host_instance_id(),
                receipt.terminal_epoch()
            ),
            action: MANAGED_STOP_ACTION.to_string(),
            outcome: match receipt.outcome() {
                hmux_runtime_contract::ManagedStopOutcome::Stopped => "stopped",
                hmux_runtime_contract::ManagedStopOutcome::AlreadyExited => "already_exited",
            }
            .to_string(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .map_err(outcome_unknown)
}

fn validate_receipt(
    request: &ManagedStopRequest,
    receipt: &ManagedStopReceipt,
) -> Result<(), ManagedStopIntentError> {
    if receipt.stop_id() != request.stop_id()
        || receipt.session_id() != request.session_id()
        || receipt.workspace_id() != request.workspace_id()
        || request.expected_runner_principal() != Some(receipt.runner_principal())
        || request.expected_runner_instance() != Some(receipt.runner_instance())
        || request.expected_channel_epoch() != Some(receipt.channel_epoch())
        || request.expected_host_instance_id() != Some(receipt.host_instance_id())
        || request.expected_terminal_epoch() != Some(receipt.terminal_epoch())
    {
        return Err(outcome_unknown(
            "managed stop receipt does not match the exact durable intent",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> ManagedStopIntentError {
    ManagedStopIntentError::Refused(message.into())
}

fn outcome_unknown(message: impl Into<String>) -> ManagedStopIntentError {
    ManagedStopIntentError::OutcomeUnknown(message.into())
}

fn not_found(message: impl Into<String>) -> ManagedStopIntentError {
    ManagedStopIntentError::NotFound(message.into())
}

fn capacity(message: impl Into<String>) -> ManagedStopIntentError {
    ManagedStopIntentError::Capacity(message.into())
}

fn is_capacity_error(error: &str) -> bool {
    error.starts_with("hmux_recovery_managed_stop_capacity_exceeded:")
        || error.starts_with("hmux_recovery_journal_capacity_exceeded:")
        || error.starts_with("hmux_recovery_journal_capacity:")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use hmux_client::ProcessDescriptor;
    use hmux_client::recovery_journal::managed_create_ledger::{self, ManagedCreateLedgerState};
    use hmux_runtime_contract::{
        ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
        ManagedStopOutcome, PermissionMode,
    };
    use std::fs;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::time::Duration;

    fn private_state() -> tempfile::TempDir {
        let state = tempfile::tempdir().unwrap();
        fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700)).unwrap();
        state
    }

    fn request(stop_id: &str, terminal_epoch: &str) -> ManagedStopRequest {
        ManagedStopRequest::new(stop_id, "session-1", "workspace-1")
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "host-1", terminal_epoch)
            .unwrap()
    }

    fn receipt(request: &ManagedStopRequest) -> ManagedStopReceipt {
        ManagedStopReceipt::from_request(
            request,
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap()
    }

    #[test]
    fn absent_reconciliation_does_not_register_new_intent() {
        let state = private_state();
        let exact = request("stop-absent", "terminal-1");
        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&exact).unwrap();
        assert!(
            reconcile(state.path(), &reconciliation)
                .err()
                .unwrap()
                .not_found()
        );
        assert!(!state.path().join(".recovery").exists());
        assert!(matches!(
            acquire(state.path(), &exact).unwrap(),
            ManagedStopIntent::Pending(_)
        ));
    }

    #[test]
    fn exact_retry_reuses_the_durable_completed_receipt() {
        let state = private_state();
        let exact = request("stop-1", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        let expected = receipt(&exact);
        intent.checkpoint_receipt(&exact, &expected).unwrap();
        intent.finish_checkpointed(&expected).unwrap();
        drop(intent);

        let ManagedStopIntent::Completed(repeated) = acquire(state.path(), &exact).unwrap() else {
            panic!("retry must return the durable receipt")
        };
        assert_eq!(repeated, expected);
    }

    #[test]
    fn compacted_stop_journal_replays_from_the_permanent_create_ledger() {
        let state = private_state();
        let ManagedCreateLedgerState::Prepared(mut create) = managed_create_ledger::reserve(
            state.path(),
            "workspace-1",
            "session-1",
            "create-1",
            &"01".repeat(32),
        )
        .unwrap() else {
            panic!("managed create lineage must be prepared")
        };
        create.checkpoint_pre_spawn_absence().unwrap();
        create
            .mark_spawn_reserved(ProcessDescriptor {
                process_id: 101,
                start_marker: "exact-host-101".into(),
            })
            .unwrap();
        create.release_with_barrier_proof().unwrap();
        let created = ManagedCreateReceipt::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            state.path(),
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "terminal-1")
                .unwrap(),
        )
        .unwrap();
        create
            .complete(serde_json::to_string(&created).unwrap())
            .unwrap();

        let exact = request("stop-compacted", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first stop must reserve an intent")
        };
        let expected = receipt(&exact);
        intent.checkpoint_receipt(&exact, &expected).unwrap();
        managed_create_ledger::checkpoint_retirement_exact(state.path(), &expected).unwrap();
        managed_create_ledger::finalize_retirement_exact(state.path(), &expected).unwrap();
        intent.finish_checkpointed(&expected).unwrap();
        drop(intent);
        garbage_collect_completed_action(
            state.path(),
            MANAGED_STOP_ACTION,
            RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                ..RecoveryJournalGcPolicy::default()
            },
        )
        .unwrap();

        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&exact).unwrap();
        assert!(matches!(
            reconcile(state.path(), &reconciliation).unwrap(),
            ManagedStopIntent::Completed(receipt) if receipt == expected
        ));
    }

    #[test]
    fn completed_reconcile_rejects_any_changed_runner_fence_field() {
        let state = private_state();
        let exact = request("stop-full-fence", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        let expected = receipt(&exact);
        intent.checkpoint_receipt(&exact, &expected).unwrap();
        intent.finish_checkpointed(&expected).unwrap();
        drop(intent);

        let changed =
            ManagedStopRequest::new(exact.stop_id(), exact.session_id(), exact.workspace_id())
                .unwrap()
                .with_expected_fence(
                    "principal-2",
                    exact.expected_runner_instance().unwrap(),
                    exact.expected_channel_epoch().unwrap(),
                    exact.expected_host_instance_id().unwrap(),
                    exact.expected_terminal_epoch().unwrap(),
                )
                .unwrap();
        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&changed).unwrap();
        let error = reconcile(state.path(), &reconciliation)
            .err()
            .expect("changed runner principal must not replay the old stop receipt");
        assert!(error.outcome_unknown(), "{error}");
    }

    #[test]
    fn receipt_checkpoint_requires_explicit_saga_completion_on_retry() {
        let state = private_state();
        let exact = request("stop-checkpoint", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        let expected = receipt(&exact);
        intent
            .reservation
            .checkpoint_source_stop_receipt(serde_json::to_string(&expected).unwrap())
            .unwrap();
        drop(intent);

        let ManagedStopIntent::Checkpointed {
            receipt: repeated,
            mut intent,
        } = acquire(state.path(), &exact).unwrap()
        else {
            panic!("checkpointed receipt must resume finalization")
        };
        assert_eq!(repeated, expected);
        intent.finish_checkpointed(&repeated).unwrap();
        drop(intent);

        assert!(matches!(
            acquire(state.path(), &exact).unwrap(),
            ManagedStopIntent::Completed(receipt) if receipt == expected
        ));
    }

    #[test]
    fn pre_ledger_stop_resumes_after_retirement_checkpoint_response_loss() {
        let state = private_state();
        let ManagedCreateLedgerState::Prepared(create) = managed_create_ledger::reserve(
            state.path(),
            "workspace-1",
            "session-1",
            "create-pre-ledger",
            &"02".repeat(32),
        )
        .unwrap() else {
            panic!("pre-ledger compatibility record must be prepared")
        };
        let exact = request("stop-pre-ledger", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        let expected = receipt(&exact);
        intent.checkpoint_receipt(&exact, &expected).unwrap();
        managed_create_ledger::checkpoint_retirement_exact(state.path(), &expected).unwrap();
        drop((create, intent));

        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&exact).unwrap();
        let ManagedStopIntent::Checkpointed {
            receipt: repeated,
            mut intent,
        } = reconcile(state.path(), &reconciliation).unwrap()
        else {
            panic!("response-loss retry must recover the checkpointed exact receipt")
        };
        assert_eq!(repeated, expected);
        managed_create_ledger::checkpoint_retirement_exact(state.path(), &repeated).unwrap();
        managed_create_ledger::finalize_retirement_exact(state.path(), &repeated).unwrap();
        intent.finish_checkpointed(&repeated).unwrap();
        drop(intent);

        assert!(matches!(
            managed_create_ledger::reserve(
                state.path(),
                "workspace-1",
                "session-1",
                "create-pre-ledger",
                &"02".repeat(32),
            )
            .unwrap(),
            ManagedCreateLedgerState::Retired,
        ));
        assert!(matches!(
            reconcile(state.path(), &reconciliation).unwrap(),
            ManagedStopIntent::Completed(receipt) if receipt == expected
        ));
    }

    #[test]
    fn pending_without_receipt_resumes_from_the_canonical_request() {
        let state = private_state();
        let exact = request("stop-resume", "terminal-1");
        let ManagedStopIntent::Pending(intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        drop(intent);

        let reconciliation_request =
            ManagedStopReconcileRequest::from_stop_request(&exact).unwrap();
        let ManagedStopIntent::Resume {
            request: stored,
            intent,
        } = reconcile(state.path(), &reconciliation_request).unwrap()
        else {
            panic!("pending request must be resumable")
        };

        assert_eq!(stored, exact);
        assert!(intent.reservation.was_existing());
    }

    #[test]
    fn raw_journal_debris_is_reclaimed_before_managed_stop_admission() {
        let state = private_state();
        let recovery = state.path().join(".recovery");
        fs::create_dir(&recovery).unwrap();
        fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).unwrap();
        let digest = "a".repeat(32);
        for index in 0..=4_096 {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(recovery.join(format!(".gc-operation_{digest}-capacity-{index}.tmp")))
                .unwrap();
        }

        let ManagedStopIntent::Pending(intent) =
            acquire(state.path(), &request("stop-after-debris", "terminal-1")).unwrap()
        else {
            panic!("safe raw debris maintenance must restore managed-stop admission")
        };
        drop(intent);
        assert!(fs::read_dir(&recovery).unwrap().count() < 4_096);
    }

    #[test]
    fn one_stop_id_cannot_retarget_a_replacement_generation() {
        let state = private_state();
        let exact = request("stop-1", "terminal-1");
        let ManagedStopIntent::Pending(intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        drop(intent);

        let error = acquire(state.path(), &request("stop-1", "terminal-2"))
            .err()
            .expect("replacement fence is refused");

        assert!(
            error
                .to_string()
                .contains("canonical operation payload changed")
        );
    }

    #[test]
    fn legacy_stop_cannot_enter_the_durable_journal() {
        let state = private_state();
        let legacy = ManagedStopRequest::new("stop-1", "session-1", "workspace-1").unwrap();

        let error = acquire(state.path(), &legacy)
            .err()
            .expect("legacy request is refused");

        assert!(error.to_string().contains("complete fence"));
        assert!(!state.path().join(".recovery").exists());
    }

    #[test]
    fn precondition_refusal_is_terminal_and_retryable() {
        let state = private_state();
        let exact = request("stop-refused", "terminal-1");
        let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &exact).unwrap() else {
            panic!("first request must reserve an intent")
        };
        intent.refuse(&exact).unwrap();
        drop(intent);

        assert!(matches!(
            acquire(state.path(), &exact).unwrap(),
            ManagedStopIntent::Refused
        ));
    }

    #[test]
    fn identical_stop_ids_are_namespaced_by_logical_session() {
        let state = private_state();
        let first = request("shared-stop", "terminal-1");
        let ManagedStopIntent::Pending(first_intent) = acquire(state.path(), &first).unwrap()
        else {
            panic!("first session must reserve an intent")
        };
        drop(first_intent);
        let second = ManagedStopRequest::new("shared-stop", "session-2", "workspace-2")
            .unwrap()
            .with_expected_fence("principal-2", "runner-2", 9, "host-2", "terminal-2")
            .unwrap();

        assert!(matches!(
            acquire(state.path(), &second).unwrap(),
            ManagedStopIntent::Pending(_)
        ));
    }

    #[test]
    fn recent_completed_stops_apply_pressure_gc_before_the_next_admission() {
        let state = private_state();
        for index in 0..=512 {
            let request = ManagedStopRequest::new(
                format!("stop-{index}"),
                format!("session-{index}"),
                "workspace-1",
            )
            .unwrap()
            .with_expected_fence(
                "principal-1",
                "runner-1",
                7,
                format!("host-{index}"),
                format!("terminal-{index}"),
            )
            .unwrap();
            let ManagedStopIntent::Pending(mut intent) = acquire(state.path(), &request).unwrap()
            else {
                panic!("new stop {index} must be admitted")
            };
            let receipt = receipt(&request);
            intent.checkpoint_receipt(&request, &receipt).unwrap();
            intent.finish_checkpointed(&receipt).unwrap();
        }
        let inspection = hmux_client::recovery_journal::inspect(state.path()).unwrap();
        assert!(
            inspection.completed_records
                <= RecoveryJournalGcPolicy::managed_stop_capacity().maximum_completed_records + 1,
            "pressure GC must free one bounded admission slot"
        );
    }
}
