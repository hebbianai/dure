use super::*;

enum ConversationAdmission {
    Acquire,
    Defer,
}

/// Freeze create identity and policy without claiming a conversation writer.
/// Execution must acquire that writer through the ordinary admission path.
pub(super) fn prepare_request_metadata(
    discovery_root: &Path,
    create_identity: (&str, &str, &str),
    request_digest: &str,
    lineage: ManagedCreateLineageContext<'_>,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    reserve_with_admission(
        discovery_root,
        create_identity,
        request_digest,
        lineage,
        ConversationAdmission::Defer,
        || {},
        || Ok(()),
    )
}

pub(super) fn reserve_with_lineage_admission(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    lineage: ManagedCreateLineageContext<'_>,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    reserve_with_lineage_admission_with_interleave(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        request_digest,
        lineage,
        || Ok(()),
    )
}

pub(super) fn reserve_with_lineage_admission_with_interleave<F>(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    lineage: ManagedCreateLineageContext<'_>,
    after_root_create_publish: F,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError>
where
    F: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    reserve_with_lineage_admission_with_hooks(
        discovery_root,
        (workspace_id, session_id, idempotency_key),
        request_digest,
        lineage,
        || {},
        after_root_create_publish,
    )
}

pub(super) fn reserve_with_lineage_admission_with_hooks<B, F>(
    discovery_root: &Path,
    create_identity: (&str, &str, &str),
    request_digest: &str,
    lineage: ManagedCreateLineageContext<'_>,
    before_conversation_lock: B,
    after_root_create_publish: F,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError>
where
    B: FnOnce(),
    F: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    reserve_with_admission(
        discovery_root,
        create_identity,
        request_digest,
        lineage,
        ConversationAdmission::Acquire,
        before_conversation_lock,
        after_root_create_publish,
    )
}

fn reserve_with_admission<B, F>(
    discovery_root: &Path,
    create_identity: (&str, &str, &str),
    request_digest: &str,
    lineage: ManagedCreateLineageContext<'_>,
    conversation_admission: ConversationAdmission,
    before_conversation_lock: B,
    after_root_create_publish: F,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError>
where
    B: FnOnce(),
    F: FnOnce() -> Result<(), ManagedCreateAdmissionError>,
{
    let (workspace_id, session_id, idempotency_key) = create_identity;
    let ManagedCreateLineageContext {
        canonical_rehost_recipe,
        conversation_identity,
        admission: lineage_admission,
    } = lineage;
    validate_identity(workspace_id, session_id, idempotency_key, request_digest)?;
    if let Some(identity) = conversation_identity {
        identity
            .validate()
            .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    }
    let canonical_rehost_recipe = canonical_rehost_recipe
        .map(|serialized| {
            decode_canonical_rehost_recipe(serialized, workspace_id, session_id)
                .map(|recipe| (serialized.to_string(), recipe.rehost().clone()))
        })
        .transpose()?;
    let incoming_rehost_authority = canonical_rehost_recipe
        .as_ref()
        .map(|(_, rehost)| rehost.clone());
    let canonical_rehost_recipe = canonical_rehost_recipe.map(|(serialized, _)| serialized);
    refuse_legacy_writer(discovery_root)?;
    let directory = discovery_root.join(LEDGER_DIRECTORY);
    ensure_private_directory(&directory)?;
    let predecessor_coverage = ensure_successor_predecessor_coverage(&directory)?;
    let conversation_owner = ManagedConversationWriterOwner {
        workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        request_digest: request_digest.to_string(),
    };
    before_conversation_lock();
    let mut conversation_writer_admission = match conversation_admission {
        ConversationAdmission::Acquire => conversation_identity
            .map(|identity| begin_conversation_writer_admission(&directory, identity))
            .transpose()?,
        ConversationAdmission::Defer => None,
    };
    if let Some(admission) = conversation_writer_admission.as_ref() {
        ensure_conversation_writer_available(
            discovery_root,
            &directory,
            admission,
            &conversation_owner,
        )?;
    }
    let record_key = logical_key(workspace_id, session_id);
    let (lock_path, shard_path) = shard_paths(&directory, &record_key)?;
    let _lock = acquire_shard_lock(&lock_path)?;
    let mut shard = read_shard_or_default(&shard_path)?;
    let index = shard_index(&record_key)?;
    validate_shard(&shard, index)?;
    let target_identity =
        ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id)
            .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    if shard
        .records
        .get(&record_key)
        .is_some_and(record_has_direct_cleanup_fence)
        || successor_cleanup_is_closed(&directory, index, &record_key, &target_identity)?
    {
        return Ok(ManagedCreateLedgerState::Retired);
    }
    let record_is_new = !shard.records.contains_key(&record_key);
    let mut record = match shard.records.get(&record_key).cloned() {
        Some(record) => record,
        None => {
            if shard.records.len() >= MAX_SHARD_RECORDS {
                return Err(format!(
                    "hmux_managed_create_ledger_capacity: shard reached {MAX_SHARD_RECORDS} logical sessions"
                )
                .into());
            }
            let record = ManagedCreateLedgerRecord {
                schema_version: LEDGER_RECORD_SCHEMA_VERSION,
                workspace_id: workspace_id.to_string(),
                session_id: session_id.to_string(),
                idempotency_key: idempotency_key.to_string(),
                request_digest: request_digest.to_string(),
                conversation_identity: conversation_identity.cloned(),
                conversation_writer_released: false,
                canonical_rehost_recipe: canonical_rehost_recipe.clone(),
                created_unix_ms: unix_time_ms(),
                authority: Some(ManagedCreateLedgerAuthorityV3 {
                    lineage: if matches!(lineage_admission, ManagedCreateLineageAdmission::Root) {
                        ManagedCreateLineageAuthorityV3::Root {
                            legacy_predecessor_absence_proven: false,
                        }
                    } else {
                        ManagedCreateLineageAuthorityV3::LegacyV2
                    },
                    successor: ManagedCreateSuccessorSlotV3::Vacant,
                }),
                state: ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified,
            };
            shard.schema_version = LEDGER_SHARD_SCHEMA_VERSION;
            shard.records.insert(record_key.clone(), record.clone());
            record
        }
    };
    validate_record(&record, workspace_id, session_id)?;
    if record.idempotency_key != idempotency_key {
        return Err(
            "hmux_managed_create_idempotency_conflict: logical session identity is permanently bound to another create request; use a new session id"
                .to_string()
                .into(),
        );
    }
    if matches!(
        record.state,
        ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission
    ) {
        return Ok(ManagedCreateLedgerState::Retired);
    }
    let direct_predecessor = matches!(
        record
            .authority
            .as_ref()
            .map(|authority| &authority.lineage),
        Some(ManagedCreateLineageAuthorityV3::Predecessor { .. })
    );
    if direct_predecessor && record.conversation_identity.as_ref() != conversation_identity {
        return Err(ManagedCreateAdmissionError::CanonicalConversationIdentityConflict);
    }
    if direct_predecessor
        && record.canonical_rehost_recipe.is_some() != canonical_rehost_recipe.is_some()
    {
        return Err(ManagedCreateAdmissionError::CanonicalRehostRecipeConflict);
    }
    let backfill_conversation_identity =
        match (record.conversation_identity.as_ref(), conversation_identity) {
            (Some(existing), Some(incoming)) if existing == incoming => false,
            (None, None) => false,
            (None, Some(_)) if !direct_predecessor && record.request_digest == request_digest => {
                true
            }
            _ => {
                return Err(ManagedCreateAdmissionError::CanonicalConversationIdentityConflict);
            }
        };
    let recorded_rehost_authority = record
        .canonical_rehost_recipe
        .as_deref()
        .map(|serialized| {
            decode_canonical_rehost_recipe(serialized, workspace_id, session_id)
                .map(|recipe| recipe.rehost().clone())
        })
        .transpose()?;
    if recorded_rehost_authority
        .as_ref()
        .zip(incoming_rehost_authority.as_ref())
        .is_some_and(|(recorded, incoming)| recorded != incoming)
    {
        return Err(ManagedCreateAdmissionError::CanonicalRehostRecipeConflict);
    }
    if record.request_digest != request_digest {
        return Err(ManagedCreateAdmissionError::CanonicalRequestDigestConflict);
    }
    let activate_successor = matches!(
        record.state,
        ManagedCreateLedgerRecordState::SuccessorLineagePending
    );
    let authority_before_lineage_admission = record.authority.clone();
    let mut lineage_reservation = admit_create_lineage(
        discovery_root,
        &predecessor_coverage,
        &target_identity,
        &mut record,
        &shard,
        lineage_admission,
        record_is_new,
    )?;
    let lineage_authority_changed = record.authority != authority_before_lineage_admission;
    if lineage_authority_changed {
        shard.records.insert(record_key.clone(), record.clone());
    }
    if activate_successor {
        record.state = ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified;
        shard.records.insert(record_key.clone(), record.clone());
    }
    if backfill_conversation_identity {
        record.conversation_identity = conversation_identity.cloned();
        shard.records.insert(record_key.clone(), record.clone());
    }
    if record_is_new
        || backfill_conversation_identity
        || activate_successor
        || lineage_authority_changed
    {
        write_shard(&directory, &shard_path, &shard)?;
    }
    if lineage_reservation.is_some()
        || (record_is_new
            && matches!(
                record
                    .authority
                    .as_ref()
                    .map(|authority| &authority.lineage),
                Some(ManagedCreateLineageAuthorityV3::Root { .. })
            ))
    {
        after_root_create_publish()?;
    }
    if let Some(lineage_reservation) = lineage_reservation.as_mut() {
        // Fresh Root absence proof and retained v2 projection recovery both
        // hold the target lineage lock through the create-shard write.
        lineage_reservation.publish()?;
        if matches!(
            &record.state,
            ManagedCreateLedgerRecordState::RootLineagePending
        ) {
            record.state = ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified;
            shard.records.insert(record_key.clone(), record.clone());
            write_shard(&directory, &shard_path, &shard)?;
        }
    }
    drop(lineage_reservation);
    if let (Some(admission), Some(identity)) = (
        conversation_writer_admission.as_mut(),
        conversation_identity,
    ) {
        admission.commit(identity, conversation_owner)?;
    }
    match record.state.clone() {
        ManagedCreateLedgerRecordState::Completed { retired: true, .. } => {
            Ok(ManagedCreateLedgerState::Retired)
        }
        ManagedCreateLedgerRecordState::Completed {
            retired: false,
            retiring_stop_receipt: Some(_),
            ..
        } => Ok(ManagedCreateLedgerState::Retired),
        ManagedCreateLedgerRecordState::Completed {
            receipt,
            retired: false,
            retiring_stop_receipt: None,
        } => {
            validate_create_receipt(&receipt)?;
            Ok(ManagedCreateLedgerState::Completed(receipt))
        }
        ManagedCreateLedgerRecordState::PreSpawnAbsenceUnverified
        | ManagedCreateLedgerRecordState::Prepared
        | ManagedCreateLedgerRecordState::PreSpawnAbsenceCheckpointed => Ok(
            ManagedCreateLedgerState::Prepared(ManagedCreateLedgerReservation {
                directory,
                lock_path,
                shard_path,
                record_key,
                record,
            }),
        ),
        ManagedCreateLedgerRecordState::SpawnReserved { host_process } => {
            Ok(ManagedCreateLedgerState::SpawnReserved {
                reservation: ManagedCreateLedgerReservation {
                    directory,
                    lock_path,
                    shard_path,
                    record_key,
                    record,
                },
                host_process,
            })
        }
        ManagedCreateLedgerRecordState::LaunchReleased {
            host_process,
            starting_generation,
        } => Ok(ManagedCreateLedgerState::LaunchReleased {
            reservation: ManagedCreateLedgerReservation {
                directory,
                lock_path,
                shard_path,
                record_key,
                record,
            },
            host_process,
            starting_generation,
        }),
        ManagedCreateLedgerRecordState::RetiringBeforeCreateCompletion { .. }
        | ManagedCreateLedgerRecordState::RetiredBeforeCreateCompletion { .. }
        | ManagedCreateLedgerRecordState::CleanupClosedBeforeCreateAdmission => {
            Ok(ManagedCreateLedgerState::Retired)
        }
        ManagedCreateLedgerRecordState::AbandonedBeforeCreateCompletion => {
            Ok(ManagedCreateLedgerState::Retired)
        }
        ManagedCreateLedgerRecordState::RootLineagePending => Err(
            "hmux_managed_create_successor_invalid: Root lineage marker was not finalized"
                .to_string()
                .into(),
        ),
        ManagedCreateLedgerRecordState::SuccessorLineagePending => Err(
            "hmux_managed_create_successor_invalid: predecessor is not terminal"
                .to_string()
                .into(),
        ),
    }
}
