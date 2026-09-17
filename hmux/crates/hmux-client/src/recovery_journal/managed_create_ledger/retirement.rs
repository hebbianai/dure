use super::*;

/// Permanent retirement is independent of discovery and the bounded journal.
/// A missing ledger is a legacy observation, not proof of an absent process.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ManagedSessionRetirementObservation {
    NoLedger,
    NotFinalized,
    Finalized { receipt: Box<ManagedStopReceipt> },
}

/// Observe only this immutable logical identity. A final exact receipt does
/// not close its successor slot or grant authority over a successor session.
pub fn observe_session_retirement(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<ManagedSessionRetirementObservation, String> {
    let Some(record) = read_retirement_record(discovery_root, workspace_id, session_id)? else {
        return Ok(ManagedSessionRetirementObservation::NoLedger);
    };
    Ok(match persisted_final_stop(&record)? {
        Some(receipt) => ManagedSessionRetirementObservation::Finalized {
            receipt: Box::new(receipt),
        },
        None => ManagedSessionRetirementObservation::NotFinalized,
    })
}

/// Replays the final exact stop receipt after the bounded operation journal
/// has compacted it. The create ledger is permanent for the logical session,
/// so this lookup can never retarget a later generation.
pub fn final_stop_receipt(
    discovery_root: &Path,
    request: &ManagedStopReconcileRequest,
) -> Result<Option<ManagedStopReceipt>, String> {
    request
        .validate()
        .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let ManagedSessionRetirementObservation::Finalized { receipt } =
        observe_session_retirement(discovery_root, request.workspace_id(), request.session_id())?
    else {
        return Ok(None);
    };
    if receipt.session_id() != request.session_id()
        || receipt.workspace_id() != request.workspace_id()
        || receipt.runner_principal() != request.expected_runner_principal()
        || receipt.runner_instance() != request.expected_runner_instance()
        || receipt.channel_epoch() != request.expected_channel_epoch()
        || receipt.host_instance_id() != request.expected_host_instance_id()
        || receipt.terminal_epoch() != request.expected_terminal_epoch()
    {
        return Err(
            "hmux_managed_create_ledger_conflict: final stop receipt changed operation identity"
                .to_string(),
        );
    }
    if receipt.stop_id() != request.stop_id() {
        return Ok(None);
    }
    Ok(Some(*receipt))
}

fn persisted_final_stop(
    record: &ManagedCreateLedgerRecord,
) -> Result<Option<ManagedStopReceipt>, String> {
    let serialized = match &record.state {
        ManagedCreateLedgerRecordState::Completed {
            retired: true,
            retiring_stop_receipt: Some(receipt),
            ..
        }
        | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion {
            stop_receipt: receipt,
        } => receipt,
        _ => return Ok(None),
    };
    let receipt = decode_persisted_stop_receipt(
        serialized,
        "hmux_managed_create_ledger_invalid: final stop receipt is malformed",
    )?;
    if receipt.session_id() != record.session_id || receipt.workspace_id() != record.workspace_id {
        return Err(
            "hmux_managed_create_ledger_invalid: final stop receipt changed ledger identity".into(),
        );
    }
    if let ManagedCreateLedgerRecordState::Completed {
        receipt: create, ..
    } = &record.state
    {
        validate_completed_generation(create, &receipt)?;
    }
    Ok(Some(receipt))
}

/// Finalized retirement is durable even after a caller loses the replacement
/// response. The immutable create key selects the receipt; atomic tip closure
/// still rejects a competing successor without following or stopping it.
#[cfg(any(feature = "local-runtime", test))]
pub fn close_finalized_create(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateSuccessorChain>, ManagedCreateAdmissionError> {
    let Some(record) = read_retirement_record(
        discovery_root,
        identity.workspace_id(),
        identity.session_id(),
    )?
    else {
        return Ok(None);
    };
    if record.idempotency_key != identity.idempotency_key() {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_reconcile_authority_unavailable: idempotency identity changed"
                .into(),
        ));
    }
    let Some(receipt) = persisted_final_stop(&record)? else {
        return Ok(None);
    };
    close_stopped_identity(discovery_root, identity, &receipt)
}

/// Close only the finalized creation proved by this stop. The permanent ledger
/// owns its create key, so callers need no extra identity hint or manifest.
/// Legacy sessions without a create ledger have no successor slot to close.
#[cfg(any(feature = "local-runtime", test))]
pub fn close_stopped_creation(
    discovery_root: &Path,
    receipt: &ManagedStopReceipt,
) -> Result<Option<ManagedCreateSuccessorChain>, ManagedCreateAdmissionError> {
    receipt.validate().map_err(|error| {
        ManagedCreateAdmissionError::Ledger(format!("hmux_managed_create_ledger_invalid: {error}"))
    })?;
    let Some(record) =
        read_retirement_record(discovery_root, receipt.workspace_id(), receipt.session_id())?
    else {
        return Ok(None);
    };
    let identity = ManagedCreateReconcileRequest::new(
        record.idempotency_key,
        record.session_id,
        record.workspace_id,
    )
    .map_err(|error| ManagedCreateAdmissionError::Ledger(error.to_string()))?;
    close_stopped_identity(discovery_root, &identity, receipt)?
        .map(Some)
        .ok_or_else(|| {
            ManagedCreateAdmissionError::Ledger(
                "hmux_managed_create_close_conflict: stopped creation is not an exact finalized tip".to_string(),
            )
        })
}

#[cfg(any(feature = "local-runtime", test))]
fn close_stopped_identity(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
    receipt: &ManagedStopReceipt,
) -> Result<Option<ManagedCreateSuccessorChain>, ManagedCreateAdmissionError> {
    let fence = ManagedCreateGenerationFence::new(
        receipt.runner_principal(),
        receipt.runner_instance(),
        receipt.channel_epoch(),
        receipt.host_instance_id(),
        receipt.terminal_epoch(),
    )
    .map_err(|error| ManagedCreateAdmissionError::Ledger(error.to_string()))?;
    // This second, mutating boundary rechecks the exact finalized generation
    // while holding the same shard lock as competing successor admission.
    close_retired_create(discovery_root, identity, &fence)
}

fn read_retirement_record(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<ManagedCreateLedgerRecord>, String> {
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("hmux_managed_create_ledger_invalid: directory is unreadable".to_string());
        }
        Ok(_) => ensure_private_directory(&directory)?,
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    if !private_path_exists(&shard_path)? {
        return Ok(None);
    }
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    validate_shard(&shard, shard_index(&record_key)?)?;
    let Some(record) = shard.records.remove(&record_key) else {
        return Ok(None);
    };
    validate_record(&record, workspace_id, session_id)?;
    Ok(Some(record))
}
