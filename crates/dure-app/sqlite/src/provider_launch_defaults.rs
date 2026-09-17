use std::collections::BTreeMap;

use dure_app::{
    DomainStoreErrorV1, PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProviderIdV1,
    ProviderLaunchDefaultV1, ProviderLaunchDefaultsPutDispositionV1,
    ProviderLaunchDefaultsPutReceiptV1, ProviderLaunchDefaultsPutRequestV1,
    ProviderLaunchDefaultsV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn read(
    pool: &SqlitePool,
) -> Result<ProviderLaunchDefaultsV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_provider_launch_defaults", error))?;
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_provider_launch_defaults", error))?;
    let result = read_on(&mut connection).await;
    finish_transaction(&mut connection, "read_provider_launch_defaults", result).await
}

pub(crate) async fn put(
    pool: &SqlitePool,
    request: &ProviderLaunchDefaultsPutRequestV1,
    updated_at_ms: i64,
) -> Result<ProviderLaunchDefaultsPutReceiptV1, DomainStoreErrorV1> {
    request
        .validate()
        .map_err(|error| DomainStoreErrorV1::InvalidRecord {
            field: error.field,
            reason: error.reason.into(),
        })?;
    if updated_at_ms < 0 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "updatedAtMs",
            reason: "must be non-negative".into(),
        });
    }
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("put_provider_launch_defaults", error))?;
    begin_immediate(&mut connection, "put_provider_launch_defaults").await?;
    let result = put_on(&mut connection, request, updated_at_ms).await;
    finish_transaction(&mut connection, "put_provider_launch_defaults", result).await
}

pub(crate) async fn read_on(
    connection: &mut SqliteConnection,
) -> Result<ProviderLaunchDefaultsV1, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT schema_version, revision, defaults_json, fingerprint
        FROM provider_launch_defaults
        WHERE singleton = 1
        "#,
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_provider_launch_defaults", error))?;
    let Some(row) = row else {
        return Ok(ProviderLaunchDefaultsV1::empty());
    };
    let schema_version = u16::try_from(
        row.try_get::<i64, _>("schema_version")
            .map_err(corrupt_authority)?,
    )
    .map_err(|_| {
        storage(
            "corrupt_provider_launch_defaults",
            "schema version is outside u16",
        )
    })?;
    let revision = u64::try_from(
        row.try_get::<i64, _>("revision")
            .map_err(corrupt_authority)?,
    )
    .map_err(|_| {
        storage(
            "corrupt_provider_launch_defaults",
            "revision is outside u64",
        )
    })?;
    let defaults_json: String = row.try_get("defaults_json").map_err(corrupt_authority)?;
    let defaults: BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1> =
        serde_json::from_str(&defaults_json).map_err(corrupt_authority)?;
    let document = ProviderLaunchDefaultsV1::new(revision, defaults)
        .map_err(|error| storage("corrupt_provider_launch_defaults", error.to_string()))?;
    let stored_fingerprint: String = row.try_get("fingerprint").map_err(corrupt_authority)?;
    if schema_version != PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1
        || stored_fingerprint != document.fingerprint.as_str()
    {
        return Err(storage(
            "corrupt_provider_launch_defaults",
            "stored columns do not match the canonical document",
        ));
    }
    Ok(document)
}

async fn put_on(
    connection: &mut SqliteConnection,
    request: &ProviderLaunchDefaultsPutRequestV1,
    updated_at_ms: i64,
) -> Result<ProviderLaunchDefaultsPutReceiptV1, DomainStoreErrorV1> {
    if let Some((stored_request, receipt)) =
        receipt_on(connection, &request.idempotency_key).await?
    {
        if stored_request != *request {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "provider launch defaults key {:?} was replayed with different input",
                    request.idempotency_key
                ),
            });
        }
        return Ok(receipt);
    }

    let current = read_on(connection).await?;
    let (disposition, document) =
        if request.expected_revision == 0 && current.revision > 0 {
            (
                ProviderLaunchDefaultsPutDispositionV1::PreservedExisting,
                current,
            )
        } else {
            if current.revision != request.expected_revision {
                return Err(DomainStoreErrorV1::ProviderLaunchDefaultsRevisionConflict {
                    expected_revision: request.expected_revision,
                    actual_revision: current.revision,
                });
            }
            let revision = current.revision.checked_add(1).ok_or_else(|| {
                storage(
                    "provider_launch_defaults_revision_exhausted",
                    "revision cannot be incremented",
                )
            })?;
            let document = ProviderLaunchDefaultsV1::new(revision, request.defaults.clone())
                .map_err(|error| DomainStoreErrorV1::InvalidRecord {
                    field: error.field,
                    reason: error.reason.into(),
                })?;
            let defaults_json = serde_json::to_string(&document.defaults)
                .map_err(|error| serialization("provider_launch_defaults", error))?;
            sqlx::query(
                r#"
            INSERT INTO provider_launch_defaults (
                singleton, schema_version, revision, defaults_json, fingerprint, updated_at_ms
            ) VALUES (1, ?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(singleton) DO UPDATE SET
                schema_version = excluded.schema_version,
                revision = excluded.revision,
                defaults_json = excluded.defaults_json,
                fingerprint = excluded.fingerprint,
                updated_at_ms = excluded.updated_at_ms
            "#,
            )
            .bind(i64::from(document.schema_version))
            .bind(i64::try_from(document.revision).map_err(|_| {
                storage(
                    "provider_launch_defaults_revision_exhausted",
                    "revision is outside SQLite i64",
                )
            })?)
            .bind(defaults_json)
            .bind(document.fingerprint.as_str())
            .bind(updated_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("put_provider_launch_defaults", error))?;
            let disposition = if current.revision == 0 {
                ProviderLaunchDefaultsPutDispositionV1::Created
            } else {
                ProviderLaunchDefaultsPutDispositionV1::Updated
            };
            (disposition, document)
        };
    let receipt = ProviderLaunchDefaultsPutReceiptV1 {
        schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
        idempotency_key: request.idempotency_key.clone(),
        expected_revision: request.expected_revision,
        disposition,
        document,
        updated_at_ms,
    };
    let request_json = serde_json::to_string(request)
        .map_err(|error| serialization("provider_launch_defaults_put_request", error))?;
    let receipt_json = serde_json::to_string(&receipt)
        .map_err(|error| serialization("provider_launch_defaults_put_receipt", error))?;
    sqlx::query(
        r#"
        INSERT INTO provider_launch_defaults_put_receipts (
            idempotency_key, request_json, receipt_json
        ) VALUES (?1, ?2, ?3)
        "#,
    )
    .bind(&request.idempotency_key)
    .bind(request_json)
    .bind(receipt_json)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("put_provider_launch_defaults", error))?;
    Ok(receipt)
}

async fn receipt_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<
    Option<(
        ProviderLaunchDefaultsPutRequestV1,
        ProviderLaunchDefaultsPutReceiptV1,
    )>,
    DomainStoreErrorV1,
> {
    let row = sqlx::query(
        r#"
        SELECT request_json, receipt_json
        FROM provider_launch_defaults_put_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_provider_launch_defaults_put_receipt", error))?;
    row.map(|row| {
        let request_json: String = row.try_get("request_json").map_err(corrupt_authority)?;
        let receipt_json: String = row.try_get("receipt_json").map_err(corrupt_authority)?;
        let request: ProviderLaunchDefaultsPutRequestV1 =
            serde_json::from_str(&request_json).map_err(corrupt_authority)?;
        request.validate().map_err(corrupt_authority)?;
        let receipt: ProviderLaunchDefaultsPutReceiptV1 =
            serde_json::from_str(&receipt_json).map_err(corrupt_authority)?;
        receipt.validate().map_err(corrupt_authority)?;
        let exact_write = matches!(
            receipt.disposition,
            ProviderLaunchDefaultsPutDispositionV1::Created
                | ProviderLaunchDefaultsPutDispositionV1::Updated
        );
        if receipt.idempotency_key != request.idempotency_key
            || receipt.expected_revision != request.expected_revision
            || (exact_write && receipt.document.defaults != request.defaults)
        {
            return Err(corrupt_authority(
                "stored put receipt does not match its request",
            ));
        }
        Ok((request, receipt))
    })
    .transpose()
}

fn corrupt_authority(error: impl std::fmt::Display) -> DomainStoreErrorV1 {
    storage(
        "corrupt_provider_launch_defaults",
        format!("stored provider launch defaults authority is invalid: {error}"),
    )
}
