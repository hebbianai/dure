use super::*;

/// Resolve a create's origin through the runtime's existing immutable lineage.
/// This may materialize retained predecessor indexes, but never closes a writer
/// or launches/stops a process. An unknown identity remains unknown, not reserved.
pub fn resolve_create_origin(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileRequest, ManagedCreateAdmissionError> {
    oldest_successor_ancestor(discovery_root, identity).map(|(origin, _)| origin)
}

/// Close only an abandoned, never-completed creation with no admitted
/// successor. A true result is durable authority to release resources bound
/// to this exact identity, not its ancestors or another logical lifetime.
///
/// Reconciliation owns process-absence proof. This operation consumes its
/// checkpoint under the same shard lock as successor admission; it neither
/// stops a process nor follows an already-admitted recovery successor.
pub fn close_abandoned_create(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<bool, ManagedCreateAdmissionError> {
    let ManagedCreateSuccessorInspection::Found {
        source_record,
        slot,
        source_lock: _source_lock,
        ..
    } = inspect_successor_node(discovery_root, identity, None)?
    else {
        return Ok(false);
    };
    if !matches!(
        source_record.state,
        ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion
    ) {
        return Ok(false);
    }
    close_vacant_slot(slot, identity)
}

/// Record exact logical-close intent before stopping its approved generation.
/// The same shard lock arbitrates successor admission; a competing child is
/// never followed. This closes admission, not resource ownership: cleanup must
/// still wait for a finalized stop via `closed_retired_chain`.
pub fn close_exact_create(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
    expected: &ManagedCreateGenerationFence,
) -> Result<bool, ManagedCreateAdmissionError> {
    let ManagedCreateSuccessorInspection::Found {
        source,
        slot,
        source_lock: _source_lock,
        ..
    } = inspect_successor_node(discovery_root, identity, None)?
    else {
        return Ok(false);
    };
    let matches = match source {
        ManagedCreateSuccessorSourceState::Completed(receipt) => {
            receipt.generation_fence() == Some(expected)
        }
        ManagedCreateSuccessorSourceState::Retiring(stop)
        | ManagedCreateSuccessorSourceState::Terminal {
            stop_receipt: Some(stop),
        } => expected.matches_generation(
            stop.runner_principal(),
            stop.runner_instance(),
            &stop.channel_epoch().to_string(),
            stop.host_instance_id(),
            stop.terminal_epoch(),
        ),
        _ => false,
    };
    Ok(matches && close_vacant_slot(slot, identity)?)
}

/// Close the approved, finalized generation without following a successor
/// admitted by a competing recovery. A returned chain contains only retired
/// ancestors of that exact tip and can transfer their resource ownership.
/// Callers must retain those resources until the replacement owns them.
pub fn close_retired_create(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
    expected: &ManagedCreateGenerationFence,
) -> Result<Option<ManagedCreateSuccessorChain>, ManagedCreateAdmissionError> {
    {
        let ManagedCreateSuccessorInspection::Found {
            source:
                ManagedCreateSuccessorSourceState::Terminal {
                    stop_receipt: Some(stop),
                },
            slot,
            source_lock: _source_lock,
            ..
        } = inspect_successor_node(discovery_root, identity, None)?
        else {
            return Ok(None);
        };
        if stop.session_id() != identity.session_id()
            || stop.workspace_id() != identity.workspace_id()
            || !expected.matches_generation(
                stop.runner_principal(),
                stop.runner_instance(),
                &stop.channel_epoch().to_string(),
                stop.host_instance_id(),
                stop.terminal_epoch(),
            )
            || !close_vacant_slot(slot, identity)?
        {
            return Ok(None);
        }
    }
    // The exact tip is now durably closed, so it cannot gain a successor after
    // this lock is released. Recover ancestry without claiming another slot;
    // broad chain cleanup could mutate an inconsistent prior generation.
    match closed_retired_chain(discovery_root, identity)? {
        Some(chain) => Ok(Some(chain)),
        None => Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_invalid: closed generation has nonterminal ancestry"
                .to_string(),
        )),
    }
}

/// Recover an existing logical-close outcome without admitting another close.
/// A finalized generation with a vacant slot remains available for rehost;
/// abandonment alone cannot release an inherited recovery claim either.
/// This may recover lineage indexes, but never closes a slot or stops a process.
pub fn closed_retired_chain(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedCreateSuccessorChain>, ManagedCreateAdmissionError> {
    Ok(closed_retired_completion(discovery_root, identity)?.map(|(chain, _)| chain))
}

/// Project the existing final stop for cleanup callers that lost their response.
/// This shares logical-close admission with resource cleanup, not discovery GC.
pub fn closed_retired_chain_receipt(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<
    Option<hmux_runtime_contract::ManagedCreateChainStopReceiptV2>,
    ManagedCreateAdmissionError,
> {
    closed_retired_completion(discovery_root, identity)?
        .map(|(chain, stop)| {
            hmux_runtime_contract::ManagedCreateChainStopReceiptV2::stopped(
                chain.into_identities(),
                stop,
            )
            .map_err(|error| ManagedCreateAdmissionError::Ledger(error.to_string()))
        })
        .transpose()
}

fn closed_retired_completion(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<Option<(ManagedCreateSuccessorChain, ManagedStopReceipt)>, ManagedCreateAdmissionError>
{
    let root = resolve_create_origin(discovery_root, identity)?;
    let ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
        chain,
        stop_receipt: Some(stop),
    } = resolve_successor_chain(discovery_root, &root)
        .map_err(ManagedCreateAdmissionError::Ledger)?
    else {
        return Ok(None);
    };
    // The prior traversal may observe a vacant tip. Only its durable Closed
    // slot proves no successor can appear after this observation is returned.
    let closed = matches!(
        inspect_successor_node(discovery_root, chain.effective(), None)?,
        ManagedCreateSuccessorInspection::Found {
            source: ManagedCreateSuccessorSourceState::Terminal {
                stop_receipt: Some(_),
            },
            slot: ManagedCreateSuccessorSlot::Closed,
            ..
        }
    );
    Ok(closed.then_some((chain, *stop)))
}

fn close_vacant_slot(
    slot: ManagedCreateSuccessorSlot,
    identity: &ManagedCreateReconcileRequest,
) -> Result<bool, ManagedCreateAdmissionError> {
    match slot {
        ManagedCreateSuccessorSlot::Vacant(reservation) => {
            close_successor_slot(*reservation, identity)?;
            Ok(true)
        }
        ManagedCreateSuccessorSlot::Closed => Ok(true),
        ManagedCreateSuccessorSlot::Existing(_) => Ok(false),
    }
}

pub(super) fn close_successor_slot(
    mut reservation: SuccessorSlotReservation,
    _source: &ManagedCreateReconcileRequest,
) -> Result<(), ManagedCreateAdmissionError> {
    if matches!(
        reservation.source_record.state,
        ManagedCreateLedgerRecordState::SuccessorLineagePending
    ) {
        reservation.source_record.state =
            ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission;
        reservation
            .source_shard
            .records
            .insert(reservation.record_key.clone(), reservation.source_record);
        return write_shard(
            &reservation.directory,
            &reservation.source_path,
            &reservation.source_shard,
        )
        .map_err(ManagedCreateAdmissionError::Ledger);
    }
    let closed_unix_ms = unix_time_ms();
    let authority =
        reservation
            .source_record
            .authority
            .get_or_insert(ManagedCreateLedgerAuthorityV3 {
                lineage: ManagedCreateLineageAuthorityV3::LegacyV2,
                successor: ManagedCreateSuccessorSlotV3::Vacant,
            });
    if !matches!(authority.successor, ManagedCreateSuccessorSlotV3::Vacant) {
        return Err(ManagedCreateAdmissionError::Ledger(
            "hmux_managed_create_successor_conflict: successor cleanup slot changed".to_string(),
        ));
    }
    authority.successor = ManagedCreateSuccessorSlotV3::Closed { closed_unix_ms };
    reservation.source_record.schema_version = LEDGER_RECORD_SCHEMA_VERSION;
    reservation.source_shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
    reservation
        .source_shard
        .records
        .insert(reservation.record_key.clone(), reservation.source_record);
    write_shard(
        &reservation.directory,
        &reservation.source_path,
        &reservation.source_shard,
    )
    .map_err(ManagedCreateAdmissionError::Ledger)
}
