use std::collections::{BTreeMap, HashMap};

use dure_app::{
    DomainStoreErrorV1, OperationEventIdV1, OperationIdV1, PluginApplyJournalEventBodyV2,
    PluginApplyJournalEventV2, PluginApplyJournalReceiptV2, PluginNativeOwnershipChangeV2,
    PluginNativeOwnershipKeyV2, PluginNativeOwnershipLedgerEventBodyV2,
    PluginNativeOwnershipLedgerEventV2, PluginNativeOwnershipReceiptV2,
    derive_plugin_native_ownership_ledger_event, fold_plugin_apply_journal,
    fold_plugin_native_ownership_ledger, plugin_native_ownership_target_for_journal_event,
    validate_plugin_apply_compensation_completion,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn append_event(
    pool: &SqlitePool,
    event: &PluginApplyJournalEventV2,
) -> Result<PluginApplyJournalReceiptV2, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("append_plugin_apply_event", error))?;
    begin_immediate(&mut connection, "append_plugin_apply_event").await?;
    let result = append_event_on(&mut connection, event).await;
    finish_transaction(&mut connection, "append_plugin_apply_event", result).await
}

pub(crate) async fn receipt(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<PluginApplyJournalReceiptV2>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_plugin_apply_receipt", error))?;
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_plugin_apply_receipt", error))?;
    let result = async {
        let events = events_for_operation(&mut connection, operation_id).await?;
        if events.is_empty() {
            if receipt_by_operation(&mut connection, operation_id)
                .await?
                .is_some()
            {
                return Err(storage(
                    "orphan_plugin_apply_receipt",
                    format!("operation {operation_id} has a receipt but no events"),
                ));
            }
            return Ok(None);
        }
        let folded = fold(&events)?;
        let stored = receipt_by_operation(&mut connection, operation_id)
            .await?
            .ok_or_else(|| {
                storage(
                    "missing_plugin_apply_receipt",
                    format!("operation {operation_id} has events but no receipt"),
                )
            })?;
        if stored != folded {
            return Err(storage(
                "stale_plugin_apply_receipt",
                format!("operation {operation_id} projection differs from its event stream"),
            ));
        }
        Ok(Some(stored))
    }
    .await;
    finish_transaction(&mut connection, "read_plugin_apply_receipt", result).await
}

pub(crate) async fn ownership(
    pool: &SqlitePool,
    ownership_key: &PluginNativeOwnershipKeyV2,
) -> Result<Option<PluginNativeOwnershipReceiptV2>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_plugin_native_ownership", error))?;
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_plugin_native_ownership", error))?;
    let result = ownership_by_key(&mut connection, ownership_key).await;
    finish_transaction(&mut connection, "read_plugin_native_ownership", result).await
}

pub(crate) async fn rebuild_receipts(pool: &SqlitePool) -> Result<usize, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebuild_plugin_apply_receipts", error))?;
    begin_immediate(&mut connection, "rebuild_plugin_apply_receipts").await?;
    let result = async {
        let events = load_all_events(&mut connection).await?;
        let mut streams: Vec<Vec<PluginApplyJournalEventV2>> = Vec::new();
        for event in events {
            match streams.last_mut() {
                Some(stream)
                    if stream
                        .first()
                        .is_some_and(|first| first.operation_id == event.operation_id) =>
                {
                    stream.push(event);
                }
                _ => streams.push(vec![event]),
            }
        }

        let mut receipts = Vec::with_capacity(streams.len());
        let mut idempotency_owners: HashMap<String, OperationIdV1> = HashMap::new();
        for stream in streams {
            let receipt = fold(&stream)?;
            if let Some(owner) = idempotency_owners.insert(
                receipt.idempotency_key.clone(),
                receipt.operation_id.clone(),
            ) {
                if owner != receipt.operation_id {
                    return Err(DomainStoreErrorV1::IdempotencyConflict {
                        reason: format!(
                            "plugin apply key {:?} is claimed by operations {} and {}",
                            receipt.idempotency_key, owner, receipt.operation_id
                        ),
                    });
                }
            }
            receipts.push(receipt);
        }
        let receipts_by_operation = receipts
            .iter()
            .map(|receipt| (receipt.operation_id.clone(), receipt))
            .collect::<HashMap<_, _>>();
        for parent in receipts
            .iter()
            .filter(|receipt| receipt.state == dure_app::PluginApplyJournalStateV2::Compensated)
        {
            let child = parent
                .compensation
                .as_ref()
                .and_then(|link| receipts_by_operation.get(&link.operation_id))
                .ok_or_else(|| {
                    storage(
                        "invalid_plugin_apply_compensation",
                        format!(
                            "compensated operation {} has no linked child receipt",
                            parent.operation_id
                        ),
                    )
                })?;
            validate_plugin_apply_compensation_completion(parent, child)
                .map_err(|error| storage("invalid_plugin_apply_compensation", error.to_string()))?;
        }

        sqlx::query("DELETE FROM plugin_apply_receipts")
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_plugin_apply_receipts", error))?;
        for receipt in &receipts {
            persist_receipt(&mut connection, receipt).await?;
        }
        Ok(receipts.len())
    }
    .await;
    finish_transaction(&mut connection, "rebuild_plugin_apply_receipts", result).await
}

pub(crate) async fn rebuild_ownership(pool: &SqlitePool) -> Result<usize, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebuild_plugin_native_ownership", error))?;
    begin_immediate(&mut connection, "rebuild_plugin_native_ownership").await?;
    let result = async {
        let ledger = load_ownership_events(&mut connection).await?;
        let folded = fold_plugin_native_ownership_ledger(&ledger).map_err(|error| {
            storage("corrupt_plugin_native_ownership_ledger", error.to_string())
        })?;
        let mut projection = BTreeMap::<
            PluginNativeOwnershipKeyV2,
            (u64, i64, PluginNativeOwnershipReceiptV2),
        >::new();

        for ownership_event in &ledger {
            let source_event = event_by_id(&mut connection, &ownership_event.journal_event_id)
                .await?
                .ok_or_else(|| {
                    storage(
                        "orphan_plugin_native_ownership_event",
                        format!(
                            "ownership revision {} references missing journal event {}",
                            ownership_event.revision, ownership_event.journal_event_id
                        ),
                    )
                })?;
            let operation_events =
                events_for_operation(&mut connection, &source_event.operation_id).await?;
            let prefix = operation_events
                .into_iter()
                .take_while(|event| event.sequence <= source_event.sequence)
                .collect::<Vec<_>>();
            if prefix.last() != Some(&source_event) {
                return Err(storage(
                    "corrupt_plugin_native_ownership_event",
                    "ownership source is not the exact end of its journal prefix",
                ));
            }
            let receipt = fold(&prefix)?;
            let target = plugin_native_ownership_target_for_journal_event(&source_event, &receipt)
                .map_err(|error| {
                    storage("corrupt_plugin_native_ownership_event", error.to_string())
                })?
                .ok_or_else(|| {
                    storage(
                        "corrupt_plugin_native_ownership_event",
                        "ownership ledger references a journal event without an effect",
                    )
                })?;
            let existing = projection.get(&target.key).map(|(_, _, receipt)| receipt);
            let expected =
                derive_plugin_native_ownership_ledger_event(PluginNativeOwnershipChangeV2 {
                    revision: ownership_event.revision,
                    journal_event: &source_event,
                    receipt: &receipt,
                    existing,
                })
                .map_err(|error| {
                    storage("corrupt_plugin_native_ownership_event", error.to_string())
                })?
                .ok_or_else(|| {
                    storage(
                        "corrupt_plugin_native_ownership_event",
                        "ownership ledger records an effect that does not change ownership",
                    )
                })?;
            if expected != *ownership_event {
                return Err(storage(
                    "corrupt_plugin_native_ownership_event",
                    format!(
                        "ownership revision {} differs from its source journal effect",
                        ownership_event.revision
                    ),
                ));
            }
            match &ownership_event.body {
                PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } => {
                    projection.insert(
                        ownership.target.key.clone(),
                        (
                            ownership_event.revision,
                            ownership_event.recorded_at_ms,
                            ownership.clone(),
                        ),
                    );
                }
                PluginNativeOwnershipLedgerEventBodyV2::Released { ownership, .. } => {
                    projection.remove(&ownership.target.key);
                }
            }
        }

        let projected_receipts = projection
            .iter()
            .map(|(key, (_, _, receipt))| (key.clone(), receipt.clone()))
            .collect::<BTreeMap<_, _>>();
        if projected_receipts != folded {
            return Err(storage(
                "corrupt_plugin_native_ownership_ledger",
                "validated ownership projection differs from the folded ledger",
            ));
        }

        sqlx::query("DELETE FROM plugin_native_ownership")
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_plugin_native_ownership", error))?;
        for (key, (revision, updated_at_ms, receipt)) in &projection {
            persist_ownership_projection(&mut connection, key, *revision, *updated_at_ms, receipt)
                .await?;
        }
        Ok(projection.len())
    }
    .await;
    finish_transaction(&mut connection, "rebuild_plugin_native_ownership", result).await
}

async fn append_event_on(
    connection: &mut SqliteConnection,
    event: &PluginApplyJournalEventV2,
) -> Result<PluginApplyJournalReceiptV2, DomainStoreErrorV1> {
    crate::plugin_native_target_binding::validate_binding_projection(connection).await?;
    if let Some(existing) = event_by_id(connection, &event.event_id).await? {
        if existing != *event {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "plugin apply event id {} was replayed with a different payload",
                    event.event_id
                ),
            });
        }
        crate::plugin_native_target_binding::validate_started_bindings(connection, event).await?;
        let events = events_for_operation(connection, &event.operation_id).await?;
        let receipt = fold(&events)?;
        persist_receipt(connection, &receipt).await?;
        return Ok(receipt);
    }
    if let Some(existing) =
        event_by_operation_sequence(connection, &event.operation_id, event.sequence).await?
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: format!(
                "plugin apply operation {} sequence {} is already owned by event {}",
                event.operation_id, event.sequence, existing.event_id
            ),
        });
    }
    if let PluginApplyJournalEventBodyV2::Started {
        idempotency_key, ..
    } = &event.body
    {
        if let Some(existing) = receipt_by_idempotency_key(connection, idempotency_key).await? {
            if existing.operation_id != event.operation_id {
                return Err(DomainStoreErrorV1::IdempotencyConflict {
                    reason: format!(
                        "plugin apply key {idempotency_key:?} already belongs to operation {}",
                        existing.operation_id
                    ),
                });
            }
        }
    }

    let mut events = events_for_operation(connection, &event.operation_id).await?;
    events.push(event.clone());
    events.sort_by_key(|candidate| candidate.sequence);
    let receipt = fold(&events)?;
    if matches!(
        &event.body,
        PluginApplyJournalEventBodyV2::Compensated { .. }
    ) {
        let link = receipt.compensation.as_ref().ok_or_else(|| {
            storage(
                "invalid_plugin_apply_compensation",
                "compensated operation has no linked child",
            )
        })?;
        let child = validated_receipt_by_operation(connection, &link.operation_id)
            .await?
            .ok_or_else(|| {
                storage(
                    "invalid_plugin_apply_compensation",
                    format!("compensation child {} does not exist", link.operation_id),
                )
            })?;
        validate_plugin_apply_compensation_completion(&receipt, &child)
            .map_err(|error| storage("invalid_plugin_apply_compensation", error.to_string()))?;
    }
    let ownership_change = match plugin_native_ownership_target_for_journal_event(event, &receipt)
        .map_err(|error| {
        storage("invalid_plugin_native_ownership", error.to_string())
    })? {
        Some(target) => {
            let existing = ownership_by_key(connection, &target.key).await?;
            let revision = next_ownership_revision(connection).await?;
            derive_plugin_native_ownership_ledger_event(PluginNativeOwnershipChangeV2 {
                revision,
                journal_event: event,
                receipt: &receipt,
                existing: existing.as_ref(),
            })
            .map_err(|error| storage("invalid_plugin_native_ownership", error.to_string()))?
        }
        None => None,
    };
    let body_json = serde_json::to_string(&event.body)
        .map_err(|error| serialization("plugin_apply_event", error))?;
    sqlx::query(
        r#"
        INSERT INTO plugin_apply_events (
            event_id, operation_id, sequence, body_json, recorded_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
    )
    .bind(event.event_id.as_str())
    .bind(event.operation_id.as_str())
    .bind(i64::from(event.sequence))
    .bind(body_json)
    .bind(event.recorded_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_plugin_apply_event", error))?;
    crate::plugin_native_target_binding::persist_started_bindings(connection, event).await?;
    persist_receipt(connection, &receipt).await?;
    if let Some(ownership_change) = ownership_change {
        persist_ownership_change(connection, &ownership_change).await?;
    }
    Ok(receipt)
}

async fn next_ownership_revision(
    connection: &mut SqliteConnection,
) -> Result<u64, DomainStoreErrorV1> {
    let revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision), 0) + 1 FROM plugin_native_ownership_events",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("next_plugin_native_ownership_revision", error))?;
    u64::try_from(revision).map_err(|_| {
        storage(
            "invalid_plugin_native_ownership_revision",
            format!("ownership revision {revision} is outside u64"),
        )
    })
}

async fn ownership_by_key(
    connection: &mut SqliteConnection,
    key: &PluginNativeOwnershipKeyV2,
) -> Result<Option<PluginNativeOwnershipReceiptV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT ownership_key, receipt_json
        FROM plugin_native_ownership
        WHERE ownership_key = ?1
        "#,
    )
    .bind(key.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_native_ownership", error))?;
    row.map(|row| {
        let stored_key: String = row
            .try_get("ownership_key")
            .map_err(|error| corrupt_row("plugin_native_ownership", error))?;
        let receipt_json: String = row
            .try_get("receipt_json")
            .map_err(|error| corrupt_row("plugin_native_ownership", error))?;
        let receipt: PluginNativeOwnershipReceiptV2 = serde_json::from_str(&receipt_json)
            .map_err(|error| serialization("plugin_native_ownership", error))?;
        if stored_key != receipt.target.key.as_str() || stored_key != key.as_str() {
            return Err(storage(
                "corrupt_plugin_native_ownership",
                "ownership projection key differs from its receipt",
            ));
        }
        Ok(receipt)
    })
    .transpose()
}

async fn persist_ownership_projection(
    connection: &mut SqliteConnection,
    key: &PluginNativeOwnershipKeyV2,
    revision: u64,
    updated_at_ms: i64,
    ownership: &PluginNativeOwnershipReceiptV2,
) -> Result<(), DomainStoreErrorV1> {
    if key != &ownership.target.key {
        return Err(storage(
            "invalid_plugin_native_ownership",
            "ownership projection key differs from its receipt",
        ));
    }
    let revision = i64::try_from(revision).map_err(|_| {
        storage(
            "invalid_plugin_native_ownership_revision",
            "ownership revision is outside SQLite INTEGER",
        )
    })?;
    let receipt_json = serde_json::to_string(ownership)
        .map_err(|error| serialization("plugin_native_ownership", error))?;
    sqlx::query(
        r#"
        INSERT INTO plugin_native_ownership (
            ownership_key, ledger_revision, receipt_json, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4)
        "#,
    )
    .bind(key.as_str())
    .bind(revision)
    .bind(receipt_json)
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("claim_plugin_native_ownership", error))?;
    Ok(())
}

async fn persist_ownership_change(
    connection: &mut SqliteConnection,
    event: &PluginNativeOwnershipLedgerEventV2,
) -> Result<(), DomainStoreErrorV1> {
    let revision = i64::try_from(event.revision).map_err(|_| {
        storage(
            "invalid_plugin_native_ownership_revision",
            "ownership revision is outside SQLite INTEGER",
        )
    })?;
    let (action, ownership) = match &event.body {
        PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } => ("claimed", ownership),
        PluginNativeOwnershipLedgerEventBodyV2::Released { ownership, .. } => {
            ("released", ownership)
        }
    };
    let body_json = serde_json::to_string(&event.body)
        .map_err(|error| serialization("plugin_native_ownership_event", error))?;
    sqlx::query(
        r#"
        INSERT INTO plugin_native_ownership_events (
            revision,
            journal_event_id,
            operation_id,
            step_index,
            attempt,
            ownership_key,
            action,
            body_json,
            recorded_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
    )
    .bind(revision)
    .bind(event.journal_event_id.as_str())
    .bind(event.operation_id.as_str())
    .bind(i64::from(event.step_index))
    .bind(i64::from(event.attempt))
    .bind(ownership.target.key.as_str())
    .bind(action)
    .bind(body_json)
    .bind(event.recorded_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_plugin_native_ownership_event", error))?;

    match &event.body {
        PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } => {
            persist_ownership_projection(
                connection,
                &ownership.target.key,
                event.revision,
                event.recorded_at_ms,
                ownership,
            )
            .await?;
        }
        PluginNativeOwnershipLedgerEventBodyV2::Released { ownership, .. } => {
            let receipt_json = serde_json::to_string(ownership)
                .map_err(|error| serialization("plugin_native_ownership", error))?;
            let result = sqlx::query(
                r#"
                DELETE FROM plugin_native_ownership
                WHERE ownership_key = ?1 AND receipt_json = ?2
                "#,
            )
            .bind(ownership.target.key.as_str())
            .bind(receipt_json)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("release_plugin_native_ownership", error))?;
            if result.rows_affected() != 1 {
                return Err(storage(
                    "stale_plugin_native_ownership",
                    "ownership release did not consume the exact current receipt",
                ));
            }
        }
    }
    Ok(())
}

async fn persist_receipt(
    connection: &mut SqliteConnection,
    receipt: &PluginApplyJournalReceiptV2,
) -> Result<(), DomainStoreErrorV1> {
    let receipt_json = serde_json::to_string(receipt)
        .map_err(|error| serialization("plugin_apply_receipt", error))?;
    sqlx::query(
        r#"
        INSERT INTO plugin_apply_receipts (
            operation_id,
            idempotency_key,
            plugin_id,
            plugin_version,
            operation_kind,
            state,
            last_sequence,
            receipt_json,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(operation_id) DO UPDATE SET
            idempotency_key = excluded.idempotency_key,
            plugin_id = excluded.plugin_id,
            plugin_version = excluded.plugin_version,
            operation_kind = excluded.operation_kind,
            state = excluded.state,
            last_sequence = excluded.last_sequence,
            receipt_json = excluded.receipt_json,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(receipt.operation_id.as_str())
    .bind(&receipt.idempotency_key)
    .bind(receipt.plugin_id.as_str())
    .bind(receipt.plugin_version.as_str())
    .bind(receipt.operation_kind.as_str())
    .bind(receipt.state.as_str())
    .bind(i64::from(receipt.last_sequence))
    .bind(receipt_json)
    .bind(receipt.created_at_ms)
    .bind(receipt.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("persist_plugin_apply_receipt", error))?;
    Ok(())
}

async fn receipt_by_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<PluginApplyJournalReceiptV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            plugin_id,
            plugin_version,
            operation_kind,
            state,
            last_sequence,
            receipt_json,
            created_at_ms,
            updated_at_ms
        FROM plugin_apply_receipts
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

pub(crate) async fn validated_receipt_by_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<PluginApplyJournalReceiptV2>, DomainStoreErrorV1> {
    let events = events_for_operation(connection, operation_id).await?;
    if events.is_empty() {
        if receipt_by_operation(connection, operation_id)
            .await?
            .is_some()
        {
            return Err(storage(
                "orphan_plugin_apply_receipt",
                format!("operation {operation_id} has a receipt but no events"),
            ));
        }
        return Ok(None);
    }
    let folded = fold(&events)?;
    let stored = receipt_by_operation(connection, operation_id)
        .await?
        .ok_or_else(|| {
            storage(
                "missing_plugin_apply_receipt",
                format!("operation {operation_id} has events but no receipt"),
            )
        })?;
    if stored != folded {
        return Err(storage(
            "stale_plugin_apply_receipt",
            format!("operation {operation_id} projection differs from its event stream"),
        ));
    }
    Ok(Some(stored))
}

async fn receipt_by_idempotency_key(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<PluginApplyJournalReceiptV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            plugin_id,
            plugin_version,
            operation_kind,
            state,
            last_sequence,
            receipt_json,
            created_at_ms,
            updated_at_ms
        FROM plugin_apply_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

async fn event_by_id(
    connection: &mut SqliteConnection,
    event_id: &OperationEventIdV1,
) -> Result<Option<PluginApplyJournalEventV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, recorded_at_ms
        FROM plugin_apply_events
        WHERE event_id = ?1
        "#,
    )
    .bind(event_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_event", error))?;
    row.map(event_from_row).transpose()
}

async fn event_by_operation_sequence(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
    sequence: u32,
) -> Result<Option<PluginApplyJournalEventV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, recorded_at_ms
        FROM plugin_apply_events
        WHERE operation_id = ?1 AND sequence = ?2
        "#,
    )
    .bind(operation_id.as_str())
    .bind(i64::from(sequence))
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_event", error))?;
    row.map(event_from_row).transpose()
}

async fn events_for_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Vec<PluginApplyJournalEventV2>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, recorded_at_ms
        FROM plugin_apply_events
        WHERE operation_id = ?1
        ORDER BY sequence
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

pub(crate) async fn load_all_events(
    connection: &mut SqliteConnection,
) -> Result<Vec<PluginApplyJournalEventV2>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, recorded_at_ms
        FROM plugin_apply_events
        ORDER BY operation_id, sequence
        "#,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_apply_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

async fn load_ownership_events(
    connection: &mut SqliteConnection,
) -> Result<Vec<PluginNativeOwnershipLedgerEventV2>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT
            revision,
            journal_event_id,
            operation_id,
            step_index,
            attempt,
            ownership_key,
            action,
            body_json,
            recorded_at_ms
        FROM plugin_native_ownership_events
        ORDER BY revision
        "#,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_native_ownership_events", error))?;
    rows.into_iter().map(ownership_event_from_row).collect()
}

fn ownership_event_from_row(
    row: SqliteRow,
) -> Result<PluginNativeOwnershipLedgerEventV2, DomainStoreErrorV1> {
    let revision: i64 = row
        .try_get("revision")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let step_index: i64 = row
        .try_get("step_index")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let attempt: i64 = row
        .try_get("attempt")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let stored_key: String = row
        .try_get("ownership_key")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let stored_action: String = row
        .try_get("action")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let body_json: String = row
        .try_get("body_json")
        .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?;
    let body: PluginNativeOwnershipLedgerEventBodyV2 = serde_json::from_str(&body_json)
        .map_err(|error| serialization("plugin_native_ownership_event", error))?;
    let (expected_action, ownership) = match &body {
        PluginNativeOwnershipLedgerEventBodyV2::Claimed { ownership } => ("claimed", ownership),
        PluginNativeOwnershipLedgerEventBodyV2::Released { ownership, .. } => {
            ("released", ownership)
        }
    };
    if stored_action != expected_action || stored_key != ownership.target.key.as_str() {
        return Err(storage(
            "corrupt_plugin_native_ownership_event",
            "ownership ledger index columns differ from the serialized body",
        ));
    }
    let revision = u64::try_from(revision).map_err(|_| {
        storage(
            "corrupt_plugin_native_ownership_event",
            "ownership revision must be positive",
        )
    })?;
    if revision == 0 {
        return Err(storage(
            "corrupt_plugin_native_ownership_event",
            "ownership revision must be positive",
        ));
    }
    let step_index = u32::try_from(step_index).map_err(|_| {
        storage(
            "corrupt_plugin_native_ownership_event",
            "ownership step index is outside u32",
        )
    })?;
    let attempt = u32::try_from(attempt).map_err(|_| {
        storage(
            "corrupt_plugin_native_ownership_event",
            "ownership attempt is outside u32",
        )
    })?;
    if attempt == 0 {
        return Err(storage(
            "corrupt_plugin_native_ownership_event",
            "ownership attempt must be positive",
        ));
    }
    Ok(PluginNativeOwnershipLedgerEventV2 {
        revision,
        journal_event_id: OperationEventIdV1::new(
            row.try_get::<String, _>("journal_event_id")
                .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?,
        )
        .map_err(|error| {
            corrupt_identifier("plugin_native_ownership_events.journal_event_id", error)
        })?,
        operation_id: OperationIdV1::new(
            row.try_get::<String, _>("operation_id")
                .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?,
        )
        .map_err(|error| {
            corrupt_identifier("plugin_native_ownership_events.operation_id", error)
        })?,
        step_index,
        attempt,
        body,
        recorded_at_ms: row
            .try_get("recorded_at_ms")
            .map_err(|error| corrupt_row("plugin_native_ownership_events", error))?,
    })
}

fn event_from_row(row: SqliteRow) -> Result<PluginApplyJournalEventV2, DomainStoreErrorV1> {
    let body_json: String = row
        .try_get("body_json")
        .map_err(|error| corrupt_row("plugin_apply_events", error))?;
    let sequence: i64 = row
        .try_get("sequence")
        .map_err(|error| corrupt_row("plugin_apply_events", error))?;
    Ok(PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(
            row.try_get::<String, _>("event_id")
                .map_err(|error| corrupt_row("plugin_apply_events", error))?,
        )
        .map_err(|error| corrupt_identifier("plugin_apply_events.event_id", error))?,
        operation_id: OperationIdV1::new(
            row.try_get::<String, _>("operation_id")
                .map_err(|error| corrupt_row("plugin_apply_events", error))?,
        )
        .map_err(|error| corrupt_identifier("plugin_apply_events.operation_id", error))?,
        sequence: u32::try_from(sequence).map_err(|_| {
            storage(
                "corrupt_plugin_apply_event",
                format!("sequence {sequence} is outside u32"),
            )
        })?,
        body: serde_json::from_str(&body_json)
            .map_err(|error| serialization("plugin_apply_event", error))?,
        recorded_at_ms: row
            .try_get("recorded_at_ms")
            .map_err(|error| corrupt_row("plugin_apply_events", error))?,
    })
}

fn receipt_from_row(row: SqliteRow) -> Result<PluginApplyJournalReceiptV2, DomainStoreErrorV1> {
    let receipt_json: String = row
        .try_get("receipt_json")
        .map_err(|error| corrupt_row("plugin_apply_receipts", error))?;
    let receipt: PluginApplyJournalReceiptV2 = serde_json::from_str(&receipt_json)
        .map_err(|error| serialization("plugin_apply_receipt", error))?;
    let stored_identity = (
        row.try_get::<String, _>("operation_id")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<String, _>("idempotency_key")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<String, _>("plugin_id")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<String, _>("plugin_version")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<String, _>("operation_kind")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<String, _>("state")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<i64, _>("last_sequence")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<i64, _>("created_at_ms")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
        row.try_get::<i64, _>("updated_at_ms")
            .map_err(|error| corrupt_row("plugin_apply_receipts", error))?,
    );
    let receipt_identity = (
        receipt.operation_id.as_str().to_owned(),
        receipt.idempotency_key.clone(),
        receipt.plugin_id.as_str().to_owned(),
        receipt.plugin_version.as_str().to_owned(),
        receipt.operation_kind.as_str().to_owned(),
        receipt.state.as_str().to_owned(),
        i64::from(receipt.last_sequence),
        receipt.created_at_ms,
        receipt.updated_at_ms,
    );
    if stored_identity != receipt_identity {
        return Err(storage(
            "corrupt_plugin_apply_receipt",
            "receipt projection columns do not match receipt_json",
        ));
    }
    Ok(receipt)
}

fn fold(
    events: &[PluginApplyJournalEventV2],
) -> Result<PluginApplyJournalReceiptV2, DomainStoreErrorV1> {
    fold_plugin_apply_journal(events).map_err(|error| DomainStoreErrorV1::InvalidEventStream {
        reason: error.to_string(),
    })
}
